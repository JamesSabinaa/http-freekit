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
    this.activeProxyServer = null;
    this.pendingRecovery = null;
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

  async needsDeactivation() {
    return this.active || Boolean(this.previousSettings && this.pendingRecovery);
  }

  _execRegistry(args, options) {
    return execFileSync('reg', args, options);
  }

  _execPowerShell(script, options = {}) {
    return execFileSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 5000, windowsHide: true, ...options }
    );
  }

  _usesPerMachineProxyPolicy() {
    const output = this._execPowerShell(`
$key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\\Policies\\Microsoft\\Windows\\CurrentVersion\\Internet Settings')
try {
  $value = if ($null -eq $key) { 1 } else { $key.GetValue('ProxySettingsPerUser', 1) }
  [Console]::Out.Write([string]$value)
} finally {
  if ($null -ne $key) { $key.Dispose() }
}
`, { encoding: 'utf8' });
    return String(output).trim() === '0';
  }

  _notifyWinInet() {
    this._execPowerShell(`
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class FreeKitWinInet {
  [DllImport("wininet.dll", SetLastError = true)]
  public static extern bool InternetSetOption(IntPtr handle, int option, IntPtr buffer, int bufferLength);
}
"@
if (![FreeKitWinInet]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)) {
  throw "InternetSetOption(INTERNET_OPTION_SETTINGS_CHANGED) failed"
}
if (![FreeKitWinInet]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)) {
  throw "InternetSetOption(INTERNET_OPTION_REFRESH) failed"
}
`);
  }

  _readCurrentSettings() {
    const output = this._execRegistry(['query', INTERNET_SETTINGS_KEY], {
      encoding: 'utf8',
      timeout: 5000
    });
    const enabledMatch = output.match(/^\s*ProxyEnable\s+REG_DWORD\s+(\S+)/im);
    const serverMatch = output.match(/^\s*ProxyServer\s+REG_SZ\s+(.*)$/im);
    const overrideMatch = output.match(/^[ \t]*ProxyOverride[ \t]+REG_SZ(?:[ \t]+(.*))?$/im);
    return {
      enabled: enabledMatch ? parseInt(enabledMatch[1], 0) !== 0 : false,
      server: serverMatch ? serverMatch[1].trim() : null,
      // null means the value is absent; an empty string is an existing value
      // that must be recreated exactly during restoration.
      override: overrideMatch ? (overrideMatch[1] || '').trim() : null
    };
  }

  _setRegistryValue(name, type, value) {
    this._execRegistry([
      'add', INTERNET_SETTINGS_KEY,
      '/v', name,
      '/t', type,
      '/d', String(value),
      '/f'
    ], { stdio: 'ignore', timeout: 5000 });
  }

  _deleteRegistryValue(name) {
    try {
      this._execRegistry(['delete', INTERNET_SETTINGS_KEY, '/v', name, '/f'], {
        encoding: 'utf8',
        timeout: 5000
      });
    } catch (err) {
      const settingsField = {
        ProxyServer: 'server',
        ProxyOverride: 'override'
      }[name];
      if (settingsField) {
        try {
          if (this._readCurrentSettings()[settingsField] === null) return;
        } catch {
          // Preserve the original deletion failure when state cannot be read.
        }
      }
      throw err;
    }
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

  _persistRecoveryState(recovery) {
    if (!this.recoveryFile) return;
    fs.mkdirSync(path.dirname(this.recoveryFile), { recursive: true });
    const tempPath = `${this.recoveryFile}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tempPath, JSON.stringify(recovery), { encoding: 'utf8', mode: 0o600 });
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

  _settingsCouldBelongToRecovery(current, recovery) {
    const previous = recovery.previousSettings;
    const owned = recovery.ownedSettings || {
      enabled: true,
      server: recovery.proxyServer
    };
    const fields = ['enabled', 'server'];
    if (recovery.ownedSettings) {
      if (!Object.prototype.hasOwnProperty.call(previous, 'override')) return false;
      fields.push('override');
    }
    return fields.every(field =>
      current[field] === previous[field] || current[field] === owned[field]
    );
  }

  recoverStaleSettings() {
    if (!this._isWindows() || !this.recoveryFile || !fs.existsSync(this.recoveryFile)) return false;
    try {
      const recovery = JSON.parse(fs.readFileSync(this.recoveryFile, 'utf8'));
      if (this._isProcessRunning(recovery.pid)) return false;
      if (!recovery.previousSettings || typeof recovery.previousSettings !== 'object') {
        throw new Error('Recovery file does not contain previous proxy settings');
      }
      const currentSettings = this._readCurrentSettings();
      // The journal is durable before activation starts writing the registry,
      // so a crash can leave any mixture of exact previous and intended owned
      // values. A value outside those two states is an external change.
      if (!this._settingsCouldBelongToRecovery(currentSettings, recovery)) {
        this._removeRecoveryState();
        console.log('[Interceptor] Stale system proxy was changed externally; preserving the newer settings');
        return false;
      }
      this.previousSettings = recovery.previousSettings;
      this.pendingRecovery = recovery;
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
    if (!previous) throw new Error('No saved system proxy settings are available to restore');
    if (previous?.server != null) {
      this._setRegistryValue('ProxyServer', 'REG_SZ', previous.server);
    } else {
      try {
        this._execRegistry(['delete', INTERNET_SETTINGS_KEY, '/v', 'ProxyServer', '/f'], {
          stdio: 'ignore',
          timeout: 5000
        });
      } catch {}
    }
    if (Object.prototype.hasOwnProperty.call(previous, 'override')) {
      if (previous.override != null) {
        this._setRegistryValue('ProxyOverride', 'REG_SZ', previous.override);
      } else {
        this._deleteRegistryValue('ProxyOverride');
      }
    }
    this._setRegistryValue('ProxyEnable', 'REG_DWORD', previous?.enabled ? 1 : 0);
    this._notifyWinInet();
    this._removeRecoveryState();
    this.previousSettings = null;
    this.activeProxyServer = null;
    this.pendingRecovery = null;
  }

  _settingsBelongToActiveSession(settings) {
    return Boolean(
      this.activeProxyServer
      && settings?.enabled
      && settings.server === this.activeProxyServer
      && settings.override === ''
    );
  }

  async activate(proxyPort) {
    if (this._isWindows()) {
      try {
        if (this._usesPerMachineProxyPolicy()) {
          throw new Error('System Proxy cannot change a machine-wide proxy policy; ask an administrator to enable per-user proxy settings');
        }
        if (!this.active && !this.previousSettings) this.previousSettings = this._readCurrentSettings();
        const proxyServer = `127.0.0.1:${proxyPort}`;
        this.pendingRecovery = {
          pid: process.pid,
          proxyServer,
          ownedSettings: {
            enabled: true,
            server: proxyServer,
            override: ''
          },
          previousSettings: this.previousSettings
        };
        this._persistRecoveryState(this.pendingRecovery);
        this._setRegistryValue('ProxyEnable', 'REG_DWORD', 1);
        this._setRegistryValue('ProxyServer', 'REG_SZ', proxyServer);
        this._setRegistryValue('ProxyOverride', 'REG_SZ', '');
        this._notifyWinInet();
        this.activeProxyServer = proxyServer;
        this.active = true;
        console.log(`[Interceptor] System proxy set to 127.0.0.1:${proxyPort}`);
        return { success: true };
      } catch (err) {
        if (this.previousSettings) {
          try { this._restorePreviousSettings(); } catch {}
        }
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
        const currentSettings = this._readCurrentSettings();
        const settingsAreOwned = this.active
          ? this._settingsBelongToActiveSession(currentSettings)
          : this.pendingRecovery
            && this._settingsCouldBelongToRecovery(currentSettings, this.pendingRecovery);
        if (!settingsAreOwned) {
          this._removeRecoveryState();
          this.previousSettings = null;
          this.activeProxyServer = null;
          this.pendingRecovery = null;
          this.active = false;
          console.log('[Interceptor] System proxy was changed externally; preserving the newer settings');
          return;
        }
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
