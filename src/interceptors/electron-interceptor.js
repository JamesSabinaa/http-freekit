import { execFile, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { NODE_USE_ENV_PROXY_VALUE } from './node-environment-proxy.js';

const ELECTRON_OWNERSHIP_VERSION = 1;
const MAX_OWNERSHIP_JOURNAL_BYTES = 16 * 1024;
const MAX_EXECUTABLE_IDENTITY_LENGTH = 4096;

export class ElectronInterceptor {
  constructor(options = {}) {
    this.id = 'electron';
    this.name = 'Electron App';
    this.active = false;
    this.ca = null;
    this.process = null;
    this.activating = false;
    this.deactivationTimeoutMs = 3000;
    this.processExitPollIntervalMs = 50;
    this.onStatusChange = null;
    this.recoveryFile = options.dataDir
      ? path.join(options.dataDir, 'electron-child-ownership.json')
      : options.recoveryFile || null;
    this.ownership = null;
    this.recoveryJournalError = null;
    this._processIdentityLookup = options.processIdentityLookup
      || (pid => this._inspectProcessIdentity(pid));
    this._loadOwnershipJournal();
  }

  async isActivable() {
    // Always available — user provides the app path
    return true;
  }

  async isActive() {
    if (this.ownership) return await this._refreshOwnedProcess();
    return this._hasActiveProcess();
  }

  _hasActiveProcess() {
    return Boolean(this.active && (this.process || this.ownership));
  }

  _hasExited(launchedProcess) {
    return launchedProcess.exitCode != null || launchedProcess.signalCode != null;
  }

  _requestProcessExit(launchedProcess) {
    if (this._hasExited(launchedProcess)) return Promise.resolve(true);

    return new Promise((resolve, reject) => {
      let timeout;
      const cleanup = () => {
        clearTimeout(timeout);
        launchedProcess.removeListener('exit', onExit);
      };
      const onExit = () => {
        cleanup();
        resolve(true);
      };

      launchedProcess.once('exit', onExit);
      timeout = setTimeout(() => {
        cleanup();
        resolve(false);
      }, this.deactivationTimeoutMs);

      try {
        if (!launchedProcess.kill() && !this._hasExited(launchedProcess)) {
          cleanup();
          resolve(false);
        }
      } catch (err) {
        cleanup();
        reject(err);
      }
    });
  }

  _getLaunchArgs(proxyPort) {
    const args = [`--proxy-server=http://127.0.0.1:${proxyPort}`];

    if (this.ca?.systemTrustInstalled !== true) {
      const spkiFingerprint = typeof this.ca?.getSpkiFingerprint === 'function'
        ? this.ca.getSpkiFingerprint()
        : '';
      if (typeof spkiFingerprint !== 'string' || !spkiFingerprint.trim()) {
        throw new Error('FreeKit CA SPKI fingerprint is unavailable for scoped Electron renderer trust');
      }
      args.push(`--ignore-certificate-errors-spki-list=${spkiFingerprint.trim()}`);
    }

    return args;
  }

  _getMainProcessCaBundlePath() {
    try {
      if (typeof this.ca?.getTerminalCaBundlePath !== 'function') {
        throw new Error('the combined public and FreeKit CA bundle is not configured');
      }
      const bundlePath = this.ca.getTerminalCaBundlePath();
      if (typeof bundlePath !== 'string' || !bundlePath.trim()) {
        throw new Error('the combined public and FreeKit CA bundle path is empty');
      }
      const stats = fs.statSync(bundlePath);
      if (!stats.isFile() || stats.size === 0) {
        throw new Error('the combined public and FreeKit CA bundle is not a readable file');
      }
      fs.accessSync(bundlePath, fs.constants.R_OK);
      return bundlePath;
    } catch (err) {
      throw new Error(`FreeKit CA trust bundle is unavailable for Electron launch: ${err.message}`);
    }
  }

  _environment() {
    return process.env;
  }

  _getLaunchEnvironment(proxyPort, caBundlePath) {
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;
    const env = {
      ...this._environment(),
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      NO_PROXY: '',
      no_proxy: '',
      NODE_USE_ENV_PROXY: NODE_USE_ENV_PROXY_VALUE
    };
    for (const name of Object.keys(env)) {
      const normalizedName = name.toUpperCase();
      if (normalizedName === 'NODE_TLS_REJECT_UNAUTHORIZED' ||
          normalizedName === 'NODE_EXTRA_CA_CERTS') {
        delete env[name];
      }
    }
    env.NODE_EXTRA_CA_CERTS = caBundlePath;
    return env;
  }

  _spawn(appPath, args, options) {
    return spawn(appPath, args, options);
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

  _probeProcessPid(pid) {
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

  _normalizeProcessIdentity(identity, expectedPid, platform = this._platform()) {
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
      executable: this._normalizeExecutableIdentity(identity.executable, platform),
      platform
    });
  }

  _parseLinuxProcessStart(stat, pid) {
    const commandEnd = stat.lastIndexOf(')');
    if (!stat.startsWith(`${pid} (`) || commandEnd < 0) {
      throw new Error('Linux process metadata is ambiguous');
    }
    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
    const startTime = fields[19];
    if (!/^\d+$/.test(startTime || '')) {
      throw new Error('Linux process start identity is unavailable');
    }
    return startTime;
  }

  async _inspectLinuxProcessIdentity(pid) {
    const procDirectory = `/proc/${pid}`;
    const statBefore = await fs.promises.readFile(path.join(procDirectory, 'stat'), 'utf8');
    const startTime = this._parseLinuxProcessStart(statBefore, pid);
    const executable = await fs.promises.readlink(path.join(procDirectory, 'exe'));
    const statAfter = await fs.promises.readFile(path.join(procDirectory, 'stat'), 'utf8');
    if (this._parseLinuxProcessStart(statAfter, pid) !== startTime) {
      throw new Error('Process identity changed during inspection');
    }
    return { pid, startTime, executable };
  }

  async _inspectDarwinProcessIdentity(pid) {
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
    if (!Number.isFinite(startTime)) throw new Error('macOS process start identity is unavailable');
    return { pid, startTime: String(startTime), executable: match[3] };
  }

  async _inspectWindowsProcessIdentity(pid) {
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
      const error = new Error('Electron process is absent');
      error.code = 'ESRCH';
      throw error;
    }
    return identity;
  }

  async _inspectProcessIdentity(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff) {
      return { state: 'unknown', error: new Error('Process ID is invalid') };
    }
    try {
      let identity;
      const platform = this._platform();
      if (platform === 'win32') identity = await this._inspectWindowsProcessIdentity(pid);
      else if (platform === 'darwin') identity = await this._inspectDarwinProcessIdentity(pid);
      else identity = await this._inspectLinuxProcessIdentity(pid);
      return { state: 'running', identity };
    } catch (error) {
      const state = this._probeProcessPid(pid);
      return state === 'absent' ? { state } : { state: 'unknown', error };
    }
  }

  async _observeProcessIdentity(pid) {
    try {
      const observation = await this._processIdentityLookup(pid);
      if (observation?.state === 'absent') return { state: 'absent' };
      if (observation?.state !== 'running') {
        return { state: 'unknown', error: observation?.error };
      }
      try {
        return {
          state: 'running',
          identity: this._normalizeProcessIdentity(observation.identity, pid)
        };
      } catch (error) {
        return { state: 'unknown', error };
      }
    } catch (error) {
      return { state: 'unknown', error };
    }
  }

  _sameProcessIdentity(left, right) {
    return Boolean(
      left && right &&
      left.pid === right.pid &&
      left.startTime === right.startTime &&
      left.executable === right.executable &&
      left.platform === right.platform
    );
  }

  _classifyProcessObservation(expected, observation) {
    if (observation?.state === 'absent') return 'gone';
    if (observation?.state !== 'running') return 'unknown';
    return this._sameProcessIdentity(expected, observation.identity) ? 'same' : 'replaced';
  }

  _validateOwnershipJournal(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error('Ownership journal must contain an object');
    }
    const keys = Object.keys(record).sort();
    const expectedKeys = ['executable', 'pid', 'platform', 'startTime', 'version'];
    if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
      throw new Error('Ownership journal has an invalid schema');
    }
    if (record.version !== ELECTRON_OWNERSHIP_VERSION ||
        !['darwin', 'linux', 'win32'].includes(record.platform)) {
      throw new Error('Ownership journal has an unsupported version or platform');
    }
    const identity = this._normalizeProcessIdentity(record, record.pid, record.platform);
    return Object.freeze({ version: ELECTRON_OWNERSHIP_VERSION, ...identity });
  }

  _loadOwnershipJournal() {
    if (!this.recoveryFile) return;
    try {
      let stats;
      try {
        stats = fs.lstatSync(this.recoveryFile);
      } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
      }
      if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_OWNERSHIP_JOURNAL_BYTES) {
        throw new Error('Ownership journal is not a bounded regular file');
      }
      const parsed = JSON.parse(fs.readFileSync(this.recoveryFile, 'utf8'));
      this.ownership = this._validateOwnershipJournal(parsed);
      this.active = true;
    } catch (error) {
      this.recoveryJournalError = error;
      console.warn('[Interceptor] Ignoring invalid Electron ownership journal:', error.message);
    }
  }

  _persistOwnershipJournal(identity) {
    if (!this.recoveryFile) return;
    const record = this._validateOwnershipJournal({
      version: ELECTRON_OWNERSHIP_VERSION,
      ...identity
    });
    fs.mkdirSync(path.dirname(this.recoveryFile), { recursive: true });
    const tempPath = path.join(
      path.dirname(this.recoveryFile),
      `.${path.basename(this.recoveryFile)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
    );
    let descriptor;
    try {
      descriptor = fs.openSync(tempPath, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify(record), 'utf8');
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

  _removeOwnershipJournal() {
    if (!this.recoveryFile) return;
    try {
      fs.unlinkSync(this.recoveryFile);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  _clearOwnership(expected) {
    if (expected && this.ownership && !this._sameProcessIdentity(this.ownership, expected)) return;
    this._removeOwnershipJournal();
    if (!expected || !this.ownership || this._sameProcessIdentity(this.ownership, expected)) {
      this.ownership = null;
      this.recoveryJournalError = null;
    }
  }

  async _refreshOwnedProcess() {
    const expected = this.ownership;
    if (!expected) return this._hasActiveProcess();
    const observation = await this._observeProcessIdentity(expected.pid);
    const state = this._classifyProcessObservation(expected, observation);
    if (state === 'same' || state === 'unknown') {
      this.active = true;
      return true;
    }

    const wasActive = this.active;
    if (this.process?.pid === expected.pid) this.process = null;
    try {
      this._clearOwnership(expected);
    } catch (error) {
      console.warn('[Interceptor] Failed to remove stale Electron ownership journal:', error.message);
      this.active = true;
      return true;
    }
    this.active = false;
    if (wasActive) this._emitStatus('exited', { pid: expected.pid });
    return false;
  }

  _killOwnedPid(pid) {
    return process.kill(pid);
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async _waitForOwnedProcessChange(expected, timeoutMs) {
    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    while (true) {
      const observation = await this._observeProcessIdentity(expected.pid);
      const state = this._classifyProcessObservation(expected, observation);
      if (state !== 'same') return { state, observation };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { state, observation };
      await this._sleep(Math.min(Math.max(1, this.processExitPollIntervalMs), remaining));
    }
  }

  async _requestRecoveredProcessExit(expected) {
    const observation = await this._observeProcessIdentity(expected.pid);
    const state = this._classifyProcessObservation(expected, observation);
    if (state !== 'same') return { state, observation };
    try {
      this._killOwnedPid(expected.pid);
    } catch (error) {
      const afterSignalFailure = await this._observeProcessIdentity(expected.pid);
      const afterState = this._classifyProcessObservation(expected, afterSignalFailure);
      return { state: afterState, observation: afterSignalFailure, error };
    }
    return await this._waitForOwnedProcessChange(expected, this.deactivationTimeoutMs);
  }

  _platform() {
    return process.platform;
  }

  async _readMacBundleExecutable(infoPlistPath) {
    try {
      const { stdout } = await this._execFile('/usr/bin/plutil', [
        '-extract', 'CFBundleExecutable', 'raw', '-o', '-', infoPlistPath
      ], {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 64 * 1024,
        stdio: ['ignore', 'pipe', 'ignore']
      });
      return stdout.replace(/\r?\n$/, '');
    } catch {
      throw new Error('macOS application bundle has no readable CFBundleExecutable metadata');
    }
  }

  async _resolveMacApplicationBundle(bundlePath) {
    const bundleRoot = fs.realpathSync(bundlePath);
    const contentsPath = path.join(bundleRoot, 'Contents');
    const macOsPath = path.join(contentsPath, 'MacOS');
    const infoPlistPath = path.join(contentsPath, 'Info.plist');

    let contentsIsDirectory = false;
    let macOsIsDirectory = false;
    let infoPlistIsFile = false;
    try { contentsIsDirectory = fs.statSync(contentsPath).isDirectory(); } catch {}
    try { macOsIsDirectory = fs.statSync(macOsPath).isDirectory(); } catch {}
    try { infoPlistIsFile = fs.statSync(infoPlistPath).isFile(); } catch {}
    if (!contentsIsDirectory || !macOsIsDirectory) {
      throw new Error('macOS application bundle is missing its Contents/MacOS directory');
    }
    if (!infoPlistIsFile) {
      throw new Error('macOS application bundle is missing Contents/Info.plist');
    }

    const executableName = await this._readMacBundleExecutable(infoPlistPath);
    if (!executableName || /[\\/\0\r\n]/.test(executableName) ||
        executableName === '.' || executableName === '..' ||
        path.basename(executableName) !== executableName) {
      throw new Error('macOS application bundle has invalid CFBundleExecutable metadata');
    }

    const realMacOsPath = fs.realpathSync(macOsPath);
    let executablePath;
    try {
      executablePath = fs.realpathSync(path.join(realMacOsPath, executableName));
    } catch {
      throw new Error(`macOS application bundle executable "${executableName}" does not exist`);
    }
    const relativeExecutablePath = path.relative(realMacOsPath, executablePath);
    if (!relativeExecutablePath || relativeExecutablePath === '..' ||
        relativeExecutablePath.startsWith('..' + path.sep) ||
        path.isAbsolute(relativeExecutablePath)) {
      throw new Error('macOS application bundle executable resolves outside Contents/MacOS');
    }
    const executableStats = fs.statSync(executablePath);
    if (!executableStats.isFile()) {
      throw new Error('macOS application bundle executable is not a file');
    }
    try {
      fs.accessSync(executablePath, fs.constants.X_OK);
    } catch {
      throw new Error('macOS application bundle executable is not executable');
    }
    return executablePath;
  }

  async _resolveLaunchPath(appPath) {
    if (typeof appPath !== 'string' || !appPath.trim() || appPath.includes('\0')) {
      throw new Error('Electron application path is invalid');
    }
    if (this._platform() !== 'darwin') return appPath;

    const isApplicationBundle = path.basename(path.resolve(appPath)).toLowerCase().endsWith('.app');
    const isBareCommand = !path.isAbsolute(appPath) && path.dirname(appPath) === '.';
    let stats;
    try {
      stats = fs.statSync(appPath);
    } catch (err) {
      if (isApplicationBundle && !isBareCommand) {
        throw new Error(`macOS application bundle is unavailable: ${err.message}`);
      }
      return appPath;
    }

    if (stats.isDirectory()) {
      if (!isApplicationBundle) {
        throw new Error('Electron application path is a directory, not a macOS .app bundle');
      }
      return await this._resolveMacApplicationBundle(appPath);
    }
    if (isApplicationBundle) {
      throw new Error('macOS .app selection is not an application bundle directory');
    }
    return appPath;
  }

  _spawnConfirmed(appPath, args, options) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this._spawn(appPath, args, options);
      } catch (err) {
        reject(err);
        return;
      }
      const lifecycle = { exit: null, error: null };
      let spawned = false;
      const cleanup = () => {
        child.removeListener('spawn', onSpawn);
        child.removeListener('exit', onExit);
        child.removeListener('error', onError);
      };
      const onSpawn = () => {
        spawned = true;
        child.removeListener('spawn', onSpawn);
        resolve({ process: child, lifecycle, cleanup });
      };
      const onError = err => {
        if (spawned) {
          lifecycle.error ||= err;
          return;
        }
        cleanup();
        reject(err);
      };
      const onExit = (code, signal) => {
        lifecycle.exit = { code, signal };
        if (spawned) return;
        cleanup();
        reject(new Error('Electron app exited before its launch was confirmed'));
      };
      child.once('spawn', onSpawn);
      child.once('exit', onExit);
      child.on('error', onError);
    });
  }

  _trackLaunchedProcess(launchedProcess, ownership = null) {
    this.process = launchedProcess;
    this.ownership = ownership;
    this.active = true;

    launchedProcess.on('exit', () => {
      if (this.process !== launchedProcess) return;
      this.process = null;
      if (ownership && this._sameProcessIdentity(this.ownership, ownership)) {
        try {
          this._clearOwnership(ownership);
        } catch (error) {
          this.active = true;
          console.warn('[Interceptor] Failed to remove Electron ownership journal after exit:', error.message);
          this._emitStatus('cleanup-failed', { pid: launchedProcess.pid, error: error.message });
          return;
        }
      }
      this.active = Boolean(this.ownership);
      this._emitStatus('exited', { pid: launchedProcess.pid });
    });

    launchedProcess.on('error', (err) => {
      if (this.process !== launchedProcess) return;
      console.error(`[Interceptor] Electron app error:`, err.message);
      if (this._hasExited(launchedProcess)) {
        this.process = null;
        if (ownership && this._sameProcessIdentity(this.ownership, ownership)) {
          try {
            this._clearOwnership(ownership);
          } catch (cleanupError) {
            this.active = true;
            this._emitStatus('cleanup-failed', {
              pid: launchedProcess.pid,
              error: cleanupError.message
            });
            return;
          }
        }
        this.active = Boolean(this.ownership);
      }
      this._emitStatus('error', { pid: launchedProcess.pid, error: err.message });
    });
  }

  async _cleanupFailedLaunch(launchedProcess, launchError) {
    let exited = false;
    let cleanupError = null;
    try {
      exited = await this._requestProcessExit(launchedProcess);
    } catch (error) {
      cleanupError = error;
    }
    if (exited || this._hasExited(launchedProcess)) {
      if (this.process === launchedProcess) this.process = null;
      this.active = false;
      return launchError;
    }

    this._trackLaunchedProcess(launchedProcess);
    this._emitStatus('stop-failed', {
      pid: launchedProcess.pid,
      error: cleanupError?.message || 'exit was not confirmed'
    });
    return new Error(
      `${launchError.message}; the launched app could not be confirmed stopped and remains tracked so Stop can be retried`
    );
  }

  async activate(proxyPort, options = {}) {
    if (this.activating || Boolean(this.active && this.process)) {
      throw new Error('An Electron app is already being intercepted');
    }
    if (this.recoveryJournalError) {
      throw new Error(`Electron ownership journal is invalid and must be resolved before launch: ${this.recoveryJournalError.message}`);
    }
    if (this.ownership && await this._refreshOwnedProcess()) {
      throw new Error('An Electron app is already being intercepted');
    }

    const appPath = options.appPath;
    if (!appPath) {
      // Return instructions for manual setup
      const launchArgs = this._getLaunchArgs(proxyPort);
      return {
        success: true,
        metadata: {
          instructions: `Launch your Electron app with:\n  your-app ${launchArgs.join(' ')}`
        }
      };
    }

    const caBundlePath = this._getMainProcessCaBundlePath();
    const launchArgs = this._getLaunchArgs(proxyPort);
    const env = this._getLaunchEnvironment(proxyPort, caBundlePath);

    this.activating = true;
    let launchedProcess;
    let pendingLaunch;
    try {
      const launchPath = await this._resolveLaunchPath(appPath);
      console.log(`[Interceptor] Launching Electron app: ${launchPath}`);
      pendingLaunch = await this._spawnConfirmed(launchPath, launchArgs, {
        detached: false,
        stdio: 'ignore',
        env
      });
      launchedProcess = pendingLaunch.process;
      if (pendingLaunch.lifecycle.exit || this._hasExited(launchedProcess)) {
        throw new Error('Electron app exited before its ownership could be recorded');
      }
      if (pendingLaunch.lifecycle.error) throw pendingLaunch.lifecycle.error;

      let ownership = null;
      if (this.recoveryFile) {
        const observation = await this._observeProcessIdentity(launchedProcess.pid);
        if (pendingLaunch.lifecycle.exit || this._hasExited(launchedProcess)) {
          throw new Error('Electron app exited before its ownership could be recorded');
        }
        if (pendingLaunch.lifecycle.error) throw pendingLaunch.lifecycle.error;
        if (observation.state !== 'running') {
          throw new Error(
            `Electron process identity could not be recorded: ${observation.error?.message || 'identity is unavailable'}`
          );
        }
        ownership = Object.freeze({
          version: ELECTRON_OWNERSHIP_VERSION,
          ...observation.identity
        });
        this._persistOwnershipJournal(ownership);
      }
      this._trackLaunchedProcess(launchedProcess, ownership);
      pendingLaunch.cleanup();
    } catch (err) {
      const exitedBeforeTracking = Boolean(
        pendingLaunch?.lifecycle.exit || (launchedProcess && this._hasExited(launchedProcess))
      );
      const failure = launchedProcess && !this.process && !exitedBeforeTracking
        ? await this._cleanupFailedLaunch(launchedProcess, err)
        : err;
      pendingLaunch?.cleanup();
      throw new Error(`Failed to launch Electron app: ${failure.message}`);
    } finally {
      this.activating = false;
    }
    this._emitStatus('active');

    return { success: true, pid: launchedProcess.pid };
  }

  async deactivate() {
    const launchedProcess = this.process;
    const ownership = this.ownership;
    if (this.recoveryJournalError && !launchedProcess && !ownership) {
      this._emitStatus('stop-failed', { pid: null, error: this.recoveryJournalError.message });
      throw new Error(`Failed to stop Electron app safely: ownership journal is invalid. Stop can be retried after the journal is resolved`);
    }
    if (!launchedProcess && !ownership) {
      this.active = false;
      this._emitStatus('inactive', { pid: null });
      return;
    }

    let exited;
    try {
      if (ownership) {
        if (launchedProcess && launchedProcess.pid !== ownership.pid) {
          throw new Error('live Electron process handle does not match its ownership record');
        }
        const observation = await this._observeProcessIdentity(ownership.pid);
        const state = this._classifyProcessObservation(ownership, observation);
        if (state === 'gone' || state === 'replaced') {
          if (launchedProcess?.pid === ownership.pid) this.process = null;
          this._clearOwnership(ownership);
          this.active = false;
          this._emitStatus('inactive', { pid: ownership.pid });
          return;
        }
        if (state === 'unknown') {
          throw observation.error || new Error('process identity could not be verified');
        }

        if (launchedProcess) {
          exited = await this._requestProcessExit(launchedProcess);
        } else {
          const result = await this._requestRecoveredProcessExit(ownership);
          if (result.state === 'gone' || result.state === 'replaced') {
            exited = true;
          } else if (result.state === 'unknown') {
            throw result.observation?.error || result.error || new Error('process identity became ambiguous');
          } else {
            exited = false;
          }
        }
      } else {
        exited = await this._requestProcessExit(launchedProcess);
      }
    } catch (err) {
      this.active = true;
      this._emitStatus('stop-failed', { pid: launchedProcess?.pid || ownership?.pid, error: err.message });
      throw new Error(`Failed to stop Electron app: ${err.message}. Stop can be retried`);
    }

    if (!exited) {
      this.active = true;
      this._emitStatus('stop-failed', { pid: launchedProcess?.pid || ownership?.pid });
      throw new Error('Electron app did not exit; its process state was preserved so Stop can be retried');
    }

    if (this.process === launchedProcess) this.process = null;
    if (ownership && this._sameProcessIdentity(this.ownership, ownership)) {
      try {
        this._clearOwnership(ownership);
      } catch (err) {
        this.active = true;
        this._emitStatus('stop-failed', { pid: ownership.pid, error: err.message });
        throw new Error(`Electron app exited but its ownership journal could not be removed: ${err.message}. Stop can be retried`);
      }
    }
    this.active = false;
    this._emitStatus('inactive', { pid: launchedProcess?.pid || ownership?.pid });
  }

  async needsDeactivation() {
    return Boolean(this.activating || this.process || this.ownership || this.recoveryJournalError);
  }

  _emitStatus(reason, extra = {}) {
    if (typeof this.onStatusChange !== 'function') return;
    this.onStatusChange({
      id: this.id,
      name: this.name,
      type: 'electron',
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
      type: 'electron',
      active: this.active,
      pid: this.process?.pid || this.ownership?.pid || null
    };
  }
}
