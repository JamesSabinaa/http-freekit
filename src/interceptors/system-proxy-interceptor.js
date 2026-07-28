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
    this.restorePending = false;
    this.restoreNotificationPending = false;
    this.restoreBaselineSettings = null;
    this.recoveryBlockedReason = null;
    this.ca = options.ca || null;
    this._processIdentityLookup = options.processIdentityLookup
      || (pid => this._queryWindowsProcessIdentity(pid));
    this.recoveryFile = options.dataDir
      ? path.join(options.dataDir, 'system-proxy-recovery.json')
      : options.recoveryFile || null;
  }

  _isWindows() {
    return process.platform === 'win32';
  }

  async isActivable() {
    return this._isWindows() && this.ca?.systemTrustInstalled === true;
  }

  async isActive() {
    return this.active;
  }

  async needsDeactivation() {
    return this.active || Boolean(
      this.recoveryBlockedReason || (this.previousSettings && this.pendingRecovery)
    );
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
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error('Process ID is missing or invalid');
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      if (err?.code === 'ESRCH') return false;
      throw err;
    }
  }

  _queryWindowsProcessIdentity(pid) {
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error('Process ID is missing or invalid');
    }
    const output = this._execPowerShell(`
$target = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop | Select-Object -First 1
if ($null -eq $target) {
  [Console]::Out.Write('null')
} else {
  $identity = [PSCustomObject]@{
    pid = [int]$target.ProcessId
    startedAt = ([DateTime]$target.CreationDate).ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture)
    executablePath = [string]$target.ExecutablePath
  }
  [Console]::Out.Write(($identity | ConvertTo-Json -Compress))
}
`, { encoding: 'utf8', timeout: 5000 });
    const serialized = String(output).trim();
    if (!serialized) throw new Error('Windows process identity query returned no result');
    try {
      return JSON.parse(serialized);
    } catch (err) {
      throw new Error(`Windows process identity query returned invalid JSON: ${err.message}`);
    }
  }

  _normalizeProcessIdentity(identity, expectedPid) {
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
      throw new Error('Process identity is missing or malformed');
    }
    if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0 ||
        identity.pid > 0xffffffff || identity.pid !== expectedPid) {
      throw new Error('Process identity PID is missing, invalid, or unexpected');
    }
    if (typeof identity.startedAt !== 'string' || !identity.startedAt.trim()) {
      throw new Error('Process identity start timestamp is missing or invalid');
    }
    const startedAt = identity.startedAt.trim();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/i.test(startedAt)) {
      throw new Error('Process identity start timestamp is missing or invalid');
    }
    const startTime = Date.parse(startedAt);
    if (!Number.isFinite(startTime)) {
      throw new Error('Process identity start timestamp is missing or invalid');
    }
    if (typeof identity.executablePath !== 'string' || !identity.executablePath.trim()) {
      throw new Error('Process identity executable path is missing or invalid');
    }
    const executablePath = path.win32.normalize(identity.executablePath.trim());
    if (!path.win32.isAbsolute(executablePath)) {
      throw new Error('Process identity executable path is not absolute');
    }
    return {
      pid: identity.pid,
      startedAt: new Date(startTime).toISOString(),
      executablePath: executablePath.toLowerCase()
    };
  }

  _lookupValidatedProcessIdentity(pid) {
    const identity = this._processIdentityLookup(pid);
    if (identity === null) return null;
    return this._normalizeProcessIdentity(identity, pid);
  }

  _recoveryOwnerIsActive(recovery) {
    if (Object.prototype.hasOwnProperty.call(recovery, 'owner')) {
      const owner = this._normalizeProcessIdentity(recovery.owner, recovery.owner?.pid);
      let currentIdentity;
      try {
        currentIdentity = this._lookupValidatedProcessIdentity(owner.pid);
      } catch (err) {
        throw new Error(`Recovery owner identity is ambiguous: ${err.message}`);
      }
      if (currentIdentity === null) return false;
      return currentIdentity.pid === owner.pid
        && currentIdentity.startedAt === owner.startedAt
        && currentIdentity.executablePath === owner.executablePath;
    }

    let isRunning;
    try {
      isRunning = this._isProcessRunning(recovery.pid);
    } catch (err) {
      throw new Error(`Legacy recovery owner is ambiguous: ${err.message}`);
    }
    if (isRunning) {
      throw new Error('Legacy recovery owner is ambiguous: its PID is live but the journal has no strong owner identity');
    }
    return false;
  }

  _persistRecoveryState(recovery) {
    if (!this.recoveryFile) {
      throw new Error('System proxy recovery journal is not configured');
    }
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

  _settingsCouldBelongToRestoreRetry(current, recovery, restoreBaseline = null) {
    const previous = recovery.previousSettings;
    const owned = restoreBaseline || recovery.ownedSettings || {
      enabled: true,
      server: recovery.proxyServer
    };
    const restoreOrder = ['server'];
    if (recovery.ownedSettings) {
      if (!Object.prototype.hasOwnProperty.call(previous, 'override')) return false;
      restoreOrder.push('override');
    }
    restoreOrder.push('enabled');

    // A graceful restore writes these fields in order. Only exact prefixes
    // from the state recorded when it began can be our partial work; other
    // mixtures may be newer settings assembled by another application.
    return Array.from({ length: restoreOrder.length + 1 }, (_, restoredCount) =>
      restoreOrder.every((field, index) =>
        current[field] === (index < restoredCount ? previous[field] : owned[field])
      )
    ).some(Boolean);
  }

  _settingsMatchCompletedRestore(current, previous = this.previousSettings) {
    if (!previous) return false;
    const fields = ['enabled', 'server'];
    if (Object.prototype.hasOwnProperty.call(previous, 'override')) fields.push('override');
    return fields.every(field => current[field] === previous[field]);
  }

  recoverStaleSettings() {
    if (!this._isWindows() || !this.recoveryFile || !fs.existsSync(this.recoveryFile)) return false;
    try {
      const recovery = JSON.parse(fs.readFileSync(this.recoveryFile, 'utf8'));
      if (this._recoveryOwnerIsActive(recovery)) return false;
      if (!recovery.previousSettings || typeof recovery.previousSettings !== 'object') {
        throw new Error('Recovery file does not contain previous proxy settings');
      }
      const notificationPending = recovery.restorePhase === 'notification-pending';
      if (Object.prototype.hasOwnProperty.call(recovery, 'restorePhase') && !notificationPending) {
        throw new Error('Recovery file contains an invalid restore phase');
      }
      const currentSettings = this._readCurrentSettings();
      // An activation journal can contain a partial registry transition. Once
      // the durable notification phase is present, however, every restore
      // write completed and only the exact restored state remains ours.
      const settingsAreOwned = notificationPending
        ? this._settingsMatchCompletedRestore(currentSettings, recovery.previousSettings)
        : this._settingsCouldBelongToRecovery(currentSettings, recovery);
      if (!settingsAreOwned) {
        this._removeRecoveryState();
        this.recoveryBlockedReason = null;
        console.log('[Interceptor] Stale system proxy was changed externally; preserving the newer settings');
        return false;
      }
      this.recoveryBlockedReason = null;
      this.previousSettings = recovery.previousSettings;
      this.pendingRecovery = recovery;
      this.restorePending = true;
      this.restoreNotificationPending = notificationPending;
      this._restorePreviousSettings();
      this.active = false;
      console.log('[Interceptor] Restored system proxy settings left by an interrupted session');
      return true;
    } catch (err) {
      // A malformed or otherwise unreadable journal cannot be replaced safely:
      // it may be the only record of settings that still need restoration. If
      // recovery progressed far enough to hydrate the normal retry state then
      // Stop can continue that retry instead.
      if (!this.previousSettings || !this.pendingRecovery) {
        this.recoveryBlockedReason = err.message;
      }
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
      this._deleteRegistryValue('ProxyServer');
    }
    if (Object.prototype.hasOwnProperty.call(previous, 'override')) {
      if (previous.override != null) {
        this._setRegistryValue('ProxyOverride', 'REG_SZ', previous.override);
      } else {
        this._deleteRegistryValue('ProxyOverride');
      }
    }
    this._setRegistryValue('ProxyEnable', 'REG_DWORD', previous?.enabled ? 1 : 0);
    // Registry restoration is complete. If notification or journal cleanup
    // fails from here, a retry may own only this exact restored state; the
    // broader prefix matcher is reserved for interrupted registry writes.
    this.restoreNotificationPending = true;
    if (this.pendingRecovery) {
      const notificationRecovery = {
        ...this.pendingRecovery,
        restorePhase: 'notification-pending'
      };
      this.pendingRecovery = notificationRecovery;
      if (this.recoveryFile) this._persistRecoveryState(notificationRecovery);
    }
    this._notifyWinInet();
    this._removeRecoveryState();
    this.previousSettings = null;
    this.activeProxyServer = null;
    this.pendingRecovery = null;
    this.restorePending = false;
    this.restoreNotificationPending = false;
    this.restoreBaselineSettings = null;
    this.recoveryBlockedReason = null;
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
      if (this.ca?.systemTrustInstalled !== true) {
        throw new Error('System Proxy requires the HTTP FreeKit CA to be installed in the Windows trust store');
      }
      if (this.recoveryBlockedReason) {
        throw new Error(`System Proxy cleanup is blocked by an unresolved recovery journal: ${this.recoveryBlockedReason}`);
      }
      if (this.restorePending || this.restoreNotificationPending) {
        throw new Error('System Proxy cleanup is still pending; retry Stop before starting it again');
      }
      if (this.active) {
        throw new Error('System Proxy is already active; Stop it before starting it again');
      }
      if (this.previousSettings || this.pendingRecovery) {
        throw new Error('System Proxy cleanup is still pending; retry Stop before starting it again');
      }
      let registryMutationStarted = false;
      try {
        if (this._usesPerMachineProxyPolicy()) {
          throw new Error('System Proxy cannot change a machine-wide proxy policy; ask an administrator to enable per-user proxy settings');
        }
        const owner = this._lookupValidatedProcessIdentity(process.pid);
        if (owner === null) {
          throw new Error('Current FreeKit process identity could not be found');
        }
        if (!this.active && !this.previousSettings) this.previousSettings = this._readCurrentSettings();
        const proxyServer = `127.0.0.1:${proxyPort}`;
        this.pendingRecovery = {
          owner,
          proxyServer,
          ownedSettings: {
            enabled: true,
            server: proxyServer,
            override: ''
          },
          previousSettings: this.previousSettings
        };
        this._persistRecoveryState(this.pendingRecovery);
        registryMutationStarted = true;
        this._setRegistryValue('ProxyEnable', 'REG_DWORD', 1);
        this._setRegistryValue('ProxyServer', 'REG_SZ', proxyServer);
        this._setRegistryValue('ProxyOverride', 'REG_SZ', '');
        this._notifyWinInet();
        this.activeProxyServer = proxyServer;
        this.active = true;
        console.log(`[Interceptor] System proxy set to 127.0.0.1:${proxyPort}`);
        return { success: true };
      } catch (err) {
        if (registryMutationStarted && this.previousSettings) {
          try { this._restorePreviousSettings(); } catch {}
        } else if (!this.active) {
          this.previousSettings = null;
          this.pendingRecovery = null;
          this.restoreNotificationPending = false;
          this.restoreBaselineSettings = null;
        }
        this.active = false;
        throw new Error(`Failed to set system proxy: ${err.message}`);
      }
    }
    throw new Error('System proxy interception not supported on this platform');
  }

  async deactivate() {
    if (this._isWindows()) {
      if (this.recoveryBlockedReason) {
        throw new Error(`Cannot safely restore System Proxy from its unresolved recovery journal: ${this.recoveryBlockedReason}`);
      }
      if (!this.active && !this.previousSettings) return;
      try {
        const currentSettings = this._readCurrentSettings();
        let settingsAreOwned;
        if (this.restoreNotificationPending) {
          settingsAreOwned = this._settingsMatchCompletedRestore(currentSettings);
        } else if (this.restorePending) {
          settingsAreOwned = this.pendingRecovery && this._settingsCouldBelongToRestoreRetry(
            currentSettings,
            this.pendingRecovery,
            this.restoreBaselineSettings
          );
        } else if (this.active) {
          settingsAreOwned = this._settingsBelongToActiveSession(currentSettings);
        } else {
          settingsAreOwned = this.pendingRecovery
            && this._settingsCouldBelongToRecovery(currentSettings, this.pendingRecovery);
        }
        if (!settingsAreOwned) {
          this._removeRecoveryState();
          this.previousSettings = null;
          this.activeProxyServer = null;
          this.pendingRecovery = null;
          this.restorePending = false;
          this.restoreNotificationPending = false;
          this.restoreBaselineSettings = null;
          this.recoveryBlockedReason = null;
          this.active = false;
          console.log('[Interceptor] System proxy was changed externally; preserving the newer settings');
          return;
        }
        if (!this.restorePending) {
          this.restoreBaselineSettings = { ...currentSettings };
        }
        this.restorePending = true;
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
