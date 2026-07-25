import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SystemProxyInterceptor } from '../src/interceptors/system-proxy-interceptor.js';

test('system proxy activation journals settings and normal stop removes the journal', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-system-proxy-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const interceptor = new SystemProxyInterceptor({ dataDir });
  interceptor._isWindows = () => true;
  interceptor._readCurrentSettings = () => ({ enabled: true, server: 'corporate.proxy:8888' });
  interceptor._setRegistryValue = () => {};

  await interceptor.activate(8080);

  assert.equal(fs.existsSync(interceptor.recoveryFile), true);
  const recovery = JSON.parse(fs.readFileSync(interceptor.recoveryFile, 'utf8'));
  assert.equal(recovery.pid, process.pid);
  assert.equal(recovery.proxyServer, '127.0.0.1:8080');
  assert.deepEqual(recovery.previousSettings, { enabled: true, server: 'corporate.proxy:8888' });

  await interceptor.deactivate();
  assert.equal(fs.existsSync(interceptor.recoveryFile), false);
});

test('a new process restores a stale system-proxy journal', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-system-proxy-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const recoveryFile = path.join(dataDir, 'system-proxy-recovery.json');
  fs.writeFileSync(recoveryFile, JSON.stringify({
    pid: 1234,
    proxyServer: '127.0.0.1:8080',
    previousSettings: { enabled: true, server: 'corporate.proxy:8888' }
  }));

  const writes = [];
  const interceptor = new SystemProxyInterceptor({ dataDir });
  interceptor._isWindows = () => true;
  interceptor._isProcessRunning = () => false;
  interceptor._setRegistryValue = (...args) => writes.push(args);

  assert.equal(interceptor.recoverStaleSettings(), true);
  assert.deepEqual(writes, [
    ['ProxyServer', 'REG_SZ', 'corporate.proxy:8888'],
    ['ProxyEnable', 'REG_DWORD', 1]
  ]);
  assert.equal(fs.existsSync(recoveryFile), false);
  assert.equal(interceptor.previousSettings, null);
});

test('system-proxy recovery does not interfere with a live owning process', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-system-proxy-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const recoveryFile = path.join(dataDir, 'system-proxy-recovery.json');
  fs.writeFileSync(recoveryFile, JSON.stringify({
    pid: process.pid,
    proxyServer: '127.0.0.1:8080',
    previousSettings: { enabled: false, server: null }
  }));

  const interceptor = new SystemProxyInterceptor({ dataDir });
  interceptor._isWindows = () => true;
  interceptor._setRegistryValue = () => assert.fail('live session must not be restored');

  assert.equal(interceptor.recoverStaleSettings(), false);
  assert.equal(fs.existsSync(recoveryFile), true);
});
