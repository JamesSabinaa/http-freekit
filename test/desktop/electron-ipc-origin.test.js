import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { isAllowedRendererUrl } = require('../../electron/security.cjs');

test('Electron renderer origin validation accepts only the exact local API origin', () => {
  assert.equal(isAllowedRendererUrl('http://127.0.0.1:49152/', 49152), true);
  assert.equal(isAllowedRendererUrl('http://127.0.0.1:49152/settings?tab=tls', 49152), true);

  assert.equal(isAllowedRendererUrl('http://127.0.0.1:49152@remote.example/', 49152), false);
  assert.equal(isAllowedRendererUrl('http://127.0.0.1:49152.evil.example/', 49152), false);
  assert.equal(isAllowedRendererUrl('http://127.0.0.1:49153/', 49152), false);
  assert.equal(isAllowedRendererUrl('https://127.0.0.1:49152/', 49152), false);
  assert.equal(isAllowedRendererUrl('http://user@127.0.0.1:49152/', 49152), false);
  assert.equal(isAllowedRendererUrl('not a URL', 49152), false);
});
