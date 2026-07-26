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
    this.operationsInProgress = new Map();
    this.statusOperations = new Map();
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
    const systemProxy = new SystemProxyInterceptor({ dataDir: options.dataDir, ca });
    systemProxy.recoverStaleSettings();
    this._register(systemProxy);
    this._register(new DockerInterceptor());
    this._register(new ElectronInterceptor());
    this._register(new AndroidAdbInterceptor({ dataDir: options.dataDir }));
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
      const operation = this.statusOperations?.get(interceptor.id);
      if (operation) operation.events.push(event);
      else this._publishStatus(event);
    };
    this.interceptors.set(interceptor.id, interceptor);
  }

  _publishStatus(event) {
    if (typeof this.onStatusChange === 'function') {
      this.onStatusChange(event);
    }
  }

  async _getActiveState(interceptor) {
    if (typeof interceptor.isActive === 'function') {
      return Boolean(await interceptor.isActive());
    }
    return Boolean(interceptor.active);
  }

  _publishFailureEvents(events, activeBeforeOperation) {
    for (const event of events) {
      const reportsSuccessfulTransition = event?.reason === 'active'
        || event?.reason === 'inactive'
        || Boolean(event?.active) !== activeBeforeOperation;
      if (!reportsSuccessfulTransition) {
        this._publishStatus(event);
      }
    }
  }

  async _runStateTransition(interceptor, operation) {
    const wasActive = await this._getActiveState(interceptor);
    const statusOperation = { events: [] };
    this.statusOperations ||= new Map();
    this.statusOperations.set(interceptor.id, statusOperation);

    try {
      let result;
      try {
        result = await operation();
      } catch (err) {
        this._publishFailureEvents(statusOperation.events, wasActive);
        throw err;
      }

      if (result?.success === false) {
        this._publishFailureEvents(statusOperation.events, wasActive);
        return result;
      }

      const active = await this._getActiveState(interceptor);
      if (active === wasActive) return result;

      const emittedTransition = statusOperation.events
        .filter(event => Boolean(event?.active) === active)
        .at(-1);
      if (emittedTransition) {
        this._publishStatus(emittedTransition);
      } else {
        const snapshot = typeof interceptor.toJSON === 'function'
          ? interceptor.toJSON()
          : {};
        this._publishStatus({
          ...snapshot,
          id: interceptor.id,
          name: interceptor.name,
          active,
          reason: active ? 'active' : 'inactive'
        });
      }
      return result;
    } finally {
      if (this.statusOperations.get(interceptor.id) === statusOperation) {
        this.statusOperations.delete(interceptor.id);
      }
    }
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

    return await this._runExclusive(id, interceptor, async () => {
      const activable = await interceptor.isActivable();
      if (!activable) throw new Error(`${interceptor.name} is not available on this system`);

      return await this._runStateTransition(
        interceptor,
        () => interceptor.activate(proxyPort, options)
      );
    });
  }

  async deactivate(id, options = {}) {
    const interceptor = this.interceptors.get(id);
    if (!interceptor) throw new Error(`Unknown interceptor: ${id}`);
    return await this._runExclusive(
      id,
      interceptor,
      () => this._runStateTransition(interceptor, () => interceptor.deactivate(options))
    );
  }

  async _runExclusive(id, interceptor, operation) {
    this.operationsInProgress ||= new Map();
    if (this.operationsInProgress.has(id)) {
      const error = new Error(`${interceptor.name} already has an operation in progress`);
      error.code = 'INTERCEPTOR_OPERATION_IN_PROGRESS';
      throw error;
    }

    const pending = Promise.resolve().then(operation);
    this.operationsInProgress.set(id, pending);
    try {
      return await pending;
    } finally {
      if (this.operationsInProgress.get(id) === pending) {
        this.operationsInProgress.delete(id);
      }
    }
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
        await this.operationsInProgress?.get(interceptor.id)?.catch(() => {});
        const needsDeactivation = typeof interceptor.needsDeactivation === 'function'
          ? await interceptor.needsDeactivation()
          : await interceptor.isActive();
        if (needsDeactivation) {
          await this.deactivate(interceptor.id);
        }
      } catch (err) {
        console.error(`[Interceptor] Error deactivating ${interceptor.name}:`, err.message);
      }
    }
  }
}
