import express from 'express';
import http from 'http';
import https from 'https';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { WebSocketServer } from 'ws';
import os from 'os';
import { trafficToHar } from './har-converter.js';
import { validateOpenApiSubmission } from './openapi-validation.js';
import { validatePortRange } from '../proxy/port-range.js';
import { UpstreamProxyConfigError } from '../proxy/upstream-proxy-config.js';

const DEFAULT_GENERATOR_DIR = '/mnt/b/bots/generator';
// A slow UI client is disconnected before pending broadcasts exceed 16 MiB.
export const DEFAULT_MAX_WS_BUFFERED_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MANAGEMENT_REQUEST_TIMEOUT_MS = 30000;

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
  const mimeType = String(body.mimeType || fallbackMimeType).replace(/[\r\n,]/g, '') || fallbackMimeType;
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

function hasCompleteMockMatchers(matchers) {
  if (!Array.isArray(matchers) || matchers.length === 0) return false;
  const nameMatchers = new Set(['header', 'query', 'cookie', 'form-data', 'multipart-form-data']);
  const valueOptionalMatchers = new Set(['wildcard', 'raw-body-exact', 'exact-query']);
  return matchers.every(matcher => {
    if (!matcher || typeof matcher.type !== 'string') return false;
    if (nameMatchers.has(matcher.type)) return typeof matcher.name === 'string' && matcher.name.trim().length > 0;
    if (valueOptionalMatchers.has(matcher.type)) return true;
    return typeof matcher.value === 'string' && matcher.value.trim().length > 0;
  });
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
  const normalizedRule = { ...rule };
  delete normalizedRule.id;

  if (rule.type === 'group') {
    if (!allowGroup || !Array.isArray(rule.items)) return null;
    const items = rule.items.map(item => normalizeImportedMockRule(item, false));
    if (items.some(item => !item)) return null;
    return {
      ...normalizedRule,
      enabled: rule.enabled !== false,
      items
    };
  }

  const hasNewFormat = hasCompleteMockMatchers(rule.matchers)
    && rule.action && typeof rule.action === 'object' && !Array.isArray(rule.action);
  const hasLegacyFormat = typeof rule.urlPattern === 'string' && rule.urlPattern.length > 0
    && rule.response && typeof rule.response === 'object' && !Array.isArray(rule.response);
  if (!hasNewFormat && !hasLegacyFormat) return null;

  return {
    ...normalizedRule,
    enabled: rule.enabled !== false,
    priority: rule.priority || 'normal'
  };
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
    this._httpSockets = new Set();
    this._startPromise = null;
    this._cancelStart = null;
    this._stopPromise = null;
    this._stopping = false;
    this.trafficLog = []; // In-memory traffic log
    this.maxTrafficLog = 10000;
    this._pendingTrafficIds = new Set();
    this._clearedPendingTrafficIds = new Set();
    this.authToken = options.authToken || null;
    this.onShutdown = options.onShutdown || null;
    this.autoRotateProxy = { enabled: false, provider: 'lemonprime' };
    this._autoRotateInFlight = false;
    this._autoRotatePromise = null;
    this._lastAutoRotateAt = 0;
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

  _runPythonJson(script, args = []) {
    return new Promise((resolve, reject) => {
      execFile('python3', ['-c', script, ...args], { timeout: 30000 }, (error, stdout, stderr) => {
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

  async _getBottingToolsProxy(provider = 'lemonprime', refill = true) {
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
    return this._runPythonJson(script, [String(provider || 'lemonprime'), refill ? 'true' : 'false']);
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

  _getHarExportTraffic() {
    const hideTunnelRequests = this.settings?.get('hideTunnelRequests', true) !== false;
    const filterSafeFonts = this.settings?.get('filterSafeFonts', false) === true;
    return this.trafficLog.filter(req => {
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
      'parentId'
    ];
    const bodySizeFields = [
      'requestBodySize', 'responseBodySize',
      'requestBodyDecodedSize', 'responseBodyDecodedSize'
    ];
    const capturedSizeFields = ['requestBodyCapturedSize', 'responseBodyCapturedSize'];
    const numberFields = ['statusCode', 'duration', ...bodySizeFields, ...capturedSizeFields];

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
      if (request.protocol === 'ws-frame' &&
          (typeof request.parentId !== 'string' || request.parentId.length === 0)) {
        return `requests[${index}].parentId must be a non-empty string for WebSocket frames`;
      }
      for (const field of numberFields) {
        if (request[field] !== undefined && request[field] !== null && !Number.isFinite(request[field])) {
          return `requests[${index}].${field} must be a finite number`;
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
            request[field] < 0 && request[field] !== -1) {
          return `requests[${index}].${field} must be non-negative or -1 for an unknown size`;
        }
      }
      for (const field of capturedSizeFields) {
        if (request[field] !== undefined && request[field] !== null && request[field] < 0) {
          return `requests[${index}].${field} must be non-negative`;
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

  _getGeneratorPythonCandidates() {
    if (process.env.GENERATOR_PYTHON) {
      return [{ command: process.env.GENERATOR_PYTHON, args: [] }];
    }

    if (process.platform === 'win32') {
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

    // Version
    router.get('/api/version', (req, res) => {
      res.json({ version: '1.0.0', name: 'HTTP FreeKit' });
    });

    // Config
    router.get('/api/config', (req, res) => {
      const certInfo = this.ca.getCertInfo();
      const networkInterfaces = os.networkInterfaces();
      res.json({
        config: {
          ...certInfo,
          networkInterfaces,
          proxyPort: this.proxy.port,
          apiPort: this.port
        }
      });
    });

    router.get('/api/ui-settings', (req, res) => {
      const filterSafeFonts = this.settings?.get('filterSafeFonts', false) === true;
      this.proxy.filterSafeFonts = filterSafeFonts;
      res.json({
        hideTunnelRequests: this.settings?.get('hideTunnelRequests', true) !== false,
        filterSafeFonts
      });
    });

    router.post('/api/ui-settings', (req, res) => {
      const hideTunnelRequests = Object.prototype.hasOwnProperty.call(req.body || {}, 'hideTunnelRequests')
        ? req.body.hideTunnelRequests !== false
        : this.settings?.get('hideTunnelRequests', true) !== false;
      const filterSafeFonts = Object.prototype.hasOwnProperty.call(req.body || {}, 'filterSafeFonts')
        ? req.body.filterSafeFonts === true
        : this.settings?.get('filterSafeFonts', false) === true;
      this._runPersistedMutation({
        capture: () => this.proxy.filterSafeFonts,
        apply: () => { this.proxy.filterSafeFonts = filterSafeFonts; },
        persist: () => this._persistSettings({ hideTunnelRequests, filterSafeFonts }),
        restore: previous => { this.proxy.filterSafeFonts = previous; }
      });
      res.json({ success: true, hideTunnelRequests, filterSafeFonts });
    });

    // Proxy stats
    router.get('/api/stats', (req, res) => {
      res.json({
        proxy: this.proxy.getStats(),
        traffic: {
          total: this.trafficLog.length,
          clients: this.clients.size
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

      let filtered = this.trafficLog;
      if (filter) {
        const lowerFilter = filter.toLowerCase();
        filtered = this.trafficLog.filter(r =>
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

    // Clear traffic
    router.post('/api/traffic/clear', (req, res) => {
      const clearId = this._clearTraffic();
      res.json({ success: true, clearId });
    });

    // Export traffic (JSON)
    router.get('/api/traffic/export', (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename=http-freekit-export.json');
      res.json({
        exported: new Date().toISOString(),
        tool: 'HTTP FreeKit',
        version: '1.0.0',
        requests: this.trafficLog
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

      let results = this.trafficLog;

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
      const request = this.trafficLog.find(r => r.id === req.params.id);
      if (!request) return res.status(404).json({ error: 'Request not found' });
      res.json(request);
    });

    // Import traffic
    router.post('/api/traffic/import', (req, res) => {
      try {
        const { requests } = req.body;
        const validationError = this._getTrafficImportValidationError(requests);
        if (validationError) {
          return res.status(400).json({ error: `Invalid import format: ${validationError}` });
        }
        this._appendImportedTraffic(requests);
        this._broadcast({ type: 'traffic-imported', count: requests.length });
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
          const responseBodyDecodedSize = entry.response?.content?.size === undefined
            ? undefined
            : normalizeHarBodySize(entry.response.content.size);

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
            duration: entry.time || 0,
            timestamp: Number.isFinite(parsedTimestamp) ? parsedTimestamp : importTimestamp,
            source: 'import'
          };
        });

        const validationError = this._getTrafficImportValidationError(imported);
        if (validationError) {
          return res.status(400).json({ error: `Invalid HAR format: ${validationError}` });
        }
        this._appendImportedTraffic(imported);
        this._broadcast({ type: 'traffic-imported', count: imported.length });
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
        res.status(interceptorOperationErrorStatus(err, 500)).json({ error: err.message });
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
      const body = req.body;

      if (body.matchers && body.action) {
        if (!hasCompleteMockMatchers(body.matchers)) {
          return res.status(400).json({ error: 'At least one complete matcher is required' });
        }
        // New format
        const rule = this._mutateRules('mockRules', 'mockRules', () => this.proxy.addMockRule({
          enabled: body.enabled !== undefined ? body.enabled : true,
          priority: body.priority || 'normal',
          matchers: body.matchers,
          preSteps: body.preSteps || undefined,
          action: body.action
        }));
        return res.json({ success: true, rule });
      }

      // Legacy format
      const { method, urlPattern, response } = body;
      if (!urlPattern && !body.matchers) {
        return res.status(400).json({ error: 'matchers+action or urlPattern+response are required' });
      }
      const rule = this._mutateRules('mockRules', 'mockRules', () => this.proxy.addMockRule({
        method: method || '*',
        urlPattern,
        enabled: true,
        priority: 'normal',
        response: {
          status: response?.status || 200,
          headers: response?.headers || { 'Content-Type': 'application/json' },
          body: response?.body || ''
        }
      }));
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
      if (req.body?.matchers && !hasCompleteMockMatchers(req.body.matchers)) {
        return res.status(400).json({ error: 'At least one complete matcher is required' });
      }
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
      if (items.some(item => item?.type === 'group')) {
        return res.status(400).json({ error: 'Mock groups cannot contain other groups' });
      }
      const group = this._mutateRules('mockRules', 'mockRules', () => this.proxy.addMockRule({
        type: 'group',
        title: req.body.title || 'New Group',
        enabled: true,
        items,
        collapsed: false
      }));
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
      const success = this.proxy.resumeBreakpoint(req.params.requestId, req.body);
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
      const result = this.proxy.addApiSpec(validation.value);
      res.json({ success: true, spec: { id: result.id, title: result.title, baseUrl: result.baseUrl } });
    });

    router.delete('/api/specs/:id', (req, res) => {
      this.proxy.removeApiSpec(req.params.id);
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
      if (!this.mcpBridge) return res.json({ enabled: false, sseEndpoint: null, connectedClients: 0 });
      const status = this.mcpBridge.getStatus();
      if (status.enabled) {
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
      const { enabled } = req.body;
      await this.mcpBridge.setEnabled(!!enabled);
      if (enabled) {
        this.mcpBridge.startSse(this.app);
      }
      res.json({ success: true, enabled: !!enabled });
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
    const incomingStart = Math.max(0, requests.length - limit);
    const incomingCount = requests.length - incomingStart;
    const existingCount = Math.min(this.trafficLog.length, limit - incomingCount);
    const existingIds = new Set(this.trafficLog.map(request => request.id));
    const reservedIds = new Set(existingIds);
    for (const request of requests) reservedIds.add(request.id);

    if (this.trafficLog.length > existingCount) {
      this.trafficLog.splice(0, this.trafficLog.length - existingCount);
    }
    const assignedIds = new Set(this.trafficLog.map(request => request.id));
    for (let index = incomingStart; index < requests.length; index++) {
      const request = requests[index];
      let id = request.id;
      if (existingIds.has(id) || assignedIds.has(id)) {
        do {
          id = crypto.randomUUID();
        } while (reservedIds.has(id) || assignedIds.has(id));
      }
      reservedIds.add(id);
      assignedIds.add(id);
      this.trafficLog.push({ ...request, id });
    }
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
      const isHttps = parsedUrl.protocol === 'https:';
      const lib = isHttps ? https : http;

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        headers: outboundHeaders,
        ...(isHttps ? this.proxy._getUpstreamTlsOptions(parsedUrl.hostname) : {})
      };

      const startTime = Date.now();
      const connectTimeoutMs = this.sendConnectTimeoutMs ?? 10000;
      const idleTimeoutMs = this.sendIdleTimeoutMs ?? 30000;
      const totalTimeoutMs = this.sendTotalTimeoutMs ?? 60000;
      let settled = false;
      let connectTimer;
      let totalTimer;
      let req;
      const cleanup = () => {
        clearTimeout(connectTimer);
        clearTimeout(totalTimer);
        req?.setTimeout(0);
        signal?.removeEventListener('abort', abortRequest);
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
          succeed({
            statusCode: res.statusCode,
            statusMessage: res.statusMessage,
            headers: res.headers,
            body: responseBody.toString('utf8'),
            duration: Date.now() - startTime
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
        const connectedEvent = isHttps ? 'secureConnect' : 'connect';
        if (!socket.connecting && (!isHttps || socket.encrypted)) {
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

  onTrafficEvent(data) {
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

    if (data._update) {
      // Update an existing pending request in-place
      delete data._update;
      this._pendingTrafficIds.delete(data.id);
      if (this._clearedPendingTrafficIds.delete(data.id)) {
        this._maybeAutoRotateProxyOnError(data);
        return;
      }
      const idx = this.trafficLog.findIndex(r => r.id === data.id);
      if (idx !== -1) {
        this.trafficLog[idx] = data;
      } else {
        this.trafficLog.push(data);
        if (this.trafficLog.length > this.maxTrafficLog) {
          this.trafficLog.shift();
        }
      }
      this._broadcast({ type: 'request-update', data });
      this._maybeAutoRotateProxyOnError(data);
    } else {
      // New request (pending or complete)
      this._clearedPendingTrafficIds.delete(data.id);
      if (data._pending) this._pendingTrafficIds.add(data.id);
      else this._pendingTrafficIds.delete(data.id);
      delete data._pending;
      this.trafficLog.push(data);
      if (this.trafficLog.length > this.maxTrafficLog) {
        this.trafficLog.shift();
      }
      this._broadcast({ type: 'request', data });
    }
  }

  _broadcast(message) {
    const json = JSON.stringify(message);
    const messageBytes = Buffer.byteLength(json);
    for (const client of this.clients) {
      try {
        if (client.readyState !== 1) { // OPEN
          this._evictWebSocketClient(client);
          continue;
        }
        const bufferedBytes = Number(client.bufferedAmount);
        if (!Number.isFinite(bufferedBytes) || bufferedBytes < 0 ||
            bufferedBytes + messageBytes > this.maxWsBufferedBytes) {
          this._evictWebSocketClient(client);
          continue;
        }
        client.send(json, err => {
          if (err) this._evictWebSocketClient(client);
        });
      } catch {
        this._evictWebSocketClient(client);
      }
    }
  }

  _evictWebSocketClient(client) {
    if (!this.clients.delete(client)) return;
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
    for (const id of this._pendingTrafficIds) this._clearedPendingTrafficIds.add(id);
    this._pendingTrafficIds.clear();
    this.trafficLog = [];
    this._broadcast({ type: 'traffic-cleared', clearId });
    return clearId;
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
