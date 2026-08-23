import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import {
  DEFAULT_HTTP2_MODE,
  restoreSavedHttp2Setting
} from '../../src/proxy/http2-config.js';
import { ProxyServer } from '../../src/proxy/proxy-server.js';

const startupSource = fs.readFileSync(new URL('../../src/index.js', import.meta.url), 'utf8');
const restoreStart = startupSource.indexOf('// Restore saved proxy settings');
const restoreEnd = startupSource.indexOf('// 5. Initialize API Server', restoreStart);
assert.ok(restoreStart >= 0 && restoreEnd > restoreStart, 'startup proxy restore block must exist');
const startupRestoreSource = startupSource.slice(restoreStart, restoreEnd);

test('runtime HTTP/2 configuration rejects unsupported modes without changing state', t => {
  t.mock.method(console, 'log', () => {});
  const proxy = new ProxyServer(null);
  proxy.setHttp2Config('all');

  for (const value of ['legacy', '', null, false, ['all']]) {
    assert.throws(
      () => proxy.setHttp2Config(value),
      error => error?.code === 'ERR_INVALID_HTTP2_MODE'
    );
    assert.equal(proxy.http2Enabled, 'all');
  }
});

test('startup normalizes invalid saved HTTP/2 modes with a diagnostic', t => {
  t.mock.method(console, 'log', () => {});
  const errors = [];
  const logger = { error: message => errors.push(message) };

  for (const value of ['legacy', '', null, false, ['all']]) {
    const proxy = new ProxyServer(null);
    proxy.setHttp2Config('all');
    const settings = { get: () => value };

    assert.equal(restoreSavedHttp2Setting(proxy, settings, logger), false);
    assert.equal(proxy.http2Enabled, DEFAULT_HTTP2_MODE);
  }

  assert.equal(errors.length, 5);
  assert.ok(errors.every(error => /Invalid saved HTTP\/2 mode; using disabled/.test(error)));
});

test('startup restores supported HTTP/2 modes and ignores an absent setting', t => {
  t.mock.method(console, 'log', () => {});
  const proxy = new ProxyServer(null);

  assert.equal(restoreSavedHttp2Setting(proxy, { get: () => undefined }), false);
  assert.equal(proxy.http2Enabled, DEFAULT_HTTP2_MODE);
  assert.equal(restoreSavedHttp2Setting(proxy, { get: () => 'h2-only' }), true);
  assert.equal(proxy.http2Enabled, 'h2-only');
});

test('application startup routes the saved HTTP/2 mode through validated restoration', t => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const proxy = new ProxyServer(null);
  proxy.setHttp2Config('all');
  const settingsReads = [];
  const settings = {
    get(key) {
      settingsReads.push(key);
      return key === 'http2Enabled' ? 'unsupported-startup-mode' : undefined;
    }
  };
  const noop = () => {};

  vm.runInNewContext(startupRestoreSource, {
    proxy,
    settings,
    restoreSavedHttp2Setting,
    restoreUpstreamProxySetting: noop,
    restoreSavedTlsMaterialSettings: noop,
    restoreHttpsWhitelistSetting: noop,
    restoreSavedTlsFingerprintSetting: noop,
    restoreSavedRuleSettings: noop,
    restoreSavedApiSpecs: noop
  });

  assert.ok(settingsReads.includes('http2Enabled'));
  assert.equal(proxy.http2Enabled, DEFAULT_HTTP2_MODE);
});
