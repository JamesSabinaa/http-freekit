import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

const INTERNET_SETTINGS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const WINHTTP_RECOVERY_FILENAME = 'winhttp-proxy-recovery.json';

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
    this.previousWinHttpSettings = null;
    this.activeWinHttpSettings = null;
    this.pendingWinHttpRecovery = null;
    this.winHttpRestorePending = false;
    this.winHttpRecoveryBlockedReason = null;
    this.ca = options.ca || null;
    this._processIdentityLookup = options.processIdentityLookup
      || (pid => this._queryWindowsProcessIdentity(pid));
    this.recoveryFile = options.dataDir
      ? path.join(options.dataDir, 'system-proxy-recovery.json')
      : options.recoveryFile || null;
    this.winHttpRecoveryFile = options.dataDir
      ? path.join(options.dataDir, WINHTTP_RECOVERY_FILENAME)
      : options.winHttpRecoveryFile
        || (options.recoveryFile ? `${options.recoveryFile}.winhttp` : null);
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
      this.recoveryBlockedReason
      || this.winHttpRecoveryBlockedReason
      || (this.previousSettings && this.pendingRecovery)
      || (this.previousWinHttpSettings && this.pendingWinHttpRecovery)
    );
  }

  _execFile(command, args, options) {
    return new Promise((resolve, reject) => {
      execFile(command, args, options, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    });
  }

  _execRegistry(args, options) {
    return this._execFile('reg', args, options);
  }

  _normalizeWinHttpSettings(settings) {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error('WinHTTP settings are missing or malformed');
    }
    if (settings.scope !== 'user' && settings.scope !== 'machine') {
      throw new Error('WinHTTP settings contain an invalid scope');
    }
    for (const field of ['proxy', 'proxyBypass', 'autoConfigUrl']) {
      if (typeof settings[field] !== 'string') {
        throw new Error(`WinHTTP settings contain an invalid ${field} value`);
      }
    }
    if (typeof settings.autoDetect !== 'boolean') {
      throw new Error('WinHTTP settings contain an invalid autoDetect value');
    }
    return {
      scope: settings.scope,
      proxy: settings.proxy,
      proxyBypass: settings.proxyBypass,
      autoConfigUrl: settings.autoConfigUrl,
      autoDetect: settings.autoDetect
    };
  }

  _winHttpSettingsEqual(left, right) {
    if (!left || !right) return false;
    return ['scope', 'proxy', 'proxyBypass', 'autoConfigUrl', 'autoDetect']
      .every(field => left[field] === right[field]);
  }

  async _readWinHttpSettings() {
    const output = await this._execFile('netsh.exe', ['winhttp', 'show', 'advproxy'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true
    });
    const serialized = String(output);
    const start = serialized.indexOf('{');
    const end = serialized.lastIndexOf('}');
    if (start === -1 || end < start) {
      throw new Error('netsh did not return WinHTTP advanced proxy settings as JSON');
    }
    let parsed;
    try {
      parsed = JSON.parse(serialized.slice(start, end + 1));
    } catch (err) {
      throw new Error(`netsh returned invalid WinHTTP proxy JSON: ${err.message}`);
    }
    for (const field of [
      'ProxyIsEnabled',
      'AutoConfigIsEnabled',
      'AutoDetect',
      'PerUserProxySettings'
    ]) {
      if (typeof parsed[field] !== 'boolean') {
        throw new Error(`netsh WinHTTP output is missing boolean ${field}`);
      }
    }
    if (parsed.ProxyIsEnabled && typeof parsed.Proxy !== 'string') {
      throw new Error('netsh WinHTTP output is missing the enabled proxy value');
    }
    if (parsed.AutoConfigIsEnabled && typeof parsed.AutoconfigUrl !== 'string') {
      throw new Error('netsh WinHTTP output is missing the enabled autoconfig URL');
    }
    return this._normalizeWinHttpSettings({
      scope: parsed.PerUserProxySettings ? 'user' : 'machine',
      proxy: parsed.ProxyIsEnabled ? parsed.Proxy : '',
      proxyBypass: parsed.ProxyIsEnabled && typeof parsed.ProxyBypass === 'string'
        ? parsed.ProxyBypass
        : '',
      autoConfigUrl: parsed.AutoConfigIsEnabled ? parsed.AutoconfigUrl : '',
      autoDetect: parsed.AutoDetect
    });
  }

  async _setWinHttpSettings(settings) {
    const normalized = this._normalizeWinHttpSettings(settings);
    const serialized = JSON.stringify({
      Proxy: normalized.proxy,
      ProxyBypass: normalized.proxyBypass,
      AutoconfigUrl: normalized.autoConfigUrl,
      AutoDetect: normalized.autoDetect
    });
    await this._execFile('netsh.exe', [
      'winhttp',
      'set',
      'advproxy',
      `setting-scope=${normalized.scope}`,
      `settings=${serialized}`
    ], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    const current = await this._readWinHttpSettings();
    if (!this._winHttpSettingsEqual(current, normalized)) {
      throw new Error('WinHTTP proxy settings did not match the requested configuration after netsh completed');
    }
  }

  _execPowerShell(script, options = {}) {
    return this._execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 5000, windowsHide: true, ...options }
    );
  }

  async _usesPerMachineProxyPolicy() {
    const output = await this._execPowerShell(`
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

  async _notifyWinInet() {
    await this._execPowerShell(`
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

  async _readCurrentSettings() {
    const output = await this._execRegistry(['query', INTERNET_SETTINGS_KEY], {
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

  async _setRegistryValue(name, type, value) {
    await this._execRegistry([
      'add', INTERNET_SETTINGS_KEY,
      '/v', name,
      '/t', type,
      '/d', String(value),
      '/f'
    ], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  }

  async _deleteRegistryValue(name) {
    try {
      await this._execRegistry(['delete', INTERNET_SETTINGS_KEY, '/v', name, '/f'], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true
      });
    } catch (err) {
      const settingsField = {
        ProxyServer: 'server',
        ProxyOverride: 'override'
      }[name];
      if (settingsField) {
        try {
          if ((await this._readCurrentSettings())[settingsField] === null) return;
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

  async _queryWindowsProcessIdentity(pid) {
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error('Process ID is missing or invalid');
    }
    const output = await this._execPowerShell(`
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

  async _lookupValidatedProcessIdentity(pid) {
    const identity = await this._processIdentityLookup(pid);
    if (identity === null) return null;
    return this._normalizeProcessIdentity(identity, pid);
  }

  async _recoveryOwnerIsActive(recovery) {
    if (Object.prototype.hasOwnProperty.call(recovery, 'owner')) {
      const owner = this._normalizeProcessIdentity(recovery.owner, recovery.owner?.pid);
      let currentIdentity;
      try {
        currentIdentity = await this._lookupValidatedProcessIdentity(owner.pid);
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

  _writeRecoveryState(recoveryFile, recovery, { exclusive = false } = {}) {
    fs.mkdirSync(path.dirname(recoveryFile), { recursive: true });
    const tempPath = `${recoveryFile}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tempPath, JSON.stringify(recovery), { encoding: 'utf8', mode: 0o600 });
      if (exclusive) {
        // Publishing a fully written hard link is atomic and, unlike rename on
        // Windows, refuses to replace a journal belonging to another process.
        fs.linkSync(tempPath, recoveryFile);
        // Once the canonical link exists, temp-link cleanup is best-effort:
        // failing it must not make the caller forget the published journal.
        try { fs.unlinkSync(tempPath); } catch {}
      } else {
        fs.renameSync(tempPath, recoveryFile);
      }
    } catch (err) {
      try { fs.unlinkSync(tempPath); } catch {}
      throw err;
    }
  }

  _persistRecoveryState(recovery, options) {
    if (!this.recoveryFile) {
      throw new Error('System proxy recovery journal is not configured');
    }
    this._writeRecoveryState(this.recoveryFile, recovery, options);
  }

  _removeRecoveryState() {
    if (!this.recoveryFile) return;
    try {
      fs.unlinkSync(this.recoveryFile);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  _persistWinHttpRecoveryState(recovery, options) {
    if (!this.winHttpRecoveryFile) {
      throw new Error('WinHTTP proxy recovery journal is not configured');
    }
    this._writeRecoveryState(this.winHttpRecoveryFile, recovery, options);
  }

  _removeWinHttpRecoveryState() {
    if (!this.winHttpRecoveryFile) return;
    try {
      fs.unlinkSync(this.winHttpRecoveryFile);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  _winHttpSettingsCouldBelongToRecovery(current, recovery) {
    const previous = this._normalizeWinHttpSettings(recovery?.previousSettings);
    const owned = this._normalizeWinHttpSettings(recovery?.ownedSettings);
    return this._winHttpSettingsEqual(current, previous)
      || this._winHttpSettingsEqual(current, owned);
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

  async _recoverStaleWinInetSettings() {
    if (!this.recoveryFile || !fs.existsSync(this.recoveryFile)) {
      if (!this.previousSettings && !this.pendingRecovery) this.recoveryBlockedReason = null;
      return false;
    }
    try {
      const recovery = JSON.parse(fs.readFileSync(this.recoveryFile, 'utf8'));
      if (await this._recoveryOwnerIsActive(recovery)) {
        this.recoveryBlockedReason = `journal belongs to active FreeKit process ${recovery.owner.pid}`;
        return false;
      }
      if (!recovery.previousSettings || typeof recovery.previousSettings !== 'object') {
        throw new Error('Recovery file does not contain previous proxy settings');
      }
      const notificationPending = recovery.restorePhase === 'notification-pending';
      if (Object.prototype.hasOwnProperty.call(recovery, 'restorePhase') && !notificationPending) {
        throw new Error('Recovery file contains an invalid restore phase');
      }
      const currentSettings = await this._readCurrentSettings();
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
      this.restoreBaselineSettings = notificationPending ? null : { ...currentSettings };
      this.restorePending = true;
      this.restoreNotificationPending = notificationPending;
      await this._restorePreviousSettings();
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

  async _recoverStaleWinHttpSettings() {
    if (!this.winHttpRecoveryFile || !fs.existsSync(this.winHttpRecoveryFile)) {
      if (!this.previousWinHttpSettings && !this.pendingWinHttpRecovery) {
        this.winHttpRecoveryBlockedReason = null;
      }
      return false;
    }
    try {
      const recovery = JSON.parse(fs.readFileSync(this.winHttpRecoveryFile, 'utf8'));
      if (await this._recoveryOwnerIsActive(recovery)) {
        this.winHttpRecoveryBlockedReason = `journal belongs to active FreeKit process ${recovery.owner.pid}`;
        return false;
      }
      const previous = this._normalizeWinHttpSettings(recovery.previousSettings);
      const owned = this._normalizeWinHttpSettings(recovery.ownedSettings);
      const current = await this._readWinHttpSettings();
      if (!this._winHttpSettingsCouldBelongToRecovery(current, { previousSettings: previous, ownedSettings: owned })) {
        this._removeWinHttpRecoveryState();
        this.winHttpRecoveryBlockedReason = null;
        console.log('[Interceptor] Stale WinHTTP proxy was changed externally; preserving the newer settings');
        return false;
      }
      this.winHttpRecoveryBlockedReason = null;
      this.previousWinHttpSettings = previous;
      this.activeWinHttpSettings = owned;
      this.pendingWinHttpRecovery = {
        ...recovery,
        previousSettings: previous,
        ownedSettings: owned
      };
      this.winHttpRestorePending = true;
      await this._restorePreviousWinHttpSettings();
      console.log('[Interceptor] Restored WinHTTP proxy settings left by an interrupted session');
      return true;
    } catch (err) {
      if (!this.previousWinHttpSettings || !this.pendingWinHttpRecovery) {
        this.winHttpRecoveryBlockedReason = err.message;
      }
      console.error('[Interceptor] Failed to recover stale WinHTTP proxy settings:', err.message);
      return false;
    }
  }

  async recoverStaleSettings() {
    if (!this._isWindows()) return false;
    const restoredWinInet = await this._recoverStaleWinInetSettings();
    const restoredWinHttp = await this._recoverStaleWinHttpSettings();
    return restoredWinInet || restoredWinHttp;
  }

  async _restorePreviousSettings() {
    const previous = this.previousSettings;
    if (!previous) throw new Error('No saved system proxy settings are available to restore');
    if (previous?.server != null) {
      await this._setRegistryValue('ProxyServer', 'REG_SZ', previous.server);
    } else {
      await this._deleteRegistryValue('ProxyServer');
    }
    if (Object.prototype.hasOwnProperty.call(previous, 'override')) {
      if (previous.override != null) {
        await this._setRegistryValue('ProxyOverride', 'REG_SZ', previous.override);
      } else {
        await this._deleteRegistryValue('ProxyOverride');
      }
    }
    await this._setRegistryValue('ProxyEnable', 'REG_DWORD', previous?.enabled ? 1 : 0);
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
    await this._notifyWinInet();
    this._removeRecoveryState();
    this.previousSettings = null;
    this.activeProxyServer = null;
    this.pendingRecovery = null;
    this.restorePending = false;
    this.restoreNotificationPending = false;
    this.restoreBaselineSettings = null;
    this.recoveryBlockedReason = null;
  }

  async _restorePreviousWinHttpSettings() {
    const previous = this.previousWinHttpSettings;
    if (!previous) throw new Error('No saved WinHTTP proxy settings are available to restore');
    this.winHttpRestorePending = true;
    await this._setWinHttpSettings(previous);
    this._removeWinHttpRecoveryState();
    this.previousWinHttpSettings = null;
    this.activeWinHttpSettings = null;
    this.pendingWinHttpRecovery = null;
    this.winHttpRestorePending = false;
    this.winHttpRecoveryBlockedReason = null;
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
      if (this.recoveryBlockedReason || this.winHttpRecoveryBlockedReason) {
        // A different process may have exited or gracefully released its
        // journals since startup. Revalidate exact ownership on each retry.
        await this.recoverStaleSettings();
      }
      if (this.recoveryBlockedReason) {
        throw new Error(`System Proxy cleanup is blocked by an unresolved recovery journal: ${this.recoveryBlockedReason}`);
      }
      if (this.winHttpRecoveryBlockedReason) {
        throw new Error(`System Proxy cleanup is blocked by an unresolved WinHTTP recovery journal: ${this.winHttpRecoveryBlockedReason}`);
      }
      if (this.restorePending || this.restoreNotificationPending || this.winHttpRestorePending) {
        throw new Error('System Proxy cleanup is still pending; retry Stop before starting it again');
      }
      if (this.active) {
        throw new Error('System Proxy is already active; Stop it before starting it again');
      }
      if (this.previousSettings || this.pendingRecovery
          || this.previousWinHttpSettings || this.pendingWinHttpRecovery) {
        throw new Error('System Proxy cleanup is still pending; retry Stop before starting it again');
      }
      let recoveryPrepared = false;
      let winInetJournalPrepared = false;
      let winHttpJournalPrepared = false;
      try {
        if (await this._usesPerMachineProxyPolicy()) {
          throw new Error('System Proxy cannot change a machine-wide proxy policy; ask an administrator to enable per-user proxy settings');
        }
        const owner = await this._lookupValidatedProcessIdentity(process.pid);
        if (owner === null) {
          throw new Error('Current FreeKit process identity could not be found');
        }
        this.previousSettings = await this._readCurrentSettings();
        this.previousWinHttpSettings = await this._readWinHttpSettings();
        const proxyServer = `127.0.0.1:${proxyPort}`;
        const ownedWinHttpSettings = {
          scope: 'machine',
          proxy: proxyServer,
          proxyBypass: '',
          autoConfigUrl: '',
          autoDetect: false
        };
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
        this.pendingWinHttpRecovery = {
          owner,
          previousSettings: this.previousWinHttpSettings,
          ownedSettings: ownedWinHttpSettings
        };
        this._persistRecoveryState(this.pendingRecovery, { exclusive: true });
        winInetJournalPrepared = true;
        this._persistWinHttpRecoveryState(this.pendingWinHttpRecovery, { exclusive: true });
        winHttpJournalPrepared = true;
        recoveryPrepared = true;
        await this._setRegistryValue('ProxyEnable', 'REG_DWORD', 1);
        await this._setRegistryValue('ProxyServer', 'REG_SZ', proxyServer);
        await this._setRegistryValue('ProxyOverride', 'REG_SZ', '');
        await this._notifyWinInet();
        await this._setWinHttpSettings(ownedWinHttpSettings);
        this.activeProxyServer = proxyServer;
        this.activeWinHttpSettings = ownedWinHttpSettings;
        this.active = true;
        console.log(`[Interceptor] WinINet and machine WinHTTP proxies set to 127.0.0.1:${proxyPort}`);
        return { success: true };
      } catch (err) {
        const rollbackErrors = [];
        if (recoveryPrepared) {
          try { await this._restorePreviousSettings(); } catch (rollbackError) {
            rollbackErrors.push(`WinINet: ${rollbackError.message}`);
          }
          try { await this._restorePreviousWinHttpSettings(); } catch (rollbackError) {
            rollbackErrors.push(`WinHTTP: ${rollbackError.message}`);
          }
        } else {
          if (winInetJournalPrepared) {
            try { this._removeRecoveryState(); } catch (cleanupError) {
              rollbackErrors.push(`WinINet journal: ${cleanupError.message}`);
              this.recoveryBlockedReason = cleanupError.message;
            }
          }
          if (winHttpJournalPrepared) {
            try { this._removeWinHttpRecoveryState(); } catch (cleanupError) {
              rollbackErrors.push(`WinHTTP journal: ${cleanupError.message}`);
              this.winHttpRecoveryBlockedReason = cleanupError.message;
            }
          }
          this.previousSettings = null;
          this.pendingRecovery = null;
          this.restoreNotificationPending = false;
          this.restoreBaselineSettings = null;
          this.previousWinHttpSettings = null;
          this.activeWinHttpSettings = null;
          this.pendingWinHttpRecovery = null;
          this.winHttpRestorePending = false;
        }
        this.active = false;
        const rollbackDetail = rollbackErrors.length > 0
          ? `; automatic rollback was incomplete (${rollbackErrors.join('; ')})`
          : '';
        throw new Error(`Failed to set system proxy: ${err.message}${rollbackDetail}`);
      }
    }
    throw new Error('System proxy interception not supported on this platform');
  }

  async _deactivateWinInetSettings() {
    if (!this.previousSettings && !this.pendingRecovery) return;
    const currentSettings = await this._readCurrentSettings();
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
      console.log('[Interceptor] WinINet proxy was changed externally; preserving the newer settings');
      return;
    }
    if (!this.restorePending) {
      this.restoreBaselineSettings = { ...currentSettings };
    }
    this.restorePending = true;
    await this._restorePreviousSettings();
    console.log('[Interceptor] Previous WinINet proxy settings restored');
  }

  async _deactivateWinHttpSettings() {
    if (!this.previousWinHttpSettings && !this.pendingWinHttpRecovery) return;
    const currentSettings = await this._readWinHttpSettings();
    const settingsAreOwned = this.pendingWinHttpRecovery
      && this._winHttpSettingsCouldBelongToRecovery(currentSettings, this.pendingWinHttpRecovery);
    if (!settingsAreOwned) {
      this._removeWinHttpRecoveryState();
      this.previousWinHttpSettings = null;
      this.activeWinHttpSettings = null;
      this.pendingWinHttpRecovery = null;
      this.winHttpRestorePending = false;
      this.winHttpRecoveryBlockedReason = null;
      console.log('[Interceptor] WinHTTP proxy was changed externally; preserving the newer settings');
      return;
    }
    this.winHttpRestorePending = true;
    await this._restorePreviousWinHttpSettings();
    console.log('[Interceptor] Previous WinHTTP proxy settings restored');
  }

  async deactivate() {
    if (this._isWindows()) {
      const hasState = this.active || this.previousSettings || this.pendingRecovery
        || this.previousWinHttpSettings || this.pendingWinHttpRecovery
        || this.recoveryBlockedReason || this.winHttpRecoveryBlockedReason;
      if (!hasState) return;
      const wasActive = this.active;
      const errors = [];
      if (this.recoveryBlockedReason) {
        errors.push(new Error(
          `Cannot safely restore System Proxy from its unresolved recovery journal: ${this.recoveryBlockedReason}`
        ));
      } else {
        try { await this._deactivateWinInetSettings(); } catch (err) { errors.push(err); }
      }
      if (this.winHttpRecoveryBlockedReason) {
        errors.push(new Error(
          `Cannot safely restore WinHTTP proxy from its unresolved recovery journal: ${this.winHttpRecoveryBlockedReason}`
        ));
      } else {
        try { await this._deactivateWinHttpSettings(); } catch (err) { errors.push(err); }
      }
      if (errors.length > 0) {
        this.active = wasActive;
        const detail = errors.map(err => err.message).join('; ');
        console.error('[Interceptor] Failed to disable system proxy:', detail);
        throw new Error(`Failed to restore system proxy settings: ${detail}`);
      }
      this.active = false;
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
