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
import { WsFrameParser, WS_OPCODE, WS_OPCODE_NAMES, parseClosePayload } from './ws-frame-parser.js';

export class ProxyServer {
  constructor(certificateAuthority, options = {}) {
    this.ca = certificateAuthority;
    this.port = options.port || 8080;
    this.onRequest = options.onRequest || (() => {});
    this.onBreakpoint = options.onBreakpoint || (() => {});
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
    this.httpsWhitelist = []; // [hostname]
    this.apiSpecs = []; // [{id, title, baseUrl, spec}]
    // HTTP/2 upstream session cache: Map<"host:port", {session, timer, pending?}>
    this._h2Sessions = new Map();
    // Set of origins known not to support h2: Set<"host:port">
    this._h2Blacklist = new Set();
  }

  setUpstreamProxy(config) {
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
    this.clientCertificates = certs || [];
    console.log(`[Proxy] Client certificates: ${this.clientCertificates.length} configured`);
  }

  setTrustedCAs(cas) {
    this.trustedCAs = cas || [];
    console.log(`[Proxy] Trusted CAs: ${this.trustedCAs.length} configured`);
  }

  setHttpsWhitelist(hosts) {
    this.httpsWhitelist = hosts || [];
    console.log(`[Proxy] HTTPS whitelist: ${this.httpsWhitelist.length} hosts`);
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
        if (err.code === 'EADDRINUSE') {
          console.error(`[Proxy] Port ${this.port} is already in use. Try: PROXY_PORT=<other_port> npm start`);
        } else {
          console.error('[Proxy] Server error:', err.message);
        }
        reject(err);
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
    const targetUrl = new URL(req.url);
    const options = {
      hostname: targetUrl.hostname,
      port: targetUrl.port || 80,
      path: targetUrl.pathname + targetUrl.search,
      headers: { ...req.headers },
      method: 'GET'
    };
    delete options.headers['proxy-connection'];

    const proxyReq = http.request(options);
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

    const requestBody = [];
    clientReq.on('data', chunk => requestBody.push(chunk));
    clientReq.on('end', async () => {
      const body = Buffer.concat(requestBody);

      // Check mock rules
      const mockRule = this._findMockRule(clientReq.method, targetUrl.href, clientReq.headers, this._safeBodyString(body));
      if (mockRule) {
        this._serveMockResponse(requestId, clientReq, clientRes, targetUrl, body, mockRule, startTime);
        return;
      }

      // Check breakpoint rules
      const breakpoint = this._checkBreakpoint(clientReq.method, targetUrl.href, clientReq.headers);
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
      }

      const headers = { ...clientReq.headers };
      delete headers['proxy-connection'];
      delete headers['proxy-authorization']; // Remove browser's proxy auth — we add our own for upstream

      let options;
      if (this.upstreamProxy && this._isSocksProxy()) {
        // Route through SOCKS proxy — connect via SOCKS then send normal request
        options = {
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
      } else if (this.upstreamProxy) {
        // Route through HTTP/HTTPS upstream proxy — send full URL as path
        options = {
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
      } else {
        options = {
          hostname: targetUrl.hostname,
          port: targetUrl.port || 80,
          path: targetUrl.pathname + targetUrl.search,
          method: clientReq.method,
          headers
        };
      }

      // Emit pending request immediately so it appears in the UI
      this._emitPendingRequest({
        id: requestId, protocol: 'http', method: clientReq.method, url: targetUrl.href,
        host: targetUrl.hostname, path: targetUrl.pathname + targetUrl.search,
        requestHeaders: clientReq.headers, requestBody: this._safeBodyString(body),
        requestBodySize: body.length, timestamp: startTime, source: 'proxy',
        tls: null, remote: null
      });

      const connectStart = Date.now();
      const proxyReq = http.request(options, (proxyRes) => {
        const responseBody = [];
        proxyRes.on('data', chunk => responseBody.push(chunk));
        proxyRes.on('end', () => {
          const resBody = Buffer.concat(responseBody);
          const duration = Date.now() - startTime;
          const timing = {
            total: Date.now() - startTime,
            waiting: Date.now() - connectStart // time waiting for response
          };
          const trailers = proxyRes.trailers;

          // Strip proxy hop-by-hop headers from responses forwarded to the browser.
          const resHeaders = { ...proxyRes.headers };
          if (proxyRes.statusCode !== 407) {
            delete resHeaders['proxy-authenticate'];
          }
          delete resHeaders['proxy-authorization'];
          delete resHeaders['proxy-connection'];
          clientRes.writeHead(proxyRes.statusCode, resHeaders);
          clientRes.end(resBody);

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
            statusCode: proxyRes.statusCode,
            statusMessage: proxyRes.statusMessage,
            responseHeaders: proxyRes.headers,
            responseBody: this._safeBodyString(resBody, proxyRes.headers['content-encoding'], proxyRes.headers['content-type']),
            responseBodySize: resBody.length,
            duration,
            timing,
            timestamp: startTime,
            source: 'proxy',
            tls: null,
            remote: { address: proxyReq.socket?.remoteAddress, port: proxyReq.socket?.remotePort },
            trailers: Object.keys(trailers || {}).length > 0 ? trailers : null
          });
        });
      });

      proxyReq.setTimeout(30000, () => {
        proxyReq.destroy(new Error('Request timeout after 30s'));
      });

      proxyReq.on('error', (err) => {
        const duration = Date.now() - startTime;
        clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
        clientRes.end(`Proxy Error: ${err.message}`);

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
          source: 'proxy',
          tls: null,
          remote: null
        });
      });

      proxyReq.end(body);
    });
  }

  // Handle CONNECT method for HTTPS tunneling + MITM
  _handleConnect(req, clientSocket, head) {
    const [hostname, port] = req.url.split(':');
    const targetPort = parseInt(port) || 443;

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
          url: `tunnel://${hostname}:${targetPort}`, host: hostname, path: '/',
          requestHeaders: {}, requestBody: '', requestBodySize: clientBytes,
          statusCode: 200, statusMessage: 'Tunnel Established',
          responseHeaders: {}, responseBody: '', responseBodySize: serverBytes,
          duration: Date.now() - startTime, timestamp: startTime,
          source: 'tunnel', tls: null,
          remote: { address: hostname, port: targetPort }
        });
      };

      const target = net.connect(targetPort, hostname, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        target.write(head);
        clientSocket.on('data', chunk => { clientBytes += chunk.length; });
        target.on('data', chunk => { serverBytes += chunk.length; });
        target.pipe(clientSocket);
        clientSocket.pipe(target);
      });
      target.on('close', emitTunnel);
      clientSocket.on('close', emitTunnel);
      target.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => target.destroy());
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

    // CONNECT handler for HTTPS tunneling

    // Tell client the tunnel is established
    clientSocket.write(
      'HTTP/1.1 200 Connection Established\r\n' +
      'Proxy-Agent: HTTP-FreeKit\r\n' +
      '\r\n'
    );

    // Create a TLS server for this connection to MITM
    try {
      const tlsServer = new tls.TLSSocket(clientSocket, {
        isServer: true,
        ...tlsOptions
      });

      if (useHttp2) {
        // Use an HTTP/2 server with allowHTTP1 to handle both h2 and h1.1 clients
        this._handleHttp2Connection(tlsServer, hostname, targetPort);
      } else {
        this._handleTlsConnection(tlsServer, hostname, targetPort);
      }
    } catch (err) {
      // TLS handshake failed (e.g., client disconnected)
      clientSocket.destroy();
      this._emitRequest({
        id: uuidv4(),
        protocol: 'tls-error',
        method: 'CONNECT',
        url: `https://${hostname}:${targetPort}`,
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
    }
  }

  _handleTlsConnection(tlsSocket, hostname, targetPort) {
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
          url: `tunnel://${hostname}:${targetPort}`, host: hostname, path: '/',
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
      let fullUrl = `https://${hostname}${targetPort !== 443 ? ':' + targetPort : ''}${req.url}`;

      const requestBody = [];
      req.on('data', chunk => requestBody.push(chunk));
      req.on('end', async () => {
        const body = Buffer.concat(requestBody);

        // Check mock rules
        const mockRule = this._findMockRule(req.method, fullUrl, req.headers, this._safeBodyString(body));
        if (mockRule) {
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
              const reqHeaders = { ...req.headers };
              if (action.addRequestHeaders) {
                for (const [k, v] of Object.entries(action.addRequestHeaders)) {
                  reqHeaders[k.toLowerCase()] = v;
                }
              }
              reqHeaders.host = forwardUrl.host;

              const fwdReq = fwdLib.request({
                hostname: forwardUrl.hostname,
                port: forwardUrl.port || (isForwardHttps ? 443 : 80),
                path: req.url,
                method: req.method,
                headers: reqHeaders,
                rejectUnauthorized: false
              }, (fwdRes) => {
                const responseBody = [];
                fwdRes.on('data', chunk => responseBody.push(chunk));
                fwdRes.on('end', () => {
                  const resBody = Buffer.concat(responseBody);
                  const resHeaders = { ...fwdRes.headers };
                  if (action.addResponseHeaders) {
                    for (const [k, v] of Object.entries(action.addResponseHeaders)) {
                      resHeaders[k.toLowerCase()] = v;
                    }
                  }
                  try {
                    res.writeHead(fwdRes.statusCode, resHeaders);
                    res.end(resBody);
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
              fwdReq.end(body);
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
              try { fullUrl = modifications.url; } catch { /* keep original */ }
            }
            if (modifications.method) req.method = modifications.method;
            if (modifications.headers) Object.assign(req.headers, modifications.headers);
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
        const breakpointRule = this._checkBreakpoint(req.method, fullUrl, req.headers);
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
        }

        // Forward to real server
        const proxyOpts = {
          hostname, port: targetPort, path: req.url, method: req.method,
          headers: { ...req.headers }, rejectUnauthorized: false
        };

        let upstreamProtocol = 'https';

        const emitSuccess = (statusCode, statusMessage, responseHeaders, resBody, remote, trailers) => {
          const duration = Date.now() - startTime;
          this._emitRequest({
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

        const emitError = (err) => {
          const duration = Date.now() - startTime;
          this._emitRequest({
            id: requestId, protocol: upstreamProtocol, method: req.method, url: fullUrl,
            host: hostname, path: req.url, requestHeaders: req.headers,
            requestBody: this._safeBodyString(body), requestBodySize: body.length,
            statusCode: 502, statusMessage: 'Bad Gateway', responseHeaders: {},
            responseBody: `Proxy Error: ${err.message}`, responseBodySize: 0,
            duration, timestamp: startTime, error: err.message, source: 'proxy',
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
                h2Session, req.method, hostname, targetPort, req.url, req.headers, body
              );
              try {
                res.writeHead(h2Res.statusCode, h2Res.headers);
                res.end(h2Res.body);
              } catch (e) { /* client gone */ }
              emitSuccess(h2Res.statusCode, h2Res.statusMessage, h2Res.headers, h2Res.body,
                { address: h2Res.remoteAddress, port: h2Res.remotePort }, null);
              return;
            }
          } catch (err) {
            // H2 request failed — fall back to h1.1
            upstreamProtocol = 'https';
          }
        }

        // Fallback: HTTPS/1.1
        const handleResponse = (proxyRes) => {
          const responseBody = [];
          proxyRes.on('data', chunk => responseBody.push(chunk));
          proxyRes.on('end', () => {
            const resBody = Buffer.concat(responseBody);
            const trailers = proxyRes.trailers;
            try {
              res.writeHead(proxyRes.statusCode, proxyRes.headers);
              res.end(resBody);
            } catch (e) { /* client gone */ }
            emitSuccess(proxyRes.statusCode, proxyRes.statusMessage, proxyRes.headers, resBody,
              { address: proxyReq?.socket?.remoteAddress, port: proxyReq?.socket?.remotePort }, trailers);
          });
        };

        const handleError = (err) => {
          try {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end(`Proxy Error: ${err.message}`);
          } catch (e) { /* client gone */ }
          emitError(err);
        };

        let proxyReq;
        if (this.upstreamProxy) {
          const agent = this._getUpstreamAgent();
          proxyReq = https.request({
            ...proxyOpts,
            agent,
            insecureHTTPParser: true
          }, handleResponse);
        } else {
          proxyReq = https.request(proxyOpts, handleResponse);
        }

        proxyReq.on('error', handleError);
        proxyReq.end(body);
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
          url: `https://${hostname}:${targetPort}`,
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

  _handleHttp2Connection(tlsSocket, hostname, targetPort) {
    const tlsDetails = tlsSocket.getCipher ? {
      cipher: tlsSocket.getCipher()?.name || null,
      version: tlsSocket.getProtocol?.() || 'TLSv1.2'
    } : null;

    // Track whether any HTTP request is received on this connection
    let httpRequestReceived = false;
    const tunnelStartTime = Date.now();
    let tunnelEmitted = false;

    const tunnelTimer = setTimeout(() => {
      if (!httpRequestReceived && !tunnelEmitted) {
        tunnelEmitted = true;
        this._emitRequest({
          id: uuidv4(), protocol: 'tunnel', method: 'CONNECT',
          url: `tunnel://${hostname}:${targetPort}`, host: hostname, path: '/',
          requestHeaders: {}, requestBody: '', requestBodySize: 0,
          statusCode: 200, statusMessage: 'Raw Tunnel',
          responseHeaders: {}, responseBody: '', responseBodySize: 0,
          duration: Date.now() - tunnelStartTime, timestamp: tunnelStartTime,
          source: 'tunnel', tls: tlsDetails,
          remote: { address: hostname, port: targetPort }
        });
      }
    }, 5000);

    tlsSocket.on('close', () => clearTimeout(tunnelTimer));

    // Create an HTTP/2 server that also handles HTTP/1.1 fallback via allowHTTP1
    const h2Server = http2.createServer({ allowHTTP1: true });

    // HTTP/2 streams — each stream is a separate request
    h2Server.on('stream', (stream, headers) => {
      httpRequestReceived = true;
      clearTimeout(tunnelTimer);
      const startTime = Date.now();
      const requestId = uuidv4();
      this.requestCount++;

      const method = headers[':method'];
      const path = headers[':path'];
      const authority = headers[':authority'] || hostname;
      const scheme = headers[':scheme'] || 'https';
      const fullUrl = `${scheme}://${authority}${path}`;

      // Collect request body
      const requestBody = [];
      stream.on('data', chunk => requestBody.push(chunk));
      stream.on('end', async () => {
        const body = Buffer.concat(requestBody);

        // Convert h2 pseudo-headers to regular headers for matching
        const reqHeaders = {};
        for (const [k, v] of Object.entries(headers)) {
          if (!k.startsWith(':')) reqHeaders[k] = v;
        }

        // Check mock rules
        const mockRule = this._findMockRule(method, fullUrl, reqHeaders, this._safeBodyString(body));
        if (mockRule) {
          await this._handleH2MockResponse(stream, mockRule, {
            requestId, method, fullUrl, authority, path, reqHeaders, body, startTime, tlsDetails
          });
          return;
        }

        // Check breakpoint rules
        const breakpointRule = this._checkBreakpoint(method, fullUrl, reqHeaders);
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
          // Apply modifications if provided (note: can't change pseudo-headers on existing stream)
          if (modifications.method) { /* method is fixed for this stream */ }
          if (modifications.headers) Object.assign(reqHeaders, modifications.headers);
        }

        // Forward to upstream server — try HTTP/2 first, then fall back to HTTPS/1.1
        const upstreamHeaders = { ...reqHeaders };
        if (!upstreamHeaders.host) {
          upstreamHeaders.host = targetPort === 443 ? hostname : `${hostname}:${targetPort}`;
        }

        const source = this._detectSource(reqHeaders);

        const emitH2Success = (statusCode, statusMessage, responseHeaders, resBody, remote) => {
          const duration = Date.now() - startTime;
          this._emitRequest({
            id: requestId, protocol: 'h2', method, url: fullUrl,
            host: authority, path, requestHeaders: reqHeaders,
            requestBody: this._safeBodyString(body), requestBodySize: body.length,
            statusCode, statusMessage, responseHeaders,
            responseBody: this._safeBodyString(resBody, responseHeaders['content-encoding'], responseHeaders['content-type']),
            responseBodySize: resBody.length, duration, timestamp: startTime,
            source, tls: tlsDetails, remote
          });
        };

        const emitH2Error = (err) => {
          const duration = Date.now() - startTime;
          this._emitRequest({
            id: requestId, protocol: 'h2', method, url: fullUrl,
            host: authority, path, requestHeaders: reqHeaders,
            requestBody: this._safeBodyString(body), requestBodySize: body.length,
            statusCode: 502, statusMessage: 'Bad Gateway', responseHeaders: {},
            responseBody: 'Proxy Error: ' + err.message, responseBodySize: 0,
            duration, timestamp: startTime, error: err.message,
            source, tls: tlsDetails, remote: null
          });
        };

        // Try HTTP/2 upstream (skip if upstream proxy is configured)
        if (!this.upstreamProxy) {
          try {
            const h2Session = await this._getH2Session(hostname, targetPort);
            if (h2Session) {
              const h2Res = await this._makeH2Request(
                h2Session, method, hostname, targetPort, path, upstreamHeaders, body
              );
              // Build h2 response headers for the client stream
              const h2ResponseHeaders = { ':status': h2Res.statusCode };
              for (const [k, v] of Object.entries(h2Res.headers)) {
                const lower = k.toLowerCase();
                if (['transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'http2-settings'].includes(lower)) continue;
                h2ResponseHeaders[k] = Array.isArray(v) ? v.join(', ') : v;
              }
              try {
                if (!stream.destroyed && !stream.closed) {
                  stream.respond(h2ResponseHeaders);
                  stream.end(h2Res.body);
                }
              } catch (e) { /* stream already closed */ }
              emitH2Success(h2Res.statusCode, h2Res.statusMessage, h2Res.headers, h2Res.body,
                { address: h2Res.remoteAddress, port: h2Res.remotePort });
              return;
            }
          } catch (err) {
            // H2 request failed — fall back to h1.1
          }
        }

        // Fallback: HTTPS/1.1 upstream
        const proxyOpts = {
          hostname, port: targetPort, path, method,
          headers: upstreamHeaders, rejectUnauthorized: false
        };

        const handleResponse = (proxyRes) => {
          const responseBody = [];
          proxyRes.on('data', chunk => responseBody.push(chunk));
          proxyRes.on('end', () => {
            const resBody = Buffer.concat(responseBody);

            // Build h2 response headers, filtering out h1-specific ones
            const responseHeaders = { ':status': proxyRes.statusCode };
            for (const [k, v] of Object.entries(proxyRes.headers)) {
              const lower = k.toLowerCase();
              if (['transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'http2-settings'].includes(lower)) continue;
              responseHeaders[k] = Array.isArray(v) ? v.join(', ') : v;
            }

            try {
              if (!stream.destroyed && !stream.closed) {
                stream.respond(responseHeaders);
                stream.end(resBody);
              }
            } catch (e) { /* stream already closed */ }

            emitH2Success(proxyRes.statusCode, proxyRes.statusMessage, proxyRes.headers, resBody,
              { address: proxyReq?.socket?.remoteAddress, port: proxyReq?.socket?.remotePort });
          });
        };

        const handleError = (err) => {
          try {
            if (!stream.destroyed && !stream.closed) {
              stream.respond({ ':status': 502 });
              stream.end('Proxy Error: ' + err.message);
            }
          } catch (e) { /* stream already closed */ }
          emitH2Error(err);
        };

        let proxyReq;
        if (this.upstreamProxy) {
          try {
            const agent = this._getUpstreamAgent();
            proxyReq = https.request({
              ...proxyOpts,
              agent,
              insecureHTTPParser: true
            }, handleResponse);
          } catch (err) {
            handleError(err);
            return;
          }
        } else {
          proxyReq = https.request(proxyOpts, handleResponse);
        }

        proxyReq.on('error', handleError);
        proxyReq.setTimeout(30000, () => {
          proxyReq.destroy(new Error('Request timeout after 30s'));
        });
        proxyReq.end(body);
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
      let fullUrl = `https://${hostname}${targetPort !== 443 ? ':' + targetPort : ''}${req.url}`;

      const requestBody = [];
      req.on('data', chunk => requestBody.push(chunk));
      req.on('end', async () => {
        const body = Buffer.concat(requestBody);

        // Check mock rules
        const mockRule = this._findMockRule(req.method, fullUrl, req.headers, this._safeBodyString(body));
        if (mockRule) {
          this._serveMockResponseH1OnH2(requestId, req, res, fullUrl, hostname, targetPort, body, mockRule, startTime, tlsDetails);
          return;
        }

        // Check breakpoint rules
        const breakpointRule = this._checkBreakpoint(req.method, fullUrl, req.headers);
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
            try { fullUrl = modifications.url; } catch { /* keep original */ }
          }
          if (modifications.method) req.method = modifications.method;
          if (modifications.headers) Object.assign(req.headers, modifications.headers);
        }

        // Forward to real server — try HTTP/2 upstream first
        let upstreamProtocol = 'https';

        const emitH1Success = (statusCode, statusMessage, responseHeaders, resBody, remote) => {
          const duration = Date.now() - startTime;
          this._emitRequest({
            id: requestId, protocol: upstreamProtocol, method: req.method, url: fullUrl,
            host: hostname, path: req.url, requestHeaders: req.headers,
            requestBody: this._safeBodyString(body), requestBodySize: body.length,
            statusCode, statusMessage, responseHeaders,
            responseBody: this._safeBodyString(resBody, responseHeaders['content-encoding'], responseHeaders['content-type']),
            responseBodySize: resBody.length, duration, timestamp: startTime, source: 'proxy',
            tls: tlsDetails, remote
          });
        };

        const emitH1Error = (err) => {
          const duration = Date.now() - startTime;
          this._emitRequest({
            id: requestId, protocol: upstreamProtocol, method: req.method, url: fullUrl,
            host: hostname, path: req.url, requestHeaders: req.headers,
            requestBody: this._safeBodyString(body), requestBodySize: body.length,
            statusCode: 502, statusMessage: 'Bad Gateway', responseHeaders: {},
            responseBody: `Proxy Error: ${err.message}`, responseBodySize: 0,
            duration, timestamp: startTime, error: err.message, source: 'proxy',
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
                h2Session, req.method, hostname, targetPort, req.url, req.headers, body
              );
              try {
                res.writeHead(h2Res.statusCode, h2Res.headers);
                res.end(h2Res.body);
              } catch (e) { /* client gone */ }
              emitH1Success(h2Res.statusCode, h2Res.statusMessage, h2Res.headers, h2Res.body,
                { address: h2Res.remoteAddress, port: h2Res.remotePort });
              return;
            }
          } catch (err) {
            // H2 request failed — fall back to h1.1
            upstreamProtocol = 'https';
          }
        }

        // Fallback: HTTPS/1.1
        const proxyOpts = {
          hostname, port: targetPort, path: req.url, method: req.method,
          headers: { ...req.headers }, rejectUnauthorized: false
        };

        const handleResponse = (proxyRes) => {
          const responseBody = [];
          proxyRes.on('data', chunk => responseBody.push(chunk));
          proxyRes.on('end', () => {
            const resBody = Buffer.concat(responseBody);
            try {
              res.writeHead(proxyRes.statusCode, proxyRes.headers);
              res.end(resBody);
            } catch (e) { /* client gone */ }
            emitH1Success(proxyRes.statusCode, proxyRes.statusMessage, proxyRes.headers, resBody,
              { address: proxyReq?.socket?.remoteAddress, port: proxyReq?.socket?.remotePort });
          });
        };

        const handleError = (err) => {
          try {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end(`Proxy Error: ${err.message}`);
          } catch (e) { /* client gone */ }
          emitH1Error(err);
        };

        let proxyReq;
        if (this.upstreamProxy) {
          const agent = this._getUpstreamAgent();
          proxyReq = https.request({
            ...proxyOpts,
            agent,
            insecureHTTPParser: true
          }, handleResponse);
        } else {
          proxyReq = https.request(proxyOpts, handleResponse);
        }

        proxyReq.on('error', handleError);
        proxyReq.end(body);
      });
    });

    h2Server.on('sessionError', (err) => {
      if (err.code === 'ECONNRESET' || err.code === 'EPIPE') return;
    });

    h2Server.on('error', (err) => {
      if (err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.code === 'ECONNABORTED') return;
    });

    // Feed the TLS socket into the h2 server — it handles both h2 and h1.1
    h2Server.emit('connection', tlsSocket);

    tlsSocket.on('error', (err) => {
      if (err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.code === 'ECONNABORTED') return;
      if (err.message?.includes('ECONNABORTED')) return;
      if (err.message?.includes('ssl') || err.message?.includes('SSL') ||
          err.message?.includes('handshake') || err.message?.includes('HANDSHAKE') ||
          err.code === 'ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN' ||
          err.code === 'ERR_SSL_WRONG_VERSION_NUMBER') {
        this._emitRequest({
          id: uuidv4(),
          protocol: 'tls-error',
          method: 'CONNECT',
          url: `https://${hostname}:${targetPort}`,
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

  // Handle mock responses for HTTP/2 streams
  async _handleH2MockResponse(stream, mockRule, ctx) {
    const { requestId, method, fullUrl, authority, path, reqHeaders, body, startTime, tlsDetails } = ctx;

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
          rejectUnauthorized: false
        }, (fwdRes) => {
          const responseBody = [];
          fwdRes.on('data', chunk => responseBody.push(chunk));
          fwdRes.on('end', () => {
            const resBody = Buffer.concat(responseBody);
            const resHeaders = { ':status': fwdRes.statusCode };
            for (const [k, v] of Object.entries(fwdRes.headers)) {
              const lower = k.toLowerCase();
              if (['transfer-encoding', 'connection', 'keep-alive', 'upgrade'].includes(lower)) continue;
              resHeaders[k] = Array.isArray(v) ? v.join(', ') : v;
            }
            if (action.addResponseHeaders) {
              for (const [k, v] of Object.entries(action.addResponseHeaders)) {
                resHeaders[k.toLowerCase()] = v;
              }
            }
            try {
              if (!stream.destroyed && !stream.closed) {
                stream.respond(resHeaders);
                stream.end(resBody);
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
        fwdReq.end(body);
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
      await new Promise((resolve) => {
        this.pendingBreakpoints.set(requestId, {
          method, url: fullUrl, host: authority, path, headers: reqHeaders,
          body: this._safeBodyString(body), timestamp: Date.now(), resolve
        });
        this._setBreakpointTimeout(requestId);
      });
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
  _serveMockResponseH1OnH2(requestId, req, res, fullUrl, hostname, targetPort, body, mockRule, startTime, tlsDetails) {
    // Delegate to the standard mock response handler — it uses h1 res.writeHead/end which works
    // because allowHTTP1 gives us a standard http.ServerResponse for h1.1 clients
    const action = mockRule.action || {
      type: 'fixed-response',
      status: mockRule.response?.status || 200,
      headers: mockRule.response?.headers || { 'Content-Type': 'application/json' },
      body: mockRule.response?.body || '',
      delay: 0
    };

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

    try {
      res.writeHead(mockStatus, mockHeaders);
      res.end(mockBody);
    } catch (e) { /* client gone */ }

    this._emitRequest({
      id: requestId, protocol: 'https', method: req.method, url: fullUrl,
      host: hostname, path: req.url, requestHeaders: req.headers,
      requestBody: this._safeBodyString(body), requestBodySize: body.length,
      statusCode: mockStatus, statusMessage: 'Mocked', responseHeaders: mockHeaders,
      responseBody: mockBody, responseBodySize: Buffer.byteLength(mockBody),
      duration: Date.now() - startTime, timestamp: startTime, source: 'mock',
      tls: tlsDetails, remote: null
    });
  }

  // Get or create an HTTP/2 session to the given origin, with caching.
  // Returns the h2 session or null if the origin doesn't support h2.
  _getH2Session(hostname, port) {
    const origin = `${hostname}:${port}`;

    // Known not to support h2
    if (this._h2Blacklist.has(origin)) return Promise.resolve(null);

    // Existing live session
    const cached = this._h2Sessions.get(origin);
    if (cached && !cached.session.destroyed && !cached.session.closed) {
      // Reset idle timer
      clearTimeout(cached.timer);
      cached.timer = setTimeout(() => this._evictH2Session(origin), 60000);
      return Promise.resolve(cached.session);
    }

    // Already connecting — wait for it
    if (cached && cached.pending) return cached.pending;

    // Create new session
    const pending = new Promise((resolve) => {
      const url = `https://${hostname}:${port}`;
      let settled = false;

      const session = http2.connect(url, {
        rejectUnauthorized: false,
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

      // Store pending promise so concurrent requests share it
      this._h2Sessions.set(origin, { session, timer, pending });
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
  // { statusCode, headers, body: Buffer } or null if the request can't be made via h2.
  _makeH2Request(session, method, hostname, port, path, headers, body) {
    return new Promise((resolve, reject) => {
      // Build h2 pseudo-headers + regular headers
      const h2Headers = {
        ':method': method,
        ':path': path,
        ':scheme': 'https',
        ':authority': port === 443 ? hostname : `${hostname}:${port}`
      };

      // Copy regular headers, filtering out h1-specific ones
      for (const [k, v] of Object.entries(headers)) {
        const lower = k.toLowerCase();
        if (lower.startsWith(':')) continue; // skip existing pseudo-headers
        if (['connection', 'keep-alive', 'transfer-encoding', 'upgrade',
             'http2-settings', 'proxy-connection', 'host'].includes(lower)) continue;
        h2Headers[lower] = v;
      }

      const stream = session.request(h2Headers);

      let statusCode;
      const responseHeaders = {};
      const responseBody = [];

      stream.on('response', (hdrs) => {
        statusCode = hdrs[':status'];
        for (const [k, v] of Object.entries(hdrs)) {
          if (!k.startsWith(':')) {
            responseHeaders[k] = v;
          }
        }
      });

      stream.on('data', chunk => responseBody.push(chunk));

      stream.on('end', () => {
        resolve({
          statusCode,
          statusMessage: '',
          headers: responseHeaders,
          body: Buffer.concat(responseBody),
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

      // Send request body
      if (body && body.length > 0) {
        stream.end(body);
      } else {
        stream.end();
      }
    });
  }

  // Build a proxy URL from the upstream proxy config
  _getUpstreamProxyUrl() {
    const p = this.upstreamProxy;
    const scheme = p.type?.startsWith('socks') ? p.type : (p.type === 'https' ? 'https' : 'http');
    const auth = p.auth ? `${p.auth}@` : '';
    return `${scheme}://${auth}${p.host}:${p.port}`;
  }

  // Return an https-proxy-agent or socks-proxy-agent that handles CONNECT tunneling + TLS automatically.
  // Matches HTTP Toolkit's approach: the agent opens the CONNECT tunnel and TLS-wraps the socket.
  _getUpstreamAgent() {
    const proxyUrl = this._getUpstreamProxyUrl();
    if (this.upstreamProxy.type?.startsWith('socks')) {
      return new SocksProxyAgent(proxyUrl);
    }
    return new HttpsProxyAgent(proxyUrl, { rejectUnauthorized: false });
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
    };
    if (proxy.auth) {
      const [userId, password] = proxy.auth.split(':');
      socksOptions.proxy.userId = userId;
      socksOptions.proxy.password = password || '';
    }
    const { socket } = await SocksClient.createConnection(socksOptions);
    return socket;
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

    return sorted.find(rule => {
      if (!rule.enabled) return false;

      // Passthrough rules mean "don't mock" — skip them so the request proceeds normally
      if (rule.action?.type === 'passthrough') return false;

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

  async _serveMockResponse(requestId, clientReq, clientRes, targetUrl, body, mockRule, startTime) {
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
        id: requestId, protocol: 'http', method: clientReq.method, url: targetUrl.href,
        host: targetUrl.hostname, path: targetUrl.pathname + targetUrl.search,
        requestHeaders: clientReq.headers, requestBody: this._safeBodyString(body),
        requestBodySize: body.length, statusCode: 0, statusMessage: 'Connection Closed',
        responseHeaders: {}, responseBody: '', responseBodySize: 0,
        duration: Date.now() - startTime, timestamp: startTime, source: 'mock',
        tls: null, remote: null,
        originalRequest, transformedBy
      });
      return;
    }

    // Reset connection (RST)
    if (action.type === 'reset') {
      clientRes.socket?.destroy();
      this._emitRequest({
        id: requestId, protocol: 'http', method: clientReq.method, url: targetUrl.href,
        host: targetUrl.hostname, path: targetUrl.pathname + targetUrl.search,
        requestHeaders: clientReq.headers, requestBody: this._safeBodyString(body),
        requestBodySize: body.length, statusCode: 0, statusMessage: 'Connection Reset',
        responseHeaders: {}, responseBody: '', responseBodySize: 0,
        duration: Date.now() - startTime, timestamp: startTime, source: 'mock',
        tls: null, remote: null,
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
        const reqHeaders = { ...clientReq.headers };
        // Apply request header modifications if present
        if (action.addRequestHeaders) {
          for (const [k, v] of Object.entries(action.addRequestHeaders)) {
            reqHeaders[k.toLowerCase()] = v;
          }
        }
        reqHeaders.host = forwardUrl.host;

        const proxyReq = lib.request({
          hostname: forwardUrl.hostname,
          port: forwardUrl.port || (isHttps ? 443 : 80),
          path: targetUrl.pathname + targetUrl.search,
          method: clientReq.method,
          headers: reqHeaders,
          rejectUnauthorized: false
        }, (proxyRes) => {
          const responseBody = [];
          proxyRes.on('data', chunk => responseBody.push(chunk));
          proxyRes.on('end', () => {
            const resBody = Buffer.concat(responseBody);
            const resHeaders = { ...proxyRes.headers };
            const trailers = proxyRes.trailers;
            // Apply response header modifications
            if (action.addResponseHeaders) {
              for (const [k, v] of Object.entries(action.addResponseHeaders)) {
                resHeaders[k.toLowerCase()] = v;
              }
            }
            clientRes.writeHead(proxyRes.statusCode, resHeaders);
            clientRes.end(resBody);
            this._emitRequest({
              id: requestId, protocol: 'http', method: clientReq.method, url: targetUrl.href,
              host: targetUrl.hostname, path: targetUrl.pathname + targetUrl.search,
              requestHeaders: clientReq.headers, requestBody: this._safeBodyString(body),
              requestBodySize: body.length, statusCode: proxyRes.statusCode,
              statusMessage: proxyRes.statusMessage, responseHeaders: resHeaders,
              responseBody: this._safeBodyString(resBody, proxyRes.headers['content-encoding'], proxyRes.headers['content-type']),
              responseBodySize: resBody.length, duration: Date.now() - startTime,
              timestamp: startTime, source: 'mock',
              tls: null, remote: { address: proxyReq.socket?.remoteAddress, port: proxyReq.socket?.remotePort },
              trailers: Object.keys(trailers || {}).length > 0 ? trailers : null,
              originalRequest, transformedBy
            });
          });
        });
        proxyReq.on('error', (err) => {
          clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
          clientRes.end(`Forward Error: ${err.message}`);
          this._emitRequest({
            id: requestId, protocol: 'http', method: clientReq.method, url: targetUrl.href,
            host: targetUrl.hostname, path: targetUrl.pathname + targetUrl.search,
            requestHeaders: clientReq.headers, requestBody: this._safeBodyString(body),
            requestBodySize: body.length, statusCode: 502, statusMessage: 'Bad Gateway',
            responseHeaders: {}, responseBody: `Forward Error: ${err.message}`,
            responseBodySize: 0, duration: Date.now() - startTime,
            timestamp: startTime, source: 'mock', error: err.message,
            tls: null, remote: null,
            originalRequest, transformedBy
          });
        });
        proxyReq.end(body);
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
          id: requestId, protocol: 'http', method: clientReq.method, url: targetUrl.href,
          host: targetUrl.hostname, path: targetUrl.pathname + targetUrl.search,
          requestHeaders: clientReq.headers, requestBody: this._safeBodyString(body),
          requestBodySize: body.length, statusCode: 500, statusMessage: 'Mock Error',
          responseHeaders: { 'Content-Type': 'text/plain' },
          responseBody: 'Mock error: no filePath configured', responseBodySize: 0,
          duration: Date.now() - startTime, timestamp: startTime, source: 'mock',
          tls: null, remote: null,
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
          id: requestId, protocol: 'http', method: clientReq.method, url: targetUrl.href,
          host: targetUrl.hostname, path: targetUrl.pathname + targetUrl.search,
          requestHeaders: clientReq.headers, requestBody: this._safeBodyString(body),
          requestBodySize: body.length, statusCode: fileStatus, statusMessage: 'Mocked (file)',
          responseHeaders: { 'Content-Type': mime },
          responseBody: this._safeBodyString(content),
          responseBodySize: content.length,
          duration: Date.now() - startTime, timestamp: startTime, source: 'mock',
          tls: null, remote: null,
          originalRequest, transformedBy
        });
      } catch (err) {
        clientRes.writeHead(500, { 'Content-Type': 'text/plain' });
        clientRes.end('File not found: ' + filePath);
        this._emitRequest({
          id: requestId, protocol: 'http', method: clientReq.method, url: targetUrl.href,
          host: targetUrl.hostname, path: targetUrl.pathname + targetUrl.search,
          requestHeaders: clientReq.headers, requestBody: this._safeBodyString(body),
          requestBodySize: body.length, statusCode: 500, statusMessage: 'File Error',
          responseHeaders: { 'Content-Type': 'text/plain' },
          responseBody: 'File not found: ' + filePath, responseBodySize: 0,
          duration: Date.now() - startTime, timestamp: startTime, source: 'mock',
          error: err.message, tls: null, remote: null,
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
          rejectUnauthorized: false
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
        id: requestId, protocol: 'http', method: clientReq.method, url: targetUrl.href,
        host: targetUrl.hostname, path: targetUrl.pathname + targetUrl.search,
        requestHeaders: clientReq.headers, requestBody: this._safeBodyString(body),
        requestBodySize: body.length, statusCode: 200, statusMessage: 'Webhook sent',
        responseHeaders: { 'Content-Type': 'text/plain' }, responseBody: '', responseBodySize: 0,
        duration: Date.now() - startTime, timestamp: startTime, source: 'mock',
        tls: null, remote: null,
        originalRequest, transformedBy
      });
      return;
    }

    // Breakpoint on request (pause for manual editing)
    if (action.type === 'breakpoint-request') {
      this._emitRequest({
        id: requestId, protocol: 'http', method: clientReq.method, url: targetUrl.href,
        host: targetUrl.hostname, path: targetUrl.pathname + targetUrl.search,
        requestHeaders: clientReq.headers, requestBody: this._safeBodyString(body),
        requestBodySize: body.length, statusCode: 0, statusMessage: 'Breakpoint',
        responseHeaders: {}, responseBody: '', responseBodySize: 0,
        duration: 0, timestamp: startTime, source: 'breakpoint',
        tls: null, remote: null,
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
      // Fall through to normal proxy behavior (don't return here)
    }

    // Breakpoint on response (forward normally, pause the response)
    if (action.type === 'breakpoint-response') {
      // Mark this request so the response will be paused
      this._emitRequest({
        id: requestId, protocol: 'http', method: clientReq.method, url: targetUrl.href,
        host: targetUrl.hostname, path: targetUrl.pathname + targetUrl.search,
        requestHeaders: clientReq.headers, requestBody: this._safeBodyString(body),
        requestBodySize: body.length, statusCode: 0, statusMessage: 'Breakpoint (response)',
        responseHeaders: {}, responseBody: '', responseBodySize: 0,
        duration: 0, timestamp: startTime, source: 'breakpoint',
        tls: null, remote: null,
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
        id: requestId, protocol: 'http', method: clientReq.method, url: targetUrl.href,
        host: targetUrl.hostname, path: targetUrl.pathname + targetUrl.search,
        requestHeaders: clientReq.headers, requestBody: this._safeBodyString(body),
        requestBodySize: body.length, statusCode: 0, statusMessage: 'Breakpoint (request)',
        responseHeaders: {}, responseBody: '', responseBodySize: 0,
        duration: 0, timestamp: startTime, source: 'breakpoint',
        tls: null, remote: null,
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

      // Phase 2: Pause on the response
      this._emitRequest({
        id: requestId, protocol: 'http', method: clientReq.method, url: targetUrl.href,
        host: targetUrl.hostname, path: targetUrl.pathname + targetUrl.search,
        requestHeaders: clientReq.headers, requestBody: this._safeBodyString(body),
        requestBodySize: body.length, statusCode: 0, statusMessage: 'Breakpoint (response)',
        responseHeaders: {}, responseBody: '', responseBodySize: 0,
        duration: 0, timestamp: startTime, source: 'breakpoint',
        tls: null, remote: null,
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
      protocol: 'http',
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
      tls: null,
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
    try {
      this.onRequest(data);
    } catch (err) {
      console.error('[Proxy] Error in request update handler:', err.message);
    }
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
    try {
      switch (encoding) {
        case 'gzip':
        case 'x-gzip':
          return zlib.gunzipSync(buffer);
        case 'deflate':
          return zlib.inflateSync(buffer);
        case 'br':
          return zlib.brotliDecompressSync(buffer);
        case 'zstd':
          if (zlib.zstdDecompressSync) return zlib.zstdDecompressSync(buffer);
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
    if (ct.startsWith('image/') && decoded.length < 2 * 1024 * 1024) { // up to 2MB images
      const mimeType = ct.split(';')[0].trim();
      return `data:${mimeType};base64,${decoded.toString('base64')}`;
    }

    // Limit body capture to 512KB
    const maxSize = 512 * 1024;
    if (decoded.length > maxSize) decoded = decoded.slice(0, maxSize);

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
      return decoded.toString('utf8');
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

  getBreakpoints() {
    return this.breakpointRules;
  }

  getPendingBreakpoints() {
    const pending = [];
    for (const [id, bp] of this.pendingBreakpoints) {
      pending.push({ id, method: bp.method, url: bp.url, host: bp.host, timestamp: bp.timestamp });
    }
    return pending;
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
