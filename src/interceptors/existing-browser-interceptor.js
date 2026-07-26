import { spawn } from 'child_process';
import path from 'path';
import { findBrowserPath } from './browser-paths.js';
import { getProcessArgv0, getProcessSnapshotAsync } from './browser-lifecycle.js';
import { ensureChromiumLoopbackProxying } from './chromium-proxy-args.js';
import { normalizeBrowserUrl } from './browser-url.js';

export class ExistingBrowserInterceptor {
  constructor(id, name, browserType) {
    this.id = id;
    this.name = name;
    this.browserType = browserType;
    this.active = false;
    this.ca = null;
    this.process = null;
    this.deactivatingProcess = null;
    this.gracefulExitTimeoutMs = 2000;
    this.forceExitTimeoutMs = 2000;
    this.onStatusChange = null;
  }

  async isActivable() {
    return this.ca?.systemTrustInstalled === true && this._findBrowserPath() !== null;
  }

  async isActive() {
    return this.active;
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
    return new Promise((resolve, reject) => {
      const onSpawn = () => {
        launchedProcess.removeListener('error', onError);
        resolve();
      };
      const onError = (err) => {
        launchedProcess.removeListener('spawn', onSpawn);
        reject(err);
      };

      launchedProcess.once('spawn', onSpawn);
      launchedProcess.once('error', onError);
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

  async activate(proxyPort, options = {}) {
    const launchOptions = { ...options };
    if (launchOptions.url) {
      launchOptions.url = normalizeBrowserUrl(launchOptions.url);
    }

    if (this.active || this.process) {
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
    this.process = launchedProcess;

    this.active = true;
    this._emitStatus('active');

    launchedProcess.on('exit', () => {
      if (this.process !== launchedProcess) return;
      if (this.deactivatingProcess === launchedProcess) return;
      this.active = false;
      this.process = null;
      this._emitStatus('exited', { pid: launchedProcess.pid });
    });

    launchedProcess.on('error', (err) => {
      if (this.process !== launchedProcess) return;
      console.error(`[Interceptor] ${this.name} error:`, err.message);
      this.active = true;
      this._emitStatus('process-error', { pid: launchedProcess.pid, error: err.message });
    });

    return { success: true, pid: launchedProcess.pid, browser: this.name };
  }

  async deactivate() {
    const launchedProcess = this.process;
    if (!launchedProcess) {
      this.active = false;
      this._emitStatus('inactive', { pid: null });
      return;
    }

    this.deactivatingProcess = launchedProcess;
    const errors = [];
    let exited = this._hasExited(launchedProcess);

    try {
      if (!exited) {
        const gracefulResult = await this._signalAndWaitForExit(
          launchedProcess,
          'SIGTERM',
          this.gracefulExitTimeoutMs
        );
        exited = gracefulResult.exited;
        if (gracefulResult.error) errors.push(gracefulResult.error);
      }

      if (!exited) {
        const forcedResult = await this._signalAndWaitForExit(
          launchedProcess,
          'SIGKILL',
          this.forceExitTimeoutMs
        );
        exited = forcedResult.exited;
        if (forcedResult.error) errors.push(forcedResult.error);
      }

      if (!exited) {
        if (this.process === launchedProcess) {
          this.active = true;
          const error = errors.at(-1);
          this._emitStatus('stop-failed', {
            pid: launchedProcess.pid,
            ...(error ? { error: error.message } : {})
          });
        }
        const detail = errors.at(-1)?.message;
        throw new Error(
          `${this.name} did not exit${detail ? `: ${detail}` : ''}; ` +
          'its process state was preserved so Stop can be retried'
        );
      }

      if (this.process === launchedProcess) {
        this.process = null;
        this.active = false;
        this._emitStatus('inactive', { pid: launchedProcess.pid });
      }
    } finally {
      if (this.deactivatingProcess === launchedProcess) {
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
      pid: this.process?.pid || null,
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
      pid: this.process?.pid || null
    };
  }
}
