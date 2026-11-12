import assert from 'node:assert/strict';
import test from 'node:test';
import { isSupported } from 'tls-impersonate';
import { ProxyServer } from '../../../src/proxy/proxy-server.js';

function hello(extraExtension = null) {
  return {
    tlsVersion: 0x0303,
    cipherSuites: [0x1301, 0xc02f],
    extensions: [
      { id: 0x000a, data: { groups: [0x001d, 0x0017] } },
      { id: 0x000b, data: { formats: [0] } },
      { id: 0x000d, data: { algorithms: [0x0403, 0x0804] } },
      { id: 0x0010, data: { protocols: ['http/1.1'] } },
      { id: 0xca34 },
      ...(extraExtension ? [{ id: extraExtension }] : [])
    ]
  };
}

test('TLS fidelity limits are reported once across destinations while new limits stay visible', t => {
  if (!isSupported()) return t.skip('native TLS mirroring requires a supported runtime');
  const proxy = new ProxyServer(null);
  t.after(() => proxy._destroyUpstreamAgent());
  const warnings = t.mock.method(console, 'warn', () => {});
  const first = proxy._getUpstreamTlsOptions('first.example.test', hello(), ['http/1.1']);
  assert.ok(first.secureContext, 'native mirroring must succeed for this test');
  assert.equal(warnings.mock.callCount(), 1);
  assert.match(warnings.mock.calls[0].arguments[0], /extension 0xca34/);

  proxy._getUpstreamTlsOptions('second.example.test', hello(), ['http/1.1']);
  proxy._getUpstreamTlsOptions('third.example.test', hello(), ['http/1.1']);
  assert.equal(warnings.mock.callCount(), 1);
  proxy._getUpstreamTlsOptions('third.example.test', hello(0xca35), ['http/1.1']);
  assert.equal(warnings.mock.callCount(), 2);
  assert.match(warnings.mock.calls[1].arguments[0], /extension 0xca35/);
  assert.doesNotMatch(warnings.mock.calls[1].arguments[0], /extension 0xca34/);
});
