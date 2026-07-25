import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const INTERNET_SETTINGS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

export class SystemProxyInterceptor {
  constructor(options = {}) {
    this.id = 'system-proxy';
    this.name = 'System Proxy';
    this.active = false;
    this.previousSettings = null;
    this.recoveryFile = options.dataDir
      ? path.join(options.dataDir, 'system-proxy-recovery.json')
      : options.recoveryFile || null;
  }

  _isWindows() {
    return process.platform === 'win32';
  }

  async isActivable() {
    return this._isWindows();
  }

  async isActive() {
    return this.active;
  }

  _readCurrentSettings() {
    let enabled = false;
    let server = null;

    try {
      const output = execFileSync('reg', ['query', INTERNET_SETTINGS_KEY, '/v', 'ProxyEnable'], {
        encoding: 'utf8',
        timeout: 5000
      });
      const match = output.match(/ProxyEnable\s+REG_DWORD\s+(\S+)/i);
      enabled = match ? parseInt(match[1], 0) !== 0 : false;
    } catch {}

    try {
      const output = execFileSync('reg', ['query', INTERNET_SETTINGS_KEY, '/v', 'ProxyServer'], {
        encoding: 'utf8',
        timeout: 5000
      });
      const match = output.match(/^\s*ProxyServer\s+REG_SZ\s+(.*)$/im);
      server = match ? match[1].trim() : null;
    } catch {}

    return { enabled, server };
  }

  _setRegistryValue(name, type, value) {
    execFileSync('reg', [
      'add', INTERNET_SETTINGS_KEY,
      '/v', name,
      '/t', type,
      '/d', String(value),
      '/f'
    ], { stdio: 'ignore', timeout: 5000 });
  }

  _isProcessRunning(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  _persistRecoveryState(proxyServer) {
    if (!this.recoveryFile) return;
    fs.mkdirSync(path.dirname(this.recoveryFile), { recursive: true });
    const tempPath = `${this.recoveryFile}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tempPath, JSON.stringify({
        pid: process.pid,
        proxyServer,
        previousSettings: this.previousSettings
      }), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tempPath, this.recoveryFile);
    } catch (err) {
      try { fs.unlinkSync(tempPath); } catch {}
      throw err;
    }
  }

  _removeRecoveryState() {
    if (!this.recoveryFile) return;
    try {
      fs.unlinkSync(this.recoveryFile);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  recoverStaleSettings() {
    if (!this._isWindows() || !this.recoveryFile || !fs.existsSync(this.recoveryFile)) return false;
    try {
      const recovery = JSON.parse(fs.readFileSync(this.recoveryFile, 'utf8'));
      if (this._isProcessRunning(recovery.pid)) return false;
      if (!recovery.previousSettings || typeof recovery.previousSettings !== 'object') {
        throw new Error('Recovery file does not contain previous proxy settings');
      }
      this.previousSettings = recovery.previousSettings;
      this._restorePreviousSettings();
      this.active = false;
      console.log('[Interceptor] Restored system proxy settings left by an interrupted session');
      return true;
    } catch (err) {
      console.error('[Interceptor] Failed to recover stale system proxy settings:', err.message);
      return false;
    }
  }

  _restorePreviousSettings() {
    const previous = this.previousSettings;
    if (previous?.server != null) {
      this._setRegistryValue('ProxyServer', 'REG_SZ', previous.server);
    } else {
      try {
        execFileSync('reg', ['delete', INTERNET_SETTINGS_KEY, '/v', 'ProxyServer', '/f'], {
          stdio: 'ignore',
          timeout: 5000
        });
      } catch {}
    }
    this._setRegistryValue('ProxyEnable', 'REG_DWORD', previous?.enabled ? 1 : 0);
    this._removeRecoveryState();
    this.previousSettings = null;
  }

  async activate(proxyPort) {
    if (this._isWindows()) {
      try {
        if (!this.active && !this.previousSettings) this.previousSettings = this._readCurrentSettings();
        this._persistRecoveryState(`127.0.0.1:${proxyPort}`);
        this._setRegistryValue('ProxyEnable', 'REG_DWORD', 1);
        this._setRegistryValue('ProxyServer', 'REG_SZ', `127.0.0.1:${proxyPort}`);
        this.active = true;
        console.log(`[Interceptor] System proxy set to 127.0.0.1:${proxyPort}`);
        return { success: true };
      } catch (err) {
        try { this._restorePreviousSettings(); } catch {}
        this.active = false;
        throw new Error(`Failed to set system proxy: ${err.message}`);
      }
    }
    throw new Error('System proxy interception not supported on this platform');
  }

  async deactivate() {
    if (this._isWindows()) {
      if (!this.active && !this.previousSettings) return;
      try {
        this._restorePreviousSettings();
        this.active = false;
        console.log('[Interceptor] Previous system proxy settings restored');
      } catch (err) {
        console.error('[Interceptor] Failed to disable system proxy:', err.message);
        throw new Error(`Failed to restore system proxy settings: ${err.message}`);
      }
    }
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      type: 'system',
      active: this.active
    };
  }
}
