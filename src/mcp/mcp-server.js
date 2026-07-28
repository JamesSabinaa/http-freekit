import { EventEmitter } from 'node:events';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode
} from '@modelcontextprotocol/sdk/types.js';
import { trafficToHar } from '../api/har-converter.js';

const MCP_HAR_EXPORT_MAX_BYTES = 200 * 1024;
const MCP_HAR_JSON_PREFIX = '{"log":{"version":"1.2","creator":{"name":"HTTP FreeKit","version":"1.0.0"},"entries":[';
const MCP_HAR_JSON_SUFFIX = ']}}';
const MCP_BODY_PAGE_MAX_CODE_UNITS = 32 * 1024;
const MCP_LEGACY_BODY_PREVIEW_CODE_UNITS = 8 * 1024;
const MCP_REQUEST_DETAIL_MAX_BYTES = 512 * 1024;
const MCP_METADATA_MAX_DEPTH = 6;
const MCP_METADATA_MAX_ENTRIES = 128;
const MCP_METADATA_MAX_SCANNED_ENTRIES = 160;
const MCP_METADATA_MAX_KEY_CODE_UNITS = 128;
const MCP_METADATA_MAX_STRING_CODE_UNITS = 4 * 1024;
const MCP_METADATA_TOTAL_STRING_CODE_UNITS = 16 * 1024;
const BOXED_STRING_VALUE_OF = String.prototype.valueOf;
const TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength'
).get;
const DATA_VIEW_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  DataView.prototype,
  'byteLength'
).get;
const guardedMcpTransports = new WeakMap();

function oversizedMcpResponse(requestId) {
  return {
    jsonrpc: '2.0',
    id: requestId,
    error: {
      code: ErrorCode.InternalError,
      message: `MCP response exceeds the ${MCP_REQUEST_DETAIL_MAX_BYTES}-byte limit`
    }
  };
}

function mcpMessageBytes(message) {
  return Buffer.byteLength(JSON.stringify(message));
}

function jsonRpcRequestIdCanFitResponse(requestId) {
  return mcpMessageBytes(oversizedMcpResponse(requestId)) <= MCP_REQUEST_DETAIL_MAX_BYTES;
}

function capMcpResponse(message) {
  if (mcpMessageBytes(message) <= MCP_REQUEST_DETAIL_MAX_BYTES) return message;
  const isResponse = message?.jsonrpc === '2.0' &&
    Object.prototype.hasOwnProperty.call(message, 'id') &&
    typeof message.method !== 'string';
  if (!isResponse) return null;
  const fallback = oversizedMcpResponse(message.id);
  return mcpMessageBytes(fallback) <= MCP_REQUEST_DETAIL_MAX_BYTES ? fallback : null;
}

function guardMcpTransportRequestIds(transport, onRejectedRequest = () => {}) {
  const existing = guardedMcpTransports.get(transport);
  if (existing) return existing;
  let closeStarted = false;
  let resolveClose;
  let rejectClose;
  const closePromise = new Promise((resolve, reject) => {
    resolveClose = resolve;
    rejectClose = reject;
  });
  const closeOnce = () => {
    if (closeStarted) return closePromise;
    closeStarted = true;
    try {
      Promise.resolve(transport.close()).then(resolveClose, rejectClose);
    } catch (error) {
      rejectClose(error);
    }
    return closePromise;
  };
  const guarded = new Proxy(transport, {
    get(target, property) {
      if (property === 'close') return closeOnce;
      const value = Reflect.get(target, property, target);
      if (property === 'send' && typeof value === 'function') {
        return (message, ...args) => {
          const boundedMessage = capMcpResponse(message);
          if (boundedMessage) return value.call(target, boundedMessage, ...args);
          closeOnce().catch(() => {});
          return Promise.reject(new Error(
            `MCP message exceeds the ${MCP_REQUEST_DETAIL_MAX_BYTES}-byte limit`
          ));
        };
      }
      if (typeof value !== 'function' ||
          property === 'onmessage' || property === 'onclose' || property === 'onerror') {
        return value;
      }
      return value.bind(target);
    },
    set(target, property, value) {
      if (property === 'onmessage' && typeof value === 'function') {
        const guardedHandler = (message, extra) => {
          const isRequest = message?.jsonrpc === '2.0' &&
            Object.prototype.hasOwnProperty.call(message, 'id') &&
            typeof message.method === 'string';
          if (isRequest && !jsonRpcRequestIdCanFitResponse(message.id)) {
            try {
              onRejectedRequest(target);
            } catch {
              // The request must still be dropped when rejection handling fails.
            }
            closeOnce().catch(() => {});
            return;
          }
          value(message, extra);
        };
        return Reflect.set(target, property, guardedHandler, target);
      }
      return Reflect.set(target, property, value, target);
    }
  });
  guardedMcpTransports.set(transport, guarded);
  return guarded;
}

function publicUpstreamProxyMetadata(upstreamProxy) {
  if (!upstreamProxy) return null;
  return {
    type: upstreamProxy.type,
    host: upstreamProxy.host,
    port: upstreamProxy.port
  };
}

function ownDataValue(value, key) {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return undefined;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function isArraySafely(value) {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

function retainedBody(value, provenance = {}) {
  let boxedString = false;
  let content = '';
  if (typeof value === 'string') {
    content = value;
  } else {
    try {
      content = BOXED_STRING_VALUE_OF.call(value);
      boxedString = true;
    } catch {
      // Non-string bodies are intentionally omitted.
    }
  }
  const boxedEncoding = boxedString ? ownDataValue(value, 'encoding') : null;
  const boxedCapturedSize = boxedString ? ownDataValue(value, 'capturedSize') : null;
  const boxedDecodedSize = boxedString ? ownDataValue(value, 'decodedSize') : null;
  const encoding = typeof provenance.encoding === 'string'
    ? provenance.encoding
    : typeof boxedEncoding === 'string'
      ? boxedEncoding
      : 'utf8';
  const capturedSize = Number.isSafeInteger(provenance.capturedSize)
    ? provenance.capturedSize
    : Number.isSafeInteger(boxedCapturedSize)
      ? boxedCapturedSize
      : null;
  const decodedSize = Number.isSafeInteger(provenance.decodedSize)
    ? provenance.decodedSize
    : Number.isSafeInteger(boxedDecodedSize)
      ? boxedDecodedSize
      : null;
  return {
    content,
    encoding: encoding.slice(0, 64),
    truncated: provenance.truncated === true || capturedSize !== null || decodedSize !== null,
    capturedSize,
    decodedSize
  };
}

function boundedMetadata(value, state = null, depth = 0, excludedKeys = null) {
  const budget = state || {
    entries: 0,
    scannedEntries: 0,
    stringCodeUnits: 0,
    seen: new WeakSet()
  };
  if (value === null || value === undefined) return value;
  let stringMetadata = typeof value === 'string';
  let text = stringMetadata ? value : '';
  if (!stringMetadata && typeof value === 'object') {
    try {
      text = BOXED_STRING_VALUE_OF.call(value);
      stringMetadata = true;
    } catch {
      // Continue with other intrinsic type checks.
    }
  }
  if (stringMetadata) {
    const remaining = Math.max(0,
      MCP_METADATA_TOTAL_STRING_CODE_UNITS - budget.stringCodeUnits);
    const available = Math.min(MCP_METADATA_MAX_STRING_CODE_UNITS, remaining);
    if (text.length <= available) {
      budget.stringCodeUnits += text.length;
      return text;
    }
    const suffix = '… [truncated]';
    const clipped = available > suffix.length
      ? text.slice(0, available - suffix.length) + suffix
      : '[string omitted]';
    budget.stringCodeUnits += Math.min(available, clipped.length);
    return clipped;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'symbol' || typeof value === 'function') return undefined;
  let dateTimestamp;
  try {
    dateTimestamp = Date.prototype.getTime.call(value);
  } catch {
    // Continue with other intrinsic type checks.
  }
  if (dateTimestamp !== undefined) {
    return Number.isFinite(dateTimestamp)
      ? new Date(dateTimestamp).toISOString()
      : 'Invalid Date';
  }
  let binaryByteLength;
  try {
    binaryByteLength = TYPED_ARRAY_BYTE_LENGTH.call(value);
  } catch {
    try { binaryByteLength = DATA_VIEW_BYTE_LENGTH.call(value); } catch {}
  }
  if (binaryByteLength !== undefined) {
    return `[Binary metadata: ${binaryByteLength} bytes]`;
  }
  if (depth >= MCP_METADATA_MAX_DEPTH) return '[maximum depth omitted]';
  if (budget.seen.has(value)) return '[repeated reference omitted]';
  budget.seen.add(value);

  const arrayOutput = isArraySafely(value);
  const output = arrayOutput ? [] : Object.create(null);
  let omitted = false;
  try {
    for (const key in value) {
      if (budget.scannedEntries >= MCP_METADATA_MAX_SCANNED_ENTRIES) {
        omitted = true;
        break;
      }
      let descriptor;
      try {
        descriptor = Object.getOwnPropertyDescriptor(value, key);
      } catch {
        budget.scannedEntries++;
        omitted = true;
        continue;
      }
      // for-in yields all own enumerable keys before walking the prototype chain.
      if (!descriptor) break;
      budget.scannedEntries++;
      if (excludedKeys?.has(key)) continue;
      if (budget.entries >= MCP_METADATA_MAX_ENTRIES) {
        omitted = true;
        break;
      }
      if (key.length > MCP_METADATA_MAX_KEY_CODE_UNITS) {
        omitted = true;
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        omitted = true;
        continue;
      }
      budget.entries++;
      const sanitized = boundedMetadata(descriptor.value, budget, depth + 1);
      if (sanitized === undefined) continue;
      if (arrayOutput) output.push(sanitized);
      else output[key] = sanitized;
    }
  } catch {
    omitted = true;
  }
  if (omitted) {
    if (arrayOutput) output.push('[additional entries omitted]');
    else output._mcpAdditionalEntriesOmitted = true;
  }
  return output;
}

function bodyDescriptor(body, previewLength) {
  return {
    totalLength: body.content.length,
    previewLength,
    hasMore: previewLength < body.content.length,
    offsetUnit: 'utf16-code-unit',
    encoding: body.encoding,
    truncated: body.truncated,
    ...(body.capturedSize !== null ? { capturedSize: body.capturedSize } : {}),
    ...(body.decodedSize !== null ? { decodedSize: body.decodedSize } : {})
  };
}

function requestDetailFitsWireBudget(text, requestId = 0) {
  const representativeMessage = {
    jsonrpc: '2.0',
    id: requestId,
    result: { content: [{ type: 'text', text }] }
  };
  return Buffer.byteLength(JSON.stringify(representativeMessage)) <=
    MCP_REQUEST_DETAIL_MAX_BYTES;
}

function stringifyRequestDetailIfBounded(detail, requestId = 0) {
  const text = JSON.stringify(detail, null, 2);
  return requestDetailFitsWireBudget(text, requestId) ? text : null;
}

function stringifyBoundedRequestDetail(detail, requestId = 0) {
  let text = stringifyRequestDetailIfBounded(detail, requestId);
  if (text !== null) return text;

  const compact = {
    id: detail.id,
    timestamp: detail.timestamp,
    metadataTruncated: true,
    bodies: detail.bodies,
    bodyPage: detail.bodyPage
  };
  for (const field of [
    'requestBody',
    'responseBody',
    'requestBodyPreview',
    'responseBodyPreview',
    'originalRequestBodyPreview',
    'legacyBodiesOmitted'
  ]) {
    if (detail[field] !== undefined) compact[field] = detail[field];
  }
  if (detail.originalRequest?.body !== undefined) {
    compact.originalRequest = { body: detail.originalRequest.body };
  }
  text = stringifyRequestDetailIfBounded(compact, requestId);
  if (text !== null) return text;
  throw new Error(`Request detail exceeds the ${MCP_REQUEST_DETAIL_MAX_BYTES}-byte response limit`);
}

export const TOOL_DEFINITIONS = [
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
    description: 'Get bounded metadata and complete legacy body fields when they fit safely, or explicit previews for a larger captured HTTP request. Pass body_side and repeat with body_offset to retrieve every retained request, response, or original-request body code unit.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string', minLength: 1, description: 'The request ID to look up' },
        body_side: {
          type: 'string',
          enum: ['request', 'response', 'original_request'],
          description: 'Optional body to page. Omit to return metadata plus wire-safe complete legacy bodies or explicit previews.'
        },
        body_offset: {
          type: 'integer',
          minimum: 0,
          maximum: Number.MAX_SAFE_INTEGER,
          default: 0,
          description: 'Zero-based UTF-16 code-unit offset within body_side.'
        },
        body_limit: {
          type: 'integer',
          minimum: 1,
          maximum: MCP_BODY_PAGE_MAX_CODE_UNITS,
          default: MCP_BODY_PAGE_MAX_CODE_UNITS,
          description: `Maximum UTF-16 code units to return (max ${MCP_BODY_PAGE_MAX_CODE_UNITS}).`
        }
      },
      required: ['request_id'],
      allOf: [{
        if: {
          anyOf: [
            { required: ['body_offset'] },
            { required: ['body_limit'] }
          ]
        },
        then: { required: ['body_side'] }
      }]
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
        request_id: { type: 'string', description: 'The request ID to select and show details for' },
        traffic_lifecycle_id: {
          anyOf: [
            { type: 'string', minLength: 1 },
            { type: 'null' }
          ],
          description: 'Optional lifecycle ID from search_traffic, including null for a legacy request without one'
        }
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
    this.stdioOutput = null;
    this.onStdioFatalError = null;
    this._stopPromise = null;
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
    const connect = server.connect.bind(server);
    server.connect = transport => connect(guardMcpTransportRequestIds(
      transport,
      rejectedTransport => this._handleRejectedMcpRequest(rejectedTransport)
    ));
    this._registerTools(server);
    return server;
  }

  _handleRejectedMcpRequest(transport) {
    if (transport !== this.stdioTransport) return;
    this.stdioTransport = null;
    const output = this.stdioOutput;
    this.stdioOutput = null;
    try { output?.end(); } catch {}
    const onFatalError = this.onStdioFatalError;
    this.onStdioFatalError = null;
    if (typeof onFatalError !== 'function') return;
    Promise.resolve(onFatalError(new Error(
      `MCP request ID cannot fit in the ${MCP_REQUEST_DETAIL_MAX_BYTES}-byte response limit`
    ))).catch(error => {
      console.error('[MCP] stdio fatal error handler failed:', error.message);
    });
  }

  _registerTools(server) {
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOL_DEFINITIONS
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name, arguments: args } = request.params;
      try {
        switch (name) {
          case 'search_traffic': return this._handleSearchTraffic(args || {});
          case 'get_request_detail': return this._handleGetRequestDetail(args || {}, extra.requestId);
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
      trafficLifecycleId: r.trafficLifecycleId ?? null,
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

  _handleGetRequestDetail({ request_id, body_side, body_offset, body_limit }, requestId = 0) {
    if (typeof request_id !== 'string' || request_id.length === 0) {
      throw new Error('request_id must be a non-empty string');
    }
    if (body_side !== undefined &&
      !['request', 'response', 'original_request'].includes(body_side)) {
      throw new Error('body_side must be request, response, or original_request');
    }
    if (body_side === undefined && (body_offset !== undefined || body_limit !== undefined)) {
      throw new Error('body_side is required when body_offset or body_limit is provided');
    }

    const offset = body_offset === undefined ? 0 : body_offset;
    const limit = body_limit === undefined ? MCP_BODY_PAGE_MAX_CODE_UNITS : body_limit;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error('body_offset must be a non-negative safe integer');
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MCP_BODY_PAGE_MAX_CODE_UNITS) {
      throw new Error(`body_limit must be a safe integer from 1 to ${MCP_BODY_PAGE_MAX_CODE_UNITS}`);
    }

    const req = this.apiServer.trafficLog.find(
      record => ownDataValue(record, 'id') === request_id
    );
    if (!req) {
      return { content: [{ type: 'text', text: `Request ${request_id} not found` }], isError: true };
    }

    const originalRequest = ownDataValue(req, 'originalRequest');
    const requestBody = retainedBody(ownDataValue(req, 'requestBody'), {
      encoding: ownDataValue(req, 'requestBodyEncoding'),
      truncated: ownDataValue(req, 'requestBodyTruncated'),
      capturedSize: ownDataValue(req, 'requestBodyCapturedSize'),
      decodedSize: ownDataValue(req, 'requestBodyDecodedSize')
    });
    const responseBody = retainedBody(ownDataValue(req, 'responseBody'), {
      encoding: ownDataValue(req, 'responseBodyEncoding'),
      truncated: ownDataValue(req, 'responseBodyTruncated'),
      capturedSize: ownDataValue(req, 'responseBodyCapturedSize'),
      decodedSize: ownDataValue(req, 'responseBodyDecodedSize')
    });
    let originalRequestBody = retainedBody('');
    let originalRequestMetadata = originalRequest;
    const originalRequestIsObject = originalRequest && typeof originalRequest === 'object' &&
      !isArraySafely(originalRequest);
    if (originalRequestIsObject) {
      originalRequestBody = retainedBody(ownDataValue(originalRequest, 'body'));
      originalRequestMetadata = boundedMetadata(
        originalRequest,
        null,
        0,
        new Set(['body'])
      );
    } else {
      originalRequestMetadata = boundedMetadata(originalRequest);
    }
    const includeLegacyBodies = body_side === undefined;
    const requestPreviewLength = includeLegacyBodies ? requestBody.content.length : 0;
    const responsePreviewLength = includeLegacyBodies ? responseBody.content.length : 0;
    const originalPreviewLength = includeLegacyBodies ? originalRequestBody.content.length : 0;
    const bodies = {
      request: bodyDescriptor(requestBody, requestPreviewLength),
      response: bodyDescriptor(responseBody, responsePreviewLength),
      original_request: bodyDescriptor(originalRequestBody, originalPreviewLength)
    };
    const metadata = boundedMetadata(
      req,
      null,
      0,
      new Set(['requestBody', 'responseBody', 'originalRequest'])
    );
    const rawTimestamp = ownDataValue(req, 'timestamp');
    let timestamp = null;
    if (typeof rawTimestamp === 'number' || typeof rawTimestamp === 'string') {
      try {
        timestamp = new Date(rawTimestamp).toISOString();
      } catch {
        // Imported traffic is validated, but omit invalid in-process timestamps.
      }
    }
    const detail = {
      ...(metadata && typeof metadata === 'object' ? metadata : {}),
      originalRequest: originalRequestMetadata,
      timestamp,
      bodies,
      bodyPage: null
    };

    if (includeLegacyBodies) {
      const totalLegacyBodyCodeUnits = requestBody.content.length + responseBody.content.length +
        originalRequestBody.content.length;
      if (totalLegacyBodyCodeUnits <= MCP_REQUEST_DETAIL_MAX_BYTES) {
        detail.requestBody = requestBody.content;
        detail.responseBody = responseBody.content;
        if (originalRequestIsObject) {
          detail.originalRequest = {
            ...originalRequestMetadata,
            body: originalRequestBody.content
          };
        }

        const legacyText = stringifyRequestDetailIfBounded(detail, requestId);
        if (legacyText !== null) {
          return { content: [{ type: 'text', text: legacyText }] };
        }
      }

      const boundedRequestPreviewLength = Math.min(
        requestBody.content.length,
        MCP_LEGACY_BODY_PREVIEW_CODE_UNITS
      );
      const boundedResponsePreviewLength = Math.min(
        responseBody.content.length,
        MCP_LEGACY_BODY_PREVIEW_CODE_UNITS
      );
      const boundedOriginalPreviewLength = Math.min(
        originalRequestBody.content.length,
        MCP_LEGACY_BODY_PREVIEW_CODE_UNITS
      );
      bodies.request = bodyDescriptor(requestBody, boundedRequestPreviewLength);
      bodies.response = bodyDescriptor(responseBody, boundedResponsePreviewLength);
      bodies.original_request = bodyDescriptor(originalRequestBody, boundedOriginalPreviewLength);
      delete detail.requestBody;
      delete detail.responseBody;
      if (detail.originalRequest && typeof detail.originalRequest === 'object') {
        delete detail.originalRequest.body;
      }
      detail.legacyBodiesOmitted = true;
      detail.requestBodyPreview = requestBody.content.slice(0, boundedRequestPreviewLength);
      detail.responseBodyPreview = responseBody.content.slice(0, boundedResponsePreviewLength);
      detail.originalRequestBodyPreview = originalRequestBody.content.slice(
        0,
        boundedOriginalPreviewLength
      );
    }

    if (body_side !== undefined) {
      const body = body_side === 'request'
        ? requestBody.content
        : body_side === 'response'
          ? responseBody.content
          : originalRequestBody.content;
      const content = body.slice(offset, offset + limit);
      const nextOffset = offset + content.length;
      const hasMore = nextOffset < body.length;
      detail.bodyPage = {
        side: body_side,
        offset,
        limit,
        length: content.length,
        totalLength: body.length,
        hasMore,
        nextOffset: hasMore ? nextOffset : null,
        content
      };
    }

    return { content: [{ type: 'text', text: stringifyBoundedRequestDetail(detail, requestId) }] };
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

  _handleSelectRequest(args) {
    const { request_id, traffic_lifecycle_id } = args;
    const lifecycleProvided = Object.prototype.hasOwnProperty.call(args, 'traffic_lifecycle_id');
    const req = this.apiServer.trafficLog.find(r =>
      r.id === request_id &&
      (!lifecycleProvided || (r.trafficLifecycleId ?? null) === traffic_lifecycle_id)
    );
    if (!req) {
      const identity = !lifecycleProvided
        ? request_id
        : traffic_lifecycle_id === null
          ? `${request_id} (legacy lifecycle)`
          : `${request_id} (lifecycle ${traffic_lifecycle_id})`;
      return { content: [{ type: 'text', text: `Request ${identity} not found` }], isError: true };
    }
    // Broadcast to UI to select this request and open detail pane
    this._broadcastToUi({
      type: 'mcp-select',
      requestId: request_id,
      trafficLifecycleId: req.trafficLifecycleId ?? null
    });
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

  async startStdio({
    stdin = process.stdin,
    stdout = process.stdout,
    onFatalError = null
  } = {}) {
    if (this._stopPromise) {
      throw new Error('MCP bridge is stopping');
    }
    const server = this.server;
    if (!server) return;
    if (this.stdioTransport) {
      throw new Error('MCP stdio transport is already active');
    }
    const transport = new StdioServerTransport(stdin, stdout);
    this.stdioTransport = transport;
    this.stdioOutput = stdout;
    this.onStdioFatalError = onFatalError;
    transport.onclose = () => {
      if (this.stdioTransport !== transport) return;
      this.stdioTransport = null;
      if (this.stdioOutput === stdout) this.stdioOutput = null;
      this.onStdioFatalError = null;
    };
    try {
      await server.connect(transport);
      if (this._stopPromise || this.server !== server || this.stdioTransport !== transport) {
        throw new Error('MCP stdio startup was interrupted by shutdown');
      }
    } catch (error) {
      await this._cleanupFailedStdioStart(server, transport, stdin);
      if (this.stdioTransport === transport) this.stdioTransport = null;
      if (this.stdioOutput === stdout) this.stdioOutput = null;
      if (this.onStdioFatalError === onFatalError) this.onStdioFatalError = null;
      throw error;
    }
    console.error('[MCP] stdio transport connected');
  }

  async _cleanupFailedStdioStart(server, transport, stdin) {
    try { await server.close(); } catch {}
    if (server.transport) {
      try { await transport.close(); } catch {}
    }
    if (!server.transport) return;

    for (const [event, listenerKey] of [
      ['data', '_ondata'],
      ['error', '_onerror']
    ]) {
      const listener = ownDataValue(transport, listenerKey);
      if (typeof listener !== 'function') continue;
      try { EventEmitter.prototype.removeListener.call(stdin, event, listener); } catch {}
    }
    try {
      if (stdin.listenerCount?.('data') === 0) stdin.pause?.();
    } catch {}
    try { server.transport.onclose?.(); } catch {}
  }

  async _performStop() {
    const sessions = [...this.sseSessions.values()];
    this.sseSessions.clear();
    const server = this.server;
    this.server = null;
    this.enabled = false;
    this.stdioTransport = null;
    this.stdioOutput = null;
    this.onStdioFatalError = null;

    for (const { transport, server: sessionServer } of sessions) {
      try { await transport.close(); } catch {}
      try { await sessionServer.close(); } catch {}
    }
    if (server) {
      try { await server.close(); } catch {}
    }
  }

  stop() {
    if (this._stopPromise) return this._stopPromise;
    let resolveStop;
    let rejectStop;
    const stopPromise = new Promise((resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    });
    this._stopPromise = stopPromise;
    void this._performStop().then(() => {
      if (this._stopPromise === stopPromise) this._stopPromise = null;
      resolveStop();
    }, error => {
      if (this._stopPromise === stopPromise) this._stopPromise = null;
      rejectStop(error);
    });
    return stopPromise;
  }

  async setEnabled(enabled) {
    if (this._stopPromise) await this._stopPromise;
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
