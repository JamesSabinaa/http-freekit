import { execFile, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  NODE_ENV_PROXY_SUPPORT_NOTE,
  NODE_USE_ENV_PROXY_VALUE
} from './node-environment-proxy.js';

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
const TERMINAL_SESSION_OWNERSHIP_VERSION = 1;
const MAX_TERMINAL_OWNERSHIP_BYTES = 64 * 1024;
const MAX_TERMINAL_SESSIONS = 32;
const MAX_EXECUTABLE_IDENTITY_LENGTH = 4096;
const MAX_TERMINAL_HANDSHAKE_BYTES = 4096;

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

function cmdSet(variable, value) {
  return `set "${variable}=${String(value)}"`;
}

function getTerminalCaPath(ca) {
  if (!ca) return '';
  if (typeof ca.getTerminalCaBundlePath === 'function') {
    return ca.getTerminalCaBundlePath();
  }
  const certInfo = ca.getCertInfo();
  return certInfo.terminalCaBundlePath || certInfo.certificatePath || '';
}

function buildTerminalEnvironment(proxyUrl, certPath) {
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: '',
    no_proxy: '',
    NODE_USE_ENV_PROXY: NODE_USE_ENV_PROXY_VALUE,
    SSL_CERT_FILE: certPath,
    NODE_EXTRA_CA_CERTS: certPath,
    REQUESTS_CA_BUNDLE: certPath,
    CURL_CA_BUNDLE: certPath
  };
}

export function buildExistingTerminalInstructions(proxyUrl, certPath) {
  const environment = Object.entries(buildTerminalEnvironment(proxyUrl, certPath));
  return {
    bash: `unset NODE_TLS_REJECT_UNAUTHORIZED; export ${environment.map(([name, value]) => `${name}=${shellQuote(value)}`).join(' ')}`,
    powershell: [
      'Remove-Item Env:NODE_TLS_REJECT_UNAUTHORIZED -ErrorAction SilentlyContinue',
      ...environment.map(([name, value]) => `$env:${name}=${powerShellQuote(value)}`)
    ].join('; '),
    cmd: [cmdSet('NODE_TLS_REJECT_UNAUTHORIZED', ''), ...environment.map(([name, value]) => cmdSet(name, value))].join('&& ')
  };
}

export class FreshTerminalInterceptor {
  constructor(options = {}) {
    this.id = 'fresh-terminal';
    this.name = 'Fresh Terminal';
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

  _launcherStartupGraceMs() {
    return 100;
  }

  _windowsHandshakeCloseDelayMs() {
    return 3250;
  }

  _confirmLauncherStartup(proc, graceMs = this._launcherStartupGraceMs()) {
    const failure = (code, signal) => {
      const detail = signal ? `signal ${signal}` : `exit code ${code}`;
      return new Error(`Terminal launcher failed during startup (${detail})`);
    };

    if (proc.signalCode !== null) {
      return Promise.reject(failure(proc.exitCode, proc.signalCode));
    }
    if (proc.exitCode !== null) {
      return proc.exitCode === 0
        ? Promise.resolve()
        : Promise.reject(failure(proc.exitCode, null));
    }

    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        proc.removeListener('exit', onExit);
        proc.removeListener('error', onError);
      };
      const finish = (callback, value) => {
        cleanup();
        callback(value);
      };
      const onExit = (code, signal) => {
        if (code === 0 && !signal) {
          finish(resolve);
        } else {
          finish(reject, failure(code, signal));
        }
      };
      const onError = (err) => finish(reject, err);

      proc.once('exit', onExit);
      proc.once('error', onError);
      timer = setTimeout(() => finish(resolve), graceMs);
    });
  }

  _createPidFilePath() {
    return path.join(os.tmpdir(), `http-freekit-terminal-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.pid`);
  }

  async _waitForShellPid(pidFile, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
        if (Number.isInteger(pid) && pid > 0) return pid;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Terminal shell did not report its process ID');
  }

  async _waitForWindowsShellReport(reportFile, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const stat = fs.lstatSync(reportFile);
        if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_TERMINAL_HANDSHAKE_BYTES) {
          throw new Error('Terminal shell identity report is not a bounded regular file');
        }
        const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
        return this._normalizeSessionIdentity(report, report?.pid, 'win32');
      } catch {}
      await this._sleep(50);
    }
    throw new Error('Terminal shell did not report a verifiable process identity');
  }

  async _acknowledgeWindowsShell(reportFile, timeoutMs = 3000) {
    const acknowledgementFile = `${reportFile}.ack`;
    fs.writeFileSync(acknowledgementFile, String(process.pid), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!fs.existsSync(acknowledgementFile)) return;
      await this._sleep(50);
    }
    throw new Error('Terminal shell did not acknowledge its verified identity');
  }

  _probeSessionPid(pid) {
    try {
      process.kill(pid, 0);
      return 'running';
    } catch (err) {
      if (err?.code === 'EPERM') return 'running';
      if (err?.code === 'ESRCH') return 'absent';
      return 'unknown';
    }
  }

  _identityInspectionTimeoutMs() {
    return this._platform() === 'win32' ? 5000 : 1000;
  }

  _execFile(command, args, options) {
    return new Promise((resolve, reject) => {
      execFile(command, args, options, (err, stdout, stderr) => {
        if (err) {
          err.stderr = stderr;
          reject(err);
        } else {
          resolve({ stdout, stderr });
        }
      });
    });
  }

  _normalizeExecutableIdentity(executable, platform = this._platform()) {
    if (typeof executable !== 'string') {
      throw new Error('Process executable identity is missing');
    }
    const value = executable.trim();
    if (!value || value.length > MAX_EXECUTABLE_IDENTITY_LENGTH || /[\0\r\n]/.test(value)) {
      throw new Error('Process executable identity is invalid');
    }
    const platformPath = platform === 'win32' ? path.win32 : path.posix;
    const normalized = platformPath.normalize(value).normalize('NFC');
    return platform === 'win32' ? normalized.toLowerCase() : normalized;
  }

  _normalizeSessionIdentity(identity, expectedPid = identity?.pid, platform = this._platform()) {
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
      throw new Error('Process identity is missing or malformed');
    }
    if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0 ||
        identity.pid > 0xffffffff || identity.pid !== expectedPid) {
      throw new Error('Process identity PID is missing, invalid, or unexpected');
    }
    const startTime = String(identity.startTime || '');
    if (!/^\d{1,32}$/.test(startTime)) {
      throw new Error('Process start identity is missing or invalid');
    }
    return Object.freeze({
      pid: identity.pid,
      startTime,
      executable: this._normalizeExecutableIdentity(identity.executable, platform)
    });
  }

  _sessionJournalEntry(identity, platform = this._platform()) {
    const normalized = this._normalizeSessionIdentity(identity, identity?.pid, platform);
    return {
      pid: normalized.pid,
      startTime: normalized.startTime,
      executable: normalized.executable,
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
      const expectedKeys = ['executable', 'pid', 'platform', 'startTime'];
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
    const commandEnd = stat.lastIndexOf(')');
    if (!stat.startsWith(`${pid} (`) || commandEnd < 0) {
      throw new Error('Linux process metadata is ambiguous');
    }
    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
    const startTime = fields[19];
    if (!/^\d+$/.test(startTime || '')) {
      throw new Error('Linux process start time is unavailable');
    }
    return startTime;
  }

  async _inspectLinuxSessionIdentity(pid) {
    const procDirectory = `/proc/${pid}`;
    const statBefore = await fs.promises.readFile(path.join(procDirectory, 'stat'), 'utf8');
    const startTime = this._parseLinuxProcessStart(statBefore, pid);
    const executable = await fs.promises.readlink(path.join(procDirectory, 'exe'));
    const statAfter = await fs.promises.readFile(path.join(procDirectory, 'stat'), 'utf8');
    if (this._parseLinuxProcessStart(statAfter, pid) !== startTime) {
      throw new Error('Process identity changed during inspection');
    }
    return {
      pid,
      startTime,
      executable: this._normalizeExecutableIdentity(executable)
    };
  }

  async _inspectDarwinSessionIdentity(pid) {
    const { stdout } = await this._execFile(
      '/bin/ps',
      ['-ww', '-p', String(pid), '-o', 'pid=', '-o', 'lstart=', '-o', 'comm='],
      {
        timeout: this._identityInspectionTimeoutMs(),
        maxBuffer: 16 * 1024,
        windowsHide: true,
        env: { ...this._environment(), LC_ALL: 'C' }
      }
    );
    const lines = String(stdout).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines.length !== 1) throw new Error('macOS process metadata is ambiguous');
    const match = lines[0].match(/^(\d+)\s+(\S+\s+\S+\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
    if (!match || Number(match[1]) !== pid) throw new Error('macOS process metadata is invalid');
    const startTime = Date.parse(match[2]);
    if (!Number.isFinite(startTime)) throw new Error('macOS process start time is unavailable');
    return {
      pid,
      startTime: String(startTime),
      executable: this._normalizeExecutableIdentity(match[3])
    };
  }

  async _inspectWindowsSessionIdentity(pid) {
    const script = [
      `$target = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop | Select-Object -First 1`,
      "if ($null -eq $target) { [Console]::Out.Write('null'); exit 0 }",
      '$identity = [PSCustomObject]@{',
      '  pid = [int]$target.ProcessId',
      "  startTime = [string]([DateTime]$target.CreationDate).ToUniversalTime().Ticks",
      '  executable = [string]$target.ExecutablePath',
      '}',
      '[Console]::Out.Write(($identity | ConvertTo-Json -Compress))'
    ].join('\n');
    const { stdout } = await this._execFile(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      {
        encoding: 'utf8',
        timeout: this._identityInspectionTimeoutMs(),
        maxBuffer: 16 * 1024,
        windowsHide: true
      }
    );
    const serialized = String(stdout).trim();
    if (!serialized) throw new Error('Windows process identity query returned no result');
    const identity = JSON.parse(serialized);
    if (identity === null) {
      const error = new Error('Terminal process is absent');
      error.code = 'ESRCH';
      throw error;
    }
    return identity;
  }

  async _inspectSessionIdentity(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return { state: 'unknown' };
    try {
      const platform = this._platform();
      const identity = platform === 'win32'
        ? await this._inspectWindowsSessionIdentity(pid)
        : platform === 'darwin'
          ? await this._inspectDarwinSessionIdentity(pid)
          : await this._inspectLinuxSessionIdentity(pid);
      return {
        state: 'running',
        identity: this._normalizeSessionIdentity(identity, pid, platform)
      };
    } catch (error) {
      const state = this._probeSessionPid(pid);
      return state === 'absent' ? { state } : { state: 'unknown', error };
    }
  }

  async _observeSessionIdentity(pid) {
    try {
      return await this._inspectSessionIdentity(pid);
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
    return Boolean(
      left &&
      right &&
      left.pid === right.pid &&
      left.startTime === right.startTime &&
      left.executable === right.executable
    );
  }

  _classifySessionObservation(expected, observation) {
    if (this._isSameSession(expected, observation)) return 'same';
    if (observation?.state === 'absent') return 'gone';
    if (observation?.state === 'running' && this._hasCompleteSessionIdentity(observation.identity)) {
      return 'replaced';
    }
    return 'unknown';
  }

  async _adoptSession(pid, reportedIdentity = null, expectedExecutable = null) {
    const observation = await this._observeSessionIdentity(pid);
    const identity = observation?.state === 'running' ? observation.identity : null;
    if (!this._hasCompleteSessionIdentity(identity) || identity.pid !== pid) return null;
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

  _buildPosixShellCommand(proxyUrl, certPath, pidFile) {
    return [
      `printf '%s' "$$" > ${shellQuote(pidFile)}`,
      ...Object.entries(buildTerminalEnvironment(proxyUrl, certPath))
        .map(([name, value]) => `export ${name}=${shellQuote(value)}`),
      `echo ${shellQuote(`HTTP FreeKit proxy active on ${proxyUrl}`)}`,
      'exec "${SHELL:-/bin/sh}" -l'
    ].join('; ');
  }

  _buildWindowsPowerShellCommand(proxyUrl, pidFile) {
    return [
      'try {',
      "  $freeKitProcess = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + $PID) -ErrorAction Stop | Select-Object -First 1",
      '  if ($null -eq $freeKitProcess) { exit 1 }',
      '  $freeKitIdentity = [PSCustomObject]@{',
      '    pid = [int]$PID',
      '    startTime = [string]([DateTime]$freeKitProcess.CreationDate).ToUniversalTime().Ticks',
      '    executable = [string]$freeKitProcess.ExecutablePath',
      '  }',
      `  [IO.File]::WriteAllText(${powerShellQuote(pidFile)}, ($freeKitIdentity | ConvertTo-Json -Compress))`,
      '  $freeKitDeadline = [DateTime]::UtcNow.AddSeconds(3)',
      `  while (-not [IO.File]::Exists(${powerShellQuote(`${pidFile}.ack`)})) {`,
      '    if ([DateTime]::UtcNow -ge $freeKitDeadline) { exit 1 }',
      '    Start-Sleep -Milliseconds 50',
      '  }',
      `  Remove-Item -LiteralPath ${powerShellQuote(`${pidFile}.ack`)} -Force -ErrorAction Stop`,
      '} catch {',
      '  exit 1',
      '}',
      `Write-Host ${powerShellQuote(`HTTP FreeKit proxy active on ${proxyUrl}`)} -ForegroundColor Green`
    ].join('\n');
  }

  async _launchTrackedPosixTerminal(command, args, env, pidFile) {
    const proc = await this._spawnDetached(command, args, { detached: true, stdio: 'ignore', env });
    try {
      await this._confirmLauncherStartup(proc);
      proc.unref();
      const shellPid = await this._waitForShellPid(pidFile);
      return { proc, shellPid };
    } catch (err) {
      try { proc.kill(); } catch {}
      throw err;
    } finally {
      try { fs.unlinkSync(pidFile); } catch {}
    }
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
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;

    const env = {
      ...this._environment(),
      ...buildTerminalEnvironment(proxyUrl, certPath)
    };
    delete env.NODE_TLS_REJECT_UNAUTHORIZED;

    let proc;
    const platform = this._platform();
    let shellPid = null;
    let sessionIdentity = null;

    if (platform === 'win32') {
      // Open Windows Terminal, PowerShell, or cmd. Windows Terminal's launcher
      // is short-lived, so its child PowerShell reports the durable shell PID.
      const terminals = [
        {
          cmd: 'wt.exe',
          reportsPid: true,
          buildArgs: pidFile => pidFile
            ? [
                'new-tab',
                '--inheritEnvironment',
                'powershell.exe',
                '-NoExit',
                '-Command',
                this._buildWindowsPowerShellCommand(proxyUrl, pidFile)
              ]
            : ['new-tab', '--inheritEnvironment']
        },
        {
          cmd: 'powershell.exe',
          reportsPid: true,
          buildArgs: pidFile => [
            '-NoExit',
            '-Command',
            pidFile
              ? this._buildWindowsPowerShellCommand(proxyUrl, pidFile)
              : `Write-Host "HTTP FreeKit proxy active on ${proxyUrl}" -ForegroundColor Green`
          ]
        },
        {
          cmd: 'cmd.exe',
          reportsPid: false,
          buildArgs: () => ['/K', `echo HTTP FreeKit proxy active on ${proxyUrl}`]
        }
      ];

      for (const terminal of terminals) {
        let candidateProc;
        let launcherStarted = false;
        const pidFile = terminal.reportsPid ? this._createPidFilePath() : null;
        try {
          candidateProc = await this._spawnDetached(terminal.cmd, terminal.buildArgs(pidFile), {
            detached: true,
            stdio: 'ignore',
            env
          });
          await this._confirmLauncherStartup(candidateProc);
          launcherStarted = true;
          candidateProc.unref();
          if (pidFile) {
            const reportedIdentity = await this._waitForWindowsShellReport(pidFile);
            const adoptedIdentity = await this._adoptSession(
              reportedIdentity.pid,
              reportedIdentity,
              'powershell.exe'
            );
            if (!adoptedIdentity) {
              throw new Error('the reported PowerShell process identity could not be verified');
            }
            await this._acknowledgeWindowsShell(pidFile);
            shellPid = adoptedIdentity.pid;
            sessionIdentity = adoptedIdentity;
          } else if (this.recoveryFile) {
            const adoptedIdentity = await this._adoptSession(
              candidateProc.pid,
              null,
              'cmd.exe'
            );
            const confirmation = adoptedIdentity
              ? await this._observeSessionIdentity(candidateProc.pid)
              : null;
            if (!adoptedIdentity || this._hasProcessExited(candidateProc) ||
                !this._isSameSession(adoptedIdentity, confirmation)) {
              throw new Error('the cmd launcher process identity could not be verified');
            }
            shellPid = adoptedIdentity.pid;
            sessionIdentity = adoptedIdentity;
          }
          proc = candidateProc;
          break;
        } catch {
          try { candidateProc?.kill(); } catch {}
          if (launcherStarted && pidFile && terminal.cmd === 'wt.exe') {
            // wt.exe is only a client for the new tab. The unacknowledged
            // PowerShell command exits after three seconds; wait past that
            // boundary before starting a fallback shell.
            await this._sleep(this._windowsHandshakeCloseDelayMs());
          }
          continue;
        } finally {
          if (pidFile) {
            try { fs.unlinkSync(pidFile); } catch {}
            try { fs.unlinkSync(`${pidFile}.ack`); } catch {}
          }
        }
      }
    } else if (platform === 'darwin') {
      // macOS: open Terminal.app
      const pidFile = this._createPidFilePath();
      const shellCommand = this._buildPosixShellCommand(proxyUrl, certPath, pidFile);
      const escapedCommand = shellCommand.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const script = `tell application "Terminal" to do script "${escapedCommand}"`;
      ({ proc, shellPid } = await this._launchTrackedPosixTerminal('osascript', ['-e', script], env, pidFile));
    } else {
      // Linux: try common terminals
      for (const terminal of this._linuxTerminalLaunchers()) {
        const pidFile = this._createPidFilePath();
        const shellCommand = this._buildPosixShellCommand(proxyUrl, certPath, pidFile);
        const args = terminal.buildArgs(shellCommand);
        try {
          ({ proc, shellPid } = await this._launchTrackedPosixTerminal(
            terminal.command,
            args,
            env,
            pidFile
          ));
          break;
        } catch {
          continue;
        }
      }
    }

    if (!proc) {
      throw new Error('No supported terminal found');
    }

    if (!sessionIdentity && shellPid) sessionIdentity = await this._adoptSession(shellPid);
    this._trackLauncherProcess(proc, sessionIdentity?.pid || shellPid);
    if (this.recoveryFile && !sessionIdentity) {
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
  constructor() {
    this.id = 'existing-terminal';
    this.name = 'Existing Terminal';
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
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;

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
