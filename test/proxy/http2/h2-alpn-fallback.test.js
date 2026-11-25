import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import tls from 'node:tls';

import { CertificateAuthority } from '../../../src/proxy/certificate-authority.js';
import { ProxyServer } from '../../../src/proxy/proxy-server.js';

for (const protocols of [[], ['http/1.1']]) {
  test(`H2 interception falls back to HTTP/1.1 when origin ALPN is ${JSON.stringify(protocols)}`, {
    timeout: 20000
  }, async t => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-alpn-'));
    const ca = new CertificateAuthority(dataDir);
    await ca.initialize();
    const certificate = await ca.generateCertForHost('127.0.0.1');
    const caPem = await readFile(ca.caCertPath);
    let receivedRequests = 0;
    const origin = https.createServer({
      key: certificate.key,
      cert: certificate.cert,
      ALPNProtocols: protocols
    }, (request, response) => {
      receivedRequests++;
      assert.equal(request.url, '/landing');
      assert.equal(request.method, 'POST');
      response.end('landing-ok');
    });
    origin.listen(0, '127.0.0.1');
    await once(origin, 'listening');

    const proxy = new ProxyServer(ca, { port: 0 });
    proxy.setHttp2Config('all');
    proxy.setTlsFingerprint('default');
    proxy.setTrustedCAs([ca.caCertPath]);
    t.after(async () => {
      await proxy.stop();
      origin.closeAllConnections();
      await new Promise(resolve => origin.close(resolve));
      await rm(dataDir, { recursive: true, force: true });
    });
    await proxy.start();

    const authority = `127.0.0.1:${origin.address().port}`;
    const tunnel = net.connect(proxy.server.address().port, '127.0.0.1');
    t.after(() => tunnel.destroy());
    await once(tunnel, 'connect');
    tunnel.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    let connectResponse = '';
    while (!connectResponse.includes('\r\n\r\n')) {
      const [chunk] = await once(tunnel, 'data');
      connectResponse += chunk.toString();
    }
    assert.match(connectResponse, /^HTTP\/1\.1 200 /);
    const socket = tls.connect({
      host: '127.0.0.1',
      socket: tunnel,
      ALPNProtocols: ['h2'],
      ca: caPem
    });
    t.after(() => socket.destroy());
    await once(socket, 'secureConnect');
    const client = http2.connect(`https://${authority}`, { createConnection: () => socket });
    t.after(() => client.destroy());
    const request = client.request({ ':method': 'POST', ':path': '/landing' });
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    const response = once(request, 'response');
    const ended = once(request, 'end');
    request.end();
    const [headers] = await response;
    await ended;
    assert.equal(headers[':status'], 200);
    assert.equal(Buffer.concat(chunks).toString(), 'landing-ok');
    assert.equal(receivedRequests, 1);
    assert.equal(proxy._h2Sessions.size, 0);
    assert.equal(proxy._h2Blacklist.size, 1);
  });
}
