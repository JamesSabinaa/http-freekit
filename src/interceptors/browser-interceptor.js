import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { findBrowserPath } from './browser-paths.js';
import { normalizeBrowserUrl } from './browser-url.js';
import { ensureChromiumLoopbackProxying } from './chromium-proxy-args.js';
import {
  collectRelatedProcessIds,
  createManagedBrowserProfile,
  getProcessSnapshotAsync,
  getRelatedProcessIdsAsync,
  removeManagedBrowserProfile
} from './browser-lifecycle.js';
import {
  execFileAsync,
  PROCESS_STARTUP_EXIT_ERROR_CODE,
  waitForSpawnStability
} from './command-runner.js';

export const BROWSER_BECAME_INACTIVE_ERROR_CODE = 'BROWSER_BECAME_INACTIVE';

export class BrowserInterceptor {
  constructor(id, name, browserType) {
    this.id = id;
    this.name = name;
    this.browserType = browserType;
    this.process = null;
    this.profileDir = null;
    this.active = false;
    this.ca = null; // Set by InterceptorManager
    this.onStatusChange = null;
    this.statusMonitor = null;
    this.proxyPort = null;
    this.trackedProcessIds = new Set();
    this.lifecycleInspectionErrorLogged = false;
    this.lastProcessInspectionAt = 0;
    this.lastProcessInspectionFailed = false;
    this.statusInspectionInFlight = false;
    this.statusMonitorGeneration = 0;
    this.lifecycleGeneration = 0;
    this.cleanupPending = false;
    this.startupConfirmationMs = 500;
  }

  async isActivable() {
    return this._findBrowserPath() !== null;
  }

  _findBrowserPath() {
    return findBrowserPath(this.browserType);
  }

  _platform() {
    return process.platform;
  }

  _spawn(browserPath, args, options) {
    return spawn(browserPath, args, options);
  }

  _execFile(command, args, options) {
    return execFileAsync(command, args, options);
  }

  _getProcessSnapshot() {
    return getProcessSnapshotAsync();
  }

  _waitForSpawn(launchedProcess) {
    return waitForSpawnStability(launchedProcess, {
      graceMs: this.startupConfirmationMs,
      label: this.name
    });
  }

  canFocus() {
    return this._platform() === 'win32' || this._platform() === 'darwin';
  }

  _createManagedProfile() {
    return createManagedBrowserProfile(this.browserType);
  }

  async isActive() {
    if (!this.active) return false;
    const lifecycle = this._captureLifecycle();
    const running = await this._isBrowserStillRunning(lifecycle);
    if (!this._isLifecycleCurrent(lifecycle)) return this.active;
    if (!running) this.active = false;
    return running;
  }

  needsDeactivation() {
    return this.active
      || this.cleanupPending
      || Boolean(this.process)
      || Boolean(this.profileDir)
      || this.trackedProcessIds.size > 0;
  }

  _captureLifecycle() {
    return {
      generation: this.lifecycleGeneration,
      profileDir: this.profileDir,
      process: this.process
    };
  }

  _isLifecycleCurrent(lifecycle) {
    return Boolean(lifecycle)
      && lifecycle.generation === this.lifecycleGeneration
      && lifecycle.profileDir === this.profileDir
      && lifecycle.process === this.process;
  }

  _ownsLifecycleProfile(generation, profileDir) {
    return generation === this.lifecycleGeneration && profileDir === this.profileDir;
  }

  _invalidateLifecycleCallbacks() {
    this.lifecycleGeneration += 1;
    this._stopStatusMonitor();
  }

  _clearLifecycleState() {
    this.active = false;
    this.process = null;
    this.profileDir = null;
    this.proxyPort = null;
    this.trackedProcessIds.clear();
    this.lifecycleInspectionErrorLogged = false;
    this.lastProcessInspectionAt = 0;
    this.lastProcessInspectionFailed = false;
    this.statusInspectionInFlight = false;
    this.cleanupPending = false;
  }

  _retireInactiveLifecycle() {
    const profileDir = this.profileDir;
    const launcherPid = this.process?.pid || null;

    // Invalidate old monitor and child continuations before any replacement
    // profile can be created or assigned.
    this._invalidateLifecycleCallbacks();
    this.active = false;

    const cleanupResult = profileDir
      ? this._cleanup(profileDir)
      : { removed: true, alreadyMissing: true };
    if (cleanupResult.removed !== true) {
      this.cleanupPending = true;
      this._emitStatus('cleanup-failed', {
        pid: launcherPid,
        profileRemoved: false,
        exitReason: 'closed'
      });
      const error = new Error(
        `Could not replace ${this.name}; its previous profile cleanup is still pending`
      );
      error.code = 'BROWSER_CLEANUP_PENDING';
      throw error;
    }

    this._clearLifecycleState();
  }

  async activate(proxyPort, options = {}) {
    if (await this.isActive()) {
      throw new Error(`${this.name} is already running`);
    }

    const browserPath = this._findBrowserPath();
    if (!browserPath) {
      throw new Error(`${this.name} not found on this system`);
    }

    const launchOptions = { ...options };
    if (launchOptions.url) {
      launchOptions.url = normalizeBrowserUrl(launchOptions.url);
    }

    this._retireInactiveLifecycle();

    // Create a uniquely-owned temporary profile. The marker lets a future
    // startup distinguish abandoned profiles from another active instance.
    const profileDir = this._createManagedProfile();
    const generation = ++this.lifecycleGeneration;
    this.profileDir = profileDir;
    this.proxyPort = proxyPort;
    this.trackedProcessIds.clear();
    this.lifecycleInspectionErrorLogged = false;
    this.lastProcessInspectionAt = 0;
    this.lastProcessInspectionFailed = false;

    let args;
    let launchedProcess;
    const rejectLaunch = err => {
      const cleanupResult = this._cleanup(profileDir);
      if (this._ownsLifecycleProfile(generation, profileDir)) {
        this._invalidateLifecycleCallbacks();
        if (cleanupResult.removed === true) {
          this._clearLifecycleState();
        } else {
          this.active = false;
          this.process = null;
          this.cleanupPending = true;
          this._emitStatus('cleanup-failed', {
            profileRemoved: false,
            launchFailed: true,
            error: err.message
          });
        }
      }
      throw err;
    };
    try {
      args = await this._getBrowserArgs(proxyPort, launchOptions, profileDir);
      if (!this._ownsLifecycleProfile(generation, profileDir)) {
        throw new Error(`${this.name} launch was superseded during preparation`);
      }
      console.log(`[Interceptor] Launching ${this.name} with proxy on port ${proxyPort}`);
      launchedProcess = this._spawn(browserPath, args, {
        detached: false,
        stdio: 'ignore'
      });
      await this._waitForSpawn(launchedProcess);
    } catch (err) {
      if (err?.code === PROCESS_STARTUP_EXIT_ERROR_CODE
          && launchedProcess
          && this._ownsLifecycleProfile(generation, profileDir)) {
        const startupLifecycle = this._captureLifecycle();
        const relatedIds = await this._refreshTrackedProcessIds(true, startupLifecycle);
        const profileDescendantsSurvived = this._isLifecycleCurrent(startupLifecycle)
          && relatedIds?.size > 0;
        // Chromium may use the spawned process only as a launcher. If its
        // uniquely-owned profile proves that descendants survived, execution
        // falls through and adopts them instead of deleting their live profile.
        if (!profileDescendantsSurvived
            && this._isLifecycleCurrent(startupLifecycle)
            && relatedIds === null) {
          this._invalidateLifecycleCallbacks();
          // Conservatively report the lifecycle as active until Stop can
          // prove that no profile process survives. This also prevents a
          // replacement activation from deleting the retained profile.
          this.active = true;
          this.process = launchedProcess;
          this.cleanupPending = true;
          this._emitStatus('cleanup-failed', {
            pid: launchedProcess.pid || null,
            profileRemoved: false,
            launchFailed: true,
            processStateUnknown: true,
            error: err.message
          });
          throw err;
        }
        if (!profileDescendantsSurvived) {
          rejectLaunch(err);
        }
      } else {
        rejectLaunch(err);
      }
    }

    if (!this._ownsLifecycleProfile(generation, profileDir)) {
      this._cleanup(profileDir);
      throw new Error(`${this.name} launch was superseded before it became active`);
    }
    this.process = launchedProcess;
    if (Number.isInteger(launchedProcess.pid)
        && launchedProcess.exitCode === null
        && launchedProcess.signalCode === null) {
      this.trackedProcessIds.add(launchedProcess.pid);
    }

    this.active = true;
    this._emitStatus('active');
    const lifecycle = this._captureLifecycle();
    this._startStatusMonitor(lifecycle);

    launchedProcess.on('exit', async (code) => {
      if (!this._isLifecycleCurrent(lifecycle)) return;
      console.log(`[Interceptor] ${this.name} exited with code ${code}`);
      if (!this.active) return;
      const browserStillRunning = await this._isBrowserStillRunning(lifecycle);
      if (!this._isLifecycleCurrent(lifecycle) || !this.active) return;
      if (browserStillRunning) {
        this._startStatusMonitor(lifecycle);
        return;
      }
      this._markInactive('exited', { code }, lifecycle);
    });

    launchedProcess.on('error', async (err) => {
      if (!this._isLifecycleCurrent(lifecycle)) return;
      console.error(`[Interceptor] ${this.name} error:`, err.message);
      if (!this.active) return;
      const browserStillRunning = await this._isBrowserStillRunning(lifecycle);
      if (!this._isLifecycleCurrent(lifecycle) || !this.active) return;
      if (browserStillRunning) {
        this._startStatusMonitor(lifecycle);
        return;
      }
      this._markInactive('error', { error: err.message }, lifecycle);
    });

    return { success: true, pid: launchedProcess.pid, browser: this.name };
  }

  /**
   * Open a web URL in the already-running isolated Chromium profile. Chromium
   * forwards this invocation to the existing profile process as a new tab.
   */
  async openUrl(url) {
    const normalizedUrl = normalizeBrowserUrl(url);
    if (this.cleanupPending) {
      const cleanupError = new Error(
        `Could not reopen ${this.name}; its previous profile cleanup is still pending`
      );
      cleanupError.code = 'BROWSER_CLEANUP_PENDING';
      throw cleanupError;
    }
    if (!(await this.isActive())) {
      if (this.active || this.profileDir) this._markInactive('closed');
      if (this.cleanupPending) {
        const cleanupError = new Error(
          `Could not reopen ${this.name}; its previous profile cleanup is still pending`
        );
        cleanupError.code = 'BROWSER_CLEANUP_PENDING';
        throw cleanupError;
      }
      const error = new Error(`${this.name} is not running`);
      error.code = BROWSER_BECAME_INACTIVE_ERROR_CODE;
      error.normalizedUrl = normalizedUrl;
      throw error;
    }
    if (this.browserType === 'firefox') {
      throw new Error('Opening a new tab in an active isolated Firefox profile is not supported');
    }

    const browserPath = this._findBrowserPath();
    if (!browserPath) {
      throw new Error(`${this.name} not found on this system`);
    }

    const args = this._getChromiumArgs(this.proxyPort, { url: normalizedUrl }, this.profileDir);
    await new Promise((resolve, reject) => {
      const opener = spawn(browserPath, args, {
        detached: false,
        stdio: 'ignore'
      });
      opener.once('error', reject);
      opener.once('spawn', () => {
        opener.unref();
        resolve();
      });
    });

    return { success: true, browser: this.name, url: normalizedUrl };
  }

  async _getBrowserArgs(proxyPort, options, profileDir = this.profileDir) {
    if (this.browserType === 'firefox') {
      return await this._getFirefoxArgs(proxyPort, options, profileDir);
    }
    return this._getChromiumArgs(proxyPort, options, profileDir);
  }

  _getChromiumArgs(proxyPort, options, profileDir = this.profileDir) {
    const args = [
      `--proxy-server=127.0.0.1:${proxyPort}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
    ];

    if (!this.ca?.systemTrustInstalled) {
      const spkiFingerprint = this.ca ? this.ca.getSpkiFingerprint() : '';
      if (!spkiFingerprint) {
        throw new Error('FreeKit CA SPKI fingerprint is unavailable for scoped Chromium trust');
      }
      args.push(`--ignore-certificate-errors-spki-list=${spkiFingerprint}`);
    }

    if (options.url) {
      args.push(options.url);
    } else {
      args.push('about:blank');
    }

    return ensureChromiumLoopbackProxying(args);
  }

  async _getFirefoxArgs(proxyPort, options, profileDir = this.profileDir) {
    // Create Firefox profile with proxy settings
    const prefsPath = path.join(profileDir, 'user.js');
    const prefs = [
      `user_pref("network.proxy.type", 1);`,
      `user_pref("network.proxy.http", "127.0.0.1");`,
      `user_pref("network.proxy.http_port", ${proxyPort});`,
      `user_pref("network.proxy.ssl", "127.0.0.1");`,
      `user_pref("network.proxy.ssl_port", ${proxyPort});`,
      `user_pref("network.proxy.no_proxies_on", "");`,
      // Allow the OS-trust fallback when NSS certutil is unavailable
      `user_pref("security.enterprise_roots.enabled", true);`,
      // Disable warnings / first-run
      `user_pref("browser.shell.checkDefaultBrowser", false);`,
      `user_pref("browser.startup.homepage_override.mstone", "ignore");`,
      `user_pref("datareporting.policy.dataSubmissionEnabled", false);`,
      `user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);`,
      `user_pref("app.normandy.first_run", false);`,
      `user_pref("browser.aboutwelcome.enabled", false);`,
    ].join('\n');
    fs.writeFileSync(prefsPath, prefs);

    // Import our CA cert into Firefox's cert store using certutil if available
    await this._importCertToFirefoxProfile(profileDir);

    const args = [
      '-profile', profileDir,
      '-no-remote',
    ];

    if (options.url) {
      args.push('-url', options.url);
    }

    return args;
  }

  _runCertutil(args) {
    return execFileAsync('certutil', args, { timeout: 5000 });
  }

  async _importCertToFirefoxProfile(profileDir = this.profileDir) {
    if (!this.ca) {
      throw new Error('FreeKit CA certificate is not available for Firefox interception');
    }
    const certInfo = this.ca.getCertInfo();
    const certPath = certInfo.certificatePath;

    try {
      // Initialize the cert DB for the profile
      await this._runCertutil(['-d', `sql:${profileDir}`, '-N', '--empty-password']);

      // Import CA cert as trusted (C = trusted for SSL, T = trusted for email, u = trusted for code signing)
      await this._runCertutil([
        '-d', `sql:${profileDir}`,
        '-A',
        '-t', 'CT,,',
        '-n', 'HTTP FreeKit CA',
        '-i', certPath
      ]);

      console.log(`[Interceptor] Imported CA cert into Firefox profile`);
      return true;
    } catch (err) {
      if (this.ca.systemTrustInstalled) {
        console.log('[Interceptor] Firefox will use the FreeKit CA from the operating-system trust store');
        return false;
      }
      throw new Error(
        `Could not import the FreeKit CA into the Firefox profile. Install Mozilla NSS certutil and retry: ${err.message}`
      );
    }
  }

  async deactivate() {
    if (!this.active && !this.profileDir) return;

    console.log(`[Interceptor] Stopping ${this.name} and its profile process tree...`);
    this._invalidateLifecycleCallbacks();
    const lifecycle = this._captureLifecycle();
    this.active = false;

    const profileDir = lifecycle.profileDir;
    const launcherPid = lifecycle.process?.pid || null;
    const inspectedIds = await this._refreshTrackedProcessIds(true, lifecycle);
    const targetIds = inspectedIds === null
      ? new Set()
      : new Set(inspectedIds);
    if (this._isSpawnedProcessRunning(lifecycle.process)) targetIds.add(launcherPid);

    const remainingIds = await this._terminateProcessTree(targetIds, lifecycle);
    let cleanupResult = { removed: false, reason: 'process state could not be verified' };
    if (remainingIds !== null && remainingIds.size === 0) {
      cleanupResult = this._cleanup(profileDir);
    } else if (remainingIds?.size) {
      console.warn(
        `[Interceptor] Preserving profile ${profileDir}: ${remainingIds.size} browser process(es) are still running`
      );
    } else {
      console.warn(`[Interceptor] Preserving profile ${profileDir}: running processes could not be inspected safely`);
    }

    if (remainingIds === null || remainingIds.size > 0 || cleanupResult.removed !== true) {
      // An unknown or surviving process is still conservatively live. If all
      // processes are confirmed dead, retain only cleanup ownership.
      this.active = remainingIds === null || remainingIds.size > 0;
      this.cleanupPending = true;
      this._emitStatus('cleanup-failed', {
        remainingProcessCount: remainingIds?.size ?? null,
        profileRemoved: false
      });
      throw new Error(
        `Could not fully stop ${this.name}; its process/profile state was preserved so Stop can be retried`
      );
    }

    this._resetLifecycleState(lifecycle);
    this._emitStatus('inactive', {
      terminatedProcessCount: Math.max(0, targetIds.size - (remainingIds?.size || 0)),
      remainingProcessCount: remainingIds?.size ?? null,
      profileRemoved: cleanupResult.removed === true
    });
  }

  _markInactive(reason, extra = {}, lifecycle = this._captureLifecycle()) {
    if (!this._isLifecycleCurrent(lifecycle)) return false;
    const profileDir = lifecycle.profileDir;
    const launcherPid = lifecycle.process?.pid || null;
    this._invalidateLifecycleCallbacks();
    const inactiveLifecycle = this._captureLifecycle();
    this.active = false;
    const cleanupResult = this._cleanup(profileDir);
    if (cleanupResult.removed !== true) {
      this.cleanupPending = true;
      this._emitStatus('cleanup-failed', {
        pid: launcherPid,
        profileRemoved: false,
        exitReason: reason,
        ...extra
      });
      return false;
    }
    this._resetLifecycleState(inactiveLifecycle);
    this._emitStatus(reason, {
      pid: launcherPid,
      profileRemoved: cleanupResult.removed === true,
      ...extra
    });
    return true;
  }

  _startStatusMonitor(lifecycle = this._captureLifecycle()) {
    if (!this._isLifecycleCurrent(lifecycle)) return;
    this._stopStatusMonitor();
    const monitorGeneration = this.statusMonitorGeneration;
    this.statusMonitor = setInterval(() => {
      if (monitorGeneration !== this.statusMonitorGeneration || !this._isLifecycleCurrent(lifecycle)) return;
      if (!this.active) {
        this._stopStatusMonitor();
        return;
      }
      if (this.statusInspectionInFlight) return;
      this.statusInspectionInFlight = true;
      Promise.resolve(this._isBrowserStillRunning(lifecycle))
        .then(running => {
          if (monitorGeneration === this.statusMonitorGeneration
              && this._isLifecycleCurrent(lifecycle)
              && this.active
              && !running) {
            this._markInactive('closed', {}, lifecycle);
          }
        })
        .catch(err => {
          if (monitorGeneration === this.statusMonitorGeneration && this._isLifecycleCurrent(lifecycle)) {
            console.warn(`[Interceptor] Could not monitor ${this.name}: ${err.message}`);
          }
        })
        .finally(() => {
          if (monitorGeneration === this.statusMonitorGeneration && this._isLifecycleCurrent(lifecycle)) {
            this.statusInspectionInFlight = false;
          }
        });
    }, 1500);
    this.statusMonitor.unref?.();
  }

  _stopStatusMonitor() {
    this.statusMonitorGeneration += 1;
    this.statusInspectionInFlight = false;
    if (this.statusMonitor) {
      clearInterval(this.statusMonitor);
      this.statusMonitor = null;
    }
  }

  async _isBrowserStillRunning(lifecycle = this._captureLifecycle()) {
    const spawnedProcessRunning = this._isSpawnedProcessRunning(lifecycle.process);
    const relatedIds = await this._refreshTrackedProcessIds(false, lifecycle);
    // If inspection is unavailable, err on the side of preserving an active
    // browser/profile rather than deleting files that may still be in use.
    return relatedIds === null
      ? spawnedProcessRunning || (this._isLifecycleCurrent(lifecycle) && this.active)
      : spawnedProcessRunning || relatedIds.size > 0;
  }

  _isSpawnedProcessRunning(launchedProcess = this.process) {
    if (!launchedProcess?.pid || launchedProcess.exitCode !== null || launchedProcess.signalCode !== null) {
      return false;
    }
    try {
      process.kill(launchedProcess.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async _refreshTrackedProcessIds(force = false, lifecycle = this._captureLifecycle()) {
    if (!lifecycle.profileDir) {
      if (this._isLifecycleCurrent(lifecycle)) this.trackedProcessIds.clear();
      return new Set();
    }

    const now = Date.now();
    if (this._isLifecycleCurrent(lifecycle) && !force && now - this.lastProcessInspectionAt < 5000) {
      return this.lastProcessInspectionFailed ? null : new Set(this.trackedProcessIds);
    }

    const rootPids = this._isSpawnedProcessRunning(lifecycle.process) ? [lifecycle.process.pid] : [];
    try {
      const relatedIds = await getRelatedProcessIdsAsync(lifecycle.profileDir, rootPids);
      if (this._isLifecycleCurrent(lifecycle)) {
        this.trackedProcessIds = relatedIds;
        this.lastProcessInspectionAt = now;
        this.lastProcessInspectionFailed = false;
        this.lifecycleInspectionErrorLogged = false;
      }
      return new Set(relatedIds);
    } catch (err) {
      if (this._isLifecycleCurrent(lifecycle)) {
        this.lastProcessInspectionAt = now;
        this.lastProcessInspectionFailed = true;
        if (!this.lifecycleInspectionErrorLogged) {
          console.warn(`[Interceptor] Could not inspect ${this.name} process tree: ${err.message}`);
          this.lifecycleInspectionErrorLogged = true;
        }
      }
      return null;
    }
  }

  _signalProcesses(processIds, signal) {
    for (const pid of processIds) {
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
      try {
        process.kill(pid, signal);
      } catch (err) {
        if (err.code !== 'ESRCH') {
          console.warn(`[Interceptor] Could not signal browser PID ${pid}: ${err.message}`);
        }
      }
    }
  }

  async _forceTerminateProcesses(processIds) {
    if (this._platform() === 'win32') {
      for (const pid of processIds) {
        if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
        try {
          await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
            stdio: 'ignore',
            timeout: 5000,
            windowsHide: true
          });
        } catch {
          // The process may have exited between inspection and taskkill.
        }
      }
      return;
    }

    this._signalProcesses(processIds, 'SIGKILL');
  }

  async _waitForProfileProcessesToExit(timeoutMs, lifecycle = this._captureLifecycle()) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const remainingIds = await this._refreshTrackedProcessIds(true, lifecycle);
      if (remainingIds === null || remainingIds.size === 0 || Date.now() >= deadline) {
        return remainingIds;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  async _terminateProcessTree(initialIds, lifecycle = this._captureLifecycle()) {
    if (initialIds.size > 0) this._signalProcesses(initialIds, 'SIGTERM');

    let remainingIds = await this._waitForProfileProcessesToExit(2000, lifecycle);
    if (remainingIds === null || remainingIds.size === 0) return remainingIds;

    console.warn(`[Interceptor] Force-stopping ${remainingIds.size} remaining ${this.name} process(es)`);
    await this._forceTerminateProcesses(remainingIds);
    remainingIds = await this._waitForProfileProcessesToExit(2000, lifecycle);
    return remainingIds;
  }

  _resetLifecycleState(lifecycle = null) {
    if (lifecycle && !this._isLifecycleCurrent(lifecycle)) return false;
    this._invalidateLifecycleCallbacks();
    this._clearLifecycleState();
    return true;
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

  async focus() {
    if (!(await this.isActive())) {
      throw new Error(`${this.name} is not running`);
    }

    const platform = this._platform();
    if (platform === 'win32') {
      const escapedProfileDir = String(this.profileDir || '').replace(/'/g, "''");
      const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}
"@
$candidatePids = @(${this.process.pid})
$profileDir = '${escapedProfileDir}'
if ($profileDir) {
  $profileMatches = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profileDir) } |
    Select-Object -ExpandProperty ProcessId
  $candidatePids = @($candidatePids + $profileMatches) | Select-Object -Unique
}

foreach ($pidValue in $candidatePids) {
  $p = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
  if ($p -and $p.MainWindowHandle -ne 0) {
    if ([Win32]::IsIconic($p.MainWindowHandle)) {
      [Win32]::ShowWindowAsync($p.MainWindowHandle, 9) | Out-Null
    } else {
      [Win32]::ShowWindowAsync($p.MainWindowHandle, 5) | Out-Null
    }
    if ([Win32]::SetForegroundWindow($p.MainWindowHandle)) {
      exit 0
    }
  }
}

exit 1
`;
      await this._execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        stdio: 'ignore',
        timeout: 5000
      });
      return { success: true };
    }

    if (platform === 'darwin') {
      const lifecycle = this._captureLifecycle();
      let processSnapshot;
      try {
        processSnapshot = await this._getProcessSnapshot();
        if (!Array.isArray(processSnapshot)) throw new Error('process snapshot is not an array');
      } catch (err) {
        if (this._isLifecycleCurrent(lifecycle)) {
          this.lastProcessInspectionAt = Date.now();
          this.lastProcessInspectionFailed = true;
          if (!this.lifecycleInspectionErrorLogged) {
            console.warn(`[Interceptor] Could not inspect ${this.name} process tree: ${err.message}`);
            this.lifecycleInspectionErrorLogged = true;
          }
        }
        throw new Error(`Could not safely identify the managed ${this.name} process to focus`);
      }
      // Do not seed this security-sensitive handoff from the launcher PID.
      // ChildProcess liveness is PID-only, so a recycled default-profile PID
      // could otherwise be mistaken for the managed browser. Exact profile
      // arguments in this snapshot establish roots; descendants follow them.
      const relatedIds = collectRelatedProcessIds(
        processSnapshot,
        lifecycle.profileDir,
        [],
        platform
      );
      if (!this._isLifecycleCurrent(lifecycle)) {
        throw new Error(`Could not safely identify the managed ${this.name} process to focus`);
      }
      this.trackedProcessIds = relatedIds;
      this.lastProcessInspectionAt = Date.now();
      this.lastProcessInspectionFailed = false;
      this.lifecycleInspectionErrorLogged = false;
      const candidateProcesses = processSnapshot.flatMap(processInfo => {
        const pid = processInfo?.pid;
        const startedAt = typeof processInfo?.startedAt === 'number'
          ? processInfo.startedAt
          : Date.parse(processInfo?.startedAt);
        return relatedIds.has(pid)
          && Number.isSafeInteger(pid) && pid > 0 && pid <= 0x7fffffff
          && Number.isFinite(startedAt)
          ? [{ pid, startedAt }]
          : [];
      });
      if (candidateProcesses.length === 0) {
        throw new Error(`Could not find the managed ${this.name} application process to focus`);
      }
      const bundleIdentifiers = {
        chrome: 'com.google.Chrome',
        firefox: 'org.mozilla.firefox',
        edge: 'com.microsoft.edgemac',
        brave: 'com.brave.Browser'
      };
      const expectedBundleIdentifier = bundleIdentifiers[this.browserType];
      if (!expectedBundleIdentifier) {
        throw new Error(`Focusing ${this.name} is not supported on macOS`);
      }
      const observationScript = `
ObjC.import('AppKit');
const candidateProcesses = ${JSON.stringify(candidateProcesses)};
const expectedBundleIdentifier = ${JSON.stringify(expectedBundleIdentifier)};
const observedApplications = [];
for (const candidate of candidateProcesses) {
  const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(candidate.pid);
  if (!app) continue;
  const bundleIdentifier = ObjC.unwrap(app.bundleIdentifier);
  if (bundleIdentifier !== expectedBundleIdentifier) continue;
  const launchDate = app.launchDate;
  if (!launchDate) continue;
  const launchTime = Number(launchDate.timeIntervalSince1970);
  if (!Number.isFinite(launchTime) ||
      Math.floor(launchTime) !== Math.floor(candidate.startedAt / 1000)) continue;
  observedApplications.push({ pid: candidate.pid, launchTime });
}
JSON.stringify(observedApplications);
`;
      let observedOutput;
      try {
        observedOutput = await this._execFile(
          'osascript',
          ['-l', 'JavaScript', '-e', observationScript],
          { encoding: 'utf8', timeout: 5000 }
        );
      } catch {
        throw new Error(`Could not safely verify the managed ${this.name} application process`);
      }
      if (!this._isLifecycleCurrent(lifecycle)) {
        throw new Error(`Could not safely identify the managed ${this.name} process to focus`);
      }

      let observedApplications;
      try {
        observedApplications = JSON.parse(String(observedOutput).trim());
      } catch {
        throw new Error(`Could not safely verify the managed ${this.name} application process`);
      }
      const candidateByPid = new Map(candidateProcesses.map(candidate => [candidate.pid, candidate]));
      const observedPids = new Set();
      if (!Array.isArray(observedApplications) || observedApplications.some(observed => {
        const candidate = candidateByPid.get(observed?.pid);
        const invalid = !candidate || observedPids.has(observed.pid) ||
          !Number.isFinite(observed.launchTime) ||
          Math.floor(observed.launchTime) !== Math.floor(candidate.startedAt / 1000);
        observedPids.add(observed?.pid);
        return invalid;
      })) {
        throw new Error(`Could not safely verify the managed ${this.name} application process`);
      }
      if (observedApplications.length === 0) {
        throw new Error(`Could not find the managed ${this.name} application process to focus`);
      }

      let revalidatedSnapshot;
      try {
        revalidatedSnapshot = await this._getProcessSnapshot();
        if (!Array.isArray(revalidatedSnapshot)) throw new Error('process snapshot is not an array');
      } catch (err) {
        if (this._isLifecycleCurrent(lifecycle)) {
          this.lastProcessInspectionAt = Date.now();
          this.lastProcessInspectionFailed = true;
          if (!this.lifecycleInspectionErrorLogged) {
            console.warn(`[Interceptor] Could not inspect ${this.name} process tree: ${err.message}`);
            this.lifecycleInspectionErrorLogged = true;
          }
        }
        throw new Error(`Could not safely identify the managed ${this.name} process to focus`);
      }
      const revalidatedIds = collectRelatedProcessIds(
        revalidatedSnapshot,
        lifecycle.profileDir,
        [],
        platform
      );
      if (!this._isLifecycleCurrent(lifecycle)) {
        throw new Error(`Could not safely identify the managed ${this.name} process to focus`);
      }
      this.trackedProcessIds = revalidatedIds;
      this.lastProcessInspectionAt = Date.now();
      this.lastProcessInspectionFailed = false;
      this.lifecycleInspectionErrorLogged = false;
      const revalidatedByPid = new Map(revalidatedSnapshot.map(processInfo => [
        processInfo?.pid,
        processInfo
      ]));
      observedApplications = observedApplications.filter(observed => {
        const original = candidateByPid.get(observed.pid);
        const revalidated = revalidatedByPid.get(observed.pid);
        const revalidatedStartedAt = typeof revalidated?.startedAt === 'number'
          ? revalidated.startedAt
          : Date.parse(revalidated?.startedAt);
        return revalidatedIds.has(observed.pid) && Number.isFinite(revalidatedStartedAt) &&
          Math.floor(revalidatedStartedAt / 1000) === Math.floor(original.startedAt / 1000);
      });
      if (observedApplications.length === 0) {
        throw new Error(`Could not find the managed ${this.name} application process to focus`);
      }

      const activationScript = `
ObjC.import('AppKit');
const candidateProcesses = ${JSON.stringify(observedApplications)};
const expectedBundleIdentifier = ${JSON.stringify(expectedBundleIdentifier)};
let focused = false;
for (const candidate of candidateProcesses) {
  const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(candidate.pid);
  if (!app) continue;
  const bundleIdentifier = ObjC.unwrap(app.bundleIdentifier);
  if (bundleIdentifier !== expectedBundleIdentifier) continue;
  const launchDate = app.launchDate;
  if (!launchDate) continue;
  const launchTime = Number(launchDate.timeIntervalSince1970);
  if (!Number.isFinite(launchTime) || launchTime !== candidate.launchTime) continue;
  if (app.activateWithOptions($.NSApplicationActivateIgnoringOtherApps)) {
    focused = true;
    break;
  }
}
if (!focused) throw new Error('No matching managed browser application could be activated');
`;
      await this._execFile('osascript', ['-l', 'JavaScript', '-e', activationScript], {
        stdio: 'ignore',
        timeout: 5000
      });
      return { success: true };
    }

    throw new Error(`Focusing ${this.name} is not supported on this platform`);
  }

  _cleanup(profileDir = this.profileDir) {
    if (!profileDir) return { removed: true, alreadyMissing: true };
    const result = removeManagedBrowserProfile(profileDir);
    if (!result.removed) {
      console.warn(`[Interceptor] Could not remove browser profile ${profileDir}: ${result.reason || 'unknown error'}`);
    }
    return result;
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      type: this.browserType,
      active: this.active,
      pid: this.process?.pid || null,
      focusable: this.active && this.canFocus(),
      cleanupPending: this.cleanupPending
    };
  }
}
