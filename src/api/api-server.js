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

const DEFAULT_GENERATOR_DIR = '/mnt/b/bots/generator';

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
  if (!body || body.text === undefined || body.text === null) return '';
  const text = String(body.text);
  if (String(body.encoding || '').toLowerCase() !== 'base64') return text;
  const mimeType = String(body.mimeType || fallbackMimeType).replace(/[\r\n,]/g, '') || fallbackMimeType;
  return `data:${mimeType};base64,${text.replace(/\s+/g, '')}`;
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
    this.trafficLog = []; // In-memory traffic log
    this.maxTrafficLog = 10000;
    this.authToken = options.authToken || null;
    this.autoRotateProxy = { enabled: false, provider: 'lemonprime' };
    this._autoRotateInFlight = false;
    this._autoRotatePromise = null;
    this._lastAutoRotateAt = 0;

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
    this.autoRotateProxy = {
      enabled: !!config.enabled,
      provider: String(config.provider || 'lemonprime').trim() || 'lemonprime'
    };
    this.settings?.set('autoRotateProxyOnError', this.autoRotateProxy);
    return this.autoRotateProxy;
  }

  async _rotateBottingToolsProxy(provider, refill = true) {
    const proxy = await this._getBottingToolsProxy(provider, refill);
    const upstreamProxy = {
      host: proxy.host,
      port: proxy.port,
      auth: proxy.auth || null,
      type: proxy.type || 'http'
    };
    this.proxy.setUpstreamProxy(upstreamProxy);
    this.settings?.set('upstreamProxy', this.proxy.upstreamProxy);
    return { provider: proxy.provider, upstreamProxy: this.proxy.upstreamProxy };
  }

  _maybeAutoRotateProxyOnError(data) {
    const config = this._getAutoRotateProxyConfig();
    const reason = this._getAutoRotateProxyReason(data);
    if (!config.enabled || !this.proxy.upstreamProxy || !reason) return;

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
        this._broadcast({
          type: 'proxy-auto-rotate',
          status: 'success',
          provider: result.provider,
          upstreamProxy: result.upstreamProxy
        });
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
      'statusMessage', 'protocol', 'source'
    ];
    const numberFields = ['statusCode', 'duration', 'requestBodySize', 'responseBodySize'];

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
      for (const field of numberFields) {
        if (request[field] !== undefined && request[field] !== null && !Number.isFinite(request[field])) {
          return `requests[${index}].${field} must be a finite number`;
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

  async _exportToGenerator() {
    const generatorDir = this._getGeneratorDir();
    const pythonCandidates = this._getGeneratorPythonCandidates();
    const sessionName = this._sanitizeGeneratorSessionName(
      `http-freekit-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}`
    );
    const harBaseDir = await this._getGeneratorHarBaseDir(generatorDir, pythonCandidates);
    const sessionDir = path.join(harBaseDir, sessionName);
    const harPath = path.join(sessionDir, `${sessionName}.har`);
    const har = trafficToHar(this._getHarExportTraffic(), { maskSensitive: false });

    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(harPath, JSON.stringify(har, null, 2), 'utf8');

    await this._spawnGeneratorPython(
      this._getGeneratorLaunchPythonCandidates(pythonCandidates),
      ['main_app.py', '--session', sessionName],
      { cwd: generatorDir }
    );

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

    this.app.use(express.json({ limit: '50mb' }));

    // Request timeout
    this.app.use((req, res, next) => {
      req.setTimeout(30000);
      next();
    });
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
      this.settings?.set('hideTunnelRequests', hideTunnelRequests);
      this.settings?.set('filterSafeFonts', filterSafeFonts);
      this.proxy.filterSafeFonts = filterSafeFonts;
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
      const limit = parseInt(req.query.limit) || 100;
      const offset = parseInt(req.query.offset) || 0;
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
      this.trafficLog = [];
      this._broadcast({ type: 'traffic-cleared' });
      res.json({ success: true });
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
        this.trafficLog.push(...requests);
        // Enforce max traffic log size after import
        while (this.trafficLog.length > this.maxTrafficLog) {
          this.trafficLog.shift();
        }
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

          return {
            id: crypto.randomUUID(),
            protocol: entry.request.url?.startsWith('https') ? 'https' : 'http',
            method: entry.request.method || 'GET',
            url: entry.request.url || '',
            host,
            path: pathname + search,
            requestHeaders: harHeadersToObject(entry.request.headers),
            requestBody: harBodyToTraffic(entry.request.postData),
            requestBodySize: entry.request.bodySize || 0,
            statusCode: entry.response?.status || 0,
            statusMessage: entry.response?.statusText || '',
            responseHeaders: harHeadersToObject(entry.response?.headers),
            responseBody: harBodyToTraffic(entry.response?.content),
            responseBodySize: entry.response?.content?.size || 0,
            duration: entry.time || 0,
            timestamp: new Date(entry.startedDateTime).getTime() || Date.now(),
            source: 'import'
          };
        });

        this.trafficLog.push(...imported);
        // Enforce max traffic log size after import
        while (this.trafficLog.length > this.maxTrafficLog) {
          this.trafficLog.shift();
        }
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
        res.json(result);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    router.post('/api/interceptors/:id/deactivate', async (req, res) => {
      try {
        await this.interceptors.deactivate(req.params.id);
        res.json({ success: true });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    router.post('/api/interceptors/:id/focus', async (req, res) => {
      try {
        const result = await this.interceptors.focus(req.params.id);
        res.json({ success: true, ...(result || {}) });
      } catch (err) {
        res.status(500).json({ error: err.message });
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
        res.status(400).json({ error: err.message });
      }
    });

    // Mock rules
    router.get('/api/mock-rules', (req, res) => {
      res.json({ rules: this.proxy.mockRules });
    });

    router.post('/api/mock-rules', (req, res) => {
      // Support new format (matchers + action) and legacy format (method + urlPattern + response)
      const body = req.body;

      if (body.matchers && body.action) {
        // New format
        const rule = this.proxy.addMockRule({
          id: body.id || undefined,
          enabled: body.enabled !== undefined ? body.enabled : true,
          priority: body.priority || 'normal',
          matchers: body.matchers,
          preSteps: body.preSteps || undefined,
          action: body.action
        });
        this._persistMockRules();
        return res.json({ success: true, rule });
      }

      // Legacy format
      const { method, urlPattern, response } = body;
      if (!urlPattern && !body.matchers) {
        return res.status(400).json({ error: 'matchers+action or urlPattern+response are required' });
      }
      const rule = this.proxy.addMockRule({
        method: method || '*',
        urlPattern,
        enabled: true,
        priority: 'normal',
        response: {
          status: response?.status || 200,
          headers: response?.headers || { 'Content-Type': 'application/json' },
          body: response?.body || ''
        }
      });
      this._persistMockRules();
      res.json({ success: true, rule });
    });

    router.put('/api/mock-rules/:id', (req, res) => {
      const updated = this.proxy.updateMockRule(req.params.id, req.body);
      if (!updated) return res.status(404).json({ error: 'Rule not found' });
      this._persistMockRules();
      res.json({ success: true, rule: updated });
    });

    router.patch('/api/mock-rules/:id/toggle', (req, res) => {
      const toggled = this.proxy.toggleMockRule(req.params.id);
      if (!toggled) return res.status(404).json({ error: 'Rule not found' });
      this._persistMockRules();
      res.json({ success: true, rule: toggled });
    });

    router.post('/api/mock-rules/reorder', (req, res) => {
      const { ids } = req.body;
      if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array is required' });
      const rules = this.proxy.reorderMockRules(ids);
      this._persistMockRules();
      res.json({ success: true, rules });
    });

    // Create a rule group
    router.post('/api/mock-rules/group', (req, res) => {
      const group = {
        id: crypto.randomUUID(),
        type: 'group',
        title: req.body.title || 'New Group',
        enabled: true,
        items: req.body.items || [],
        collapsed: false
      };
      this.proxy.mockRules.push(group);
      this._persistMockRules();
      res.json({ success: true, group });
    });

    // Move a rule into a group
    router.post('/api/mock-rules/move-to-group', (req, res) => {
      const { ruleId, groupId } = req.body;
      if (ruleId === groupId) {
        return res.status(400).json({ error: 'A group cannot be moved into itself' });
      }
      const group = this.proxy.mockRules.find(r => r.id === groupId && r.type === 'group');
      if (!group) return res.status(404).json({ error: 'Group not found' });

      // Find and remove the rule from its current location
      const rule = this._removeRuleById(ruleId);
      if (!rule) return res.status(404).json({ error: 'Rule not found' });
      group.items.push(rule);
      this._persistMockRules();
      res.json({ success: true });
    });

    // Move a rule out of its group to top level
    router.post('/api/mock-rules/ungroup', (req, res) => {
      const { ruleId } = req.body;
      const rule = this._removeRuleById(ruleId);
      if (!rule) return res.status(404).json({ error: 'Rule not found' });
      this.proxy.mockRules.push(rule);
      this._persistMockRules();
      res.json({ success: true });
    });

    router.delete('/api/mock-rules/:id', (req, res) => {
      // Support both index (legacy) and UUID
      const param = req.params.id;
      const asInt = parseInt(param);
      if (!isNaN(asInt) && String(asInt) === param && asInt >= 0) {
        // Legacy: delete by index
        if (asInt >= this.proxy.mockRules.length) {
          return res.status(404).json({ error: 'Rule not found' });
        }
        this.proxy.removeMockRule(asInt);
      } else {
        // New: delete by ID
        const removed = this.proxy.removeMockRuleById(param);
        if (!removed) return res.status(404).json({ error: 'Rule not found' });
      }
      this._persistMockRules();
      res.json({ success: true });
    });

    router.delete('/api/mock-rules', (req, res) => {
      this.proxy.clearMockRules();
      this._persistMockRules();
      res.json({ success: true });
    });

    // Breakpoints
    router.get('/api/breakpoints', (req, res) => {
      res.json({ rules: this.proxy.getBreakpoints() });
    });

    router.post('/api/breakpoints', (req, res) => {
      const rule = this.proxy.addBreakpoint(req.body);
      res.json({ success: true, rule });
    });

    router.patch('/api/breakpoints/:id', (req, res) => {
      const updated = this.proxy.updateBreakpoint(req.params.id, req.body || {});
      if (!updated) return res.status(404).json({ error: 'Breakpoint not found' });
      res.json({ success: true, rule: updated });
    });

    // Pending breakpoints (paused requests) — must be before /:id to avoid matching "pending" as an id
    router.get('/api/breakpoints/pending', (req, res) => {
      res.json({ pending: this.proxy.getPendingBreakpoints() });
    });

    router.post('/api/breakpoints/pending/:requestId/resume', (req, res) => {
      const success = this.proxy.resumeBreakpoint(req.params.requestId, req.body);
      res.json({ success });
    });

    router.delete('/api/breakpoints/:id', (req, res) => {
      this.proxy.removeBreakpoint(req.params.id);
      res.json({ success: true });
    });

    // Upstream proxy
    router.get('/api/upstream-proxy', (req, res) => {
      res.json({ upstreamProxy: this.proxy.upstreamProxy });
    });

    router.post('/api/upstream-proxy', (req, res) => {
      const { host, port, auth, type } = req.body;
      this.proxy.setUpstreamProxy(host ? { host, port, auth, type } : null);
      this.settings?.set('upstreamProxy', this.proxy.upstreamProxy);
      res.json({ success: true, upstreamProxy: this.proxy.upstreamProxy });
    });

    router.delete('/api/upstream-proxy', (req, res) => {
      this.proxy.setUpstreamProxy(null);
      this.settings?.set('upstreamProxy', null);
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
        const result = await this._rotateBottingToolsProxy(provider, refill);
        const autoConfig = this._getAutoRotateProxyConfig();
        this._setAutoRotateProxyConfig({ ...autoConfig, provider: result.provider });
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
      this.proxy.setTlsPassthrough(hosts || []);
      this.settings?.set('tlsPassthrough', this.proxy.tlsPassthrough);
      res.json({ success: true, hosts: this.proxy.tlsPassthrough });
    });

    // Client certificates
    router.get('/api/client-certificates', (req, res) => {
      res.json({ certificates: this.proxy.clientCertificates });
    });
    router.post('/api/client-certificates', (req, res) => {
      this.proxy.setClientCertificates(req.body.certificates || []);
      this.settings?.set('clientCertificates', this.proxy.clientCertificates);
      res.json({ success: true });
    });

    // Trusted CAs
    router.get('/api/trusted-cas', (req, res) => {
      res.json({ cas: this.proxy.trustedCAs });
    });
    router.post('/api/trusted-cas', (req, res) => {
      this.proxy.setTrustedCAs(req.body.cas || []);
      this.settings?.set('trustedCAs', this.proxy.trustedCAs);
      res.json({ success: true });
    });

    // HTTPS whitelist
    router.get('/api/https-whitelist', (req, res) => {
      res.json({ hosts: this.proxy.httpsWhitelist });
    });
    router.post('/api/https-whitelist', (req, res) => {
      this.proxy.setHttpsWhitelist(req.body.hosts || []);
      this.settings?.set('httpsWhitelist', this.proxy.httpsWhitelist);
      res.json({ success: true });
    });

    // API Specs
    router.get('/api/specs', (req, res) => {
      res.json({ specs: this.proxy.getApiSpecs() });
    });

    router.post('/api/specs', (req, res) => {
      const { title, baseUrl, spec } = req.body;
      if (!spec) return res.status(400).json({ error: 'spec is required' });
      const result = this.proxy.addApiSpec({ title: title || 'Untitled API', baseUrl: baseUrl || '', spec });
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
      this.proxy.setHttp2Config(mode);
      this.settings?.set('http2Enabled', mode);
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
      this.proxy.setTlsFingerprint(fingerprint);
      this.settings?.set('tlsFingerprint', fingerprint);
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
      // Store for next restart (can't change port while running)
      this.proxy.minPort = parseInt(minPort) || 8000;
      this.proxy.maxPort = parseInt(maxPort) || 65535;
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
      res.json({ success: true });
      setTimeout(() => process.exit(0), 500);
    });

    // Send a test request through the proxy
    router.post('/api/send', async (req, res) => {
      try {
        const { url, method, headers, body, bodyEncoding } = req.body;
        const result = await this._sendRequest(url, method || 'GET', headers || {}, body || '', bodyEncoding || 'utf8');
        res.json(result);
      } catch (err) {
        res.status(500).json({ error: err.message });
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

  _removeRuleById(ruleId) {
    for (let i = 0; i < this.proxy.mockRules.length; i++) {
      if (this.proxy.mockRules[i].id === ruleId) {
        return this.proxy.mockRules.splice(i, 1)[0];
      }
      if (this.proxy.mockRules[i].type === 'group') {
        const items = this.proxy.mockRules[i].items || [];
        for (let j = 0; j < items.length; j++) {
          if (items[j].id === ruleId) {
            return items.splice(j, 1)[0];
          }
        }
      }
    }
    return null;
  }

  async _sendRequest(url, method, headers, body, bodyEncoding = 'utf8') {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const isHttps = parsedUrl.protocol === 'https:';
      const lib = isHttps ? https : http;

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        headers,
        rejectUnauthorized: false
      };

      const startTime = Date.now();
      const req = lib.request(options, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const responseBody = Buffer.concat(chunks);
          resolve({
            statusCode: res.statusCode,
            statusMessage: res.statusMessage,
            headers: res.headers,
            body: responseBody.toString('utf8'),
            duration: Date.now() - startTime
          });
        });
      });

      req.on('error', reject);
      if (body) req.write(bodyEncoding === 'base64' ? Buffer.from(body, 'base64') : body);
      req.end();
    });
  }

  onTrafficEvent(data) {
    // Enrich with API spec match
    const apiMatch = this.proxy.matchApiSpec(data.method, data.path, data.host);
    if (apiMatch) data.apiMatch = apiMatch;

    if (data._update) {
      // Update an existing pending request in-place
      delete data._update;
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
    for (const client of this.clients) {
      if (client.readyState === 1) { // OPEN
        client.send(json);
      }
    }
  }

  start() {
    return new Promise((resolve, reject) => {
      this.httpServer = http.createServer(this.app);

      this.httpServer.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`[API] Port ${this.port} is already in use. Try: API_PORT=<other_port> npm start`);
        }
        reject(err);
      });

      // WebSocket server for live traffic streaming
      this.wss = new WebSocketServer({ noServer: true });

      this.httpServer.on('upgrade', (request, socket, head) => {
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
          this.wss.handleUpgrade(request, socket, head, (ws) => {
            this.wss.emit('connection', ws, request);
          });
        } else {
          socket.destroy();
        }
      });

      this.wss.on('connection', (ws) => {
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

        ws.on('close', () => {
          this.clients.delete(ws);
          console.log(`[API] WebSocket client disconnected (${this.clients.size} total)`);
        });

        ws.on('message', (message) => {
          try {
            const msg = JSON.parse(message);
            this._handleWsMessage(ws, msg);
          } catch (err) {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid message' }));
          }
        });
      });

      this.httpServer.listen(this.port, '127.0.0.1', () => {
        console.log(`[API] Management API listening on http://127.0.0.1:${this.port}`);
        console.log(`[API] WebSocket available at ws://127.0.0.1:${this.port}/ws`);
        resolve(this.port);
      });
    });
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
        this.trafficLog = [];
        this._broadcast({ type: 'traffic-cleared' });
        break;
      default:
        ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${msg.type}` }));
    }
  }

  _persistMockRules() {
    this.settings?.set('mockRules', this.proxy.mockRules);
  }

  setMcpBridge(bridge) {
    this.mcpBridge = bridge;
  }

  stop() {
    return new Promise((resolve) => {
      for (const client of this.clients) {
        client.close();
      }
      if (this.httpServer) {
        this.httpServer.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}
