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

function readInstalledPackage(name) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'));
}

function versionParts(version) {
  return String(version).split(/[.-]/).slice(0, 3).map(part => Number.parseInt(part, 10) || 0);
}

function assertVersionAtLeast(name, minimum) {
  const actual = readInstalledPackage(name).version;
  const actualParts = versionParts(actual);
  const minimumParts = versionParts(minimum);
  for (let i = 0; i < 3; i++) {
    if (actualParts[i] > minimumParts[i]) return;
    if (actualParts[i] < minimumParts[i]) {
      assert.fail(`${name} ${actual} is below the safe minimum ${minimum}`);
    }
  }
}

test('installed packages meet the audited safe minimums', () => {
  const minimumVersions = {
    '@hono/node-server': '2.0.5',
    'body-parser': '2.3.0',
    'dompurify': '3.4.12',
    'fast-uri': '3.1.4',
    'hono': '4.12.27',
    'js-yaml': '4.3.0',
    'monaco-editor': '0.56.0',
    'protobufjs': '8.7.1',
    'sharp': '0.35.3'
  };

  for (const [name, minimum] of Object.entries(minimumVersions)) {
    assertVersionAtLeast(name, minimum);
  }
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
