import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  getProtocolRegistrationWarning,
  registerDefaultProtocolClient
} = require('../../electron/protocol-registration.cjs');

test('packaged protocol registration reports a false OS result with recovery guidance', () => {
  const calls = [];
  const result = registerDefaultProtocolClient({
    app: {
      setAsDefaultProtocolClient: (...args) => {
        calls.push(args);
        return false;
      }
    },
    scheme: 'http-freekit',
    execPath: process.execPath
  });

  assert.deepEqual(calls, [['http-freekit']]);
  assert.equal(result.registered, false);
  assert.equal(result.development, false);
  const warning = getProtocolRegistrationWarning(result, 'http-freekit');
  assert.match(warning.message, /could not register http-freekit: links/);
  assert.match(warning.detail, /Default Apps settings/);
});

test('development protocol registration preserves the executable and entry-point arguments', () => {
  const calls = [];
  const entryPoint = path.join('relative', 'electron', 'main.cjs');
  const result = registerDefaultProtocolClient({
    app: {
      setAsDefaultProtocolClient: (...args) => {
        calls.push(args);
        return true;
      }
    },
    scheme: 'http-freekit',
    defaultApp: true,
    execPath: process.execPath,
    argv: [process.execPath, entryPoint]
  });

  assert.deepEqual(calls, [[
    'http-freekit',
    process.execPath,
    [path.resolve(entryPoint)]
  ]]);
  assert.equal(result.registered, true);
  assert.equal(result.development, true);
});

test('a thrown protocol-registration error is non-fatal and remains actionable', () => {
  const result = registerDefaultProtocolClient({
    app: {
      setAsDefaultProtocolClient: () => { throw new Error('registry unavailable'); }
    },
    scheme: 'http-freekit',
    execPath: process.execPath
  });

  assert.equal(result.registered, false);
  assert.match(result.error, /registry unavailable/);
  assert.match(
    getProtocolRegistrationWarning(result, 'http-freekit').detail,
    /Reinstall the packaged application/
  );
});
