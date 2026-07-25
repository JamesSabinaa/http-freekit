import { spawn } from 'child_process';

export class ElectronInterceptor {
  constructor() {
    this.id = 'electron';
    this.name = 'Electron App';
    this.active = false;
    this.ca = null;
    this.process = null;
    this.activating = false;
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
    return this.active && this.process && !this.process.killed;
  }

  _getLaunchArgs(proxyPort) {
    const spkiFingerprint = this.ca ? this.ca.getSpkiFingerprint() : '';
    return [
      `--proxy-server=http://127.0.0.1:${proxyPort}`,
      '--ignore-certificate-errors',
      `--ignore-certificate-errors-spki-list=${spkiFingerprint}`
    ];
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
    const launchArgs = this._getLaunchArgs(proxyPort);
    if (!appPath) {
      // Return instructions for manual setup
      return {
        success: true,
        metadata: {
          instructions: `Launch your Electron app with:\n  your-app ${launchArgs.join(' ')}`
        }
      };
    }

    const env = {
      ...process.env,
      HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
      HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
    };

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
    this.process = null;
    if (launchedProcess && !launchedProcess.killed) {
      launchedProcess.kill();
    }
    this.active = false;
    this._emitStatus('inactive', { pid: launchedProcess?.pid || null });
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
