import { spawn } from 'child_process';

export class ElectronInterceptor {
  constructor() {
    this.id = 'electron';
    this.name = 'Electron App';
    this.active = false;
    this.ca = null;
    this.process = null;
  }

  async isActivable() {
    // Always available — user provides the app path
    return true;
  }

  async isActive() {
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

  async activate(proxyPort, options = {}) {
    if (await this.isActive()) {
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
    const launchedProcess = this._spawn(appPath, launchArgs, {
      detached: false,
      stdio: 'ignore',
      env
    });
    this.process = launchedProcess;

    this.active = true;

    launchedProcess.on('exit', () => {
      if (this.process !== launchedProcess) return;
      this.active = false;
      this.process = null;
    });

    launchedProcess.on('error', (err) => {
      if (this.process !== launchedProcess) return;
      console.error(`[Interceptor] Electron app error:`, err.message);
      this.active = false;
      this.process = null;
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
