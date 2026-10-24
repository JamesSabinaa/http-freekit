import assert from 'node:assert/strict';
import test from 'node:test';
import { LOGICAL_HOST, fixture, h1Request, h2Session, h2Request } from './ip-connect-fixture.js';

test('IP CONNECT authenticates a DNS-only upstream identity without resolving it', { timeout: 20000 }, async t => {
  const context = await fixture(t, { dnsOnly: true });
  const response = await h1Request(t, context, `${LOGICAL_HOST}:${context.originPort}`);
  assert.equal(response.status, 200);
  assert.equal(context.observed.requests.length, 1);
  assert.ok(context.observed.serverNames.every(name => name === LOGICAL_HOST));
  assert.ok(context.observed.connections > 0, 'The original IP was dialed');
  assert.equal(context.observed.dnsRetargets, 0);
});

test('H1 preserves the bound logical Host and rejects conflicts before egress', { timeout: 20000 }, async t => {
  const context = await fixture(t);
  const authority = `${LOGICAL_HOST}:${context.originPort}`;
  assert.equal((await h1Request(t, context, authority)).status, 200);
  const before = context.observed.connections;
  assert.equal((await h1Request(t, context, `other.example.invalid:${context.originPort}`)).status, 421);
  assert.deepEqual(context.observed.requests.map(request => request.host), [authority]);
  assert.equal(context.observed.connections, before);
  assert.ok(context.observed.serverNames.every(name => name === LOGICAL_HOST));
  assert.equal(context.observed.dnsRetargets, 0);
});

test('H2 accepts the bound logical authority and rejects hostile mismatches before egress', { timeout: 20000 }, async t => {
  const context = await fixture(t, { h2: true, dnsOnly: true });
  const client = await h2Session(t, context);
  const authority = `${LOGICAL_HOST}:${context.originPort}`;
  assert.deepEqual(await h2Request(client, authority), { status: 200, body: 'original-ip-origin' });
  const before = context.observed.connections;
  const eventCount = context.events.length;
  for (const [value, scheme] of [
    [`other.example.invalid:${context.originPort}`, 'https'],
    [`${LOGICAL_HOST}:${context.originPort + 1}`, 'https'],
    [authority, 'http']
  ]) assert.deepEqual(await h2Request(client, value, scheme), { status: 421, body: 'Misdirected Request' });
  assert.equal(context.observed.connections, before);
  assert.equal(context.events.length, eventCount);
  assert.equal(context.observed.requests[0].authority, authority);
  assert.ok(context.observed.serverNames.every(name => name === LOGICAL_HOST));
  assert.equal(context.observed.dnsRetargets, 0);
});

for (const h2 of [false, true]) {
  test(`IP CONNECT without SNI retains its existing ${h2 ? 'H2 authority' : 'H1 Host'} fallback`, { timeout: 20000 }, async t => {
    const context = await fixture(t, { h2 });
    const authority = `127.0.0.1:${context.originPort}`;
    if (h2) {
      const client = await h2Session(t, context, null);
      assert.deepEqual(await h2Request(client, authority), { status: 200, body: 'original-ip-origin' });
      assert.equal(context.observed.requests[0].authority, authority);
    } else {
      const response = await h1Request(t, context, authority, null);
      assert.equal(response.status, 200);
      assert.match(response.wire, /original-ip-origin/);
      assert.equal(context.observed.requests[0].host, authority);
    }
    assert.equal(context.observed.dnsRetargets, 0);
  });
}
