import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { findBrowserPath } from './browser-paths.js';
import { normalizeBrowserUrl } from './browser-url.js';
import {
  createManagedBrowserProfile,
  getRelatedProcessIdsAsync,
  removeManagedBrowserProfile
} from './browser-lifecycle.js';
import { execFileAsync } from './command-runner.js';

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

  canFocus() {
    return this._platform() === 'win32' || this._platform() === 'darwin';
  }

  _createManagedProfile() {
    return createManagedBrowserProfile(this.browserType);
  }

  async isActive() {
    return this.active && this._isBrowserStillRunning();
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

    // Create a uniquely-owned temporary profile. The marker lets a future
    // startup distinguish abandoned profiles from another active instance.
    this.profileDir = this._createManagedProfile();
    this.proxyPort = proxyPort;
    this.trackedProcessIds.clear();
    this.lifecycleInspectionErrorLogged = false;
    this.lastProcessInspectionAt = 0;
    this.lastProcessInspectionFailed = false;

    let args;
    let launchedProcess;
    try {
      args = await this._getBrowserArgs(proxyPort, launchOptions);
      console.log(`[Interceptor] Launching ${this.name} with proxy on port ${proxyPort}`);
      launchedProcess = spawn(browserPath, args, {
        detached: false,
        stdio: 'ignore'
      });
    } catch (err) {
      const profileDir = this.profileDir;
      this._cleanup(profileDir);
      this._resetLifecycleState();
      throw err;
    }
    this.process = launchedProcess;
    if (Number.isInteger(launchedProcess.pid)) this.trackedProcessIds.add(launchedProcess.pid);

    this.active = true;
    this._emitStatus('active');
    this._startStatusMonitor();

    launchedProcess.on('exit', async (code) => {
      console.log(`[Interceptor] ${this.name} exited with code ${code}`);
      if (!this.active || this.process !== launchedProcess) return;
      const browserStillRunning = await this._isBrowserStillRunning();
      if (!this.active || this.process !== launchedProcess) return;
      if (browserStillRunning) {
        this._startStatusMonitor();
        return;
      }
      this._markInactive('exited', { code });
    });

    launchedProcess.on('error', (err) => {
      if (this.process !== launchedProcess) return;
      console.error(`[Interceptor] ${this.name} error:`, err.message);
      this._markInactive('error', { error: err.message });
    });

    return { success: true, pid: launchedProcess.pid, browser: this.name };
  }

  /**
   * Open a web URL in the already-running isolated Chromium profile. Chromium
   * forwards this invocation to the existing profile process as a new tab.
   */
  async openUrl(url) {
    const normalizedUrl = normalizeBrowserUrl(url);
    if (!(await this.isActive())) {
      throw new Error(`${this.name} is not running`);
    }
    if (this.browserType === 'firefox') {
      throw new Error('Opening a new tab in an active isolated Firefox profile is not supported');
    }

    const browserPath = this._findBrowserPath();
    if (!browserPath) {
      throw new Error(`${this.name} not found on this system`);
    }

    const args = this._getChromiumArgs(this.proxyPort, { url: normalizedUrl });
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

  async _getBrowserArgs(proxyPort, options) {
    if (this.browserType === 'firefox') {
      return await this._getFirefoxArgs(proxyPort, options);
    }
    return this._getChromiumArgs(proxyPort, options);
  }

  _getChromiumArgs(proxyPort, options) {
    const args = [
      `--proxy-server=127.0.0.1:${proxyPort}`,
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
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
    } else {
      args.push('about:blank');
    }

    return args;
  }

  async _getFirefoxArgs(proxyPort, options) {
    // Create Firefox profile with proxy settings
    const prefsPath = path.join(this.profileDir, 'user.js');
    const prefs = [
      `user_pref("network.proxy.type", 1);`,
      `user_pref("network.proxy.http", "127.0.0.1");`,
      `user_pref("network.proxy.http_port", ${proxyPort});`,
      `user_pref("network.proxy.ssl", "127.0.0.1");`,
      `user_pref("network.proxy.ssl_port", ${proxyPort});`,
      `user_pref("network.proxy.no_proxies_on", "");`,
      // Trust our CA cert
      `user_pref("security.enterprise_roots.enabled", true);`,
      `user_pref("security.cert_pinning.enforcement_level", 0);`,
      `user_pref("security.mixed_content.block_active_content", false);`,
      `user_pref("security.OCSP.enabled", 0);`,
      `user_pref("security.OCSP.require", false);`,
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
    await this._importCertToFirefoxProfile();

    const args = [
      '-profile', this.profileDir,
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

  async _importCertToFirefoxProfile() {
    if (!this.ca) {
      throw new Error('FreeKit CA certificate is not available for Firefox interception');
    }
    const certInfo = this.ca.getCertInfo();
    const certPath = certInfo.certificatePath;

    try {
      // Initialize the cert DB for the profile
      await this._runCertutil(['-d', `sql:${this.profileDir}`, '-N', '--empty-password']);

      // Import CA cert as trusted (C = trusted for SSL, T = trusted for email, u = trusted for code signing)
      await this._runCertutil([
        '-d', `sql:${this.profileDir}`,
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
    this._stopStatusMonitor();
    this.active = false;

    const profileDir = this.profileDir;
    const launcherPid = this.process?.pid || null;
    const inspectedIds = await this._refreshTrackedProcessIds(true);
    const targetIds = inspectedIds === null
      ? new Set()
      : new Set(inspectedIds);
    if (this._isSpawnedProcessRunning()) targetIds.add(launcherPid);

    const remainingIds = await this._terminateProcessTree(targetIds);
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

    this._resetLifecycleState();
    this._emitStatus('inactive', {
      terminatedProcessCount: Math.max(0, targetIds.size - (remainingIds?.size || 0)),
      remainingProcessCount: remainingIds?.size ?? null,
      profileRemoved: cleanupResult.removed === true
    });
  }

  _markInactive(reason, extra = {}) {
    const profileDir = this.profileDir;
    const launcherPid = this.process?.pid || null;
    this._stopStatusMonitor();
    this.active = false;
    const cleanupResult = this._cleanup(profileDir);
    this._resetLifecycleState();
    this._emitStatus(reason, {
      pid: launcherPid,
      profileRemoved: cleanupResult.removed === true,
      ...extra
    });
  }

  _startStatusMonitor() {
    this._stopStatusMonitor();
    const generation = this.statusMonitorGeneration;
    this.statusMonitor = setInterval(() => {
      if (!this.active) {
        this._stopStatusMonitor();
        return;
      }
      if (this.statusInspectionInFlight) return;
      this.statusInspectionInFlight = true;
      Promise.resolve(this._isBrowserStillRunning())
        .then(running => {
          if (generation === this.statusMonitorGeneration && this.active && !running) {
            this._markInactive('closed');
          }
        })
        .catch(err => console.warn(`[Interceptor] Could not monitor ${this.name}: ${err.message}`))
        .finally(() => {
          if (generation === this.statusMonitorGeneration) this.statusInspectionInFlight = false;
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

  async _isBrowserStillRunning() {
    const spawnedProcessRunning = this._isSpawnedProcessRunning();
    const relatedIds = await this._refreshTrackedProcessIds();
    // If inspection is unavailable, err on the side of preserving an active
    // browser/profile rather than deleting files that may still be in use.
    return relatedIds === null
      ? spawnedProcessRunning || this.active
      : spawnedProcessRunning || relatedIds.size > 0;
  }

  _isSpawnedProcessRunning() {
    if (!this.process?.pid || this.process.exitCode !== null || this.process.signalCode !== null) {
      return false;
    }
    try {
      process.kill(this.process.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async _refreshTrackedProcessIds(force = false) {
    if (!this.profileDir) {
      this.trackedProcessIds.clear();
      return new Set();
    }

    const now = Date.now();
    if (!force && now - this.lastProcessInspectionAt < 5000) {
      return this.lastProcessInspectionFailed ? null : new Set(this.trackedProcessIds);
    }

    const rootPids = this._isSpawnedProcessRunning() ? [this.process.pid] : [];
    try {
      const relatedIds = await getRelatedProcessIdsAsync(this.profileDir, rootPids);
      this.trackedProcessIds = relatedIds;
      this.lastProcessInspectionAt = now;
      this.lastProcessInspectionFailed = false;
      this.lifecycleInspectionErrorLogged = false;
      return new Set(relatedIds);
    } catch (err) {
      this.lastProcessInspectionAt = now;
      this.lastProcessInspectionFailed = true;
      if (!this.lifecycleInspectionErrorLogged) {
        console.warn(`[Interceptor] Could not inspect ${this.name} process tree: ${err.message}`);
        this.lifecycleInspectionErrorLogged = true;
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

  async _waitForProfileProcessesToExit(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const remainingIds = await this._refreshTrackedProcessIds(true);
      if (remainingIds === null || remainingIds.size === 0 || Date.now() >= deadline) {
        return remainingIds;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  async _terminateProcessTree(initialIds) {
    if (initialIds.size > 0) this._signalProcesses(initialIds, 'SIGTERM');

    let remainingIds = await this._waitForProfileProcessesToExit(2000);
    if (remainingIds === null || remainingIds.size === 0) return remainingIds;

    console.warn(`[Interceptor] Force-stopping ${remainingIds.size} remaining ${this.name} process(es)`);
    await this._forceTerminateProcesses(remainingIds);
    remainingIds = await this._waitForProfileProcessesToExit(2000);
    return remainingIds;
  }

  _resetLifecycleState() {
    this.active = false;
    this.process = null;
    this.profileDir = null;
    this.proxyPort = null;
    this.trackedProcessIds.clear();
    this.lifecycleInspectionErrorLogged = false;
    this.lastProcessInspectionAt = 0;
    this.lastProcessInspectionFailed = false;
    this.statusInspectionInFlight = false;
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

    if (process.platform === 'win32') {
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
      await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        stdio: 'ignore',
        timeout: 5000
      });
      return { success: true };
    }

    if (this._platform() === 'darwin') {
      const appNames = {
        chrome: 'Google Chrome',
        firefox: 'Firefox',
        edge: 'Microsoft Edge',
        brave: 'Brave Browser'
      };
      await execFileAsync('osascript', ['-e', `tell application "${appNames[this.browserType] || this.name}" to activate`], {
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
      focusable: this.canFocus()
    };
  }
}
