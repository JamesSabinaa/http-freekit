import { spawn } from 'child_process';
import fs from 'fs';
import { NODE_USE_ENV_PROXY_VALUE } from './node-environment-proxy.js';

export class ElectronInterceptor {
  constructor() {
    this.id = 'electron';
    this.name = 'Electron App';
    this.active = false;
    this.ca = null;
    this.process = null;
    this.activating = false;
    this.deactivationTimeoutMs = 3000;
    this.onStatusChange = null;
  }

  async isActivable() {
    // Always available — user provides the app path
    return true;
  }

  async isActive() {
    return this._hasActiveProcess();
  }

  _hasActiveProcess() {
    return Boolean(this.active && this.process);
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

  _spawnConfirmed(appPath, args, options) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this._spawn(appPath, args, options);
      } catch (err) {
        reject(err);
        return;
      }
      const onSpawn = () => {
        child.removeListener('error', onError);
        resolve(child);
      };
      const onError = err => {
        child.removeListener('spawn', onSpawn);
        reject(err);
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });
  }

  async activate(proxyPort, options = {}) {
    if (this.activating || this._hasActiveProcess()) {
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

    console.log(`[Interceptor] Launching Electron app: ${appPath}`);
    this.activating = true;
    let launchedProcess;
    try {
      launchedProcess = await this._spawnConfirmed(appPath, launchArgs, {
        detached: false,
        stdio: 'ignore',
        env
      });
    } catch (err) {
      throw new Error(`Failed to launch Electron app: ${err.message}`);
    } finally {
      this.activating = false;
    }
    this.process = launchedProcess;

    this.active = true;
    this._emitStatus('active');

    launchedProcess.on('exit', () => {
      if (this.process !== launchedProcess) return;
      this.active = false;
      this.process = null;
      this._emitStatus('exited', { pid: launchedProcess.pid });
    });

    launchedProcess.on('error', (err) => {
      if (this.process !== launchedProcess) return;
      console.error(`[Interceptor] Electron app error:`, err.message);
      this.active = false;
      this.process = null;
      this._emitStatus('error', { pid: launchedProcess.pid, error: err.message });
    });

    return { success: true, pid: launchedProcess.pid };
  }

  async deactivate() {
    const launchedProcess = this.process;
    if (!launchedProcess) {
      this.active = false;
      this._emitStatus('inactive', { pid: null });
      return;
    }

    let exited;
    try {
      exited = await this._requestProcessExit(launchedProcess);
    } catch (err) {
      this.active = true;
      this._emitStatus('stop-failed', { pid: launchedProcess.pid, error: err.message });
      throw new Error(`Failed to stop Electron app: ${err.message}. Stop can be retried`);
    }

    if (!exited) {
      this.active = true;
      this._emitStatus('stop-failed', { pid: launchedProcess.pid });
      throw new Error('Electron app did not exit; its process state was preserved so Stop can be retried');
    }

    if (this.process === launchedProcess) this.process = null;
    this.active = false;
    this._emitStatus('inactive', { pid: launchedProcess.pid });
  }

  _emitStatus(reason, extra = {}) {
    if (typeof this.onStatusChange !== 'function') return;
    this.onStatusChange({
      id: this.id,
      name: this.name,
      type: 'electron',
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
      type: 'electron',
      active: this.active,
      pid: this.process?.pid || null
    };
  }
}
