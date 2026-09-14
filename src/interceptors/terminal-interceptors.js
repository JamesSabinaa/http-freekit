import { execFile, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  NODE_ENV_PROXY_SUPPORT_NOTE,
  NODE_USE_ENV_PROXY_VALUE
} from './node-environment-proxy.js';
import {
  inspectProcessIdentity,
  normalizeBootId,
  normalizeProcessIdentity,
  parseLinuxProcessStart,
  sameProcessIdentity
} from './process-identity.js';
import { formatProxyUrl, getLocalProxyHost } from './proxy-bind-reachability.js';

const LINUX_TERMINAL_LAUNCHERS = [
  {
    command: 'gnome-terminal',
    buildArgs: shellCommand => ['--wait', '--', 'sh', '-c', shellCommand]
  },
  {
    command: 'xterm',
    buildArgs: shellCommand => ['-e', 'sh', '-c', shellCommand]
  },
  {
    command: 'konsole',
    buildArgs: shellCommand => ['--separate', '--nofork', '-e', 'sh', '-c', shellCommand]
  }
];
const TERMINAL_SESSION_OWNERSHIP_VERSION = 3;
const MAX_TERMINAL_OWNERSHIP_BYTES = 64 * 1024;
const MAX_TERMINAL_SESSIONS = 32;
const MAX_TERMINAL_HANDSHAKE_BYTES = 4096;
const CMD_LITERAL_HELPERS = Object.freeze({
  '%': '__HTTP_FREEKIT_CMD_LITERAL_PERCENT_4F91D2A7__',
  '!': '__HTTP_FREEKIT_CMD_LITERAL_BANG_4F91D2A7__',
  '^': '__HTTP_FREEKIT_CMD_LITERAL_CARET_4F91D2A7__'
});

function spawnDetached(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    const onSpawn = () => {
      child.removeListener('error', onError);
      resolve(child);
    };
    const onError = (err) => {
      child.removeListener('spawn', onSpawn);
      reject(err);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

function isProcessRunning(proc) {
  return proc && proc.exitCode == null && proc.signalCode == null;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function powerShellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function terminalEnvironmentValue(value) {
  const normalized = String(value);
  if (/[\x00-\x1f\x7f]/.test(normalized)) {
    throw new TypeError('Terminal environment values cannot contain control characters');
  }
  // A literal double quote cannot occur in a valid Windows path, and it can
  // terminate SET's protective quoting when these instructions are pasted.
  if (normalized.includes('"')) {
    throw new TypeError('Terminal environment values cannot contain double quotes');
  }
  return normalized;
}

function cmdNeedsLiteralHelpers(value) {
  return /[%!]/.test(value);
}

function cmdLiteralHelperReference(character) {
  return `^%${CMD_LITERAL_HELPERS[character]}^%`;
}

function cmdLiteralValue(value) {
  let encoded = '';
  for (const character of value) {
    if (CMD_LITERAL_HELPERS[character]) {
      // CALL resolves these helper references on its second expansion pass,
      // after normal percent and delayed-exclamation expansion have finished.
      encoded += cmdLiteralHelperReference(character);
    } else if ('&|<>()'.includes(character)) {
      // The assignment's protective quotes are deferred to CALL's second pass,
      // so command metacharacters must survive the first pass explicitly.
      encoded += `^${character}`;
    } else {
      encoded += character;
    }
  }
  return encoded;
}

function cmdSet(variable, value) {
  if (!cmdNeedsLiteralHelpers(value)) return `set "${variable}=${value}"`;
  return `call set ^"${variable}=${cmdLiteralValue(value)}^"`;
}

function cmdLiteralHelperSetup() {
  return [
    `set "${CMD_LITERAL_HELPERS['%']}=%"`,
    `set "${CMD_LITERAL_HELPERS['!']}=!"`,
    `set "${CMD_LITERAL_HELPERS['^']}=^"`
  ];
}

function cmdLiteralHelperCleanup() {
  return Object.values(CMD_LITERAL_HELPERS).map(name => `set "${name}="`);
}

function getTerminalCaPath(ca) {
  if (!ca) return '';
  if (typeof ca.getCertInfo === 'function') {
    const certInfo = ca.getCertInfo();
    if (typeof certInfo?.certificatePath === 'string') return certInfo.certificatePath;
  }
  if (typeof ca.caCertPath === 'string') return ca.caCertPath;
  // Compatibility for lightweight integrations that have not yet exposed the
  // raw certificate path. Production CertificateAuthority instances take the
  // raw-certificate branch above, never the generated Node-root bundle.
  if (typeof ca.getTerminalCaBundlePath === 'function') {
    return ca.getTerminalCaBundlePath();
  }
  return '';
}

function buildTerminalEnvironment(proxyUrl, certPath) {
  const environment = {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: '',
    no_proxy: '',
    NODE_USE_ENV_PROXY: NODE_USE_ENV_PROXY_VALUE
  };
  // Node supports an additive CA file. The other common trust variables are
  // intentionally left untouched because they replace platform/tool roots.
  // Omitting this too when no CA is available preserves an inherited value.
  if (certPath) environment.NODE_EXTRA_CA_CERTS = certPath;
  return environment;
}

export function buildExistingTerminalInstructions(proxyUrl, certPath) {
  const environment = Object.entries(buildTerminalEnvironment(proxyUrl, certPath))
    .map(([name, value]) => [name, terminalEnvironmentValue(value)]);
  const cmdAssignments = [
    cmdSet('NODE_TLS_REJECT_UNAUTHORIZED', ''),
    ...environment.map(([name, value]) => cmdSet(name, value))
  ];
  const cmdUsesLiteralHelpers = environment.some(([, value]) => cmdNeedsLiteralHelpers(value));
  return {
    bash: `unset NODE_TLS_REJECT_UNAUTHORIZED; export ${environment.map(([name, value]) => `${name}=${shellQuote(value)}`).join(' ')}`,
    powershell: [
      'Remove-Item Env:NODE_TLS_REJECT_UNAUTHORIZED -ErrorAction SilentlyContinue',
      ...environment.map(([name, value]) => `$env:${name}=${powerShellQuote(value)}`)
    ].join('; '),
    cmd: [
      ...(cmdUsesLiteralHelpers ? cmdLiteralHelperSetup() : []),
      ...cmdAssignments,
      ...(cmdUsesLiteralHelpers ? cmdLiteralHelperCleanup() : [])
    ].join('&& ')
  };
}

export class FreshTerminalInterceptor {
  constructor(options = {}) {
    this.id = 'fresh-terminal';
    this.name = 'Fresh Terminal';
    this.proxyHost = getLocalProxyHost(options.proxyBindHost);
    this.active = false;
    this.processes = [];
    this.sessions = new Map();
    this.ca = null;
    this.onStatusChange = null;
    this.statusMonitor = null;
    this.deactivating = false;
    this.deactivatingProcesses = new Set();
    this.gracefulExitTimeoutMs = 2000;
    this.forceExitTimeoutMs = 2000;
    this.sessionExitPollIntervalMs = 50;
    this.posixBootIdPromise = null;
    this.platformOverride = options.platform || null;
    this.recoveryFile = options.dataDir
      ? path.join(options.dataDir, 'fresh-terminal-session-ownership.json')
      : options.recoveryFile || null;
    this.recoveryJournalError = null;
    this._loadSessionJournal();
  }

  _platform() {
    return this.platformOverride || process.platform;
  }

  _environment() {
    return process.env;
  }

  _workingDirectory() {
    return process.cwd();
  }

  _linuxTerminalLaunchers() {
    return LINUX_TERMINAL_LAUNCHERS;
  }

  async _isExecutablePath(executablePath) {
    try {
      const stats = await fs.promises.stat(executablePath);
      if (!stats.isFile()) return false;
      await fs.promises.access(executablePath, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  async _resolveLinuxLauncher(command) {
    const environment = this._environment();
    // Node uses /usr/bin:/bin to resolve commands on Unix when PATH is absent.
    const pathValue = environment.PATH == null ? '/usr/bin:/bin' : String(environment.PATH);
    for (const directory of pathValue.split(path.posix.delimiter)) {
      const executablePath = path.posix.resolve(
        this._workingDirectory(),
        directory || '.',
        command
      );
      if (await this._isExecutablePath(executablePath)) return executablePath;
    }
    return null;
  }

  async _availableLinuxTerminalLaunchers() {
    const launchers = this._linuxTerminalLaunchers();
    const resolvedPaths = await Promise.all(
      launchers.map(launcher => this._resolveLinuxLauncher(launcher.command))
    );
    return launchers.filter((launcher, index) => resolvedPaths[index] !== null);
  }

  _spawnDetached(command, args, options) {
    return spawnDetached(command, args, options);
  }

  _windowsHandshakeCloseDelayMs() {
    return 3250;
  }

  _confirmLauncherStartup(proc, waitUntilReady) {
    const failure = (code, signal) => {
      const detail = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
      return new Error(`Terminal launcher failed during startup (${detail})`);
    };

    if (proc.signalCode !== null) {
      return Promise.reject(failure(proc.exitCode, proc.signalCode));
    }
    if (proc.exitCode !== null) {
      if (proc.exitCode !== 0) return Promise.reject(failure(proc.exitCode, null));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const abortController = new AbortController();
      const cleanup = () => {
        abortController.abort();
        proc.removeListener('exit', onExit);
        proc.removeListener('error', onError);
      };
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };
      const onExit = (code, signal) => {
        if (code !== 0 || signal) {
          finish(reject, failure(code, signal));
        }
      };
      const onError = (err) => finish(reject, err);
      const onReady = value => {
        if (proc.signalCode !== null || (proc.exitCode !== null && proc.exitCode !== 0)) {
          finish(reject, failure(proc.exitCode, proc.signalCode));
        } else {
          finish(resolve, value);
        }
      };

      proc.on('exit', onExit);
      proc.once('error', onError);
      let ready;
      try {
        ready = waitUntilReady(abortController.signal);
      } catch (error) {
        finish(reject, error);
        return;
      }
      Promise.resolve(ready).then(onReady, error => finish(reject, error));
    });
  }

  _createTerminalHandshake() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-terminal-handshake-'));
    try { fs.chmodSync(directory, 0o700); } catch {}
    return Object.freeze({
      directory,
      reportFile: path.join(directory, 'identity.json'),
      acknowledgementFile: path.join(directory, 'acknowledgement.txt'),
      nonce: crypto.randomBytes(32).toString('hex')
    });
  }

  _createWindowsHandshake() {
    return this._createTerminalHandshake();
  }

  _createPosixHandshake() {
    const handshake = this._createTerminalHandshake();
    const ownershipMarkerFile = path.join(handshake.directory, 'ownership.marker');
    try {
      fs.writeFileSync(ownershipMarkerFile, '', { flag: 'wx', mode: 0o600 });
      return Object.freeze({ ...handshake, ownershipMarkerFile });
    } catch (error) {
      this._cleanupTerminalHandshake(handshake);
      throw error;
    }
  }

  _cleanupTerminalHandshake(handshake, { preserveOwnershipMarker = false } = {}) {
    if (!handshake) return;
    const temporaryRoot = path.resolve(os.tmpdir());
    const directory = handshake.directory ? path.resolve(handshake.directory) : null;
    if (directory && path.dirname(directory) === temporaryRoot &&
        path.basename(directory).startsWith('http-freekit-terminal-handshake-')) {
      if (preserveOwnershipMarker && handshake.ownershipMarkerFile) {
        for (const filePath of [handshake.reportFile, handshake.acknowledgementFile]) {
          try { fs.unlinkSync(filePath); } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
          }
        }
        return;
      }
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    }
    for (const filePath of [handshake.reportFile, handshake.acknowledgementFile]) {
      if (!filePath) continue;
      try { fs.unlinkSync(filePath); } catch {}
    }
  }

  _cleanupWindowsHandshake(handshake) {
    this._cleanupTerminalHandshake(handshake);
  }

  _readTerminalHandshakeReport(reportFile) {
    const pathStats = fs.lstatSync(reportFile);
    if (!pathStats.isFile() || pathStats.nlink !== 1 || pathStats.size <= 0 ||
        pathStats.size > MAX_TERMINAL_HANDSHAKE_BYTES) {
      throw new Error('Terminal shell identity report is not a bounded regular file');
    }
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    const descriptor = fs.openSync(reportFile, fs.constants.O_RDONLY | noFollow);
    try {
      const stats = fs.fstatSync(descriptor);
      if (!stats.isFile() || stats.nlink !== 1 || stats.size !== pathStats.size ||
          stats.dev !== pathStats.dev || stats.ino !== pathStats.ino) {
        throw new Error('Terminal shell identity report changed before it was read');
      }
      const buffer = Buffer.alloc(stats.size + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const count = fs.readSync(
          descriptor,
          buffer,
          bytesRead,
          buffer.length - bytesRead,
          bytesRead
        );
        if (count === 0) break;
        bytesRead += count;
      }
      if (bytesRead !== stats.size) {
        throw new Error('Terminal shell identity report changed while it was being read');
      }
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      fs.closeSync(descriptor);
    }
  }

  async _waitForPosixShellReport(handshake, timeoutMs = 3000, signal = null) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('Terminal shell identity wait was cancelled');
      try {
        const report = JSON.parse(this._readTerminalHandshakeReport(handshake.reportFile));
        const reportKeys = Object.keys(report || {}).sort();
        if (reportKeys.length !== 2 || reportKeys[0] !== 'nonce' || reportKeys[1] !== 'pid' ||
            report.nonce !== handshake.nonce || !Number.isSafeInteger(report.pid) || report.pid <= 0) {
          throw new Error('Terminal shell identity report has an invalid schema or nonce');
        }
        return report.pid;
      } catch {}
      await this._sleep(50);
    }
    throw new Error('Terminal shell did not report a nonce-bound process ID');
  }

  async _waitForWindowsShellReport(reportFile, timeoutMs = 3000, signal = null) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('Terminal shell identity wait was cancelled');
      try {
        const report = JSON.parse(this._readTerminalHandshakeReport(reportFile));
        const reportKeys = Object.keys(report || {}).sort();
        if (reportKeys.length !== 3 ||
            reportKeys[0] !== 'executable' || reportKeys[1] !== 'pid' ||
            reportKeys[2] !== 'startTime') {
          throw new Error('Terminal shell identity report has an invalid schema');
        }
        return this._normalizeSessionIdentity(report, report?.pid, 'win32');
      } catch {}
      await this._sleep(50);
    }
    throw new Error('Terminal shell did not report a verifiable process identity');
  }

  async _acknowledgeWindowsShell(handshake, timeoutMs = 3000) {
    fs.writeFileSync(handshake.acknowledgementFile, handshake.nonce, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!fs.existsSync(handshake.acknowledgementFile)) return;
      await this._sleep(50);
    }
    throw new Error('Terminal shell did not acknowledge its verified identity');
  }

  async _acknowledgePosixShell(handshake, timeoutMs = 3000) {
    fs.writeFileSync(handshake.acknowledgementFile, handshake.nonce, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!fs.existsSync(handshake.acknowledgementFile)) return;
      await this._sleep(50);
    }
    throw new Error('Terminal shell did not acknowledge its persisted ownership');
  }

  _identityInspectionTimeoutMs() {
    return this._platform() === 'win32' ? 5000 : 1000;
  }

  _execFile(command, args, options) {
    return new Promise((resolve, reject) => {
      execFile(command, args, options, (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          reject(err);
        } else {
          resolve({ stdout, stderr });
        }
      });
    });
  }

  _normalizeSessionIdentity(identity, expectedPid = identity?.pid, platform = this._platform()) {
    const normalized = normalizeProcessIdentity(identity, expectedPid, { platform });
    return Object.freeze({
      ...normalized,
      ...(platform !== 'win32' && identity?.bootId !== undefined
        ? { bootId: normalizeBootId(identity.bootId) }
        : {}),
      ...(platform === 'darwin' && identity?.ownershipMarkerFile !== undefined
        ? { ownershipMarkerFile: this._normalizeOwnershipMarkerFile(identity.ownershipMarkerFile) }
        : {})
    });
  }

  _normalizeOwnershipMarkerFile(markerFile) {
    if (typeof markerFile !== 'string' || markerFile.length > 4096 || /[\0\r\n]/.test(markerFile)) {
      throw new Error('Fresh Terminal ownership marker path is invalid');
    }
    const normalized = path.resolve(markerFile);
    const directory = path.dirname(normalized);
    if (path.basename(normalized) !== 'ownership.marker' ||
        path.dirname(directory) !== path.resolve(os.tmpdir()) ||
        !path.basename(directory).startsWith('http-freekit-terminal-handshake-')) {
      throw new Error('Fresh Terminal ownership marker is outside its private directory');
    }
    return normalized;
  }

  _sessionJournalEntry(identity, platform = this._platform()) {
    const normalized = this._normalizeSessionIdentity(identity, identity?.pid, platform);
    if (platform !== 'win32' && !normalized.bootId) {
      throw new Error('Fresh Terminal POSIX ownership is missing its boot identity');
    }
    if (platform === 'darwin' && !normalized.ownershipMarkerFile) {
      throw new Error('Fresh Terminal macOS ownership is missing its open-file marker');
    }
    return {
      pid: normalized.pid,
      startTime: normalized.startTime,
      executable: normalized.executable,
      ...(platform !== 'win32' ? { bootId: normalized.bootId } : {}),
      ...(platform === 'darwin'
        ? { ownershipMarkerFile: normalized.ownershipMarkerFile }
        : {}),
      platform
    };
  }

  _validateSessionJournal(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error('Fresh Terminal ownership journal must contain an object');
    }
    const keys = Object.keys(record).sort();
    if (keys.length !== 2 || keys[0] !== 'sessions' || keys[1] !== 'version' ||
        record.version !== TERMINAL_SESSION_OWNERSHIP_VERSION ||
        !Array.isArray(record.sessions) || record.sessions.length === 0 ||
        record.sessions.length > MAX_TERMINAL_SESSIONS) {
      throw new Error('Fresh Terminal ownership journal has an invalid schema');
    }

    const sessions = new Map();
    for (const rawEntry of record.sessions) {
      if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
        throw new Error('Fresh Terminal ownership journal has an invalid session');
      }
      const entryKeys = Object.keys(rawEntry).sort();
      const expectedKeys = rawEntry.platform === 'darwin'
        ? ['bootId', 'executable', 'ownershipMarkerFile', 'pid', 'platform', 'startTime']
        : rawEntry.platform === 'linux'
          ? ['bootId', 'executable', 'pid', 'platform', 'startTime']
          : ['executable', 'pid', 'platform', 'startTime'];
      if (entryKeys.length !== expectedKeys.length ||
          entryKeys.some((key, index) => key !== expectedKeys[index]) ||
          !['darwin', 'linux', 'win32'].includes(rawEntry.platform) ||
          rawEntry.platform !== this._platform()) {
        throw new Error('Fresh Terminal ownership journal has an invalid session schema');
      }
      const identity = this._normalizeSessionIdentity(rawEntry, rawEntry.pid, rawEntry.platform);
      if (sessions.has(identity.pid)) {
        throw new Error('Fresh Terminal ownership journal contains duplicate process IDs');
      }
      sessions.set(identity.pid, identity);
    }
    return sessions;
  }

  _sessionJournalRecord(sessions) {
    return {
      version: TERMINAL_SESSION_OWNERSHIP_VERSION,
      sessions: [...sessions.values()].map(identity => this._sessionJournalEntry(identity))
    };
  }

  _loadSessionJournal() {
    if (!this.recoveryFile) return;
    try {
      let descriptor;
      try {
        const pathStats = fs.lstatSync(this.recoveryFile);
        if (!pathStats.isFile()) {
          throw new Error('Fresh Terminal ownership journal is not a bounded regular file');
        }
        descriptor = fs.openSync(this.recoveryFile, 'r');
      } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
      }
      let serialized;
      try {
        const stats = fs.fstatSync(descriptor);
        if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_TERMINAL_OWNERSHIP_BYTES) {
          throw new Error('Fresh Terminal ownership journal is not a bounded regular file');
        }
        const buffer = Buffer.alloc(stats.size + 1);
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
          const count = fs.readSync(
            descriptor,
            buffer,
            bytesRead,
            buffer.length - bytesRead,
            bytesRead
          );
          if (count === 0) break;
          bytesRead += count;
        }
        if (bytesRead !== stats.size) {
          throw new Error('Fresh Terminal ownership journal changed while it was being read');
        }
        serialized = buffer.subarray(0, bytesRead).toString('utf8');
      } finally {
        fs.closeSync(descriptor);
      }
      const parsed = JSON.parse(serialized);
      this.sessions = this._validateSessionJournal(parsed);
      this.active = this.sessions.size > 0;
      if (this.active) this._startStatusMonitor();
    } catch (error) {
      this.recoveryJournalError = error;
      console.warn('[Interceptor] Ignoring invalid Fresh Terminal ownership journal:', error.message);
    }
  }

  _writeSessionJournal(sessions) {
    if (!this.recoveryFile) return;
    if (sessions.size === 0) {
      try {
        fs.unlinkSync(this.recoveryFile);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      return;
    }

    const record = this._sessionJournalRecord(sessions);
    this._validateSessionJournal(record);
    const serialized = JSON.stringify(record);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_TERMINAL_OWNERSHIP_BYTES) {
      throw new Error('Fresh Terminal ownership journal exceeds its size limit');
    }
    fs.mkdirSync(path.dirname(this.recoveryFile), { recursive: true });
    const tempPath = path.join(
      path.dirname(this.recoveryFile),
      `.${path.basename(this.recoveryFile)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
    );
    let descriptor;
    try {
      descriptor = fs.openSync(tempPath, 'wx', 0o600);
      fs.writeFileSync(descriptor, serialized, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(tempPath, this.recoveryFile);
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch {}
      }
      try { fs.unlinkSync(tempPath); } catch {}
      throw error;
    }
  }

  _addTrackedSession(identity) {
    const normalized = this._normalizeSessionIdentity(identity);
    const next = new Map(this.sessions);
    next.set(normalized.pid, normalized);
    this._writeSessionJournal(next);
    this.sessions = next;
    this.recoveryJournalError = null;
    return normalized;
  }

  _parseLinuxProcessStart(stat, pid) {
    return parseLinuxProcessStart(stat, pid, {
      unavailableMessage: 'Linux process start time is unavailable'
    });
  }

  async _getPosixBootId(platform = this._platform()) {
    if (!this.posixBootIdPromise) {
      this.posixBootIdPromise = (async () => {
        if (platform === 'linux') {
          return normalizeBootId(
            await fs.promises.readFile('/proc/sys/kernel/random/boot_id', 'utf8')
          );
        }
        if (platform === 'darwin') {
          const result = await this._execFile(
            '/usr/sbin/sysctl',
            ['-n', 'kern.bootsessionuuid'],
            {
              encoding: 'utf8',
              timeout: this._identityInspectionTimeoutMs(),
              maxBuffer: 16 * 1024,
              windowsHide: true,
              env: { ...this._environment(), LC_ALL: 'C' }
            }
          );
          return normalizeBootId(result?.stdout ?? result);
        }
        throw new Error('POSIX boot identity is unavailable on this platform');
      })();
    }
    try {
      return await this.posixBootIdPromise;
    } catch (error) {
      this.posixBootIdPromise = null;
      throw error;
    }
  }

  async _inspectSessionIdentity(
    pid,
    ownershipMarkerFile = this.sessions.get(pid)?.ownershipMarkerFile,
    expectedIdentity = this.sessions.get(pid)
  ) {
    const platform = this._platform();
    const observation = await inspectProcessIdentity(pid, {
      platform,
      environment: this._environment(),
      execFile: (...args) => this._execFile(...args),
      timeoutMs: this._identityInspectionTimeoutMs(),
      includeBootId: platform !== 'win32',
      getBootId: platform === 'win32' ? undefined : () => this._getPosixBootId(platform),
      absentMessage: 'Terminal process is absent',
      includeInvalidPidError: false,
      parseStart: (stat, processId) => this._parseLinuxProcessStart(stat, processId),
      normalizeIdentity: identity => this._normalizeSessionIdentity(identity, pid, platform)
    });
    if (platform !== 'darwin' || observation.state !== 'running' || !ownershipMarkerFile) {
      return observation;
    }
    if (expectedIdentity && (
      expectedIdentity.pid !== observation.identity.pid ||
      expectedIdentity.startTime !== observation.identity.startTime ||
      expectedIdentity.bootId !== observation.identity.bootId
    )) {
      return observation;
    }
    try {
      const normalizedMarker = this._normalizeOwnershipMarkerFile(ownershipMarkerFile);
      if (!await this._isOwnershipMarkerOpen(pid, normalizedMarker)) return observation;
      return {
        state: 'running',
        identity: this._normalizeSessionIdentity({
          ...observation.identity,
          ownershipMarkerFile: normalizedMarker
        }, pid, platform)
      };
    } catch (error) {
      return { state: 'unknown', error };
    }
  }

  async _isOwnershipMarkerOpen(pid, markerFile) {
    let result;
    try {
      result = await this._execFile(
        '/usr/sbin/lsof',
        ['-a', '-p', String(pid), '-Fpfn', markerFile],
        {
          encoding: 'utf8',
          timeout: this._identityInspectionTimeoutMs(),
          maxBuffer: 64 * 1024,
          windowsHide: true,
          env: { ...this._environment(), LC_ALL: 'C' }
        }
      );
    } catch (error) {
      if (error?.code === 1) return false;
      throw error;
    }
    const fields = String(result?.stdout ?? result).split(/\r?\n/);
    return fields.includes(`p${pid}`) && fields.some(field => /^f\S+/.test(field));
  }

  async _observeSessionIdentity(pid, ownershipMarkerFile) {
    try {
      return await this._inspectSessionIdentity(pid, ownershipMarkerFile);
    } catch (error) {
      return { state: 'unknown', error };
    }
  }

  _isSameSession(expected, observation) {
    const actual = observation?.state === 'running' ? observation.identity : null;
    return Boolean(
      this._hasCompleteSessionIdentity(expected) &&
      this._hasCompleteSessionIdentity(actual) &&
      this._isSameSessionIdentity(expected, actual)
    );
  }

  _hasCompleteSessionIdentity(identity) {
    return Boolean(
      Number.isInteger(identity?.pid) &&
      identity.pid > 0 &&
      identity.startTime &&
      identity.executable
    );
  }

  _isSameSessionIdentity(left, right) {
    const platform = this._platform();
    if (platform === 'darwin' && (left?.ownershipMarkerFile || right?.ownershipMarkerFile)) {
      // Terminal.app's shell keeps this private file open across exec. A reused
      // PID cannot acquire that kernel-held ownership marker accidentally.
      return Boolean(
        left?.ownershipMarkerFile && right?.ownershipMarkerFile &&
        left.ownershipMarkerFile === right.ownershipMarkerFile &&
        left?.bootId && right?.bootId && left.bootId === right.bootId &&
        left.pid === right.pid && left.startTime === right.startTime
      );
    }
    if (platform === 'linux') {
      // A Linux launcher reports its identity before exec'ing the user's login
      // shell. PID and process-start identity survive exec, while the boot ID
      // scopes them across restarts. The executable is expected to change.
      if (left?.bootId || right?.bootId) {
        return Boolean(
          left?.bootId && right?.bootId &&
          left.bootId === right.bootId &&
          left.pid === right.pid &&
          left.startTime === right.startTime
        );
      }
    }
    if (platform === 'darwin' && (left?.bootId || right?.bootId)) {
      return Boolean(
        left?.bootId && right?.bootId && left.bootId === right.bootId &&
        sameProcessIdentity(left, right)
      );
    }
    return sameProcessIdentity(left, right);
  }

  _classifySessionObservation(expected, observation) {
    if (this._isSameSession(expected, observation)) return 'same';
    if (observation?.state === 'absent') return 'gone';
    if (observation?.state === 'running' && this._hasCompleteSessionIdentity(observation.identity)) {
      return 'replaced';
    }
    return 'unknown';
  }

  async _adoptSession(pid, reportedIdentity = null, expectedExecutable = null, ownershipMarkerFile = null) {
    const observation = await this._observeSessionIdentity(pid, ownershipMarkerFile);
    const identity = observation?.state === 'running' ? observation.identity : null;
    if (!this._hasCompleteSessionIdentity(identity) || identity.pid !== pid) return null;
    if (ownershipMarkerFile && !identity.ownershipMarkerFile) return null;
    if (reportedIdentity && !this._isSameSessionIdentity(reportedIdentity, identity)) return null;
    if (expectedExecutable && path.win32.basename(identity.executable).toLowerCase() !== expectedExecutable) {
      return null;
    }
    return Object.freeze({ ...identity });
  }

  _killSession(pid, signal = 'SIGTERM') {
    return process.kill(pid, signal);
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  _markSessionCleanupPending(expected) {
    const tracked = this.sessions.get(expected.pid);
    if (!this._isSameSessionIdentity(tracked, expected)) return expected;
    if (tracked.cleanupPending) return tracked;
    const pending = Object.freeze({ ...tracked, cleanupPending: true });
    this.sessions.set(expected.pid, pending);
    return pending;
  }

  _removeTrackedSession(expected) {
    const tracked = this.sessions.get(expected.pid);
    if (!this._isSameSessionIdentity(tracked, expected)) return false;
    const next = new Map(this.sessions);
    next.delete(expected.pid);
    this._writeSessionJournal(next);
    this.sessions = next;
    return true;
  }

  async _waitForSessionChange(expected, timeoutMs) {
    const boundedTimeout = Math.max(0, Number(timeoutMs) || 0);
    const deadline = Date.now() + boundedTimeout;
    while (true) {
      const observation = await this._observeSessionIdentity(expected.pid);
      const state = this._classifySessionObservation(expected, observation);
      if (state !== 'same') return { state, observation };

      const remaining = deadline - Date.now();
      if (remaining <= 0) return { state, observation };
      const pollInterval = Math.max(1, Number(this.sessionExitPollIntervalMs) || 1);
      await this._sleep(Math.min(pollInterval, remaining));
    }
  }

  async _signalOwnedSession(expected, signal) {
    const observation = await this._observeSessionIdentity(expected.pid);
    const state = this._classifySessionObservation(expected, observation);
    if (state !== 'same') return { state, observation, error: null };

    let error = null;
    try {
      if (this._killSession(expected.pid, signal) === false) {
        error = new Error(`${signal} was not delivered`);
      }
    } catch (err) {
      error = err;
    }
    return { state: 'signalled', observation, error };
  }

  _finishSessionCleanup(identity) {
    try {
      this._cleanupOwnershipMarker(identity);
      this._removeTrackedSession(identity);
      return { stopped: true };
    } catch (error) {
      this._markSessionCleanupPending(identity);
      return { stopped: false, error };
    }
  }

  async _stopOwnedSession(originalIdentity) {
    let identity = originalIdentity;
    const initial = await this._observeSessionIdentity(identity.pid);
    const initialState = this._classifySessionObservation(identity, initial);
    if (initialState === 'gone' || initialState === 'replaced') {
      return this._finishSessionCleanup(identity);
    }
    if (initialState === 'unknown') {
      this._markSessionCleanupPending(identity);
      return { stopped: false, error: initial.error || new Error('process identity could not be verified') };
    }

    identity = this._markSessionCleanupPending(identity);
    const gracefulSignal = await this._signalOwnedSession(identity, 'SIGTERM');
    if (gracefulSignal.state === 'gone' || gracefulSignal.state === 'replaced') {
      return this._finishSessionCleanup(identity);
    }
    if (gracefulSignal.state === 'unknown') {
      return { stopped: false, error: gracefulSignal.observation?.error || new Error('process identity became ambiguous') };
    }

    const gracefulWait = await this._waitForSessionChange(identity, this.gracefulExitTimeoutMs);
    if (gracefulWait.state === 'gone' || gracefulWait.state === 'replaced') {
      return this._finishSessionCleanup(identity);
    }
    if (gracefulWait.state === 'unknown') {
      return { stopped: false, error: gracefulWait.observation?.error || gracefulSignal.error };
    }

    const forcedSignal = await this._signalOwnedSession(identity, 'SIGKILL');
    if (forcedSignal.state === 'gone' || forcedSignal.state === 'replaced') {
      return this._finishSessionCleanup(identity);
    }
    if (forcedSignal.state === 'unknown') {
      return { stopped: false, error: forcedSignal.observation?.error || new Error('process identity became ambiguous') };
    }

    const forcedWait = await this._waitForSessionChange(identity, this.forceExitTimeoutMs);
    if (forcedWait.state === 'gone' || forcedWait.state === 'replaced') {
      return this._finishSessionCleanup(identity);
    }
    return {
      stopped: false,
      error: forcedWait.observation?.error || forcedSignal.error || gracefulSignal.error ||
        new Error('terminal shell did not exit')
    };
  }

  _hasProcessExited(proc) {
    return !proc || proc.exitCode != null || proc.signalCode != null;
  }

  _signalAndWaitForProcessExit(proc, signal, timeoutMs) {
    if (this._hasProcessExited(proc)) return Promise.resolve({ exited: true, error: null });

    return new Promise(resolve => {
      let settled = false;
      let timeout = null;
      let signalError = null;
      const finish = (exited, error = signalError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        proc.removeListener('exit', onExit);
        proc.removeListener('error', onError);
        resolve({ exited, error });
      };
      const onExit = () => finish(true, null);
      const onError = error => {
        signalError = error;
        if (this._hasProcessExited(proc)) finish(true, error);
      };

      proc.once('exit', onExit);
      proc.on('error', onError);
      if (this._hasProcessExited(proc)) {
        finish(true, null);
        return;
      }

      const boundedTimeout = Math.max(0, Number(timeoutMs) || 0);
      timeout = setTimeout(() => finish(this._hasProcessExited(proc)), boundedTimeout);
      try {
        if (proc.kill(signal) === false && !this._hasProcessExited(proc)) {
          signalError = new Error(`${signal} was not delivered`);
        }
        if (this._hasProcessExited(proc)) finish(true, signalError);
      } catch (error) {
        signalError = error;
        if (this._hasProcessExited(proc)) finish(true, error);
      }
    });
  }

  async _stopLauncherProcess(proc) {
    if (this._hasProcessExited(proc)) {
      this.processes = this.processes.filter(candidate => candidate !== proc);
      return { stopped: true };
    }

    this.deactivatingProcesses.add(proc);
    const errors = [];
    try {
      const gracefulResult = await this._signalAndWaitForProcessExit(
        proc,
        'SIGTERM',
        this.gracefulExitTimeoutMs
      );
      if (gracefulResult.error) errors.push(gracefulResult.error);
      if (!gracefulResult.exited) {
        const forcedResult = await this._signalAndWaitForProcessExit(
          proc,
          'SIGKILL',
          this.forceExitTimeoutMs
        );
        if (forcedResult.error) errors.push(forcedResult.error);
      }

      if (this._hasProcessExited(proc)) {
        this.processes = this.processes.filter(candidate => candidate !== proc);
        return { stopped: true };
      }
      return { stopped: false, error: errors.at(-1) || new Error('terminal launcher did not exit') };
    } finally {
      this.deactivatingProcesses.delete(proc);
    }
  }

  async _refreshActiveState(reason = 'exited', extra = {}) {
    if (this.deactivating) return this.active;
    const wasActive = this.active;
    let cleanupError = null;
    for (const [pid, identity] of [...this.sessions]) {
      const observation = await this._observeSessionIdentity(pid);
      const state = this._classifySessionObservation(identity, observation);
      if ((state === 'gone' || state === 'replaced') && this.sessions.get(pid) === identity) {
        const result = this._finishSessionCleanup(identity);
        if (!result.stopped) {
          cleanupError = result.error;
          console.warn('[Interceptor] Failed to remove stale Fresh Terminal ownership:', result.error.message);
        }
      }
    }
    this.active = this.sessions.size > 0 || this.processes.some(isProcessRunning);
    if (wasActive && !this.active) {
      this._stopStatusMonitor();
      this._emitStatus(reason, extra);
    } else if (cleanupError) {
      this._emitStatus('cleanup-failed', { ...extra, error: cleanupError.message });
    }
    return this.active;
  }

  _startStatusMonitor() {
    this._stopStatusMonitor();
    this.statusMonitor = setInterval(() => { void this._refreshActiveState(); }, 1000);
    this.statusMonitor.unref?.();
  }

  _stopStatusMonitor() {
    if (this.statusMonitor) {
      clearInterval(this.statusMonitor);
      this.statusMonitor = null;
    }
  }

  _trackLauncherProcess(proc, sessionPid = null) {
    this.processes.push(proc);
    proc.on('exit', () => {
      if (!this.processes.includes(proc) && !this.deactivatingProcesses.has(proc)) return;
      this.processes = this.processes.filter(candidate => candidate !== proc);
      if (this.deactivatingProcesses.has(proc)) return;
      void this._refreshActiveState('exited', { pid: sessionPid || proc.pid });
    });

    proc.on('error', (err) => {
      if (this.deactivatingProcesses.has(proc)) return;
      if (!this.processes.includes(proc)) return;
      console.error('[Interceptor] Fresh terminal error:', err.message);
      if (this._hasProcessExited(proc)) {
        this.processes = this.processes.filter(candidate => candidate !== proc);
        void this._refreshActiveState('error', {
          pid: sessionPid || proc.pid,
          error: err.message
        });
      } else {
        this.active = true;
        this._emitStatus('error', { pid: sessionPid || proc.pid, error: err.message });
      }
    });
  }

  _buildPosixShellCommand(proxyUrl, certPath, handshake, {
    relaunchLoginShell = true,
    ownershipMarkerFile = null
  } = {}) {
    const reportPrefix = `{"nonce":"${handshake.nonce}","pid":`;
    const commands = [
      ...(ownershipMarkerFile ? [`exec 9<${shellQuote(ownershipMarkerFile)}`] : []),
      'umask 077',
      'set -C',
      `printf '%s%s%s\\n' ${shellQuote(reportPrefix)} "$$" '}' > ${shellQuote(handshake.reportFile)} || exit 1`,
      'set +C',
      'freeKitAcknowledged=0',
      'freeKitAttempt=0',
      `while [ "$freeKitAttempt" -lt 60 ]; do ` +
        `if [ -f ${shellQuote(handshake.acknowledgementFile)} ]; then ` +
          `freeKitAcknowledgement=$(cat ${shellQuote(handshake.acknowledgementFile)} 2>/dev/null) || exit 1; ` +
          `if [ "$freeKitAcknowledgement" = ${shellQuote(handshake.nonce)} ]; then ` +
            `rm -f ${shellQuote(handshake.acknowledgementFile)} ${shellQuote(handshake.reportFile)} || exit 1; ` +
            'freeKitAcknowledged=1; break; ' +
          'fi; exit 1; ' +
        'fi; freeKitAttempt=$((freeKitAttempt + 1)); sleep 0.05; ' +
      'done',
      '[ "$freeKitAcknowledged" -eq 1 ] || exit 1',
      ...Object.entries(buildTerminalEnvironment(proxyUrl, certPath))
        .map(([name, value]) => `export ${name}=${shellQuote(value)}`),
      `echo ${shellQuote(`HTTP FreeKit proxy active on ${proxyUrl}`)}`
    ];
    if (relaunchLoginShell) commands.push('exec "${SHELL:-/bin/sh}" -l');
    return commands.join('; ');
  }

  _buildWindowsPowerShellCommand(proxyUrl, handshake) {
    const reportFile = handshake.reportFile;
    const acknowledgementFile = handshake.acknowledgementFile;
    const acknowledgementNonce = handshake.nonce;
    return [
      'try {',
      '  $freeKitProcess = [Diagnostics.Process]::GetCurrentProcess()',
      '  $freeKitIdentity = [PSCustomObject]@{',
      '    pid = [int]$PID',
      '    startTime = [string]$freeKitProcess.StartTime.ToUniversalTime().Ticks',
      '    executable = [string]$freeKitProcess.MainModule.FileName',
      '  }',
      '  $freeKitReportBytes = [Text.Encoding]::UTF8.GetBytes(($freeKitIdentity | ConvertTo-Json -Compress))',
      `  $freeKitReport = [IO.File]::Open(${powerShellQuote(reportFile)}, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)`,
      '  try {',
      '    $freeKitReport.Write($freeKitReportBytes, 0, $freeKitReportBytes.Length)',
      '    $freeKitReport.Flush($true)',
      '  } finally {',
      '    $freeKitReport.Dispose()',
      '  }',
      '  $freeKitDeadline = [DateTime]::UtcNow.AddSeconds(3)',
      '  while ($true) {',
      '    try {',
      `      if ([IO.File]::ReadAllText(${powerShellQuote(acknowledgementFile)}) -ceq ${powerShellQuote(acknowledgementNonce)}) {`,
      `        Remove-Item -LiteralPath ${powerShellQuote(acknowledgementFile)} -Force -ErrorAction Stop`,
      '        break',
      '      }',
      '    } catch {}',
      '    if ([DateTime]::UtcNow -ge $freeKitDeadline) { exit 1 }',
      '    Start-Sleep -Milliseconds 50',
      '  }',
      '} catch {',
      '  exit 1',
      '}',
      `Write-Host ${powerShellQuote(`HTTP FreeKit proxy active on ${proxyUrl}`)} -ForegroundColor Green`
    ].join('\n');
  }

  async _launchTrackedPosixTerminal(command, args, env, handshake) {
    let proc;
    try {
      proc = await this._spawnDetached(command, args, { detached: true, stdio: 'ignore', env });
      const shellPid = await this._confirmLauncherStartup(
        proc,
        signal => this._waitForPosixShellReport(handshake, 3000, signal)
      );
      proc.unref();
      return { proc, shellPid };
    } catch (err) {
      try { proc?.kill(); } catch {}
      try {
        this._cleanupTerminalHandshake(handshake);
      } catch (error) {
        console.warn('[Interceptor] Failed to remove POSIX terminal handshake:', error.message);
      }
      throw err;
    }
  }

  _cleanupOwnershipMarker(identity) {
    if (!identity?.ownershipMarkerFile) return;
    const markerFile = this._normalizeOwnershipMarkerFile(identity.ownershipMarkerFile);
    fs.rmSync(path.dirname(markerFile), { recursive: true, force: true });
  }

  async isActivable() {
    const platform = this._platform();
    if (platform === 'win32' || platform === 'darwin') return true;
    return (await this._availableLinuxTerminalLaunchers()).length > 0;
  }

  async isActive() {
    return await this._refreshActiveState();
  }

  async activate(proxyPort) {
    if (this.recoveryJournalError) {
      throw new Error(
        `Fresh Terminal ownership journal is invalid and must be resolved before launch: ${this.recoveryJournalError.message}`
      );
    }
    const certPath = getTerminalCaPath(this.ca);
    const proxyUrl = formatProxyUrl(this.proxyHost, proxyPort);

    const baseEnvironment = {
      ...this._environment()
    };
    const platform = this._platform();
    for (const key of Object.keys(baseEnvironment)) {
      const name = platform === 'win32' ? key.toUpperCase() : key;
      if (name === 'NODE_TLS_REJECT_UNAUTHORIZED') delete baseEnvironment[key];
    }
    const env = {
      ...baseEnvironment,
      ...buildTerminalEnvironment(proxyUrl, certPath)
    };

    let proc;
    let shellPid = null;
    let sessionIdentity = null;
    let posixHandshake = null;

    if (platform === 'win32') {
      // Open Windows Terminal or PowerShell. Windows Terminal's launcher
      // is short-lived, so its child PowerShell reports the durable shell PID.
      const terminals = [
        {
          cmd: 'wt.exe',
          reportsPid: true,
          buildArgs: handshake => handshake
            ? [
                'new-tab',
                '--inheritEnvironment',
                'powershell.exe',
                '-NoExit',
                '-Command',
                this._buildWindowsPowerShellCommand(proxyUrl, handshake)
              ]
            : ['new-tab', '--inheritEnvironment']
        },
        {
          cmd: 'powershell.exe',
          reportsPid: true,
          buildArgs: handshake => [
            '-NoExit',
            '-Command',
            handshake
              ? this._buildWindowsPowerShellCommand(proxyUrl, handshake)
              : `Write-Host "HTTP FreeKit proxy active on ${proxyUrl}" -ForegroundColor Green`
          ]
        }
      ];

      for (const terminal of terminals) {
        let candidateProc;
        let launcherSpawned = false;
        const handshake = terminal.reportsPid ? this._createWindowsHandshake() : null;
        try {
          candidateProc = await this._spawnDetached(terminal.cmd, terminal.buildArgs(handshake), {
            detached: true,
            stdio: 'ignore',
            env
          });
          launcherSpawned = true;
          const reportedIdentity = await this._confirmLauncherStartup(
            candidateProc,
            signal => handshake
              ? this._waitForWindowsShellReport(handshake.reportFile, 3000, signal)
              : Promise.resolve(null)
          );
          candidateProc.unref();
          if (handshake) {
            const adoptedIdentity = await this._adoptSession(
              reportedIdentity.pid,
              reportedIdentity,
              'powershell.exe'
            );
            if (!adoptedIdentity) {
              throw new Error('the reported PowerShell process identity could not be verified');
            }
            await this._acknowledgeWindowsShell(handshake);
            shellPid = adoptedIdentity.pid;
            sessionIdentity = adoptedIdentity;
          }
          proc = candidateProc;
          break;
        } catch {
          try { candidateProc?.kill(); } catch {}
          if (launcherSpawned && handshake && terminal.cmd === 'wt.exe') {
            // wt.exe is only a client for the new tab. The unacknowledged
            // PowerShell command exits after three seconds; wait past that
            // boundary before starting a fallback shell.
            await this._sleep(this._windowsHandshakeCloseDelayMs());
          }
          continue;
        } finally {
          try {
            this._cleanupWindowsHandshake(handshake);
          } catch (error) {
            console.warn('[Interceptor] Failed to remove Windows terminal handshake:', error.message);
          }
        }
      }
    } else if (platform === 'darwin') {
      // macOS: open Terminal.app
      posixHandshake = this._createPosixHandshake();
      const shellCommand = this._buildPosixShellCommand(proxyUrl, certPath, posixHandshake, {
        // Terminal.app's `do script` already runs inside the durable login
        // shell. Its private open-file marker survives any later explicit exec.
        relaunchLoginShell: false,
        ownershipMarkerFile: posixHandshake.ownershipMarkerFile
      });
      const escapedCommand = shellCommand.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const script = `tell application "Terminal" to do script "${escapedCommand}"`;
      ({ proc, shellPid } = await this._launchTrackedPosixTerminal(
        'osascript',
        ['-e', script],
        baseEnvironment,
        posixHandshake
      ));
    } else {
      // Linux: try common terminals
      for (const terminal of this._linuxTerminalLaunchers()) {
        const candidateHandshake = this._createPosixHandshake();
        const shellCommand = this._buildPosixShellCommand(proxyUrl, certPath, candidateHandshake);
        const args = terminal.buildArgs(shellCommand);
        try {
          ({ proc, shellPid } = await this._launchTrackedPosixTerminal(
            terminal.command,
            args,
            baseEnvironment,
            candidateHandshake
          ));
          posixHandshake = candidateHandshake;
          break;
        } catch {
          continue;
        }
      }
    }

    if (!proc) {
      throw new Error('No supported terminal found');
    }

    try {
    if (!sessionIdentity && shellPid) {
      sessionIdentity = await this._adoptSession(
        shellPid,
        null,
        null,
        platform === 'darwin' ? posixHandshake?.ownershipMarkerFile : null
      );
    }
    this._trackLauncherProcess(proc, sessionIdentity?.pid || shellPid);
    if (!sessionIdentity) {
      const processResult = await this._stopLauncherProcess(proc);
      this.active = this.sessions.size > 0 || this.processes.some(isProcessRunning);
      const detail = 'the reported shell process identity could not be verified';
      if (!processResult.stopped) {
        this._startStatusMonitor();
        const message = `Fresh Terminal launch was rejected because ${detail}; ` +
          'the exact launcher handle remains tracked so Stop can be retried';
        this._emitStatus('stop-failed', { pid: shellPid || proc.pid, error: message });
        throw new Error(message);
      }
      throw new Error(
        `Fresh Terminal launch was rejected because ${detail}; its launcher was stopped`
      );
    }

    let ownershipWriteError = null;
    const sessionsBeforeOwnershipWrite = new Map(this.sessions);
    if (sessionIdentity) {
      try {
        this._addTrackedSession(sessionIdentity);
        if (posixHandshake) await this._acknowledgePosixShell(posixHandshake);
      } catch (error) {
        // The exact live identity is still safe to own in memory. Cleanup below
        // either confirms it gone or leaves this state available to Stop.
        this.sessions.set(sessionIdentity.pid, sessionIdentity);
        ownershipWriteError = error;
      }
    }
    this.active = this.sessions.size > 0 || this.processes.some(isProcessRunning);

    if (ownershipWriteError) {
      let sessionResult = await this._stopOwnedSession(sessionIdentity);
      if (!sessionResult.stopped) {
        const observation = await this._observeSessionIdentity(sessionIdentity.pid);
        const state = this._classifySessionObservation(sessionIdentity, observation);
        if (state === 'gone' || state === 'replaced') {
          // The failed atomic add left the previous journal intact. Once this
          // unpersisted shell is conclusively gone, restoring only its prior
          // map entry does not require another journal write.
          const tracked = this.sessions.get(sessionIdentity.pid);
          if (this._isSameSessionIdentity(tracked, sessionIdentity)) {
            const previous = sessionsBeforeOwnershipWrite.get(sessionIdentity.pid);
            if (previous) this.sessions.set(previous.pid, previous);
            else this.sessions.delete(sessionIdentity.pid);
          }
          sessionResult = { stopped: true };
        }
      }
      let processResult;
      if (proc.pid === sessionIdentity.pid) {
        processResult = sessionResult;
        if (sessionResult.stopped) {
          this.processes = this.processes.filter(candidate => candidate !== proc);
        }
      } else {
        processResult = await this._stopLauncherProcess(proc);
      }
      this.active = this.sessions.size > 0 || this.processes.some(isProcessRunning);
      if (!sessionResult.stopped || !processResult.stopped) {
        this._startStatusMonitor();
        const cleanupError = [sessionResult, processResult]
          .find(result => !result.stopped)?.error;
        const message = `Fresh Terminal ownership could not be persisted: ${ownershipWriteError.message}; ` +
          `the exact live process remains tracked so Stop can be retried${cleanupError ? ` (${cleanupError.message})` : ''}`;
        this._emitStatus('stop-failed', { pid: sessionIdentity.pid, error: message });
        throw new Error(message);
      }
      throw new Error(
        `Fresh Terminal ownership could not be persisted, so the launched session was stopped: ${ownershipWriteError.message}`
      );
    }

    this._emitStatus('active');
    if (this.active) this._startStatusMonitor();

    console.log(`[Interceptor] Fresh terminal opened with proxy ${proxyUrl}`);
    return { success: true, pid: sessionIdentity?.pid || proc.pid };
    } finally {
      if (posixHandshake) {
        try {
          const tracked = sessionIdentity && this.sessions.get(sessionIdentity.pid);
          this._cleanupTerminalHandshake(posixHandshake, {
            preserveOwnershipMarker: platform === 'darwin' &&
              Boolean(tracked?.ownershipMarkerFile) &&
              tracked.ownershipMarkerFile === sessionIdentity.ownershipMarkerFile
          });
        } catch (error) {
          console.warn('[Interceptor] Failed to remove POSIX terminal handshake:', error.message);
        }
      }
    }
  }

  async deactivate() {
    this._stopStatusMonitor();
    this.deactivating = true;
    const errors = [];
    try {
      if (this.recoveryJournalError && this.sessions.size === 0) {
        this.active = false;
        const message = `Fresh Terminal ownership journal is invalid and cannot be cleaned safely: ` +
          `${this.recoveryJournalError.message}. Stop can be retried after the journal is resolved`;
        this._emitStatus('stop-failed', { error: message });
        throw new Error(message);
      }
      const ownedSessionPids = new Set(this.sessions.keys());
      const sessionResults = await Promise.all(
        [...this.sessions.values()].map(identity => this._stopOwnedSession(identity))
      );
      const processResults = await Promise.all(
        [...this.processes]
          .filter(proc => !ownedSessionPids.has(proc.pid))
          .map(proc => this._stopLauncherProcess(proc))
      );
      for (const result of [...sessionResults, ...processResults]) {
        if (!result.stopped && result.error) errors.push(result.error);
      }
      this.processes = this.processes.filter(proc =>
        !ownedSessionPids.has(proc.pid) || this.sessions.has(proc.pid)
      );

      // A launcher exit may also close a shell that survived its own signal sequence.
      for (const [pid, identity] of [...this.sessions]) {
        const observation = await this._observeSessionIdentity(pid);
        const state = this._classifySessionObservation(identity, observation);
        if (state === 'gone' || state === 'replaced') {
          const result = this._finishSessionCleanup(identity);
          if (!result.stopped && result.error) errors.push(result.error);
        }
      }
      this.processes = this.processes.filter(proc => !this._hasProcessExited(proc));
      this.active = this.sessions.size > 0 || this.processes.some(isProcessRunning);

      if (this.active) {
        const detail = errors.at(-1)?.message;
        const message = `Fresh Terminal did not fully exit${detail ? `: ${detail}` : ''}; ` +
          'its process state was preserved so Stop can be retried';
        this._emitStatus('stop-failed', { error: message });
        throw new Error(message);
      }

      this._emitStatus('inactive');
    } finally {
      this.deactivating = false;
      this.deactivatingProcesses.clear();
      if (this.active) this._startStatusMonitor();
    }
  }

  async needsDeactivation() {
    return Boolean(
      this.deactivating || this.recoveryJournalError || this.sessions.size > 0 ||
      this.processes.some(proc => !this._hasProcessExited(proc))
    );
  }

  _emitStatus(reason, extra = {}) {
    if (typeof this.onStatusChange !== 'function') return;
    const sessionPid = this.sessions.keys().next().value;
    this.onStatusChange({
      id: this.id,
      name: this.name,
      type: 'terminal',
      active: this.active,
      pid: sessionPid || this.processes[0]?.pid || null,
      reason,
      ...extra
    });
  }

  toJSON() {
    const sessionPid = this.sessions.keys().next().value;
    return {
      id: this.id,
      name: this.name,
      type: 'terminal',
      active: this.active,
      pid: sessionPid || this.processes[0]?.pid || null
    };
  }
}

export class ExistingTerminalInterceptor {
  constructor(options = {}) {
    this.id = 'existing-terminal';
    this.name = 'Existing Terminal';
    this.proxyHost = getLocalProxyHost(options.proxyBindHost);
    this.active = false;
    this.ca = null;
    this.proxyPort = null;
  }

  async isActivable() {
    return true;
  }

  async isActive() {
    return false;
  }

  async activate(proxyPort) {
    this.proxyPort = proxyPort;
    this.active = false;
    const certPath = getTerminalCaPath(this.ca);
    const proxyUrl = formatProxyUrl(this.proxyHost, proxyPort);

    console.log(`[Interceptor] Existing terminal interceptor activated — users should set proxy env vars`);

    // Return the setup instructions as metadata
    return {
      success: true,
      metadata: {
        instructionsOnly: true,
        lifecycleNote: 'These variables remain active in the terminal until you unset them or close that shell.',
        nodeProxyNote: NODE_ENV_PROXY_SUPPORT_NOTE,
        proxyUrl,
        certPath,
        instructions: buildExistingTerminalInstructions(proxyUrl, certPath)
      }
    };
  }

  async deactivate() {
    this.active = false;
    this.proxyPort = null;
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      type: 'terminal',
      active: false,
      pid: null
    };
  }
}
