import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import tls from 'node:tls';
import { ProxyServer } from '../src/proxy/proxy-server.js';

test('configured trusted CAs and client PFX files feed outbound TLS options', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-tls-config-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const caPath = path.join(tempDir, 'private-ca.pem');
  const pfxPath = path.join(tempDir, 'client.pfx');
  fs.writeFileSync(caPath, 'TEST PRIVATE CA');
  fs.writeFileSync(pfxPath, Buffer.from([0, 1, 2, 3]));

  const proxy = new ProxyServer(null);
  proxy.setTrustedCAs([caPath]);
  proxy.setClientCertificates([{
    host: 'MTLS.EXAMPLE.TEST.',
    pfxPath,
    passphrase: 'secret'
  }]);

  const matching = proxy._getUpstreamTlsOptions('mtls.example.test');
  assert.deepEqual(matching.pfx, Buffer.from([0, 1, 2, 3]));
  assert.equal(matching.passphrase, 'secret');
  assert.deepEqual(matching.ca.slice(0, tls.rootCertificates.length), tls.rootCertificates);
  assert.equal(matching.ca.at(-1), 'TEST PRIVATE CA');

  const otherHost = proxy._getUpstreamTlsOptions('other.example.test');
  assert.equal(otherHost.pfx, undefined);
  assert.equal(otherHost.passphrase, undefined);
  assert.equal(otherHost.ca.at(-1), 'TEST PRIVATE CA');
});
