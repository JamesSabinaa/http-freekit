import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { JvmInterceptor } from '../src/interceptors/jvm-interceptor.js';

const expectedFallback = port =>
  `-Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=${port} -Dhttp.nonProxyHosts= ` +
  `-Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=${port}`;

test('generated JVM agent clears and exactly restores HTTP non-proxy hosts', () => {
  const interceptor = new JvmInterceptor();
  const source = interceptor._getAgentSource();
  const proxyProperties = source.match(/PROXY_PROPERTIES = \{([\s\S]*?)\};/)?.[1] || '';

  assert.match(proxyProperties, /"http\.nonProxyHosts"/);
  assert.doesNotMatch(proxyProperties, /"https\.nonProxyHosts"/);
  assert.match(source, /if \(!configured\) \{[\s\S]*originalProperties\.put\(property, System\.getProperty\(property\)\)/);
  assert.match(source, /String value = values\.get\(property\);[\s\S]*System\.setProperty\(property, value\)/);
  assert.match(source, /if \(originalValue == null\) \{\s*System\.clearProperty\(property\)/);
  assert.match(source, /else \{\s*System\.setProperty\(property, originalValue\)/);
  assert.match(source, /originalProperties\.clear\(\)/);
  assert.match(source, /configured = false/);

  const activationArgs = interceptor._getAgentArgs('127.0.0.1', 8123).split(',');
  assert.ok(activationArgs.includes('http.nonProxyHosts='));
  assert.equal(activationArgs.some(value => value.startsWith('https.nonProxyHosts=')), false);
  assert.equal(
    interceptor._getAgentArgs(null, null, 'deactivate'),
    'freekit.action=deactivate'
  );
});

test('JVM fallback metadata includes the localhost override in every backend path', async () => {
  const interceptor = new JvmInterceptor();
  interceptor._getRunningProcesses = async () => [];

  const selection = await interceptor.activate(8123);
  assert.equal(selection.success, true);
  assert.equal(selection.metadata.fallbackCommand, expectedFallback(8123));
  assert.doesNotMatch(selection.metadata.fallbackCommand, /https\.nonProxyHosts/);

  const failed = new JvmInterceptor();
  failed._getRunningProcesses = async () => [{
    pid: '123',
    name: 'Example',
    mainClass: 'example.Main'
  }];
  failed._attachAgent = async () => ({ success: false, error: 'attach denied' });
  const result = await failed.activate(9000, { pid: '123' });

  assert.equal(result.success, false);
  assert.equal(result.metadata.fallbackCommand, expectedFallback(9000));
  assert.match(result.error, new RegExp(expectedFallback(9000).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(result.error, /https\.nonProxyHosts/);
});

test('JVM UI copy command matches the backend fallback flags', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
  const start = source.indexOf('function renderJvmConfig(');
  const end = source.indexOf('async function activateJvmProcess(', start);
  assert.ok(start >= 0 && end > start);

  const container = { innerHTML: '' };
  const context = {
    expandedInterceptorMetadata: { processes: [], activatedProcesses: [] },
    config: { proxyPort: 8123 },
    esc: value => String(value ?? '')
  };
  vm.createContext(context);
  vm.runInContext(`
    ${source.slice(start, end)}
    globalThis.renderJvm = renderJvmConfig;
  `, context);

  context.renderJvm(container);
  const displayedCommand = container.innerHTML.match(
    /class="config-code-block"[^>]*>([^<]+)<\/div>/
  )?.[1];
  assert.equal(displayedCommand, expectedFallback(8123));
  assert.doesNotMatch(displayedCommand, /https\.nonProxyHosts/);

  const backendCommand = new JvmInterceptor()._getFallbackCommand('127.0.0.1', 8123);
  context.expandedInterceptorMetadata = {
    processes: [],
    activatedProcesses: [],
    fallbackCommand: backendCommand
  };
  context.renderJvm(container);
  assert.match(container.innerHTML, new RegExp(backendCommand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
