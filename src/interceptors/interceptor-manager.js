import { BrowserInterceptor } from './browser-interceptor.js';
import { ExistingBrowserInterceptor } from './existing-browser-interceptor.js';
import { FreshTerminalInterceptor, ExistingTerminalInterceptor } from './terminal-interceptors.js';
import { SystemProxyInterceptor } from './system-proxy-interceptor.js';
import { DockerInterceptor } from './docker-interceptor.js';
import { ElectronInterceptor } from './electron-interceptor.js';
import { AndroidAdbInterceptor } from './android-adb-interceptor.js';
import { JvmInterceptor } from './jvm-interceptor.js';
import { cleanupStaleBrowserProfiles } from './browser-lifecycle.js';

export class InterceptorManager {
  constructor(ca, options = {}) {
    this.interceptors = new Map();
    this.ca = ca;
    this.onStatusChange = null;

    const staleProfileCleanup = cleanupStaleBrowserProfiles();
    if (staleProfileCleanup.removed.length > 0) {
      console.log(`[Interceptor] Removed ${staleProfileCleanup.removed.length} stale browser profile(s)`);
    }
    for (const failure of staleProfileCleanup.failed) {
      console.warn(`[Interceptor] Stale profile cleanup skipped ${failure.path}: ${failure.reason}`);
    }

    // Register all interceptors (order matches HTTP Toolkit's sidebar)
    this._register(new BrowserInterceptor('chrome', 'Chrome', 'chrome'));
    this._register(new ExistingBrowserInterceptor('existing-chrome', 'Global Chrome', 'chrome'));
    this._register(new BrowserInterceptor('firefox', 'Firefox', 'firefox'));
    this._register(new BrowserInterceptor('edge', 'Edge', 'edge'));
    this._register(new BrowserInterceptor('brave', 'Brave', 'brave'));
    this._register(new FreshTerminalInterceptor());
    this._register(new ExistingTerminalInterceptor());
    const systemProxy = new SystemProxyInterceptor({ dataDir: options.dataDir });
    systemProxy.recoverStaleSettings();
    this._register(systemProxy);
    this._register(new DockerInterceptor());
    this._register(new ElectronInterceptor());
    this._register(new AndroidAdbInterceptor());
    this._register(new JvmInterceptor({ dataDir: options.dataDir }));

    // Give all interceptors that need it a reference to the CA
    for (const interceptor of this.interceptors.values()) {
      if ('ca' in interceptor) {
        interceptor.ca = ca;
      }
    }
  }

  _register(interceptor) {
    interceptor.onStatusChange = (event) => {
      if (typeof this.onStatusChange === 'function') {
        this.onStatusChange(event);
      }
    };
    this.interceptors.set(interceptor.id, interceptor);
  }

  async getAll() {
    const results = [];
    for (const interceptor of this.interceptors.values()) {
      const activable = await interceptor.isActivable();
      const active = await interceptor.isActive();
      results.push({
        ...interceptor.toJSON(),
        activable,
        active
      });
    }
    return results;
  }

  async activate(id, proxyPort, options = {}) {
    const interceptor = this.interceptors.get(id);
    if (!interceptor) throw new Error(`Unknown interceptor: ${id}`);

    const activable = await interceptor.isActivable();
    if (!activable) throw new Error(`${interceptor.name} is not available on this system`);

    return await interceptor.activate(proxyPort, options);
  }

  async deactivate(id, options = {}) {
    const interceptor = this.interceptors.get(id);
    if (!interceptor) throw new Error(`Unknown interceptor: ${id}`);
    await interceptor.deactivate(options);
  }

  async focus(id) {
    const interceptor = this.interceptors.get(id);
    if (!interceptor) throw new Error(`Unknown interceptor: ${id}`);
    if (typeof interceptor.focus !== 'function') {
      throw new Error(`${interceptor.name} cannot be focused`);
    }
    return await interceptor.focus();
  }

  async openUrl(id, proxyPort, url) {
    const interceptor = this.interceptors.get(id);
    if (!interceptor) throw new Error(`Unknown interceptor: ${id}`);
    if (typeof interceptor.openUrl !== 'function') {
      throw new Error(`${interceptor.name} cannot open browser URLs`);
    }

    if (await interceptor.isActive()) {
      return await interceptor.openUrl(url);
    }

    return await this.activate(id, proxyPort, { url });
  }

  async deactivateAll() {
    for (const interceptor of this.interceptors.values()) {
      try {
        if (await interceptor.isActive()) {
          await interceptor.deactivate();
        }
      } catch (err) {
        console.error(`[Interceptor] Error deactivating ${interceptor.name}:`, err.message);
      }
    }
  }
}
