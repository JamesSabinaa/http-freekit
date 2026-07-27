import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import express from 'express';
import protobuf from 'protobufjs';
import sharp from 'sharp';
import { McpServerBridge } from '../src/mcp/mcp-server.js';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageLock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));

function versionParts(version) {
  return String(version).split(/[.-]/).slice(0, 3).map(part => Number.parseInt(part, 10) || 0);
}

function isVersionAtLeast(actualVersion, minimumVersion) {
  const actual = versionParts(actualVersion);
  const minimum = versionParts(minimumVersion);
  for (let i = 0; i < 3; i++) {
    if (actual[i] > minimum[i]) return true;
    if (actual[i] < minimum[i]) return false;
  }
  return true;
}

function assertVersionAtLeast(name, minimum) {
  const packageSuffix = `node_modules/${name}`;
  const rootPackage = packageLock.packages[packageSuffix];
  const matches = rootPackage
    ? [[packageSuffix, rootPackage]]
    : Object.entries(packageLock.packages)
      .filter(([packagePath]) => packagePath.endsWith(`/${packageSuffix}`));
  assert.ok(matches.length > 0, `${name} is missing from the dependency lockfile`);
  for (const [, packageData] of matches) {
    assert.ok(
      isVersionAtLeast(packageData.version, minimum),
      `${name} ${packageData.version} is below the safe minimum ${minimum}`
    );
  }
}

test('locked packages meet the audited safe minimums', () => {
  const minimumVersions = {
    '@electron/asar': '4.2.1',
    '@electron/universal': '3.0.6',
    '@hono/node-server': '2.0.12',
    'app-builder-lib': '26.15.0',
    'body-parser': '2.3.0',
    'brace-expansion': '5.0.8',
    'builder-util-runtime': '9.7.0',
    'dompurify': '3.4.12',
    'electron': '43.2.0',
    'electron-builder': '26.15.7',
    'fast-uri': '3.1.4',
    'hono': '4.12.27',
    'https-proxy-agent': '9.1.0',
    'jake': '12.10.1',
    'js-yaml': '4.3.0',
    'monaco-editor': '0.56.0',
    'pako': '3.0.1',
    'protobufjs': '8.7.1',
    'sharp': '0.35.3',
    'socks-proxy-agent': '10.1.0',
    'uuid': '14.0.1',
    'ws': '8.21.1'
  };

  for (const [name, minimum] of Object.entries(minimumVersions)) {
    assertVersionAtLeast(name, minimum);
  }
});

test('the complete dependency graph excludes vulnerable brace expansion releases', () => {
  const bracePackages = Object.entries(packageLock.packages)
    .filter(([packagePath]) => packagePath.endsWith('node_modules/brace-expansion'));

  assert.ok(bracePackages.length > 0, 'Expected brace-expansion in the dependency graph');
  for (const [packagePath, packageData] of bracePackages) {
    assert.ok(
      isVersionAtLeast(packageData.version, '5.0.8'),
      `${packagePath} resolved vulnerable brace-expansion ${packageData.version}`
    );
  }

  const squirrelPackages = Object.keys(packageLock.packages)
    .filter(packagePath => packagePath.endsWith('node_modules/electron-builder-squirrel-windows'));
  assert.deepEqual(squirrelPackages, [], 'Unused Squirrel.Windows tooling should not be installed');
});

test('electron-updater uses a credential-safe builder runtime', () => {
  const updaterPath = require.resolve('electron-updater/package.json');
  const updaterRequire = createRequire(updaterPath);
  const runtimePath = updaterRequire.resolve('builder-util-runtime/package.json');
  const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));

  const actual = versionParts(runtime.version);
  const minimum = versionParts('9.7.0');
  assert.ok(
    actual[0] > minimum[0]
      || (actual[0] === minimum[0] && actual[1] > minimum[1])
      || (actual[0] === minimum[0] && actual[1] === minimum[1] && actual[2] >= minimum[2]),
    `electron-updater resolved vulnerable builder-util-runtime ${runtime.version}`
  );
});

test('updated Monaco and protobuf browser bundles are present', () => {
  const expectedAssets = [
    'node_modules/monaco-editor/min/vs/loader.js',
    'node_modules/monaco-editor/min/vs/editor/editor.main.js',
    'node_modules/protobufjs/dist/protobuf.min.js'
  ];
  for (const asset of expectedAssets) {
    assert.equal(fs.existsSync(path.join(repoRoot, asset)), true, `Missing browser asset: ${asset}`);
  }
});

test('protobuf parser and codec complete a schema round trip', () => {
  const root = protobuf.parse('syntax = "proto3"; message Ping { string value = 1; }').root;
  const Ping = root.lookupType('Ping');
  const decoded = Ping.decode(Ping.encode({ value: 'ok' }).finish());
  assert.equal(decoded.value, 'ok');
});

test('updated Sharp build dependency renders an image', async () => {
  const { data, info } = await sharp({
    create: {
      width: 1,
      height: 1,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  }).png().toBuffer({ resolveWithObject: true });

  assert.ok(data.length > 0);
  assert.equal(info.width, 1);
  assert.equal(info.height, 1);
  assert.equal(info.format, 'png');
});

test('MCP AJV stack validates URIs with the patched fast-uri dependency', () => {
  const sdkRequire = createRequire(require.resolve('@modelcontextprotocol/sdk/package.json'));
  const Ajv = sdkRequire('ajv');
  const addFormats = sdkRequire('ajv-formats');
  const ajv = new Ajv();
  addFormats(ajv);
  const validate = ajv.compile({ type: 'string', format: 'uri' });

  assert.equal(validate('https://example.com/path'), true);
  assert.equal(validate('not a URI'), false);
});

test('patched js-yaml dependency parses nested release configuration', () => {
  const yaml = require('js-yaml');
  assert.deepEqual(yaml.load('release:\n  enabled: true'), { release: { enabled: true } });
});

test('MCP SSE bridge initializes with the patched dependency stack', async () => {
  const bridge = new McpServerBridge({
    apiServer: { trafficLog: [], _broadcast() {} },
    proxyServer: { getStats: () => ({}), mockRules: [], breakpointRules: [] },
    interceptorManager: { getAll: async () => [] }
  });
  bridge.startSse(express());

  assert.ok(bridge.server);
  assert.equal(bridge.sseRoutesRegistered, true);
  await bridge.stop();
});

test('overridden Hono Node adapter serves a request', async (t) => {
  const app = new Hono();
  app.get('/health', c => c.json({ ok: true }));
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  t.after(() => new Promise(resolve => server.close(resolve)));
  if (!server.listening) await once(server, 'listening');

  const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});
