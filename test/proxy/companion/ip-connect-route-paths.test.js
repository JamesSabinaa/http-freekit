import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { LOGICAL_HOST, fixture, securedTunnel, h1Request, h2Session, h2Request } from './ip-connect-fixture.js';

const paths = [
  { label: 'H1', mode: 'disabled', h2: false, clientH2: false },
  { label: 'H1 on H2 ingress', mode: 'all', h2: false, clientH2: false },
  { label: 'H2', mode: 'h2-only', h2: true, clientH2: true },
  { label: 'H2 to H1 fallback', mode: 'h2-only', h2: false, clientH2: true }
];

test('bound H2 rejects conflicting regular Host and invalid targets before HTTP capture or egress', { timeout: 20000 }, async t => {
  const context = await fixture(t, { h2: true, dnsOnly: true });
  const client = await h2Session(t, context);
  const authority = `${LOGICAL_HOST}:${context.originPort}`;
  for (const [headers, status] of [
    [{ host: `other.example.invalid:${context.originPort}` }, 421],
    [{ ':path': '/path#fragment' }, 400],
    [{ ':path': '*', ':method': 'GET' }, 400]
  ]) await t.test(JSON.stringify(headers), async () => {
    try {
      assert.equal((await h2Request(client, authority, 'https', headers)).status, status);
    } catch (error) {
      // nghttp2 can reject invalid field combinations before the stream event.
      assert.equal(error.code, 'ERR_HTTP2_STREAM_ERROR');
      assert.match(error.message, /NGHTTP2_PROTOCOL_ERROR/);
    }
  });
  assert.equal(context.observed.connections, 0);
  assert.equal(context.events.length, 0);
});

async function request(t, context, clientH2, host = LOGICAL_HOST) {
  const authority = `${host}:${context.originPort}`;
  if (clientH2) return h2Request(await h2Session(t, context, host), authority);
  return h1Request(t, context, authority, host);
}

for (const address of ['127.0.0.1', '::1']) {
  for (const route of paths) {
    test(`${route.label} over ${address} keeps DNS-only TLS identity and original IP`, { timeout: 20000 }, async t => {
      const context = await fixture(t, { ...route, address, dnsOnly: true });
      assert.equal((await request(t, context, route.clientH2)).status, 200);
      assert.equal(context.observed.requests[0].host || context.observed.requests[0].authority, `${LOGICAL_HOST}:${context.originPort}`);
      assert.ok(context.observed.serverNames.every(name => name === LOGICAL_HOST));
      assert.equal(context.observed.dnsRetargets, 0);
    });
  }
}

for (const h2 of [false, true]) {
  for (const failure of ['wrong name', 'untrusted CA']) {
    test(`bound ${h2 ? 'H2' : 'H1'} still rejects ${failure}`, { timeout: 20000 }, async t => {
      const context = await fixture(t, { h2, dnsOnly: true,
        ...(failure === 'wrong name' ? { certificateName: 'wrong.example.invalid' } : { trust: false }) });
      assert.equal((await request(t, context, h2)).status, 502);
      assert.equal(context.observed.requests.length, 0);
      assert.equal(context.observed.dnsRetargets, 0);
      assert.ok([...context.events.map(event => event.errorCode), ...context.observed.h2ProbeErrors.map(error => error.code)]
        .some(code => /CERT|ISSUER|SIGNATURE/.test(code || '')));
    });
  }
}

for (const mode of ['disabled', 'all']) {
  test(`bound ${mode} H1 rejects malformed targets and ambiguous Host before egress`, { timeout: 20000 }, async t => {
    const context = await fixture(t, { mode, dnsOnly: true });
    const authority = `${LOGICAL_HOST}:${context.originPort}`;
    for (const [target, headers, status] of [
      ['/', `Host: ${authority}\r\nHost: ${authority}`, 400],
      ['/', 'X-No-Host: yes', 400],
      ['/', `Host: ${LOGICAL_HOST}:0`, 421],
      ['/', `Host: ${authority}:`, 421],
      ['/', `Host: other.example.invalid:${context.originPort}`, 421],
      ['https://other.example.invalid/', `Host: ${authority}`, 400],
      ['@other.example.invalid/', `Host: ${authority}`, 400],
      ['/path#fragment', `Host: ${authority}`, 400]
    ]) {
      const response = await h1Request(t, context, authority, LOGICAL_HOST,
        `GET ${target} HTTP/1.1\r\n${headers}\r\nConnection: close\r\n\r\n`);
      assert.equal(response.status, status, `${target} / ${headers}`);
    }
    assert.equal(context.observed.connections, 0);
    assert.ok(context.events.every(event => event.protocol === 'tunnel'), 'Parser-level rejection may retain raw tunnel metadata, but must not reach HTTP capture');
  });

  test(`bound secure WebSocket uses logical Host/SNI and original IP in ${mode} mode`, { timeout: 20000 }, async t => {
    const context = await fixture(t, { mode, dnsOnly: true });
    context.origin.on('upgrade', (req, socket) => {
      context.observed.upgrades.push(req.headers.host);
      const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.end(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    });
    const authority = `${LOGICAL_HOST}:${context.originPort}`;
    const socket = await securedTunnel(t, context, LOGICAL_HOST, 'http/1.1');
    const response = once(socket, 'data');
    socket.write(`GET /socket HTTP/1.1\r\nHost: ${authority}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    assert.match((await response)[0].toString(), /^HTTP\/1.1 101 /);
    assert.deepEqual(context.observed.upgrades, [authority]);
    assert.ok(context.observed.serverNames.every(name => name === LOGICAL_HOST));
    assert.equal(context.observed.dnsRetargets, 0);
    const conflicting = await securedTunnel(t, context, LOGICAL_HOST, 'http/1.1');
    const rejected = once(conflicting, 'data');
    const before = context.observed.connections;
    conflicting.write(`GET /socket HTTP/1.1\r\nHost: other.example.invalid:${context.originPort}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
    assert.match((await rejected)[0].toString(), /^HTTP\/1.1 421 /);
    assert.equal(context.observed.connections, before);
  });
}

for (const route of paths) {
  test(`${route.label} preserves binding through transforms, forwards and both breakpoints`, { timeout: 30000 }, async t => {
    const context = await fixture(t, { ...route, dnsOnly: true });
    const origin = `https://${LOGICAL_HOST}:${context.originPort}`;
    for (const [label, action] of [
      ['request transform', { type: 'transform-request', urlMode: 'modify', urlReplace: '/rewritten', methodMode: 'POST', headersMode: 'update', headers: { host: 'hostile.invalid', 'x-bound-rule': 'yes' } }],
      ['response transform', { type: 'transform-request', resHeadersMode: 'update', resHeaders: { 'x-bound-response': 'yes' } }],
      ['same-origin forward', { type: 'forward', forwardTo: origin }],
      ['request/response breakpoints', { type: 'breakpoint-request-response' }]
    ]) {
      await t.test(label, async () => {
        context.proxy.mockRules = [{ enabled: true, matchers: [], action }];
        context.proxy.onBreakpoint = event => setImmediate(() => context.proxy.resumeBreakpoint(event.requestId,
          event.phase === 'response' ? { status: 201 } : { url: `${origin}/breakpoint`, headers: { host: 'hostile.invalid' } }));
        assert.equal((await request(t, context, route.clientH2)).status, label.includes('breakpoints') ? 201 : 200);
        const observed = context.observed.requests.at(-1);
        assert.equal(observed.host || observed.authority, `${LOGICAL_HOST}:${context.originPort}`);
        if (label === 'request transform') {
          assert.equal(observed.path, '/rewritten');
          assert.equal(observed.method, 'POST');
          assert.equal(observed.headers['x-bound-rule'], 'yes');
        }
        if (label.includes('breakpoints')) assert.equal(observed.path, '/breakpoint');
        assert.equal(context.observed.dnsRetargets, 0);
      });
    }
    assert.ok(context.observed.serverNames.every(name => name === LOGICAL_HOST));
  });
}

test('normal DNS CONNECT retains its existing authority coercion behavior', { timeout: 20000 }, async t => {
  const context = await fixture(t, { certificateName: 'localhost' });
  const response = await h1Request(t, { ...context, address: 'localhost' }, 'unrelated.example.invalid', LOGICAL_HOST);
  assert.equal(response.status, 200);
  assert.equal(context.observed.requests[0].host, `localhost:${context.originPort}`);
  assert.ok(context.observed.serverNames.every(name => name === 'localhost'));
  assert.equal(context.observed.dnsRetargets, 0);
});

for (const h2 of [false, true]) {
  test(`${h2 ? 'H2' : 'H1'} pools separate physical IPs and logical TLS identities`, { timeout: 20000 }, async t => {
    const context = await fixture(t, { h2, certificateName: '*.example.invalid' });
    await context.listenAlias('127.0.0.2');
    for (const [address, host] of [
      ['127.0.0.1', LOGICAL_HOST], ['127.0.0.2', LOGICAL_HOST], ['127.0.0.1', 'other.example.invalid'], ['127.0.0.1', LOGICAL_HOST]
    ]) assert.equal((await request(t, { ...context, address }, h2, host)).status, 200);
    assert.deepEqual(context.observed.requests.map(req => req.address), ['127.0.0.1', '127.0.0.2', '127.0.0.1', '127.0.0.1']);
    assert.deepEqual(context.observed.requests.map(req => req.host || req.authority), [LOGICAL_HOST, LOGICAL_HOST, 'other.example.invalid', LOGICAL_HOST].map(host => `${host}:${context.originPort}`));
    assert.equal(context.observed.handshakes, 3, 'The fourth request should reuse only its own identity/physical route');
    assert.equal(context.observed.dnsRetargets, 0);
  });
}

for (const route of paths) {
  test(`${route.label} explicit cross-origin rules drop only that request's binding`, { timeout: 20000 }, async t => {
    const context = await fixture(t, { ...route, dnsOnly: true });
    const alternate = http.createServer((req, res) => res.end(`alternate:${req.headers.host}`));
    alternate.listen(0, '127.0.0.1');
    await once(alternate, 'listening');
    t.after(() => new Promise(resolve => alternate.close(resolve)));
    const destination = `http://127.0.0.1:${alternate.address().port}/cross-origin`;
    for (const action of [
      { type: 'transform-request', urlMode: 'modify', urlReplace: destination },
      { type: 'forward', forwardTo: destination }
    ]) {
      context.proxy.mockRules = [{ enabled: true, matchers: [], action }];
      const response = await request(t, context, route.clientH2);
      assert.equal(response.status, 200);
      assert.match(response.body || response.wire, /alternate:127\.0\.0\.1:/);
    }
    assert.equal(context.observed.requests.length, 0);
    context.proxy.mockRules = [];
    assert.equal((await request(t, context, route.clientH2)).status, 200);
    assert.equal(context.observed.requests.length, 1);
    assert.equal(context.observed.dnsRetargets, 0);
  });
}
