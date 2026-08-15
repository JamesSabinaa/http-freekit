'use strict';

const fs = require('fs');
const path = require('path');
const { Writable } = require('stream');

// The active file plus two archives retain at most 15 MiB of recent output.
const DEFAULT_SERVER_LOG_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_SERVER_LOG_MAX_FILES = 3;

function asError(value) {
  return value instanceof Error ? value : new Error(String(value || 'Unknown server log error'));
}

function isMissing(error) {
  return error?.code === 'ENOENT';
}

async function fileSize(fileSystem, filePath) {
  try {
    return (await fileSystem.stat(filePath)).size;
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
}

async function removeIfPresent(fileSystem, filePath) {
  try {
    await fileSystem.unlink(filePath);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function renameIfPresent(fileSystem, source, destination) {
  try {
    await fileSystem.rename(source, destination);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

/**
 * Bound a legacy oversized log without loading it all into memory. Diagnostics
 * at the end are more useful than the oldest startup output, so retain the
 * newest maxBytes in place.
 */
async function retainFileTail(fileSystem, filePath, maxBytes) {
  let size;
  try {
    size = (await fileSystem.stat(filePath)).size;
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (size <= maxBytes) return;

  let handle;
  let operationError = null;
  try {
    handle = await fileSystem.open(filePath, 'r+');
    const tail = Buffer.allocUnsafe(maxBytes);
    let bytesRead = 0;
    while (bytesRead < maxBytes) {
      const result = await handle.read(
        tail,
        bytesRead,
        maxBytes - bytesRead,
        size - maxBytes + bytesRead
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }

    let bytesWritten = 0;
    while (bytesWritten < bytesRead) {
      const result = await handle.write(
        tail,
        bytesWritten,
        bytesRead - bytesWritten,
        bytesWritten
      );
      if (result.bytesWritten === 0) {
        throw new Error(`Could not retain the recent tail of ${filePath}`);
      }
      bytesWritten += result.bytesWritten;
    }
    await handle.truncate(bytesWritten);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (closeError) {
        if (!operationError) throw closeError;
      }
    }
  }
}

function endWriteStream(stream) {
  if (!stream || stream.closed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let failure = null;
    const cleanup = () => {
      stream.removeListener('error', onError);
      stream.removeListener('close', onClose);
    };
    const onError = error => {
      failure ||= asError(error);
      try {
        if (!stream.destroyed) stream.destroy();
      } catch {}
    };
    const onClose = () => {
      cleanup();
      if (failure) reject(failure);
      else resolve();
    };

    stream.on('error', onError);
    stream.once('close', onClose);
    try {
      stream.end();
    } catch (error) {
      failure = asError(error);
      try {
        stream.destroy();
      } catch {
        cleanup();
        reject(failure);
      }
    }
  });
}

/**
 * A serialized rolling file destination. The active file is newest, .1 is
 * the previous segment, and higher suffixes are progressively older.
 */
class RotatingFileStream extends Writable {
  constructor({
    logPath,
    maxBytes = DEFAULT_SERVER_LOG_MAX_BYTES,
    maxFiles = DEFAULT_SERVER_LOG_MAX_FILES,
    fileSystem = fs.promises,
    createWriteStream = fs.createWriteStream
  }) {
    super();
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new RangeError('Server log maxBytes must be a positive safe integer');
    }
    if (!Number.isSafeInteger(maxFiles) || maxFiles <= 0) {
      throw new RangeError('Server log maxFiles must be a positive safe integer');
    }

    this.logPath = logPath;
    this.maxBytes = maxBytes;
    this.maxFiles = maxFiles;
    this.fileSystem = fileSystem;
    this.createFileStream = createWriteStream;
    this.fileStream = null;
    this.currentSize = 0;
    this.onFileError = error => this.destroy(asError(error));
  }

  _construct(callback) {
    this.initialize().then(() => callback(), callback);
  }

  async initialize() {
    const directory = path.dirname(this.logPath);
    const baseName = path.basename(this.logPath);
    let entries;
    try {
      entries = await this.fileSystem.readdir(directory);
    } catch (error) {
      if (!isMissing(error)) throw error;
      entries = [];
    }

    const archivePrefix = `${baseName}.`;
    const staleArchives = entries
      .filter(entry => entry.startsWith(archivePrefix))
      .map(entry => ({ entry, suffix: entry.slice(archivePrefix.length) }))
      .filter(({ suffix }) => /^[1-9]\d*$/.test(suffix))
      .map(({ entry, suffix }) => ({ entry, index: Number(suffix) }))
      .filter(({ index }) => !Number.isSafeInteger(index) || index >= this.maxFiles)
      .sort((left, right) => right.index - left.index);
    for (const { entry } of staleArchives) {
      await removeIfPresent(this.fileSystem, path.join(directory, entry));
    }

    for (let index = 1; index < this.maxFiles; index++) {
      await retainFileTail(this.fileSystem, `${this.logPath}.${index}`, this.maxBytes);
    }
    await retainFileTail(this.fileSystem, this.logPath, this.maxBytes);
    this.currentSize = await fileSize(this.fileSystem, this.logPath);
    await this.openCurrentFile();
  }

  openCurrentFile() {
    return new Promise((resolve, reject) => {
      let stream;
      try {
        stream = this.createFileStream(this.logPath, { flags: 'a' });
      } catch (error) {
        reject(asError(error));
        return;
      }

      let settled = false;
      const onOpen = () => {
        if (settled) return;
        settled = true;
        stream.removeListener('error', onOpenError);
        stream.on('error', this.onFileError);
        this.fileStream = stream;
        resolve();
      };
      const onOpenError = error => {
        if (settled) return;
        settled = true;
        stream.removeListener('open', onOpen);
        const openError = asError(error);
        if (stream.closed) {
          reject(openError);
          return;
        }
        stream.once('error', () => {});
        stream.once('close', () => reject(openError));
        try {
          if (!stream.destroyed) stream.destroy();
        } catch {
          reject(openError);
        }
      };
      stream.once('open', onOpen);
      stream.once('error', onOpenError);
    });
  }

  writeToCurrentFile(chunk) {
    return new Promise((resolve, reject) => {
      try {
        this.fileStream.write(chunk, error => {
          if (error) reject(asError(error));
          else resolve();
        });
      } catch (error) {
        reject(asError(error));
      }
    });
  }

  async closeCurrentFile() {
    const stream = this.fileStream;
    this.fileStream = null;
    if (!stream) return;
    stream.removeListener('error', this.onFileError);
    await endWriteStream(stream);
  }

  async rotate() {
    await this.closeCurrentFile();

    if (this.maxFiles === 1) {
      await removeIfPresent(this.fileSystem, this.logPath);
    } else {
      for (let index = this.maxFiles - 1; index >= 1; index--) {
        const source = index === 1 ? this.logPath : `${this.logPath}.${index - 1}`;
        const destination = `${this.logPath}.${index}`;
        await removeIfPresent(this.fileSystem, destination);
        await renameIfPresent(this.fileSystem, source, destination);
      }
    }

    this.currentSize = 0;
    await this.openCurrentFile();
  }

  async writeBounded(chunk) {
    let offset = 0;
    while (offset < chunk.length) {
      const remaining = chunk.length - offset;
      if (this.currentSize >= this.maxBytes || (
        this.currentSize > 0 &&
        remaining <= this.maxBytes &&
        this.currentSize + remaining > this.maxBytes
      )) {
        await this.rotate();
      }

      const writableBytes = Math.min(this.maxBytes - this.currentSize, remaining);
      await this.writeToCurrentFile(chunk.subarray(offset, offset + writableBytes));
      this.currentSize += writableBytes;
      offset += writableBytes;
    }
  }

  _write(chunk, _encoding, callback) {
    this.writeBounded(chunk).then(() => callback(), callback);
  }

  _final(callback) {
    this.closeCurrentFile().then(() => callback(), callback);
  }

  _destroy(error, callback) {
    const stream = this.fileStream;
    this.fileStream = null;
    if (!stream || stream.closed) {
      callback(error);
      return;
    }

    stream.removeListener('error', this.onFileError);
    let completed = false;
    const finish = () => {
      if (completed) return;
      completed = true;
      callback(error);
    };
    stream.once('error', () => {});
    stream.once('close', finish);
    try {
      stream.destroy();
    } catch {
      finish();
    }
  }
}

/**
 * Own the server log destination and every child stream piped into it.
 * Failures before completeStartup() reject startupFailure; later failures
 * disable logging and are reported without escaping an EventEmitter handler.
 */
function createServerLogLifecycle({
  logPath,
  initialMessage,
  maxBytes = DEFAULT_SERVER_LOG_MAX_BYTES,
  maxFiles = DEFAULT_SERVER_LOG_MAX_FILES,
  fileSystem = fs.promises,
  createWriteStream = fs.createWriteStream,
  createDestination = options => new RotatingFileStream(options),
  onLateError = error => console.error('[Electron] Server log unavailable:', error.message)
}) {
  let stream;
  let resolveReady;
  let rejectReady;
  let rejectStartupFailure;
  let resolveClosed;
  let startupComplete = false;
  let destinationError = null;
  let closeRequested = false;
  let currentAttachment = null;
  let hadAttachment = false;
  const sourceRecords = [];

  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const startupFailure = new Promise((_, reject) => {
    rejectStartupFailure = reject;
  });
  const closed = new Promise(resolve => {
    resolveClosed = resolve;
  });
  // A caller normally races this promise during startup. Keep it handled even
  // if destination preparation fails before the caller installs that race.
  startupFailure.catch(() => {});

  function reportLateError(error) {
    try {
      onLateError(error);
    } catch (reportError) {
      try {
        console.error('[Electron] Could not report server log failure:', reportError.message);
      } catch {}
    }
  }

  function unpipeSources({ proc, removeErrorListeners, drain = false } = {}) {
    for (let index = sourceRecords.length - 1; index >= 0; index--) {
      const record = sourceRecords[index];
      if (proc && record.proc !== proc) continue;
      if (!record.unpiped) {
        try { record.source.unpipe(stream); } catch {}
        record.unpiped = true;
      }
      if (drain && !record.draining && typeof record.source.resume === 'function') {
        try { record.source.resume(); } catch {}
        record.draining = true;
      }
      if (removeErrorListeners) {
        record.source.removeListener('error', record.onError);
        sourceRecords.splice(index, 1);
      } else {
        record.active = false;
      }
    }
  }

  function handleFailure(value) {
    if (destinationError) return;
    const error = asError(value);
    destinationError = error;
    // Keep draining child output after disabling the log so a full stdio pipe
    // cannot block the still-running server process.
    unpipeSources({ removeErrorListeners: false, drain: true });
    try {
      if (stream && !stream.destroyed) stream.destroy();
      else if (!stream || stream.closed) resolveClosed();
    } catch {
      resolveClosed();
    }

    if (startupComplete || closeRequested) {
      reportLateError(error);
    } else {
      rejectReady(error);
      rejectStartupFailure(error);
    }
  }

  try {
    stream = createDestination({
      logPath,
      maxBytes,
      maxFiles,
      fileSystem,
      createWriteStream
    });
    stream.on('error', handleFailure);
    stream.once('close', resolveClosed);
    stream.write(initialMessage, error => {
      if (error) handleFailure(error);
      else resolveReady();
    });
  } catch (error) {
    handleFailure(error);
  }

  function write(message) {
    if (destinationError || closeRequested || !stream || stream.destroyed || stream.writableEnded) {
      return false;
    }
    try {
      return stream.write(message, error => {
        if (error) handleFailure(error);
      });
    } catch (error) {
      handleFailure(error);
      return false;
    }
  }

  function writeAndWait(message) {
    if (destinationError) return Promise.reject(destinationError);
    if (closeRequested || !stream || stream.destroyed || stream.writableEnded) {
      return Promise.reject(new Error('Server log is closed'));
    }
    return new Promise((resolve, reject) => {
      try {
        stream.write(message, error => {
          if (error) {
            const writeError = asError(error);
            handleFailure(writeError);
            reject(writeError);
          } else {
            resolve();
          }
        });
      } catch (error) {
        const writeError = asError(error);
        handleFailure(writeError);
        reject(writeError);
      }
    });
  }

  function closeDestination() {
    if (!stream || destinationError || stream.destroyed || stream.writableEnded) return;
    try {
      stream.end();
    } catch (error) {
      handleFailure(error);
    }
  }

  function close() {
    if (closeRequested) return;
    closeRequested = true;
    // A startup failure can close the log before the child has closed. Keep
    // its error listeners until the process close event, and drain output in
    // the meantime so cleanup cannot introduce an unhandled source error.
    unpipeSources({ removeErrorListeners: false, drain: true });
    closeDestination();
  }

  function attachProcess(proc) {
    if (destinationError || closeRequested || currentAttachment) return false;
    const attachment = { proc, retired: false, onClose: null };
    hadAttachment = true;
    currentAttachment = attachment;
    attachment.onClose = () => {
      unpipeSources({ proc, removeErrorListeners: true });
      if (currentAttachment === attachment) currentAttachment = null;
      if (!attachment.retired && startupComplete) {
        closeRequested = true;
        closeDestination();
      }
    };
    proc.once('close', attachment.onClose);
    for (const [name, source] of [['stdout', proc.stdout], ['stderr', proc.stderr]]) {
      if (!source) continue;
      const record = {
        proc,
        source,
        onError: null,
        active: true,
        unpiped: false,
        draining: false
      };
      record.onError = error => {
        if (!record.active) return;
        handleFailure(new Error(
          `Server ${name} log pipe failed: ${asError(error).message}`,
          { cause: error }
        ));
      };
      source.on('error', record.onError);
      sourceRecords.push(record);
      try {
        source.pipe(stream, { end: false });
      } catch (error) {
        handleFailure(error);
        return false;
      }
      if (destinationError) return false;
    }
    return true;
  }

  function detachProcess(proc) {
    const attachment = currentAttachment;
    if (!attachment || attachment.proc !== proc) return false;
    attachment.retired = true;
    currentAttachment = null;
    unpipeSources({ proc, removeErrorListeners: false, drain: true });
    return true;
  }

  function completeStartup() {
    startupComplete = true;
    if (hadAttachment && currentAttachment === null) {
      closeRequested = true;
      closeDestination();
    }
  }

  return {
    ready,
    startupFailure,
    closed,
    attachProcess,
    detachProcess,
    completeStartup,
    write,
    writeAndWait,
    close,
    get failed() { return destinationError !== null; }
  };
}

module.exports = {
  DEFAULT_SERVER_LOG_MAX_BYTES,
  DEFAULT_SERVER_LOG_MAX_FILES,
  createServerLogLifecycle
};
