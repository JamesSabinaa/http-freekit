import { spawn } from 'child_process';
import { findBrowserPath } from './browser-paths.js';

export class ExistingBrowserInterceptor {
  constructor(id, name, browserType) {
    this.id = id;
    this.name = name;
    this.browserType = browserType;
    this.active = false;
    this.ca = null;
  }

  async isActivable() {
    return findBrowserPath(this.browserType) !== null;
  }

  async isActive() {
    return this.active;
  }

  async activate(proxyPort, options = {}) {
    const browserPath = findBrowserPath(this.browserType);
    if (!browserPath) {
      throw new Error(`${this.name} not found on this system`);
    }

    // For "Global" mode, we re-launch the browser with proxy flags but using
    // the user's existing default profile (no --user-data-dir override)
    const spkiFingerprint = this.ca ? this.ca.getSpkiFingerprint() : '';

    const args = [
      `--proxy-server=http://127.0.0.1:${proxyPort}`,
      '--ignore-certificate-errors',
      `--ignore-certificate-errors-spki-list=${spkiFingerprint}`,
      '--test-type',
      '--allow-insecure-localhost',
    ];

    if (options.url) {
      args.push(options.url);
    }

    console.log(`[Interceptor] Launching ${this.name} (existing profile) with proxy on port ${proxyPort}`);
    // Note: this will only work if Chrome is fully closed first, or will open a new window in the existing instance
    this.process = spawn(browserPath, args, {
      detached: false,
      stdio: 'ignore'
    });

    this.active = true;

    this.process.on('exit', () => {
      this.active = false;
    });

    this.process.on('error', (err) => {
      console.error(`[Interceptor] ${this.name} error:`, err.message);
      this.active = false;
    });

    return { success: true, pid: this.process.pid, browser: this.name };
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
      type: this.browserType,
      active: this.active,
      pid: this.process?.pid || null
    };
  }
}
