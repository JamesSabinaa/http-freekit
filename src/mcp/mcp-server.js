import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { trafficToHar } from '../api/har-converter.js';

const MCP_HAR_EXPORT_MAX_BYTES = 200 * 1024;
const MCP_HAR_JSON_PREFIX = '{"log":{"version":"1.2","creator":{"name":"HTTP FreeKit","version":"1.0.0"},"entries":[';
const MCP_HAR_JSON_SUFFIX = ']}}';

function publicUpstreamProxyMetadata(upstreamProxy) {
  if (!upstreamProxy) return null;
  return {
    type: upstreamProxy.type,
    host: upstreamProxy.host,
    port: upstreamProxy.port
  };
}

const TOOL_DEFINITIONS = [
  {
    name: 'search_traffic',
    description: 'Search captured HTTP traffic and update the UI filter in real-time. The traffic list in the user\'s browser will immediately update to show only matching requests. Filter by method, status code, hostname, or free-text query.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text search across URL, host, path, request/response body' },
        method: { type: 'string', description: 'HTTP method filter (GET, POST, etc.)' },
        status: { type: 'string', description: 'Status code or range (200, 4xx, 5xx)' },
        host: { type: 'string', description: 'Hostname substring filter' },
        limit: { type: 'number', minimum: 1, maximum: 500, description: 'Max results (default 50, max 500)' }
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
  },
  {
    name: 'select_request',
    description: 'Select a specific request in the HTTP FreeKit UI, opening its detail pane so the user can see the full request/response details in their browser.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string', description: 'The request ID to select and show details for' }
      },
      required: ['request_id']
    }
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
    this.sseRoutesRegistered = false;
    this.stdioTransport = null;
    this.launchConfig = options.launchConfig || null;

    if (this.enabled) {
      this._createServer();
    }
  }

  _createServer() {
    this.server = this._buildServer();
  }

  _buildServer() {
    const server = new Server(
      { name: 'http-freekit', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );
    this._registerTools(server);
    return server;
  }

  _registerTools(server) {
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOL_DEFINITIONS
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      try {
        switch (name) {
          case 'search_traffic': return this._handleSearchTraffic(args || {});
          case 'get_request_detail': return this._handleGetRequestDetail(args || {});
          case 'get_traffic_stats': return this._handleGetTrafficStats();
          case 'security_scan': return this._handleSecurityScan();
          case 'export_traffic': return this._handleExportTraffic(args || {});
          case 'get_live_summary': return this._handleGetLiveSummary();
          case 'select_request': return this._handleSelectRequest(args || {});
          default:
            return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
        }
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    });
  }

  // ========== Tool Handlers ==========

  _getHttpRequestTraffic() {
    return this.apiServer.trafficLog.filter(record => record?.protocol !== 'ws-frame');
  }

  _handleSearchTraffic({ query, method, status, host, limit }) {
    let results = this._getHttpRequestTraffic();
    const requestedLimit = Number.isFinite(limit) ? Math.trunc(limit) : 50;
    const max = Math.min(Math.max(requestedLimit, 1), 500);

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

    // Build a filter string and broadcast to the UI so it updates live
    const filterParts = [];
    if (method) filterParts.push('method:' + method);
    if (status) filterParts.push('status:' + status);
    if (host) filterParts.push('host:' + host);
    if (query) filterParts.push(query);
    const filterStr = filterParts.join(' ');
    this._broadcastToUi({ type: 'mcp-filter', filter: filterStr });

    return {
      content: [{
        type: 'text',
        text: `Found ${results.length} matching requests (showing ${matched.length}). The UI filter has been updated to show these results.\n\n` +
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
    const log = this._getHttpRequestTraffic();
    const byMethod = new Map();
    const byStatus = { '1xx': 0, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, 'other': 0 };
    const byHost = new Map();
    let totalDuration = 0;
    let durationCount = 0;
    let totalBandwidth = 0;
    const endpoints = [];

    for (const r of log) {
      // By method
      byMethod.set(r.method, (byMethod.get(r.method) || 0) + 1);

      // By status range
      if (r.statusCode >= 100 && r.statusCode < 200) byStatus['1xx']++;
      else if (r.statusCode >= 200 && r.statusCode < 300) byStatus['2xx']++;
      else if (r.statusCode >= 300 && r.statusCode < 400) byStatus['3xx']++;
      else if (r.statusCode >= 400 && r.statusCode < 500) byStatus['4xx']++;
      else if (r.statusCode >= 500 && r.statusCode < 600) byStatus['5xx']++;
      else byStatus['other']++;

      // By host
      if (r.host) byHost.set(r.host, (byHost.get(r.host) || 0) + 1);

      // Duration
      if (r.duration != null) {
        totalDuration += r.duration;
        durationCount++;
        endpoints.push({ method: r.method, url: r.url, duration: r.duration });
      }

      // Bandwidth
      totalBandwidth = addByteCount(totalBandwidth, r.requestBodySize);
      totalBandwidth = addByteCount(totalBandwidth, r.responseBodySize);
    }

    // Top hosts (by count)
    const topHosts = Array.from(byHost.entries())
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
      byMethod: Object.fromEntries(byMethod),
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
      const responseHeaders = r.responseHeaders;

      // Missing HTTPS (excluding localhost)
      const isLocalhost = /^(?:localhost|127\.0\.0\.1)(?::\d+)?$|^(?:::1|\[::1\](?::\d+)?)$/i.test(r.host || '');
      if (r.protocol === 'http' && r.host && !isLocalhost) {
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
      const setCookie = getHeaderValue(responseHeaders, 'set-cookie');
      if (setCookie) {
        const cookies = headerValues(setCookie);
        for (const cookie of cookies) {
          const attributes = String(cookie).split(';').slice(1).map(part => part.trim().toLowerCase());
          if (!attributes.includes('secure')) {
            issues.push({ severity: 'medium', category: 'Insecure Cookie', url: r.url, requestId: r.id,
              description: `Cookie missing Secure flag: ${cookie.split(';')[0]}` });
          }
          if (!attributes.includes('httponly')) {
            issues.push({ severity: 'medium', category: 'Insecure Cookie', url: r.url, requestId: r.id,
              description: `Cookie missing HttpOnly flag: ${cookie.split(';')[0]}` });
          }
        }
      }

      // Missing security headers (on HTML responses)
      const contentTypes = headerValues(getHeaderValue(responseHeaders, 'content-type'));
      if (contentTypes.some(value => value.includes('text/html')) && r.statusCode >= 200 && r.statusCode < 400) {
        for (const header of securityHeaders) {
          if (!getHeaderValue(responseHeaders, header)) {
            issues.push({ severity: 'low', category: 'Missing Security Header', url: r.url, requestId: r.id,
              description: `Missing ${header} header on HTML response` });
          }
        }
      }

      // CORS wildcard
      const allowedOrigins = headerValues(getHeaderValue(responseHeaders, 'access-control-allow-origin'));
      if (allowedOrigins.includes('*')) {
        issues.push({ severity: 'low', category: 'CORS Wildcard', url: r.url, requestId: r.id,
          description: 'Access-Control-Allow-Origin set to * (allows any origin)' });
      }
    }

    // Sort by severity, cap per category
    const severityOrder = { high: 0, medium: 1, low: 2 };
    issues.sort((a, b) => (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9));

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
    let filtered = this.apiServer._getHarExportTraffic();

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

    const json = serializeHarWithinLimit(filtered, MCP_HAR_EXPORT_MAX_BYTES);
    if (json === null) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: `HAR export exceeds the ${formatBytes(MCP_HAR_EXPORT_MAX_BYTES)} MCP response limit ` +
            `(${filtered.length} matching requests). Narrow the export with method, host, or status filters.`
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
      totalCapturedRequests: this._getHttpRequestTraffic().length,
      activeConnections: proxyStats.activeConnections,
      mockRulesCount: proxyStats.mockRules,
      breakpointRules: proxyStats.breakpointRules || 0,
      pendingBreakpoints: proxyStats.pendingBreakpoints || 0,
      activeInterceptors,
      upstreamProxy: publicUpstreamProxyMetadata(proxyStats.upstreamProxy),
      http2Enabled: proxyStats.http2Enabled,
      tlsPassthrough: proxyStats.tlsPassthrough?.length || 0
    };

    return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
  }

  _handleSelectRequest({ request_id }) {
    const req = this.apiServer.trafficLog.find(r => r.id === request_id);
    if (!req) {
      return { content: [{ type: 'text', text: `Request ${request_id} not found` }], isError: true };
    }
    // Broadcast to UI to select this request and open detail pane
    this._broadcastToUi({ type: 'mcp-select', requestId: request_id });
    return {
      content: [{
        type: 'text',
        text: `Selected request ${request_id} in the UI. The user can now see:\n` +
          `${req.method} ${req.url} — ${req.statusCode} (${req.duration}ms)`
      }]
    };
  }

  // Broadcast a message to all connected WebSocket UI clients
  _broadcastToUi(message) {
    if (this.apiServer && this.apiServer._broadcast) {
      this.apiServer._broadcast(message);
    }
  }

  // ========== Transports ==========

  _authenticateSseRequest(req, res, next) {
    if (typeof this.apiServer?._isAllowedBrowserOrigin === 'function' &&
        !this.apiServer._isAllowedBrowserOrigin(req.headers.origin)) {
      return res.status(403).json({ error: 'Forbidden origin' });
    }
    if (typeof this.apiServer?._isAuthorizedRequest === 'function' &&
        !this.apiServer._isAuthorizedRequest(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  }

  startSse(expressApp) {
    if (!this.server || this.sseRoutesRegistered) return;
    this.sseRoutesRegistered = true;

    const authenticate = this._authenticateSseRequest.bind(this);

    expressApp.get('/mcp/sse', authenticate, (req, res) => {
      if (!this.enabled || !this.server) {
        return res.status(503).json({ error: 'MCP server is disabled' });
      }
      const authToken = new URL(req.url, 'http://127.0.0.1').searchParams.get('authToken');
      const messageEndpoint = authToken
        ? `/mcp/messages?authToken=${encodeURIComponent(authToken)}`
        : '/mcp/messages';
      const transport = new SSEServerTransport(messageEndpoint, res);
      const server = this._buildServer();
      const sessionId = transport.sessionId;
      this.sseSessions.set(sessionId, { transport, server });

      transport.onclose = () => {
        this.sseSessions.delete(sessionId);
      };

      server.connect(transport).catch(err => {
        console.error('[MCP] SSE connection error:', err.message);
        this.sseSessions.delete(sessionId);
      });
    });

    expressApp.post('/mcp/messages', authenticate, (req, res) => {
      if (!this.enabled || !this.server) {
        return res.status(503).json({ error: 'MCP server is disabled' });
      }
      const sessionId = req.query.sessionId;
      const session = this.sseSessions.get(sessionId);
      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      return session.transport.handlePostMessage(req, res, req.body);
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
    for (const { transport, server } of this.sseSessions.values()) {
      try { await transport.close(); } catch {}
      try { await server.close(); } catch {}
    }
    this.sseSessions.clear();
    if (this.server) {
      try { await this.server.close(); } catch {}
    }
    this.stdioTransport = null;
    this.server = null;
    this.enabled = false;
  }

  async setEnabled(enabled) {
    if (enabled && !this.server) {
      this._createServer();
      this.enabled = true;
    } else if (!enabled && this.server) {
      this.enabled = false;
      await this.stop();
    }
  }

  getStatus() {
    return {
      enabled: this.enabled,
      sseEndpoint: this.enabled ? `/mcp/sse` : null,
      connectedClients: this.sseSessions.size,
      stdioActive: !!this.stdioTransport,
      claudeDesktopConfig: this.launchConfig
    };
  }
}

function getHeaderValue(headers, name) {
  const normalizedName = name.toLowerCase();
  const entry = Object.entries(headers || {})
    .find(([headerName]) => headerName.toLowerCase() === normalizedName);
  return entry?.[1];
}

function headerValues(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function serializeHarWithinLimit(requests, maxBytes) {
  const chunks = [MCP_HAR_JSON_PREFIX];
  let usedBytes = Buffer.byteLength(MCP_HAR_JSON_PREFIX) + Buffer.byteLength(MCP_HAR_JSON_SUFFIX);

  if (usedBytes > maxBytes) return null;

  for (let index = 0; index < requests.length; index++) {
    const separator = index === 0 ? '' : ',';
    const remainingBytes = maxBytes - usedBytes - separator.length;

    // Body text is already the dominant part of large captures. Reject it before
    // trafficToHar can parse/copy it or JSON serialization can allocate it again.
    if (hasBodyDefinitelyLargerThan(requests[index], remainingBytes)) return null;

    const entry = trafficToHar([requests[index]]).log.entries[0];
    const entryBytes = measureJsonBytes(entry, remainingBytes);
    if (entryBytes > remainingBytes) return null;

    const entryJson = JSON.stringify(entry);
    const serializedBytes = Buffer.byteLength(entryJson);
    if (serializedBytes > remainingBytes) return null;

    if (separator) chunks.push(separator);
    chunks.push(entryJson);
    usedBytes += separator.length + serializedBytes;
  }

  chunks.push(MCP_HAR_JSON_SUFFIX);
  return chunks.join('');
}

function hasBodyDefinitelyLargerThan(request, remainingBytes) {
  return minimumHarBodyTextBytes(request, 'request') > remainingBytes ||
    minimumHarBodyTextBytes(request, 'response') > remainingBytes;
}

function minimumHarBodyTextBytes(request, side) {
  if (request[`${side}BodyTruncated`] && request[`${side}BodyCapturedSize`] === 0) return 0;

  const body = request[`${side}Body`];
  if (!body || typeof body !== 'string') return 0;

  const base64PayloadLength = getBase64DataUriPayloadLength(body);
  return base64PayloadLength === null ? body.length : base64PayloadLength;
}

function getBase64DataUriPayloadLength(body) {
  if (!body.startsWith('data:')) return null;

  const marker = ';base64,';
  const markerIndex = body.lastIndexOf(marker);
  if (markerIndex <= 5 || body[5] === ';' || body[5] === ',' || body.indexOf(',', 5) < markerIndex) {
    return null;
  }

  let payloadLength = 0;
  for (let index = markerIndex + marker.length; index < body.length; index++) {
    const code = body.charCodeAt(index);
    const isBase64 = (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 || code === 47 || code === 61;
    if (isBase64) {
      payloadLength++;
    } else if (code !== 10 && code !== 13) {
      return null;
    }
  }
  return payloadLength;
}

function measureJsonBytes(value, maxBytes) {
  if (maxBytes < 0) return Infinity;
  if (value === null) return 4;

  switch (typeof value) {
    case 'string':
      return measureJsonStringBytes(value, maxBytes);
    case 'number':
      return Number.isFinite(value) ? String(value).length : 4;
    case 'boolean':
      return value ? 4 : 5;
    case 'object':
      break;
    default:
      return 0;
  }

  let bytes = 2;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (index > 0) bytes++;
      const item = value[index];
      const itemBytes = item === undefined || typeof item === 'function' || typeof item === 'symbol'
        ? 4
        : measureJsonBytes(item, maxBytes - bytes);
      bytes += itemBytes;
      if (bytes > maxBytes) return Infinity;
    }
    return bytes;
  }

  let includedProperties = 0;
  for (const key of Object.keys(value)) {
    const item = value[key];
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;

    if (includedProperties++ > 0) bytes++;
    bytes += measureJsonStringBytes(key, maxBytes - bytes) + 1;
    if (bytes > maxBytes) return Infinity;
    bytes += measureJsonBytes(item, maxBytes - bytes);
    if (bytes > maxBytes) return Infinity;
  }
  return bytes;
}

function measureJsonStringBytes(value, maxBytes) {
  if (maxBytes < 0) return Infinity;
  let bytes = 2;
  if (value.length + bytes > maxBytes) return Infinity;

  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) {
      bytes += 2;
    } else if (code < 32) {
      bytes += 6;
    } else if (code < 128) {
      bytes++;
    } else if (code < 2048) {
      bytes += 2;
    } else if (code >= 0xD800 && code <= 0xDBFF && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        bytes += 4;
        index++;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xD800 && code <= 0xDFFF) {
      bytes += 6;
    } else {
      bytes += 3;
    }

    if (bytes > maxBytes) return Infinity;
  }

  return bytes;
}

function normalizeByteCount(bytes) {
  return typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0 ? bytes : 0;
}

function addByteCount(total, bytes) {
  const count = normalizeByteCount(bytes);
  return total > Number.MAX_VALUE - count ? Number.MAX_VALUE : total + count;
}

function formatBytes(bytes) {
  const normalizedBytes = normalizeByteCount(bytes);
  if (normalizedBytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'];
  const i = Math.min(Math.floor(Math.log(normalizedBytes) / Math.log(k)), sizes.length - 1);
  return parseFloat((normalizedBytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}
