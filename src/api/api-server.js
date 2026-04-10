import express from 'express';
import http from 'http';
import https from 'https';
import crypto from 'crypto';
import { WebSocketServer } from 'ws';
import os from 'os';
import { trafficToHar } from './har-converter.js';

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

    // Wire up breakpoint broadcast so the UI gets real-time breakpoint events
    this.proxy.onBreakpoint = (event) => {
      this._broadcast(event);
    };

    this._setupMiddleware();
    this._setupRoutes();
  }

  _setupMiddleware() {
    // CORS
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.header('Access-Control-Max-Age', '86400');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
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

    // Export as HAR (must be before :id param route)
    router.get('/api/traffic/export.har', (req, res) => {
      const har = trafficToHar(this.trafficLog);
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
        if (Array.isArray(requests)) {
          this.trafficLog.push(...requests);
          this._broadcast({ type: 'traffic-imported', count: requests.length });
          res.json({ success: true, imported: requests.length });
        } else {
          res.status(400).json({ error: 'Invalid import format' });
        }
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
            requestHeaders: Object.fromEntries(
              (entry.request.headers || []).map(h => [h.name.toLowerCase(), h.value])
            ),
            requestBody: entry.request.postData?.text || '',
            requestBodySize: entry.request.bodySize || 0,
            statusCode: entry.response?.status || 0,
            statusMessage: entry.response?.statusText || '',
            responseHeaders: Object.fromEntries(
              (entry.response?.headers || []).map(h => [h.name.toLowerCase(), h.value])
            ),
            responseBody: entry.response?.content?.text || '',
            responseBodySize: entry.response?.content?.size || 0,
            duration: entry.time || 0,
            timestamp: new Date(entry.startedDateTime).getTime() || Date.now(),
            source: 'import'
          };
        });

        this.trafficLog.push(...imported);
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
      res.json({ success: true, rule });
    });

    router.put('/api/mock-rules/:id', (req, res) => {
      const updated = this.proxy.updateMockRule(req.params.id, req.body);
      if (!updated) return res.status(404).json({ error: 'Rule not found' });
      res.json({ success: true, rule: updated });
    });

    router.patch('/api/mock-rules/:id/toggle', (req, res) => {
      const toggled = this.proxy.toggleMockRule(req.params.id);
      if (!toggled) return res.status(404).json({ error: 'Rule not found' });
      res.json({ success: true, rule: toggled });
    });

    router.post('/api/mock-rules/reorder', (req, res) => {
      const { ids } = req.body;
      if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array is required' });
      const rules = this.proxy.reorderMockRules(ids);
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
      res.json({ success: true, group });
    });

    // Move a rule into a group
    router.post('/api/mock-rules/move-to-group', (req, res) => {
      const { ruleId, groupId } = req.body;
      // Find and remove the rule from its current location
      const rule = this._removeRuleById(ruleId);
      if (!rule) return res.status(404).json({ error: 'Rule not found' });
      // Find the group and add the rule
      const group = this.proxy.mockRules.find(r => r.id === groupId && r.type === 'group');
      if (!group) {
        // Put the rule back at top level if group not found
        this.proxy.mockRules.push(rule);
        return res.status(404).json({ error: 'Group not found' });
      }
      group.items.push(rule);
      res.json({ success: true });
    });

    // Move a rule out of its group to top level
    router.post('/api/mock-rules/ungroup', (req, res) => {
      const { ruleId } = req.body;
      const rule = this._removeRuleById(ruleId);
      if (!rule) return res.status(404).json({ error: 'Rule not found' });
      this.proxy.mockRules.push(rule);
      res.json({ success: true });
    });

    router.delete('/api/mock-rules/:id', (req, res) => {
      // Support both index (legacy) and UUID
      const param = req.params.id;
      const asInt = parseInt(param);
      if (!isNaN(asInt) && String(asInt) === param && asInt >= 0) {
        // Legacy: delete by index
        this.proxy.removeMockRule(asInt);
      } else {
        // New: delete by ID
        const removed = this.proxy.removeMockRuleById(param);
        if (!removed) return res.status(404).json({ error: 'Rule not found' });
      }
      res.json({ success: true });
    });

    router.delete('/api/mock-rules', (req, res) => {
      this.proxy.clearMockRules();
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
      res.json({ success: true, upstreamProxy: this.proxy.upstreamProxy });
    });

    router.delete('/api/upstream-proxy', (req, res) => {
      this.proxy.setUpstreamProxy(null);
      res.json({ success: true });
    });

    // TLS Passthrough
    router.get('/api/tls-passthrough', (req, res) => {
      res.json({ hosts: this.proxy.tlsPassthrough });
    });

    router.post('/api/tls-passthrough', (req, res) => {
      const { hosts } = req.body;
      this.proxy.setTlsPassthrough(hosts || []);
      res.json({ success: true, hosts: this.proxy.tlsPassthrough });
    });

    // Client certificates
    router.get('/api/client-certificates', (req, res) => {
      res.json({ certificates: this.proxy.clientCertificates });
    });
    router.post('/api/client-certificates', (req, res) => {
      this.proxy.setClientCertificates(req.body.certificates || []);
      res.json({ success: true });
    });

    // Trusted CAs
    router.get('/api/trusted-cas', (req, res) => {
      res.json({ cas: this.proxy.trustedCAs });
    });
    router.post('/api/trusted-cas', (req, res) => {
      this.proxy.setTrustedCAs(req.body.cas || []);
      res.json({ success: true });
    });

    // HTTPS whitelist
    router.get('/api/https-whitelist', (req, res) => {
      res.json({ hosts: this.proxy.httpsWhitelist });
    });
    router.post('/api/https-whitelist', (req, res) => {
      this.proxy.setHttpsWhitelist(req.body.hosts || []);
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
      res.json({ success: true, mode: this.proxy.http2Enabled });
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
        const { url, method, headers, body } = req.body;
        const result = await this._sendRequest(url, method || 'GET', headers || {}, body || '');
        res.json(result);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // MCP Server status and control
    router.get('/api/mcp/status', (req, res) => {
      if (!this.mcpBridge) return res.json({ enabled: false, sseEndpoint: null, connectedClients: 0 });
      const status = this.mcpBridge.getStatus();
      status.sseEndpoint = status.enabled ? `http://127.0.0.1:${this.port}/mcp/sse` : null;
      res.json(status);
    });

    router.post('/api/mcp/toggle', (req, res) => {
      if (!this.mcpBridge) return res.status(500).json({ error: 'MCP bridge not initialized' });
      const { enabled } = req.body;
      this.mcpBridge.setEnabled(!!enabled);
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

  async _sendRequest(url, method, headers, body) {
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
      if (body) req.write(body);
      req.end();
    });
  }

  onTrafficEvent(data) {
    // Enrich with API spec match
    const apiMatch = this.proxy.matchApiSpec(data.method, data.path, data.host);
    if (apiMatch) data.apiMatch = apiMatch;

    this.trafficLog.push(data);
    if (this.trafficLog.length > this.maxTrafficLog) {
      this.trafficLog.shift();
    }
    this._broadcast({ type: 'request', data });
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
        if (request.url === '/ws') {
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
