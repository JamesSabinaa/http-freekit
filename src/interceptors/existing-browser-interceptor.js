import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { findBrowserPath } from './browser-paths.js';
import { getProcessArgv0, getProcessSnapshotAsync } from './browser-lifecycle.js';
import { ensureChromiumLoopbackProxying } from './chromium-proxy-args.js';
import { normalizeBrowserUrl } from './browser-url.js';
import { waitForSpawnStability } from './command-runner.js';

const GLOBAL_BROWSER_OWNERSHIP_VERSION = 1;
const MAX_OWNERSHIP_JOURNAL_BYTES = 16 * 1024;
const MAX_EXECUTABLE_IDENTITY_LENGTH = 4096;

export class ExistingBrowserInterceptor {
  constructor(id, name, browserType, options = {}) {
    this.id = id;
    this.name = name;
    this.browserType = browserType;
    this.active = false;
    this.ca = null;
    this.process = null;
    this.deactivatingProcess = null;
    this.gracefulExitTimeoutMs = 2000;
    this.forceExitTimeoutMs = 2000;
    this.startupConfirmationMs = 500;
    this.processExitPollIntervalMs = 50;
    this.onStatusChange = null;
    this.recoveryFile = options.dataDir
      ? path.join(options.dataDir, `existing-browser-${browserType}-ownership.json`)
      : options.recoveryFile || null;
    this.ownership = null;
    this.recoveryJournalError = null;
    this._loadOwnershipJournal();
  }

  async isActivable() {
    return this.ca?.systemTrustInstalled === true && this._findBrowserPath() !== null;
  }

  async isActive() {
    if (this.ownership) return await this._refreshOwnedProcess();
    return this.active;
  }

  needsDeactivation() {
    return Boolean(this.active || this.process || this.ownership || this.recoveryJournalError);
  }

  _findBrowserPath() {
    return findBrowserPath(this.browserType);
  }

  _getProcessSnapshot() {
    return getProcessSnapshotAsync();
  }

  _getPlatform() {
    return process.platform;
  }

  _normalizeExecutableIdentity(executable, platform = this._getPlatform()) {
    if (typeof executable !== 'string') throw new Error('Browser executable identity is missing');
    const value = executable.trim();
    if (!value || value.length > MAX_EXECUTABLE_IDENTITY_LENGTH || /[\0\r\n]/.test(value)) {
      throw new Error('Browser executable identity is invalid');
    }
    const pathApi = platform === 'win32' ? path.win32 : path.posix;
    const normalized = pathApi.normalize(value).normalize('NFC');
    return platform === 'win32' ? normalized.toLowerCase() : normalized;
  }

  _sameOwnership(left, right) {
    return Boolean(left && right) &&
      left.version === right.version &&
      left.id === right.id &&
      left.browserType === right.browserType &&
      left.pid === right.pid &&
      left.startedAt === right.startedAt &&
      left.executable === right.executable &&
      left.platform === right.platform;
  }

  _validateOwnershipJournal(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error('Global browser ownership journal must contain an object');
    }
    const expectedKeys = ['browserType', 'executable', 'id', 'pid', 'platform', 'startedAt', 'version'];
    if (Object.keys(record).sort().join('\0') !== expectedKeys.join('\0') ||
        record.version !== GLOBAL_BROWSER_OWNERSHIP_VERSION ||
        record.id !== this.id || record.browserType !== this.browserType ||
        record.platform !== this._getPlatform() ||
        !Number.isSafeInteger(record.pid) || record.pid <= 0 || record.pid > 0xffffffff ||
        !Number.isFinite(record.startedAt)) {
      throw new Error('Global browser ownership journal has an invalid schema');
    }
    return Object.freeze({
      version: GLOBAL_BROWSER_OWNERSHIP_VERSION,
      id: this.id,
      browserType: this.browserType,
      pid: record.pid,
      startedAt: record.startedAt,
      executable: this._normalizeExecutableIdentity(record.executable),
      platform: record.platform
    });
  }

  _loadOwnershipJournal() {
    if (!this.recoveryFile) return;
    try {
      const stats = fs.lstatSync(this.recoveryFile);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_OWNERSHIP_JOURNAL_BYTES) {
        throw new Error('Global browser ownership journal must be a bounded regular file');
      }
      const parsed = JSON.parse(fs.readFileSync(this.recoveryFile, 'utf8'));
      this.ownership = this._validateOwnershipJournal(parsed);
      this.active = true;
    } catch (error) {
      if (error.code === 'ENOENT') return;
      this.recoveryJournalError = error;
      console.warn('[Interceptor] Ignoring invalid Global browser ownership journal:', error.message);
    }
  }

  _persistOwnershipJournal(ownership) {
    if (!this.recoveryFile) return;
    fs.mkdirSync(path.dirname(this.recoveryFile), { recursive: true });
    const tempPath = path.join(
      path.dirname(this.recoveryFile),
      `.${path.basename(this.recoveryFile)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
    );
    try {
      fs.writeFileSync(tempPath, JSON.stringify(ownership), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fs.renameSync(tempPath, this.recoveryFile);
    } finally {
      try { fs.unlinkSync(tempPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  _clearOwnership(expected = null) {
    if (expected && this.ownership && !this._sameOwnership(this.ownership, expected)) return false;
    if (this.recoveryFile) {
      try {
        fs.unlinkSync(this.recoveryFile);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    if (!expected || !this.ownership || this._sameOwnership(this.ownership, expected)) {
      this.ownership = null;
      this.recoveryJournalError = null;
    }
    return true;
  }

  async _observeOwnedProcess(ownership) {
    let snapshot;
    try {
      snapshot = await this._getProcessSnapshot();
      if (!Array.isArray(snapshot)) throw new Error('Process snapshot is not an array');
    } catch (error) {
      return { state: 'unknown', error };
    }
    const row = snapshot.find(candidate => candidate?.pid === ownership.pid);
    if (!row) return { state: 'absent' };
    try {
      const platform = this._getPlatform();
      const startedAt = typeof row.startedAt === 'number'
        ? row.startedAt
        : Date.parse(row.startedAt);
      if (!Number.isFinite(startedAt)) throw new Error('Browser process start identity is unavailable');
      const authoritativePosixCommand = platform !== 'win32' &&
        typeof row.commandName === 'string' && path.posix.isAbsolute(row.commandName)
        ? row.commandName
        : null;
      let executable = row.executablePath || authoritativePosixCommand || row.argv0 ||
        (platform === 'win32' ? null : row.commandName);

      // macOS `ps` flattens an unquoted application path containing spaces, so
      // argv0 alone becomes `/Applications/Google`. Pair the authoritative comm
      // name with the exact expected command prefix before restoring the full
      // executable identity. A same-named executable at another path cannot
      // satisfy this check.
      if (platform === 'darwin' && ownership.executable && !row.executablePath &&
          !authoritativePosixCommand) {
        const expected = this._normalizeExecutableIdentity(ownership.executable, platform);
        const commandName = typeof row.commandName === 'string'
          ? row.commandName.trim().normalize('NFC')
          : '';
        const command = typeof row.command === 'string' ? row.command.trimStart() : '';
        const expectedName = path.posix.basename(expected);
        const exactCommandPrefix = command === expected || command.startsWith(`${expected} `) ||
          command === `"${expected}"` || command.startsWith(`"${expected}" `);
        if (commandName === expectedName && exactCommandPrefix) executable = expected;
      }
      return {
        state: 'running',
        identity: {
          pid: row.pid,
          startedAt,
          executable: this._normalizeExecutableIdentity(executable)
        }
      };
    } catch (error) {
      return { state: 'unknown', error };
    }
  }

  _observationMatches(ownership, observation) {
    return observation?.state === 'running' &&
      observation.identity?.pid === ownership.pid &&
      observation.identity?.startedAt === ownership.startedAt &&
      observation.identity?.executable === ownership.executable;
  }

  async _refreshOwnedProcess() {
    const ownership = this.ownership;
    if (!ownership) return this.active;
    const observation = await this._observeOwnedProcess(ownership);
    if (!this._sameOwnership(this.ownership, ownership)) {
      return Boolean(this.active && (this.process || this.ownership));
    }
    if (observation.state === 'unknown') {
      this.active = true;
      return true;
    }
    if (this._observationMatches(ownership, observation)) {
      this.active = true;
      return true;
    }
    try {
      if (this.process?.pid === ownership.pid) this.process = null;
      this._clearOwnership(ownership);
      this.active = false;
      return false;
    } catch (error) {
      this.recoveryJournalError = error;
      this.active = true;
      return true;
    }
  }

  async _captureLaunchedOwnership(launchedProcess, browserPath) {
    const expectedExecutable = this._normalizeExecutableIdentity(browserPath);
    const provisional = {
      pid: launchedProcess.pid,
      executable: expectedExecutable
    };
    const observation = await this._observeOwnedProcess(provisional);
    if (observation.state !== 'running') {
      throw observation.error || new Error('Global browser process exited before ownership was recorded');
    }
    if (observation.identity.executable !== expectedExecutable) {
      throw new Error('Launched Global browser executable identity does not match the selected browser');
    }
    return Object.freeze({
      version: GLOBAL_BROWSER_OWNERSHIP_VERSION,
      id: this.id,
      browserType: this.browserType,
      pid: launchedProcess.pid,
      startedAt: observation.identity.startedAt,
      executable: observation.identity.executable,
      platform: this._getPlatform()
    });
  }

  async _isBrowserRunning(browserPath) {
    const platform = this._getPlatform();
    const pathApi = platform === 'win32' ? path.win32 : path.posix;
    const normalize = value => {
      const normalized = pathApi.normalize(String(value));
      return platform === 'win32' ? normalized.toLowerCase() : normalized;
    };
    const selectedPath = normalize(browserPath);
    const selectedName = normalize(pathApi.basename(browserPath));
    const selectedIsAbsolute = pathApi.isAbsolute(browserPath);
    const identityMatches = identity => {
      if (typeof identity !== 'string' || !identity || /[\0\r\n]/.test(identity)) return false;
      const value = identity.trim();
      if (!value) return false;
      if (pathApi.isAbsolute(value)) {
        return selectedIsAbsolute
          ? normalize(value) === selectedPath
          : normalize(pathApi.basename(value)) === selectedName;
      }
      return normalize(pathApi.basename(value)) === selectedName;
    };
    const processes = await this._getProcessSnapshot();
    return processes.some(processInfo => {
      if (processInfo.executablePath) {
        // A full OS-reported executable path is authoritative. Do not let a
        // same-named executable elsewhere, or its arguments, override it.
        return identityMatches(processInfo.executablePath);
      }
      if (platform !== 'win32' && identityMatches(processInfo.commandName)) return true;
      const argv0 = processInfo.argv0 || getProcessArgv0(processInfo.command, platform);
      return identityMatches(argv0);
    });
  }

  _spawn(browserPath, args, options) {
    return spawn(browserPath, args, options);
  }

  _waitForSpawn(launchedProcess) {
    return waitForSpawnStability(launchedProcess, {
      graceMs: this.startupConfirmationMs,
      label: this.name
    });
  }

  _hasExited(launchedProcess) {
    return launchedProcess.exitCode != null || launchedProcess.signalCode != null;
  }

  _signalAndWaitForExit(launchedProcess, signal, timeoutMs) {
    if (this._hasExited(launchedProcess)) {
      return Promise.resolve({ exited: true, error: null });
    }

    return new Promise(resolve => {
      let settled = false;
      let timeout = null;
      const finish = (exited, error = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        launchedProcess.removeListener('exit', onExit);
        launchedProcess.removeListener('error', onError);
        resolve({ exited, error });
      };
      const onExit = () => finish(true);
      const onError = err => finish(this._hasExited(launchedProcess), err);

      launchedProcess.once('exit', onExit);
      launchedProcess.once('error', onError);
      if (this._hasExited(launchedProcess)) {
        finish(true);
        return;
      }

      timeout = setTimeout(
        () => finish(this._hasExited(launchedProcess)),
        timeoutMs
      );
      try {
        const signalSent = launchedProcess.kill(signal);
        if (!signalSent && !this._hasExited(launchedProcess)) {
          finish(false, new Error(`${signal} was not delivered`));
        }
      } catch (err) {
        finish(this._hasExited(launchedProcess), err);
      }
    });
  }

  _killOwnedPid(pid, signal) {
    return process.kill(pid, signal);
  }

  async _requestRecoveredProcessExit(ownership, signal, timeoutMs) {
    const beforeSignal = await this._observeOwnedProcess(ownership);
    if (beforeSignal.state === 'unknown') throw beforeSignal.error;
    if (!this._observationMatches(ownership, beforeSignal)) return { exited: true, identityChanged: true };

    let signalSent;
    try {
      signalSent = this._killOwnedPid(ownership.pid, signal);
    } catch (error) {
      if (error.code === 'ESRCH') return { exited: true };
      throw error;
    }
    if (!signalSent) throw new Error(`${signal} was not delivered`);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, this.processExitPollIntervalMs));
      const observation = await this._observeOwnedProcess(ownership);
      if (observation.state === 'unknown') throw observation.error;
      if (!this._observationMatches(ownership, observation)) return { exited: true };
    }
    return { exited: false };
  }

  async activate(proxyPort, options = {}) {
    const launchOptions = { ...options };
    if (launchOptions.url) {
      launchOptions.url = normalizeBrowserUrl(launchOptions.url);
    }

    if (this.recoveryJournalError) {
      throw new Error(
        `${this.name} ownership journal is invalid and must be resolved before launch: ` +
        this.recoveryJournalError.message
      );
    }
    if (this.ownership && await this._refreshOwnedProcess()) {
      throw new Error(`${this.name} is already running`);
    }
    if (this.active || this.process || this.ownership) {
      throw new Error(`${this.name} is already running`);
    }
    if (this.ca?.systemTrustInstalled !== true) {
      throw new Error(
        `${this.name} requires the HTTP FreeKit CA to be installed in the system trust store; ` +
        'scoped Chromium certificate trust requires an isolated user-data directory'
      );
    }
    const browserPath = this._findBrowserPath();
    if (!browserPath) {
      throw new Error(`${this.name} not found on this system`);
    }
    if (await this._isBrowserRunning(browserPath)) {
      throw new Error(`Close every ${this.name.replace(/^Global\s+/, '')} window before activating ${this.name}`);
    }

    // For "Global" mode, we re-launch the browser with proxy flags but using
    // the user's existing default profile (no --user-data-dir override)
    const args = [
      `--proxy-server=127.0.0.1:${proxyPort}`,
    ];

    if (launchOptions.url) {
      args.push(launchOptions.url);
    }
    const launchArgs = ensureChromiumLoopbackProxying(args);

    console.log(`[Interceptor] Launching ${this.name} (existing profile) with proxy on port ${proxyPort}`);
    const launchedProcess = this._spawn(browserPath, launchArgs, {
      detached: false,
      stdio: 'ignore'
    });
    await this._waitForSpawn(launchedProcess);
    let ownership = null;
    this.process = launchedProcess;

    launchedProcess.on('exit', () => {
      if (this.process !== launchedProcess) return;
      if (this.deactivatingProcess === launchedProcess) return;
      this.active = false;
      this.process = null;
      if (ownership && this._sameOwnership(this.ownership, ownership)) {
        try {
          this._clearOwnership(ownership);
        } catch (error) {
          this.recoveryJournalError = error;
          console.warn(`[Interceptor] Failed to remove ${this.name} ownership journal after exit:`, error.message);
        }
      }
      this._emitStatus('exited', { pid: launchedProcess.pid });
    });

    launchedProcess.on('error', (err) => {
      if (this.process !== launchedProcess) return;
      console.error(`[Interceptor] ${this.name} error:`, err.message);
      this.active = true;
      this._emitStatus('process-error', { pid: launchedProcess.pid, error: err.message });
    });

    if (this.recoveryFile) {
      try {
        ownership = await this._captureLaunchedOwnership(launchedProcess, browserPath);
        if (this._hasExited(launchedProcess)) {
          throw new Error(`${this.name} exited before its ownership could be recorded`);
        }
        this._persistOwnershipJournal(ownership);
        this.ownership = ownership;
        if (this._hasExited(launchedProcess)) {
          this._clearOwnership(ownership);
          throw new Error(`${this.name} exited before its ownership could be recorded`);
        }
      } catch (error) {
        let exited = this._hasExited(launchedProcess);
        if (!exited) {
          const graceful = await this._signalAndWaitForExit(
            launchedProcess,
            'SIGTERM',
            this.gracefulExitTimeoutMs
          );
          exited = graceful.exited;
        }
        if (!exited) {
          const forced = await this._signalAndWaitForExit(
            launchedProcess,
            'SIGKILL',
            this.forceExitTimeoutMs
          );
          exited = forced.exited;
        }
        if (!exited) {
          this.active = true;
          this._emitStatus('cleanup-failed', {
            pid: launchedProcess.pid,
            launchFailed: true,
            error: error.message
          });
        } else {
          if (this.process === launchedProcess) this.process = null;
          if (ownership && this._sameOwnership(this.ownership, ownership)) {
            try { this._clearOwnership(ownership); } catch (cleanupError) {
              this.recoveryJournalError = cleanupError;
            }
          }
        }
        throw new Error(`Could not record ${this.name} ownership safely: ${error.message}`);
      }
    }

    this.active = true;
    this._emitStatus('active');

    return { success: true, pid: launchedProcess.pid, browser: this.name };
  }

  async deactivate() {
    const launchedProcess = this.process;
    const ownership = this.ownership;
    if (this.recoveryJournalError && !ownership) {
      throw new Error(
        `Failed to stop ${this.name} safely: ownership journal is invalid. ` +
        'Stop can be retried after the journal is resolved'
      );
    }
    if (!launchedProcess && !ownership) {
      this.active = false;
      this._emitStatus('inactive', { pid: null });
      return;
    }

    if (ownership) {
      if (launchedProcess && launchedProcess.pid !== ownership.pid) {
        throw new Error(`Live ${this.name} process handle does not match its ownership record`);
      }
      const observation = await this._observeOwnedProcess(ownership);
      if (observation.state === 'unknown') {
        this.active = true;
        this._emitStatus('stop-failed', { pid: ownership.pid, error: observation.error?.message });
        throw new Error(
          `Could not verify ${this.name} ownership: ${observation.error?.message || 'unknown error'}. ` +
          'Stop can be retried'
        );
      }
      if (!this._observationMatches(ownership, observation)) {
        if (this.process?.pid === ownership.pid) this.process = null;
        this._clearOwnership(ownership);
        this.active = false;
        this._emitStatus('inactive', { pid: ownership.pid });
        return;
      }
    }

    this.deactivatingProcess = launchedProcess || ownership;
    const errors = [];
    let exited = launchedProcess ? this._hasExited(launchedProcess) : false;

    try {
      if (!exited) {
        const gracefulResult = launchedProcess
          ? await this._signalAndWaitForExit(
            launchedProcess,
            'SIGTERM',
            this.gracefulExitTimeoutMs
          )
          : await this._requestRecoveredProcessExit(
            ownership,
            'SIGTERM',
            this.gracefulExitTimeoutMs
          );
        exited = gracefulResult.exited;
        if (gracefulResult.error) errors.push(gracefulResult.error);
      }

      if (!exited) {
        const forcedResult = launchedProcess
          ? await this._signalAndWaitForExit(
            launchedProcess,
            'SIGKILL',
            this.forceExitTimeoutMs
          )
          : await this._requestRecoveredProcessExit(
            ownership,
            'SIGKILL',
            this.forceExitTimeoutMs
          );
        exited = forcedResult.exited;
        if (forcedResult.error) errors.push(forcedResult.error);
      }

      if (!exited) {
        this.active = true;
        const detail = errors.at(-1)?.message;
        throw new Error(
          `${this.name} did not exit${detail ? `: ${detail}` : ''}; ` +
          'its process state was preserved so Stop can be retried'
        );
      }

      if (launchedProcess && this.process === launchedProcess) this.process = null;
      if (ownership && this._sameOwnership(this.ownership, ownership)) {
        try {
          this._clearOwnership(ownership);
        } catch (error) {
          this.active = false;
          this.recoveryJournalError = error;
          this._emitStatus('stop-failed', { pid: ownership.pid, error: error.message });
          throw new Error(
            `${this.name} exited but its ownership journal could not be removed: ${error.message}. ` +
            'Stop can be retried'
          );
        }
      }
      this.active = false;
      this._emitStatus('inactive', { pid: launchedProcess?.pid || ownership?.pid });
    } catch (error) {
      if (!/ownership journal could not be removed/.test(error.message)) {
        this.active = true;
        this._emitStatus('stop-failed', {
          pid: launchedProcess?.pid || ownership?.pid,
          error: error.message
        });
      }
      throw error;
    } finally {
      if (this.deactivatingProcess === (launchedProcess || ownership)) {
        this.deactivatingProcess = null;
      }
    }
  }

  _emitStatus(reason, extra = {}) {
    if (typeof this.onStatusChange !== 'function') return;
    this.onStatusChange({
      id: this.id,
      name: this.name,
      type: this.browserType,
      active: this.active,
      pid: this.process?.pid || this.ownership?.pid || null,
      reason,
      ...extra
    });
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      type: this.browserType,
      active: this.active,
      pid: this.process?.pid || this.ownership?.pid || null
    };
  }
}
