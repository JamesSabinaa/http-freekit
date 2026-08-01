import express from 'express';
import { isUtf8 } from 'node:buffer';
import http from 'http';
import https from 'https';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { performance } from 'node:perf_hooks';
import { execFile, spawn } from 'child_process';
import { WebSocketServer } from 'ws';
import os from 'os';
import { trafficToHar } from './har-converter.js';
import { validateOpenApiSubmission } from './openapi-validation.js';
import { registerConfigurationRoutes } from './routes/configuration-routes.js';
import { validatePortRange } from '../proxy/port-range.js';
import { MCP_ENABLED_SETTING } from '../mcp/enabled-state.js';
import { UpstreamProxyConfigError } from '../proxy/upstream-proxy-config.js';
import { validateMockRule } from '../proxy/mock-rule-validation.js';
import {
  DEFAULT_EXCLUSIONS,
  normalizeDefaultExclusions
} from '../traffic/default-exclusions.js';
import {
  DEFAULT_TRAFFIC_LIST_ID,
  createDefaultTrafficList,
  filterTrafficLists,
  normalizeTrafficLists
} from '../traffic/traffic-lists.js';

const DEFAULT_GENERATOR_DIR = '/mnt/b/bots/generator';
const INTERNAL_SEND_HEADER_NAME = 'x-http-freekit-internal-send-token';
// A slow UI client is disconnected before pending broadcasts exceed 16 MiB.
export const DEFAULT_MAX_WS_BUFFERED_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MANAGEMENT_REQUEST_TIMEOUT_MS = 30000;
const DATA_URI_MEDIA_TYPE_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+\/[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function normalizeDataUriMediaType(value) {
  const rawValue = Array.isArray(value) ? value[0] : value;
  const candidate = String(rawValue || '').split(';', 1)[0].trim().toLowerCase();
  return DATA_URI_MEDIA_TYPE_PATTERN.test(candidate)
    ? candidate
    : 'application/octet-stream';
}

function harHeadersToObject(headers = []) {
  const result = {};
  for (const header of headers) {
    const name = String(header?.name || '').toLowerCase();
    if (!name) continue;
    const value = String(header?.value ?? '');
    if (result[name] === undefined) {
      result[name] = value;
    } else if (Array.isArray(result[name])) {
      result[name].push(value);
    } else {
      result[name] = [result[name], value];
    }
  }
  return result;
}

function harBodyToTraffic(body, fallbackMimeType = 'application/octet-stream') {
  if (!body || body.text === undefined || body.text === null) {
    return { body: '', encoding: 'utf8' };
  }
  const text = String(body.text);
  if (String(body.encoding || '').toLowerCase() !== 'base64') {
    return { body: text, encoding: 'utf8' };
  }
  const mimeType = normalizeDataUriMediaType(body.mimeType || fallbackMimeType);
  return {
    body: `data:${mimeType};base64,${text.replace(/\s+/g, '')}`,
    encoding: 'base64'
  };
}

function normalizeHarBodySize(value) {
  return typeof value === 'number' && Number.isFinite(value) && (value >= 0 || value === -1)
    ? value
    : 0;
}

function harTruncationToTraffic(body, fieldPath) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || !Object.prototype.hasOwnProperty.call(body, '_truncated')) return null;
  if (typeof body._truncated !== 'boolean') {
    throw new TypeError(`${fieldPath}._truncated must be a boolean`);
  }
  if (!body._truncated) return null;

  const capturedSize = body._capturedSize;
  if (!Number.isSafeInteger(capturedSize) || capturedSize < 0) {
    throw new TypeError(`${fieldPath}._capturedSize must be a non-negative safe integer`);
  }
  const originalSize = body._originalSize;
  if (!Number.isSafeInteger(originalSize) || originalSize < -1) {
    throw new TypeError(
      `${fieldPath}._originalSize must be a non-negative safe integer or -1`
    );
  }
  if (originalSize >= 0 && capturedSize > originalSize) {
    throw new TypeError(`${fieldPath}._capturedSize cannot exceed _originalSize`);
  }
  return {
    capturedSize,
    originalSize
  };
}

function publicClientCertificates(certificates) {
  if (!Array.isArray(certificates)) return [];
  return certificates.map(certificate => ({
    host: certificate?.host,
    pfxPath: certificate?.pfxPath
  }));
}

function normalizeImportedMockRule(rule, allowGroup = true) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return null;
  if (Object.prototype.hasOwnProperty.call(rule, 'enabled')
    && typeof rule.enabled !== 'boolean') return null;
  const normalizedRule = { ...rule };
  delete normalizedRule.id;

  if (rule.type === 'group') {
    if (!allowGroup || !Array.isArray(rule.items)) return null;
    const items = rule.items.map(item => normalizeImportedMockRule(item, false));
    if (items.some(item => !item)) return null;
    const group = {
      ...normalizedRule,
      enabled: rule.enabled === undefined ? true : rule.enabled,
      items
    };
    return validateMockRule(group) ? null : group;
  }

  const normalized = {
    ...normalizedRule,
    enabled: rule.enabled === undefined ? true : rule.enabled,
    priority: rule.priority || 'normal'
  };
  return validateMockRule(normalized) ? null : normalized;
}

function normalizeImportedBreakpointRule(rule) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return null;
  const normalizedRule = structuredClone(rule);
  delete normalizedRule.id;
  normalizedRule.enabled = rule.enabled !== false;
  return normalizedRule;
}

function interceptorOperationErrorStatus(error, fallbackStatus) {
  if (error?.code === 'INTERCEPTOR_MANAGER_CLOSING') return 503;
  if (error?.code === 'INTERCEPTOR_OPERATION_IN_PROGRESS') return 409;
  if (error?.code === 'ANDROID_CA_REMOVAL_CONFIRMATION_REQUIRED') return 409;
  return fallbackStatus;
}

export class ApiServer {
  constructor(proxyServer, certificateAuthority, interceptorManager, options = {}) {
    this.proxy = proxyServer;
    this.ca = certificateAuthority;
    this.interceptors = interceptorManager;
    this.port = options.port || 45457;
    this.app = express();
    this.httpServer = null;
    this.wss = null;
    this.clients = new Set();
    this._clientBroadcastQueues = new WeakMap();
    this._httpSockets = new Set();
    this._startPromise = null;
    this._cancelStart = null;
    this._stopPromise = null;
    this._stopping = false;
    this.trafficLog = []; // In-memory traffic log
    this.capturePaused = false;
    this.captureStateSessionId = crypto.randomUUID();
    this.captureStateRevision = 0;
    this.maxTrafficLog = 10000;
    this._pendingTrafficIds = new Set();
    this._pendingTrafficLifecycles = new Map();
    this._clearedPendingTrafficIds = new Map();
    this._activeTrafficIdentities = new Set();
    this._deletedTrafficIdentities = new Map();
    this._retainedTrafficGenerations = new Map();
    this._trafficClearGeneration = Symbol('traffic-clear-generation');
    this._trafficClearRevision = 0;
    this._trafficPinRevision = 0;
    this.maxClearedPendingTrafficIds = Number.isSafeInteger(options.maxClearedPendingTrafficIds) &&
      options.maxClearedPendingTrafficIds > 0
      ? options.maxClearedPendingTrafficIds
      : this.maxTrafficLog;
    this.clearedPendingTrafficTtlMs = Number.isSafeInteger(options.clearedPendingTrafficTtlMs) &&
      options.clearedPendingTrafficTtlMs > 0
      ? options.clearedPendingTrafficTtlMs
      : 60 * 60 * 1000;
    this._clearedPendingTrafficNow = typeof options.clearedPendingTrafficNow === 'function'
      ? options.clearedPendingTrafficNow
      : () => performance.now();
    this.authToken = options.authToken || null;
    this.onShutdown = options.onShutdown || null;
    this.bottingToolsWorkDir = path.resolve(
      options.bottingToolsWorkDir || path.join(os.tmpdir(), 'http-freekit-bottingtools-proxies')
    );
    this.autoRotateProxy = { enabled: false, provider: 'lemonprime' };
    this._autoRotateInFlight = false;
    this._autoRotatePromise = null;
    this._lastAutoRotateAt = 0;
    this._mcpEnabledMutationQueue = Promise.resolve();
    this._mcpStateDegraded = null;
    this.sendConnectTimeoutMs = options.sendConnectTimeoutMs ?? 10000;
    this.sendIdleTimeoutMs = options.sendIdleTimeoutMs ?? 30000;
    this.sendTotalTimeoutMs = options.sendTotalTimeoutMs ?? 60000;
    this.sendMaxResponseBytes = options.sendMaxResponseBytes ?? 32 * 1024 * 1024;
    this.shutdownTimeoutMs = Number.isSafeInteger(options.shutdownTimeoutMs) && options.shutdownTimeoutMs > 0
      ? options.shutdownTimeoutMs
      : 1000;
    const managementRequestTimeoutMs = options.managementRequestTimeoutMs ??
      DEFAULT_MANAGEMENT_REQUEST_TIMEOUT_MS;
    this.managementRequestTimeoutMs = Number.isSafeInteger(managementRequestTimeoutMs) &&
      managementRequestTimeoutMs > 0 && managementRequestTimeoutMs <= 0x7fffffff
      ? managementRequestTimeoutMs
      : DEFAULT_MANAGEMENT_REQUEST_TIMEOUT_MS;
    const maxWsBufferedBytes = options.maxWsBufferedBytes ?? DEFAULT_MAX_WS_BUFFERED_BYTES;
    this.maxWsBufferedBytes = Number.isSafeInteger(maxWsBufferedBytes) && maxWsBufferedBytes >= 0
      ? maxWsBufferedBytes
      : DEFAULT_MAX_WS_BUFFERED_BYTES;

    // Wire up breakpoint broadcast so the UI gets real-time breakpoint events
    this.proxy.onBreakpoint = (event) => {
      this._broadcast(event);
    };
    this.proxy.onUpstreamProxyRetry = (event) => this._rotateProxyForTransparentRetry(event);

    if (this.interceptors) {
      this.interceptors.onStatusChange = (event) => {
        this._broadcast({ type: 'interceptor-status', data: event });
      };
    }

    this._setupMiddleware();
    this._setupRoutes();
  }

  _cloneConfigValue(value) {
    return value === undefined ? undefined : structuredClone(value);
  }

  _persistSettings(values) {
    if (!this.settings) return;
    const clonedValues = Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, this._cloneConfigValue(value)])
    );
    if (typeof this.settings.setAll === 'function') {
      this.settings.setAll(clonedValues);
      return;
    }
    // Settings always provides setAll. Keep the single-key-compatible fallback
    // for embedders and lightweight test doubles implementing the older shape.
    for (const [key, value] of Object.entries(clonedValues)) this.settings.set(key, value);
  }

  _runPersistedMutation({ capture, apply, persist, restore, shouldPersist = () => true }) {
    const previous = capture();
    try {
      const result = apply();
      if (shouldPersist(result)) persist(result);
      return result;
    } catch (error) {
      try {
        restore(previous);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `${error.message || 'Configuration mutation failed'}; rollback failed: ${rollbackError.message}`,
          { cause: error }
        );
      }
      throw error;
    }
  }

  _captureRuleCollection(property) {
    const reference = this.proxy[property];
    return { reference, value: this._cloneConfigValue(reference) };
  }

  _restoreRuleCollection(property, previous) {
    previous.reference.splice(
      0,
      previous.reference.length,
      ...this._cloneConfigValue(previous.value)
    );
    this.proxy[property] = previous.reference;
  }

  _mutateRules(property, settingKey, apply, shouldPersist) {
    return this._runPersistedMutation({
      capture: () => this._captureRuleCollection(property),
      apply,
      persist: () => this._persistSettings({ [settingKey]: this.proxy[property] }),
      restore: previous => this._restoreRuleCollection(property, previous),
      ...(shouldPersist ? { shouldPersist } : {})
    });
  }

  _mutateRuleCollections(apply) {
    return this._runPersistedMutation({
      capture: () => ({
        mockRules: this._captureRuleCollection('mockRules'),
        breakpointRules: this._captureRuleCollection('breakpointRules')
      }),
      apply,
      persist: () => this._persistSettings({
        mockRules: this.proxy.mockRules,
        breakpointRules: this.proxy.breakpointRules
      }),
      restore: previous => {
        this._restoreRuleCollection('mockRules', previous.mockRules);
        this._restoreRuleCollection('breakpointRules', previous.breakpointRules);
      }
    });
  }

  _mutateProxySetting({ property, settingKey = property, apply, restore, shouldPersist }) {
    return this._runPersistedMutation({
      capture: () => ({
        reference: this.proxy[property],
        value: this._cloneConfigValue(this.proxy[property])
      }),
      apply,
      persist: () => this._persistSettings({ [settingKey]: this.proxy[property] }),
      restore: previous => {
        restore(this._cloneConfigValue(previous.value));
        this.proxy[property] = previous.reference;
      },
      ...(shouldPersist ? { shouldPersist } : {})
    });
  }

  _captureUpstreamProxy() {
    return {
      reference: this.proxy.upstreamProxy,
      value: this._cloneConfigValue(this.proxy.upstreamProxy),
      generation: this.proxy.getUpstreamProxyGeneration?.()
    };
  }

  _restoreUpstreamProxy(previous) {
    this.proxy.setUpstreamProxy(this._cloneConfigValue(previous.value));
    this.proxy.upstreamProxy = previous.reference;
    if (previous.generation !== undefined && '_upstreamProxyGeneration' in this.proxy) {
      this.proxy._upstreamProxyGeneration = previous.generation;
    }
  }

  _setUpstreamProxy(config) {
    return this._runPersistedMutation({
      capture: () => this._captureUpstreamProxy(),
      apply: () => this.proxy.setUpstreamProxy(config),
      persist: () => this._persistSettings({ upstreamProxy: this.proxy.upstreamProxy }),
      restore: previous => this._restoreUpstreamProxy(previous)
    });
  }

  _execBottingToolsPythonJson(candidate, script, args = [], options = {}) {
    return new Promise((resolve, reject) => {
      execFile(candidate.command, [...candidate.args, '-c', script, ...args], {
        timeout: 30000,
        windowsHide: true,
        ...(options.cwd ? { cwd: options.cwd } : {})
      }, (error, stdout, stderr) => {
        if (error) {
          const message = (stderr || stdout || error.message).trim();
          reject(new Error(message || error.message));
          return;
        }

        const lines = stdout.split(/\r?\n/)
          .map(line => line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').trim())
          .filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          const objectStart = lines[i].indexOf('{');
          const objectEnd = lines[i].lastIndexOf('}');
          const jsonText = objectStart >= 0 && objectEnd > objectStart
            ? lines[i].slice(objectStart, objectEnd + 1)
            : lines[i];
          try {
            resolve(JSON.parse(jsonText));
            return;
          } catch {}
        }

        reject(new Error('BottingTools did not return JSON output.'));
      });
    });
  }

  async _setMcpEnabled(enabled) {
    if (!this.mcpBridge) throw new Error('MCP bridge not initialized');
    const previousEnabled = this.mcpBridge.getStatus().enabled === true;
    const persistedEnabled = this._mcpStateDegraded?.persistedEnabled ?? previousEnabled;

    try {
      await this.mcpBridge.setEnabled(enabled);
      if (enabled) this.mcpBridge.startSse(this.app);
      const appliedStatus = this.mcpBridge.getStatus();
      if ((appliedStatus.enabled === true) !== enabled) {
        throw new Error('MCP bridge did not apply the requested enabled state');
      }
      if (appliedStatus.degraded === true) {
        throw new Error(
          `MCP bridge remains degraded: ${appliedStatus.degradedReason || 'cleanup is incomplete'}`
        );
      }
      this._persistSettings({ [MCP_ENABLED_SETTING]: enabled });
      this._mcpStateDegraded = null;
      return enabled;
    } catch (error) {
      let rollbackError = null;
      try {
        await this.mcpBridge.setEnabled(previousEnabled);
        if (previousEnabled) this.mcpBridge.startSse(this.app);
      } catch (caughtRollbackError) {
        rollbackError = caughtRollbackError;
      }

      let rollbackStatus = null;
      let rollbackStatusError = null;
      try {
        rollbackStatus = this.mcpBridge.getStatus();
      } catch (caughtStatusError) {
        rollbackStatusError = caughtStatusError;
      }

      const rollbackProblems = [];
      if (rollbackError) rollbackProblems.push(rollbackError);
      if (rollbackStatusError) {
        rollbackProblems.push(rollbackStatusError);
      } else if ((rollbackStatus.enabled === true) !== previousEnabled) {
        rollbackProblems.push(new Error(
          `MCP rollback left runtime enabled=${rollbackStatus.enabled === true}; ` +
          `persisted state remains enabled=${persistedEnabled}`
        ));
      } else if (rollbackStatus.degraded === true) {
        rollbackProblems.push(new Error(
          `MCP rollback is degraded: ${rollbackStatus.degradedReason || 'cleanup is incomplete'}`
        ));
      }

      const rollbackIsDegraded = rollbackStatusError ||
        (rollbackStatus && (
          (rollbackStatus.enabled === true) !== previousEnabled ||
          rollbackStatus.degraded === true
        ));
      if (rollbackIsDegraded) {
        this._mcpStateDegraded = {
          persistedEnabled,
          runtimeEnabled: rollbackStatus ? rollbackStatus.enabled === true : null,
          reason: rollbackProblems.map(problem => problem.message).join('; ')
        };
      }

      if (rollbackProblems.length > 0) {
        throw new AggregateError(
          [error, ...rollbackProblems],
          `${error.message || 'MCP state change failed'}; ` +
          `rollback failed: ${rollbackProblems.map(problem => problem.message).join('; ')}`,
          { cause: error }
        );
      }
      throw error;
    }
  }

  _queueMcpEnabledMutation(enabled) {
    const operation = this._mcpEnabledMutationQueue.then(() => this._setMcpEnabled(enabled));
    this._mcpEnabledMutationQueue = operation.catch(() => {});
    return operation;
  }

  _getMcpStatus() {
    if (!this.mcpBridge) {
      return { enabled: false, sseEndpoint: null, connectedClients: 0 };
    }
    const status = { ...this.mcpBridge.getStatus() };
    if (!this._mcpStateDegraded) return status;

    const reasons = [status.degradedReason, this._mcpStateDegraded.reason].filter(Boolean);
    status.degraded = true;
    status.degradedReason = reasons.join('; ');
    status.persistedEnabled = this._mcpStateDegraded.persistedEnabled;
    return status;
  }

  async _runPythonJson(script, args = [], options = {}) {
    const candidates = this._getBottingToolsPythonCandidates();
    const errors = [];
    for (const candidate of candidates) {
      try {
        return await this._execBottingToolsPythonJson(candidate, script, args, options);
      } catch (error) {
        errors.push(`${this._formatCommand(candidate)}: ${error.message}`);
      }
    }
    throw new Error(`Could not run BottingTools Python. Tried ${errors.join('; ')}`);
  }

  async _getBottingToolsProxy(provider = 'lemonprime', refill = true) {
    const normalizedProvider = String(provider || 'lemonprime');
    const queueKey = crypto.createHash('sha256').update(normalizedProvider).digest('hex');
    const queueDir = path.join(this.bottingToolsWorkDir, queueKey);
    await fs.mkdir(queueDir, { recursive: true });
    const script = `
import json
import sys
from bottingtools import get_proxy

provider = sys.argv[1] or "lemonprime"
refill = sys.argv[2].lower() == "true"
proxy = get_proxy(provider=provider, refill=refill)
auth = None
if proxy.username is not None and proxy.password is not None:
    auth = f"{proxy.username}:{proxy.password}"
print(json.dumps({
    "provider": provider,
    "host": proxy.ip,
    "port": int(proxy.port),
    "auth": auth,
    "type": "http",
    "raw": str(proxy),
}))
`;
    return this._runPythonJson(
      script,
      [normalizedProvider, refill ? 'true' : 'false'],
      { cwd: queueDir }
    );
  }

  async _getBottingToolsProviders() {
    const script = `
import json
from bottingtools import get_proxy_providers
print(json.dumps({"providers": get_proxy_providers()}))
`;
    return this._runPythonJson(script);
  }

  _getAutoRotateProxyConfig() {
    const saved = this.settings?.get('autoRotateProxyOnError');
    return {
      enabled: !!saved?.enabled,
      provider: saved?.provider || this.autoRotateProxy.provider || 'lemonprime'
    };
  }

  _setAutoRotateProxyConfig(config = {}) {
    return this._runPersistedMutation({
      capture: () => ({
        reference: this.autoRotateProxy
      }),
      apply: () => {
        this.autoRotateProxy = {
          enabled: !!config.enabled,
          provider: String(config.provider || 'lemonprime').trim() || 'lemonprime'
        };
        return this.autoRotateProxy;
      },
      persist: () => this._persistSettings({ autoRotateProxyOnError: this.autoRotateProxy }),
      restore: previous => { this.autoRotateProxy = previous.reference; }
    });
  }

  async _rotateBottingToolsProxy(provider, refill = true, { persistProvider = false } = {}) {
    const startingGeneration = this.proxy.getUpstreamProxyGeneration?.();
    const proxy = await this._getBottingToolsProxy(provider, refill);
    const currentGeneration = this.proxy.getUpstreamProxyGeneration?.();
    if (startingGeneration !== undefined && currentGeneration !== startingGeneration) {
      return {
        applied: false,
        provider: proxy.provider,
        upstreamProxy: this.proxy.upstreamProxy
      };
    }
    const upstreamProxy = {
      host: proxy.host,
      port: proxy.port,
      auth: proxy.auth || null,
      type: proxy.type || 'http',
      noProxy: this.proxy.upstreamProxy?.noProxy || []
    };
    this._runPersistedMutation({
      capture: () => ({
        upstreamProxy: this._captureUpstreamProxy(),
        autoRotateProxy: {
          reference: this.autoRotateProxy
        }
      }),
      apply: () => {
        this.proxy.setUpstreamProxy(upstreamProxy);
        if (persistProvider) {
          this.autoRotateProxy = {
            ...this._getAutoRotateProxyConfig(),
            provider: proxy.provider
          };
        }
      },
      persist: () => this._persistSettings({
        upstreamProxy: this.proxy.upstreamProxy,
        ...(persistProvider ? { autoRotateProxyOnError: this.autoRotateProxy } : {})
      }),
      restore: previous => {
        this._restoreUpstreamProxy(previous.upstreamProxy);
        this.autoRotateProxy = previous.autoRotateProxy.reference;
      }
    });
    return { applied: true, provider: proxy.provider, upstreamProxy: this.proxy.upstreamProxy };
  }

  _maybeAutoRotateProxyOnError(data) {
    const config = this._getAutoRotateProxyConfig();
    const reason = this._getAutoRotateProxyReason(data);
    if (!config.enabled || !this.proxy.upstreamProxy || !reason || data?.usedUpstreamProxy === false) return;

    const currentGeneration = this.proxy.getUpstreamProxyGeneration?.();
    if (data?.upstreamProxyGeneration !== undefined &&
        currentGeneration !== undefined &&
        data.upstreamProxyGeneration !== currentGeneration) return;

    const now = Date.now();
    if (this._autoRotateInFlight || now - this._lastAutoRotateAt < 10000) return;

    this._autoRotateInFlight = true;
    this._lastAutoRotateAt = now;
    this._broadcast({ type: 'proxy-auto-rotate', status: 'started', provider: config.provider, reason });

    this._autoRotatePromise = this._rotateBottingToolsProxy(config.provider, true)
      .then(result => {
        if (result.applied === false) {
          this._broadcast({
            type: 'proxy-auto-rotate',
            status: 'cancelled',
            provider: result.provider,
            upstreamProxy: result.upstreamProxy
          });
          return false;
        }
        this._broadcast({
          type: 'proxy-auto-rotate',
          status: 'success',
          provider: result.provider,
          upstreamProxy: result.upstreamProxy
        });
        return true;
      })
      .catch(err => {
        this._broadcast({
          type: 'proxy-auto-rotate',
          status: 'error',
          provider: config.provider,
          error: err.message
        });
      })
      .finally(() => {
        this._autoRotateInFlight = false;
        this._autoRotatePromise = null;
      });
  }

  async _rotateProxyForTransparentRetry(event = {}) {
    const config = this._getAutoRotateProxyConfig();
    if (!config.enabled || !this.proxy.upstreamProxy) return false;

    const failedGeneration = event.proxyGeneration;
    const currentGeneration = this.proxy.getUpstreamProxyGeneration?.();
    if (failedGeneration !== undefined &&
        currentGeneration !== undefined &&
        failedGeneration !== currentGeneration) return true;

    if (this._autoRotateInFlight && this._autoRotatePromise) {
      const rotated = await this._autoRotatePromise;
      const latestGeneration = this.proxy.getUpstreamProxyGeneration?.();
      return rotated || (failedGeneration !== undefined && latestGeneration !== failedGeneration);
    }

    if (Date.now() - this._lastAutoRotateAt < 10000) return false;

    this._autoRotateInFlight = true;
    this._lastAutoRotateAt = Date.now();
    this._broadcast({
      type: 'proxy-auto-rotate',
      status: 'started',
      provider: config.provider,
      reason: event.reason || 'upstream proxy error',
      transparent: true
    });

    this._autoRotatePromise = this._rotateBottingToolsProxy(config.provider, true)
      .then(result => {
        if (result.applied === false) {
          this._broadcast({
            type: 'proxy-auto-rotate',
            status: 'cancelled',
            provider: result.provider,
            upstreamProxy: result.upstreamProxy,
            transparent: true
          });
          const latestGeneration = this.proxy.getUpstreamProxyGeneration?.();
          return failedGeneration !== undefined && latestGeneration !== failedGeneration;
        }
        this._broadcast({
          type: 'proxy-auto-rotate',
          status: 'success',
          provider: result.provider,
          upstreamProxy: result.upstreamProxy,
          transparent: true
        });
        return true;
      })
      .catch(err => {
        this._broadcast({
          type: 'proxy-auto-rotate',
          status: 'error',
          provider: config.provider,
          error: err.message,
          transparent: true
        });
        return false;
      })
      .finally(() => {
        this._autoRotateInFlight = false;
        this._autoRotatePromise = null;
      });

    return await this._autoRotatePromise;
  }

  _getAutoRotateProxyReason(data) {
    if (data?.statusCode === 410) return '410 Gone';

    const errorText = `${data?.error || ''}\n${data?.responseBody || ''}\n${data?.statusMessage || ''}`;
    if (/request timeout after 30s|upstream (?:connection|response) timeout/i.test(errorText)) {
      return 'request timeout';
    }
    if (['ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH',
      'ENETDOWN', 'ENETUNREACH', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN'].includes(data?.errorCode) ||
      /client network socket disconnected before secure tls connection was established|socket hang up/i.test(errorText)) {
      return 'proxy connection failure';
    }

    return null;
  }

  _isTunnelRequest(req) {
    return req?.protocol === 'tunnel' || req?.method === 'CONNECT';
  }

  _getTrafficListsConfig() {
    const savedLists = this.settings?.get('trafficLists');
    if (savedLists !== undefined) {
      try {
        return { lists: normalizeTrafficLists(savedLists) };
      } catch {}
    }

    const enabled = this.settings?.get('defaultExclusionsEnabled', true) !== false;
    const savedPatterns = this.settings?.get('defaultExclusions', DEFAULT_EXCLUSIONS);
    let patterns;
    try {
      patterns = normalizeDefaultExclusions(savedPatterns);
    } catch {
      patterns = [...DEFAULT_EXCLUSIONS];
    }
    return { lists: [createDefaultTrafficList({ enabled, patterns })] };
  }

  _getDefaultExclusionsConfig() {
    const list = this._getTrafficListsConfig().lists.find(
      candidate => candidate.id === DEFAULT_TRAFFIC_LIST_ID
    ) || createDefaultTrafficList();
    return { enabled: list.enabled, patterns: [...list.patterns] };
  }

  _trafficListsPersistenceValues(lists) {
    const defaultList = lists.find(list => list.id === DEFAULT_TRAFFIC_LIST_ID);
    return {
      trafficLists: lists.map(({ builtIn, ...list }) => ({ ...list, patterns: [...list.patterns] })),
      defaultExclusionsEnabled: defaultList.enabled,
      defaultExclusions: [...defaultList.patterns]
    };
  }

  _getTrafficWithListsApplied() {
    const { lists } = this._getTrafficListsConfig();
    return filterTrafficLists(this.trafficLog, lists);
  }

  _getTrafficWithoutDefaultExclusions() {
    return this._getTrafficWithListsApplied();
  }

  _getHarExportTraffic() {
    const hideTunnelRequests = this.settings?.get('hideTunnelRequests', true) !== false;
    const filterSafeFonts = this.settings?.get('filterSafeFonts', false) === true;
    return this._getTrafficWithoutDefaultExclusions().filter(req => {
      if (req?.protocol === 'ws-frame') return false;
      if (hideTunnelRequests && this._isTunnelRequest(req)) return false;
      if (filterSafeFonts && ['fonts.gstatic.com', 'fonts.googleapis.com'].includes(String(req?.host || '').toLowerCase())) return false;
      return true;
    });
  }

  _getTrafficImportValidationError(requests) {
    if (!Array.isArray(requests)) return 'requests must be an array';
    const textFields = [
      'id', 'method', 'url', 'host', 'path', 'requestBody', 'responseBody',
      'requestBodyEncoding', 'responseBodyEncoding', 'statusMessage', 'protocol', 'source',
      'parentId', 'trafficLifecycleId', 'parentTrafficLifecycleId'
    ];
    const bodySizeFields = [
      'requestBodySize', 'responseBodySize',
      'requestBodyDecodedSize', 'responseBodyDecodedSize'
    ];
    const capturedSizeFields = ['requestBodyCapturedSize', 'responseBodyCapturedSize'];
    const numberFields = ['statusCode', 'duration', ...bodySizeFields, ...capturedSizeFields];
    const booleanFields = [
      'requestBodyTruncated', 'responseBodyTruncated', 'breakpointActive', 'pinned'
    ];

    for (let index = 0; index < requests.length; index++) {
      const request = requests[index];
      if (!request || typeof request !== 'object' || Array.isArray(request)) {
        return `requests[${index}] must be an object`;
      }
      if (typeof request.id !== 'string' || !request.id) {
        return `requests[${index}].id must be a non-empty string`;
      }
      if (request.timestamp === undefined || !Number.isFinite(new Date(request.timestamp).getTime())) {
        return `requests[${index}].timestamp must be a valid date`;
      }
      for (const field of textFields) {
        if (request[field] !== undefined && request[field] !== null && typeof request[field] !== 'string') {
          return `requests[${index}].${field} must be a string`;
        }
      }
      for (const field of ['trafficLifecycleId', 'parentTrafficLifecycleId']) {
        if (request[field] === '') {
          return `requests[${index}].${field} must be non-empty when provided`;
        }
      }
      if (request.protocol === 'ws-frame' &&
          (typeof request.parentId !== 'string' || request.parentId.length === 0)) {
        return `requests[${index}].parentId must be a non-empty string for WebSocket frames`;
      }
      if (request.protocol === 'ws-frame' && request.pinned === true) {
        return `requests[${index}].pinned cannot be true for WebSocket frames`;
      }
      for (const field of numberFields) {
        if (request[field] !== undefined && request[field] !== null && !Number.isFinite(request[field])) {
          return `requests[${index}].${field} must be a finite number`;
        }
      }
      for (const field of booleanFields) {
        if (request[field] !== undefined && request[field] !== null
            && typeof request[field] !== 'boolean') {
          return `requests[${index}].${field} must be a boolean`;
        }
      }
      if (request.statusCode !== undefined && request.statusCode !== null &&
          (!Number.isInteger(request.statusCode) ||
           (request.statusCode !== 0 && (request.statusCode < 100 || request.statusCode > 999)))) {
        return `requests[${index}].statusCode must be 0 or an integer from 100 to 999`;
      }
      if (request.duration !== undefined && request.duration !== null && request.duration < 0) {
        return `requests[${index}].duration must be non-negative`;
      }
      for (const field of bodySizeFields) {
        if (request[field] !== undefined && request[field] !== null &&
            (!Number.isSafeInteger(request[field]) || request[field] < -1)) {
          return `requests[${index}].${field} must be a non-negative safe integer or -1 for an unknown size`;
        }
      }
      for (const field of capturedSizeFields) {
        if (request[field] !== undefined && request[field] !== null &&
            (!Number.isSafeInteger(request[field]) || request[field] < 0)) {
          return `requests[${index}].${field} must be a non-negative safe integer`;
        }
      }
      for (const side of ['request', 'response']) {
        const truncatedField = `${side}BodyTruncated`;
        const capturedField = `${side}BodyCapturedSize`;
        const decodedField = `${side}BodyDecodedSize`;
        const hasCaptured = request[capturedField] !== undefined
          && request[capturedField] !== null;
        const hasDecoded = request[decodedField] !== undefined
          && request[decodedField] !== null;
        if (request[truncatedField] === true && hasDecoded && !hasCaptured) {
          return `requests[${index}].${capturedField} must be provided when ${decodedField} is set`;
        }
        if (request[truncatedField] !== true && hasCaptured) {
          return `requests[${index}].${capturedField} requires ${truncatedField} to be true`;
        }
        if (request[truncatedField] === true && hasCaptured
            && request[decodedField] >= 0
            && request[capturedField] > request[decodedField]) {
          return `requests[${index}].${capturedField} cannot exceed ${decodedField}`;
        }
      }
      for (const field of ['requestBodyEncoding', 'responseBodyEncoding']) {
        if (request[field] !== undefined && request[field] !== null &&
            request[field] !== 'utf8' && request[field] !== 'base64') {
          return `requests[${index}].${field} must be utf8 or base64`;
        }
      }
      for (const field of ['requestHeaders', 'responseHeaders']) {
        const headers = request[field];
        if (headers === undefined || headers === null) continue;
        if (typeof headers !== 'object' || Array.isArray(headers)) {
          return `requests[${index}].${field} must be an object`;
        }
        for (const value of Object.values(headers)) {
          const valid = typeof value === 'string' ||
            (Array.isArray(value) && value.every(item => typeof item === 'string'));
          if (!valid) return `requests[${index}].${field} values must be strings or string arrays`;
        }
      }
      if (request.remote !== undefined && request.remote !== null) {
        if (typeof request.remote !== 'object' || Array.isArray(request.remote)) {
          return `requests[${index}].remote must be an object`;
        }
        if (request.remote.address !== undefined && request.remote.address !== null &&
            typeof request.remote.address !== 'string') {
          return `requests[${index}].remote.address must be a string`;
        }
        if (request.remote.port !== undefined && request.remote.port !== null &&
            (!Number.isInteger(request.remote.port) ||
             request.remote.port < 0 || request.remote.port > 65535)) {
          return `requests[${index}].remote.port must be an integer from 0 to 65535`;
        }
      }
      if (request.tls !== undefined && request.tls !== null) {
        if (typeof request.tls !== 'object' || Array.isArray(request.tls)) {
          return `requests[${index}].tls must be an object`;
        }
        for (const field of ['version', 'cipher']) {
          if (request.tls[field] !== undefined && request.tls[field] !== null &&
              typeof request.tls[field] !== 'string') {
            return `requests[${index}].tls.${field} must be a string`;
          }
        }
      }
    }

    const parentIds = new Set();
    const parentLifecycleIds = new Set();
    for (const rows of [this.trafficLog, requests]) {
      for (const request of rows) {
        if (request?.protocol !== 'ws' && request?.protocol !== 'wss') continue;
        parentIds.add(request.id);
        if (request.trafficLifecycleId) {
          parentLifecycleIds.add(JSON.stringify([request.id, request.trafficLifecycleId]));
        }
      }
    }
    for (let index = 0; index < requests.length; index++) {
      const request = requests[index];
      if (request.protocol !== 'ws-frame') continue;
      if (request.parentTrafficLifecycleId) {
        const parentKey = JSON.stringify([request.parentId, request.parentTrafficLifecycleId]);
        if (!parentLifecycleIds.has(parentKey)) {
          return `requests[${index}].parentTrafficLifecycleId does not match an imported or retained WebSocket parent`;
        }
      } else if (!parentIds.has(request.parentId)) {
        return `requests[${index}].parentId does not match an imported or retained WebSocket parent`;
      }
    }
    return null;
  }

  _sanitizeGeneratorSessionName(value) {
    const sanitized = String(value || '')
      .trim()
      .replace(/[^0-9A-Za-z_-]/g, '_')
      .replace(/^_+|_+$/g, '');
    return sanitized || `http-freekit-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  }

  _toHostPath(value) {
    const raw = String(value || '');
    if (process.platform !== 'win32') return raw;

    const match = raw.match(/^\/mnt\/([a-z])\/(.+)$/i);
    if (!match) return raw;

    return `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, '\\')}`;
  }

  _getGeneratorDir() {
    return this._toHostPath(process.env.GENERATOR_DIR || DEFAULT_GENERATOR_DIR);
  }

  _getPythonCandidates(configuredCommand, platform = process.platform) {
    if (configuredCommand) {
      return [{ command: configuredCommand, args: [] }];
    }

    if (platform === 'win32') {
      return [
        { command: 'py', args: ['-3'] },
        { command: 'python', args: [] },
        { command: 'python3', args: [] }
      ];
    }

    return [
      { command: 'python3', args: [] },
      { command: 'python', args: [] }
    ];
  }

  _getBottingToolsPythonCandidates() {
    return this._getPythonCandidates(process.env.BOTTINGTOOLS_PYTHON);
  }

  _getGeneratorPythonCandidates() {
    return this._getPythonCandidates(process.env.GENERATOR_PYTHON);
  }

  _getGeneratorLaunchPythonCandidates(pythonCandidates = this._getGeneratorPythonCandidates()) {
    if (process.platform !== 'win32') return pythonCandidates;

    const candidates = [];
    const seen = new Set();
    const addCandidate = (candidate) => {
      const key = `${candidate.command}\0${candidate.args.join('\0')}`;
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push(candidate);
      }
    };
    const toWindowedPython = (candidate) => {
      const command = String(candidate.command || '');
      const basename = path.basename(command).toLowerCase();
      const dirname = path.dirname(command);
      const hasDirectory = dirname && dirname !== '.';
      let windowedCommand = command;

      if (basename === 'py' || basename === 'py.exe') {
        windowedCommand = hasDirectory ? path.join(dirname, 'pyw.exe') : 'pyw';
      } else if (
        basename === 'python' ||
        basename === 'python.exe' ||
        basename === 'python3' ||
        basename === 'python3.exe'
      ) {
        windowedCommand = hasDirectory ? path.join(dirname, 'pythonw.exe') : 'pythonw';
      }

      return { command: windowedCommand, args: candidate.args };
    };

    for (const candidate of pythonCandidates) {
      addCandidate(toWindowedPython(candidate));
    }

    addCandidate({ command: 'pyw', args: ['-3'] });
    addCandidate({ command: 'pythonw', args: [] });
    return candidates;
  }

  _formatCommand(candidate) {
    return [candidate.command, ...candidate.args].join(' ');
  }

  async _getGeneratorHarBaseDir(generatorDir, pythonCandidates) {
    if (process.env.GENERATOR_HARS_DIR) {
      return this._toHostPath(process.env.GENERATOR_HARS_DIR);
    }

    const script = `
import json
import os
import sys

generator_dir = sys.argv[1]
os.chdir(generator_dir)
sys.path.insert(0, generator_dir)

import config
config.load_config()
print(json.dumps({"harsBaseDir": str(config.HARS_BASE_DIR)}))
`;
    const result = await this._runGeneratorPythonJson(script, [generatorDir], {
      cwd: generatorDir,
      candidates: pythonCandidates
    });
    return this._toHostPath(result.harsBaseDir);
  }

  _execGeneratorPythonJson(candidate, script, args = [], options = {}) {
    return new Promise((resolve, reject) => {
      execFile(candidate.command, [...candidate.args, '-c', script, ...args], {
        timeout: 30000,
        cwd: options.cwd,
        windowsHide: true
      }, (error, stdout, stderr) => {
        if (error) {
          const message = (stderr || stdout || error.message).trim();
          reject(new Error(message || error.message));
          return;
        }

        const lines = stdout.split(/\r?\n/)
          .map(line => line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').trim())
          .filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          const objectStart = lines[i].indexOf('{');
          const objectEnd = lines[i].lastIndexOf('}');
          const jsonText = objectStart >= 0 && objectEnd > objectStart
            ? lines[i].slice(objectStart, objectEnd + 1)
            : lines[i];
          try {
            resolve(JSON.parse(jsonText));
            return;
          } catch {}
        }

        reject(new Error('Generator did not return JSON output.'));
      });
    });
  }

  async _runGeneratorPythonJson(script, args = [], options = {}) {
    const candidates = options.candidates || this._getGeneratorPythonCandidates();
    const errors = [];

    for (const candidate of candidates) {
      try {
        return await this._execGeneratorPythonJson(candidate, script, args, options);
      } catch (err) {
        errors.push(`${this._formatCommand(candidate)}: ${err.message}`);
      }
    }

    throw new Error(`Could not run generator Python. Tried ${errors.join('; ')}`);
  }

  async _spawnGeneratorPython(pythonCandidates, args, options = {}) {
    const errors = [];

    for (const candidate of pythonCandidates) {
      try {
        await new Promise((resolve, reject) => {
          const child = spawn(candidate.command, [...candidate.args, ...args], {
            cwd: options.cwd,
            detached: true,
            stdio: 'ignore',
            windowsHide: true
          });
          child.once('error', reject);
          child.once('spawn', () => {
            child.unref();
            resolve();
          });
        });
        return;
      } catch (err) {
        errors.push(`${this._formatCommand(candidate)}: ${err.message}`);
      }
    }

    throw new Error(`Could not launch generator. Tried ${errors.join('; ')}`);
  }

  async _reserveGeneratorSession(harBaseDir) {
    await fs.mkdir(harBaseDir, { recursive: true });
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    const prefix = this._sanitizeGeneratorSessionName(`http-freekit-${timestamp}`);
    const sessionDir = await fs.mkdtemp(path.join(harBaseDir, `${prefix}-`));
    return {
      sessionDir,
      sessionName: path.basename(sessionDir)
    };
  }

  async _cleanupGeneratorSession(sessionDir, harBaseDir) {
    const resolvedSessionDir = path.resolve(sessionDir);
    if (path.dirname(resolvedSessionDir) !== path.resolve(harBaseDir)) return;
    await fs.rm(resolvedSessionDir, { recursive: true, force: true });
  }

  async _exportToGenerator() {
    const generatorDir = this._getGeneratorDir();
    const pythonCandidates = this._getGeneratorPythonCandidates();
    const harBaseDir = await this._getGeneratorHarBaseDir(generatorDir, pythonCandidates);
    const har = trafficToHar(this._getHarExportTraffic(), { maskSensitive: false });
    const { sessionDir, sessionName } = await this._reserveGeneratorSession(harBaseDir);
    const harPath = path.join(sessionDir, `${sessionName}.har`);

    try {
      await fs.writeFile(harPath, JSON.stringify(har, null, 2), 'utf8');

      await this._spawnGeneratorPython(
        this._getGeneratorLaunchPythonCandidates(pythonCandidates),
        ['main_app.py', '--session', sessionName],
        { cwd: generatorDir }
      );
    } catch (err) {
      try {
        await this._cleanupGeneratorSession(sessionDir, harBaseDir);
      } catch {}
      throw err;
    }

    return {
      sessionName,
      harPath,
      requestCount: har.log.entries.length
    };
  }

  _isAllowedBrowserOrigin(origin) {
    if (!origin) return true;
    try {
      const parsed = new URL(origin);
      const isLoopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
      return isLoopback && parsed.port === String(this.port);
    } catch {
      return false;
    }
  }

  _isValidAuthToken(value) {
    if (!this.authToken || typeof value !== 'string') return !this.authToken;
    const actual = Buffer.from(value);
    const expected = Buffer.from(this.authToken);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }

  _isAuthorizedRequest(req) {
    if (!this.authToken) return true;
    const authorization = req.headers?.authorization || '';
    const bearerToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : null;
    let queryToken = null;
    try {
      queryToken = new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('authToken');
    } catch {}
    return this._isValidAuthToken(bearerToken) || this._isValidAuthToken(queryToken);
  }

  _setupMiddleware() {
    // CORS
    this.app.use((req, res, next) => {
      const origin = req.get('origin');
      if (origin && !this._isAllowedBrowserOrigin(origin)) {
        return res.status(403).json({ error: 'Forbidden origin' });
      }
      if (origin) {
        res.header('Access-Control-Allow-Origin', origin);
        res.header('Vary', 'Origin');
      }
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.header('Access-Control-Max-Age', '86400');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    });

    this.app.use('/api', (req, res, next) => {
      if (!this._isAuthorizedRequest(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      next();
    });

    // Install the idle timeout before body parsing so incomplete uploads cannot
    // occupy an authenticated management connection indefinitely.
    this.app.use((req, res, next) => {
      req.setTimeout(this.managementRequestTimeoutMs, () => req.destroy());
      next();
    });

    this.app.use(express.json({ limit: '50mb' }));
  }

  _setupRoutes() {
    const router = express.Router();
    registerConfigurationRoutes(router, this);

    // Proxy stats
    router.get('/api/stats', (req, res) => {
      res.json({
        proxy: this.proxy.getStats(),
        traffic: {
          total: this._getTrafficWithoutDefaultExclusions().length,
          clients: this.clients.size,
          capturePaused: this.capturePaused
        }
      });
    });

    // Traffic log
    router.get('/api/traffic', (req, res) => {
      const parsePaginationValue = (value, fallback) => {
        if (value === undefined) return fallback;
        if (!/^\d+$/.test(String(value))) return null;
        const parsed = Number(value);
        return Number.isSafeInteger(parsed) ? parsed : null;
      };
      const limit = parsePaginationValue(req.query.limit, 100);
      const offset = parsePaginationValue(req.query.offset, 0);
      if (limit === null || offset === null) {
        return res.status(400).json({ error: 'limit and offset must be non-negative integers' });
      }
      const filter = req.query.filter || '';

      const visibleTraffic = this._getTrafficWithoutDefaultExclusions();
      let filtered = visibleTraffic;
      if (filter) {
        const lowerFilter = filter.toLowerCase();
        filtered = visibleTraffic.filter(r =>
          r.url?.toLowerCase().includes(lowerFilter) ||
          r.method?.toLowerCase().includes(lowerFilter) ||
          r.host?.toLowerCase().includes(lowerFilter) ||
          String(r.statusCode).includes(lowerFilter)
        );
      }

      res.json({
        total: filtered.length,
        requests: filtered.slice(offset, offset + limit)
      });
    });

    router.get('/api/traffic/capture', (req, res) => {
      res.json({
        paused: this.capturePaused,
        sessionId: this.captureStateSessionId,
        revision: this.captureStateRevision
      });
    });

    router.put('/api/traffic/capture', (req, res) => {
      if (typeof req.body?.paused !== 'boolean') {
        return res.status(400).json({ error: 'paused must be a boolean' });
      }
      this._setCapturePaused(req.body.paused);
      res.json({
        success: true,
        paused: this.capturePaused,
        sessionId: this.captureStateSessionId,
        revision: this.captureStateRevision
      });
    });

    // Clear traffic
    router.post('/api/traffic/clear', (req, res) => {
      const result = this._clearTraffic();
      res.json({ success: true, ...result });
    });

    // Export traffic (JSON)
    router.get('/api/traffic/export', (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename=http-freekit-export.json');
      res.json({
        exported: new Date().toISOString(),
        tool: 'HTTP FreeKit',
        version: '1.0.0',
        requests: this._getTrafficWithoutDefaultExclusions()
      });
    });

    // Export as HAR into the external generator app and launch it with the new session selected
    router.post('/api/traffic/export-generator', async (req, res) => {
      try {
        const result = await this._exportToGenerator();
        res.json({ success: true, ...result });
      } catch (err) {
        res.status(500).json({
          success: false,
          error: err.message || 'Failed to export HAR to generator'
        });
      }
    });

    // Export as HAR (must be before :id param route)
    router.get('/api/traffic/export.har', (req, res) => {
      const har = trafficToHar(this._getHarExportTraffic(), { maskSensitive: false });
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename=http-freekit-export.har');
      res.json(har);
    });

    // Advanced traffic search
    router.get('/api/traffic/search', (req, res) => {
      const { method, status, host, path: pathFilter, source } = req.query;

      let results = this._getTrafficWithoutDefaultExclusions();

      if (method) results = results.filter(r => r.method?.toUpperCase() === method.toUpperCase());
      if (status) {
        const statusNum = parseInt(status);
        if (status.endsWith('xx')) {
          const base = parseInt(status[0]) * 100;
          results = results.filter(r => r.statusCode >= base && r.statusCode < base + 100);
        } else {
          results = results.filter(r => r.statusCode === statusNum);
        }
      }
      if (host) results = results.filter(r => r.host?.includes(host));
      if (pathFilter) results = results.filter(r => r.path?.includes(pathFilter));
      if (source) results = results.filter(r => r.source === source);

      res.json({ total: results.length, requests: results });
    });

    // Single request detail (after specific routes to avoid matching "export.har" as :id)
    router.get('/api/traffic/:id', (req, res) => {
      const lifecycleProvided = Object.hasOwn(req.query, 'trafficLifecycleId');
      if (lifecycleProvided &&
          (typeof req.query.trafficLifecycleId !== 'string' || !req.query.trafficLifecycleId)) {
        return res.status(400).json({ error: 'trafficLifecycleId must be a non-empty string' });
      }
      const candidates = this.trafficLog.filter(request =>
        request.id === req.params.id &&
        (!lifecycleProvided || request.trafficLifecycleId === req.query.trafficLifecycleId)
      );
      if (candidates.length === 0) return res.status(404).json({ error: 'Request not found' });
      if (candidates.length > 1) {
        return res.status(409).json({
          error: lifecycleProvided
            ? 'Multiple requests have this traffic identity'
            : 'Multiple request lifecycles have this ID; provide trafficLifecycleId'
        });
      }
      res.json(candidates[0]);
    });

    router.put('/api/traffic/:id/pin', (req, res) => {
      if (typeof req.body?.pinned !== 'boolean') {
        return res.status(400).json({ error: 'pinned must be a boolean' });
      }
      const lifecycleProvided = Object.hasOwn(req.query, 'trafficLifecycleId');
      if (lifecycleProvided &&
          (typeof req.query.trafficLifecycleId !== 'string' || !req.query.trafficLifecycleId)) {
        return res.status(400).json({ error: 'trafficLifecycleId must be a non-empty string' });
      }

      const candidates = this.trafficLog.filter(request =>
        request.id === req.params.id &&
        (!lifecycleProvided || request.trafficLifecycleId === req.query.trafficLifecycleId)
      );
      if (candidates.length === 0) {
        return res.status(404).json({ error: 'Request not found' });
      }
      if (candidates.length > 1) {
        return res.status(409).json({
          error: lifecycleProvided
            ? 'Multiple requests have this traffic identity'
            : 'Multiple request lifecycles have this ID; provide trafficLifecycleId'
        });
      }

      const request = candidates[0];
      if (req.body.pinned && request.protocol === 'ws-frame') {
        return res.status(400).json({
          error: 'WebSocket frames cannot be pinned; pin the parent connection instead'
        });
      }
      request.pinned = req.body.pinned;
      const pin = {
        requestId: request.id,
        trafficLifecycleId: request.trafficLifecycleId ?? null,
        pinned: request.pinned,
        revision: ++this._trafficPinRevision
      };
      this._broadcast({ type: 'traffic-pinned', ...pin });
      res.json({ success: true, ...pin });
    });

    router.delete('/api/traffic/:id', (req, res) => {
      const lifecycleProvided = Object.hasOwn(req.query, 'trafficLifecycleId');
      if (lifecycleProvided &&
          (typeof req.query.trafficLifecycleId !== 'string' || !req.query.trafficLifecycleId)) {
        return res.status(400).json({ error: 'trafficLifecycleId must be a non-empty string' });
      }

      const candidates = this.trafficLog.filter(request =>
        request.id === req.params.id &&
        (!lifecycleProvided || request.trafficLifecycleId === req.query.trafficLifecycleId)
      );
      if (candidates.length === 0) {
        return res.status(404).json({ error: 'Request not found' });
      }
      if (candidates.length > 1) {
        return res.status(409).json({
          error: lifecycleProvided
            ? 'Multiple requests have this traffic identity'
            : 'Multiple request lifecycles have this ID; provide trafficLifecycleId'
        });
      }

      const request = candidates[0];
      const trafficLifecycleId = request.trafficLifecycleId ?? null;
      const webSocketConnection = request.protocol === 'ws' || request.protocol === 'wss';
      const isMatchingFrame = row => webSocketConnection &&
        row.protocol === 'ws-frame' &&
        row.parentId === request.id &&
        (row.parentTrafficLifecycleId ?? null) === trafficLifecycleId;
      const removed = this.trafficLog.reduce(
        (count, row) => count + (row === request || isMatchingFrame(row) ? 1 : 0),
        0
      );
      this.trafficLog = this.trafficLog.filter(row => row !== request && !isMatchingFrame(row));

      const identityKey = this._trafficIdentityKey(request.id, trafficLifecycleId);
      this._retainedTrafficGenerations.delete(identityKey);
      const expiresAt = this._activeTrafficIdentities.has(identityKey)
        ? Infinity
        : this._clearedPendingTrafficNow() + this.clearedPendingTrafficTtlMs;
      this._deletedTrafficIdentities.delete(identityKey);
      this._deletedTrafficIdentities.set(identityKey, expiresAt);
      this._pruneDeletedTrafficIdentities();

      const deletion = {
        requestId: request.id,
        trafficLifecycleId,
        webSocketConnection,
        removed
      };
      this._broadcast({ type: 'traffic-deleted', ...deletion });
      res.json({ success: true, ...deletion });
    });

    // Import traffic
    router.post('/api/traffic/import', (req, res) => {
      try {
        const { requests } = req.body;
        const validationError = this._getTrafficImportValidationError(requests);
        if (validationError) {
          return res.status(400).json({ error: `Invalid import format: ${validationError}` });
        }
        const retainedRequests = this._appendImportedTraffic(requests);
        this._broadcastImportedTraffic(retainedRequests, requests.length);
        res.json({ success: true, imported: requests.length });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    });

    // Import HAR file
    router.post('/api/traffic/import-har', (req, res) => {
      try {
        const har = req.body;
        if (!har?.log?.entries) {
          return res.status(400).json({ error: 'Invalid HAR format: missing log.entries' });
        }
        if (!Array.isArray(har.log.entries)) {
          return res.status(400).json({ error: 'Invalid HAR format: log.entries must be an array' });
        }

        const importTimestamp = Date.now();
        const imported = har.log.entries.map(entry => {
          let host, pathname, search;
          try {
            const parsed = new URL(entry.request.url);
            host = parsed.hostname;
            pathname = parsed.pathname;
            search = parsed.search;
          } catch {
            host = '';
            pathname = entry.request.url;
            search = '';
          }
          const parsedTimestamp = entry.startedDateTime === null || entry.startedDateTime === undefined
            ? NaN
            : new Date(entry.startedDateTime).getTime();
          const requestBody = harBodyToTraffic(entry.request.postData);
          const responseBody = harBodyToTraffic(entry.response?.content);
          const requestTruncation = harTruncationToTraffic(
            entry.request.postData,
            'request.postData'
          );
          const responseTruncation = harTruncationToTraffic(
            entry.response?.content,
            'response.content'
          );
          const responseBodyDecodedSize = responseTruncation?.originalSize
            ?? (entry.response?.content?.size === undefined
              ? undefined
              : normalizeHarBodySize(entry.response.content.size));

          return {
            id: crypto.randomUUID(),
            protocol: /^HTTP\/2(?:\.\d+)?$/i.test(entry.request.httpVersion || '')
              ? 'h2'
              : entry.request.url?.toLowerCase().startsWith('https') ? 'https' : 'http',
            method: entry.request.method || 'GET',
            url: entry.request.url || '',
            host,
            path: pathname + search,
            requestHeaders: harHeadersToObject(entry.request.headers),
            requestBody: requestBody.body,
            requestBodyEncoding: requestBody.encoding,
            requestCookies: Array.isArray(entry.request.cookies) ? entry.request.cookies : [],
            requestPostDataParams: Array.isArray(entry.request.postData?.params)
              ? entry.request.postData.params
              : undefined,
            requestPostDataMimeType: entry.request.postData?.mimeType || '',
            requestHttpVersion: entry.request.httpVersion || '',
            requestBodySize: normalizeHarBodySize(entry.request.bodySize),
            ...(requestTruncation ? {
              requestBodyTruncated: true,
              requestBodyCapturedSize: requestTruncation.capturedSize,
              requestBodyDecodedSize: requestTruncation.originalSize
            } : {}),
            statusCode: entry.response?.status || 0,
            statusMessage: entry.response?.statusText || '',
            responseHeaders: harHeadersToObject(entry.response?.headers),
            responseBody: responseBody.body,
            responseBodyEncoding: responseBody.encoding,
            responseCookies: Array.isArray(entry.response?.cookies) ? entry.response.cookies : [],
            responseContentMimeType: entry.response?.content?.mimeType || '',
            responseHttpVersion: entry.response?.httpVersion || '',
            responseBodySize: normalizeHarBodySize(entry.response?.bodySize),
            ...(responseBodyDecodedSize === undefined ? {} : { responseBodyDecodedSize }),
            ...(responseTruncation ? {
              responseBodyTruncated: true,
              responseBodyCapturedSize: responseTruncation.capturedSize
            } : {}),
            duration: entry.time || 0,
            timestamp: Number.isFinite(parsedTimestamp) ? parsedTimestamp : importTimestamp,
            source: 'import'
          };
        });

        const validationError = this._getTrafficImportValidationError(imported);
        if (validationError) {
          return res.status(400).json({ error: `Invalid HAR format: ${validationError}` });
        }
        const retainedRequests = this._appendImportedTraffic(imported);
        this._broadcastImportedTraffic(retainedRequests, imported.length);
        res.json({ success: true, imported: imported.length });
      } catch (err) {
        res.status(400).json({ error: 'Failed to parse HAR: ' + err.message });
      }
    });

    // Interceptors
    router.get('/api/interceptors', async (req, res) => {
      try {
        const interceptors = await this.interceptors.getAll();
        res.json({ interceptors });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    router.post('/api/interceptors/:id/activate', async (req, res) => {
      try {
        const result = await this.interceptors.activate(req.params.id, this.proxy.port, req.body);
        res.status(result?.success === false ? 422 : 200).json(result);
      } catch (err) {
        res.status(interceptorOperationErrorStatus(err, 500)).json({ error: err.message });
      }
    });

    router.post('/api/interceptors/:id/deactivate', async (req, res) => {
      try {
        await this.interceptors.deactivate(req.params.id, req.body || {});
        res.json({ success: true });
      } catch (err) {
        res.status(interceptorOperationErrorStatus(err, 500)).json({
          error: err.message,
          ...(err?.code === 'ANDROID_CA_REMOVAL_CONFIRMATION_REQUIRED'
            ? {
                code: err.code,
                deviceIds: err.deviceIds,
                settingsOpened: err.settingsOpened
              }
            : {})
        });
      }
    });

    router.post('/api/interceptors/:id/focus', async (req, res) => {
      try {
        const result = await this.interceptors.focus(req.params.id);
        res.json({ success: true, ...(result || {}) });
      } catch (err) {
        res.status(interceptorOperationErrorStatus(err, 500)).json({ error: err.message });
      }
    });

    // Open a URL in an isolated proxied browser, launching it if necessary.
    // The Electron build protects this action with its per-session token.
    router.post('/api/interceptors/:id/open', async (req, res) => {
      if (this.authToken && req.get('authorization') !== `Bearer ${this.authToken}`) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      try {
        const result = await this.interceptors.openUrl(
          req.params.id,
          this.proxy.port,
          req.body?.url
        );
        res.json({ success: true, ...(result || {}) });
      } catch (err) {
        res.status(interceptorOperationErrorStatus(err, 400)).json({ error: err.message });
      }
    });

    // Mock rules
    router.get('/api/mock-rules', (req, res) => {
      res.json({ rules: this.proxy.mockRules });
    });

    // Version 2 rule backups contain both persisted rule collections. Validate
    // both completely before replacing either, then save them in one settings
    // transaction so mixed imports cannot partially commit.
    router.put('/api/rules', (req, res) => {
      if (!Array.isArray(req.body?.mockRules) || !Array.isArray(req.body?.breakpointRules)) {
        return res.status(400).json({ error: 'mockRules and breakpointRules arrays are required' });
      }
      const mode = req.body.mode === undefined ? 'replace' : req.body.mode;
      if (mode !== 'replace' && mode !== 'append') {
        return res.status(400).json({ error: 'mode must be replace or append' });
      }

      const importedMockRules = req.body.mockRules.map(rule => normalizeImportedMockRule(rule));
      if (importedMockRules.some(rule => !rule)) {
        return res.status(400).json({ error: 'Every imported mock rule must be valid' });
      }

      const importedBreakpointRules = req.body.breakpointRules.map(rule =>
        normalizeImportedBreakpointRule(rule));
      if (importedBreakpointRules.some(rule => !rule)) {
        return res.status(400).json({ error: 'Every imported breakpoint rule must be valid' });
      }
      const breakpointValidationError = importedBreakpointRules
        .map(rule => this.proxy.validateBreakpointRule(rule))
        .find(Boolean);
      if (breakpointValidationError) {
        return res.status(400).json({ error: breakpointValidationError });
      }

      const nextMockRules = mode === 'append'
        ? [...this.proxy.mockRules, ...importedMockRules]
        : importedMockRules;
      const nextBreakpointRules = mode === 'append'
        ? [...this.proxy.breakpointRules, ...importedBreakpointRules]
        : importedBreakpointRules;

      try {
        this._mutateRuleCollections(() => {
          this.proxy.loadMockRules(nextMockRules);
          const restoredBreakpoints = this.proxy.loadBreakpoints(nextBreakpointRules);
          if (restoredBreakpoints.discarded > 0) {
            throw new Error('Every imported breakpoint rule must be valid');
          }
          return {
            mockRules: this.proxy.mockRules,
            breakpointRules: this.proxy.breakpointRules
          };
        });
      } catch (err) {
        return res.status(500).json({ error: err.message || 'Failed to persist imported rules' });
      }

      res.json({
        success: true,
        mockRules: this.proxy.mockRules,
        breakpointRules: this.proxy.breakpointRules
      });
    });

    router.post('/api/mock-rules', (req, res) => {
      // Support new format (matchers + action) and legacy format (method + urlPattern + response)
      const body = req.body || {};

      if (body.matchers !== undefined || body.action !== undefined) {
        // New format
        const candidate = {
          enabled: body.enabled !== undefined ? body.enabled : true,
          priority: body.priority || 'normal',
          matchers: body.matchers,
          preSteps: body.preSteps || undefined,
          action: body.action
        };
        const validationError = validateMockRule(candidate);
        if (validationError) return res.status(400).json({ error: validationError });
        const rule = this._mutateRules(
          'mockRules', 'mockRules', () => this.proxy.addMockRule(candidate)
        );
        return res.json({ success: true, rule });
      }

      // Legacy format
      const { method, urlPattern, response } = body;
      const candidate = {
        method: method || '*',
        urlPattern,
        enabled: true,
        priority: 'normal',
        response: {
          status: response?.status || 200,
          headers: response?.headers || { 'Content-Type': 'application/json' },
          body: response?.body || ''
        }
      };
      const validationError = validateMockRule(candidate);
      if (validationError) return res.status(400).json({ error: validationError });
      const rule = this._mutateRules(
        'mockRules', 'mockRules', () => this.proxy.addMockRule(candidate)
      );
      res.json({ success: true, rule });
    });

    router.put('/api/mock-rules', (req, res) => {
      if (!Array.isArray(req.body?.rules)) {
        return res.status(400).json({ error: 'rules array is required' });
      }
      const mode = req.body.mode === undefined ? 'replace' : req.body.mode;
      if (mode !== 'replace' && mode !== 'append') {
        return res.status(400).json({ error: 'mode must be replace or append' });
      }

      const rules = req.body.rules.map(rule => normalizeImportedMockRule(rule));
      if (rules.some(rule => !rule)) {
        return res.status(400).json({ error: 'Every imported mock rule must be valid' });
      }

      const nextRules = mode === 'append'
        ? [...this.proxy.mockRules, ...rules]
        : rules;
      this._mutateRules('mockRules', 'mockRules', () => this.proxy.loadMockRules(nextRules));
      res.json({ success: true, rules: this.proxy.mockRules });
    });

    router.put('/api/mock-rules/:id', (req, res) => {
      const existing = this._findRuleById(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Rule not found' });
      const validationError = validateMockRule({ ...existing, ...(req.body || {}) });
      if (validationError) return res.status(400).json({ error: validationError });
      const updated = this._mutateRules(
        'mockRules',
        'mockRules',
        () => this.proxy.updateMockRule(req.params.id, req.body),
        result => result !== null
      );
      if (!updated) return res.status(404).json({ error: 'Rule not found' });
      res.json({ success: true, rule: updated });
    });

    router.patch('/api/mock-rules/:id/toggle', (req, res) => {
      const toggled = this._mutateRules(
        'mockRules',
        'mockRules',
        () => this.proxy.toggleMockRule(req.params.id),
        result => result !== null
      );
      if (!toggled) return res.status(404).json({ error: 'Rule not found' });
      res.json({ success: true, rule: toggled });
    });

    router.post('/api/mock-rules/reorder', (req, res) => {
      const { ids } = req.body;
      if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array is required' });
      const rules = this._mutateRules(
        'mockRules',
        'mockRules',
        () => this.proxy.reorderMockRules(ids)
      );
      res.json({ success: true, rules });
    });

    // Create a rule group
    router.post('/api/mock-rules/group', (req, res) => {
      const items = Array.isArray(req.body.items) ? req.body.items : [];
      const candidate = {
        type: 'group',
        title: req.body.title || 'New Group',
        enabled: true,
        items,
        collapsed: false
      };
      const validationError = validateMockRule(candidate);
      if (validationError) return res.status(400).json({ error: validationError });
      const group = this._mutateRules(
        'mockRules', 'mockRules', () => this.proxy.addMockRule(candidate)
      );
      res.json({ success: true, group });
    });

    // Atomically replace two existing rules with one complete group
    router.post('/api/mock-rules/combine', (req, res) => {
      const { ruleIds } = req.body || {};
      if (!Array.isArray(ruleIds) || ruleIds.length !== 2 ||
          ruleIds.some(id => typeof id !== 'string' || !id)) {
        return res.status(400).json({ error: 'Exactly two rule IDs are required' });
      }
      if (ruleIds[0] === ruleIds[1]) {
        return res.status(400).json({ error: 'Rule IDs must be distinct' });
      }

      const sourceRules = ruleIds.map(ruleId => this._findRuleById(ruleId));
      if (sourceRules.some(rule => !rule)) {
        return res.status(404).json({ error: 'Rule not found' });
      }
      if (sourceRules.some(rule => rule.type === 'group')) {
        return res.status(400).json({ error: 'Mock groups cannot contain other groups' });
      }

      let groupId;
      do {
        groupId = crypto.randomUUID();
      } while (this._findRuleById(groupId));

      const sourceIds = new Set(ruleIds);
      const removeSources = rules => rules.reduce((remaining, rule) => {
        if (sourceIds.has(rule.id)) return remaining;
        remaining.push(rule.type === 'group'
          ? { ...rule, items: removeSources(rule.items || []) }
          : rule);
        return remaining;
      }, []);
      const group = {
        id: groupId,
        type: 'group',
        title: req.body.title || 'New Group',
        enabled: true,
        items: sourceRules,
        collapsed: false
      };
      const combinedRules = [...removeSources(this.proxy.mockRules), group];

      try {
        this._mutateRules('mockRules', 'mockRules', () => {
          this.proxy.mockRules = combinedRules;
          return combinedRules;
        });
      } catch (err) {
        return res.status(500).json({ error: err.message || 'Failed to persist mock rules' });
      }

      res.json({ success: true, group, rules: combinedRules });
    });

    // Move a rule into a group
    router.post('/api/mock-rules/move-to-group', (req, res) => {
      const { ruleId, groupId } = req.body;
      if (ruleId === groupId) {
        return res.status(400).json({ error: 'A group cannot be moved into itself' });
      }
      const group = this.proxy.mockRules.find(r => r.id === groupId && r.type === 'group');
      if (!group) return res.status(404).json({ error: 'Group not found' });
      const rule = this._findRuleById(ruleId);
      if (rule?.type === 'group') {
        return res.status(400).json({ error: 'Mock groups cannot contain other groups' });
      }

      // Find and remove the rule from its current location
      const removedRule = this._mutateRules('mockRules', 'mockRules', () => {
        const removed = this._removeRuleById(ruleId);
        if (removed) group.items.push(removed);
        return removed;
      }, result => result !== null);
      if (!removedRule) return res.status(404).json({ error: 'Rule not found' });
      res.json({ success: true });
    });

    // Move a rule out of its group to top level
    router.post('/api/mock-rules/ungroup', (req, res) => {
      const { ruleId } = req.body;
      const rule = this._mutateRules('mockRules', 'mockRules', () => {
        const removed = this._removeRuleById(ruleId);
        if (removed) this.proxy.mockRules.push(removed);
        return removed;
      }, result => result !== null);
      if (!rule) return res.status(404).json({ error: 'Rule not found' });
      res.json({ success: true });
    });

    router.delete('/api/mock-rules/:id', (req, res) => {
      // IDs take precedence; fall back to an index only for legacy clients.
      const param = req.params.id;
      const removed = this._mutateRules('mockRules', 'mockRules', () => {
        if (this.proxy.removeMockRuleById(param)) return true;
        const asInt = Number(param);
        if (!Number.isInteger(asInt) || String(asInt) !== param || asInt < 0 ||
            asInt >= this.proxy.mockRules.length) return false;
        this.proxy.removeMockRule(asInt);
        return true;
      }, Boolean);
      if (!removed) return res.status(404).json({ error: 'Rule not found' });
      res.json({ success: true });
    });

    router.delete('/api/mock-rules', (req, res) => {
      this._mutateRules('mockRules', 'mockRules', () => this.proxy.clearMockRules());
      res.json({ success: true });
    });

    // Breakpoints
    router.get('/api/breakpoints', (req, res) => {
      res.json({ rules: this.proxy.getBreakpoints() });
    });

    router.post('/api/breakpoints', (req, res) => {
      const validationError = this.proxy.validateBreakpointRule(req.body);
      if (validationError) return res.status(400).json({ error: validationError });
      const rule = this._mutateRules(
        'breakpointRules',
        'breakpointRules',
        () => this.proxy.addBreakpoint(req.body)
      );
      res.json({ success: true, rule });
    });

    router.patch('/api/breakpoints/:id', (req, res) => {
      const patch = req.body || {};
      const validationError = this.proxy.validateBreakpointRule(patch, { patch: true });
      if (validationError) return res.status(400).json({ error: validationError });
      const updated = this._mutateRules(
        'breakpointRules',
        'breakpointRules',
        () => this.proxy.updateBreakpoint(req.params.id, patch),
        result => result !== null
      );
      if (!updated) return res.status(404).json({ error: 'Breakpoint not found' });
      res.json({ success: true, rule: updated });
    });

    // Pending breakpoints (paused requests) — must be before /:id to avoid matching "pending" as an id
    router.get('/api/breakpoints/pending', (req, res) => {
      res.json({ pending: this.proxy.getPendingBreakpoints() });
    });

    router.post('/api/breakpoints/pending/:requestId/resume', (req, res) => {
      const validationError = this.proxy.validateBreakpointModifications(req.body);
      if (validationError) return res.status(400).json({ error: validationError });
      const trafficLifecycleId = typeof req.query.trafficLifecycleId === 'string'
        ? req.query.trafficLifecycleId
        : undefined;
      const success = this.proxy.resumeBreakpoint(
        req.params.requestId,
        req.body,
        trafficLifecycleId
      );
      if (!success) return res.status(404).json({ error: 'Pending breakpoint not found' });
      res.json({ success: true });
    });

    router.delete('/api/breakpoints/:id', (req, res) => {
      const removed = this._mutateRules(
        'breakpointRules',
        'breakpointRules',
        () => this.proxy.removeBreakpoint(req.params.id),
        Boolean
      );
      if (!removed) {
        return res.status(404).json({ error: 'Breakpoint not found' });
      }
      res.json({ success: true });
    });

    // Upstream proxy
    router.get('/api/upstream-proxy', (req, res) => {
      res.json({ upstreamProxy: this.proxy.upstreamProxy });
    });

    router.post('/api/upstream-proxy', (req, res) => {
      const { host, port, auth, type, noProxy } = req.body || {};
      try {
        this._setUpstreamProxy({ host, port, auth, type, noProxy });
        res.json({ success: true, upstreamProxy: this.proxy.upstreamProxy });
      } catch (error) {
        if (error instanceof UpstreamProxyConfigError) {
          return res.status(400).json({ error: error.message });
        }
        throw error;
      }
    });

    router.delete('/api/upstream-proxy', (req, res) => {
      this._setUpstreamProxy(null);
      res.json({ success: true });
    });

    router.get('/api/bottingtools/proxy-providers', async (req, res) => {
      try {
        const data = await this._getBottingToolsProviders();
        res.json(data);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    router.post('/api/bottingtools/rotate-proxy', async (req, res) => {
      try {
        const provider = req.body?.provider || 'lemonprime';
        const refill = req.body?.refill !== false;
        const result = await this._rotateBottingToolsProxy(provider, refill, { persistProvider: true });
        if (result.applied === false) {
          return res.status(409).json({
            error: 'Upstream proxy changed while rotation was in progress',
            upstreamProxy: result.upstreamProxy
          });
        }
        res.json({ success: true, ...result });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    router.get('/api/bottingtools/auto-rotate-proxy', (req, res) => {
      res.json(this._getAutoRotateProxyConfig());
    });

    router.post('/api/bottingtools/auto-rotate-proxy', (req, res) => {
      const config = this._setAutoRotateProxyConfig({
        enabled: req.body?.enabled,
        provider: req.body?.provider
      });
      res.json({ success: true, ...config });
    });

    // TLS Passthrough
    router.get('/api/tls-passthrough', (req, res) => {
      res.json({ hosts: this.proxy.tlsPassthrough });
    });

    router.post('/api/tls-passthrough', (req, res) => {
      const { hosts } = req.body;
      this._mutateProxySetting({
        property: 'tlsPassthrough',
        apply: () => this.proxy.setTlsPassthrough(hosts || []),
        restore: previous => this.proxy.setTlsPassthrough(previous)
      });
      res.json({ success: true, hosts: this.proxy.tlsPassthrough });
    });
    router.post('/api/tls-passthrough/items', (req, res) => {
      const host = String(req.body?.host || '').trim();
      if (!host) return res.status(400).json({ error: 'host is required' });
      if (!this.proxy.tlsPassthrough.includes(host)) {
        this._mutateProxySetting({
          property: 'tlsPassthrough',
          apply: () => this.proxy.setTlsPassthrough([...this.proxy.tlsPassthrough, host]),
          restore: previous => this.proxy.setTlsPassthrough(previous)
        });
      }
      res.json({ success: true, hosts: this.proxy.tlsPassthrough });
    });
    router.delete('/api/tls-passthrough/items', (req, res) => {
      const host = String(req.body?.host || '').trim();
      const hosts = this.proxy.tlsPassthrough.filter(item => item !== host);
      if (!host || hosts.length === this.proxy.tlsPassthrough.length) {
        return res.status(404).json({ error: 'Host not found' });
      }
      this._mutateProxySetting({
        property: 'tlsPassthrough',
        apply: () => this.proxy.setTlsPassthrough(hosts),
        restore: previous => this.proxy.setTlsPassthrough(previous)
      });
      res.json({ success: true, hosts: this.proxy.tlsPassthrough });
    });

    // Client certificates
    router.get('/api/client-certificates', (req, res) => {
      res.json({ certificates: publicClientCertificates(this.proxy.clientCertificates) });
    });
    router.post('/api/client-certificates', (req, res) => {
      this._mutateProxySetting({
        property: 'clientCertificates',
        apply: () => this.proxy.setClientCertificates(req.body.certificates || []),
        restore: previous => this.proxy.setClientCertificates(previous)
      });
      res.json({ success: true });
    });
    router.post('/api/client-certificates/items', (req, res) => {
      const host = String(req.body?.host || '').trim();
      const pfxPath = String(req.body?.pfxPath || '').trim();
      if (!host || !pfxPath) return res.status(400).json({ error: 'host and pfxPath are required' });
      const hasPassphrase = Object.prototype.hasOwnProperty.call(req.body || {}, 'passphrase');
      if (hasPassphrase && typeof req.body.passphrase !== 'string') {
        return res.status(400).json({ error: 'passphrase must be a string' });
      }
      const hostKey = this.proxy._getClientCertificateHostKey(host);
      const matchesHost = certificate => hostKey
        ? this.proxy._getClientCertificateHostKey(certificate?.host) === hostKey
        : certificate?.host === host;
      const matchingCertificates = this.proxy.clientCertificates.filter(matchesHost);
      const exactPair = matchingCertificates.find(
        certificate => certificate?.host === host && certificate?.pfxPath === pfxPath
      );
      const alreadyConfigured = matchingCertificates.length === 1 && exactPair &&
        (!hasPassphrase || exactPair.passphrase === req.body.passphrase);
      if (!alreadyConfigured) {
        const retainedPassphrase = !hasPassphrase
          ? matchingCertificates.find(certificate =>
            certificate?.pfxPath === pfxPath &&
            Object.prototype.hasOwnProperty.call(certificate, 'passphrase')
          )?.passphrase
          : undefined;
        const replacement = {
          host,
          pfxPath,
          ...(hasPassphrase
            ? { passphrase: req.body.passphrase }
            : retainedPassphrase !== undefined
              ? { passphrase: retainedPassphrase }
              : {})
        };
        this._mutateProxySetting({
          property: 'clientCertificates',
          apply: () => {
            const certificates = [];
            let replacementAdded = false;
            for (const certificate of this.proxy.clientCertificates) {
              if (!matchesHost(certificate)) {
                certificates.push(certificate);
              } else if (!replacementAdded) {
                certificates.push(replacement);
                replacementAdded = true;
              }
            }
            if (!replacementAdded) certificates.push(replacement);
            return this.proxy.setClientCertificates(certificates);
          },
          restore: previous => this.proxy.setClientCertificates(previous)
        });
      }
      res.json({
        success: true,
        certificates: publicClientCertificates(this.proxy.clientCertificates)
      });
    });
    router.delete('/api/client-certificates/items', (req, res) => {
      const host = String(req.body?.host || '').trim();
      const pfxPath = String(req.body?.pfxPath || '').trim();
      const certificates = this.proxy.clientCertificates.filter(cert => cert.host !== host || cert.pfxPath !== pfxPath);
      if (!host || !pfxPath || certificates.length === this.proxy.clientCertificates.length) {
        return res.status(404).json({ error: 'Client certificate not found' });
      }
      this._mutateProxySetting({
        property: 'clientCertificates',
        apply: () => this.proxy.setClientCertificates(certificates),
        restore: previous => this.proxy.setClientCertificates(previous)
      });
      res.json({
        success: true,
        certificates: publicClientCertificates(this.proxy.clientCertificates)
      });
    });

    // Trusted CAs
    router.get('/api/trusted-cas', (req, res) => {
      res.json({ cas: this.proxy.trustedCAs });
    });
    router.post('/api/trusted-cas', (req, res) => {
      this._mutateProxySetting({
        property: 'trustedCAs',
        apply: () => this.proxy.setTrustedCAs(req.body.cas || []),
        restore: previous => this.proxy.setTrustedCAs(previous)
      });
      res.json({ success: true });
    });
    router.post('/api/trusted-cas/items', (req, res) => {
      const ca = String(req.body?.ca || '').trim();
      if (!ca) return res.status(400).json({ error: 'ca is required' });
      if (!this.proxy.trustedCAs.includes(ca)) {
        this._mutateProxySetting({
          property: 'trustedCAs',
          apply: () => this.proxy.setTrustedCAs([...this.proxy.trustedCAs, ca]),
          restore: previous => this.proxy.setTrustedCAs(previous)
        });
      }
      res.json({ success: true, cas: this.proxy.trustedCAs });
    });
    router.delete('/api/trusted-cas/items', (req, res) => {
      const ca = String(req.body?.ca || '').trim();
      const cas = this.proxy.trustedCAs.filter(item => item !== ca);
      if (!ca || cas.length === this.proxy.trustedCAs.length) {
        return res.status(404).json({ error: 'Trusted CA not found' });
      }
      this._mutateProxySetting({
        property: 'trustedCAs',
        apply: () => this.proxy.setTrustedCAs(cas),
        restore: previous => this.proxy.setTrustedCAs(previous)
      });
      res.json({ success: true, cas: this.proxy.trustedCAs });
    });

    // HTTPS whitelist
    router.get('/api/https-whitelist', (req, res) => {
      res.json({ hosts: this.proxy.httpsWhitelist });
    });
    router.post('/api/https-whitelist', (req, res) => {
      this._mutateProxySetting({
        property: 'httpsWhitelist',
        apply: () => this.proxy.setHttpsWhitelist(req.body.hosts || []),
        restore: previous => this.proxy.setHttpsWhitelist(previous)
      });
      res.json({ success: true });
    });
    router.post('/api/https-whitelist/items', (req, res) => {
      const host = String(req.body?.host || '').trim();
      if (!host) return res.status(400).json({ error: 'host is required' });
      if (!this.proxy.httpsWhitelist.includes(host)) {
        this._mutateProxySetting({
          property: 'httpsWhitelist',
          apply: () => this.proxy.setHttpsWhitelist([...this.proxy.httpsWhitelist, host]),
          restore: previous => this.proxy.setHttpsWhitelist(previous)
        });
      }
      res.json({ success: true, hosts: this.proxy.httpsWhitelist });
    });
    router.delete('/api/https-whitelist/items', (req, res) => {
      const host = String(req.body?.host || '').trim();
      const hosts = this.proxy.httpsWhitelist.filter(item => item !== host);
      if (!host || hosts.length === this.proxy.httpsWhitelist.length) {
        return res.status(404).json({ error: 'Host not found' });
      }
      this._mutateProxySetting({
        property: 'httpsWhitelist',
        apply: () => this.proxy.setHttpsWhitelist(hosts),
        restore: previous => this.proxy.setHttpsWhitelist(previous)
      });
      res.json({ success: true, hosts: this.proxy.httpsWhitelist });
    });

    // API Specs
    router.get('/api/specs', (req, res) => {
      res.json({ specs: this.proxy.getApiSpecs() });
    });

    router.post('/api/specs', (req, res) => {
      const validation = validateOpenApiSubmission(req.body);
      if (validation.error) return res.status(400).json({ error: validation.error });
      let result;
      try {
        result = this._mutateRules(
          'apiSpecs',
          'apiSpecs',
          () => this.proxy.addApiSpec(validation.value)
        );
      } catch (err) {
        return res.status(500).json({ error: err.message || 'Failed to persist API spec' });
      }
      res.json({ success: true, spec: { id: result.id, title: result.title, baseUrl: result.baseUrl } });
    });

    router.delete('/api/specs/:id', (req, res) => {
      try {
        this._mutateRules(
          'apiSpecs',
          'apiSpecs',
          () => this.proxy.removeApiSpec(req.params.id),
          removed => removed
        );
      } catch (err) {
        return res.status(500).json({ error: err.message || 'Failed to persist API spec removal' });
      }
      res.json({ success: true });
    });

    // Match a request against loaded specs
    router.get('/api/specs/match', (req, res) => {
      const { method, path, host } = req.query;
      const match = this.proxy.matchApiSpec(method || 'GET', path || '/', host || '');
      res.json({ match });
    });

    // HTTP/2 config
    router.get('/api/http2', (req, res) => {
      res.json({ mode: this.proxy.http2Enabled });
    });

    router.post('/api/http2', (req, res) => {
      const { mode } = req.body;
      if (!['all', 'h2-only', 'disabled'].includes(mode)) {
        return res.status(400).json({ error: 'Invalid mode. Use: all, h2-only, disabled' });
      }
      this._mutateProxySetting({
        property: 'http2Enabled',
        apply: () => this.proxy.setHttp2Config(mode),
        restore: previous => this.proxy.setHttp2Config(previous)
      });
      res.json({ success: true, mode: this.proxy.http2Enabled });
    });

    // TLS fingerprint config
    router.get('/api/tls-fingerprint', (req, res) => {
      const fingerprints = this.proxy.constructor.TLS_FINGERPRINTS || {};
      const presets = Object.entries(fingerprints).map(([id, p]) => ({ id, label: p.label }));
      res.json({ fingerprint: this.proxy.tlsFingerprint, presets });
    });

    router.post('/api/tls-fingerprint', (req, res) => {
      const { fingerprint } = req.body;
      this._mutateProxySetting({
        property: 'tlsFingerprint',
        apply: () => this.proxy.setTlsFingerprint(fingerprint),
        restore: previous => this.proxy.setTlsFingerprint(previous)
      });
      res.json({ success: true, fingerprint: this.proxy.tlsFingerprint });
    });

    // Proxy port range config
    router.get('/api/port-config', (req, res) => {
      res.json({
        proxyPort: this.proxy.port,
        minPort: this.proxy.minPort || this.proxy.port,
        maxPort: this.proxy.maxPort || this.proxy.port
      });
    });

    router.post('/api/port-config', (req, res) => {
      const { minPort, maxPort } = req.body;
      const range = validatePortRange(minPort, maxPort);
      if (!range) {
        return res.status(400).json({ error: 'Port range must use integers from 1 to 65535 with minimum no greater than maximum' });
      }
      // Store for next restart (can't change port while running)
      this._runPersistedMutation({
        capture: () => ({ minPort: this.proxy.minPort, maxPort: this.proxy.maxPort }),
        apply: () => {
          this.proxy.minPort = range.minPort;
          this.proxy.maxPort = range.maxPort;
        },
        persist: () => this._persistSettings({ proxyPortRange: range }),
        restore: previous => {
          this.proxy.minPort = previous.minPort;
          this.proxy.maxPort = previous.maxPort;
        }
      });
      res.json({ success: true, minPort: this.proxy.minPort, maxPort: this.proxy.maxPort, note: 'Port changes take effect on next restart' });
    });

    // Certificate download
    router.post('/api/certificate/renewal', (req, res) => {
      try {
        const certInfo = this.ca.getCertInfo();
        if (certInfo.certificateAutomaticRenewalEnabled) {
          return res.status(409).json({
            error: 'CA renewal is managed automatically on this platform'
          });
        }
        if (!certInfo.certificateRenewalRequired) {
          return res.status(409).json({
            error: 'CA renewal can be scheduled only within 30 days of expiry'
          });
        }
        this.ca.scheduleRenewal();
        res.json({
          success: true,
          scheduled: true,
          note: 'The CA will be replaced on the next application restart'
        });
      } catch (error) {
        res.status(500).json({ error: `Could not schedule CA renewal: ${error.message}` });
      }
    });

    router.delete('/api/certificate/renewal', (req, res) => {
      try {
        this.ca.cancelScheduledRenewal();
        res.json({ success: true, scheduled: false });
      } catch (error) {
        res.status(500).json({ error: `Could not cancel CA renewal: ${error.message}` });
      }
    });

    router.post('/api/certificate/replacement-acknowledgement', (req, res) => {
      try {
        this.ca.acknowledgeReplacementMigration();
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: `Could not acknowledge CA replacement: ${error.message}` });
      }
    });

    router.get('/api/certificate', (req, res) => {
      const certInfo = this.ca.getCertInfo();
      res.setHeader('Content-Type', 'application/x-pem-file');
      res.setHeader('Content-Disposition', 'attachment; filename=http-freekit-ca.pem');
      res.send(certInfo.certificateContent);
    });

    // Shutdown
    router.post('/api/shutdown', (req, res) => {
      if (typeof this.onShutdown !== 'function') {
        return res.status(503).json({ error: 'Graceful shutdown is not configured' });
      }
      res.json({ success: true });
      setImmediate(() => {
        Promise.resolve(this.onShutdown()).catch(err => {
          console.error('[API] Graceful shutdown failed:', err.message);
        });
      });
    });

    // Send a test request through the proxy
    router.post('/api/send', async (req, res) => {
      const controller = new AbortController();
      const abortOutbound = () => {
        if (!res.writableEnded) controller.abort();
      };
      req.once('aborted', abortOutbound);
      res.once('close', abortOutbound);

      try {
        const { url, method, headers, body, bodyEncoding } = req.body;
        const result = await this._sendRequest(
          url,
          method || 'GET',
          headers || {},
          body || '',
          bodyEncoding || 'utf8',
          controller.signal
        );
        if (!res.destroyed) res.json(result);
      } catch (err) {
        if (err.name !== 'AbortError' && !res.destroyed) {
          res.status(500).json({ error: err.message });
        }
      } finally {
        req.removeListener('aborted', abortOutbound);
        res.removeListener('close', abortOutbound);
      }
    });

    // MCP Server status and control
    router.get('/api/mcp/status', (req, res) => {
      const status = this._getMcpStatus();
      if (status.enabled && status.sseEndpoint) {
        const endpoint = new URL(`http://127.0.0.1:${this.port}/mcp/sse`);
        if (this.authToken) endpoint.searchParams.set('authToken', this.authToken);
        status.sseEndpoint = endpoint.toString();
      } else {
        status.sseEndpoint = null;
      }
      res.json(status);
    });

    router.post('/api/mcp/toggle', async (req, res) => {
      if (!this.mcpBridge) return res.status(500).json({ error: 'MCP bridge not initialized' });
      const { enabled } = req.body || {};
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled must be a boolean' });
      }
      try {
        const appliedEnabled = await this._queueMcpEnabledMutation(enabled);
        res.json({ success: true, enabled: appliedEnabled });
      } catch (error) {
        const status = this._getMcpStatus();
        const body = { error: error.message || 'Could not update MCP state' };
        if (status.degraded === true) {
          body.degraded = true;
          body.enabled = status.enabled === true;
          body.degradedReason = status.degradedReason;
          if (typeof status.persistedEnabled === 'boolean') {
            body.persistedEnabled = status.persistedEnabled;
          }
        }
        res.status(500).json(body);
      }
    });

    this.app.use(router);
  }

  _findRuleById(ruleId, rules = this.proxy.mockRules) {
    for (const rule of rules) {
      if (rule.id === ruleId) return rule;
      if (rule.type === 'group') {
        const nested = this._findRuleById(ruleId, rule.items || []);
        if (nested) return nested;
      }
    }
    return null;
  }

  _appendImportedTraffic(requests) {
    const limit = Math.max(0, this.maxTrafficLog);
    const excess = Math.max(0, this.trafficLog.length + requests.length - limit);
    const existingIds = new Set();
    const reservedIds = new Set();
    let framesToRemove = 0;
    for (const request of this.trafficLog) {
      existingIds.add(request.id);
      reservedIds.add(request.id);
      if (request?.protocol === 'ws-frame' && framesToRemove < excess) {
        framesToRemove++;
      }
    }
    for (const request of requests) {
      reservedIds.add(request.id);
      if (request?.protocol === 'ws-frame' && framesToRemove < excess) {
        framesToRemove++;
      }
    }
    let baseRowsToRemove = excess - framesToRemove;
    let remainingFramesToRemove = framesToRemove;
    const retainedExisting = [];
    const retainedIncoming = [];
    for (const [rows, retained] of [
      [this.trafficLog, retainedExisting],
      [requests, retainedIncoming]
    ]) {
      for (const request of rows) {
        if (request?.protocol === 'ws-frame' && remainingFramesToRemove > 0) {
          remainingFramesToRemove--;
        } else if (request?.protocol !== 'ws-frame' && baseRowsToRemove > 0) {
          baseRowsToRemove--;
        } else {
          retained.push(request);
        }
      }
    }

    const assignedIds = new Set(retainedExisting.map(request => request.id));
    const assignedIncoming = [];
    const importedParentIds = new Map();
    const importedParentLifecycleIds = new Map();
    for (const request of retainedIncoming) {
      let id = request.id;
      if (!this._importedTrafficIdFitsBroadcast(id) || existingIds.has(id) || assignedIds.has(id)) {
        do {
          id = crypto.randomUUID();
        } while (reservedIds.has(id) || assignedIds.has(id));
      }
      reservedIds.add(id);
      assignedIds.add(id);
      // Imported traffic is historical and cannot own a live resumable breakpoint.
      const { breakpointActive: _importedBreakpointActive, ...historicalRequest } = request;
      let trafficLifecycleId = request.trafficLifecycleId;
      if (trafficLifecycleId &&
          !this._importedTrafficLifecycleIdFitsBroadcast(id, trafficLifecycleId)) {
        trafficLifecycleId = crypto.randomUUID();
      }
      const assignedRequest = {
        ...historicalRequest,
        id,
        ...(trafficLifecycleId ? { trafficLifecycleId } : {})
      };
      assignedIncoming.push(assignedRequest);
      if (request.protocol === 'ws' || request.protocol === 'wss') {
        // Legacy frames cannot disambiguate duplicate parent lifecycles, so
        // consistently bind them to the first imported parent with that ID.
        if (!importedParentIds.has(request.id)) {
          importedParentIds.set(request.id, {
            id,
            trafficLifecycleId: assignedRequest.trafficLifecycleId || null
          });
        }
        if (request.trafficLifecycleId) {
          const parentKey = JSON.stringify([request.id, request.trafficLifecycleId]);
          if (!importedParentLifecycleIds.has(parentKey)) {
            importedParentLifecycleIds.set(parentKey, {
              id,
              trafficLifecycleId: assignedRequest.trafficLifecycleId || null
            });
          }
        }
      }
    }
    const legacyParentIds = new Map();
    for (const request of retainedExisting) {
      if (request.protocol !== 'ws' && request.protocol !== 'wss') continue;
      if (!legacyParentIds.has(request.id)) {
        legacyParentIds.set(request.id, {
          id: request.id,
          trafficLifecycleId: request.trafficLifecycleId || null
        });
      }
    }
    // Preserve the established rule that an imported parent wins an ID
    // collision with retained traffic when binding an imported legacy frame.
    for (const [originalId, parent] of importedParentIds) {
      legacyParentIds.set(originalId, parent);
    }
    for (const request of assignedIncoming) {
      if (request.protocol !== 'ws-frame') continue;
      const parentKey = request.parentTrafficLifecycleId
        ? JSON.stringify([request.parentId, request.parentTrafficLifecycleId])
        : null;
      if (parentKey && importedParentLifecycleIds.has(parentKey)) {
        const parent = importedParentLifecycleIds.get(parentKey);
        request.parentId = parent.id;
        if (parent.trafficLifecycleId) {
          request.parentTrafficLifecycleId = parent.trafficLifecycleId;
        } else {
          delete request.parentTrafficLifecycleId;
        }
      } else if (!parentKey && legacyParentIds.has(request.parentId)) {
        const parent = legacyParentIds.get(request.parentId);
        request.parentId = parent.id;
        if (parent.trafficLifecycleId) {
          request.parentTrafficLifecycleId = parent.trafficLifecycleId;
        }
      }
    }

    this.trafficLog.length = 0;
    for (const request of retainedExisting) this.trafficLog.push(request);
    for (const request of assignedIncoming) this.trafficLog.push(request);
    return assignedIncoming;
  }

  _summarizeTrafficForBroadcast(request) {
    const truncate = (value, length) => value === undefined || value === null
      ? value
      : String(value).slice(0, length);
    return {
      id: request.id,
      trafficLifecycleId: request.trafficLifecycleId,
      protocol: truncate(request.protocol, 32),
      method: truncate(request.method, 32),
      url: truncate(request.url, 256),
      host: truncate(request.host, 128),
      path: truncate(request.path, 256),
      statusCode: request.statusCode,
      statusMessage: truncate(request.statusMessage, 128),
      duration: request.duration,
      timestamp: request.timestamp,
      source: truncate(request.source, 32),
      parentId: request.parentId,
      parentTrafficLifecycleId: request.parentTrafficLifecycleId,
      direction: truncate(request.direction, 32),
      opcode: request.opcode,
      opcodeName: truncate(request.opcodeName, 32),
      requestBodySize: request.requestBodySize,
      responseBodySize: request.responseBodySize,
      ...(request.pinned === true ? { pinned: true } : {}),
      _deferredTrafficDetail: true
    };
  }

  _importBroadcastMessage(count, requests, chunkIndex, chunkCount) {
    return {
      type: 'traffic-imported',
      count,
      requests,
      ...(chunkCount > 1 ? { chunkIndex, chunkCount } : {})
    };
  }

  _messageFitsWsBuffer(message) {
    return Buffer.byteLength(JSON.stringify(message)) <= this.maxWsBufferedBytes;
  }

  _importedTrafficIdFitsBroadcast(id) {
    let encodedId;
    try {
      encodedId = encodeURIComponent(id);
    } catch {
      return false;
    }
    // Detail, pin, and delete routes all carry this value in the request
    // target. Leave room for a lifecycle query and ordinary HTTP headers.
    if (Buffer.byteLength(encodedId) > 4096) return false;
    const deferredIdentity = { id, pinned: true, _deferredTrafficDetail: true };
    return this._messageFitsWsBuffer(this._importBroadcastMessage(
      Number.MAX_SAFE_INTEGER,
      [deferredIdentity],
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER
    )) && this._messageFitsWsBuffer(this._trafficClearBroadcastMessage(
      '00000000-0000-4000-8000-000000000000',
      [deferredIdentity],
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER
    ));
  }

  _importedTrafficLifecycleIdFitsBroadcast(id, trafficLifecycleId) {
    let encodedLifecycleId;
    try {
      encodedLifecycleId = encodeURIComponent(trafficLifecycleId);
    } catch {
      return false;
    }
    // Keep exact-detail query strings comfortably below Node's request-header
    // ceiling, even when every input byte needs percent encoding.
    if (Buffer.byteLength(encodedLifecycleId) > 4096) return false;
    const deferredIdentity = {
      id,
      trafficLifecycleId,
      pinned: true,
      _deferredTrafficDetail: true
    };
    return this._messageFitsWsBuffer(this._trafficClearBroadcastMessage(
      '00000000-0000-4000-8000-000000000000',
      [deferredIdentity],
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER
    ));
  }

  _buildImportedTrafficMessages(requests, count) {
    const completeMessage = this._importBroadcastMessage(count, requests, 0, 1);
    if (this._messageFitsWsBuffer(completeMessage)) return [completeMessage];

    const batches = [];
    let batch = [];
    const placeholderChunk = Number.MAX_SAFE_INTEGER;
    const fitsBatch = candidate => this._messageFitsWsBuffer(
      this._importBroadcastMessage(count, candidate, placeholderChunk, placeholderChunk)
    );

    for (const request of requests) {
      if (fitsBatch([...batch, request])) {
        batch.push(request);
        continue;
      }
      if (batch.length > 0) {
        batches.push(batch);
        batch = [];
      }

      const item = fitsBatch([request])
        ? request
        : this._summarizeTrafficForBroadcast(request);
      if (!fitsBatch([item])) {
        // Extremely small custom ceilings still receive the stable identity.
        batch = [{
          id: request.id,
          ...(request.pinned === true ? { pinned: true } : {}),
          _deferredTrafficDetail: true
        }];
      } else {
        batch = [item];
      }
    }
    if (batch.length > 0) batches.push(batch);
    if (batches.length === 0) batches.push([]);

    return batches.map((requestsBatch, chunkIndex) => this._importBroadcastMessage(
      count,
      requestsBatch,
      chunkIndex,
      batches.length
    ));
  }

  _broadcastImportedTraffic(requests, count) {
    this._broadcastSequence(this._buildImportedTrafficMessages(requests, count));
  }

  _trafficClearBroadcastMessage(
    clearId,
    retainedTraffic,
    chunkIndex,
    chunkCount,
    revision,
    pinRevision
  ) {
    return {
      type: 'traffic-cleared',
      clearId,
      retainedTraffic,
      ...(Number.isSafeInteger(revision) && revision > 0 ? { revision } : {}),
      ...(Number.isSafeInteger(pinRevision) && pinRevision >= 0 ? { pinRevision } : {}),
      ...(chunkCount > 1 ? { chunkIndex, chunkCount } : {})
    };
  }

  _compactTrafficClearBroadcastMessage(
    clearId,
    retainedTraffic,
    chunkIndex,
    chunkCount,
    revision,
    pinRevision
  ) {
    const message = this._trafficClearBroadcastMessage(
      clearId,
      retainedTraffic,
      chunkIndex,
      chunkCount,
      revision
    );
    return {
      ...message,
      d: 1,
      ...(Number.isSafeInteger(pinRevision) && pinRevision >= 0 ? { p: pinRevision } : {})
    };
  }

  _buildCompactTrafficClearedMessages(clearId, retainedTraffic, revision, pinRevision) {
    const identities = new Set();
    const compactTraffic = [];
    for (const request of retainedTraffic) {
      const identityKey = this._trafficIdentityKey(
        request.id,
        request.trafficLifecycleId ?? null
      );
      // A compact row must still identify exactly one retained lifecycle.
      if (identities.has(identityKey)) return [];
      identities.add(identityKey);
      compactTraffic.push({
        id: request.id,
        ...(request.trafficLifecycleId == null ? {} : { l: request.trafficLifecycleId })
      });
    }

    const batches = [];
    let batch = [];
    // At most one chunk per identity is needed, so these values have at least
    // as many digits as every final chunk index/count.
    const placeholderChunkIndex = Math.max(0, compactTraffic.length - 1);
    const placeholderChunkCount = Math.max(1, compactTraffic.length);
    const fitsBatch = candidate => this._messageFitsWsBuffer(
      this._compactTrafficClearBroadcastMessage(
        clearId,
        candidate,
        placeholderChunkIndex,
        placeholderChunkCount,
        revision,
        pinRevision
      )
    );

    for (const request of compactTraffic) {
      if (fitsBatch([...batch, request])) {
        batch.push(request);
        continue;
      }
      if (batch.length > 0) {
        batches.push(batch);
        batch = [];
      }
      if (!fitsBatch([request])) return [];
      batch = [request];
    }
    if (batch.length > 0) batches.push(batch);
    if (batches.length === 0) batches.push([]);

    const messages = batches.map((requestsBatch, chunkIndex) =>
      this._compactTrafficClearBroadcastMessage(
        clearId,
        requestsBatch,
        chunkIndex,
        batches.length,
        revision,
        pinRevision
      )
    );
    return messages.every(message => this._messageFitsWsBuffer(message)) ? messages : [];
  }

  _buildTrafficClearedMessages(clearId, retainedTraffic, revision, pinRevision) {
    const completeMessage = this._trafficClearBroadcastMessage(
      clearId,
      retainedTraffic,
      0,
      1,
      revision,
      pinRevision
    );
    if (this._messageFitsWsBuffer(completeMessage)) return [completeMessage];

    const retainedIdCounts = new Map();
    for (const request of retainedTraffic) {
      retainedIdCounts.set(request.id, (retainedIdCounts.get(request.id) || 0) + 1);
    }
    const batches = [];
    let batch = [];
    const placeholderChunk = Number.MAX_SAFE_INTEGER;
    const fitsBatch = candidate => this._messageFitsWsBuffer(
      this._trafficClearBroadcastMessage(
        clearId,
        candidate,
        placeholderChunk,
        placeholderChunk,
        revision,
        pinRevision
      )
    );

    for (const request of retainedTraffic) {
      if (fitsBatch([...batch, request])) {
        batch.push(request);
        continue;
      }
      if (batch.length > 0) {
        batches.push(batch);
        batch = [];
      }

      const item = fitsBatch([request])
        ? request
        : this._summarizeTrafficForBroadcast(request);
      const deferredIdentity = {
        id: request.id,
        trafficLifecycleId: request.trafficLifecycleId ?? null,
        pinned: true,
        _deferredTrafficDetail: true
      };
      const itemFits = fitsBatch([item]);
      const deferredIdentityFits = fitsBatch([deferredIdentity]);
      if (!itemFits && !deferredIdentityFits && retainedIdCounts.get(request.id) > 1) {
        return this._buildCompactTrafficClearedMessages(
          clearId,
          retainedTraffic,
          revision,
          pinRevision
        );
      }
      const fallback = itemFits
        ? item
        : (deferredIdentityFits ? deferredIdentity : {
            id: request.id,
            pinned: true,
            _deferredTrafficDetail: true
          });
      // If even the minimal stable identity cannot fit, no valid authoritative
      // Clear payload exists for this configured ceiling. Do not enqueue an
      // oversized message that would terminate every connected renderer.
      if (!fitsBatch([fallback])) return [];
      batch = [fallback];
    }
    if (batch.length > 0) batches.push(batch);
    if (batches.length === 0) batches.push([]);

    const messages = batches.map((requestsBatch, chunkIndex) => this._trafficClearBroadcastMessage(
      clearId,
      requestsBatch,
      chunkIndex,
      batches.length,
      revision,
      pinRevision
    ));
    return messages.every(message => this._messageFitsWsBuffer(message)) ? messages : [];
  }

  _broadcastTrafficCleared(clearId, retainedTraffic, revision, pinRevision) {
    const messages = this._buildTrafficClearedMessages(
      clearId,
      retainedTraffic,
      revision,
      pinRevision
    );
    if (messages.length === 0) {
      console.warn('[API] Traffic Clear broadcast skipped: WebSocket ceiling is too small');
      return;
    }
    if (messages.length === 1) this._broadcast(messages[0]);
    else this._broadcastSequence(messages);
  }

  _removeRuleById(ruleId, rules = this.proxy.mockRules) {
    for (let i = 0; i < rules.length; i++) {
      if (rules[i].id === ruleId) return rules.splice(i, 1)[0];
      if (rules[i].type === 'group') {
        const nested = this._removeRuleById(ruleId, rules[i].items || []);
        if (nested) return nested;
      }
    }
    return null;
  }

  async _sendRequest(url, method, headers, body, bodyEncoding = 'utf8', signal) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        throw new Error(`Unsupported Send URL protocol: ${parsedUrl.protocol}`);
      }
      const outboundHeaders = { ...headers };
      for (const name of Object.keys(outboundHeaders)) {
        if (name.toLowerCase() === INTERNAL_SEND_HEADER_NAME) delete outboundHeaders[name];
      }
      const hasExplicitAuthorization = Object.keys(outboundHeaders)
        .some(name => name.toLowerCase() === 'authorization');
      if (!hasExplicitAuthorization && (parsedUrl.username !== '' || parsedUrl.password !== '')) {
        let username;
        let password;
        try {
          username = decodeURIComponent(parsedUrl.username);
          password = decodeURIComponent(parsedUrl.password);
        } catch {
          throw new Error('Send URL contains invalid percent-encoding in its credentials');
        }
        const encodedCredentials = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
        outboundHeaders.Authorization = `Basic ${encodedCredentials}`;
      }
      parsedUrl.username = '';
      parsedUrl.password = '';
      parsedUrl.hash = '';
      const isHttps = parsedUrl.protocol === 'https:';
      const connectTimeoutMs = this.sendConnectTimeoutMs ?? 10000;
      const idleTimeoutMs = this.sendIdleTimeoutMs ?? 30000;
      const totalTimeoutMs = this.sendTotalTimeoutMs ?? 60000;
      const proxyAddress = this.proxy?.server?.listening
        ? this.proxy.server.address()
        : null;
      const proxyPort = proxyAddress && typeof proxyAddress === 'object'
        ? proxyAddress.port
        : this.proxy?.port;
      const canUseProxy = Number.isInteger(proxyPort) && proxyPort > 0 && proxyPort <= 65535
        && typeof this.proxy?._registerInternalSendRequest === 'function'
        && typeof this.proxy?._cancelInternalSendRequest === 'function';
      const sendContextTtl = Number.isSafeInteger(totalTimeoutMs) && totalTimeoutMs > 0
        ? totalTimeoutMs + 5000
        : 120000;
      const sendContext = canUseProxy
        ? this.proxy._registerInternalSendRequest(sendContextTtl)
        : null;
      const proxyBindHost = String(this.proxy?.bindHost || '127.0.0.1');
      const proxyHostname = proxyBindHost === '0.0.0.0'
        ? '127.0.0.1'
        : (proxyBindHost === '::' || proxyBindHost === '[::]')
          ? '::1'
          : proxyBindHost.replace(/^\[|\]$/g, '');
      const transportIsHttps = isHttps && !sendContext;
      const lib = transportIsHttps ? https : http;

      if (sendContext) {
        const hasExplicitHost = Object.keys(outboundHeaders)
          .some(name => name.toLowerCase() === 'host');
        if (!hasExplicitHost) outboundHeaders.Host = parsedUrl.host;
        outboundHeaders[sendContext.headerName] = sendContext.token;
      }

      const options = sendContext
        ? {
            hostname: proxyHostname,
            port: proxyPort,
            path: parsedUrl.href,
            method,
            headers: outboundHeaders
          }
        : {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method,
            headers: outboundHeaders,
            ...(isHttps ? this.proxy._getUpstreamTlsOptions(parsedUrl.hostname) : {})
          };

      const startTime = Date.now();
      let settled = false;
      let connectTimer;
      let totalTimer;
      let req;
      const cleanup = () => {
        clearTimeout(connectTimer);
        clearTimeout(totalTimer);
        req?.setTimeout(0);
        signal?.removeEventListener('abort', abortRequest);
        if (sendContext) this.proxy._cancelInternalSendRequest(sendContext.token);
      };
      const fail = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        req?.destroy();
        reject(err);
      };
      const succeed = (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const abortRequest = () => {
        const error = new Error('Send request aborted');
        error.name = 'AbortError';
        error.code = 'ABORT_ERR';
        fail(error);
      };

      signal?.addEventListener('abort', abortRequest, { once: true });
      if (signal?.aborted) {
        abortRequest();
        return;
      }

      req = lib.request(options, (res) => {
        const chunks = [];
        let responseBytes = 0;
        res.on('data', chunk => {
          responseBytes += chunk.length;
          if (responseBytes > this.sendMaxResponseBytes) {
            fail(new Error(`Send response exceeds ${this.sendMaxResponseBytes} byte buffer limit`));
            return;
          }
          chunks.push(chunk);
        });
        res.once('aborted', () => fail(new Error('Send response aborted before completion')));
        res.once('error', fail);
        res.on('end', () => {
          const responseBody = Buffer.concat(chunks);
          const bodyEncoding = isUtf8(responseBody) ? 'utf8' : 'base64';
          const rawContentType = Object.entries(res.headers)
            .find(([name]) => name.toLowerCase() === 'content-type')?.[1];
          const contentType = normalizeDataUriMediaType(rawContentType);
          succeed({
            statusCode: res.statusCode,
            statusMessage: res.statusMessage,
            headers: res.headers,
            body: bodyEncoding === 'base64'
              ? `data:${contentType};base64,${responseBody.toString('base64')}`
              : responseBody.toString('utf8'),
            bodyEncoding,
            bodySize: responseBody.length,
            duration: Date.now() - startTime,
            ...(sendContext ? { trafficId: sendContext.requestId } : {})
          });
        });
      });

      connectTimer = setTimeout(() => {
        fail(new Error(`Send connection timeout after ${connectTimeoutMs}ms`));
      }, connectTimeoutMs);
      totalTimer = setTimeout(() => {
        fail(new Error(`Send request timeout after ${totalTimeoutMs}ms`));
      }, totalTimeoutMs);
      req.once('socket', socket => {
        const connectedEvent = transportIsHttps ? 'secureConnect' : 'connect';
        if (!socket.connecting && (!transportIsHttps || socket.encrypted)) {
          clearTimeout(connectTimer);
        } else {
          socket.once(connectedEvent, () => clearTimeout(connectTimer));
        }
      });
      req.setTimeout(idleTimeoutMs, () => {
        fail(new Error(`Send idle timeout after ${idleTimeoutMs}ms`));
      });
      req.once('error', fail);
      if (body) req.write(bodyEncoding === 'base64' ? Buffer.from(body, 'base64') : body);
      req.end();
    });
  }

  _addPendingTrafficLifecycle(id, lifecycleToken) {
    this._pendingTrafficIds.add(id);
    if (lifecycleToken === undefined) return;
    let lifecycles = this._pendingTrafficLifecycles.get(id);
    if (!lifecycles) {
      lifecycles = new Set();
      this._pendingTrafficLifecycles.set(id, lifecycles);
    }
    lifecycles.add(lifecycleToken);
  }

  _completePendingTrafficLifecycle(id, lifecycleToken) {
    const lifecycles = this._pendingTrafficLifecycles.get(id);
    if (lifecycleToken !== undefined) {
      if (!lifecycles) return;
      if (!lifecycles.delete(lifecycleToken)) return;
      if (lifecycles.size > 0) return;
    }
    this._pendingTrafficLifecycles.delete(id);
    this._pendingTrafficIds.delete(id);
  }

  _trimTrafficLog() {
    const limit = Math.max(0, this.maxTrafficLog);
    const excess = this.trafficLog.length - limit;
    if (excess <= 0) return;

    if (excess === 1) {
      const frameIndex = this.trafficLog.findIndex(request => request?.protocol === 'ws-frame');
      this.trafficLog.splice(frameIndex === -1 ? 0 : frameIndex, 1);
      return;
    }

    let framesToRemove = 0;
    for (const request of this.trafficLog) {
      if (request?.protocol === 'ws-frame' && framesToRemove < excess) framesToRemove++;
    }
    let baseRowsToRemove = excess - framesToRemove;
    let writeIndex = 0;
    for (const request of this.trafficLog) {
      if (request?.protocol === 'ws-frame' && framesToRemove > 0) {
        framesToRemove--;
      } else if (request?.protocol !== 'ws-frame' && baseRowsToRemove > 0) {
        baseRowsToRemove--;
      } else {
        this.trafficLog[writeIndex++] = request;
      }
    }
    this.trafficLog.length = writeIndex;
  }

  _setCapturePaused(paused) {
    const next = paused === true;
    if (this.capturePaused === next) return false;
    this.capturePaused = next;
    this.captureStateRevision += 1;
    this._broadcast({
      type: 'capture-state',
      paused: next,
      sessionId: this.captureStateSessionId,
      revision: this.captureStateRevision
    });
    return true;
  }

  _shouldSuppressPausedTrafficEvent(data) {
    if (!this.capturePaused || data.source === 'Send') return false;

    if (data._update === true) {
      const retainedPending = this.trafficLog.some(request =>
        request.id === data.id &&
        (request.trafficLifecycleId ?? null) === (data.trafficLifecycleId ?? null)
      );
      if (retainedPending) return false;
    }
    return true;
  }

  onTrafficEvent(data) {
    if (this._shouldSuppressPausedTrafficEvent(data)) {
      if (data._pending !== true) this._maybeAutoRotateProxyOnError(data);
      return false;
    }
    this._pruneClearedPendingTrafficIds();
    this._pruneDeletedTrafficIdentities();
    // Enrich with API spec match
    let apiMatch = null;
    try {
      apiMatch = this.proxy.matchApiSpec(data.method, data.path, data.host);
    } catch (err) {
      console.warn(
        '[API] Could not match traffic against API specs:',
        err instanceof Error ? err.message : String(err)
      );
    }
    if (apiMatch) data.apiMatch = apiMatch;

    const trafficClearGeneration = data._trafficClearGeneration;
    const trafficLifecycleToken = data._trafficLifecycleToken;
    const trafficLifecycleComplete = data._pending !== true &&
      data._trafficLifecycleComplete !== false;
    const preservePendingTrafficLifecycle = data._preservePendingTrafficLifecycle === true;
    delete data._trafficClearGeneration;
    delete data._trafficLifecycleToken;
    delete data._trafficLifecycleComplete;
    delete data._preservePendingTrafficLifecycle;
    const trafficIdentityKey = this._trafficIdentityKey(data.id, data.trafficLifecycleId ?? null);
    const parentTrafficIdentityKey = data.protocol === 'ws-frame'
      ? this._trafficIdentityKey(data.parentId, data.parentTrafficLifecycleId ?? null)
      : null;
    const retainedGenerations = this._retainedTrafficGenerations.get(trafficIdentityKey);
    const retainedParentGenerations = parentTrafficIdentityKey
      ? this._retainedTrafficGenerations.get(parentTrafficIdentityKey)
      : null;
    const retainedAcrossClear = retainedGenerations?.has(trafficClearGeneration) === true ||
      retainedParentGenerations?.has(trafficClearGeneration) === true;
    if (trafficClearGeneration !== undefined &&
        trafficClearGeneration !== this._trafficClearGeneration &&
        !retainedAcrossClear) {
      this._activeTrafficIdentities.delete(trafficIdentityKey);
      if (trafficLifecycleComplete && this._deletedTrafficIdentities.has(trafficIdentityKey)) {
        this._deletedTrafficIdentities.set(
          trafficIdentityKey,
          this._clearedPendingTrafficNow() + this.clearedPendingTrafficTtlMs
        );
        this._pruneDeletedTrafficIdentities();
      }
      if (data._update || trafficLifecycleToken !== undefined) {
        this._completePendingTrafficLifecycle(data.id, trafficLifecycleToken);
        this._clearedPendingTrafficIds.delete(data.id);
        this._maybeAutoRotateProxyOnError(data);
      }
      return;
    }
    if (trafficLifecycleComplete) {
      this._activeTrafficIdentities.delete(trafficIdentityKey);
      this._retainedTrafficGenerations.delete(trafficIdentityKey);
    } else {
      this._activeTrafficIdentities.add(trafficIdentityKey);
    }

    const deletedIdentityKey = trafficIdentityKey;
    const deletedParentIdentityKey = parentTrafficIdentityKey;
    const deletedOwnIdentity = this._deletedTrafficIdentities.has(deletedIdentityKey);
    if (deletedOwnIdentity ||
        (deletedParentIdentityKey && this._deletedTrafficIdentities.has(deletedParentIdentityKey))) {
      if (deletedOwnIdentity && trafficLifecycleComplete) {
        this._deletedTrafficIdentities.set(
          deletedIdentityKey,
          this._clearedPendingTrafficNow() + this.clearedPendingTrafficTtlMs
        );
        this._pruneDeletedTrafficIdentities();
      }
      delete data._update;
      delete data._mergeUpdate;
      this._completePendingTrafficLifecycle(data.id, trafficLifecycleToken);
      this._maybeAutoRotateProxyOnError(data);
      return;
    }

    if (data._update) {
      // Update an existing pending request in-place
      delete data._update;
      const mergeUpdate = data._mergeUpdate === true;
      delete data._mergeUpdate;
      this._completePendingTrafficLifecycle(data.id, trafficLifecycleToken);
      if (this._clearedPendingTrafficIds.delete(data.id)) {
        this._maybeAutoRotateProxyOnError(data);
        return;
      }
      const idx = this.trafficLog.findIndex(r =>
        r.id === data.id &&
        (data.trafficLifecycleId === undefined ||
          r.trafficLifecycleId === data.trafficLifecycleId)
      );
      if (idx !== -1) {
        const existing = this.trafficLog[idx];
        if (mergeUpdate) data = { ...existing, ...data };
        else if (Object.hasOwn(existing, 'pinned') && !Object.hasOwn(data, 'pinned')) {
          data.pinned = existing.pinned;
        }
        this.trafficLog[idx] = data;
        this._broadcast({ type: 'request-update', data });
      } else {
        // A completion whose pending row was evicted must be surfaced as a new
        // row so backend and renderer state stay consistent.
        this.trafficLog.push(data);
        this._trimTrafficLog();
        this._broadcast({ type: 'request', data });
      }
      this._maybeAutoRotateProxyOnError(data);
    } else {
      // New request (pending or complete)
      this._retainedTrafficGenerations.delete(trafficIdentityKey);
      this._clearedPendingTrafficIds.delete(data.id);
      if (data._pending) {
        this._addPendingTrafficLifecycle(data.id, trafficLifecycleToken);
        Object.defineProperty(data, '_trafficClearGeneration', {
          value: this._trafficClearGeneration,
          configurable: true
        });
      } else if (!preservePendingTrafficLifecycle) {
        this._completePendingTrafficLifecycle(data.id, trafficLifecycleToken);
      }
      delete data._pending;
      this.trafficLog.push(data);
      this._trimTrafficLog();
      this._broadcast({ type: 'request', data });
    }
  }

  _broadcast(message) {
    this._broadcastSequence([message]);
  }

  onSuppressedTrafficCompletion(data) {
    this._maybeAutoRotateProxyOnError(data);
    return false;
  }

  _broadcastSequence(messages) {
    const payloads = messages.map(message => JSON.stringify(message));
    for (const client of this.clients) {
      let queue = this._clientBroadcastQueues.get(client);
      if (!queue) {
        queue = { payloads: [], sending: false };
        this._clientBroadcastQueues.set(client, queue);
      }
      queue.payloads.push(...payloads);
      this._drainClientBroadcastQueue(client, queue);
    }
  }

  _drainClientBroadcastQueue(client, queue) {
    if (queue.sending) return;
    const json = queue.payloads.shift();
    if (json === undefined) return;
    queue.sending = true;
    try {
      if (client.readyState !== 1) { // OPEN
        this._evictWebSocketClient(client);
        return;
      }
      const bufferedBytes = Number(client.bufferedAmount);
      const messageBytes = Buffer.byteLength(json);
      if (!Number.isFinite(bufferedBytes) || bufferedBytes < 0 ||
          bufferedBytes + messageBytes > this.maxWsBufferedBytes) {
        this._evictWebSocketClient(client);
        return;
      }
      client.send(json, err => {
        if (err) {
          this._evictWebSocketClient(client);
          return;
        }
        queue.sending = false;
        queueMicrotask(() => this._drainClientBroadcastQueue(client, queue));
      });
    } catch {
      this._evictWebSocketClient(client);
    }
  }

  _evictWebSocketClient(client) {
    if (!this.clients.delete(client)) return;
    const queue = this._clientBroadcastQueues.get(client);
    if (queue) {
      queue.payloads.length = 0;
      queue.sending = false;
    }
    try {
      client.terminate?.();
    } catch {}
  }

  start() {
    if (this._stopPromise) return this._stopPromise.then(() => this.start());
    if (this._startPromise) return this._startPromise;
    if (this.httpServer?.listening && !this._stopping) return Promise.resolve(this.port);

    this._stopping = false;
    const server = http.createServer(this.app);
    const wss = new WebSocketServer({ noServer: true });
    this.httpServer = server;
    this.wss = wss;

    const startPromise = new Promise((resolve, reject) => {
      let settled = false;
      const resolveStart = () => {
        if (settled) return;
        settled = true;
        resolve(this.port);
      };
      const rejectStart = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      this._cancelStart = () => rejectStart(new Error('API server startup cancelled by shutdown'));

      server.on('connection', (socket) => {
        this._httpSockets.add(socket);
        socket.once('close', () => this._httpSockets.delete(socket));
        if (this._stopping || this.httpServer !== server) socket.destroy();
      });

      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`[API] Port ${this.port} is already in use. Try: API_PORT=<other_port> npm start`);
        }
        rejectStart(err);
      });

      server.on('upgrade', (request, socket, head) => {
        if (this._stopping || this.httpServer !== server || this.wss !== wss) {
          socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
          return;
        }
        let pathname;
        try {
          pathname = new URL(request.url, 'http://127.0.0.1').pathname;
        } catch {
          socket.destroy();
          return;
        }

        if (pathname === '/ws') {
          if (!this._isAllowedBrowserOrigin(request.headers.origin)) {
            socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
            return;
          }
          if (!this._isAuthorizedRequest(request)) {
            socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
            return;
          }
          try {
            wss.handleUpgrade(request, socket, head, (ws) => {
              let terminated = false;
              const removeTrackedClient = () => {
                if (!this.clients.delete(ws)) return;
                console.log(`[API] WebSocket client disconnected (${this.clients.size} total)`);
              };
              const terminatePeer = () => {
                if (terminated) return;
                terminated = true;
                try { ws.terminate(); } catch {}
              };

              // Protocol/parser failures are peer-scoped WebSocket errors. Attach
              // this before emitting `connection` so even malformed upgrade head
              // bytes cannot become an unhandled EventEmitter error.
              ws.on('error', (error) => {
                console.warn(`[API] WebSocket client error: ${error.message}`);
                removeTrackedClient();
                terminatePeer();
              });
              ws.on('close', removeTrackedClient);

              if (this._stopping || this.httpServer !== server || this.wss !== wss) {
                terminatePeer();
                return;
              }
              wss.emit('connection', ws, request);
            });
          } catch {
            socket.destroy();
          }
        } else {
          socket.destroy();
        }
      });

      wss.on('connection', (ws) => {
        if (this._stopping || this.wss !== wss) {
          ws.terminate();
          return;
        }
        this.clients.add(ws);
        console.log(`[API] WebSocket client connected (${this.clients.size} total)`);

        // Send current traffic count
        ws.send(JSON.stringify({
          type: 'init',
          trafficCount: this.trafficLog.length,
          trafficLimit: this.maxTrafficLog,
          capturePaused: this.capturePaused,
          captureStateSessionId: this.captureStateSessionId,
          captureStateRevision: this.captureStateRevision,
          proxyPort: this.proxy.port,
          apiPort: this.port
        }));

        ws.on('message', (message) => {
          try {
            const msg = JSON.parse(message);
            this._handleWsMessage(ws, msg);
          } catch (err) {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid message' }));
          }
        });
      });

      server.listen(this.port, '127.0.0.1', () => {
        console.log(`[API] Management API listening on http://127.0.0.1:${this.port}`);
        console.log(`[API] WebSocket available at ws://127.0.0.1:${this.port}/ws`);
        resolveStart();
      });
    });

    this._startPromise = startPromise;
    void startPromise.then(
      () => {
        if (this._startPromise === startPromise) this._startPromise = null;
        this._cancelStart = null;
      },
      () => {
        if (this._startPromise === startPromise) this._startPromise = null;
        this._cancelStart = null;
        if (this.httpServer === server) this.httpServer = null;
        if (this.wss === wss) this.wss = null;
        try { wss.close(); } catch {}
      }
    );
    return startPromise;
  }

  _handleWsMessage(ws, msg) {
    switch (msg.type) {
      case 'get-traffic':
        ws.send(JSON.stringify({
          type: 'traffic-dump',
          requests: this.trafficLog.slice(-(msg.limit || 100))
        }));
        break;
      case 'clear-traffic':
        this._clearTraffic();
        break;
      default:
        ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${msg.type}` }));
    }
  }

  _clearTraffic() {
    const clearId = crypto.randomUUID();
    const revision = ++this._trafficClearRevision;
    const pinRevision = this._trafficPinRevision;
    const expiresAt = this._clearedPendingTrafficNow() + this.clearedPendingTrafficTtlMs;
    const retainedRequests = this.trafficLog.filter(request =>
      request?.pinned === true && request.protocol !== 'ws-frame'
    );
    const retainedTraffic = retainedRequests.map(request => ({ ...request }));
    const retainedIdentityKeys = new Set(retainedRequests.map(request =>
      this._trafficIdentityKey(request.id, request.trafficLifecycleId ?? null)
    ));
    const retainedPendingIds = new Set(retainedRequests.map(request => request.id));
    for (const id of this._pendingTrafficIds) {
      if (retainedPendingIds.has(id)) continue;
      this._clearedPendingTrafficIds.delete(id);
      this._clearedPendingTrafficIds.set(id, expiresAt);
    }
    const retainedGenerations = new Map();
    for (const identityKey of retainedIdentityKeys) {
      if (this._activeTrafficIdentities.has(identityKey)) {
        const existingGeneration = this._retainedTrafficGenerations
          .get(identityKey)?.values().next().value;
        retainedGenerations.set(identityKey, new Set([
          existingGeneration ?? this._trafficClearGeneration
        ]));
      }
    }
    this._retainedTrafficGenerations = retainedGenerations;
    this._trafficClearGeneration = Symbol('traffic-clear-generation');
    this._pruneClearedPendingTrafficIds();
    for (const id of this._pendingTrafficIds) {
      if (!retainedPendingIds.has(id)) this._pendingTrafficIds.delete(id);
    }
    for (const id of this._pendingTrafficLifecycles.keys()) {
      if (!retainedPendingIds.has(id)) this._pendingTrafficLifecycles.delete(id);
    }
    for (const identityKey of this._activeTrafficIdentities) {
      if (!retainedIdentityKeys.has(identityKey)) this._activeTrafficIdentities.delete(identityKey);
    }
    this._deletedTrafficIdentities.clear();
    this.trafficLog = retainedRequests;
    const result = { clearId, revision, pinRevision, retainedTraffic };
    this._broadcastTrafficCleared(clearId, retainedTraffic, revision, pinRevision);
    return result;
  }

  _pruneClearedPendingTrafficIds(now = this._clearedPendingTrafficNow()) {
    for (const [id, expiresAt] of this._clearedPendingTrafficIds) {
      if (expiresAt > now) break;
      this._clearedPendingTrafficIds.delete(id);
    }
    while (this._clearedPendingTrafficIds.size > this.maxClearedPendingTrafficIds) {
      const oldestId = this._clearedPendingTrafficIds.keys().next().value;
      this._clearedPendingTrafficIds.delete(oldestId);
    }
  }

  _trafficIdentityKey(id, trafficLifecycleId) {
    return JSON.stringify([String(id), trafficLifecycleId ?? null]);
  }

  _pruneDeletedTrafficIdentities(now = this._clearedPendingTrafficNow()) {
    for (const [identityKey, expiresAt] of this._deletedTrafficIdentities) {
      if (Number.isFinite(expiresAt) && expiresAt <= now) {
        this._deletedTrafficIdentities.delete(identityKey);
      }
    }
    let retainedCompletedIdentities = 0;
    for (const expiresAt of this._deletedTrafficIdentities.values()) {
      if (Number.isFinite(expiresAt)) retainedCompletedIdentities++;
    }
    if (retainedCompletedIdentities <= this.maxClearedPendingTrafficIds) return;
    for (const [identityKey, expiresAt] of this._deletedTrafficIdentities) {
      if (!Number.isFinite(expiresAt)) continue;
      this._deletedTrafficIdentities.delete(identityKey);
      retainedCompletedIdentities--;
      if (retainedCompletedIdentities <= this.maxClearedPendingTrafficIds) break;
    }
  }

  setMcpBridge(bridge) {
    this.mcpBridge = bridge;
  }

  setShutdownHandler(handler) {
    this.onShutdown = handler;
  }

  stop() {
    if (this._stopPromise) return this._stopPromise;
    this._stopping = true;
    this._cancelStart?.();
    const server = this.httpServer;
    const wss = this.wss;

    if (!server && !wss) {
      this._stopping = false;
      return Promise.resolve();
    }

    const closePromise = Promise.all([
      new Promise((resolve) => {
        if (!wss) {
          resolve();
          return;
        }
        const clients = new Set([...this.clients, ...wss.clients]);
        for (const client of clients) {
          try { client.close(1001, 'Server shutting down'); } catch {}
          try { client.terminate(); } catch {}
        }
        this.clients.clear();
        try { wss.close(() => resolve()); } catch { resolve(); }
      }),
      new Promise((resolve) => {
        if (!server) {
          resolve();
          return;
        }
        try { server.close(() => resolve()); } catch { resolve(); }
        for (const socket of this._httpSockets) socket.destroy();
        server.closeAllConnections?.();
      })
    ]).then(() => undefined);
    let shutdownTimer;
    const stopPromise = Promise.race([
      closePromise,
      new Promise(resolve => {
        shutdownTimer = setTimeout(resolve, this.shutdownTimeoutMs);
      })
    ]).finally(() => clearTimeout(shutdownTimer));

    this._stopPromise = stopPromise;
    void stopPromise.then(() => {
      if (this.httpServer === server) this.httpServer = null;
      if (this.wss === wss) this.wss = null;
      this._httpSockets.clear();
      this.clients.clear();
      this._stopping = false;
      if (this._stopPromise === stopPromise) this._stopPromise = null;
    });
    return stopPromise;
  }
}
