import fs from 'fs';
import http from 'http';
import http2 from 'http2';
import https from 'https';
import net from 'net';
import tls from 'tls';
import zlib from 'zlib';
import { URL } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { SocksClient } from 'socks';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { Duplex } from 'stream';
import { WsFrameParser, WS_OPCODE, WS_OPCODE_NAMES, parseClosePayload } from './ws-frame-parser.js';

const RETRYABLE_UPSTREAM_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN'
]);

export class ProxyServer {
  constructor(certificateAuthority, options = {}) {
    this.ca = certificateAuthority;
    this.port = options.port ?? 8080;
    this.minPort = options.minPort ?? this.port;
    this.maxPort = options.maxPort ?? this.port;
    this.onRequest = options.onRequest || (() => {});
    this.onBreakpoint = options.onBreakpoint || (() => {});
    this.onUpstreamProxyRetry = options.onUpstreamProxyRetry || (async () => false);
    this.server = null;
    this.requestCount = 0;
    this.activeConnections = new Set();
    this.breakpointRules = []; // {id, enabled, matchers: [...]}
    this.pendingBreakpoints = new Map(); // requestId -> {req details, resolve fn}
    this.mockRules = [];
    // Upstream proxy: { host, port, auth? } or null
    this.upstreamProxy = null;
    this.tlsPassthrough = []; // hostnames to skip MITM for
    this.http2Enabled = 'disabled'; // 'all', 'h2-only', 'disabled'
    this.clientCertificates = []; // [{host, pfxPath}]
    this.trustedCAs = []; // [certPath]
    this._clientCertificateOptions = [];
    this._trustedCaCertificates = [];
    this.httpsWhitelist = []; // [hostname]
    this.tlsFingerprint = 'chrome-136'; // TLS fingerprint preset
    this.apiSpecs = []; // [{id, title, baseUrl, spec}]
    this.filterSafeFonts = false;
    // HTTP/2 upstream session cache: Map<"host:port", {session, timer, pending?}>
    this._h2Sessions = new Map();
    // Set of origins known not to support h2: Set<"host:port">
    this._h2Blacklist = new Set();
    this._upstreamAgent = null;
    this._upstreamAgentKey = null;
    this._upstreamProxyGeneration = 0;
    this._upstreamConnectTimeoutMs = options.upstreamConnectTimeoutMs ?? 15000;
    this._upstreamIdleTimeoutMs = options.upstreamIdleTimeoutMs ?? 30000;
    this._upstreamRetryDelayMs = options.upstreamRetryDelayMs ?? 200;
    this.maxBufferedBodyBytes = options.maxBufferedBodyBytes ?? 32 * 1024 * 1024;
    this.maxDecompressedBodyBytes = options.maxDecompressedBodyBytes ?? 32 * 1024 * 1024;
  }

  async _shouldRetryAfterUpstreamResponse(proxyRes, context = {}) {
    if (!this.upstreamProxy || context.attempt > 0) return false;
    if (proxyRes?.statusCode !== 410) return false;
    if (!this._canSafelyReplayRequest(context.method)) return false;
    if (context.proxyGeneration !== undefined &&
        context.proxyGeneration !== this._upstreamProxyGeneration) return true;
    try {
      return await this.onUpstreamProxyRetry({
        reason: '410 Gone',
        statusCode: proxyRes.statusCode,
        statusMessage: proxyRes.statusMessage,
        proxyGeneration: context.proxyGeneration,
        url: context.url,
        method: context.method,
        host: context.host
      });
    } catch (err) {
      console.error('[Proxy] Upstream proxy retry hook failed:', err.message);
      return false;
    }
  }

  _canSafelyReplayRequest(method) {
    return ['GET', 'HEAD', 'OPTIONS', 'TRACE'].includes(String(method || '').toUpperCase());
  }

  _getUpstreamErrorCode(err) {
    return err?.code || err?.cause?.code || null;
  }

  _getUpstreamErrorPhase(err) {
    if (err?.upstreamPhase) return err.upstreamPhase;
    const code = this._getUpstreamErrorCode(err);
    const message = String(err?.message || '');
    if (code === 'EAI_AGAIN' || code === 'ENOTFOUND') return 'dns';
    if (/before secure tls connection|tls|ssl|handshake/i.test(message)) return 'tls-handshake';
    if (code === 'ETIMEDOUT' || /timeout/i.test(message)) return 'timeout';
    if (code && RETRYABLE_UPSTREAM_ERROR_CODES.has(code)) return 'connect';
    return 'upstream';
  }

  _isRetryableUpstreamError(err) {
    const code = this._getUpstreamErrorCode(err);
    if (code && RETRYABLE_UPSTREAM_ERROR_CODES.has(code)) return true;
    return /client network socket disconnected before secure tls connection was established|socket hang up|upstream (?:connection|response) (?:timeout|aborted)|request timeout after \d+(?:\.\d+)?s/i
      .test(String(err?.message || ''));
  }

  async _shouldRetryAfterUpstreamError(err, context = {}) {
    if (!this.upstreamProxy || context.attempt > 0) return false;
    if (!this._canSafelyReplayRequest(context.method)) return false;
    if (!this._isRetryableUpstreamError(err)) return false;

    const failedGeneration = context.proxyGeneration;
    if (failedGeneration !== undefined && failedGeneration !== this._upstreamProxyGeneration) {
      return true;
    }

    try {
      await this.onUpstreamProxyRetry({
        reason: err?.message || 'Transient upstream proxy error',
        errorCode: this._getUpstreamErrorCode(err),
        errorPhase: this._getUpstreamErrorPhase(err),
        proxyGeneration: failedGeneration,
        url: context.url,
        method: context.method,
        host: context.host
      });
    } catch (hookErr) {
      console.error('[Proxy] Upstream proxy retry hook failed:', hookErr.message);
    }

    if (this._upstreamRetryDelayMs > 0) {
      const jitter = Math.floor(Math.random() * Math.max(1, this._upstreamRetryDelayMs / 2));
      await new Promise(resolve => setTimeout(resolve, this._upstreamRetryDelayMs + jitter));
    }
    return true;
  }

  _configureUpstreamRequest(req) {
    let connectTimer = null;
    const clearConnectTimer = () => {
      if (!connectTimer) return;
      clearTimeout(connectTimer);
      connectTimer = null;
    };

    if (this._upstreamConnectTimeoutMs > 0) {
      connectTimer = setTimeout(() => {
        const err = new Error(`Upstream connection timeout after ${this._upstreamConnectTimeoutMs / 1000}s`);
        err.code = 'ETIMEDOUT';
        err.upstreamPhase = 'connect';
        req.destroy(err);
      }, this._upstreamConnectTimeoutMs);
      connectTimer.unref?.();
    }

    req.once('response', clearConnectTimer);
    req.once('upgrade', clearConnectTimer);
    req.once('error', clearConnectTimer);
    req.once('close', clearConnectTimer);
    req.once('socket', (socket) => {
      const connected = socket.encrypted ? !socket.secureConnecting : !socket.connecting;
      if (connected) {
        clearConnectTimer();
      } else {
        socket.once(socket.encrypted ? 'secureConnect' : 'connect', clearConnectTimer);
      }
    });

    if (this._upstreamIdleTimeoutMs > 0) {
      req.setTimeout(this._upstreamIdleTimeoutMs, () => {
        const err = new Error(`Upstream response timeout after ${this._upstreamIdleTimeoutMs / 1000}s`);
        err.code = 'ETIMEDOUT';
        err.upstreamPhase = 'response';
        req.destroy(err);
      });
    }

    req.once('proxyConnect', (response) => {
      req._upstreamProxyConnect = {
        statusCode: response?.statusCode || null,
        statusText: response?.statusText || null
      };
    });
  }

  _forwardUpstreamResponseErrors(response, request) {
    response.once('aborted', () => {
      const err = new Error('Upstream response aborted');
      err.code = 'ECONNRESET';
      err.upstreamPhase = 'response';
      request.destroy(err);
    });
    response.once('error', (err) => request.destroy(err));
  }

  _destroyUpstreamAgent() {
    this._upstreamAgent?.destroy?.();
    this._upstreamAgent = null;
    this._upstreamAgentKey = null;
  }

  getUpstreamProxyGeneration() {
    return this._upstreamProxyGeneration;
  }

  _setContentLength(headers, length) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'content-length') delete headers[key];
    }
    headers['content-length'] = String(length);
  }

  _createBodyCollector(limit = this.maxBufferedBodyBytes) {
    return { chunks: [], length: 0, limit, exceeded: false };
  }

  _appendBodyChunk(collector, chunk) {
    if (collector.exceeded) return false;
    collector.length += chunk.length;
    if (collector.length > collector.limit) {
      collector.exceeded = true;
      collector.chunks.length = 0;
      return false;
    }
    collector.chunks.push(chunk);
    return true;
  }

  _concatBody(collector) {
    return Buffer.concat(collector.chunks, collector.length);
  }

  _bodyLimitError(kind = 'body') {
    const err = new Error(`${kind} exceeds ${this.maxBufferedBodyBytes} byte buffer limit`);
    err.code = 'ERR_BODY_TOO_LARGE';
    return err;
  }

  _cleanTrailers(trailers) {
    const clean = {};
    for (const [name, value] of Object.entries(trailers || {})) {
      if (!name.startsWith(':') && value !== undefined) clean[name.toLowerCase()] = value;
    }
    return clean;
  }

  _endH1Request(request, body, trailers) {
    if (body?.length) request.write(body);
    const cleanTrailers = this._cleanTrailers(trailers);
    if (Object.keys(cleanTrailers).length > 0) request.addTrailers(cleanTrailers);
    request.end();
  }

  _sendH1Response(response, statusCode, headers, body, trailers) {
    const cleanTrailers = this._cleanTrailers(trailers);
    const outgoingHeaders = { ...(headers || {}) };
    if (Object.keys(cleanTrailers).length > 0) {
      for (const name of Object.keys(outgoingHeaders)) {
        if (name.toLowerCase() === 'content-length') delete outgoingHeaders[name];
      }
      outgoingHeaders.trailer = Object.keys(cleanTrailers).join(', ');
    }
    response.writeHead(statusCode, outgoingHeaders);
    if (body?.length) response.write(body);
    if (Object.keys(cleanTrailers).length > 0) response.addTrailers(cleanTrailers);
    response.end();
  }

  _sendH2Response(stream, headers, body, trailers) {
    const cleanTrailers = this._cleanTrailers(trailers);
    const hasTrailers = Object.keys(cleanTrailers).length > 0;
    stream.respond(headers, hasTrailers ? { waitForTrailers: true } : undefined);
    if (hasTrailers) {
      stream.once('wantTrailers', () => {
        if (!stream.destroyed && !stream.closed) stream.sendTrailers(cleanTrailers);
      });
    }
    stream.end(body);
  }


  setUpstreamProxy(config) {
    this._destroyUpstreamAgent();
    this._upstreamProxyGeneration++;
    if (!config || !config.host) {
      this.upstreamProxy = null;
      console.log('[Proxy] Upstream proxy disabled');
      return;
    }
    const type = config.type || 'http';
    const defaultPort = type === 'https' ? 443 : type.startsWith('socks') ? 1080 : 8080;
    this.upstreamProxy = {
      host: config.host,
      port: parseInt(config.port) || defaultPort,
      auth: config.auth || null, // "user:pass" or null
      type
    };
    console.log(`[Proxy] Upstream proxy set to ${type.toUpperCase()} ${this.upstreamProxy.host}:${this.upstreamProxy.port}`);
  }

  setTlsPassthrough(hostnames) {
    this.tlsPassthrough = Array.isArray(hostnames) ? hostnames : [];
    console.log(`[Proxy] TLS passthrough: ${this.tlsPassthrough.length} hosts`);
  }

  setHttp2Config(mode) {
    this.http2Enabled = mode; // 'all', 'h2-only', 'disabled'
    console.log(`[Proxy] HTTP/2: ${mode}`);
  }

  setClientCertificates(certs) {
    this.clientCertificates = Array.isArray(certs) ? certs : [];
    this._clientCertificateOptions = this.clientCertificates.flatMap((config) => {
      if (!config?.host || !config?.pfxPath) return [];
      try {
        return [{
          host: this._normalizeTlsHostname(config.host),
          pfx: fs.readFileSync(config.pfxPath),
          ...(config.passphrase ? { passphrase: config.passphrase } : {})
        }];
      } catch (err) {
        console.error(`[Proxy] Failed to load client certificate ${config.pfxPath}: ${err.message}`);
        return [];
      }
    });
    this._destroyUpstreamAgent();
    this._closeAllH2Sessions();
    console.log(`[Proxy] Client certificates: ${this.clientCertificates.length} configured`);
  }

  setTrustedCAs(cas) {
    this.trustedCAs = Array.isArray(cas) ? cas : [];
    this._trustedCaCertificates = this.trustedCAs.flatMap((certPath) => {
      try {
        return [fs.readFileSync(certPath, 'utf8')];
      } catch (err) {
        console.error(`[Proxy] Failed to load trusted CA ${certPath}: ${err.message}`);
        return [];
      }
    });
    this._destroyUpstreamAgent();
    this._closeAllH2Sessions();
    console.log(`[Proxy] Trusted CAs: ${this.trustedCAs.length} configured`);
  }

  setHttpsWhitelist(hosts) {
    this.httpsWhitelist = hosts || [];
    this._destroyUpstreamAgent();
    this._closeAllH2Sessions();
    console.log(`[Proxy] HTTPS whitelist: ${this.httpsWhitelist.length} hosts`);
  }

  _normalizeTlsHostname(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '');
  }

  _isHttpsWhitelisted(hostname) {
    const target = this._normalizeTlsHostname(hostname);
    return target.length > 0 && this.httpsWhitelist.some(
      host => this._normalizeTlsHostname(host) === target
    );
  }

  _getClientCertificateOptions(hostname) {
    const target = this._normalizeTlsHostname(hostname);
    const match = this._clientCertificateOptions.find(config => config.host === target);
    return match ? { pfx: match.pfx, ...(match.passphrase ? { passphrase: match.passphrase } : {}) } : {};
  }

  setTlsFingerprint(preset) {
    this.tlsFingerprint = preset || 'chrome-136';
    console.log(`[Proxy] TLS fingerprint: ${this.tlsFingerprint}`);
  }

  // Convert rawHeaders array to an object preserving original case.
  // Node.js lowercases header names in req.headers; this keeps e.g. "User-Agent" not "user-agent".
  // Filters out proxy-specific headers that shouldn't be forwarded upstream.
  _rawHeadersToObject(rawHeaders) {
    const headers = {};
    for (let i = 0; i < rawHeaders.length; i += 2) {
      const name = rawHeaders[i];
      const value = rawHeaders[i + 1];
      const lower = name.toLowerCase();
      if (this._shouldStripUpstreamHeader(lower)) continue;
      if (headers[name] !== undefined) {
        // Multiple values — combine (cookie is common)
        headers[name] = Array.isArray(headers[name])
          ? [...headers[name], value]
          : [headers[name], value];
      } else {
        headers[name] = value;
      }
    }
    return headers;
  }

  // Preserve original header casing while treating req.headers as the source of
  // truth after mock steps or breakpoints have added, changed, or removed fields.
  _currentHeadersWithRawCase(rawHeaders, currentHeaders) {
    const pending = new Map();
    for (const [name, value] of Object.entries(this._stripUpstreamHeaders(currentHeaders || {}))) {
      pending.set(name.toLowerCase(), { name, value });
    }

    const headers = {};
    for (const rawName of Object.keys(this._rawHeadersToObject(rawHeaders || []))) {
      const lower = rawName.toLowerCase();
      const current = pending.get(lower);
      if (!current) continue;
      headers[rawName] = current.value;
      pending.delete(lower);
    }
    for (const { name, value } of pending.values()) {
      headers[name] = value;
    }
    return headers;
  }

  _shouldStripUpstreamHeader(name) {
    const lower = String(name || '').toLowerCase();
    return [
      'proxy-connection',
      'proxy-authorization',
      'proxy-authenticate',
      'via',
      'forwarded',
      'x-forwarded-for',
      'x-forwarded-host',
      'x-forwarded-proto',
      'x-forwarded-protocol',
      'x-forwarded-port',
      'x-forwarded-server',
      'x-real-ip',
      'client-ip',
      'true-client-ip',
      'forwarded-for',
      'forwarded-host',
      'forwarded-proto'
    ].includes(lower);
  }

  _stripUpstreamHeaders(headers) {
    const clean = {};
    for (const [name, value] of Object.entries(headers || {})) {
      if (this._shouldStripUpstreamHeader(name)) continue;
      clean[name] = value;
    }
    return clean;
  }

  _toH2ResponseHeaders(statusCode, headers) {
    const converted = { ':status': statusCode };
    for (const [name, value] of Object.entries(headers || {})) {
      const lower = name.toLowerCase();
      if (['transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'http2-settings'].includes(lower)) continue;
      converted[lower] = Array.isArray(value)
        ? (lower === 'set-cookie' ? value : value.join(', '))
        : value;
    }
    return converted;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this._handleHttpRequest(req, res);
      });

      this.server.on('connect', (req, clientSocket, head) => {
        this._handleConnect(req, clientSocket, head);
      });

      this.server.on('upgrade', (req, socket, head) => {
        this._handleHttpUpgrade(req, socket, head);
      });

      this.server.on('error', (err) => {
        if (err.code === 'EADDRINUSE' && this.port < this.maxPort) {
          const unavailablePort = this.port;
          this.port++;
          console.log(`[Proxy] Port ${unavailablePort} is in use, trying ${this.port}...`);
          this.server.listen(this.port, '0.0.0.0');
        } else if (err.code === 'EADDRINUSE') {
          console.error(`[Proxy] No available port in range ${this.minPort}-${this.maxPort}`);
          reject(err);
        } else {
          console.error('[Proxy] Server error:', err.message);
          reject(err);
        }
      });

      this.server.on('connection', (socket) => {
        this.activeConnections.add(socket);
        socket.on('close', () => this.activeConnections.delete(socket));
      });

      this.server.listen(this.port, '0.0.0.0', () => {
        console.log(`[Proxy] HTTP/HTTPS proxy listening on port ${this.port}`);
        resolve(this.port);
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      this._closeAllH2Sessions();
      this._destroyUpstreamAgent();
      if (!this.server) return resolve();
      for (const socket of this.activeConnections) {
        socket.destroy();
      }
      this.server.close(() => {
        console.log('[Proxy] Server stopped');
        resolve();
      });
    });
  }

  // Handle HTTP upgrade requests (WebSocket passthrough)
  _handleHttpUpgrade(req, socket, head) {
    const startTime = Date.now();
    const requestId = uuidv4();
    let targetUrl;
    try {
      targetUrl = new URL(req.url);
    } catch {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const options = {
      hostname: targetUrl.hostname,
      port: targetUrl.port || 80,
      path: targetUrl.pathname + targetUrl.search,
      headers: this._rawHeadersToObject(req.rawHeaders),
      method: 'GET'
    };
    let requestLib = http;
    if (this.upstreamProxy && this._isSocksProxy()) {
      options.createConnection = (connectOptions, oncreate) => {
        this._connectViaSocks(targetUrl.hostname, targetUrl.port || 80)
          .then(upstreamSocket => oncreate(null, upstreamSocket))
          .catch(err => oncreate(err));
      };
    } else if (this.upstreamProxy) {
      options.hostname = this.upstreamProxy.host;
      options.port = this.upstreamProxy.port;
      options.path = targetUrl.href;
      if (this.upstreamProxy.auth) {
        options.headers['proxy-authorization'] = 'Basic ' + Buffer.from(this.upstreamProxy.auth).toString('base64');
      }
      requestLib = this.upstreamProxy.type === 'https' ? https : http;
      if (requestLib === https) {
        Object.assign(options, this._getUpstreamTlsOptions(this.upstreamProxy.host));
      }
    }

    const proxyReq = requestLib.request(options);
    this._configureUpstreamRequest(proxyReq);
    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      // Send upgrade response back to client
      let responseStr = `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`;
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        responseStr += `${key}: ${value}\r\n`;
      }
      responseStr += '\r\n';
      socket.write(responseStr);
      if (proxyHead.length) socket.write(proxyHead);

      // Track message counts and bytes
      let clientMessages = 0;
      let serverMessages = 0;
      let clientBytes = 0;
      let serverBytes = 0;
      let cleanedUp = false;
      let frameSequence = 0;

      // Frame parser for client -> server direction
      const clientParser = new WsFrameParser((frame) => {
        clientMessages++;
        this._emitWsFrame(frame, 'client', requestId, ++frameSequence);
      });

      // Frame parser for server -> client direction
      const serverParser = new WsFrameParser((frame) => {
        serverMessages++;
        this._emitWsFrame(frame, 'server', requestId, ++frameSequence);
      });

      // `head`/`proxyHead` contain bytes already read beyond the HTTP upgrade
      // headers. They are part of the WebSocket stream and must not be dropped.
      if (head.length) {
        clientBytes += head.length;
        try { clientParser.push(head); } catch { /* forward even if parse fails */ }
        proxySocket.write(head);
      }
      if (proxyHead.length) {
        serverBytes += proxyHead.length;
        try { serverParser.push(proxyHead); } catch { /* already forwarded above */ }
      }

      // Client -> Server: parse frames, forward raw bytes
      socket.on('data', (chunk) => {
        clientBytes += chunk.length;
        try { clientParser.push(chunk); } catch { /* forward even if parse fails */ }
        proxySocket.write(chunk);
      });

      // Server -> Client: parse frames, forward raw bytes
      proxySocket.on('data', (chunk) => {
        serverBytes += chunk.length;
        try { serverParser.push(chunk); } catch { /* forward even if parse fails */ }
        socket.write(chunk);
      });

      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        const duration = Date.now() - startTime;
        this._emitRequest({
          id: requestId,
          protocol: 'ws',
          method: 'WS',
          url: req.url.replace(/^http/, 'ws'),
          host: targetUrl.hostname,
          path: targetUrl.pathname + targetUrl.search,
          requestHeaders: req.headers,
          requestBody: `WebSocket: ${clientMessages} sent, ${serverMessages} received`,
          requestBodySize: clientBytes,
          statusCode: proxyRes.statusCode,
          statusMessage: 'WebSocket',
          responseHeaders: proxyRes.headers,
          responseBody: `${clientMessages + serverMessages} messages (${clientBytes + serverBytes} bytes)`,
          responseBodySize: serverBytes,
          duration,
          timestamp: startTime,
          source: this._detectSource(req.headers),
          tls: null,
          remote: { address: proxySocket.remoteAddress, port: proxySocket.remotePort }
        });
      };

      proxySocket.on('end', cleanup);
      proxySocket.on('error', () => { socket.destroy(); cleanup(); });
      socket.on('end', () => proxySocket.end());
      socket.on('error', () => { proxySocket.destroy(); cleanup(); });
    });

    // A server may reject an upgrade with a normal HTTP response (for example
    // 401 or 404). In that case Node emits `response`, not `upgrade`.
    proxyReq.on('response', (proxyRes) => {
      let responseStr = `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage || ''}\r\n`;
      for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
        responseStr += `${proxyRes.rawHeaders[i]}: ${proxyRes.rawHeaders[i + 1]}\r\n`;
      }
      responseStr += '\r\n';
      socket.write(responseStr);
      proxyRes.pipe(socket);
    });

    proxyReq.on('error', (err) => {
      socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      socket.destroy();
    });

    proxyReq.end();
  }

  /**
   * Emit a single WebSocket frame as a traffic event.
   * @param {{ fin: boolean, opcode: number, masked: boolean, payload: Buffer, timestamp: number }} frame
   * @param {'client'|'server'} direction
   * @param {string} parentId - The WS connection request ID
   * @param {number} sequence - Frame sequence number within the connection
   */
  _emitWsFrame(frame, direction, parentId, sequence) {
    const opcodeName = WS_OPCODE_NAMES[frame.opcode] || `unknown(0x${frame.opcode.toString(16)})`;

    let payload;
    if (frame.opcode === WS_OPCODE.TEXT) {
      // Decode text frames as UTF-8
      payload = frame.payload.toString('utf-8');
    } else if (frame.opcode === WS_OPCODE.CLOSE) {
      // Parse close frame for code and reason
      const close = parseClosePayload(frame.payload);
      payload = close.code != null
        ? `Close code: ${close.code}${close.reason ? ' - ' + close.reason : ''}`
        : '';
    } else if (frame.opcode === WS_OPCODE.BINARY) {
      // Hex-encode binary frames
      payload = frame.payload.toString('hex');
    } else {
      // Ping/pong: show payload as UTF-8 if present, otherwise empty
      payload = frame.payload.length > 0 ? frame.payload.toString('utf-8') : '';
    }

    this._emitRequest({
      id: uuidv4(),
      protocol: 'ws-frame',
      method: 'WS',
      url: '',
      host: '',
      path: '',
      requestHeaders: {},
      requestBody: payload,
      requestBodySize: frame.payload.length,
      statusCode: 0,
      statusMessage: opcodeName,
      responseHeaders: {},
      responseBody: '',
      responseBodySize: 0,
      duration: 0,
      timestamp: frame.timestamp,
      source: 'websocket',
      tls: null,
      remote: null,
      // WebSocket frame-specific fields
      direction,
      opcode: frame.opcode,
      opcodeName,
      fin: frame.fin,
      masked: frame.masked,
      parentId,
      sequence
    });
  }

  // Handle plain HTTP requests (non-CONNECT)
  _handleHttpRequest(clientReq, clientRes) {
    const startTime = Date.now();
    const requestId = uuidv4();
    this.requestCount++;


    let targetUrl;
    try {
      targetUrl = new URL(clientReq.url);
    } catch {
      // Relative URL — this might be the UI or management request
      clientRes.writeHead(400, { 'Content-Type': 'text/plain' });
      clientRes.end('Bad Request: Invalid URL');
      return;
    }

    if (this._serveHttpToolkitAndroidConfig(clientReq, clientRes, targetUrl)) {
      return;
    }

    const requestBody = this._createBodyCollector();
    clientReq.on('data', chunk => this._appendBodyChunk(requestBody, chunk));
    clientReq.on('end', async () => {
      if (requestBody.exceeded) {
        clientRes.writeHead(413, { 'Content-Type': 'text/plain', Connection: 'close' });
        clientRes.end('Request body too large');
        return;
      }
      let body = this._concatBody(requestBody);
      let breakpointBodyModified = false;

      // Check mock rules
      const mockRule = this._findMockRule(clientReq.method, targetUrl.href, clientReq.headers, this._safeBodyString(body));
      const mockBreakpointPhase = this._getMockBreakpointPhase(mockRule);
      if (mockRule && !mockBreakpointPhase) {
        this._serveMockResponse(requestId, clientReq, clientRes, targetUrl, body, mockRule, startTime);
        return;
      }

      // Check breakpoint rules
      const breakpoint = mockBreakpointPhase === 'request'
        ? mockRule
        : this._checkBreakpoint(clientReq.method, targetUrl.href, clientReq.headers);
      const responseBreakpoint = mockBreakpointPhase === 'response';
      if (breakpoint) {
        this._emitRequest({
          id: requestId, protocol: 'http', method: clientReq.method, url: targetUrl.href,
          host: targetUrl.hostname, path: targetUrl.pathname + targetUrl.search,
          requestHeaders: clientReq.headers, requestBody: this._safeBodyString(body),
          requestBodySize: body.length, statusCode: 0, statusMessage: 'Breakpoint',
          responseHeaders: {}, responseBody: '', responseBodySize: 0,
          duration: 0, timestamp: startTime, source: 'breakpoint',
          tls: null, remote: null
        });
        try {
          this.onBreakpoint({
            type: 'breakpoint-hit', requestId,
            method: clientReq.method, url: targetUrl.href, host: targetUrl.hostname
          });
        } catch (err) {
          console.error('[Proxy] Error in breakpoint handler:', err.message);
        }
        const modifications = await new Promise((resolve) => {
          this.pendingBreakpoints.set(requestId, {
            method: clientReq.method, url: targetUrl.href, host: targetUrl.hostname,
            path: targetUrl.pathname + targetUrl.search, headers: clientReq.headers,
            body: this._safeBodyString(body), timestamp: Date.now(), resolve
          });
          this._setBreakpointTimeout(requestId);
        });
        // Apply modifications if provided
        if (modifications.url) {
          try { targetUrl = new URL(modifications.url); } catch { /* keep original */ }
        }
        if (modifications.method) {
          clientReq.method = modifications.method;
        }
        if (modifications.headers) {
          Object.assign(clientReq.headers, modifications.headers);
        }
        if (Object.prototype.hasOwnProperty.call(modifications, 'body')) {
          body = Buffer.from(String(modifications.body || ''));
          this._setContentLength(clientReq.headers, body.length);
          breakpointBodyModified = true;
        }
      }

      const buildOptions = () => {
        const headers = this._stripUpstreamHeaders({
          ...this._rawHeadersToObject(clientReq.rawHeaders),
          ...clientReq.headers
        });
        if (breakpointBodyModified) this._setContentLength(headers, body.length);

        if (this.upstreamProxy && this._isSocksProxy()) {
          // Route through SOCKS proxy — connect via SOCKS then send normal request
          return {
            hostname: targetUrl.hostname,
            port: parseInt(targetUrl.port) || 80,
            path: targetUrl.pathname + targetUrl.search,
            method: clientReq.method,
            headers,
            createConnection: (opts, oncreate) => {
              this._connectViaSocks(opts.hostname, opts.port)
                .then(socket => oncreate(null, socket))
                .catch(err => oncreate(err));
            }
          };
        }

        if (this.upstreamProxy) {
          // Route through HTTP/HTTPS upstream proxy — send full URL as path
          const options = {
            hostname: this.upstreamProxy.host,
            port: this.upstreamProxy.port,
            path: targetUrl.href,
            method: clientReq.method,
            headers,
            insecureHTTPParser: true
          };
          if (this.upstreamProxy.auth) {
            options.headers['proxy-authorization'] = 'Basic ' + Buffer.from(this.upstreamProxy.auth).toString('base64');
          }
          return options;
        }

        return {
          hostname: targetUrl.hostname,
          port: targetUrl.port || 80,
          path: targetUrl.pathname + targetUrl.search,
          method: clientReq.method,
          headers
        };
      };

      // Emit pending request immediately so it appears in the UI
      this._emitPendingRequest({
        id: requestId, protocol: 'http', method: clientReq.method, url: targetUrl.href,
        host: targetUrl.hostname, path: targetUrl.pathname + targetUrl.search,
        requestHeaders: clientReq.headers, requestBody: this._safeBodyString(body),
        requestBodySize: body.length, timestamp: startTime, source: 'proxy',
        tls: null, remote: null
      });

      const connectStart = Date.now();
      const sendProxyRequest = (attempt = 0) => {
        const proxyGeneration = this._upstreamProxyGeneration;
        const options = buildOptions();
        const requestLib = this.upstreamProxy?.type === 'https' ? https : http;
        if (requestLib === https) {
          Object.assign(options, this._getUpstreamTlsOptions(this.upstreamProxy.host));
        }
        const proxyReq = requestLib.request(options, (proxyRes) => {
          this._forwardUpstreamResponseErrors(proxyRes, proxyReq);
          const responseBody = this._createBodyCollector();
          proxyRes.on('data', chunk => {
            if (!this._appendBodyChunk(responseBody, chunk)) {
              proxyReq.destroy(this._bodyLimitError('Upstream response body'));
            }
          });
          proxyRes.on('end', async () => {
            const resBody = this._concatBody(responseBody);
            if (await this._shouldRetryAfterUpstreamResponse(proxyRes, {
              attempt, proxyGeneration, method: clientReq.method,
              url: targetUrl.href, host: targetUrl.hostname
            })) {
              sendProxyRequest(attempt + 1);
              return;
            }

            const trailers = proxyRes.trailers;
            const resHeaders = { ...proxyRes.headers };
            if (proxyRes.statusCode !== 407) delete resHeaders['proxy-authenticate'];
            delete resHeaders['proxy-authorization'];
            delete resHeaders['proxy-connection'];
            let finalResponse = {
              statusCode: proxyRes.statusCode,
              statusMessage: proxyRes.statusMessage,
              headers: resHeaders,
              body: resBody,
              trailers
            };
            const remote = { address: proxyReq.socket?.remoteAddress, port: proxyReq.socket?.remotePort };
            if (responseBreakpoint) {
              finalResponse = await this._pauseResponseBreakpoint({
                requestId,
                protocol: 'http',
                method: clientReq.method,
                url: targetUrl.href,
                host: targetUrl.hostname,
                path: targetUrl.pathname + targetUrl.search,
                requestHeaders: clientReq.headers,
                requestBody: body,
                statusCode: proxyRes.statusCode,
                statusMessage: proxyRes.statusMessage,
                responseHeaders: resHeaders,
                responseBody: resBody,
                trailers,
                startTime,
                tlsDetails: null,
                remote
              });
            }
            const duration = Date.now() - startTime;
            const timing = {
              total: Date.now() - startTime,
              waiting: Date.now() - connectStart // time waiting for response
            };
            this._sendH1Response(
              clientRes,
              finalResponse.statusCode,
              finalResponse.headers,
              finalResponse.body,
              finalResponse.trailers
            );

            this._emitRequestUpdate({
              id: requestId,
              protocol: 'http',
              method: clientReq.method,
              url: targetUrl.href,
              host: targetUrl.hostname,
              path: targetUrl.pathname + targetUrl.search,
              requestHeaders: clientReq.headers,
              requestBody: this._safeBodyString(body),
              requestBodySize: body.length,
              statusCode: finalResponse.statusCode,
              statusMessage: finalResponse.statusMessage,
              responseHeaders: finalResponse.headers,
              responseBody: this._safeBodyString(
                finalResponse.body,
                finalResponse.headers['content-encoding'],
                finalResponse.headers['content-type']
              ),
              responseBodySize: finalResponse.body.length,
              duration,
              timing,
              timestamp: startTime,
              source: 'proxy',
              tls: null,
              remote,
              trailers: Object.keys(finalResponse.trailers || {}).length > 0 ? finalResponse.trailers : null
            });
          });
        });
        proxyReq._upstreamProxyGeneration = proxyGeneration;
        this._configureUpstreamRequest(proxyReq);

        proxyReq.once('error', async (err) => {
          if (await this._shouldRetryAfterUpstreamError(err, {
            attempt, proxyGeneration, method: clientReq.method,
            url: targetUrl.href, host: targetUrl.hostname
          })) {
            sendProxyRequest(attempt + 1);
            return;
          }

          const duration = Date.now() - startTime;
          try {
            clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
            clientRes.end(`Proxy Error: ${err.message}`);
          } catch { /* client gone */ }

          this._emitRequestUpdate({
            id: requestId,
            protocol: 'http',
            method: clientReq.method,
            url: targetUrl.href,
            host: targetUrl.hostname,
            path: targetUrl.pathname + targetUrl.search,
            requestHeaders: clientReq.headers,
            requestBody: this._safeBodyString(body),
            requestBodySize: body.length,
            statusCode: 502,
            statusMessage: 'Bad Gateway',
            responseHeaders: {},
            responseBody: `Proxy Error: ${err.message}`,
            responseBodySize: 0,
            duration,
            timestamp: startTime,
            error: err.message,
            errorCode: this._getUpstreamErrorCode(err),
            errorPhase: this._getUpstreamErrorPhase(err),
            upstreamProxyGeneration: proxyGeneration,
            upstreamProxyConnect: proxyReq._upstreamProxyConnect || null,
            source: 'proxy',
            tls: null,
            remote: null
          });
        });

        this._endH1Request(proxyReq, body, clientReq.trailers);
      };

      sendProxyRequest();
    });
  }

  _serveHttpToolkitAndroidConfig(clientReq, clientRes, targetUrl) {
    if (clientReq.method !== 'GET') return false;

    const host = targetUrl.hostname.toLowerCase();
    const path = targetUrl.pathname;
    const certInfo = this.ca?.getCertInfo?.();
    const certificate = certInfo?.certificateContent;
    if (!certificate) return false;

    if (host === 'android.httptoolkit.tech' && path === '/config') {
      const body = JSON.stringify({ certificate });
      clientRes.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      });
      clientRes.end(body);
      return true;
    }

    if (host === 'amiusing.httptoolkit.tech' && path === '/certificate') {
      clientRes.writeHead(200, {
        'Content-Type': 'application/x-pem-file',
        'Content-Length': Buffer.byteLength(certificate)
      });
      clientRes.end(certificate);
      return true;
    }

    return false;
  }

  // Handle CONNECT method for HTTPS tunneling + MITM
  _handleConnect(req, clientSocket, head) {
    let connectTarget;
    try {
      connectTarget = new URL(`https://${req.url}`);
    } catch {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    // WHATWG URL keeps brackets in IPv6 hostnames; socket and certificate APIs
    // require the literal address without them.
    const hostname = connectTarget.hostname.replace(/^\[|\]$/g, '');
    const targetPort = parseInt(connectTarget.port, 10) || 443;
    const urlHostname = net.isIP(hostname) === 6 ? `[${hostname}]` : hostname;

    // TLS passthrough — no MITM, no certificate generation
    if (this.tlsPassthrough.includes(hostname) ||
        this.tlsPassthrough.some(p => p.startsWith('*.') && hostname.endsWith(p.slice(1)))) {
      const tunnelId = uuidv4();
      const startTime = Date.now();
      let clientBytes = head.length;
      let serverBytes = 0;
      let tunnelEmitted = false;

      const emitTunnel = () => {
        if (tunnelEmitted) return;
        tunnelEmitted = true;
        this._emitRequest({
          id: tunnelId, protocol: 'tunnel', method: 'CONNECT',
          url: `tunnel://${urlHostname}:${targetPort}`, host: hostname, path: '/',
          requestHeaders: {}, requestBody: '', requestBodySize: clientBytes,
          statusCode: 200, statusMessage: 'Tunnel Established',
          responseHeaders: {}, responseBody: '', responseBodySize: serverBytes,
          duration: Date.now() - startTime, timestamp: startTime,
          source: 'tunnel', tls: null,
          remote: { address: hostname, port: targetPort }
        });
      };

      let target = null;
      this._connectTcp(hostname, targetPort).then((connectedTarget) => {
        target = connectedTarget;
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        target.write(head);
        clientSocket.on('data', chunk => { clientBytes += chunk.length; });
        target.on('data', chunk => { serverBytes += chunk.length; });
        target.pipe(clientSocket);
        clientSocket.pipe(target);
        target.on('close', emitTunnel);
        target.on('error', () => clientSocket.destroy());
      }).catch(() => {
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      });
      clientSocket.on('close', () => {
        target?.destroy();
        emitTunnel();
      });
      clientSocket.on('error', () => target?.destroy());
      return;
    }

    // Generate a certificate for this host
    const hostCert = this.ca.generateCertForHost(hostname);

    // Determine which ALPN protocols to advertise based on http2Enabled setting
    const useHttp2 = this.http2Enabled === 'all' || this.http2Enabled === 'h2-only';
    let ALPNProtocols;
    if (this.http2Enabled === 'h2-only') {
      ALPNProtocols = ['h2'];
    } else if (useHttp2) {
      ALPNProtocols = ['h2', 'http/1.1'];
    } else {
      ALPNProtocols = ['http/1.1'];
    }

    const tlsOptions = {
      key: hostCert.key,
      cert: hostCert.cert,
      ca: hostCert.ca,
      ALPNProtocols
    };

    clientSocket.on('error', () => {}); // Suppress connection reset errors

    // Tell client the tunnel is established
    clientSocket.write(
      'HTTP/1.1 200 Connection Established\r\n' +
      '\r\n'
    );

    // In passthrough mode, wrap the socket in a Duplex that captures
    // the ClientHello as it passes through (unshift doesn't work with TLSSocket
    // because TLS reads from the native handle, not Node's readable buffer).
    let socketForTls = clientSocket;
    if (this.tlsFingerprint === 'passthrough' || head.length > 0) {
      // `head` may already contain the start (or all) of the ClientHello. Feed
      // it through the wrapper because TLSSocket does not consume socket.unshift().
      socketForTls = this._createCapturingSocket(clientSocket, head);
    }

    const emitTlsHandshakeFailure = (err) => {
      clientSocket.destroy();
      this._emitRequest({
        id: uuidv4(),
        protocol: 'tls-error',
        method: 'CONNECT',
        url: `https://${urlHostname}:${targetPort}`,
        host: hostname,
        path: '/',
        requestHeaders: {},
        requestBody: '',
        requestBodySize: 0,
        statusCode: 0,
        statusMessage: 'TLS Handshake Failed',
        responseHeaders: {},
        responseBody: err.message || 'TLS error',
        responseBodySize: 0,
        duration: 0,
        timestamp: Date.now(),
        error: err.message,
        errorCode: err.code || null,
        source: 'tls-error',
        tls: null,
        remote: null
      });
    };

    if (useHttp2) {
      try {
        this._handleHttp2Connection(socketForTls, hostname, targetPort, tlsOptions);
      } catch (err) {
        emitTlsHandshakeFailure(err);
      }
      return;
    }

    try {
      const tlsServer = new tls.TLSSocket(socketForTls, {
        isServer: true,
        ...tlsOptions
      });

      // After TLS handshake, extract the captured ClientHello params
      if (socketForTls._captured !== undefined) {
        tlsServer.once('secure', () => {
          const parsed = socketForTls._captured;
          if (parsed) {
            tlsServer._clientHelloTls = ProxyServer._clientHelloToTlsOptions(parsed);
          }
        });
      }

      this._handleTlsConnection(tlsServer, hostname, targetPort);
    } catch (err) {
      emitTlsHandshakeFailure(err);
    }
  }

  _handleTlsConnection(tlsSocket, hostname, targetPort) {
    const urlHostname = net.isIP(hostname) === 6 ? `[${hostname}]` : hostname;
    // Capture TLS session details from the MITM socket
    const tlsDetails = tlsSocket.getCipher ? {
      cipher: tlsSocket.getCipher()?.name || null,
      version: tlsSocket.getProtocol?.() || 'TLSv1.2'
    } : null;

    // Track whether any HTTP request is received on this connection
    let httpRequestReceived = false;
    const tunnelStartTime = Date.now();
    let tunnelBytesIn = 0;
    let tunnelBytesOut = 0;
    let tunnelEmitted = false;

    const tunnelTimer = setTimeout(() => {
      if (!httpRequestReceived && !tunnelEmitted) {
        tunnelEmitted = true;
        this._emitRequest({
          id: uuidv4(), protocol: 'tunnel', method: 'CONNECT',
          url: `tunnel://${urlHostname}:${targetPort}`, host: hostname, path: '/',
          requestHeaders: {}, requestBody: '', requestBodySize: tunnelBytesIn,
          statusCode: 200, statusMessage: 'Raw Tunnel',
          responseHeaders: {}, responseBody: '', responseBodySize: tunnelBytesOut,
          duration: Date.now() - tunnelStartTime, timestamp: tunnelStartTime,
          source: 'tunnel', tls: tlsDetails,
          remote: { address: hostname, port: targetPort }
        });
      }
    }, 5000);

    tlsSocket.on('data', chunk => { tunnelBytesIn += chunk.length; });
    tlsSocket.on('close', () => clearTimeout(tunnelTimer));

    // Use Node's http parser by creating a virtual HTTP server on this TLS socket.
    // This properly handles keep-alive, chunked encoding, pipelining, etc.
    const virtualServer = http.createServer((req, res) => {
      httpRequestReceived = true;
      clearTimeout(tunnelTimer);
      const startTime = Date.now();
      const requestId = uuidv4();
      this.requestCount++;
      let fullUrl = `https://${urlHostname}${targetPort !== 443 ? ':' + targetPort : ''}${req.url}`;

      const requestBody = this._createBodyCollector();
      req.on('data', chunk => this._appendBodyChunk(requestBody, chunk));
    req.on('end', async () => {
        if (requestBody.exceeded) {
          res.writeHead(413, { 'Content-Type': 'text/plain', Connection: 'close' });
          res.end('Request body too large');
          return;
        }
        let body = this._concatBody(requestBody);
        let breakpointBodyModified = false;

        // Emit pending request immediately so it appears in the UI
        this._emitPendingRequest({
          id: requestId, protocol: 'https', method: req.method, url: fullUrl,
          host: hostname, path: req.url, requestHeaders: req.headers,
          requestBody: this._safeBodyString(body), requestBodySize: body.length,
          timestamp: startTime, source: 'proxy', tls: tlsDetails, remote: null
        });

        // Check mock rules
        const mockRule = this._findMockRule(req.method, fullUrl, req.headers, this._safeBodyString(body));
        const mockBreakpointPhase = this._getMockBreakpointPhase(mockRule);
        if (mockRule && !mockBreakpointPhase) {
          const action = mockRule.action || {
            type: 'fixed-response',
            status: mockRule.response?.status || 200,
            headers: mockRule.response?.headers || { 'Content-Type': 'application/json' },
            body: mockRule.response?.body || '',
            delay: 0
          };

          // Capture original request data before pre-steps modify it
          const origMethod = req.method;
          const origUrl = fullUrl;
          const origHeaders = { ...req.headers };

          // Execute pre-steps (step chaining) before the terminal action
          const preSteps = mockRule.preSteps || [];
          for (const step of preSteps) {
            switch (step.type) {
              case 'delay':
                if (step.ms > 0) {
                  await new Promise(r => setTimeout(r, step.ms));
                }
                break;
              case 'add-header':
                if (step.name) {
                  req.headers[step.name.toLowerCase()] = step.value || '';
                }
                break;
              case 'remove-header':
                if (step.name) {
                  delete req.headers[step.name.toLowerCase()];
                }
                break;
              case 'rewrite-url':
                if (step.value) {
                  try { fullUrl = step.value; } catch { /* keep original */ }
                }
                break;
              case 'rewrite-method':
                if (step.value) {
                  req.method = step.value;
                }
                break;
            }
          }

          // Detect if pre-steps transformed the request
          const transformed = origMethod !== req.method ||
            origUrl !== fullUrl ||
            JSON.stringify(origHeaders) !== JSON.stringify(req.headers);
          const originalRequest = transformed ? {
            method: origMethod, url: origUrl, headers: origHeaders,
            body: this._safeBodyString(body)
          } : null;
          const transformedBy = originalRequest ? (mockRule.title || mockRule.id || 'Mock Rule') : null;

          // Close connection
          if (action.type === 'close') {
            res.destroy();
            this._emitRequest({
              id: requestId, protocol: 'https', method: req.method, url: fullUrl,
              host: hostname, path: req.url, requestHeaders: req.headers,
              requestBody: this._safeBodyString(body), requestBodySize: body.length,
              statusCode: 0, statusMessage: 'Connection Closed', responseHeaders: {},
              responseBody: '', responseBodySize: 0,
              duration: Date.now() - startTime, timestamp: startTime, source: 'mock',
              tls: tlsDetails, remote: null,
              originalRequest, transformedBy
            });
            return;
          }

          // Reset connection (RST)
          if (action.type === 'reset') {
            res.socket?.destroy();
            this._emitRequest({
              id: requestId, protocol: 'https', method: req.method, url: fullUrl,
              host: hostname, path: req.url, requestHeaders: req.headers,
              requestBody: this._safeBodyString(body), requestBodySize: body.length,
              statusCode: 0, statusMessage: 'Connection Reset', responseHeaders: {},
              responseBody: '', responseBodySize: 0,
              duration: Date.now() - startTime, timestamp: startTime, source: 'mock',
              tls: tlsDetails, remote: null,
              originalRequest, transformedBy
            });
            return;
          }

          // Apply delay
          if (action.delay && action.delay > 0) {
            await new Promise(r => setTimeout(r, action.delay));
          }

          // Forward action
          if (action.type === 'forward' && action.forwardTo) {
            try {
              const forwardUrl = new URL(action.forwardTo);
              const isForwardHttps = forwardUrl.protocol === 'https:';
              const fwdLib = isForwardHttps ? https : http;
              const reqHeaders = this._currentHeadersWithRawCase(req.rawHeaders, req.headers);
              if (action.addRequestHeaders) {
                for (const [k, v] of Object.entries(action.addRequestHeaders)) {
                  reqHeaders[k] = v;
                }
              }
              // Update Host to match forward target
              const hostKey = Object.keys(reqHeaders).find(k => k.toLowerCase() === 'host') || 'Host';
              reqHeaders[hostKey] = forwardUrl.host;

              const fwdReq = fwdLib.request({
                hostname: forwardUrl.hostname,
                port: forwardUrl.port || (isForwardHttps ? 443 : 80),
                path: req.url,
                method: req.method,
                headers: reqHeaders,
                ...(isForwardHttps ? this._getUpstreamTlsOptions(forwardUrl.hostname) : {})
              }, (fwdRes) => {
                const responseBody = this._createBodyCollector();
                fwdRes.on('data', chunk => {
                  if (!this._appendBodyChunk(responseBody, chunk)) {
                    fwdReq.destroy(this._bodyLimitError('Mock forward response body'));
                  }
                });
                fwdRes.on('end', () => {
                  const resBody = this._concatBody(responseBody);
                  const resHeaders = { ...fwdRes.headers };
                  if (action.addResponseHeaders) {
                    for (const [k, v] of Object.entries(action.addResponseHeaders)) {
                      resHeaders[k.toLowerCase()] = v;
                    }
                  }
                  try {
                    this._sendH1Response(res, fwdRes.statusCode, resHeaders, resBody, fwdRes.trailers);
                  } catch (e) { /* client gone */ }
                  this._emitRequest({
                    id: requestId, protocol: 'https', method: req.method, url: fullUrl,
                    host: hostname, path: req.url, requestHeaders: req.headers,
                    requestBody: this._safeBodyString(body), requestBodySize: body.length,
                    statusCode: fwdRes.statusCode, statusMessage: fwdRes.statusMessage,
                    responseHeaders: resHeaders,
                    responseBody: this._safeBodyString(resBody, fwdRes.headers['content-encoding'], fwdRes.headers['content-type']),
                    responseBodySize: resBody.length, duration: Date.now() - startTime,
                    timestamp: startTime, source: 'mock',
                    tls: tlsDetails, remote: { address: fwdReq.socket?.remoteAddress, port: fwdReq.socket?.remotePort },
                    originalRequest, transformedBy
                  });
                });
              });
              fwdReq.on('error', (err) => {
                try {
                  res.writeHead(502, { 'Content-Type': 'text/plain' });
                  res.end(`Forward Error: ${err.message}`);
                } catch (e) { /* client gone */ }
                this._emitRequest({
                  id: requestId, protocol: 'https', method: req.method, url: fullUrl,
                  host: hostname, path: req.url, requestHeaders: req.headers,
                  requestBody: this._safeBodyString(body), requestBodySize: body.length,
                  statusCode: 502, statusMessage: 'Bad Gateway', responseHeaders: {},
                  responseBody: `Forward Error: ${err.message}`, responseBodySize: 0,
                  duration: Date.now() - startTime, timestamp: startTime, source: 'mock',
                  error: err.message,
                  tls: tlsDetails, remote: null,
                  originalRequest, transformedBy
                });
              });
              this._endH1Request(fwdReq, body, req.trailers);
            } catch (err) {
              try {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end(`Forward setup error: ${err.message}`);
              } catch (e) { /* client gone */ }
            }
            return;
          }

          // Serve content from a file
          if (action.type === 'serve-file') {
            const filePath = action.filePath;
            if (!filePath) {
              try {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Mock error: no filePath configured');
              } catch (e) { /* client gone */ }
              this._emitRequest({
                id: requestId, protocol: 'https', method: req.method, url: fullUrl,
                host: hostname, path: req.url, requestHeaders: req.headers,
                requestBody: this._safeBodyString(body), requestBodySize: body.length,
                statusCode: 500, statusMessage: 'Mock Error',
                responseHeaders: { 'Content-Type': 'text/plain' },
                responseBody: 'Mock error: no filePath configured', responseBodySize: 0,
                duration: Date.now() - startTime, timestamp: startTime, source: 'mock',
                tls: tlsDetails, remote: null,
                originalRequest, transformedBy
              });
              return;
            }
            try {
              const content = fs.readFileSync(filePath);
              const mime = action.contentType || 'application/octet-stream';
              const fileStatus = action.status || 200;
              res.writeHead(fileStatus, { 'Content-Type': mime });
              res.end(content);
              this._emitRequest({
                id: requestId, protocol: 'https', method: req.method, url: fullUrl,
                host: hostname, path: req.url, requestHeaders: req.headers,
                requestBody: this._safeBodyString(body), requestBodySize: body.length,
                statusCode: fileStatus, statusMessage: 'Mocked (file)',
                responseHeaders: { 'Content-Type': mime },
                responseBody: this._safeBodyString(content),
                responseBodySize: content.length,
                duration: Date.now() - startTime, timestamp: startTime, source: 'mock',
                tls: tlsDetails, remote: null,
                originalRequest, transformedBy
              });
            } catch (err) {
              try {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('File not found: ' + filePath);
              } catch (e) { /* client gone */ }
              this._emitRequest({
                id: requestId, protocol: 'https', method: req.method, url: fullUrl,
                host: hostname, path: req.url, requestHeaders: req.headers,
                requestBody: this._safeBodyString(body), requestBodySize: body.length,
                statusCode: 500, statusMessage: 'File Error',
                responseHeaders: { 'Content-Type': 'text/plain' },
                responseBody: 'File not found: ' + filePath, responseBodySize: 0,
                duration: Date.now() - startTime, timestamp: startTime, source: 'mock',
                error: err.message, tls: tlsDetails, remote: null,
                originalRequest, transformedBy
              });
            }
            return;
          }

          // Breakpoint on request (pause for manual editing)
          if (action.type === 'breakpoint-request') {
            this._emitRequest({
              id: requestId, protocol: 'https', method: req.method, url: fullUrl,
              host: hostname, path: req.url, requestHeaders: req.headers,
              requestBody: this._safeBodyString(body), requestBodySize: body.length,
              statusCode: 0, statusMessage: 'Breakpoint',
              responseHeaders: {}, responseBody: '', responseBodySize: 0,
              duration: 0, timestamp: startTime, source: 'breakpoint',
              tls: tlsDetails, remote: null,
              originalRequest, transformedBy
            });
            try {
              this.onBreakpoint({
                type: 'breakpoint-hit', requestId,
                method: req.method, url: fullUrl, host: hostname
              });
            } catch (err) {
              console.error('[Proxy] Error in breakpoint handler:', err.message);
            }
            const modifications = await new Promise((resolve) => {
              this.pendingBreakpoints.set(requestId, {
                method: req.method, url: fullUrl, host: hostname,
                path: req.url, headers: req.headers,
                body: this._safeBodyString(body), timestamp: Date.now(), resolve
              });
              this._setBreakpointTimeout(requestId);
            });
            if (modifications.url) {
              try {
                const nextUrl = new URL(modifications.url);
                fullUrl = nextUrl.href;
                hostname = nextUrl.hostname;
                targetPort = parseInt(nextUrl.port, 10) || 443;
                req.url = nextUrl.pathname + nextUrl.search;
              } catch { /* keep original */ }
            }
            if (modifications.method) req.method = modifications.method;
            if (modifications.headers) Object.assign(req.headers, modifications.headers);
            if (Object.prototype.hasOwnProperty.call(modifications, 'body')) {
              body = Buffer.from(String(modifications.body || ''));
              this._setContentLength(req.headers, body.length);
              breakpointBodyModified = true;
            }
            // Fall through to normal proxy behavior
          }

          // Breakpoint on response (forward normally, pause the response)
          if (action.type === 'breakpoint-response') {
            this._emitRequest({
              id: requestId, protocol: 'https', method: req.method, url: fullUrl,
              host: hostname, path: req.url, requestHeaders: req.headers,
              requestBody: this._safeBodyString(body), requestBodySize: body.length,
              statusCode: 0, statusMessage: 'Breakpoint (response)',
              responseHeaders: {}, responseBody: '', responseBodySize: 0,
              duration: 0, timestamp: startTime, source: 'breakpoint',
              tls: tlsDetails, remote: null,
              originalRequest, transformedBy
            });
            try {
              this.onBreakpoint({
                type: 'breakpoint-hit', requestId,
                method: req.method, url: fullUrl, host: hostname,
                phase: 'response'
              });
            } catch (err) {
              console.error('[Proxy] Error in breakpoint handler:', err.message);
            }
            const modifications = await new Promise((resolve) => {
              this.pendingBreakpoints.set(requestId, {
                method: req.method, url: fullUrl, host: hostname,
                path: req.url, headers: req.headers,
                body: this._safeBodyString(body), timestamp: Date.now(), phase: 'response', resolve
              });
              this._setBreakpointTimeout(requestId);
            });
            if (modifications.status) {
              try {
                res.writeHead(modifications.status, modifications.headers || {});
                res.end(modifications.body || '');
              } catch (e) { /* client gone */ }
            } else {
              try {
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end('Breakpoint released');
              } catch (e) { /* client gone */ }
            }
            return;
          }

          // Fixed response (default)
          const mockHeaders = action.headers || { 'Content-Type': 'application/json' };
          const mockBody = action.body || '';
          const mockStatus = action.status || 200;
          // Prevent browser caching of mocked responses
          if (!mockHeaders['cache-control'] && !mockHeaders['Cache-Control']) {
            mockHeaders['cache-control'] = 'no-store, no-cache, must-revalidate';
          }
          if (action.addResponseHeaders) {
            for (const [k, v] of Object.entries(action.addResponseHeaders)) {
              mockHeaders[k.toLowerCase()] = v;
            }
          }
          res.writeHead(mockStatus, mockHeaders);
          res.end(mockBody);
          this._emitRequest({
            id: requestId, protocol: 'https', method: req.method, url: fullUrl,
            host: hostname, path: req.url, requestHeaders: req.headers,
            requestBody: this._safeBodyString(body), requestBodySize: body.length,
            statusCode: mockStatus, statusMessage: 'Mocked', responseHeaders: mockHeaders,
            responseBody: mockBody, responseBodySize: Buffer.byteLength(mockBody),
            duration: Date.now() - startTime, timestamp: startTime, source: 'mock',
            tls: tlsDetails, remote: null,
            originalRequest, transformedBy
          });
          return;
        }

        // Check breakpoint rules
        const breakpointRule = mockBreakpointPhase === 'request'
          ? mockRule
          : this._checkBreakpoint(req.method, fullUrl, req.headers);
        const responseBreakpoint = mockBreakpointPhase === 'response';
        if (breakpointRule) {
          this._emitRequest({
            id: requestId, protocol: 'https', method: req.method, url: fullUrl,
            host: hostname, path: req.url, requestHeaders: req.headers,
            requestBody: this._safeBodyString(body), requestBodySize: body.length,
            statusCode: 0, statusMessage: 'Breakpoint', responseHeaders: {},
            responseBody: '', responseBodySize: 0,
            duration: 0, timestamp: startTime, source: 'breakpoint',
            tls: tlsDetails, remote: null
          });
          try {
            this.onBreakpoint({
              type: 'breakpoint-hit', requestId,
              method: req.method, url: fullUrl, host: hostname
            });
          } catch (err) {
            console.error('[Proxy] Error in breakpoint handler:', err.message);
          }
          const modifications = await new Promise((resolve) => {
            this.pendingBreakpoints.set(requestId, {
              method: req.method, url: fullUrl, host: hostname,
              path: req.url, headers: req.headers,
              body: this._safeBodyString(body), timestamp: Date.now(), resolve
            });
            this._setBreakpointTimeout(requestId);
          });
          // Apply modifications if provided
          if (modifications.url) {
            try {
              const modUrl = new URL(modifications.url);
              hostname = modUrl.hostname;
              targetPort = parseInt(modUrl.port) || (modUrl.protocol === 'https:' ? 443 : 80);
              req.url = modUrl.pathname + modUrl.search;
              fullUrl = modifications.url;
            } catch { /* keep original */ }
          }
          if (modifications.method) {
            req.method = modifications.method;
          }
          if (modifications.headers) {
            Object.assign(req.headers, modifications.headers);
          }
          if (Object.prototype.hasOwnProperty.call(modifications, 'body')) {
            body = Buffer.from(String(modifications.body || ''));
            this._setContentLength(req.headers, body.length);
            breakpointBodyModified = true;
          }
        }

        // Forward to real server — preserve raw header case to avoid bot detection
        const proxyOpts = {
          hostname, port: targetPort, path: req.url, method: req.method,
          headers: (() => {
            const headers = this._stripUpstreamHeaders({
              ...this._rawHeadersToObject(req.rawHeaders),
              ...req.headers
            });
            if (breakpointBodyModified) this._setContentLength(headers, body.length);
            return headers;
          })(),
          ...this._getUpstreamTlsOptions(hostname, tlsSocket._clientHelloTls)
        };

        let upstreamProtocol = 'https';

        const emitSuccess = (statusCode, statusMessage, responseHeaders, resBody, remote, trailers) => {
          const duration = Date.now() - startTime;
          this._emitRequestUpdate({
            id: requestId, protocol: upstreamProtocol, method: req.method, url: fullUrl,
            host: hostname, path: req.url, requestHeaders: req.headers,
            requestBody: this._safeBodyString(body), requestBodySize: body.length,
            statusCode, statusMessage, responseHeaders,
            responseBody: this._safeBodyString(resBody, responseHeaders['content-encoding'], responseHeaders['content-type']),
            responseBodySize: resBody.length, duration, timestamp: startTime, source: 'proxy',
            tls: tlsDetails, remote,
            trailers: Object.keys(trailers || {}).length > 0 ? trailers : null
          });
        };

        const emitError = (err, request) => {
          const duration = Date.now() - startTime;
          this._emitRequestUpdate({
            id: requestId, protocol: upstreamProtocol, method: req.method, url: fullUrl,
            host: hostname, path: req.url, requestHeaders: req.headers,
            requestBody: this._safeBodyString(body), requestBodySize: body.length,
            statusCode: 502, statusMessage: 'Bad Gateway', responseHeaders: {},
            responseBody: `Proxy Error: ${err.message}`, responseBodySize: 0,
            duration, timestamp: startTime, error: err.message,
            errorCode: this._getUpstreamErrorCode(err),
            errorPhase: this._getUpstreamErrorPhase(err),
            upstreamProxyGeneration: request?._upstreamProxyGeneration,
            upstreamProxyConnect: request?._upstreamProxyConnect || null,
            source: 'proxy',
            tls: tlsDetails, remote: null
          });
        };

        // Try HTTP/2 upstream first (skip if upstream proxy is configured)
        if (!this.upstreamProxy) {
          try {
            const h2Session = await this._getH2Session(hostname, targetPort);
            if (h2Session) {
              upstreamProtocol = 'h2';
              const h2Res = await this._makeH2Request(
                h2Session, req.method, hostname, targetPort, req.url, req.headers, body, req.trailers
              );
              let finalResponse = {
                statusCode: h2Res.statusCode,
                statusMessage: h2Res.statusMessage,
                headers: h2Res.headers,
                body: h2Res.body,
                trailers: h2Res.trailers
              };
              const remote = { address: h2Res.remoteAddress, port: h2Res.remotePort };
              if (responseBreakpoint) {
                finalResponse = await this._pauseResponseBreakpoint({
                  requestId, protocol: 'https', method: req.method, url: fullUrl,
                  host: hostname, path: req.url, requestHeaders: req.headers, requestBody: body,
                  statusCode: h2Res.statusCode, statusMessage: h2Res.statusMessage,
                  responseHeaders: h2Res.headers, responseBody: h2Res.body,
                  trailers: h2Res.trailers, startTime, tlsDetails, remote
                });
              }
              try {
                this._sendH1Response(
                  res, finalResponse.statusCode, finalResponse.headers, finalResponse.body, finalResponse.trailers
                );
              } catch (e) { /* client gone */ }
              emitSuccess(
                finalResponse.statusCode,
                finalResponse.statusMessage,
                finalResponse.headers,
                finalResponse.body,
                remote,
                finalResponse.trailers
              );
              return;
            }
          } catch (err) {
            // H2 request failed — fall back to h1.1
            upstreamProtocol = 'https';
          }
        }

        // Fallback: HTTPS/1.1
        const handleResponse = (attempt, proxyGeneration) => (proxyRes) => {
          this._forwardUpstreamResponseErrors(proxyRes, proxyReq);
          const responseBody = this._createBodyCollector();
          proxyRes.on('data', chunk => {
            if (!this._appendBodyChunk(responseBody, chunk)) {
              proxyReq.destroy(this._bodyLimitError('Upstream response body'));
            }
          });
          proxyRes.on('end', async () => {
            const resBody = this._concatBody(responseBody);
            if (await this._shouldRetryAfterUpstreamResponse(proxyRes, {
              attempt, proxyGeneration, method: req.method, url: fullUrl, host: hostname
            })) {
              sendProxyRequest(attempt + 1);
              return;
            }

            const trailers = proxyRes.trailers;
            const remote = { address: proxyReq?.socket?.remoteAddress, port: proxyReq?.socket?.remotePort };
            let finalResponse = {
              statusCode: proxyRes.statusCode,
              statusMessage: proxyRes.statusMessage,
              headers: proxyRes.headers,
              body: resBody,
              trailers
            };
            if (responseBreakpoint) {
              finalResponse = await this._pauseResponseBreakpoint({
                requestId, protocol: 'https', method: req.method, url: fullUrl,
                host: hostname, path: req.url, requestHeaders: req.headers, requestBody: body,
                statusCode: proxyRes.statusCode, statusMessage: proxyRes.statusMessage,
                responseHeaders: proxyRes.headers, responseBody: resBody,
                trailers, startTime, tlsDetails, remote
              });
            }
            try {
              this._sendH1Response(
                res, finalResponse.statusCode, finalResponse.headers, finalResponse.body, finalResponse.trailers
              );
            } catch (e) { /* client gone */ }
            emitSuccess(
              finalResponse.statusCode,
              finalResponse.statusMessage,
              finalResponse.headers,
              finalResponse.body,
              remote,
              finalResponse.trailers
            );
          });
        };

        const handleError = (err, request) => {
          try {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end(`Proxy Error: ${err.message}`);
          } catch (e) { /* client gone */ }
          emitError(err, request);
        };

        let proxyReq;
        const sendProxyRequest = (attempt = 0) => {
          const proxyGeneration = this._upstreamProxyGeneration;
          if (this.upstreamProxy) {
            const agent = this._getUpstreamAgent();
            proxyReq = https.request({
              ...proxyOpts,
              agent,
              insecureHTTPParser: true
            }, handleResponse(attempt, proxyGeneration));
          } else {
            proxyReq = https.request(proxyOpts, handleResponse(attempt, proxyGeneration));
          }

          const attemptReq = proxyReq;
          attemptReq._upstreamProxyGeneration = proxyGeneration;
          this._configureUpstreamRequest(attemptReq);
          attemptReq.once('error', async (err) => {
            if (await this._shouldRetryAfterUpstreamError(err, {
              attempt, proxyGeneration, method: req.method, url: fullUrl, host: hostname
            })) {
              sendProxyRequest(attempt + 1);
              return;
            }
            handleError(err, attemptReq);
          });
          this._endH1Request(attemptReq, body, req.trailers);
        };

        sendProxyRequest();
      });
    });

    // Don't actually listen — just feed the TLS socket into the server
    virtualServer.emit('connection', tlsSocket);

    tlsSocket.on('error', (err) => {
      if (err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.code === 'ECONNABORTED') return;
      if (err.message?.includes('ECONNABORTED')) return;
      // Emit TLS handshake errors as traffic events for UI visibility
      if (err.message?.includes('ssl') || err.message?.includes('SSL') ||
          err.message?.includes('handshake') || err.message?.includes('HANDSHAKE') ||
          err.code === 'ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN' ||
          err.code === 'ERR_SSL_WRONG_VERSION_NUMBER') {
        this._emitRequest({
          id: uuidv4(),
          protocol: 'tls-error',
          method: 'CONNECT',
          url: `https://${urlHostname}:${targetPort}`,
          host: hostname,
          path: '/',
          requestHeaders: {},
          requestBody: '',
          requestBodySize: 0,
          statusCode: 0,
          statusMessage: 'TLS Handshake Failed',
          responseHeaders: {},
          responseBody: err.message || 'TLS error',
          responseBodySize: 0,
          duration: 0,
          timestamp: Date.now(),
          error: err.message,
          errorCode: err.code || null,
          source: 'tls-error',
          tls: null,
          remote: null
        });
        return;
      }
      console.error(`[Proxy] TLS error for ${hostname}:`, err.message);
    });
  }

  _handleHttp2Connection(socket, hostname, targetPort, tlsOptions) {
    const urlHostname = net.isIP(hostname) === 6 ? `[${hostname}]` : hostname;
    let tlsSocket = socket;
    let tlsDetails = null;

    // Track whether any HTTP request is received on this connection
    let httpRequestReceived = false;
    const tunnelStartTime = Date.now();
    let tunnelEmitted = false;

    const tunnelTimer = setTimeout(() => {
      if (!httpRequestReceived && !tunnelEmitted) {
        tunnelEmitted = true;
        this._emitRequest({
          id: uuidv4(), protocol: 'tunnel', method: 'CONNECT',
          url: `tunnel://${urlHostname}:${targetPort}`, host: hostname, path: '/',
          requestHeaders: {}, requestBody: '', requestBodySize: 0,
          statusCode: 200, statusMessage: 'Raw Tunnel',
          responseHeaders: {}, responseBody: '', responseBodySize: 0,
          duration: Date.now() - tunnelStartTime, timestamp: tunnelStartTime,
          source: 'tunnel', tls: tlsDetails,
          remote: { address: hostname, port: targetPort }
        });
      }
    }, 5000);

    socket.on('close', () => clearTimeout(tunnelTimer));

    // Let the HTTP/2 secure server own TLS & ALPN. It can then dispatch both
    // HTTP/2 streams and HTTP/1.1 fallback requests on the injected socket.
    const h2Server = http2.createSecureServer({
      ...tlsOptions,
      allowHTTP1: this.http2Enabled !== 'h2-only'
    });
    h2Server.on('secureConnection', (secureSocket) => {
      tlsSocket = secureSocket;
      tlsDetails = {
        cipher: secureSocket.getCipher()?.name || null,
        version: secureSocket.getProtocol?.() || 'TLSv1.2'
      };
      const parsed = socket._captured;
      if (parsed) {
        secureSocket._clientHelloTls = ProxyServer._clientHelloToTlsOptions(parsed);
      }
    });

    // HTTP/2 streams — each stream is a separate request
    h2Server.on('stream', (stream, headers) => {
      httpRequestReceived = true;
      clearTimeout(tunnelTimer);
      const startTime = Date.now();
      const requestId = uuidv4();
      this.requestCount++;

      let method = headers[':method'];
      let path = headers[':path'];
      let authority = headers[':authority'] || hostname;
      const scheme = headers[':scheme'] || 'https';
      let fullUrl = `${scheme}://${authority}${path}`;
      let upstreamHostname = hostname;
      let upstreamPort = targetPort;

      // Collect request body
      const requestBody = this._createBodyCollector();
      let requestTrailers = {};
      stream.on('data', chunk => this._appendBodyChunk(requestBody, chunk));
      stream.on('trailers', trailers => { requestTrailers = this._cleanTrailers(trailers); });
      stream.on('end', async () => {
        if (requestBody.exceeded) {
          if (!stream.destroyed && !stream.closed) {
            stream.respond({ ':status': 413, 'content-type': 'text/plain' });
            stream.end('Request body too large');
          }
          return;
        }
        let body = this._concatBody(requestBody);
        let breakpointBodyModified = false;

        // Convert h2 pseudo-headers to regular headers for matching
        const reqHeaders = {};
        for (const [k, v] of Object.entries(headers)) {
          if (!k.startsWith(':')) reqHeaders[k] = v;
        }

        // Emit pending request immediately so it appears in the UI
        this._emitPendingRequest({
          id: requestId, protocol: 'h2', method, url: fullUrl,
          host: authority, path, requestHeaders: reqHeaders,
          requestBody: this._safeBodyString(body), requestBodySize: body.length,
          timestamp: startTime, source: 'proxy', tls: tlsDetails, remote: null
        });

        // Check mock rules
        const mockRule = this._findMockRule(method, fullUrl, reqHeaders, this._safeBodyString(body));
        const mockBreakpointPhase = this._getMockBreakpointPhase(mockRule);
        if (mockRule && !mockBreakpointPhase) {
          await this._handleH2MockResponse(stream, mockRule, {
            requestId, method, fullUrl, authority, path, reqHeaders, body,
            requestTrailers, startTime, tlsDetails
          });
          return;
        }

        // Check breakpoint rules
        const breakpointRule = mockBreakpointPhase === 'request'
          ? mockRule
          : this._checkBreakpoint(method, fullUrl, reqHeaders);
        const responseBreakpoint = mockBreakpointPhase === 'response';
        if (breakpointRule) {
          this._emitRequest({
            id: requestId, protocol: 'h2', method, url: fullUrl,
            host: authority, path, requestHeaders: reqHeaders,
            requestBody: this._safeBodyString(body), requestBodySize: body.length,
            statusCode: 0, statusMessage: 'Breakpoint', responseHeaders: {},
            responseBody: '', responseBodySize: 0,
            duration: 0, timestamp: startTime, source: 'breakpoint',
            tls: tlsDetails, remote: null
          });
          try {
            this.onBreakpoint({
              type: 'breakpoint-hit', requestId,
              method, url: fullUrl, host: authority
            });
          } catch (err) {
            console.error('[Proxy] Error in breakpoint handler:', err.message);
          }
          const modifications = await new Promise((resolve) => {
            this.pendingBreakpoints.set(requestId, {
              method, url: fullUrl, host: authority,
              path, headers: reqHeaders,
              body: this._safeBodyString(body), timestamp: Date.now(), resolve
            });
            this._setBreakpointTimeout(requestId);
          });
          if (modifications.url) {
            try {
              const nextUrl = new URL(modifications.url);
              if (nextUrl.protocol === 'https:') {
                fullUrl = nextUrl.href;
                authority = nextUrl.host;
                path = nextUrl.pathname + nextUrl.search;
                upstreamHostname = nextUrl.hostname;
                upstreamPort = parseInt(nextUrl.port, 10) || 443;
                reqHeaders.host = nextUrl.host;
              }
            } catch { /* keep original */ }
          }
          if (modifications.method) {
            method = String(modifications.method).trim().toUpperCase() || method;
          }
          if (modifications.headers) Object.assign(reqHeaders, modifications.headers);
          if (Object.prototype.hasOwnProperty.call(modifications, 'body')) {
            body = Buffer.from(String(modifications.body || ''));
            this._setContentLength(reqHeaders, body.length);
            breakpointBodyModified = true;
          }
        }

        // Forward to upstream server — try HTTP/2 first, then fall back to HTTPS/1.1
        const upstreamHeaders = this._stripUpstreamHeaders(reqHeaders);
        if (breakpointBodyModified) this._setContentLength(upstreamHeaders, body.length);
        if (!upstreamHeaders.host) {
          const upstreamUrlHostname = net.isIP(upstreamHostname) === 6 ? `[${upstreamHostname}]` : upstreamHostname;
          upstreamHeaders.host = upstreamPort === 443
            ? upstreamUrlHostname
            : `${upstreamUrlHostname}:${upstreamPort}`;
        }

        const source = this._detectSource(reqHeaders);

        const emitH2Success = (statusCode, statusMessage, responseHeaders, resBody, remote, trailers) => {
          const duration = Date.now() - startTime;
          this._emitRequestUpdate({
            id: requestId, protocol: 'h2', method, url: fullUrl,
            host: authority, path, requestHeaders: reqHeaders,
            requestBody: this._safeBodyString(body), requestBodySize: body.length,
            statusCode, statusMessage, responseHeaders,
            responseBody: this._safeBodyString(resBody, responseHeaders['content-encoding'], responseHeaders['content-type']),
            responseBodySize: resBody.length, duration, timestamp: startTime,
            source, tls: tlsDetails, remote,
            trailers: Object.keys(trailers || {}).length > 0 ? trailers : null
          });
        };

        const emitH2Error = (err, request) => {
          const duration = Date.now() - startTime;
          this._emitRequestUpdate({
            id: requestId, protocol: 'h2', method, url: fullUrl,
            host: authority, path, requestHeaders: reqHeaders,
            requestBody: this._safeBodyString(body), requestBodySize: body.length,
            statusCode: 502, statusMessage: 'Bad Gateway', responseHeaders: {},
            responseBody: 'Proxy Error: ' + err.message, responseBodySize: 0,
            duration, timestamp: startTime, error: err.message,
            errorCode: this._getUpstreamErrorCode(err),
            errorPhase: this._getUpstreamErrorPhase(err),
            upstreamProxyGeneration: request?._upstreamProxyGeneration,
            upstreamProxyConnect: request?._upstreamProxyConnect || null,
            source, tls: tlsDetails, remote: null
          });
        };

        // Try HTTP/2 upstream (skip if upstream proxy is configured)
        if (!this.upstreamProxy) {
          try {
            const h2Session = await this._getH2Session(upstreamHostname, upstreamPort);
            if (h2Session) {
              const h2Res = await this._makeH2Request(
                h2Session, method, upstreamHostname, upstreamPort, path, upstreamHeaders, body, requestTrailers
              );
              const remote = { address: h2Res.remoteAddress, port: h2Res.remotePort };
              let finalResponse = {
                statusCode: h2Res.statusCode,
                statusMessage: h2Res.statusMessage,
                headers: h2Res.headers,
                body: h2Res.body,
                trailers: h2Res.trailers
              };
              if (responseBreakpoint) {
                finalResponse = await this._pauseResponseBreakpoint({
                  requestId, protocol: 'h2', method, url: fullUrl, host: authority, path,
                  requestHeaders: reqHeaders, requestBody: body,
                  statusCode: h2Res.statusCode, statusMessage: h2Res.statusMessage,
                  responseHeaders: h2Res.headers, responseBody: h2Res.body,
                  trailers: h2Res.trailers, startTime, tlsDetails, remote
                });
              }
              const h2ResponseHeaders = this._toH2ResponseHeaders(
                finalResponse.statusCode, finalResponse.headers
              );
              try {
                if (!stream.destroyed && !stream.closed) {
                  this._sendH2Response(stream, h2ResponseHeaders, finalResponse.body, finalResponse.trailers);
                }
              } catch (e) { /* stream already closed */ }
              emitH2Success(
                finalResponse.statusCode,
                finalResponse.statusMessage,
                finalResponse.headers,
                finalResponse.body,
                remote,
                finalResponse.trailers
              );
              return;
            }
          } catch (err) {
            // H2 request failed — fall back to h1.1
          }
        }

        // Fallback: HTTPS/1.1 upstream with Firefox TLS fingerprint
        const proxyOpts = {
          hostname: upstreamHostname, port: upstreamPort, path, method,
          headers: upstreamHeaders,
          ...this._getUpstreamTlsOptions(upstreamHostname, tlsSocket._clientHelloTls)
        };

        const handleResponse = (attempt, proxyGeneration) => (proxyRes) => {
          this._forwardUpstreamResponseErrors(proxyRes, proxyReq);
          const responseBody = this._createBodyCollector();
          proxyRes.on('data', chunk => {
            if (!this._appendBodyChunk(responseBody, chunk)) {
              proxyReq.destroy(this._bodyLimitError('Upstream response body'));
            }
          });
          proxyRes.on('end', async () => {
            const resBody = this._concatBody(responseBody);
            if (await this._shouldRetryAfterUpstreamResponse(proxyRes, {
              attempt, proxyGeneration, method, url: fullUrl, host: authority
            })) {
              sendProxyRequest(attempt + 1);
              return;
            }

            const remote = { address: proxyReq?.socket?.remoteAddress, port: proxyReq?.socket?.remotePort };
            let finalResponse = {
              statusCode: proxyRes.statusCode,
              statusMessage: proxyRes.statusMessage,
              headers: proxyRes.headers,
              body: resBody,
              trailers: proxyRes.trailers
            };
            if (responseBreakpoint) {
              finalResponse = await this._pauseResponseBreakpoint({
                requestId, protocol: 'h2', method, url: fullUrl, host: authority, path,
                requestHeaders: reqHeaders, requestBody: body,
                statusCode: proxyRes.statusCode, statusMessage: proxyRes.statusMessage,
                responseHeaders: proxyRes.headers, responseBody: resBody,
                trailers: proxyRes.trailers, startTime, tlsDetails, remote
              });
            }
            const responseHeaders = this._toH2ResponseHeaders(
              finalResponse.statusCode, finalResponse.headers
            );

            try {
              if (!stream.destroyed && !stream.closed) {
                this._sendH2Response(stream, responseHeaders, finalResponse.body, finalResponse.trailers);
              }
            } catch (e) { /* stream already closed */ }

            emitH2Success(
              finalResponse.statusCode,
              finalResponse.statusMessage,
              finalResponse.headers,
              finalResponse.body,
              remote,
              finalResponse.trailers
            );
          });
        };

        const handleError = (err, request) => {
          try {
            if (!stream.destroyed && !stream.closed) {
              stream.respond({ ':status': 502 });
              stream.end('Proxy Error: ' + err.message);
            }
          } catch (e) { /* stream already closed */ }
          emitH2Error(err, request);
        };

        let proxyReq;
        const sendProxyRequest = (attempt = 0) => {
          const proxyGeneration = this._upstreamProxyGeneration;
          if (this.upstreamProxy) {
            try {
              const agent = this._getUpstreamAgent();
              proxyReq = https.request({
                ...proxyOpts,
                agent,
                insecureHTTPParser: true
              }, handleResponse(attempt, proxyGeneration));
            } catch (err) {
              handleError(err, null);
              return;
            }
          } else {
            proxyReq = https.request(proxyOpts, handleResponse(attempt, proxyGeneration));
          }

          const attemptReq = proxyReq;
          attemptReq._upstreamProxyGeneration = proxyGeneration;
          this._configureUpstreamRequest(attemptReq);
          attemptReq.once('error', async (err) => {
            if (await this._shouldRetryAfterUpstreamError(err, {
              attempt, proxyGeneration, method, url: fullUrl, host: authority
            })) {
              sendProxyRequest(attempt + 1);
              return;
            }
            handleError(err, attemptReq);
          });
          this._endH1Request(attemptReq, body, requestTrailers);
        };

        sendProxyRequest();
      });

      // Handle stream errors (e.g., client reset)
      stream.on('error', (err) => {
        if (err.code === 'ERR_HTTP2_STREAM_ERROR' ||
            err.code === 'ERR_HTTP2_STREAM_CANCEL' ||
            err.code === 'ECONNRESET') return;
      });
    });

    // HTTP/1.1 fallback — when allowHTTP1 is true and client negotiates h1.1
    h2Server.on('request', (req, res) => {
      httpRequestReceived = true;
      clearTimeout(tunnelTimer);
      // This fires for HTTP/1.1 requests when allowHTTP1 is true.
      // HTTP/2 requests are handled by the 'stream' event above, not this one.
      // Only handle if this is actually an HTTP/1.1 request (not an h2 stream).
      if (req.httpVersion === '2.0') return; // already handled by 'stream'

      const startTime = Date.now();
      const requestId = uuidv4();
      this.requestCount++;
      let fullUrl = `https://${urlHostname}${targetPort !== 443 ? ':' + targetPort : ''}${req.url}`;

      const requestBody = this._createBodyCollector();
      req.on('data', chunk => this._appendBodyChunk(requestBody, chunk));
      req.on('end', async () => {
        if (requestBody.exceeded) {
          res.writeHead(413, { 'Content-Type': 'text/plain', Connection: 'close' });
          res.end('Request body too large');
          return;
        }
        let body = this._concatBody(requestBody);
        let breakpointBodyModified = false;

        // Emit pending request immediately so it appears in the UI
        this._emitPendingRequest({
          id: requestId, protocol: 'https', method: req.method, url: fullUrl,
          host: hostname, path: req.url, requestHeaders: req.headers,
          requestBody: this._safeBodyString(body), requestBodySize: body.length,
          timestamp: startTime, source: 'proxy', tls: tlsDetails, remote: null
        });

        // Check mock rules
        const mockRule = this._findMockRule(req.method, fullUrl, req.headers, this._safeBodyString(body));
        const mockBreakpointPhase = this._getMockBreakpointPhase(mockRule);
        if (mockRule && !mockBreakpointPhase) {
          await this._serveMockResponseH1OnH2(
            requestId, req, res, fullUrl, hostname, targetPort, body, mockRule, startTime, tlsDetails
          );
          return;
        }

        // Check breakpoint rules
        const breakpointRule = mockBreakpointPhase === 'request'
          ? mockRule
          : this._checkBreakpoint(req.method, fullUrl, req.headers);
        const responseBreakpoint = mockBreakpointPhase === 'response';
        if (breakpointRule) {
          this._emitRequest({
            id: requestId, protocol: 'https', method: req.method, url: fullUrl,
            host: hostname, path: req.url, requestHeaders: req.headers,
            requestBody: this._safeBodyString(body), requestBodySize: body.length,
            statusCode: 0, statusMessage: 'Breakpoint', responseHeaders: {},
            responseBody: '', responseBodySize: 0,
            duration: 0, timestamp: startTime, source: 'breakpoint',
            tls: tlsDetails, remote: null
          });
          try {
            this.onBreakpoint({
              type: 'breakpoint-hit', requestId,
              method: req.method, url: fullUrl, host: hostname
            });
          } catch (err) {
            console.error('[Proxy] Error in breakpoint handler:', err.message);
          }
          const modifications = await new Promise((resolve) => {
            this.pendingBreakpoints.set(requestId, {
              method: req.method, url: fullUrl, host: hostname,
              path: req.url, headers: req.headers,
              body: this._safeBodyString(body), timestamp: Date.now(), resolve
            });
            this._setBreakpointTimeout(requestId);
          });
          if (modifications.url) {
            try {
              const nextUrl = new URL(modifications.url);
              fullUrl = nextUrl.href;
              hostname = nextUrl.hostname;
              targetPort = parseInt(nextUrl.port, 10) || 443;
              req.url = nextUrl.pathname + nextUrl.search;
            } catch { /* keep original */ }
          }
          if (modifications.method) req.method = modifications.method;
          if (modifications.headers) Object.assign(req.headers, modifications.headers);
          if (Object.prototype.hasOwnProperty.call(modifications, 'body')) {
            body = Buffer.from(String(modifications.body || ''));
            this._setContentLength(req.headers, body.length);
            breakpointBodyModified = true;
          }
        }

        // Forward to real server — try HTTP/2 upstream first
        let upstreamProtocol = 'https';

        const emitH1Success = (statusCode, statusMessage, responseHeaders, resBody, remote) => {
          const duration = Date.now() - startTime;
          this._emitRequestUpdate({
            id: requestId, protocol: upstreamProtocol, method: req.method, url: fullUrl,
            host: hostname, path: req.url, requestHeaders: req.headers,
            requestBody: this._safeBodyString(body), requestBodySize: body.length,
            statusCode, statusMessage, responseHeaders,
            responseBody: this._safeBodyString(resBody, responseHeaders['content-encoding'], responseHeaders['content-type']),
            responseBodySize: resBody.length, duration, timestamp: startTime, source: 'proxy',
            tls: tlsDetails, remote
          });
        };

        const emitH1Error = (err, request) => {
          const duration = Date.now() - startTime;
          this._emitRequestUpdate({
            id: requestId, protocol: upstreamProtocol, method: req.method, url: fullUrl,
            host: hostname, path: req.url, requestHeaders: req.headers,
            requestBody: this._safeBodyString(body), requestBodySize: body.length,
            statusCode: 502, statusMessage: 'Bad Gateway', responseHeaders: {},
            responseBody: `Proxy Error: ${err.message}`, responseBodySize: 0,
            duration, timestamp: startTime, error: err.message,
            errorCode: this._getUpstreamErrorCode(err),
            errorPhase: this._getUpstreamErrorPhase(err),
            upstreamProxyGeneration: request?._upstreamProxyGeneration,
            upstreamProxyConnect: request?._upstreamProxyConnect || null,
            source: 'proxy',
            tls: tlsDetails, remote: null
          });
        };

        // Try HTTP/2 upstream (skip if upstream proxy is configured)
        if (!this.upstreamProxy) {
          try {
            const h2Session = await this._getH2Session(hostname, targetPort);
            if (h2Session) {
              upstreamProtocol = 'h2';
              const h2Res = await this._makeH2Request(
                h2Session, req.method, hostname, targetPort, req.url, req.headers, body, req.trailers
              );
              const remote = { address: h2Res.remoteAddress, port: h2Res.remotePort };
              let finalResponse = {
                statusCode: h2Res.statusCode,
                statusMessage: h2Res.statusMessage,
                headers: h2Res.headers,
                body: h2Res.body,
                trailers: h2Res.trailers
              };
              if (responseBreakpoint) {
                finalResponse = await this._pauseResponseBreakpoint({
                  requestId, protocol: 'https', method: req.method, url: fullUrl,
                  host: hostname, path: req.url, requestHeaders: req.headers, requestBody: body,
                  statusCode: h2Res.statusCode, statusMessage: h2Res.statusMessage,
                  responseHeaders: h2Res.headers, responseBody: h2Res.body,
                  trailers: h2Res.trailers, startTime, tlsDetails, remote
                });
              }
              try {
                this._sendH1Response(
                  res, finalResponse.statusCode, finalResponse.headers, finalResponse.body, finalResponse.trailers
                );
              } catch (e) { /* client gone */ }
              emitH1Success(
                finalResponse.statusCode,
                finalResponse.statusMessage,
                finalResponse.headers,
                finalResponse.body,
                remote
              );
              return;
            }
          } catch (err) {
            // H2 request failed — fall back to h1.1
            upstreamProtocol = 'https';
          }
        }

        // Fallback: HTTPS/1.1 — preserve raw header case
        const proxyOpts = {
          hostname, port: targetPort, path: req.url, method: req.method,
          headers: (() => {
            const headers = this._stripUpstreamHeaders({
              ...this._rawHeadersToObject(req.rawHeaders),
              ...req.headers
            });
            if (breakpointBodyModified) this._setContentLength(headers, body.length);
            return headers;
          })(),
          ...this._getUpstreamTlsOptions(hostname, tlsSocket._clientHelloTls)
        };

        const handleResponse = (attempt, proxyGeneration) => (proxyRes) => {
          this._forwardUpstreamResponseErrors(proxyRes, proxyReq);
          const responseBody = this._createBodyCollector();
          proxyRes.on('data', chunk => {
            if (!this._appendBodyChunk(responseBody, chunk)) {
              proxyReq.destroy(this._bodyLimitError('Upstream response body'));
            }
          });
          proxyRes.on('end', async () => {
            const resBody = this._concatBody(responseBody);
            if (await this._shouldRetryAfterUpstreamResponse(proxyRes, {
              attempt, proxyGeneration, method: req.method, url: fullUrl, host: hostname
            })) {
              sendProxyRequest(attempt + 1);
              return;
            }

            const trailers = proxyRes.trailers;
            const remote = { address: proxyReq?.socket?.remoteAddress, port: proxyReq?.socket?.remotePort };
            let finalResponse = {
              statusCode: proxyRes.statusCode,
              statusMessage: proxyRes.statusMessage,
              headers: proxyRes.headers,
              body: resBody,
              trailers
            };
            if (responseBreakpoint) {
              finalResponse = await this._pauseResponseBreakpoint({
                requestId, protocol: 'https', method: req.method, url: fullUrl,
                host: hostname, path: req.url, requestHeaders: req.headers, requestBody: body,
                statusCode: proxyRes.statusCode, statusMessage: proxyRes.statusMessage,
                responseHeaders: proxyRes.headers, responseBody: resBody,
                trailers, startTime, tlsDetails, remote
              });
            }
            try {
              this._sendH1Response(
                res, finalResponse.statusCode, finalResponse.headers, finalResponse.body, finalResponse.trailers
              );
            } catch (e) { /* client gone */ }
            emitH1Success(
              finalResponse.statusCode,
              finalResponse.statusMessage,
              finalResponse.headers,
              finalResponse.body,
              remote
            );
          });
        };

        const handleError = (err, request) => {
          try {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end(`Proxy Error: ${err.message}`);
          } catch (e) { /* client gone */ }
          emitH1Error(err, request);
        };

        let proxyReq;
        const sendProxyRequest = (attempt = 0) => {
          const proxyGeneration = this._upstreamProxyGeneration;
          if (this.upstreamProxy) {
            const agent = this._getUpstreamAgent();
            proxyReq = https.request({
              ...proxyOpts,
              agent,
              insecureHTTPParser: true
            }, handleResponse(attempt, proxyGeneration));
          } else {
            proxyReq = https.request(proxyOpts, handleResponse(attempt, proxyGeneration));
          }

          const attemptReq = proxyReq;
          attemptReq._upstreamProxyGeneration = proxyGeneration;
          this._configureUpstreamRequest(attemptReq);
          attemptReq.once('error', async (err) => {
            if (await this._shouldRetryAfterUpstreamError(err, {
              attempt, proxyGeneration, method: req.method, url: fullUrl, host: hostname
            })) {
              sendProxyRequest(attempt + 1);
              return;
            }
            handleError(err, attemptReq);
          });
          this._endH1Request(attemptReq, body, req.trailers);
        };

        sendProxyRequest();
      });
    });

    h2Server.on('sessionError', (err) => {
      if (err.code === 'ECONNRESET' || err.code === 'EPIPE') return;
      console.error(`[Proxy] HTTP/2 session error for ${hostname}:`, err.message);
    });

    h2Server.on('error', (err) => {
      if (err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.code === 'ECONNABORTED' ||
          err.code === 'ERR_STREAM_DESTROYED' || err.message?.includes('stream was destroyed')) return;
      console.error(`[Proxy] HTTP/2 server error for ${hostname}:`, err.message);
    });

    h2Server.emit('connection', socket);

    let tlsErrorEmitted = false;
    const handleTlsSocketError = (err) => {
      if (err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.code === 'ECONNABORTED') return;
      if (err.code === 'ERR_STREAM_DESTROYED' || err.message?.includes('ECONNABORTED') ||
          err.message?.includes('stream was destroyed')) return;
      if (err.message?.includes('ssl') || err.message?.includes('SSL') ||
          err.message?.includes('handshake') || err.message?.includes('HANDSHAKE') ||
          err.code === 'ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN' ||
          err.code === 'ERR_SSL_WRONG_VERSION_NUMBER') {
        if (tlsErrorEmitted) return;
        tlsErrorEmitted = true;
        this._emitRequest({
          id: uuidv4(),
          protocol: 'tls-error',
          method: 'CONNECT',
          url: `https://${urlHostname}:${targetPort}`,
          host: hostname,
          path: '/',
          requestHeaders: {},
          requestBody: '',
          requestBodySize: 0,
          statusCode: 0,
          statusMessage: 'TLS Handshake Failed',
          responseHeaders: {},
          responseBody: err.message || 'TLS error',
          responseBodySize: 0,
          duration: 0,
          timestamp: Date.now(),
          error: err.message,
          errorCode: err.code || null,
          source: 'tls-error',
          tls: null,
          remote: null
        });
        return;
      }
      console.error(`[Proxy] TLS error for ${hostname}:`, err.message);
    };
    h2Server.on('tlsClientError', handleTlsSocketError);
    socket.on('error', handleTlsSocketError);
  }

  // Handle mock responses for HTTP/2 streams
  async _handleH2MockResponse(stream, mockRule, ctx) {
    const { requestId, requestTrailers, startTime, tlsDetails } = ctx;
    let { method, fullUrl, authority, path, reqHeaders, body } = ctx;

    const action = mockRule.action || {
      type: 'fixed-response',
      status: mockRule.response?.status || 200,
      headers: mockRule.response?.headers || { 'Content-Type': 'application/json' },
      body: mockRule.response?.body || '',
      delay: 0
    };

    // Capture original request data before pre-steps modify it
    const origHeaders = { ...reqHeaders };

    // Execute pre-steps
    const preSteps = mockRule.preSteps || [];
    for (const step of preSteps) {
      switch (step.type) {
        case 'delay':
          if (step.ms > 0) await new Promise(r => setTimeout(r, step.ms));
          break;
        case 'add-header':
          if (step.name) reqHeaders[step.name.toLowerCase()] = step.value || '';
          break;
        case 'remove-header':
          if (step.name) delete reqHeaders[step.name.toLowerCase()];
          break;
      }
    }

    // Detect if pre-steps transformed the request
    const transformed = JSON.stringify(origHeaders) !== JSON.stringify(reqHeaders);
    const originalRequest = transformed ? {
      method, url: fullUrl, headers: origHeaders,
      body: this._safeBodyString(body)
    } : null;
    const transformedBy = originalRequest ? (mockRule.title || mockRule.id || 'Mock Rule') : null;

    // Close connection
    if (action.type === 'close' || action.type === 'reset') {
      try { stream.destroy(); } catch (e) { /* */ }
      this._emitRequest({
        id: requestId, protocol: 'h2', method, url: fullUrl,
        host: authority, path, requestHeaders: reqHeaders,
        requestBody: this._safeBodyString(body), requestBodySize: body.length,
        statusCode: 0, statusMessage: action.type === 'close' ? 'Connection Closed' : 'Connection Reset',
        responseHeaders: {}, responseBody: '', responseBodySize: 0,
        duration: Date.now() - startTime, timestamp: startTime, source: 'mock',
        tls: tlsDetails, remote: null,
        originalRequest, transformedBy
      });
      return;
    }

    // Apply delay
    if (action.delay && action.delay > 0) {
      await new Promise(r => setTimeout(r, action.delay));
    }

    // Forward action
    if (action.type === 'forward' && action.forwardTo) {
      try {
        const forwardUrl = new URL(action.forwardTo);
        const isForwardHttps = forwardUrl.protocol === 'https:';
        const fwdLib = isForwardHttps ? https : http;
        const fwdHeaders = { ...reqHeaders };
        if (action.addRequestHeaders) {
          for (const [k, v] of Object.entries(action.addRequestHeaders)) {
            fwdHeaders[k.toLowerCase()] = v;
          }
        }
        fwdHeaders.host = forwardUrl.host;

        const fwdReq = fwdLib.request({
          hostname: forwardUrl.hostname,
          port: forwardUrl.port || (isForwardHttps ? 443 : 80),
          path,
          method,
          headers: fwdHeaders,
          ...(isForwardHttps ? this._getUpstreamTlsOptions(forwardUrl.hostname) : {})
        }, (fwdRes) => {
          const responseBody = this._createBodyCollector();
          fwdRes.on('data', chunk => {
            if (!this._appendBodyChunk(responseBody, chunk)) {
              fwdReq.destroy(this._bodyLimitError('Mock forward response body'));
            }
          });
          fwdRes.on('end', () => {
            const resBody = this._concatBody(responseBody);
            const resHeaders = this._toH2ResponseHeaders(fwdRes.statusCode, fwdRes.headers);
            if (action.addResponseHeaders) {
              for (const [k, v] of Object.entries(action.addResponseHeaders)) {
                resHeaders[k.toLowerCase()] = v;
              }
            }
            try {
              if (!stream.destroyed && !stream.closed) {
                this._sendH2Response(stream, resHeaders, resBody, fwdRes.trailers);
              }
            } catch (e) { /* stream closed */ }
            this._emitRequest({
              id: requestId, protocol: 'h2', method, url: fullUrl,
              host: authority, path, requestHeaders: reqHeaders,
              requestBody: this._safeBodyString(body), requestBodySize: body.length,
              statusCode: fwdRes.statusCode, statusMessage: fwdRes.statusMessage,
              responseHeaders: fwdRes.headers,
              responseBody: this._safeBodyString(resBody, fwdRes.headers['content-encoding'], fwdRes.headers['content-type']),
              responseBodySize: resBody.length, duration: Date.now() - startTime,
              timestamp: startTime, source: 'mock',
              tls: tlsDetails, remote: { address: fwdReq.socket?.remoteAddress, port: fwdReq.socket?.remotePort },
              originalRequest, transformedBy
            });
          });
        });
        fwdReq.on('error', (err) => {
          try {
            if (!stream.destroyed && !stream.closed) {
              stream.respond({ ':status': 502 });
              stream.end('Forward Error: ' + err.message);
            }
          } catch (e) { /* stream closed */ }
          this._emitRequest({
            id: requestId, protocol: 'h2', method, url: fullUrl,
            host: authority, path, requestHeaders: reqHeaders,
            requestBody: this._safeBodyString(body), requestBodySize: body.length,
            statusCode: 502, statusMessage: 'Bad Gateway', responseHeaders: {},
            responseBody: 'Forward Error: ' + err.message, responseBodySize: 0,
            duration: Date.now() - startTime, timestamp: startTime, source: 'mock',
            error: err.message, tls: tlsDetails, remote: null,
            originalRequest, transformedBy
          });
        });
        this._endH1Request(fwdReq, body, requestTrailers);
      } catch (err) {
        try {
          if (!stream.destroyed && !stream.closed) {
            stream.respond({ ':status': 500 });
            stream.end('Forward setup error: ' + err.message);
          }
        } catch (e) { /* stream closed */ }
      }
      return;
    }

    // Serve content from a file
    if (action.type === 'serve-file') {
      const filePath = action.filePath;
      if (!filePath) {
        try {
          if (!stream.destroyed && !stream.closed) {
            stream.respond({ ':status': 500, 'content-type': 'text/plain' });
            stream.end('Mock error: no filePath configured');
          }
        } catch (e) { /* */ }
        return;
      }
      try {
        const content = fs.readFileSync(filePath);
        const mime = action.contentType || 'application/octet-stream';
        const fileStatus = action.status || 200;
        if (!stream.destroyed && !stream.closed) {
          stream.respond({ ':status': fileStatus, 'content-type': mime });
          stream.end(content);
        }
        this._emitRequest({
          id: requestId, protocol: 'h2', method, url: fullUrl,
          host: authority, path, requestHeaders: reqHeaders,
          requestBody: this._safeBodyString(body), requestBodySize: body.length,
          statusCode: fileStatus, statusMessage: 'Mocked (file)',
          responseHeaders: { 'Content-Type': mime },
          responseBody: this._safeBodyString(content),
          responseBodySize: content.length,
          duration: Date.now() - startTime, timestamp: startTime, source: 'mock',
          tls: tlsDetails, remote: null,
          originalRequest, transformedBy
        });
      } catch (err) {
        try {
          if (!stream.destroyed && !stream.closed) {
            stream.respond({ ':status': 500, 'content-type': 'text/plain' });
            stream.end('File not found: ' + filePath);
          }
        } catch (e) { /* */ }
      }
      return;
    }

    // Breakpoint on request
    if (action.type === 'breakpoint-request') {
      this._emitRequest({
        id: requestId, protocol: 'h2', method, url: fullUrl,
        host: authority, path, requestHeaders: reqHeaders,
        requestBody: this._safeBodyString(body), requestBodySize: body.length,
        statusCode: 0, statusMessage: 'Breakpoint', responseHeaders: {},
        responseBody: '', responseBodySize: 0,
        duration: 0, timestamp: startTime, source: 'breakpoint',
        tls: tlsDetails, remote: null,
        originalRequest, transformedBy
      });
      try {
        this.onBreakpoint({ type: 'breakpoint-hit', requestId, method, url: fullUrl, host: authority });
      } catch (err) { console.error('[Proxy] Error in breakpoint handler:', err.message); }
      const modifications = await new Promise((resolve) => {
        this.pendingBreakpoints.set(requestId, {
          method, url: fullUrl, host: authority, path, headers: reqHeaders,
          body: this._safeBodyString(body), timestamp: Date.now(), resolve
        });
        this._setBreakpointTimeout(requestId);
      });
      if (modifications.url) {
        try {
          const nextUrl = new URL(modifications.url);
          fullUrl = nextUrl.href;
          authority = nextUrl.host;
          path = nextUrl.pathname + nextUrl.search;
          reqHeaders[':authority'] = authority;
          reqHeaders[':path'] = path;
        } catch { /* keep original */ }
      }
      if (modifications.method) {
        method = String(modifications.method).trim().toUpperCase();
        reqHeaders[':method'] = method;
      }
      if (modifications.headers) Object.assign(reqHeaders, modifications.headers);
      if (Object.prototype.hasOwnProperty.call(modifications, 'body')) {
        body = Buffer.from(String(modifications.body || ''));
        this._setContentLength(reqHeaders, body.length);
      }
      // Fall through — but for h2 streams we can't easily re-proxy, so just send a generic response
    }

    // Breakpoint on response
    if (action.type === 'breakpoint-response') {
      this._emitRequest({
        id: requestId, protocol: 'h2', method, url: fullUrl,
        host: authority, path, requestHeaders: reqHeaders,
        requestBody: this._safeBodyString(body), requestBodySize: body.length,
        statusCode: 0, statusMessage: 'Breakpoint (response)', responseHeaders: {},
        responseBody: '', responseBodySize: 0,
        duration: 0, timestamp: startTime, source: 'breakpoint',
        tls: tlsDetails, remote: null,
        originalRequest, transformedBy
      });
      try {
        this.onBreakpoint({ type: 'breakpoint-hit', requestId, method, url: fullUrl, host: authority, phase: 'response' });
      } catch (err) { console.error('[Proxy] Error in breakpoint handler:', err.message); }
      const modifications = await new Promise((resolve) => {
        this.pendingBreakpoints.set(requestId, {
          method, url: fullUrl, host: authority, path, headers: reqHeaders,
          body: this._safeBodyString(body), timestamp: Date.now(), phase: 'response', resolve
        });
        this._setBreakpointTimeout(requestId);
      });
      if (modifications.status) {
        try {
          if (!stream.destroyed && !stream.closed) {
            stream.respond({ ':status': modifications.status, ...(modifications.headers || {}) });
            stream.end(modifications.body || '');
          }
        } catch (e) { /* stream closed */ }
      } else {
        try {
          if (!stream.destroyed && !stream.closed) {
            stream.respond({ ':status': 200, 'content-type': 'text/plain' });
            stream.end('Breakpoint released');
          }
        } catch (e) { /* stream closed */ }
      }
      return;
    }

    // Fixed response (default)
    const mockHeaders = { ':status': action.status || 200 };
    const actionHeaders = action.headers || { 'Content-Type': 'application/json' };
    for (const [k, v] of Object.entries(actionHeaders)) {
      mockHeaders[k.toLowerCase()] = v;
    }
    if (action.addResponseHeaders) {
      for (const [k, v] of Object.entries(action.addResponseHeaders)) {
        mockHeaders[k.toLowerCase()] = v;
      }
    }
    const mockBody = action.body || '';

    try {
      if (!stream.destroyed && !stream.closed) {
        stream.respond(mockHeaders);
        stream.end(mockBody);
      }
    } catch (e) { /* stream closed */ }

    this._emitRequest({
      id: requestId, protocol: 'h2', method, url: fullUrl,
      host: authority, path, requestHeaders: reqHeaders,
      requestBody: this._safeBodyString(body), requestBodySize: body.length,
      statusCode: action.status || 200, statusMessage: 'Mocked',
      responseHeaders: actionHeaders,
      responseBody: mockBody, responseBodySize: Buffer.byteLength(mockBody),
      duration: Date.now() - startTime, timestamp: startTime, source: 'mock',
      tls: tlsDetails, remote: null,
      originalRequest, transformedBy
    });
  }

  // Helper for HTTP/1.1 mock responses on the h2 fallback server
  async _serveMockResponseH1OnH2(requestId, req, res, fullUrl, hostname, targetPort, body, mockRule, startTime, tlsDetails) {
    // allowHTTP1 provides normal IncomingMessage/ServerResponse objects, so the
    // complete H1 mock engine can preserve every action and pre-step.
    const targetUrl = new URL(fullUrl);
    await this._serveMockResponse(requestId, req, res, targetUrl, body, mockRule, startTime, {
      protocol: 'https',
      tls: tlsDetails
    });
  }

  // Get or create an HTTP/2 session to the given origin, with caching.
  // Returns the h2 session or null if the origin doesn't support h2.
  _getH2Session(hostname, port) {
    const origin = `${hostname}:${port}`;
    const urlHostname = net.isIP(hostname) === 6 ? `[${hostname}]` : hostname;

    // Known not to support h2
    if (this._h2Blacklist.has(origin)) return Promise.resolve(null);

    // Already connecting — wait for it rather than exposing a session that has
    // not completed its TLS/ALPN handshake yet.
    const cached = this._h2Sessions.get(origin);
    if (cached && cached.pending) return cached.pending;

    // Existing live session
    if (cached && !cached.session.destroyed && !cached.session.closed) {
      // Reset idle timer
      clearTimeout(cached.timer);
      cached.timer = setTimeout(() => this._evictH2Session(origin), 60000);
      return Promise.resolve(cached.session);
    }

    // Create new session
    const pending = new Promise((resolve) => {
      const url = `https://${urlHostname}:${port}`;
      let settled = false;

      const session = http2.connect(url, {
        ...this._getUpstreamTlsOptions(hostname),
        ALPNProtocols: ['h2']
      });

      const timer = setTimeout(() => this._evictH2Session(origin), 60000);

      session.on('connect', () => {
        if (settled) return;
        settled = true;
        this._h2Sessions.set(origin, { session, timer });
        resolve(session);
      });

      session.on('error', (err) => {
        if (!settled) {
          settled = true;
          this._h2Blacklist.add(origin);
          this._h2Sessions.delete(origin);
          clearTimeout(timer);
          resolve(null);
        } else {
          // Session died after initial connect — evict
          this._evictH2Session(origin);
        }
      });

      session.on('close', () => {
        this._evictH2Session(origin);
      });

      session.on('goaway', () => {
        this._evictH2Session(origin);
      });

      // Timeout for initial connect
      const connectTimeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          this._h2Blacklist.add(origin);
          this._h2Sessions.delete(origin);
          clearTimeout(timer);
          session.destroy();
          resolve(null);
        }
      }, 5000);

      session.on('connect', () => clearTimeout(connectTimeout));
      session.on('error', () => clearTimeout(connectTimeout));

      // The pending promise is attached immediately after construction below.
      // Referencing it here would hit its temporal dead zone because Promise
      // executors run synchronously.
      this._h2Sessions.set(origin, { session, timer });
    });

    // Update cache entry with the pending promise
    const entry = this._h2Sessions.get(origin);
    if (entry) entry.pending = pending;

    return pending;
  }

  _evictH2Session(origin) {
    const cached = this._h2Sessions.get(origin);
    if (cached) {
      clearTimeout(cached.timer);
      if (cached.session && !cached.session.destroyed) {
        cached.session.close();
      }
      this._h2Sessions.delete(origin);
    }
  }

  _closeAllH2Sessions() {
    for (const [origin, cached] of this._h2Sessions) {
      clearTimeout(cached.timer);
      if (cached.session && !cached.session.destroyed) {
        cached.session.close();
      }
    }
    this._h2Sessions.clear();
    this._h2Blacklist.clear();
  }

  // Make an HTTP/2 request via a cached session. Returns a promise that resolves to
  // { statusCode, headers, body: Buffer, trailers } or null if the request can't be made via h2.
  _makeH2Request(session, method, hostname, port, path, headers, body, trailers = {}) {
    return new Promise((resolve, reject) => {
      // Build h2 pseudo-headers + regular headers
      const h2Headers = {
        ':method': method,
        ':path': path,
        ':scheme': 'https',
        ':authority': port === 443
          ? (net.isIP(hostname) === 6 ? `[${hostname}]` : hostname)
          : `${net.isIP(hostname) === 6 ? `[${hostname}]` : hostname}:${port}`
      };

      // Copy regular headers, filtering out h1-specific ones
      for (const [k, v] of Object.entries(headers)) {
        const lower = k.toLowerCase();
        if (lower.startsWith(':')) continue; // skip existing pseudo-headers
        if (['connection', 'keep-alive', 'transfer-encoding', 'upgrade',
             'http2-settings', 'host'].includes(lower) || this._shouldStripUpstreamHeader(lower)) continue;
        h2Headers[lower] = v;
      }

      const requestTrailers = this._cleanTrailers(trailers);
      const hasRequestTrailers = Object.keys(requestTrailers).length > 0;
      const stream = session.request(h2Headers, hasRequestTrailers ? { waitForTrailers: true } : undefined);

      let statusCode;
      const responseHeaders = {};
      let responseTrailers = {};
      const responseBody = this._createBodyCollector();

      stream.on('response', (hdrs) => {
        statusCode = hdrs[':status'];
        for (const [k, v] of Object.entries(hdrs)) {
          if (!k.startsWith(':')) {
            responseHeaders[k] = v;
          }
        }
      });

      stream.on('data', chunk => {
        if (!this._appendBodyChunk(responseBody, chunk)) {
          stream.destroy(this._bodyLimitError('HTTP/2 response body'));
        }
      });

      stream.on('trailers', receivedTrailers => {
        responseTrailers = this._cleanTrailers(receivedTrailers);
      });

      stream.on('end', () => {
        resolve({
          statusCode,
          statusMessage: '',
          headers: responseHeaders,
          body: this._concatBody(responseBody),
          trailers: responseTrailers,
          remoteAddress: session.socket?.remoteAddress,
          remotePort: session.socket?.remotePort
        });
      });

      stream.on('error', (err) => {
        reject(err);
      });

      stream.setTimeout(30000, () => {
        stream.close(http2.constants.NGHTTP2_CANCEL);
        reject(new Error('H2 stream timeout after 30s'));
      });

      if (hasRequestTrailers) {
        stream.once('wantTrailers', () => stream.sendTrailers(requestTrailers));
      }

      // Send request body
      if (body && body.length > 0) {
        stream.end(body);
      } else {
        stream.end();
      }
    });
  }

  // Parse a TLS ClientHello to extract cipher suites, supported groups, and sigalgs.
  // Used by the "passthrough" fingerprint mode to mirror the client's TLS profile upstream.
  static _parseClientHello(buf) {
    try {
      let pos = 0;
      // TLS record header: type(1) + version(2) + length(2)
      if (buf.length < 5 || buf[0] !== 0x16) return null; // not a Handshake record
      const recordLen = buf.readUInt16BE(3);
      if (buf.length < 5 + recordLen) return null;

      pos = 5;
      // Handshake header: type(1) + length(3)
      if (buf[pos] !== 0x01) return null; // not ClientHello
      const hsLen = (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3];
      pos += 4;

      const chStart = pos;
      // ClientHello: version(2) + random(32)
      const tlsVersion = buf.readUInt16BE(pos);
      pos += 2 + 32;

      // Session ID
      const sidLen = buf[pos]; pos += 1 + sidLen;

      // Cipher suites
      const csLen = buf.readUInt16BE(pos); pos += 2;
      const cipherSuites = [];
      for (let i = 0; i < csLen; i += 2) {
        cipherSuites.push(buf.readUInt16BE(pos + i));
      }
      pos += csLen;

      // Compression methods
      const compLen = buf[pos]; pos += 1 + compLen;

      // Extensions
      const groups = [];
      const sigalgs = [];
      if (pos < chStart + hsLen + 4) {
        const extLen = buf.readUInt16BE(pos); pos += 2;
        const extEnd = pos + extLen;
        while (pos + 4 <= extEnd) {
          const extType = buf.readUInt16BE(pos);
          const extDataLen = buf.readUInt16BE(pos + 2);
          pos += 4;
          if (extType === 0x000a && extDataLen >= 2) {
            // supported_groups
            const listLen = buf.readUInt16BE(pos);
            for (let i = 0; i < listLen; i += 2) {
              groups.push(buf.readUInt16BE(pos + 2 + i));
            }
          } else if (extType === 0x000d && extDataLen >= 2) {
            // signature_algorithms
            const listLen = buf.readUInt16BE(pos);
            for (let i = 0; i < listLen; i += 2) {
              sigalgs.push(buf.readUInt16BE(pos + 2 + i));
            }
          }
          pos += extDataLen;
        }
      }

      return { tlsVersion, cipherSuites, groups, sigalgs };
    } catch {
      return null;
    }
  }

  // Map TLS cipher suite hex codes to OpenSSL names
  static _CIPHER_MAP = {
    0x1301: 'TLS_AES_128_GCM_SHA256', 0x1302: 'TLS_AES_256_GCM_SHA384',
    0x1303: 'TLS_CHACHA20_POLY1305_SHA256',
    0xc02b: 'ECDHE-ECDSA-AES128-GCM-SHA256', 0xc02f: 'ECDHE-RSA-AES128-GCM-SHA256',
    0xc02c: 'ECDHE-ECDSA-AES256-GCM-SHA384', 0xc030: 'ECDHE-RSA-AES256-GCM-SHA384',
    0xcca9: 'ECDHE-ECDSA-CHACHA20-POLY1305', 0xcca8: 'ECDHE-RSA-CHACHA20-POLY1305',
    0xc009: 'ECDHE-ECDSA-AES128-SHA', 0xc013: 'ECDHE-RSA-AES128-SHA',
    0xc00a: 'ECDHE-ECDSA-AES256-SHA', 0xc014: 'ECDHE-RSA-AES256-SHA',
    0xc023: 'ECDHE-ECDSA-AES128-SHA256', 0xc027: 'ECDHE-RSA-AES128-SHA256',
    0xc024: 'ECDHE-ECDSA-AES256-SHA384', 0xc028: 'ECDHE-RSA-AES256-SHA384',
    0x009c: 'AES128-GCM-SHA256', 0x009d: 'AES256-GCM-SHA384',
    0x002f: 'AES128-SHA', 0x0035: 'AES256-SHA',
    0x003c: 'AES128-SHA256', 0x003d: 'AES256-SHA256',
    0xc007: 'ECDHE-ECDSA-RC4-SHA', 0xc011: 'ECDHE-RSA-RC4-SHA',
    0x0004: 'RC4-SHA', 0x0005: 'RC4-MD5',
    0x000a: 'DES-CBC3-SHA',
    0xc008: 'ECDHE-ECDSA-DES-CBC3-SHA', 0xc012: 'ECDHE-RSA-DES-CBC3-SHA',
  };

  // Map supported_groups hex codes to OpenSSL curve names
  static _GROUP_MAP = {
    0x0017: 'prime256v1', 0x0018: 'secp384r1', 0x0019: 'secp521r1',
    0x001d: 'X25519', 0x001e: 'X448',
    0x0100: 'ffdhe2048', 0x0101: 'ffdhe3072', 0x0102: 'ffdhe4096',
    0x11ec: 'X25519MLKEM768',
  };

  // Map signature_algorithms hex codes to OpenSSL sigalgs names
  static _SIGALG_MAP = {
    0x0401: 'rsa_pkcs1_sha256', 0x0501: 'rsa_pkcs1_sha384', 0x0601: 'rsa_pkcs1_sha512',
    0x0201: 'rsa_pkcs1_sha1',
    0x0403: 'ecdsa_secp256r1_sha256', 0x0503: 'ecdsa_secp384r1_sha384', 0x0603: 'ecdsa_secp521r1_sha512',
    0x0203: 'ECDSA+SHA1',
    0x0804: 'rsa_pss_rsae_sha256', 0x0805: 'rsa_pss_rsae_sha384', 0x0806: 'rsa_pss_rsae_sha512',
    0x0809: 'rsa_pss_pss_sha256', 0x080a: 'rsa_pss_pss_sha384', 0x080b: 'rsa_pss_pss_sha512',
  };

  // Convert parsed ClientHello to Node.js tls options
  static _clientHelloToTlsOptions(parsed) {
    if (!parsed) return null;

    // Filter out GREASE values (0x?a?a pattern)
    const isGrease = (v) => (v & 0x0f0f) === 0x0a0a;

    const ciphers = parsed.cipherSuites
      .filter(c => !isGrease(c))
      .map(c => ProxyServer._CIPHER_MAP[c])
      .filter(Boolean);

    const groups = parsed.groups
      .filter(g => !isGrease(g))
      .map(g => ProxyServer._GROUP_MAP[g])
      .filter(Boolean);

    const sigalgs = parsed.sigalgs
      .filter(s => !isGrease(s))
      .map(s => ProxyServer._SIGALG_MAP[s])
      .filter(Boolean);

    if (ciphers.length === 0) return null;

    return {
      ciphers: ciphers.join(':'),
      ecdhCurve: ProxyServer._filterSupportedEcdhCurves(groups.join(':')),
      sigalgs: sigalgs.length > 0 ? sigalgs.join(':') : undefined,
      minVersion: parsed.tlsVersion <= 0x0301 ? 'TLSv1' : 'TLSv1.2',
      maxVersion: 'TLSv1.3',
    };
  }

  static _ecdhCurveSupport = new Map();

  static _isEcdhCurveSupported(curve) {
    if (!curve) return false;
    if (ProxyServer._ecdhCurveSupport.has(curve)) {
      return ProxyServer._ecdhCurveSupport.get(curve);
    }
    try {
      tls.createSecureContext({ ecdhCurve: curve });
      ProxyServer._ecdhCurveSupport.set(curve, true);
      return true;
    } catch {
      ProxyServer._ecdhCurveSupport.set(curve, false);
      return false;
    }
  }

  static _filterSupportedEcdhCurves(ecdhCurve) {
    const curves = String(ecdhCurve || '')
      .split(':')
      .map(curve => curve.trim())
      .filter(Boolean)
      .filter(curve => ProxyServer._isEcdhCurveSupported(curve));
    return curves.length > 0 ? curves.join(':') : undefined;
  }

  static _sanitizeUpstreamTlsOptions(options) {
    const sanitized = { ...options };
    if (sanitized.ecdhCurve) {
      sanitized.ecdhCurve = ProxyServer._filterSupportedEcdhCurves(sanitized.ecdhCurve);
      if (!sanitized.ecdhCurve) delete sanitized.ecdhCurve;
    }
    return sanitized;
  }

  // Create a Duplex wrapper around a socket that transparently captures the
  // first chunk (the TLS ClientHello) as it passes through. Unlike unshift(),
  // this works with tls.TLSSocket which reads from the native handle.
  _createCapturingSocket(socket, initialData = Buffer.alloc(0)) {
    let captured = initialData.length > 0;
    const wrapper = new Duplex({
      read() { socket.resume(); },
      write(chunk, enc, cb) { socket.write(chunk, enc, cb); },
      final(cb) {
        if (socket.destroyed || socket.writableEnded) {
          cb();
          return;
        }
        socket.end(cb);
      },
      destroy(err, cb) { socket.destroy(err); cb(err); }
    });
    wrapper._captured = captured
      ? ProxyServer._parseClientHello(initialData)
      : null; // will hold parsed ClientHello

    if (initialData.length > 0) wrapper.push(initialData);

    socket.on('data', (chunk) => {
      if (!captured) {
        captured = true;
        wrapper._captured = ProxyServer._parseClientHello(chunk);
      }
      if (!wrapper.push(chunk)) socket.pause();
    });
    wrapper.on('drain', () => socket.resume());
    socket.on('end', () => wrapper.push(null));
    socket.on('error', (err) => { if (!wrapper.destroyed) wrapper.destroy(err); });
    socket.on('close', () => { if (!wrapper.destroyed) wrapper.destroy(); });
    wrapper.on('close', () => { if (!socket.destroyed) socket.destroy(); });

    return wrapper;
  }

  // TLS fingerprint presets — emulate real browser Client Hello parameters
  // to prevent JA3/bot detection (Cloudflare, Akamai, etc.) from blocking.
  static TLS_FINGERPRINTS = {
    'chrome-136': {
      label: 'Chrome 136',
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.3',
      ciphers: [
        'TLS_AES_128_GCM_SHA256', 'TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256',
        'ECDHE-ECDSA-AES128-GCM-SHA256', 'ECDHE-RSA-AES128-GCM-SHA256',
        'ECDHE-ECDSA-AES256-GCM-SHA384', 'ECDHE-RSA-AES256-GCM-SHA384',
        'ECDHE-ECDSA-CHACHA20-POLY1305', 'ECDHE-RSA-CHACHA20-POLY1305',
        'ECDHE-RSA-AES128-SHA', 'ECDHE-RSA-AES256-SHA',
        'AES128-GCM-SHA256', 'AES256-GCM-SHA384', 'AES128-SHA', 'AES256-SHA',
      ].join(':'),
      sigalgs: [
        'ecdsa_secp256r1_sha256', 'rsa_pss_rsae_sha256', 'rsa_pkcs1_sha256',
        'ecdsa_secp384r1_sha384', 'rsa_pss_rsae_sha384', 'rsa_pkcs1_sha384',
        'rsa_pss_rsae_sha512', 'rsa_pkcs1_sha512',
      ].join(':'),
      ecdhCurve: 'X25519:P-256:P-384',
    },
    'chrome-124': {
      label: 'Chrome 124',
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.3',
      ciphers: [
        'TLS_AES_128_GCM_SHA256', 'TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256',
        'ECDHE-ECDSA-AES128-GCM-SHA256', 'ECDHE-RSA-AES128-GCM-SHA256',
        'ECDHE-ECDSA-AES256-GCM-SHA384', 'ECDHE-RSA-AES256-GCM-SHA384',
        'ECDHE-ECDSA-CHACHA20-POLY1305', 'ECDHE-RSA-CHACHA20-POLY1305',
        'ECDHE-RSA-AES128-SHA', 'ECDHE-RSA-AES256-SHA',
        'AES128-GCM-SHA256', 'AES256-GCM-SHA384', 'AES128-SHA', 'AES256-SHA',
      ].join(':'),
      sigalgs: [
        'ecdsa_secp256r1_sha256', 'rsa_pss_rsae_sha256', 'rsa_pkcs1_sha256',
        'ecdsa_secp384r1_sha384', 'rsa_pss_rsae_sha384', 'rsa_pkcs1_sha384',
        'rsa_pss_rsae_sha512', 'rsa_pkcs1_sha512',
      ].join(':'),
      ecdhCurve: 'X25519:P-256:P-384',
    },
    'firefox-133': {
      label: 'Firefox 133',
      minVersion: 'TLSv1',
      maxVersion: 'TLSv1.3',
      ciphers: [
        'TLS_AES_128_GCM_SHA256', 'TLS_CHACHA20_POLY1305_SHA256', 'TLS_AES_256_GCM_SHA384',
        'ECDHE-ECDSA-AES128-GCM-SHA256', 'ECDHE-RSA-AES128-GCM-SHA256',
        'ECDHE-ECDSA-CHACHA20-POLY1305', 'ECDHE-RSA-CHACHA20-POLY1305',
        'ECDHE-ECDSA-AES256-GCM-SHA384', 'ECDHE-RSA-AES256-GCM-SHA384',
        'ECDHE-ECDSA-AES256-SHA', 'ECDHE-ECDSA-AES128-SHA',
        'ECDHE-RSA-AES128-SHA', 'ECDHE-RSA-AES256-SHA',
        'AES128-GCM-SHA256', 'AES256-GCM-SHA384', 'AES128-SHA', 'AES256-SHA',
      ].join(':') + ':@SECLEVEL=0',
      sigalgs: [
        'ecdsa_secp256r1_sha256', 'ecdsa_secp384r1_sha384', 'ecdsa_secp521r1_sha512',
        'rsa_pss_rsae_sha256', 'rsa_pss_rsae_sha384', 'rsa_pss_rsae_sha512',
        'rsa_pkcs1_sha256', 'rsa_pkcs1_sha384', 'rsa_pkcs1_sha512',
        'ECDSA+SHA1', 'rsa_pkcs1_sha1',
      ].join(':'),
      ecdhCurve: 'X25519:prime256v1:secp384r1:secp521r1',
    },
    'safari-18': {
      label: 'Safari 18',
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.3',
      ciphers: [
        'TLS_AES_128_GCM_SHA256', 'TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256',
        'ECDHE-ECDSA-AES256-GCM-SHA384', 'ECDHE-ECDSA-AES128-GCM-SHA256',
        'ECDHE-ECDSA-CHACHA20-POLY1305',
        'ECDHE-RSA-AES256-GCM-SHA384', 'ECDHE-RSA-AES128-GCM-SHA256',
        'ECDHE-RSA-CHACHA20-POLY1305',
        'AES256-GCM-SHA384', 'AES128-GCM-SHA256',
        'ECDHE-ECDSA-AES256-SHA384', 'ECDHE-ECDSA-AES128-SHA256',
        'ECDHE-RSA-AES256-SHA384', 'ECDHE-RSA-AES128-SHA256',
        'AES256-SHA256', 'AES128-SHA256',
        'ECDHE-ECDSA-AES256-SHA', 'ECDHE-ECDSA-AES128-SHA',
        'ECDHE-RSA-AES256-SHA', 'ECDHE-RSA-AES128-SHA',
        'AES256-SHA', 'AES128-SHA',
      ].join(':'),
      sigalgs: [
        'ecdsa_secp256r1_sha256', 'rsa_pss_rsae_sha256', 'rsa_pkcs1_sha256',
        'ecdsa_secp384r1_sha384', 'rsa_pss_rsae_sha384', 'rsa_pkcs1_sha384',
        'rsa_pss_rsae_sha512', 'rsa_pkcs1_sha512',
      ].join(':'),
      ecdhCurve: 'X25519:P-256:P-384:P-521',
    },
    'edge-136': {
      label: 'Edge 136',
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.3',
      ciphers: [
        'TLS_AES_128_GCM_SHA256', 'TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256',
        'ECDHE-ECDSA-AES128-GCM-SHA256', 'ECDHE-RSA-AES128-GCM-SHA256',
        'ECDHE-ECDSA-AES256-GCM-SHA384', 'ECDHE-RSA-AES256-GCM-SHA384',
        'ECDHE-ECDSA-CHACHA20-POLY1305', 'ECDHE-RSA-CHACHA20-POLY1305',
        'ECDHE-RSA-AES128-SHA', 'ECDHE-RSA-AES256-SHA',
        'AES128-GCM-SHA256', 'AES256-GCM-SHA384', 'AES128-SHA', 'AES256-SHA',
      ].join(':'),
      sigalgs: [
        'ecdsa_secp256r1_sha256', 'rsa_pss_rsae_sha256', 'rsa_pkcs1_sha256',
        'ecdsa_secp384r1_sha384', 'rsa_pss_rsae_sha384', 'rsa_pkcs1_sha384',
        'rsa_pss_rsae_sha512', 'rsa_pkcs1_sha512',
      ].join(':'),
      ecdhCurve: 'X25519:P-256:P-384',
    },
  };

  _getUpstreamTlsOptions(hostname, clientHelloTls) {
    const base = {
      servername: net.isIP(hostname) ? undefined : hostname,
      rejectUnauthorized: !this._isHttpsWhitelisted(hostname),
      ...(this._trustedCaCertificates.length > 0
        ? { ca: [...tls.rootCertificates, ...this._trustedCaCertificates] }
        : {}),
      ...this._getClientCertificateOptions(hostname),
    };

    // Passthrough mode — mirror the client's exact TLS parameters
    if (this.tlsFingerprint === 'passthrough' && clientHelloTls) {
      return ProxyServer._sanitizeUpstreamTlsOptions({
        ...base,
        minVersion: clientHelloTls.minVersion,
        maxVersion: clientHelloTls.maxVersion,
        ciphers: clientHelloTls.ciphers,
        sigalgs: clientHelloTls.sigalgs,
        ecdhCurve: clientHelloTls.ecdhCurve,
        requestOCSP: true,
      });
    }

    const preset = ProxyServer.TLS_FINGERPRINTS[this.tlsFingerprint];
    if (!preset) {
      return base; // 'default' — Node.js built-in TLS
    }
    return ProxyServer._sanitizeUpstreamTlsOptions({
      ...base,
      minVersion: preset.minVersion,
      maxVersion: preset.maxVersion,
      ciphers: preset.ciphers,
      sigalgs: preset.sigalgs,
      ecdhCurve: preset.ecdhCurve,
      requestOCSP: true,
    });
  }

  // Build a proxy URL from the upstream proxy config
  _getUpstreamProxyUrl() {
    const p = this.upstreamProxy;
    const scheme = p.type?.startsWith('socks') ? p.type : (p.type === 'https' ? 'https' : 'http');
    let auth = '';
    if (p.auth) {
      const colonIdx = p.auth.indexOf(':');
      const user = colonIdx === -1 ? p.auth : p.auth.slice(0, colonIdx);
      const pass = colonIdx === -1 ? '' : p.auth.slice(colonIdx + 1);
      auth = `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`;
    }
    return `${scheme}://${auth}${p.host}:${p.port}`;
  }

  // Return an https-proxy-agent or socks-proxy-agent that handles CONNECT tunneling + TLS automatically.
  // Matches HTTP Toolkit's approach: the agent opens the CONNECT tunnel and TLS-wraps the socket.
  _getUpstreamAgent() {
    const proxyUrl = this._getUpstreamProxyUrl();
    const agentKey = `${this._upstreamProxyGeneration}:${proxyUrl}`;
    if (this._upstreamAgent && this._upstreamAgentKey === agentKey) {
      return this._upstreamAgent;
    }

    this._destroyUpstreamAgent();
    const agentOptions = {
      keepAlive: true,
      maxSockets: 64,
      maxFreeSockets: 16,
      scheduling: 'lifo'
    };
    if (this.upstreamProxy.type?.startsWith('socks')) {
      this._upstreamAgent = new SocksProxyAgent(proxyUrl, {
        ...agentOptions,
        timeout: this._upstreamConnectTimeoutMs
      });
    } else {
      const proxyTlsOptions = this._getUpstreamTlsOptions(this.upstreamProxy.host);
      this._upstreamAgent = new HttpsProxyAgent(proxyUrl, {
        ...agentOptions,
        ...proxyTlsOptions
      });
    }
    this._upstreamAgentKey = agentKey;
    return this._upstreamAgent;
  }

  // Whether the configured upstream proxy is a SOCKS proxy
  _isSocksProxy() {
    return this.upstreamProxy?.type?.startsWith('socks') || false;
  }

  // Create a raw TCP socket through a SOCKS proxy (used for plain HTTP only)
  async _connectViaSocks(hostname, targetPort) {
    const proxy = this.upstreamProxy;
    const socksOptions = {
      proxy: {
        host: proxy.host,
        port: proxy.port,
        type: (proxy.type === 'socks4' || proxy.type === 'socks4a') ? 4 : 5,
      },
      command: 'connect',
      destination: {
        host: hostname,
        port: targetPort,
      },
      timeout: this._upstreamConnectTimeoutMs,
    };
    if (proxy.auth) {
      const [userId, password] = proxy.auth.split(':');
      socksOptions.proxy.userId = userId;
      socksOptions.proxy.password = password || '';
    }
    const { socket } = await SocksClient.createConnection(socksOptions);
    return socket;
  }

  _connectTcp(hostname, targetPort) {
    if (!this.upstreamProxy) {
      return new Promise((resolve, reject) => {
        const socket = net.connect(targetPort, hostname);
        socket.once('connect', () => resolve(socket));
        socket.once('error', reject);
      });
    }
    if (this._isSocksProxy()) {
      return this._connectViaSocks(hostname, targetPort);
    }

    return new Promise((resolve, reject) => {
      const urlHostname = net.isIP(hostname) === 6 ? `[${hostname}]` : hostname;
      const authority = `${urlHostname}:${targetPort}`;
      const headers = { host: authority };
      if (this.upstreamProxy.auth) {
        headers['proxy-authorization'] = 'Basic ' + Buffer.from(this.upstreamProxy.auth).toString('base64');
      }
      const requestLib = this.upstreamProxy.type === 'https' ? https : http;
      const options = {
        hostname: this.upstreamProxy.host,
        port: this.upstreamProxy.port,
        method: 'CONNECT',
        path: authority,
        headers
      };
      if (requestLib === https) {
        Object.assign(options, this._getUpstreamTlsOptions(this.upstreamProxy.host));
      }
      const request = requestLib.request(options);
      this._configureUpstreamRequest(request);
      request.once('connect', (response, socket, proxyHead) => {
        if (response.statusCode !== 200) {
          socket.destroy();
          reject(new Error(`Upstream proxy CONNECT returned HTTP ${response.statusCode}`));
          return;
        }
        if (proxyHead.length > 0) socket.unshift(proxyHead);
        resolve(socket);
      });
      request.once('error', reject);
      request.end();
    });
  }

  _flattenMockRules(rules) {
    const flat = [];
    for (const item of rules) {
      if (item.type === 'group') {
        if (item.enabled !== false) {
          flat.push(...this._flattenMockRules(item.items || []));
        }
      } else {
        flat.push(item);
      }
    }
    return flat;
  }

  _findMockRule(method, url, headers, body) {
    const flatRules = this._flattenMockRules(this.mockRules);
    // Sort: high-priority first, then by original order
    const sorted = [...flatRules].sort((a, b) => {
      if (a.priority === 'high' && b.priority !== 'high') return -1;
      if (b.priority === 'high' && a.priority !== 'high') return 1;
      return 0;
    });

    const matchedRule = sorted.find(rule => {
      if (!rule.enabled) return false;

      // New format: matchers + action
      if (rule.matchers && rule.action) {
        return rule.matchers.every(m => this._evaluateMatcher(m, method, url, headers, body));
      }

      // Legacy format: method + urlPattern + response
      if (rule.method && rule.method !== '*' && rule.method.toUpperCase() !== method.toUpperCase()) return false;
      if (rule.urlPattern) {
        if (rule.urlPattern instanceof RegExp) {
          return rule.urlPattern.test(url);
        }
        return url.includes(rule.urlPattern);
      }
      return false;
    });

    // A matching passthrough rule stops evaluation while allowing normal forwarding.
    return matchedRule?.action?.type === 'passthrough' ? undefined : matchedRule;
  }

  _evaluateMatcher(matcher, method, url, headers, body) {
    switch (matcher.type) {
      case 'wildcard':
        return true;
      case 'method':
        return matcher.value === '*' || matcher.value.toUpperCase() === method.toUpperCase();
      case 'path': {
        let urlPath;
        try { urlPath = new URL(url).pathname; } catch { urlPath = url; }
        if (matcher.matchType === 'regex') {
          try { return new RegExp(matcher.value).test(urlPath); } catch { return false; }
        }
        if (matcher.matchType === 'exact') return urlPath === matcher.value;
        return urlPath.startsWith(matcher.value); // prefix (default)
      }
      case 'host': {
        let urlHost;
        try { urlHost = new URL(url).host; } catch { urlHost = ''; }
        if (matcher.value.startsWith('*')) {
          return urlHost.endsWith(matcher.value.slice(1));
        }
        return urlHost === matcher.value;
      }
      case 'hostname': {
        let urlHostname;
        try { urlHostname = new URL(url).hostname; } catch { urlHostname = ''; }
        if (matcher.value.startsWith('*')) {
          return urlHostname.endsWith(matcher.value.slice(1));
        }
        return urlHostname === matcher.value;
      }
      case 'url-contains':
        return url.includes(matcher.value);
      case 'header': {
        if (!matcher.name) return false;
        const headerVal = headers[matcher.name.toLowerCase()];
        if (headerVal === undefined) return false;
        if (!matcher.value) return true; // just check presence
        if (matcher.value.includes('*')) {
          try {
            const regex = new RegExp('^' + matcher.value.replace(/\*/g, '.*') + '$');
            return regex.test(headerVal);
          } catch { return false; }
        }
        return headerVal === matcher.value;
      }
      case 'query': {
        try {
          const params = new URL(url).searchParams;
          if (!matcher.name) return false;
          if (!params.has(matcher.name)) return false;
          if (matcher.value) return params.get(matcher.name) === matcher.value;
          return true;
        } catch { return false; }
      }
      case 'body-contains':
        return body && typeof body === 'string' ? body.includes(matcher.value) : (body && body.toString().includes(matcher.value));
      case 'regex-path': {
        let urlPath;
        try { urlPath = new URL(url).pathname; } catch { urlPath = url; }
        try { return new RegExp(matcher.value).test(urlPath); } catch { return false; }
      }
      case 'exact-query': {
        try { return new URL(url).search === matcher.value || new URL(url).search === '?' + matcher.value; } catch { return false; }
      }
      case 'json-body-exact': {
        try {
          const actual = JSON.parse(body);
          const expected = JSON.parse(matcher.value);
          return JSON.stringify(actual) === JSON.stringify(expected);
        } catch { return false; }
      }
      case 'json-body-includes': {
        try {
          const actual = JSON.parse(body);
          const expected = JSON.parse(matcher.value);
          // Check that all keys in expected exist in actual with matching values
          return Object.keys(expected).every(k => JSON.stringify(actual[k]) === JSON.stringify(expected[k]));
        } catch { return false; }
      }
      case 'port': {
        try { return String(new URL(url).port || (url.startsWith('https') ? '443' : '80')) === String(matcher.value); } catch { return false; }
      }
      case 'protocol': {
        try { return new URL(url).protocol.replace(':', '') === matcher.value.toLowerCase(); } catch { return false; }
      }
      case 'cookie': {
        const cookieHeader = headers['cookie'] || '';
        const cookies = Object.fromEntries(cookieHeader.split(';').map(c => c.trim().split('=').map(p => p.trim())));
        if (!matcher.name) return false;
        if (matcher.value) return cookies[matcher.name] === matcher.value;
        return matcher.name in cookies;
      }
      case 'form-data': {
        // Match URL-encoded form field
        if (!body || !matcher.name) return false;
        try {
          const params = new URLSearchParams(body);
          if (matcher.value) return params.get(matcher.name) === matcher.value;
          return params.has(matcher.name);
        } catch { return false; }
      }
      case 'multipart-form-data': {
        // Match multipart/form-data field by name and optional value
        if (!body || !matcher.name) return false;
        const ct = headers['content-type'] || '';
        const boundaryMatch = ct.match(/boundary=([^\s;]+)/);
        if (!boundaryMatch) return false;
        const boundary = boundaryMatch[1];
        const parts = body.split('--' + boundary);
        for (const part of parts) {
          const dispMatch = part.match(/Content-Disposition:\s*form-data;\s*name="([^"]+)"/i);
          if (!dispMatch || dispMatch[1] !== matcher.name) continue;
          if (!matcher.value) return true; // field exists
          const bodyStart = part.indexOf('\r\n\r\n');
          if (bodyStart === -1) continue;
          const fieldValue = part.slice(bodyStart + 4).replace(/\r\n$/, '');
          if (fieldValue === matcher.value) return true;
        }
        return false;
      }
      case 'regex-url': {
        try { return new RegExp(matcher.value).test(url); } catch { return false; }
      }
      case 'regex-body': {
        if (!body) return false;
        try { return new RegExp(matcher.value).test(body); } catch { return false; }
      }
      case 'raw-body-exact': {
        return body === matcher.value;
      }
      default:
        return false;
    }
  }

  async _serveMockResponse(requestId, clientReq, clientRes, targetUrl, body, mockRule, startTime, capture = {}) {
    const captureProtocol = capture.protocol || 'http';
    const captureTls = capture.tls || null;
    // Determine action — support both new format (action) and legacy format (response)
    const action = mockRule.action || {
      type: 'fixed-response',
      status: mockRule.response?.status || 200,
      headers: mockRule.response?.headers || { 'Content-Type': 'application/json' },
      body: mockRule.response?.body || '',
      delay: 0
    };

    // Capture original request data before pre-steps modify it
    const origMethod = clientReq.method;
    const origUrl = targetUrl.href;
    const origHeaders = { ...clientReq.headers };

    // Execute pre-steps (step chaining) before the terminal action
    const preSteps = mockRule.preSteps || [];
    for (const step of preSteps) {
      switch (step.type) {
        case 'delay':
          if (step.ms > 0) {
            await new Promise(r => setTimeout(r, step.ms));
          }
          break;
        case 'add-header':
          if (step.name) {
            clientReq.headers[step.name.toLowerCase()] = step.value || '';
          }
          break;
        case 'remove-header':
          if (step.name) {
            delete clientReq.headers[step.name.toLowerCase()];
          }
          break;
        case 'rewrite-url':
          if (step.value) {
            try { targetUrl = new URL(step.value); } catch { /* keep original */ }
          }
          break;
        case 'rewrite-method':
          if (step.value) {
            clientReq.method = step.value;
          }
          break;
      }
    }

    // Detect if pre-steps transformed the request
    const transformed = origMethod !== clientReq.method ||
      origUrl !== targetUrl.href ||
      JSON.stringify(origHeaders) !== JSON.stringify(clientReq.headers);
    const originalRequest = transformed ? {
      method: origMethod, url: origUrl, headers: origHeaders,
      body: this._safeBodyString(body)
    } : null;
    const transformedBy = originalRequest ? (mockRule.title || mockRule.id || 'Mock Rule') : null;

    // Close connection action
    if (action.type === 'close') {
      clientRes.destroy();
      this._emitRequest({
        id: requestId, protocol: captureProtocol, method: clientReq.method, url: targetUrl.href,
        host: targetUrl.hostname, path: targetUrl.pathname + targetUrl.search,
        requestHeaders: clientReq.headers, requestBody: this._safeBodyString(body),
        requestBodySize: body.length, statusCode: 0, statusMessage: 'Connection Closed',
        responseHeaders: {}, responseBody: '', responseBodySize: 0,
        duration: Date.now() - startTime, timestamp: startTime, source: 'mock',
        tls: captureTls, remote: null,
        originalRequest, transformedBy
      });
      return;
    }

    // Reset connection (RST)
    if (action.type === 'reset') {
      clientRes.socket?.destroy();
      this._emitRequest({
        id: requestId, protocol: captureProtocol, method: clientReq.method, url: targetUrl.href,
        host: targetUrl.hostname, path: targetUrl.pathname + targetUrl.search,
        requestHeaders: clientReq.headers, requestBody: this._safeBodyString(body),
        requestBodySize: body.length, statusCode: 0, statusMessage: 'Connection Reset',
        responseHeaders: {}, responseBody: '', responseBodySize: 0,
        duration: Date.now() - startTime, timestamp: startTime, source: 'mock',
        tls: captureTls, remote: null,
        originalRequest, transformedBy
      });
      return;
    }

    // Apply delay
    if (action.delay && action.delay > 0) {
      await new Promise(r => setTimeout(r, action.delay));
    }

    // Forward action — proxy to a different host
    if (action.type === 'forward' && action.forwardTo) {
      try {
        const forwardUrl = new URL(action.forwardTo);
        const isHttps = forwardUrl.protocol === 'https:';
        const lib = isHttps ? https : http;
        const reqHeaders = this._currentHeadersWithRawCase(clientReq.rawHeaders, clientReq.headers);
        if (action.addRequestHeaders) {
          for (const [k, v] of Object.entries(action.addRequestHeaders)) {
            reqHeaders[k] = v;
          }
        }
        const hostKey = Object.keys(reqHeaders).find(k => k.toLowerCase() === 'host') || 'Host';
        reqHeaders[hostKey] = forwardUrl.host;

        const proxyReq = lib.request({
          hostname: forwardUrl.hostname,
          port: forwardUrl.port || (isHttps ? 443 : 80),
          path: targetUrl.pathname + targetUrl.search,
          method: clientReq.method,
          headers: reqHeaders,
          ...(isHttps ? this._getUpstreamTlsOptions(forwardUrl.hostname) : {})
        }, (proxyRes) => {
          const responseBody = this._createBodyCollector();
          proxyRes.on('data', chunk => {
            if (!this._appendBodyChunk(responseBody, chunk)) {
              proxyReq.destroy(this._bodyLimitError('Mock forward response body'));
            }
          });
          proxyRes.on('end', () => {
            const resBody = this._concatBody(responseBody);
            const resHeaders = { ...proxyRes.headers };
            const trailers = proxyRes.trailers;
            // Apply response header modifications
            if (action.addResponseHeaders) {
              for (const [k, v] of Object.entries(action.addResponseHeaders)) {
                resHeaders[k.toLowerCase()] = v;
              }
            }
            this._sendH1Response(clientRes, proxyRes.statusCode, resHeaders, resBody, trailers);
            this._emitRequest({
              id: requestId, protocol: captureProtocol, method: clientReq.method, url: targetUrl.href,
              host: targetUrl.hostname, path: targetUrl.pathname + targetUrl.search,
              requestHeaders: clientReq.headers, requestBody: this._safeBodyString(body),
              requestBodySize: body.length, statusCode: proxyRes.statusCode,
              statusMessage: proxyRes.statusMessage, responseHeaders: resHeaders,
              responseBody: this._safeBodyString(resBody, proxyRes.headers['content-encoding'], proxyRes.headers['content-type']),
              responseBodySize: resBody.length, duration: Date.now() - startTime,
              timestamp: startTime, source: 'mock',
              tls: captureTls, remote: { address: proxyReq.socket?.remoteAddress, port: proxyReq.socket?.remotePort },
              trailers: Object.keys(trailers || {}).length > 0 ? trailers : null,
              originalRequest, transformedBy
            });
          });
        });
        proxyReq.on('error', (err) => {
          clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
          clientRes.end(`Forward Error: ${err.message}`);
          this._emitRequest({
            id: requestId, protocol: captureProtocol, method: clientReq.method, url: targetUrl.href,
            host: targetUrl.hostname, path: targetUrl.pathname + targetUrl.search,
            requestHeaders: clientReq.headers, requestBody: this._safeBodyString(body),
            requestBodySize: body.length, statusCode: 502, statusMessage: 'Bad Gateway',
            responseHeaders: {}, responseBody: `Forward Error: ${err.message}`,
            responseBodySize: 0, duration: Date.now() - startTime,
            timestamp: startTime, source: 'mock', error: err.message,
            tls: captureTls, remote: null,
            originalRequest, transformedBy
          });
        });
        this._endH1Request(proxyReq, body, clientReq.trailers);
      } catch (err) {
        clientRes.writeHead(500, { 'Content-Type': 'text/plain' });
        clientRes.end(`Forward setup error: ${err.message}`);
      }
      return;
    }

    // Serve content from a file
    if (action.type === 'serve-file') {
      const filePath = action.filePath;
      if (!filePath) {
        clientRes.writeHead(500, { 'Content-Type': 'text/plain' });
        clientRes.end('Mock error: no filePath configured');
        this._emitRequest({
          id: requestId, protocol: captureProtocol, method: clientReq.method, url: targetUrl.href,
          host: targetUrl.hostname, path: targetUrl.pathname + targetUrl.search,
          requestHeaders: clientReq.headers, requestBody: this._safeBodyString(body),
          requestBodySize: body.length, statusCode: 500, statusMessage: 'Mock Error',
          responseHeaders: { 'Content-Type': 'text/plain' },
          responseBody: 'Mock error: no filePath configured', responseBodySize: 0,
          duration: Date.now() - startTime, timestamp: startTime, source: 'mock',
          tls: captureTls, remote: null,
          originalRequest, transformedBy
        });
        return;
      }
      try {
        const content = fs.readFileSync(filePath);
        const mime = action.contentType || 'application/octet-stream';
        const fileStatus = action.status || 200;
        clientRes.writeHead(fileStatus, { 'Content-Type': mime });
        clientRes.end(content);
        this._emitRequest({
          id: requestId, protocol: captureProtocol, method: clientReq.method, url: targetUrl.href,
          host: targetUrl.hostname, path: targetUrl.pathname + targetUrl.search,
          requestHeaders: clientReq.headers, requestBody: this._safeBodyString(body),
          requestBodySize: body.length, statusCode: fileStatus, statusMessage: 'Mocked (file)',
          responseHeaders: { 'Content-Type': mime },
          responseBody: this._safeBodyString(content),
          responseBodySize: content.length,
          duration: Date.now() - startTime, timestamp: startTime, source: 'mock',
          tls: captureTls, remote: null,
          originalRequest, transformedBy
        });
      } catch (err) {
        clientRes.writeHead(500, { 'Content-Type': 'text/plain' });
        clientRes.end('File not found: ' + filePath);
        this._emitRequest({
          id: requestId, protocol: captureProtocol, method: clientReq.method, url: targetUrl.href,
          host: targetUrl.hostname, path: targetUrl.pathname + targetUrl.search,
          requestHeaders: clientReq.headers, requestBody: this._safeBodyString(body),
          requestBodySize: body.length, statusCode: 500, statusMessage: 'File Error',
          responseHeaders: { 'Content-Type': 'text/plain' },
          responseBody: 'File not found: ' + filePath, responseBodySize: 0,
          duration: Date.now() - startTime, timestamp: startTime, source: 'mock',
          error: err.message, tls: captureTls, remote: null,
          originalRequest, transformedBy
        });
      }
      return;
    }

    // Webhook — send a copy of the request to a configured URL (fire-and-forget)
    if (action.type === 'webhook' && action.webhookUrl) {
      try {
        const webhookTarget = new URL(action.webhookUrl);
        const isHttps = webhookTarget.protocol === 'https:';
        const lib = isHttps ? https : http;
        const webhookHeaders = {
          'content-type': clientReq.headers['content-type'] || 'application/octet-stream',
          'x-forwarded-method': clientReq.method,
          'x-forwarded-url': targetUrl.href,
          'x-forwarded-host': targetUrl.hostname,
          ...(action.webhookHeaders || {})
        };
        const webhookReq = lib.request({
          hostname: webhookTarget.hostname,
          port: webhookTarget.port || (isHttps ? 443 : 80),
          path: webhookTarget.pathname + webhookTarget.search,
          method: 'POST',
          headers: webhookHeaders,
          ...(isHttps ? this._getUpstreamTlsOptions(webhookTarget.hostname) : {})
        });
        webhookReq.on('error', (err) => {
          console.error('[Proxy] Webhook error:', err.message);
        });
        webhookReq.end(body);
      } catch (err) {
        console.error('[Proxy] Webhook setup error:', err.message);
      }
      // Respond 200 OK to the client
      clientRes.writeHead(200, { 'Content-Type': 'text/plain' });
      clientRes.end('');
      this._emitRequest({
        id: requestId, protocol: captureProtocol, method: clientReq.method, url: targetUrl.href,
        host: targetUrl.hostname, path: targetUrl.pathname + targetUrl.search,
        requestHeaders: clientReq.headers, requestBody: this._safeBodyString(body),
        requestBodySize: body.length, statusCode: 200, statusMessage: 'Webhook sent',
        responseHeaders: { 'Content-Type': 'text/plain' }, responseBody: '', responseBodySize: 0,
        duration: Date.now() - startTime, timestamp: startTime, source: 'mock',
        tls: captureTls, remote: null,
        originalRequest, transformedBy
      });
      return;
    }

    // Breakpoint on request (pause for manual editing)
    if (action.type === 'breakpoint-request') {
      this._emitRequest({
        id: requestId, protocol: captureProtocol, method: clientReq.method, url: targetUrl.href,
        host: targetUrl.hostname, path: targetUrl.pathname + targetUrl.search,
        requestHeaders: clientReq.headers, requestBody: this._safeBodyString(body),
        requestBodySize: body.length, statusCode: 0, statusMessage: 'Breakpoint',
        responseHeaders: {}, responseBody: '', responseBodySize: 0,
        duration: 0, timestamp: startTime, source: 'breakpoint',
        tls: captureTls, remote: null,
        originalRequest, transformedBy
      });
      try {
        this.onBreakpoint({
          type: 'breakpoint-hit', requestId,
          method: clientReq.method, url: targetUrl.href, host: targetUrl.hostname
        });
      } catch (err) {
        console.error('[Proxy] Error in breakpoint handler:', err.message);
      }
      const modifications = await new Promise((resolve) => {
        this.pendingBreakpoints.set(requestId, {
          method: clientReq.method, url: targetUrl.href, host: targetUrl.hostname,
          path: targetUrl.pathname + targetUrl.search, headers: clientReq.headers,
          body: this._safeBodyString(body), timestamp: Date.now(), resolve
        });
        this._setBreakpointTimeout(requestId);
      });
      // Apply modifications and continue as normal proxy request
      if (modifications.url) {
        try { targetUrl = new URL(modifications.url); } catch { /* keep original */ }
      }
      if (modifications.method) clientReq.method = modifications.method;
      if (modifications.headers) Object.assign(clientReq.headers, modifications.headers);
      if (Object.prototype.hasOwnProperty.call(modifications, 'body')) {
        body = Buffer.from(String(modifications.body || ''));
        this._setContentLength(clientReq.headers, body.length);
      }
      // Fall through to normal proxy behavior (don't return here)
    }

    // Breakpoint on response (forward normally, pause the response)
    if (action.type === 'breakpoint-response') {
      // Mark this request so the response will be paused
      this._emitRequest({
        id: requestId, protocol: captureProtocol, method: clientReq.method, url: targetUrl.href,
        host: targetUrl.hostname, path: targetUrl.pathname + targetUrl.search,
        requestHeaders: clientReq.headers, requestBody: this._safeBodyString(body),
        requestBodySize: body.length, statusCode: 0, statusMessage: 'Breakpoint (response)',
        responseHeaders: {}, responseBody: '', responseBodySize: 0,
        duration: 0, timestamp: startTime, source: 'breakpoint',
        tls: captureTls, remote: null,
        originalRequest, transformedBy
      });
      try {
        this.onBreakpoint({
          type: 'breakpoint-hit', requestId,
          method: clientReq.method, url: targetUrl.href, host: targetUrl.hostname,
          phase: 'response'
        });
      } catch (err) {
        console.error('[Proxy] Error in breakpoint handler:', err.message);
      }
      const modifications = await new Promise((resolve) => {
        this.pendingBreakpoints.set(requestId, {
          method: clientReq.method, url: targetUrl.href, host: targetUrl.hostname,
          path: targetUrl.pathname + targetUrl.search, headers: clientReq.headers,
          body: this._safeBodyString(body), timestamp: Date.now(), phase: 'response', resolve
        });
        this._setBreakpointTimeout(requestId);
      });
      // Apply modifications to the response
      if (modifications.status) {
        clientRes.writeHead(modifications.status, modifications.headers || {});
        clientRes.end(modifications.body || '');
      } else {
        clientRes.writeHead(200, { 'Content-Type': 'text/plain' });
        clientRes.end('Breakpoint released');
      }
      return;
    }

    // Breakpoint on both request and response
    if (action.type === 'breakpoint-request-response') {
      // Phase 1: Pause on the request
      this._emitRequest({
        id: requestId, protocol: captureProtocol, method: clientReq.method, url: targetUrl.href,
        host: targetUrl.hostname, path: targetUrl.pathname + targetUrl.search,
        requestHeaders: clientReq.headers, requestBody: this._safeBodyString(body),
        requestBodySize: body.length, statusCode: 0, statusMessage: 'Breakpoint (request)',
        responseHeaders: {}, responseBody: '', responseBodySize: 0,
        duration: 0, timestamp: startTime, source: 'breakpoint',
        tls: captureTls, remote: null,
        originalRequest, transformedBy
      });
      try {
        this.onBreakpoint({
          type: 'breakpoint-hit', requestId,
          method: clientReq.method, url: targetUrl.href, host: targetUrl.hostname,
          phase: 'request'
        });
      } catch (err) {
        console.error('[Proxy] Error in breakpoint handler:', err.message);
      }
      const reqModifications = await new Promise((resolve) => {
        this.pendingBreakpoints.set(requestId, {
          method: clientReq.method, url: targetUrl.href, host: targetUrl.hostname,
          path: targetUrl.pathname + targetUrl.search, headers: clientReq.headers,
          body: this._safeBodyString(body), timestamp: Date.now(), phase: 'request', resolve
        });
        this._setBreakpointTimeout(requestId);
      });
      // Apply request modifications
      if (reqModifications.url) {
        try { targetUrl = new URL(reqModifications.url); } catch { /* keep original */ }
      }
      if (reqModifications.method) clientReq.method = reqModifications.method;
      if (reqModifications.headers) Object.assign(clientReq.headers, reqModifications.headers);
      if (Object.prototype.hasOwnProperty.call(reqModifications, 'body')) {
        body = Buffer.from(String(reqModifications.body || ''));
        this._setContentLength(clientReq.headers, body.length);
      }

      // Phase 2: Pause on the response
      this._emitRequest({
        id: requestId, protocol: captureProtocol, method: clientReq.method, url: targetUrl.href,
        host: targetUrl.hostname, path: targetUrl.pathname + targetUrl.search,
        requestHeaders: clientReq.headers, requestBody: this._safeBodyString(body),
        requestBodySize: body.length, statusCode: 0, statusMessage: 'Breakpoint (response)',
        responseHeaders: {}, responseBody: '', responseBodySize: 0,
        duration: 0, timestamp: startTime, source: 'breakpoint',
        tls: captureTls, remote: null,
        originalRequest, transformedBy
      });
      try {
        this.onBreakpoint({
          type: 'breakpoint-hit', requestId,
          method: clientReq.method, url: targetUrl.href, host: targetUrl.hostname,
          phase: 'response'
        });
      } catch (err) {
        console.error('[Proxy] Error in breakpoint handler:', err.message);
      }
      const resModifications = await new Promise((resolve) => {
        this.pendingBreakpoints.set(requestId, {
          method: clientReq.method, url: targetUrl.href, host: targetUrl.hostname,
          path: targetUrl.pathname + targetUrl.search, headers: clientReq.headers,
          body: this._safeBodyString(body), timestamp: Date.now(), phase: 'response', resolve
        });
        this._setBreakpointTimeout(requestId);
      });
      // Apply response modifications
      if (resModifications.status) {
        clientRes.writeHead(resModifications.status, resModifications.headers || {});
        clientRes.end(resModifications.body || '');
      } else {
        clientRes.writeHead(200, { 'Content-Type': 'text/plain' });
        clientRes.end('Breakpoint released');
      }
      return;
    }

    // Fixed response (default)
    const resHeaders = action.headers || { 'Content-Type': 'application/json' };
    const resBody = action.body || '';
    const statusCode = action.status || 200;

    // Apply response header modifications if present
    if (action.addResponseHeaders) {
      for (const [k, v] of Object.entries(action.addResponseHeaders)) {
        resHeaders[k.toLowerCase()] = v;
      }
    }

    clientRes.writeHead(statusCode, resHeaders);
    clientRes.end(resBody);

    this._emitRequest({
      id: requestId,
      protocol: captureProtocol,
      method: clientReq.method,
      url: targetUrl.href,
      host: targetUrl.hostname,
      path: targetUrl.pathname + targetUrl.search,
      requestHeaders: clientReq.headers,
      requestBody: this._safeBodyString(body),
      requestBodySize: body.length,
      statusCode,
      statusMessage: 'Mocked',
      responseHeaders: resHeaders,
      responseBody: resBody,
      responseBodySize: Buffer.byteLength(resBody),
      duration: Date.now() - startTime,
      timestamp: startTime,
      source: 'mock',
      tls: captureTls,
      remote: null,
      originalRequest,
      transformedBy
    });
  }

  _emitRequest(data) {
    // Auto-detect source from User-Agent if source is 'proxy' (generic)
    if (data.source === 'proxy' && data.requestHeaders) {
      data.source = this._detectSource(data.requestHeaders);
    }
    if (this._shouldSuppressTrafficLog(data)) return;
    try {
      this.onRequest(data);
    } catch (err) {
      console.error('[Proxy] Error in request handler:', err.message);
    }
  }

  // Emit a pending request that appears in the UI immediately (before response arrives)
  _emitPendingRequest(data) {
    data._pending = true;
    data.statusCode = null;
    data.statusMessage = 'Pending';
    data.responseHeaders = {};
    data.responseBody = '';
    data.responseBodySize = 0;
    data.duration = null;
    this._emitRequest(data);
  }

  // Emit an update that replaces an existing pending request
  _emitRequestUpdate(data) {
    data._update = true;
    // Auto-detect source
    if (data.source === 'proxy' && data.requestHeaders) {
      data.source = this._detectSource(data.requestHeaders);
    }
    if (this._shouldSuppressTrafficLog(data)) return;
    try {
      this.onRequest(data);
    } catch (err) {
      console.error('[Proxy] Error in request update handler:', err.message);
    }
  }

  _shouldSuppressTrafficLog(data) {
    if (data.source !== 'Chrome' && data.source !== 'Edge' && data.source !== 'Brave') return false;
    if (data.protocol === 'ws-frame') return false;

    const host = String(data.host || '').toLowerCase();
    const path = String(data.path || '').toLowerCase();
    const url = String(data.url || '').toLowerCase();
    const target = host || (() => {
      try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
    })();

    if (!target) return false;

    if (this.filterSafeFonts && (target === 'fonts.gstatic.com' || target === 'fonts.googleapis.com')) return true;

    const exactHosts = new Set([
      'update.googleapis.com',
      'optimizationguide-pa.googleapis.com',
      'safebrowsing.googleapis.com',
      'safebrowsing.google.com',
      'clients1.google.com',
      'clients2.google.com',
      'clients3.google.com',
      'clients4.google.com',
      'clients5.google.com',
      'clients6.google.com',
      'content-autofill.googleapis.com',
      'google-ohttp-relay-safebrowsing.fastly-edge.com',
      'redirector.gvt1.com'
    ]);

    if (exactHosts.has(target)) return true;
    if (target.endsWith('.gvt1.com') || target.endsWith('.gvt2.com')) return true;
    if (target.endsWith('.googleapis.com') && (
      target.includes('update') ||
      target.includes('safebrowsing') ||
      target.includes('optimizationguide')
    )) return true;

    if (target === 'bam.nr-data.net' && path.startsWith('/jserrors')) return true;

    if (target === 'android.clients.google.com' && (
      path.startsWith('/c2dm/register3') ||
      path.startsWith('/checkin')
    )) return true;

    if (target === 'clients2.googleusercontent.com' && path.startsWith('/crx/blobs')) return true;
    if (target === 'accounts.google.com' && path.startsWith('/listaccounts')) return true;
    if (target === 'clientservices.googleapis.com' && (
      path.startsWith('/chrome-variations/seed') ||
      path.startsWith('/uma/v2')
    )) return true;
    if (target === 'www.googleapis.com' && path.startsWith('/chromewebstore/v1.1/items/verify')) return true;
    if (target === 'chromewebstore.googleapis.com' &&
      path.startsWith('/v2/items/-/storemetadata:batchget')
    ) return true;
    if (target === 'www.gstatic.com' && (
      path.startsWith('/og/_/js') ||
      path.startsWith('/images/branding/googlelogo') ||
      path === '/images/branding/searchlogo/ico/favicon.ico' ||
      path.startsWith('/images/branding/searchlogo/ico/favicon.ico?')
    )) return true;
    if (target === 'play.google.com' && (path === '/log' || path.startsWith('/log?'))) return true;
    if (target === 'ogads-pa.clients6.google.com' &&
      path.startsWith('/$rpc/google.internal.onegoogle.asyncdata.v1.asyncdataservice/getasyncdata')
    ) return true;

    if (target === 'www.google.com' && (
      path.startsWith('/async/folae') ||
      path.startsWith('/async/ddljson') ||
      path.startsWith('/async/newtab_ogb') ||
      path.startsWith('/xjs/_/js') ||
      path === '/complete/s' ||
      path.startsWith('/complete/s?') ||
      path.startsWith('/complete/search') ||
      path.startsWith('/gen_204') ||
      path.startsWith('/chrome/')
    )) return true;

    if ((target === 'google.com' || target === 'www.google.com' ||
        target === 'google.co.uk' || target === 'www.google.co.uk') &&
      path.startsWith('/domainreliability/upload')
    ) return true;

    return false;
  }

  _detectSource(headers) {
    const ua = (headers['user-agent'] || '').toLowerCase();
    if (ua.includes('firefox')) return 'Firefox';
    if (ua.includes('edg/') || ua.includes('edga/') || ua.includes('edgios/')) return 'Edge';
    if (ua.includes('brave')) return 'Brave';
    if (ua.includes('opr/') || ua.includes('opera')) return 'Opera';
    if (ua.includes('chrome') || ua.includes('chromium')) return 'Chrome';
    if (ua.includes('safari') && !ua.includes('chrome')) return 'Safari';
    if (ua.includes('curl')) return 'cURL';
    if (ua.includes('wget')) return 'wget';
    if (ua.includes('python')) return 'Python';
    if (ua.includes('node') || ua.includes('axios')) return 'Node.js';
    if (ua.includes('go-http') || ua.includes('golang')) return 'Go';
    if (ua.includes('java/') || ua.includes('okhttp')) return 'Java';
    if (ua.includes('powershell')) return 'PowerShell';
    if (!ua) return 'Unknown';
    return 'Other';
  }

  _decompressBody(buffer, encoding) {
    if (!buffer || buffer.length === 0) return buffer;
    const options = { maxOutputLength: this.maxDecompressedBodyBytes };
    try {
      switch (encoding) {
        case 'gzip':
        case 'x-gzip':
          return zlib.gunzipSync(buffer, options);
        case 'deflate':
          return zlib.inflateSync(buffer, options);
        case 'br':
          return zlib.brotliDecompressSync(buffer, options);
        case 'zstd':
          if (zlib.zstdDecompressSync) return zlib.zstdDecompressSync(buffer, options);
          return buffer;
        default:
          return buffer;
      }
    } catch {
      return buffer; // If decompression fails, return raw
    }
  }

  _safeBodyString(buffer, contentEncoding, contentType) {
    if (!buffer || buffer.length === 0) return '';

    // Decompress if needed
    let decoded = this._decompressBody(buffer, contentEncoding);

    // For images, encode as base64 data URI so the UI can display them
    const ct = (contentType || '').toLowerCase();
    const isProtobufLike = ct.includes('application/grpc') ||
      ct.includes('application/connect+proto') ||
      ct.includes('protobuf') ||
      ct.includes('x-protobuf') ||
      ct.includes('x-protobuffer');
    if (isProtobufLike && decoded.length < 2 * 1024 * 1024) {
      const mimeType = ct.split(';')[0].trim() || 'application/x-protobuf';
      return `data:${mimeType};base64,${decoded.toString('base64')}`;
    }

    if (ct.startsWith('image/') && decoded.length < 2 * 1024 * 1024) { // up to 2MB images
      const mimeType = ct.split(';')[0].trim();
      return `data:${mimeType};base64,${decoded.toString('base64')}`;
    }

    // Check if it looks like text
    const sample = decoded.slice(0, 512);
    let isText = true;
    for (let i = 0; i < sample.length; i++) {
      const byte = sample[i];
      if (byte < 9 || (byte > 13 && byte < 32 && byte !== 27)) {
        isText = false;
        break;
      }
    }

    if (isText) {
      const maxSize = 512 * 1024;
      if (decoded.length > maxSize) decoded = decoded.slice(0, maxSize);
      return decoded.toString('utf8');
    }

    if (decoded.length < 2 * 1024 * 1024) {
      const mimeType = ct.split(';')[0].trim() || 'application/octet-stream';
      return `data:${mimeType};base64,${decoded.toString('base64')}`;
    }

    return `[Binary data: ${buffer.length} bytes]`;
  }

  // ---- Breakpoint methods ----

  addBreakpoint(rule) {
    rule.id = rule.id || uuidv4();
    rule.enabled = rule.enabled !== false;
    this.breakpointRules.push(rule);
    return rule;
  }

  removeBreakpoint(id) {
    this.breakpointRules = this.breakpointRules.filter(r => r.id !== id);
  }

  updateBreakpoint(id, patch = {}) {
    const rule = this.breakpointRules.find(r => r.id === id);
    if (!rule) return null;
    Object.assign(rule, patch);
    return rule;
  }

  getBreakpoints() {
    return this.breakpointRules;
  }

  getPendingBreakpoints() {
    const pending = [];
    for (const [id, bp] of this.pendingBreakpoints) {
      pending.push({
        id,
        method: bp.method,
        url: bp.url,
        host: bp.host,
        phase: bp.phase || 'request',
        timestamp: bp.timestamp
      });
    }
    return pending;
  }

  _getMockBreakpointPhase(mockRule) {
    const type = mockRule?.action?.type;
    if (type === 'breakpoint-request') return 'request';
    if (type === 'breakpoint-response') return 'response';
    return null;
  }

  async _pauseResponseBreakpoint(context) {
    const {
      requestId, protocol, method, url, host, path, requestHeaders, requestBody,
      statusCode, statusMessage, responseHeaders, responseBody, trailers,
      startTime, tlsDetails, remote
    } = context;
    const displayBody = this._safeBodyString(
      responseBody,
      responseHeaders?.['content-encoding'],
      responseHeaders?.['content-type']
    );
    this._emitRequestUpdate({
      id: requestId,
      protocol,
      method,
      url,
      host,
      path,
      requestHeaders,
      requestBody: this._safeBodyString(requestBody),
      requestBodySize: requestBody.length,
      statusCode: 0,
      statusMessage: 'Breakpoint (response)',
      responseHeaders,
      responseBody: displayBody,
      responseBodySize: responseBody.length,
      upstreamStatusCode: statusCode,
      upstreamStatusMessage: statusMessage,
      breakpointPhase: 'response',
      duration: Date.now() - startTime,
      timestamp: startTime,
      source: 'breakpoint',
      tls: tlsDetails || null,
      remote,
      trailers: Object.keys(trailers || {}).length > 0 ? trailers : null
    });
    try {
      this.onBreakpoint({ type: 'breakpoint-hit', requestId, method, url, host, phase: 'response' });
    } catch (err) {
      console.error('[Proxy] Error in breakpoint handler:', err.message);
    }
    const modifications = await new Promise((resolve) => {
      this.pendingBreakpoints.set(requestId, {
        method,
        url,
        host,
        path,
        headers: responseHeaders,
        body: displayBody,
        status: statusCode,
        phase: 'response',
        timestamp: Date.now(),
        resolve
      });
      this._setBreakpointTimeout(requestId);
    });
    const requestedStatus = Number(modifications.status ?? modifications.statusCode);
    const bodyModified = Object.prototype.hasOwnProperty.call(modifications, 'body');
    const finalBody = bodyModified
      ? Buffer.from(String(modifications.body ?? ''))
      : responseBody;
    const finalHeaders = modifications.headers && typeof modifications.headers === 'object'
      ? { ...modifications.headers }
      : { ...responseHeaders };
    if (bodyModified) {
      for (const name of Object.keys(finalHeaders)) {
        if (name.toLowerCase() === 'transfer-encoding') delete finalHeaders[name];
      }
      this._setContentLength(finalHeaders, finalBody.length);
    }
    return {
      statusCode: Number.isInteger(requestedStatus) && requestedStatus >= 100 && requestedStatus <= 599
        ? requestedStatus
        : statusCode,
      statusMessage,
      headers: finalHeaders,
      body: finalBody,
      trailers
    };
  }

  resumeBreakpoint(requestId, modifications = {}) {
    const bp = this.pendingBreakpoints.get(requestId);
    if (!bp) return false;
    bp.resolve(modifications);
    this.pendingBreakpoints.delete(requestId);
    try {
      this.onBreakpoint({ type: 'breakpoint-resumed', requestId });
    } catch (err) {
      console.error('[Proxy] Error in breakpoint handler:', err.message);
    }
    return true;
  }

  _setBreakpointTimeout(requestId) {
    const timeout = setTimeout(() => {
      if (this.pendingBreakpoints.has(requestId)) {
        this.pendingBreakpoints.get(requestId).resolve({});
        this.pendingBreakpoints.delete(requestId);
      }
    }, 5 * 60 * 1000); // 5 min timeout
    // Wrap the resolve so we clear the timer when manually resumed
    const bp = this.pendingBreakpoints.get(requestId);
    const origResolve = bp.resolve;
    bp.resolve = (val) => { clearTimeout(timeout); origResolve(val); };
  }

  _checkBreakpoint(method, url, headers) {
    return this.breakpointRules.find(rule => {
      if (!rule.enabled) return false;
      return (rule.matchers || []).every(m => this._evaluateMatcher(m, method, url, headers, ''));
    });
  }

  addMockRule(rule) {
    // Ensure rule has an id and enabled flag
    if (!rule.id) rule.id = uuidv4();
    if (rule.enabled === undefined) rule.enabled = true;
    if (!rule.priority) rule.priority = 'normal';
    // Insert before any wildcard/passthrough rules so new rules take priority
    const passthroughIdx = this.mockRules.findIndex(r =>
      r.action?.type === 'passthrough' && r.matchers?.some(m => m.type === 'method' && m.value === '*')
    );
    if (passthroughIdx !== -1) {
      this.mockRules.splice(passthroughIdx, 0, rule);
    } else {
      this.mockRules.push(rule);
    }
    return rule;
  }

  removeMockRule(index) {
    this.mockRules.splice(index, 1);
  }

  removeMockRuleById(id) {
    const idx = this.mockRules.findIndex(r => r.id === id);
    if (idx !== -1) {
      this.mockRules.splice(idx, 1);
      return true;
    }
    // Search inside groups
    for (const item of this.mockRules) {
      if (item.type === 'group' && item.items) {
        const gIdx = item.items.findIndex(r => r.id === id);
        if (gIdx !== -1) {
          item.items.splice(gIdx, 1);
          return true;
        }
      }
    }
    return false;
  }

  _findMockRuleById(id) {
    const top = this.mockRules.find(r => r.id === id);
    if (top) return top;
    for (const item of this.mockRules) {
      if (item.type === 'group' && item.items) {
        const nested = item.items.find(r => r.id === id);
        if (nested) return nested;
      }
    }
    return null;
  }

  updateMockRule(id, updates) {
    const rule = this._findMockRuleById(id);
    if (!rule) return null;
    Object.assign(rule, updates);
    return rule;
  }

  toggleMockRule(id) {
    const rule = this._findMockRuleById(id);
    if (!rule) return null;
    rule.enabled = !rule.enabled;
    return rule;
  }

  reorderMockRules(orderedIds) {
    const ruleMap = new Map(this.mockRules.map(r => [r.id, r]));
    const reordered = [];
    for (const id of orderedIds) {
      const rule = ruleMap.get(id);
      if (rule) {
        reordered.push(rule);
        ruleMap.delete(id);
      }
    }
    // Append any rules not in the ordered list (shouldn't happen but be safe)
    for (const rule of ruleMap.values()) {
      reordered.push(rule);
    }
    this.mockRules = reordered;
    return this.mockRules;
  }

  clearMockRules() {
    this.mockRules = [];
  }

  addApiSpec(spec) {
    spec.id = spec.id || uuidv4();
    this.apiSpecs.push(spec);
    return spec;
  }

  removeApiSpec(id) {
    this.apiSpecs = this.apiSpecs.filter(s => s.id !== id);
  }

  getApiSpecs() {
    return this.apiSpecs.map(s => ({ id: s.id, title: s.title, baseUrl: s.baseUrl }));
  }

  matchApiSpec(method, path, host) {
    for (const spec of this.apiSpecs) {
      if (spec.baseUrl && !host.includes(spec.baseUrl.replace(/^https?:\/\//, '').split('/')[0])) continue;

      const paths = spec.spec?.paths || {};
      for (const [pathPattern, pathItem] of Object.entries(paths)) {
        const operation = pathItem[method.toLowerCase()];
        if (!operation) continue;

        // Convert OpenAPI path pattern to regex: /users/{id} -> /users/[^/]+
        let regex;
        try { regex = new RegExp('^' + pathPattern.replace(/\{[^}]+\}/g, '[^/]+') + '$'); } catch { continue; }
        const testPath = path.split('?')[0];
        if (regex.test(testPath)) {
          return {
            operationId: operation.operationId || method + ' ' + pathPattern,
            summary: operation.summary || '',
            description: operation.description || '',
            parameters: operation.parameters || pathItem.parameters || [],
            pathPattern,
            tags: operation.tags || []
          };
        }
      }
    }
    return null;
  }

  getStats() {
    return {
      port: this.port,
      requestCount: this.requestCount,
      activeConnections: this.activeConnections.size,
      mockRules: this.mockRules.length,
      breakpointRules: this.breakpointRules.length,
      pendingBreakpoints: this.pendingBreakpoints.size,
      upstreamProxy: this.upstreamProxy,
      tlsPassthrough: this.tlsPassthrough,
      http2Enabled: this.http2Enabled,
      clientCertificates: this.clientCertificates,
      trustedCAs: this.trustedCAs,
      httpsWhitelist: this.httpsWhitelist
    };
  }
}
