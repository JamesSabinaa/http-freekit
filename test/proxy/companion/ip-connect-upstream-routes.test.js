import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import test from 'node:test';
import forge from 'node-forge';
import { IntermediateCertificates } from '../../../src/proxy/intermediate-certificates.js';
import { LOGICAL_HOST, fixture, h1Request, h2Session, h2Request, securedTunnel } from './ip-connect-fixture.js';

async function upstream(t, type, ca = null) {
  const destinations = [];
  const sockets = new Set();
  const track = socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); return socket; };
  const pipe = (client, hostname, port, head = Buffer.alloc(0), socks = false) => {
    destinations.push({ hostname, port });
    const target = track(net.connect(port, hostname));
    target.once('connect', () => {
      client.write(socks ? Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]) : 'HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) target.write(head);
      client.pipe(target).pipe(client);
    });
    target.on('error', () => client.destroy());
    client.on('error', () => target.destroy());
    client.once('close', () => target.destroy());
  };
  const material = type === 'https' ? await ca.generateCertForHost('127.0.0.1') : null;
  const server = type === 'https' ? https.createServer({ key: material.key, cert: material.cert })
    : type === 'http' ? http.createServer() : net.createServer();
  server.on('connection', track);
  if (type === 'http' || type === 'https') {
    server.on('connect', (req, client, head) => {
      const url = new URL(`https://${req.url}`);
      pipe(client, url.hostname.replace(/^\[|\]$/g, ''), Number(url.port) || 443, head);
    });
  } else {
    server.on('connection', async client => {
      const read = async size => {
        let chunk;
        while (!(chunk = client.read(size))) await once(client, 'readable');
        return chunk;
      };
      try {
        const hello = await read(2);
        assert.equal(hello[0], 5);
        await read(hello[1]);
        client.write(Buffer.from([5, 0]));
        const command = await read(4);
        assert.equal(command[1], 1);
        let hostname;
        if (command[3] === 1) hostname = [...await read(4)].join('.');
        else if (command[3] === 3) hostname = (await read((await read(1))[0])).toString();
        else throw new Error('This controlled SOCKS fixture accepts IPv4 or DNS destinations only');
        pipe(client, hostname, (await read(2)).readUInt16BE(), Buffer.alloc(0), true);
      } catch (error) { client.destroy(error); }
    });
  }
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return { destinations, config: { type, host: '127.0.0.1', port: server.address().port } };
}

for (const type of ['http', 'https', 'socks5h']) {
  test(`no-SNI IP identity remains verified through the ${type} upstream`, { timeout: 20000 }, async t => {
    const context = await fixture(t);
    const relay = await upstream(t, type, context.ca);
    context.proxy.setUpstreamProxy(relay.config);
    const authority = `127.0.0.1:${context.originPort}`;
    const response = await h1Request(t, context, authority, null);
    assert.equal(response.status, 200);
    assert.equal(context.observed.requests[0].host, authority);
    assert.ok(context.observed.serverNames.every(name => name === null));
    assert.deepEqual(relay.destinations, [{ hostname: '127.0.0.1', port: context.originPort }]);
  });
  test(`no-SNI ${type} upstream rejects a localhost certificate for an IP destination`, { timeout: 20000 }, async t => {
    const context = await fixture(t, { certificateName: 'localhost' });
    const relay = await upstream(t, type, context.ca);
    context.proxy.setUpstreamProxy(relay.config);
    const response = await h1Request(t, context, `127.0.0.1:${context.originPort}`, null);
    assert.equal(response.status, 502);
    assert.equal(context.observed.requests.length, 0);
    assert.ok(context.events.some(event => event.errorCode === 'ERR_TLS_CERT_ALTNAME_INVALID'));
    assert.deepEqual(relay.destinations, [{ hostname: '127.0.0.1', port: context.originPort }]);
  });
}

for (const type of ['http', 'https', 'socks5h']) {
  for (const clientH2 of [false, true]) {
    for (const buffered of [false, true]) {
      test(`${type} upstream preserves IP destination and logical ${clientH2 ? 'H2' : 'H1'} identity, buffered=${buffered}`, { timeout: 20000 }, async t => {
        const context = await fixture(t, { h2: clientH2, dnsOnly: true });
        const relay = await upstream(t, type, context.ca);
        context.proxy.setUpstreamProxy(relay.config);
        if (buffered) context.proxy.mockRules = [{ enabled: true, matchers: [], action: {
          type: 'transform-request', resHeadersMode: 'update', resHeaders: { 'x-buffered': 'yes' }
        } }];
        const authority = `${LOGICAL_HOST}:${context.originPort}`;
        const response = clientH2
          ? await h2Request(await h2Session(t, context), authority)
          : await h1Request(t, context, authority);
        assert.equal(response.status, 200);
        assert.deepEqual(relay.destinations, [{ hostname: '127.0.0.1', port: context.originPort }]);
        assert.equal(context.observed.requests[0].authority || context.observed.requests[0].host, authority);
        if (clientH2) assert.equal(context.observed.requests[0].authority, authority, 'Configured upstream transport must retain native H2');
        assert.ok(context.observed.serverNames.every(name => name === LOGICAL_HOST));
        assert.equal(context.observed.dnsRetargets, 0);
      });
    }
  }
}

for (const clientH2 of [false, true]) {
  test(`configured bypass policy uses the physical IP for bound ${clientH2 ? 'H2' : 'H1'}`, { timeout: 20000 }, async t => {
    const context = await fixture(t, { h2: clientH2, dnsOnly: true });
    const relay = await upstream(t, 'http');
    const authority = `${LOGICAL_HOST}:${context.originPort}`;
    const request = async () => clientH2
      ? h2Request(await h2Session(t, context), authority)
      : h1Request(t, context, authority);
    context.proxy.setUpstreamProxy({ ...relay.config, noProxy: ['127.0.0.1'] });
    assert.equal((await request()).status, 200);
    assert.equal(relay.destinations.length, 0);
    context.proxy.setUpstreamProxy({ ...relay.config, noProxy: [LOGICAL_HOST] });
    assert.equal((await request()).status, 200);
    assert.ok(relay.destinations.length > 0, 'SNI must not change the physical destination bypass policy');
    assert.ok(relay.destinations.every(destination => destination.hostname === '127.0.0.1'));
  });
}

for (const clientH2 of [false, true]) {
  for (const action of [null, { type: 'transform-request', resHeadersMode: 'update', resHeaders: { 'x-buffered': 'yes' } }, 'forward']) {
    test(`bound ${clientH2 ? 'H2' : 'H1'} keeps its route after upstream rotation, action=${action?.type || action || 'stream'}`, { timeout: 20000 }, async t => {
      const context = await fixture(t, { mode: clientH2 ? 'h2-only' : 'disabled', dnsOnly: true });
      const first = await upstream(t, 'http');
      const second = await upstream(t, 'http');
      context.origin.removeAllListeners('request');
      const hosts = [];
      context.origin.on('request', (req, res) => {
        hosts.push(req.headers.host);
        req.resume();
        res.writeHead(hosts.length === 1 ? 410 : 200);
        res.end(hosts.length === 1 ? 'rotate' : 'rotated-ok');
      });
      context.proxy.setUpstreamProxy(first.config);
      let rotations = 0;
      context.proxy.onUpstreamProxyRetry = async () => {
        rotations++;
        context.proxy.setUpstreamProxy(second.config);
        return true;
      };
      const authority = `${LOGICAL_HOST}:${context.originPort}`;
      if (action) context.proxy.mockRules = [{ enabled: true, matchers: [], action: action === 'forward'
        ? { type: 'forward', forwardTo: `https://${authority}` } : action }];
      const response = clientH2
        ? await h2Request(await h2Session(t, context), authority)
        : await h1Request(t, context, authority);
      assert.equal(response.status, 200);
      assert.match(response.body || response.wire, /rotated-ok/);
      assert.equal(rotations, 1);
      assert.deepEqual(hosts, [authority, authority]);
      assert.ok(first.destinations.length > 0 && second.destinations.length > 0);
      assert.ok([...first.destinations, ...second.destinations].every(destination => destination.hostname === '127.0.0.1' && destination.port === context.originPort));
      assert.ok(context.observed.serverNames.every(name => name === LOGICAL_HOST));
      assert.equal(context.observed.dnsRetargets, 0);
    });
  }
}

for (const clientH2 of [false, true]) {
  test(`bound ${clientH2 ? 'H2' : 'H1'} H2 CANCEL fallback preserves the IP and logical identity`, { timeout: 20000 }, async t => {
    const context = await fixture(t, { h2: true, dnsOnly: true, mode: clientH2 ? 'h2-only' : 'disabled' });
    const authorities = [];
    context.origin.removeAllListeners('stream');
    context.origin.on('stream', (stream, headers) => {
      authorities.push(headers[':authority']);
      stream.close(8); // NGHTTP2_CANCEL before the response starts
    });
    const authority = `${LOGICAL_HOST}:${context.originPort}`;
    const response = clientH2
      ? await h2Request(await h2Session(t, context), authority)
      : await h1Request(t, context, authority);
    assert.equal(response.status, 200);
    assert.deepEqual(authorities, [authority]);
    assert.equal(context.observed.requests[0].host, authority);
    assert.equal(context.observed.dnsRetargets, 0);
  });
}

test('bound H2 POST is not replayed through H1 after upstream cancellation', { timeout: 20000 }, async t => {
  const context = await fixture(t, { h2: true, dnsOnly: true });
  let attempts = 0;
  context.origin.removeAllListeners('stream');
  context.origin.on('stream', stream => { attempts++; stream.close(8); });
  const response = await h2Request(await h2Session(t, context), `${LOGICAL_HOST}:${context.originPort}`, 'https', { ':method': 'POST' });
  assert.equal(response.status, 502);
  assert.equal(attempts, 1);
  assert.equal(context.observed.requests.length, 0);
  assert.equal(context.observed.dnsRetargets, 0);
});

for (const clientH2 of [false, true]) {
  test(`missing-intermediate recovery retains bound ${clientH2 ? 'H2' : 'H1'} identity and proxy route`, { timeout: 20000 }, async t => {
    const context = await fixture(t, { h2: clientH2, dnsOnly: true });
    const relay = await upstream(t, 'http');
    context.proxy.setUpstreamProxy(relay.config);
    const issuerKeys = forge.pki.rsa.generateKeyPair(2048);
    const issuer = forge.pki.createCertificate();
    issuer.publicKey = issuerKeys.publicKey;
    issuer.serialNumber = '0a';
    issuer.validity.notBefore = new Date(Date.now() - 60000);
    issuer.validity.notAfter = new Date(Date.now() + 86400000);
    issuer.setSubject([{ name: 'commonName', value: 'Controlled missing issuer' }]);
    issuer.setIssuer(context.ca.caCert.subject.attributes);
    issuer.setExtensions([
      { name: 'basicConstraints', cA: true, critical: true },
      { name: 'keyUsage', keyCertSign: true, digitalSignature: true, critical: true }
    ]);
    issuer.sign(context.ca.caKey, forge.md.sha256.create());
    const material = await context.ca.generateCertForHost(LOGICAL_HOST);
    const leaf = forge.pki.certificateFromPem(material.cert);
    leaf.setIssuer(issuer.subject.attributes);
    const { asn1 } = forge;
    leaf.setExtensions([...leaf.extensions, {
      id: '1.3.6.1.5.5.7.1.1',
      value: asn1.toDer(asn1.create(0, 16, true, [asn1.create(0, 16, true, [
        asn1.create(0, 6, false, asn1.oidToDer('1.3.6.1.5.5.7.48.2').getBytes()),
        asn1.create(asn1.Class.CONTEXT_SPECIFIC, 6, false, 'http://controlled-issuer.invalid/intermediate')
      ])])).getBytes()
    }]);
    leaf.sign(issuerKeys.privateKey, forge.md.sha256.create());
    context.origin.setSecureContext({ key: material.key, cert: forge.pki.certificateToPem(leaf) });
    const fetched = [];
    context.proxy._intermediateCertificates = new IntermediateCertificates({ download: async url => {
      fetched.push(url);
      return Buffer.from(asn1.toDer(forge.pki.certificateToAsn1(issuer)).getBytes(), 'binary');
    } });
    const authority = `${LOGICAL_HOST}:${context.originPort}`;
    for (let index = 0; index < 2; index++) {
      const response = clientH2
        ? await h2Request(await h2Session(t, context), authority)
        : await h1Request(t, context, authority);
      assert.equal(response.status, 200);
    }
    assert.deepEqual(fetched, ['http://controlled-issuer.invalid/intermediate']);
    assert.equal(context.observed.requests.length, 2);
    assert.ok(context.observed.requests.every(req => (req.authority || req.host) === authority));
    assert.ok(relay.destinations.length >= 2, 'Recovery must create a new verified tunnel rather than send on the rejected TLS socket');
    assert.ok(relay.destinations.every(destination => destination.hostname === '127.0.0.1' && destination.port === context.originPort));
    assert.equal(context.observed.dnsRetargets, 0);
  });
}

// Read one fixture response without closing the intercepted CONNECT socket.
async function keepAliveRequest(socket, authority) {
  let bytes = Buffer.alloc(0);
  return new Promise((resolve, reject) => {
    const cleanup = () => { socket.off('data', data); socket.off('error', reject); };
    const data = chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      const boundary = bytes.indexOf('\r\n\r\n');
      if (boundary < 0) return;
      const header = bytes.subarray(0, boundary).toString();
      const length = Number(header.match(/\r\ncontent-length:\s*(\d+)/i)?.[1]);
      if (!Number.isInteger(length) || bytes.length < boundary + 4 + length) return;
      cleanup();
      resolve(bytes.toString());
    };
    socket.on('data', data);
    socket.once('error', reject);
    socket.write(`GET /keep-alive HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  });
}

for (const mode of ['disabled', 'all']) {
  test(`${mode} keep-alive binding survives a cross-origin rule and the next request`, { timeout: 20000 }, async t => {
    const context = await fixture(t, { mode, dnsOnly: true });
    const alternate = http.createServer((_req, res) => res.end('alternate'));
    alternate.listen(0, '127.0.0.1');
    await once(alternate, 'listening');
    t.after(() => new Promise(resolve => alternate.close(resolve)));
    const socket = await securedTunnel(t, context, LOGICAL_HOST, 'http/1.1');
    const authority = `${LOGICAL_HOST}:${context.originPort}`;
    assert.match(await keepAliveRequest(socket, authority), /original-ip-origin/);
    context.proxy.mockRules = [{ enabled: true, matchers: [], action: {
      type: 'transform-request', urlMode: 'modify', urlReplace: `http://127.0.0.1:${alternate.address().port}/rewritten`
    } }];
    assert.match(await keepAliveRequest(socket, authority), /alternate/);
    context.proxy.mockRules = [];
    assert.match(await keepAliveRequest(socket, authority), /original-ip-origin/);
    assert.equal(context.observed.requests.length, 2);
    assert.ok(context.observed.requests.every(req => req.host === authority));
    assert.equal(context.observed.dnsRetargets, 0);
  });
}

for (const clientH2 of [false, true]) {
  test(`native TLS fingerprint retains bound ${clientH2 ? 'H2' : 'H1'} identity and physical route`, { timeout: 20000 }, async t => {
    const context = await fixture(t, { h2: clientH2, dnsOnly: true, fingerprint: 'passthrough' });
    const authority = `${LOGICAL_HOST}:${context.originPort}`;
    const response = clientH2
      ? await h2Request(await h2Session(t, context), authority)
      : await h1Request(t, context, authority);
    assert.equal(response.status, 200);
    assert.equal(context.observed.requests[0].authority || context.observed.requests[0].host, authority);
    assert.ok(context.observed.serverNames.every(name => name === LOGICAL_HOST));
    assert.equal(context.observed.dnsRetargets, 0);
  });
}
