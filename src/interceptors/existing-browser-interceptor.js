import { spawn } from 'child_process';
import path from 'path';
import { findBrowserPath } from './browser-paths.js';
import { getProcessSnapshotAsync } from './browser-lifecycle.js';

export class ExistingBrowserInterceptor {
  constructor(id, name, browserType) {
    this.id = id;
    this.name = name;
    this.browserType = browserType;
    this.active = false;
    this.ca = null;
    this.process = null;
    this.onStatusChange = null;
  }

  async isActivable() {
    return this._findBrowserPath() !== null;
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

  async _isBrowserRunning(browserPath) {
    const normalizedPath = String(browserPath).replace(/\\/g, '/').toLowerCase();
    const executableName = path.basename(browserPath).toLowerCase();
    const escapedName = executableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const executablePattern = new RegExp(`(^|[\\s/\\\\"])${escapedName}(?=$|\\s|\")`, 'i');
    const processes = await this._getProcessSnapshot();
    return processes.some(({ command }) => {
      const normalizedCommand = String(command || '').replace(/\\/g, '/').toLowerCase();
      return normalizedCommand.includes(normalizedPath) || executablePattern.test(normalizedCommand);
    });
  }

  async activate(proxyPort, options = {}) {
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

    if (!this.ca?.systemTrustInstalled) {
      const spkiFingerprint = this.ca ? this.ca.getSpkiFingerprint() : '';
      args.push(
        '--ignore-certificate-errors',
        `--ignore-certificate-errors-spki-list=${spkiFingerprint}`,
        '--test-type',
        '--allow-insecure-localhost'
      );
    }

    if (options.url) {
      args.push(options.url);
    }

    console.log(`[Interceptor] Launching ${this.name} (existing profile) with proxy on port ${proxyPort}`);
    this.process = spawn(browserPath, args, {
      detached: false,
      stdio: 'ignore'
    });

    this.active = true;
    this._emitStatus('active');

    this.process.on('exit', () => {
      this.active = false;
      this._emitStatus('exited');
    });

    this.process.on('error', (err) => {
      console.error(`[Interceptor] ${this.name} error:`, err.message);
      this.active = false;
      this._emitStatus('error', { error: err.message });
    });

    return { success: true, pid: this.process.pid, browser: this.name };
  }

  async deactivate() {
    if (this.process && !this.process.killed) {
      this.process.kill();
    }
    this.active = false;
    this._emitStatus('inactive');
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
