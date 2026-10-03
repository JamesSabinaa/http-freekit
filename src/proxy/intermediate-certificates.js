import { X509Certificate } from 'node:crypto';
import { lookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const CHAIN_ERRORS = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_ISSUER_CERT'
]);
const MAX_CERT_BYTES = 128 * 1024;
const MAX_ISSUERS = 5;
const CACHE_TTL = 60 * 60 * 1000;

// AIA locations come from an unauthenticated peer. Never let certificate
// discovery become a request to loopback, private networks or cloud metadata.
export function isPublicCertificateAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) || (a === 198 && (b === 18 || b === 19)));
  }
  // Only native global-unicast IPv6; exclude transition mechanisms too.
  return net.isIP(address) === 6 && /^[23]/i.test(address) &&
    !/^200[12]:/i.test(address) && !/^2001:(?:0*:|0*db8:)/i.test(address);
}

export function downloadIssuer(location, signal) {
  const url = new URL(location);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && !['80', '443'].includes(url.port))) {
    throw new Error('Unsupported certificate issuer URL');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(hostname) && !isPublicCertificateAddress(hostname)) {
    throw new Error('Non-public certificate issuer address');
  }
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).get(url, {
      agent: false,
      signal,
      headers: { Accept: 'application/pkix-cert, application/x-x509-ca-cert' },
      lookup(name, options, callback) {
        lookup(name, { ...options, all: true }, (error, addresses) => {
          if (error) return callback(error);
          const permitted = addresses.filter(item => isPublicCertificateAddress(item.address));
          if (!permitted.length) return callback(new Error('Non-public certificate issuer address'));
          // The checked addresses are passed directly to the socket: no second
          // DNS lookup, including when Node enables automatic family selection.
          if (options.all) callback(null, permitted);
          else callback(null, permitted[0].address, permitted[0].family);
        });
      }
    }, response => {
      // Redirects deliberately are not followed.
      if (response.statusCode !== 200) {
        response.destroy();
        reject(new Error(`Certificate issuer returned HTTP ${response.statusCode}`));
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_CERT_BYTES) request.destroy(new Error('Certificate issuer response too large'));
        else chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('end', () => resolve(Buffer.concat(chunks)));
    });
    request.once('error', reject);
    const timer = setTimeout(() => request.destroy(new Error('Certificate issuer timeout')), 3000);
    timer.unref?.();
    request.once('close', () => clearTimeout(timer));
  });
}

function peerChain(socket) {
  const chain = [];
  let peer = socket.getPeerCertificate(true);
  const seen = new Set();
  while (peer?.raw && chain.length < 10) {
    const cert = new X509Certificate(peer.raw);
    if (seen.has(cert.fingerprint256)) break;
    seen.add(cert.fingerprint256);
    chain.push(cert);
    peer = peer.issuerCertificate;
  }
  return chain;
}

function waitForHandshake(socket, signal) {
  if (!socket.encrypted || socket.secureConnecting === false) return Promise.resolve(socket);
  return new Promise((resolve, reject) => {
    let chain = [];
    const capture = () => { chain = peerChain(socket); };
    const cleanup = () => {
      socket.removeListener('secure', capture);
      socket.removeListener('secureConnect', success);
      socket.removeListener('error', failure);
      socket.removeListener('close', closed);
      signal.removeEventListener('abort', abort);
    };
    const success = () => { cleanup(); resolve(socket); };
    const failure = error => {
      cleanup();
      socket.destroy();
      reject(Object.assign(error, { peerChain: chain }));
    };
    const closed = () => failure(new Error('TLS connection closed before verification'));
    const abort = () => failure(signal.reason);
    // Capture the chain before Node rejects and destroys an unauthorized socket.
    // Verification remains enabled and this socket is never exposed to HTTP.
    socket.prependOnceListener('secure', capture);
    socket.once('secureConnect', success);
    socket.once('error', failure);
    socket.once('close', closed);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

function openSocket(createSocket, certificates, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return createSocket(certificates);
    }).then(socket => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) socket.destroy();
      else resolve(socket);
    }, error => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });
  });
}

export class IntermediateCertificates {
  constructor({ download = downloadIssuer } = {}) {
    this.download = download;
    this.cache = new Map();
  }

  async connect(createSocket, { cacheKey, signal, timeoutMs = 15000 } = {}) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(Object.assign(
      new Error('TLS certificate discovery timeout'), { code: 'ETIMEDOUT' }
    )), timeoutMs) : null;
    timer?.unref?.();
    const cached = this.cache.get(cacheKey);
    const intermediates = cached?.expires > Date.now() ? [...cached.certificates] : [];
    const visited = new Set();
    try {
      for (let attempt = 0; attempt <= MAX_ISSUERS; attempt++) {
        controller.signal.throwIfAborted();
        try {
          const socket = await openSocket(createSocket, intermediates, controller.signal);
          if (controller.signal.aborted) {
            socket.destroy();
            controller.signal.throwIfAborted();
          }
          const verified = await waitForHandshake(socket, controller.signal);
          if (intermediates.length && verified.authorized) {
            this.cache.delete(cacheKey);
            this.cache.set(cacheKey, { certificates: intermediates, expires: Date.now() + CACHE_TTL });
            if (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value);
          }
          return verified;
        } catch (error) {
          if (!CHAIN_ERRORS.has(error.code) || attempt === MAX_ISSUERS) throw error;
          let issuer = null;
          for (const child of error.peerChain || []) {
            for (const match of (child.infoAccess || '').matchAll(/^CA Issuers - URI:(.+)$/gm)) {
              const location = match[1];
              if (visited.has(location) || visited.size >= MAX_ISSUERS) continue;
              visited.add(location);
              try {
                const candidate = new X509Certificate(await this.download(location, controller.signal));
                // Downloaded certificates are chain-building material, never new
                // trust anchors. OpenSSL must still reach an existing trusted root.
                if (candidate.ca && !candidate.verify(candidate.publicKey) &&
                    child.checkIssued(candidate) && child.verify(candidate.publicKey) &&
                    !intermediates.includes(candidate.toString())) {
                  issuer = candidate.toString();
                  break;
                }
              } catch { /* Preserve the original TLS failure if discovery fails. */ }
            }
            if (issuer) break;
          }
          controller.signal.throwIfAborted();
          if (!issuer) throw error;
          intermediates.push(issuer);
        }
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
}
