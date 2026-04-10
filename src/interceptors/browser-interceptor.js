import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { findBrowserPath } from './browser-paths.js';

export class BrowserInterceptor {
  constructor(id, name, browserType) {
    this.id = id;
    this.name = name;
    this.browserType = browserType;
    this.process = null;
    this.profileDir = null;
    this.active = false;
    this.ca = null; // Set by InterceptorManager
  }

  async isActivable() {
    return findBrowserPath(this.browserType) !== null;
  }

  async isActive() {
    return this.active && this.process && !this.process.killed;
  }

  async activate(proxyPort, options = {}) {
    const browserPath = findBrowserPath(this.browserType);
    if (!browserPath) {
      throw new Error(`${this.name} not found on this system`);
    }

    // Create a temporary profile directory
    this.profileDir = path.join(os.tmpdir(), `http-freekit-${this.browserType}-${Date.now()}`);
    fs.mkdirSync(this.profileDir, { recursive: true });

    const args = this._getBrowserArgs(proxyPort, options);

    console.log(`[Interceptor] Launching ${this.name} with proxy on port ${proxyPort}`);
    this.process = spawn(browserPath, args, {
      detached: false,
      stdio: 'ignore'
    });

    this.active = true;

    this.process.on('exit', (code) => {
      console.log(`[Interceptor] ${this.name} exited with code ${code}`);
      this.active = false;
      this._cleanup();
    });

    this.process.on('error', (err) => {
      console.error(`[Interceptor] ${this.name} error:`, err.message);
      this.active = false;
    });

    return { success: true, pid: this.process.pid, browser: this.name };
  }

  _getBrowserArgs(proxyPort, options) {
    if (this.browserType === 'firefox') {
      return this._getFirefoxArgs(proxyPort, options);
    }
    return this._getChromiumArgs(proxyPort, options);
  }

  _getChromiumArgs(proxyPort, options) {
    // Get the SPKI fingerprint of our CA so Chrome trusts our MITM certs
    const spkiFingerprint = this.ca ? this.ca.getSpkiFingerprint() : '';

    const args = [
      `--proxy-server=http://127.0.0.1:${proxyPort}`,
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-sync',
      '--disable-translate',
      '--metrics-recording-only',
      // These two flags together suppress "Not Secure" for our CA-signed certs
      '--ignore-certificate-errors',
      `--ignore-certificate-errors-spki-list=${spkiFingerprint}`,
      '--test-type', // Suppresses "unsupported command-line flag" warnings
      '--allow-insecure-localhost',
    ];

    if (options.url) {
      args.push(options.url);
    } else {
      args.push('about:blank');
    }

    return args;
  }

  _getFirefoxArgs(proxyPort, options) {
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
    this._importCertToFirefoxProfile();

    const args = [
      '-profile', this.profileDir,
      '-no-remote',
    ];

    if (options.url) {
      args.push('-url', options.url);
    }

    return args;
  }

  _importCertToFirefoxProfile() {
    if (!this.ca) return;
    const certInfo = this.ca.getCertInfo();
    const certPath = certInfo.certificatePath;

    try {
      // Initialize the cert DB for the profile
      execSync(`certutil -d sql:${this.profileDir} -N --empty-password`, {
        stdio: 'ignore', timeout: 5000
      });

      // Import CA cert as trusted (C = trusted for SSL, T = trusted for email, u = trusted for code signing)
      execSync(`certutil -d sql:${this.profileDir} -A -t "CT,," -n "HTTP FreeKit CA" -i "${certPath}"`, {
        stdio: 'ignore', timeout: 5000
      });

      console.log(`[Interceptor] Imported CA cert into Firefox profile`);
    } catch {
      // certutil not available — Firefox will still work via enterprise_roots pref
      // On Windows, we can try the NSS certutil bundled with HTTP Toolkit if available
      console.log('[Interceptor] certutil not found, relying on enterprise_roots pref for Firefox');
    }
  }

  async deactivate() {
    if (this.process && !this.process.killed) {
      console.log(`[Interceptor] Stopping ${this.name}...`);
      this.process.kill();
      this.active = false;
    }
    this._cleanup();
  }

  _cleanup() {
    if (this.profileDir) {
      try {
        fs.rmSync(this.profileDir, { recursive: true, force: true });
      } catch (e) {
        // Profile may still be locked
      }
    }
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
