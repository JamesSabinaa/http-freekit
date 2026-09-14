import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import tls from 'node:tls';
import { CertificateAuthority } from '../../../src/proxy/certificate-authority.js';
import { ProxyServer } from '../../../src/proxy/proxy-server.js';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function send(proxyPort, originPort, target, nativeH2 = false) {
  const raw = net.connect(proxyPort, '127.0.0.1');
  await once(raw, 'connect');
  raw.write(`CONNECT 127.0.0.1:${originPort} HTTP/1.1\r\nHost: 127.0.0.1:${originPort}\r\n\r\n`);
  let head = '';
  while (!head.includes('\r\n\r\n')) head += (await once(raw, 'data'))[0].toString();
  assert.match(head, /^HTTP\/1.1 200 /);
  const socket = tls.connect({ socket: raw, ALPNProtocols: [nativeH2 ? 'h2' : 'http/1.1'], rejectUnauthorized: false });
  await once(socket, 'secureConnect');
  if (nativeH2) {
    const client = http2.connect(`https://127.0.0.1:${originPort}`, { createConnection: () => socket });
    try {
      await once(client, 'connect');
      const req = client.request({ ':method': 'OPTIONS', ':path': target });
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      const headers = once(req, 'response');
      const ended = once(req, 'end');
      req.end();
      const [responseHeaders] = await headers;
      await ended;
      return { headers: responseHeaders, body: Buffer.concat(chunks).toString() };
    } finally {
      client.destroy();
    }
  }
  const chunks = [];
  socket.on('data', chunk => chunks.push(chunk));
  const ended = once(socket, 'end');
  socket.write(`OPTIONS ${target} HTTP/1.1\r\nHost: 127.0.0.1:${originPort}\r\nConnection: close\r\n\r\n`);
  await ended;
  socket.destroy();
  return Buffer.concat(chunks).toString();
}

test('TLS OPTIONS preserves the asterisk target across streaming and buffered H1/H2 routing', { timeout: 30000 }, async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-asterisk-'));
  const ca = new CertificateAuthority(dataDir);
  await ca.initialize();
  const cert = await ca.generateCertForHost('127.0.0.1');
  const respond = (req, res) => {
    const body = `${req.method} ${req.url}`;
    res.writeHead(200, { 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };
  const h1 = https.createServer({ key: cert.key, cert: cert.cert }, respond);
  const h2 = http2.createSecureServer({ key: cert.key, cert: cert.cert, allowHTTP1: true }, respond);
  const ports = [await listen(h1), await listen(h2)];
  const captures = [];
  const proxy = new ProxyServer(ca, { port: 0, onRequest: event => captures.push(event) });
  proxy.setHttpsWhitelist(['127.0.0.1']);
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await Promise.all([h1, h2].map(server => new Promise(resolve => server.close(resolve))));
    await rm(dataDir, { recursive: true, force: true });
  });
  for (const mode of ['disabled', 'all', 'h2-only']) {
    proxy.setHttp2Config(mode);
    for (const [index, port] of ports.entries()) {
      for (const buffered of [false, true]) {
        await t.test(`${mode}, origin ${index + 1}, ${buffered ? 'response transform' : 'streaming'}`, async () => {
          proxy.mockRules = buffered ? [{ enabled: true, matchers: [], action: {
            type: 'transform-request', resHeadersMode: 'update', resHeaders: { 'x-edited': 'yes' }
          } }] : [];
          const response = await send(proxy.server.address().port, port, '*', mode === 'h2-only');
          if (mode === 'h2-only') {
            assert.equal(response.headers[':status'], 200);
            assert.equal(response.body, 'OPTIONS *');
            if (buffered) assert.equal(response.headers['x-edited'], 'yes');
          } else {
            assert.match(response, /^HTTP\/1.1 200 /);
            assert.match(response, /\r\nOPTIONS \*(?:\r\n|$)/);
            if (buffered) assert.match(response, /x-edited: yes/i);
          }
          assert.equal(captures.at(-1).path, '*');
          assert.equal(new URL(captures.at(-1).url).port, String(port));
        });
      }
    }
    proxy.mockRules = [];
    if (mode === 'h2-only') {
      assert.equal((await send(proxy.server.address().port, ports[0], '/healthy', true)).headers[':status'], 200);
    } else {
      assert.match(await send(proxy.server.address().port, ports[0], 'bad-target'), /^HTTP\/1.1 400 /);
      assert.match(await send(proxy.server.address().port, ports[0], '/healthy'), /^HTTP\/1.1 200 /);
    }
  }
});
