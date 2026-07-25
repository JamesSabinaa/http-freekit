import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ProxyServer } from '../src/proxy/proxy-server.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('outbound TLS verifies certificates unless the hostname is whitelisted', () => {
  const proxy = new ProxyServer(null);

  assert.equal(proxy._getUpstreamTlsOptions('api.example.test').rejectUnauthorized, true);

  proxy.setHttpsWhitelist(['API.EXAMPLE.TEST.', '[::1]']);
  assert.equal(proxy._getUpstreamTlsOptions('api.example.test').rejectUnauthorized, false);
  assert.equal(proxy._getUpstreamTlsOptions('::1').rejectUnauthorized, false);
  assert.equal(proxy._getUpstreamTlsOptions('other.example.test').rejectUnauthorized, true);
});

test('outbound request paths do not hard-code disabled certificate verification', () => {
  const proxySource = fs.readFileSync(path.join(repoRoot, 'src/proxy/proxy-server.js'), 'utf8');
  const apiSource = fs.readFileSync(path.join(repoRoot, 'src/api/api-server.js'), 'utf8');

  assert.doesNotMatch(proxySource, /rejectUnauthorized\s*[:=]\s*false/);
  assert.doesNotMatch(apiSource, /rejectUnauthorized:\s*false/);
  assert.match(apiSource, /this\.proxy\._getUpstreamTlsOptions\(parsedUrl\.hostname\)/);
});
