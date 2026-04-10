import { spawn } from 'child_process';
import path from 'path';
import os from 'os';

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

  async activate(proxyPort, options = {}) {
    const appPath = options.appPath;
    if (!appPath) {
      // Return instructions for manual setup
      return {
        success: true,
        metadata: {
          instructions: `Launch your Electron app with:\n  ELECTRON_EXTRA_LAUNCH_ARGS="--proxy-server=http://127.0.0.1:${proxyPort} --ignore-certificate-errors" your-app`
        }
      };
    }

    const spkiFingerprint = this.ca ? this.ca.getSpkiFingerprint() : '';

    const env = {
      ...process.env,
      ELECTRON_EXTRA_LAUNCH_ARGS: [
        `--proxy-server=http://127.0.0.1:${proxyPort}`,
        '--ignore-certificate-errors',
        `--ignore-certificate-errors-spki-list=${spkiFingerprint}`,
      ].join(' '),
      HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
      HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
    };

    console.log(`[Interceptor] Launching Electron app: ${appPath}`);
    this.process = spawn(appPath, [], {
      detached: false,
      stdio: 'ignore',
      env
    });

    this.active = true;

    this.process.on('exit', () => {
      this.active = false;
    });

    this.process.on('error', (err) => {
      console.error(`[Interceptor] Electron app error:`, err.message);
      this.active = false;
    });

    return { success: true, pid: this.process.pid };
  }

  async deactivate() {
    if (this.process && !this.process.killed) {
      this.process.kill();
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
