import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { trafficToHar } from '../api/har-converter.js';

const TOOL_DEFINITIONS = [
  {
    name: 'search_traffic',
    description: 'Search captured HTTP traffic. Filter by method, status code, hostname, or free-text query across URLs, headers, and bodies.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text search across URL, host, path, request/response body' },
        method: { type: 'string', description: 'HTTP method filter (GET, POST, etc.)' },
        status: { type: 'string', description: 'Status code or range (200, 4xx, 5xx)' },
        host: { type: 'string', description: 'Hostname substring filter' },
        limit: { type: 'number', description: 'Max results (default 50, max 500)' }
      }
    }
  },
  {
    name: 'get_request_detail',
    description: 'Get full details of a specific captured HTTP request including headers, body, timing, and TLS info.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string', description: 'The request ID to look up' }
      },
      required: ['request_id']
    }
  },
  {
    name: 'get_traffic_stats',
    description: 'Get aggregate statistics about captured traffic: request counts by method/status/host, average response times, bandwidth, and slowest endpoints.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'security_scan',
    description: 'Scan captured traffic for security issues: missing HTTPS, insecure cookies, exposed tokens in URLs, missing security headers, CORS problems.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'export_traffic',
    description: 'Export captured traffic as a HAR 1.2 file. Optionally filter by method, host, or status.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', description: 'Filter by HTTP method' },
        host: { type: 'string', description: 'Filter by hostname' },
        status: { type: 'string', description: 'Filter by status code or range (200, 4xx)' }
      }
    }
  },
  {
    name: 'get_live_summary',
    description: 'Get current state of the HTTP FreeKit proxy: port, active interceptors, captured request count, mock rules, and breakpoints.',
    inputSchema: { type: 'object', properties: {} }
  }
];

export class McpServerBridge {
  constructor({ apiServer, proxyServer, interceptorManager, options = {} }) {
    this.apiServer = apiServer;
    this.proxy = proxyServer;
    this.interceptors = interceptorManager;
    this.enabled = options.enabled !== false;
    this.server = null;
    this.sseSessions = new Map();
    this.stdioTransport = null;

    if (this.enabled) {
      this._createServer();
    }
  }

  _createServer() {
    this.server = new Server(
      { name: 'http-freekit', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );
    this._registerTools();
  }

  _registerTools() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOL_DEFINITIONS
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      try {
        switch (name) {
          case 'search_traffic': return this._handleSearchTraffic(args || {});
          case 'get_request_detail': return this._handleGetRequestDetail(args || {});
          case 'get_traffic_stats': return this._handleGetTrafficStats();
          case 'security_scan': return this._handleSecurityScan();
          case 'export_traffic': return this._handleExportTraffic(args || {});
          case 'get_live_summary': return this._handleGetLiveSummary();
          default:
            return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
        }
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    });
  }

  // ========== Tool Handlers ==========

  _handleSearchTraffic({ query, method, status, host, limit }) {
    let results = this.apiServer.trafficLog;
    const max = Math.min(limit || 50, 500);

    if (method) {
      const m = method.toUpperCase();
      results = results.filter(r => r.method?.toUpperCase() === m);
    }
    if (status) {
      if (status.endsWith('xx')) {
        const base = parseInt(status[0]) * 100;
        results = results.filter(r => r.statusCode >= base && r.statusCode < base + 100);
      } else {
        const code = parseInt(status);
        results = results.filter(r => r.statusCode === code);
      }
    }
    if (host) {
      const h = host.toLowerCase();
      results = results.filter(r => r.host?.toLowerCase().includes(h));
    }
    if (query) {
      const q = query.toLowerCase();
      results = results.filter(r =>
        r.url?.toLowerCase().includes(q) ||
        r.host?.toLowerCase().includes(q) ||
        r.path?.toLowerCase().includes(q) ||
        r.requestBody?.toLowerCase().includes(q) ||
        r.responseBody?.toLowerCase().includes(q) ||
        String(r.statusCode).includes(q) ||
        r.method?.toLowerCase().includes(q)
      );
    }

    const matched = results.slice(-max).map(r => ({
      id: r.id,
      method: r.method,
      statusCode: r.statusCode,
      url: r.url,
      host: r.host,
      path: r.path,
      duration: r.duration,
      source: r.source,
      timestamp: new Date(r.timestamp).toISOString(),
      responseSize: r.responseBodySize
    }));

    return {
      content: [{
        type: 'text',
        text: `Found ${results.length} matching requests (showing ${matched.length}):\n\n` +
          JSON.stringify(matched, null, 2)
      }]
    };
  }

  _handleGetRequestDetail({ request_id }) {
    const req = this.apiServer.trafficLog.find(r => r.id === request_id);
    if (!req) {
      return { content: [{ type: 'text', text: `Request ${request_id} not found` }], isError: true };
    }

    // Truncate bodies to 50KB for context manageability
    const maxBody = 50 * 1024;
    const detail = {
      ...req,
      requestBody: req.requestBody?.length > maxBody
        ? req.requestBody.substring(0, maxBody) + '\n... [truncated]'
        : req.requestBody,
      responseBody: req.responseBody?.length > maxBody
        ? req.responseBody.substring(0, maxBody) + '\n... [truncated]'
        : req.responseBody,
      timestamp: new Date(req.timestamp).toISOString()
    };

    return { content: [{ type: 'text', text: JSON.stringify(detail, null, 2) }] };
  }

  _handleGetTrafficStats() {
    const log = this.apiServer.trafficLog;
    const byMethod = {};
    const byStatus = { '1xx': 0, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, 'other': 0 };
    const byHost = {};
    let totalDuration = 0;
    let durationCount = 0;
    let totalBandwidth = 0;
    const endpoints = [];

    for (const r of log) {
      // By method
      byMethod[r.method] = (byMethod[r.method] || 0) + 1;

      // By status range
      if (r.statusCode >= 100 && r.statusCode < 200) byStatus['1xx']++;
      else if (r.statusCode >= 200 && r.statusCode < 300) byStatus['2xx']++;
      else if (r.statusCode >= 300 && r.statusCode < 400) byStatus['3xx']++;
      else if (r.statusCode >= 400 && r.statusCode < 500) byStatus['4xx']++;
      else if (r.statusCode >= 500 && r.statusCode < 600) byStatus['5xx']++;
      else byStatus['other']++;

      // By host
      if (r.host) byHost[r.host] = (byHost[r.host] || 0) + 1;

      // Duration
      if (r.duration != null) {
        totalDuration += r.duration;
        durationCount++;
        endpoints.push({ method: r.method, url: r.url, duration: r.duration });
      }

      // Bandwidth
      totalBandwidth += (r.requestBodySize || 0) + (r.responseBodySize || 0);
    }

    // Top hosts (by count)
    const topHosts = Object.entries(byHost)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([host, count]) => ({ host, count }));

    // Top slow endpoints
    const topSlow = endpoints
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 10)
      .map(e => ({ method: e.method, url: e.url, duration: Math.round(e.duration) + 'ms' }));

    const stats = {
      totalRequests: log.length,
      byMethod,
      byStatusRange: byStatus,
      topHosts,
      averageResponseTime: durationCount > 0 ? Math.round(totalDuration / durationCount) + 'ms' : 'N/A',
      totalBandwidth: formatBytes(totalBandwidth),
      topSlowEndpoints: topSlow
    };

    return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
  }

  _handleSecurityScan() {
    const log = this.apiServer.trafficLog;
    const issues = [];

    const tokenPatterns = /[?&](token|api_key|apikey|access_token|secret|password|auth|session_id|sessionid)=/i;
    const securityHeaders = ['content-security-policy', 'strict-transport-security', 'x-frame-options', 'x-content-type-options'];

    for (const r of log) {
      // Skip non-HTTP events
      if (!r.statusCode || r.source === 'mock') continue;

      // Missing HTTPS (excluding localhost)
      if (r.protocol === 'http' && r.host && !r.host.match(/^(localhost|127\.0\.0\.1|::1)/)) {
        issues.push({ severity: 'high', category: 'Missing HTTPS', url: r.url, requestId: r.id,
          description: `Unencrypted HTTP request to ${r.host}` });
      }

      // Exposed tokens in URLs
      if (r.url && tokenPatterns.test(r.url)) {
        const match = r.url.match(tokenPatterns);
        issues.push({ severity: 'high', category: 'Exposed Token in URL', url: r.url, requestId: r.id,
          description: `Sensitive parameter "${match[1]}" found in URL query string` });
      }

      // Insecure cookies
      const setCookie = r.responseHeaders?.['set-cookie'];
      if (setCookie) {
        const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
        for (const cookie of cookies) {
          const c = cookie.toLowerCase();
          if (!c.includes('secure')) {
            issues.push({ severity: 'medium', category: 'Insecure Cookie', url: r.url, requestId: r.id,
              description: `Cookie missing Secure flag: ${cookie.split(';')[0]}` });
          }
          if (!c.includes('httponly')) {
            issues.push({ severity: 'medium', category: 'Insecure Cookie', url: r.url, requestId: r.id,
              description: `Cookie missing HttpOnly flag: ${cookie.split(';')[0]}` });
          }
        }
      }

      // Missing security headers (on HTML responses)
      const ct = r.responseHeaders?.['content-type'] || '';
      if (ct.includes('text/html') && r.statusCode >= 200 && r.statusCode < 400) {
        for (const header of securityHeaders) {
          if (!r.responseHeaders?.[header]) {
            issues.push({ severity: 'low', category: 'Missing Security Header', url: r.url, requestId: r.id,
              description: `Missing ${header} header on HTML response` });
          }
        }
      }

      // CORS wildcard
      if (r.responseHeaders?.['access-control-allow-origin'] === '*') {
        issues.push({ severity: 'low', category: 'CORS Wildcard', url: r.url, requestId: r.id,
          description: 'Access-Control-Allow-Origin set to * (allows any origin)' });
      }
    }

    // Sort by severity, cap per category
    const severityOrder = { high: 0, medium: 1, low: 2 };
    issues.sort((a, b) => (severityOrder[a.severity] || 9) - (severityOrder[b.severity] || 9));

    const summary = {
      totalIssues: issues.length,
      bySeverity: {
        high: issues.filter(i => i.severity === 'high').length,
        medium: issues.filter(i => i.severity === 'medium').length,
        low: issues.filter(i => i.severity === 'low').length
      },
      issues: issues.slice(0, 100)
    };

    return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
  }

  _handleExportTraffic({ method, host, status }) {
    let filtered = this.apiServer.trafficLog;

    if (method) filtered = filtered.filter(r => r.method?.toUpperCase() === method.toUpperCase());
    if (host) filtered = filtered.filter(r => r.host?.toLowerCase().includes(host.toLowerCase()));
    if (status) {
      if (status.endsWith('xx')) {
        const base = parseInt(status[0]) * 100;
        filtered = filtered.filter(r => r.statusCode >= base && r.statusCode < base + 100);
      } else {
        filtered = filtered.filter(r => r.statusCode === parseInt(status));
      }
    }

    const har = trafficToHar(filtered);
    const json = JSON.stringify(har, null, 2);

    if (json.length > 200 * 1024) {
      return {
        content: [{
          type: 'text',
          text: `HAR export is ${formatBytes(json.length)} (${filtered.length} requests). ` +
            `This is very large. Consider narrowing with method/host/status filters.\n\n` +
            `First 50KB:\n${json.substring(0, 50 * 1024)}\n... [truncated]`
        }]
      };
    }

    return { content: [{ type: 'text', text: json }] };
  }

  async _handleGetLiveSummary() {
    const proxyStats = this.proxy.getStats();
    let activeInterceptors = [];
    try {
      const all = await this.interceptors.getAll();
      activeInterceptors = all.filter(i => i.active).map(i => ({ id: i.id, name: i.name }));
    } catch {}

    const summary = {
      proxyPort: this.proxy.port,
      totalCapturedRequests: this.apiServer.trafficLog.length,
      activeConnections: proxyStats.activeConnections,
      mockRulesCount: proxyStats.mockRules,
      breakpointRules: proxyStats.breakpointRules || 0,
      pendingBreakpoints: proxyStats.pendingBreakpoints || 0,
      activeInterceptors,
      upstreamProxy: proxyStats.upstreamProxy || null,
      http2Enabled: proxyStats.http2Enabled,
      tlsPassthrough: proxyStats.tlsPassthrough?.length || 0
    };

    return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
  }

  // ========== Transports ==========

  startSse(expressApp) {
    if (!this.server) return;

    expressApp.get('/mcp/sse', (req, res) => {
      const transport = new SSEServerTransport('/mcp/messages', res);
      const sessionId = transport.sessionId;
      this.sseSessions.set(sessionId, transport);

      transport.onClose = () => {
        this.sseSessions.delete(sessionId);
      };

      this.server.connect(transport).catch(err => {
        console.error('[MCP] SSE connection error:', err.message);
        this.sseSessions.delete(sessionId);
      });
    });

    expressApp.post('/mcp/messages', (req, res) => {
      const sessionId = req.query.sessionId;
      const transport = this.sseSessions.get(sessionId);
      if (!transport) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      transport.handlePostMessage(req, res);
    });

    console.log('[MCP] SSE transport ready on /mcp/sse');
  }

  async startStdio() {
    if (!this.server) return;
    this.stdioTransport = new StdioServerTransport();
    await this.server.connect(this.stdioTransport);
    console.error('[MCP] stdio transport connected');
  }

  async stop() {
    for (const [id, transport] of this.sseSessions) {
      try { transport.close(); } catch {}
    }
    this.sseSessions.clear();
    if (this.server) {
      try { await this.server.close(); } catch {}
    }
    this.server = null;
    this.enabled = false;
  }

  setEnabled(enabled) {
    if (enabled && !this.server) {
      this._createServer();
      this.enabled = true;
    } else if (!enabled && this.server) {
      this.stop();
    }
  }

  getStatus() {
    return {
      enabled: this.enabled,
      sseEndpoint: this.enabled ? `/mcp/sse` : null,
      connectedClients: this.sseSessions.size,
      stdioActive: !!this.stdioTransport
    };
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}
