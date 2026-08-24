import {
  BROWSER_BECAME_INACTIVE_ERROR_CODE,
  BrowserInterceptor
} from './browser-interceptor.js';
import { ExistingBrowserInterceptor } from './existing-browser-interceptor.js';
import { FreshTerminalInterceptor, ExistingTerminalInterceptor } from './terminal-interceptors.js';
import { SystemProxyInterceptor } from './system-proxy-interceptor.js';
import { DockerInterceptor } from './docker-interceptor.js';
import { ElectronInterceptor } from './electron-interceptor.js';
import { AndroidAdbInterceptor } from './android-adb-interceptor.js';
import { JvmInterceptor } from './jvm-interceptor.js';
import { cleanupStaleBrowserProfiles } from './browser-lifecycle.js';

export const INTERCEPTOR_MANAGER_CLOSING_ERROR_CODE = 'INTERCEPTOR_MANAGER_CLOSING';
export const INTERCEPTOR_MANAGER_CLOSING_ERROR_MESSAGE = 'Interceptor manager is shutting down';
export const DEFAULT_SHUTDOWN_CLEANUP_ATTEMPTS = 2;
export const DEFAULT_SHUTDOWN_OPERATION_TIMEOUT_MS = 120_000;
export const MAX_SHUTDOWN_OPERATION_TIMEOUT_MS = 2 * 60 * 60 * 1000;
export const SHUTDOWN_PROGRESS_GRACE_MS = 5_000;

function withTimeout(operation, timeoutMs, interceptorName) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(
        `${interceptorName} cleanup did not finish within ${timeoutMs}ms`
      ));
    }, timeoutMs);
    timer.unref?.();
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

export class InterceptorManager {
  constructor(ca, options = {}) {
    this.interceptors = new Map();
    this.operationsInProgress = new Map();
    this.statusOperations = new Map();
    this.closing = false;
    this.ca = ca;
    this.onStatusChange = null;
    this._initializationPromise = Promise.resolve(false);

    const staleProfileCleanup = cleanupStaleBrowserProfiles();
    if (staleProfileCleanup.removed.length > 0) {
      console.log(`[Interceptor] Removed ${staleProfileCleanup.removed.length} stale browser profile(s)`);
    }
    for (const failure of staleProfileCleanup.failed) {
      console.warn(`[Interceptor] Stale profile cleanup skipped ${failure.path}: ${failure.reason}`);
    }

    // Register all interceptors (order matches HTTP Toolkit's sidebar)
    const isolatedBrowsers = [
      new BrowserInterceptor('chrome', 'Chrome', 'chrome', options),
      new BrowserInterceptor('firefox', 'Firefox', 'firefox', options),
      new BrowserInterceptor('edge', 'Edge', 'edge', options),
      new BrowserInterceptor('brave', 'Brave', 'brave', options)
    ];
    this._register(isolatedBrowsers[0]);
    this._register(new ExistingBrowserInterceptor(
      'existing-chrome',
      'Global Chrome',
      'chrome',
      { dataDir: options.dataDir, proxyBindHost: options.proxyBindHost }
    ));
    this._register(isolatedBrowsers[1]);
    this._register(isolatedBrowsers[2]);
    this._register(isolatedBrowsers[3]);
    for (const browser of isolatedBrowsers) {
      const recoverableProfiles = staleProfileCleanup.recoverable.filter(
        record => record.browserType === browser.browserType
      );
      if (browser.recoverProfiles(recoverableProfiles)) {
        console.log(
          `[Interceptor] Recovered ${recoverableProfiles.length} active ${browser.name} profile(s)`
        );
      }
    }
    this._register(new FreshTerminalInterceptor({
      dataDir: options.dataDir,
      proxyBindHost: options.proxyBindHost
    }));
    this._register(new ExistingTerminalInterceptor({ proxyBindHost: options.proxyBindHost }));
    const systemProxy = new SystemProxyInterceptor({
      dataDir: options.dataDir,
      ca,
      proxyBindHost: options.proxyBindHost
    });
    this._register(systemProxy);
    this._initializationPromise = systemProxy.recoverStaleSettings();
    this._register(new DockerInterceptor({ proxyBindHost: options.proxyBindHost }));
    this._register(new ElectronInterceptor({
      dataDir: options.dataDir,
      proxyBindHost: options.proxyBindHost
    }));
    this._register(new AndroidAdbInterceptor({
      dataDir: options.dataDir,
      proxyBindHost: options.proxyBindHost
    }));
    this._register(new JvmInterceptor({
      dataDir: options.dataDir,
      proxyBindHost: options.proxyBindHost
    }));

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

  async initialize() {
    return await this._initializationPromise;
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

  async _getNeedsDeactivationState(interceptor, active) {
    if (typeof interceptor.needsDeactivation === 'function') {
      return Boolean(await interceptor.needsDeactivation());
    }
    return active;
  }

  _publishFailureEvents(events, activeBeforeOperation) {
    for (const event of events) {
      const reportsFailureState = event?.reason === 'cleanup-failed'
        || event?.reason === 'stop-failed'
        || event?.launchFailed === true;
      const reportsSuccessfulTransition = event?.reason === 'active'
        || event?.reason === 'inactive'
        || Boolean(event?.active) !== activeBeforeOperation;
      if (reportsFailureState || !reportsSuccessfulTransition) {
        this._publishStatus(event);
      }
    }
  }

  async _runStateTransition(interceptor, operation) {
    const wasActive = await this._getActiveState(interceptor);
    const neededDeactivation = await this._getNeedsDeactivationState(interceptor, wasActive);
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
      const needsDeactivation = await this._getNeedsDeactivationState(interceptor, active);
      if (active === wasActive && needsDeactivation === neededDeactivation) return result;

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
    await this.initialize();
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

  beginShutdown() {
    this.closing = true;
  }

  _assertAcceptingOperations() {
    if (!this.closing) return;
    const error = new Error(INTERCEPTOR_MANAGER_CLOSING_ERROR_MESSAGE);
    error.code = INTERCEPTOR_MANAGER_CLOSING_ERROR_CODE;
    throw error;
  }

  async activate(id, proxyPort, options = {}) {
    await this.initialize();
    this._assertAcceptingOperations();
    const interceptor = this.interceptors.get(id);
    if (!interceptor) throw new Error(`Unknown interceptor: ${id}`);

    return await this._runExclusive(
      id,
      interceptor,
      () => this._activateInterceptor(interceptor, proxyPort, options)
    );
  }

  async _activateInterceptor(interceptor, proxyPort, options = {}) {
    const activable = await interceptor.isActivable();
    if (!activable) throw new Error(`${interceptor.name} is not available on this system`);

    return await this._runStateTransition(
      interceptor,
      () => interceptor.activate(proxyPort, options)
    );
  }

  async deactivate(id, options = {}) {
    await this.initialize();
    this._assertAcceptingOperations();
    const interceptor = this.interceptors.get(id);
    if (!interceptor) throw new Error(`Unknown interceptor: ${id}`);
    return await this._deactivateInterceptor(interceptor, options);
  }

  async _deactivateInterceptor(interceptor, options = {}, runOptions = {}) {
    return await this._runExclusive(
      interceptor.id,
      interceptor,
      () => this._runStateTransition(interceptor, () => interceptor.deactivate(options)),
      runOptions
    );
  }

  async _runExclusive(id, interceptor, operation, { allowWhileClosing = false } = {}) {
    if (!allowWhileClosing) this._assertAcceptingOperations();
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
    await this.initialize();
    this._assertAcceptingOperations();
    const interceptor = this.interceptors.get(id);
    if (!interceptor) throw new Error(`Unknown interceptor: ${id}`);
    if (typeof interceptor.focus !== 'function') {
      throw new Error(`${interceptor.name} cannot be focused`);
    }
    return await this._runExclusive(id, interceptor, () => interceptor.focus());
  }

  async openUrl(id, proxyPort, url) {
    await this.initialize();
    this._assertAcceptingOperations();
    const interceptor = this.interceptors.get(id);
    if (!interceptor) throw new Error(`Unknown interceptor: ${id}`);
    if (typeof interceptor.openUrl !== 'function') {
      throw new Error(`${interceptor.name} cannot open browser URLs`);
    }

    return await this._runExclusive(id, interceptor, async () => {
      if (!(await interceptor.isActive())) {
        return await this._activateInterceptor(interceptor, proxyPort, { url });
      }

      try {
        return await interceptor.openUrl(url);
      } catch (err) {
        const browserBecameInactive =
          err?.code === BROWSER_BECAME_INACTIVE_ERROR_CODE &&
          typeof err.normalizedUrl === 'string' &&
          !(await interceptor.isActive());
        if (!browserBecameInactive) throw err;

        return await this._activateInterceptor(interceptor, proxyPort, {
          url: err.normalizedUrl
        });
      }
    });
  }

  async deactivateAll({
    maxAttempts = DEFAULT_SHUTDOWN_CLEANUP_ATTEMPTS,
    operationTimeoutMs = DEFAULT_SHUTDOWN_OPERATION_TIMEOUT_MS,
    onProgress = null
  } = {}) {
    this.beginShutdown();
    await this.initialize();
    const attempts = Math.max(1, Number.isSafeInteger(maxAttempts) ? maxAttempts : 1);
    const timeoutMs = Math.max(1, Number.isSafeInteger(operationTimeoutMs)
      ? operationTimeoutMs
      : DEFAULT_SHUTDOWN_OPERATION_TIMEOUT_MS);
    let pending = [...this.interceptors.values()];
    let failures = [];

    for (let attempt = 1; attempt <= attempts && pending.length > 0; attempt++) {
      failures = [];
      for (const interceptor of pending) {
        try {
          const requestedTimeoutMs = typeof interceptor.getShutdownTimeoutMs === 'function'
            ? interceptor.getShutdownTimeoutMs(timeoutMs)
            : timeoutMs;
          const interceptorTimeoutMs = Number.isSafeInteger(requestedTimeoutMs) && requestedTimeoutMs > 0
            ? Math.min(requestedTimeoutMs, MAX_SHUTDOWN_OPERATION_TIMEOUT_MS)
            : timeoutMs;
          onProgress?.({
            interceptorId: interceptor.id,
            interceptorName: interceptor.name,
            attempt,
            maxAttempts: attempts,
            operationTimeoutMs: interceptorTimeoutMs,
            timeoutMs: Math.min(
              interceptorTimeoutMs + SHUTDOWN_PROGRESS_GRACE_MS,
              MAX_SHUTDOWN_OPERATION_TIMEOUT_MS + SHUTDOWN_PROGRESS_GRACE_MS
            )
          });
          await withTimeout((async () => {
            await this.operationsInProgress?.get(interceptor.id)?.catch(() => {});
            const needsDeactivation = typeof interceptor.needsDeactivation === 'function'
              ? await interceptor.needsDeactivation()
              : await interceptor.isActive();
            if (needsDeactivation) {
              // Shutdown owns this admission. It bypasses only the external
              // closing gate and retains the ordinary per-ID lock and status flow.
              await this._deactivateInterceptor(interceptor, {}, { allowWhileClosing: true });
            }
          })(), interceptorTimeoutMs, interceptor.name);
        } catch (error) {
          console.error(
            `[Interceptor] Error deactivating ${interceptor.name} ` +
            `(attempt ${attempt}/${attempts}):`,
            error.message
          );
          failures.push({ interceptor, error });
        }
      }
      pending = failures.map(failure => failure.interceptor);
    }

    if (failures.length > 0) {
      throw new AggregateError(
        failures.map(failure => failure.error),
        `Failed to deactivate ${failures.map(failure => failure.interceptor.name).join(', ')}`
      );
    }
  }
}
