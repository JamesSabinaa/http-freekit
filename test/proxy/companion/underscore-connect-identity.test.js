import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, h1Request, h2Request, h2Session } from './ip-connect-fixture.js';

const hostname = 'cdn_test.example.invalid';
for (const [name, mode, h2] of [['H1', 'disabled', false], ['H2', 'h2-only', true], ['H1-on-H2', 'all', false]]) {
  test(`underscore CDN identity preserves IP egress and authority binding through ${name}`, { timeout: 20000 }, async t => {
    const context = await fixture(t, { h2, mode, dnsOnly: true, certificateName: hostname });
    const authority = `${hostname}:${context.originPort}`;
    const client = h2 ? await h2Session(t, context, hostname) : null;
    const result = h2 ? await h2Request(client, authority) : await h1Request(t, context, authority, hostname);
    assert.equal(result.status, 200);
    assert.equal(context.observed.requests.length, 1);
    assert.equal(context.observed.requests[0].host || context.observed.requests[0].authority, authority);
    assert.equal(context.observed.dnsRetargets, 0);
    assert.ok(context.observed.serverNames.includes(hostname));
    const wrongAuthority = `other_cdn.example.invalid:${context.originPort}`;
    const rejected = h2 ? await h2Request(client, wrongAuthority) : await h1Request(t, context, wrongAuthority, hostname);
    assert.equal(rejected.status, 421);
    assert.equal(context.observed.requests.length, 1, 'a different authority must not reach the origin');
  });
}
