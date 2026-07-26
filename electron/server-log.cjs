const fs = require('fs');

function asError(value) {
  return value instanceof Error ? value : new Error(String(value || 'Unknown server log error'));
}

/**
 * Own the server log destination and every child stream piped into it.
 * Failures before completeStartup() reject startupFailure; later failures
 * disable logging and are reported without escaping an EventEmitter handler.
 */
function createServerLogLifecycle({
  logPath,
  initialMessage,
  createWriteStream = fs.createWriteStream,
  onLateError = error => console.error('[Electron] Server log unavailable:', error.message)
}) {
  let stream;
  let resolveReady;
  let rejectReady;
  let rejectStartupFailure;
  let startupComplete = false;
  let destinationError = null;
  let closeRequested = false;
  let attachedProcess = null;
  let processCloseHandler = null;
  const sourceRecords = [];

  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const startupFailure = new Promise((_, reject) => {
    rejectStartupFailure = reject;
  });
  // A caller normally races this promise during startup. Keep it handled even
  // if stream creation fails before the caller has installed that race.
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

  function unpipeSources(removeErrorListeners, drain = false) {
    for (const record of sourceRecords) {
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
      }
    }
    if (removeErrorListeners) sourceRecords.length = 0;
  }

  function handleFailure(value) {
    if (destinationError) return;
    const error = asError(value);
    destinationError = error;
    // Keep draining child output after disabling the log so a full stdio pipe
    // cannot block the still-running server process.
    unpipeSources(false, true);
    try {
      if (stream && !stream.destroyed) stream.destroy();
    } catch {}

    if (startupComplete || closeRequested) {
      reportLateError(error);
    } else {
      rejectReady(error);
      rejectStartupFailure(error);
    }
  }

  stream = createWriteStream(logPath, { flags: 'a' });
  stream.on('error', handleFailure);
  stream.once('open', () => {
    if (destinationError || closeRequested) return;
    try {
      stream.write(initialMessage, error => {
        if (error) handleFailure(error);
        else resolveReady();
      });
    } catch (error) {
      handleFailure(error);
    }
  });

  function write(message) {
    if (destinationError || closeRequested || stream.destroyed || stream.writableEnded) return false;
    try {
      return stream.write(message, error => {
        if (error) handleFailure(error);
      });
    } catch (error) {
      handleFailure(error);
      return false;
    }
  }

  function closeDestination() {
    if (destinationError || stream.destroyed || stream.writableEnded) return;
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
    unpipeSources(!attachedProcess, true);
    closeDestination();
  }

  function attachProcess(proc) {
    if (destinationError || closeRequested) return false;
    attachedProcess = proc;
    for (const [name, source] of [['stdout', proc.stdout], ['stderr', proc.stderr]]) {
      if (!source) continue;
      const onError = error => handleFailure(
        new Error(`Server ${name} log pipe failed: ${asError(error).message}`, { cause: error })
      );
      source.on('error', onError);
      sourceRecords.push({ source, onError, unpiped: false, draining: false });
      try {
        source.pipe(stream, { end: false });
      } catch (error) {
        handleFailure(error);
        return false;
      }
    }
    processCloseHandler = () => {
      unpipeSources(true);
      attachedProcess = null;
      processCloseHandler = null;
      if (!closeRequested) closeRequested = true;
      closeDestination();
    };
    proc.once('close', processCloseHandler);
    return true;
  }

  function completeStartup() {
    startupComplete = true;
  }

  return {
    ready,
    startupFailure,
    attachProcess,
    completeStartup,
    write,
    close,
    get failed() { return destinationError !== null; }
  };
}

module.exports = { createServerLogLifecycle };
