import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

import {
  createMcpLaunchConfig,
  removeMcpRuntimeDescriptor,
  writeMcpRuntimeDescriptor
} from '../src/mcp/launch-config.js';
import { McpServerBridge } from '../src/mcp/mcp-server.js';
import { readRuntimeDescriptor } from '../src/mcp/stdio-bridge.js';

const require = createRequire(import.meta.url);
const { resolveDesktopMcpExecutable } = require('../electron/mcp-launch.cjs');
const builderConfig = require('../electron-builder.config.cjs');
const repoRoot = process.cwd();

function jsonLineReader(stream) {
  const queued = [];
  const waiting = [];
  let buffer = '';
  stream.on('data', chunk => {
    buffer += chunk.toString('utf8');
    while (buffer.includes('\n')) {
      const newline = buffer.indexOf('\n');
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = waiting.shift();
      if (waiter) waiter.resolve(message);
      else queued.push(message);
    }
  });
  return () => {
    if (queued.length) return Promise.resolve(queued.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for bridged MCP output')), 5000);
      waiting.push({
        resolve(message) {
          clearTimeout(timer);
          resolve(message);
        }
      });
    });
  };
}

test('source MCP config uses an absolute Node bridge command from any working directory', () => {
  const bridgeScript = path.join(repoRoot, 'src', 'mcp', 'stdio-bridge.js');
  const descriptorPath = path.join(repoRoot, 'data', 'mcp-runtime.json');
  const config = createMcpLaunchConfig({
    executablePath: process.execPath,
    bridgeScript,
    descriptorPath
  });

  assert.equal(path.isAbsolute(config.command), true);
  assert.equal(path.isAbsolute(config.args[0]), true);
  assert.equal(path.isAbsolute(config.args[1]), true);
  assert.equal(fs.existsSync(config.command), true);
  assert.equal(fs.existsSync(config.args[0]), true);
  assert.deepEqual(config.args, [bridgeScript, descriptorPath]);
  assert.equal(config.env, undefined);
});

test('packaged MCP config uses Electron as Node with an unpacked bridge script', () => {
  const installedAppImage = path.join(repoRoot, 'fixtures', 'HTTP-FreeKit.AppImage');
  const mountedElectron = path.join(repoRoot, 'fixtures', '.mount', 'http-freekit');
  const bridgeScript = path.join(repoRoot, 'resources', 'app.asar.unpacked', 'src', 'mcp', 'stdio-bridge.js');
  const descriptorPath = path.join(repoRoot, 'user-data', 'mcp-runtime.json');
  const executablePath = resolveDesktopMcpExecutable({
    platform: 'linux',
    execPath: mountedElectron,
    appImage: installedAppImage,
    isPackaged: true
  });
  const config = createMcpLaunchConfig({
    executablePath,
    bridgeScript,
    descriptorPath,
    electronRuntime: true
  });

  assert.equal(config.command, installedAppImage);
  assert.deepEqual(config.args, [bridgeScript, descriptorPath]);
  assert.deepEqual(config.env, { ELECTRON_RUN_AS_NODE: '1' });
  assert.ok(builderConfig.asarUnpack.includes('src/**/*'));
  assert.ok(builderConfig.asarUnpack.includes('node_modules/**/*'));
});

test('runtime descriptor keeps authentication outside the displayed config and cleans up by owner', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-mcp-launch-'));
  const descriptorPath = path.join(directory, 'runtime.json');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = createMcpLaunchConfig({
    executablePath: process.execPath,
    bridgeScript: path.join(repoRoot, 'src', 'mcp', 'stdio-bridge.js'),
    descriptorPath
  });

  writeMcpRuntimeDescriptor({
    descriptorPath,
    sseUrl: 'http://127.0.0.1:49152/mcp/sse',
    authToken: 'desktop-secret',
    instanceId: 'current-instance'
  });

  assert.doesNotMatch(JSON.stringify(config), /desktop-secret|AUTH_TOKEN|authToken/);
  assert.equal(readRuntimeDescriptor(descriptorPath).authToken, 'desktop-secret');
  removeMcpRuntimeDescriptor(descriptorPath, 'old-instance');
  assert.equal(fs.existsSync(descriptorPath), true);
  removeMcpRuntimeDescriptor(descriptorPath, 'current-instance');
  assert.equal(fs.existsSync(descriptorPath), false);
});

test('stdio bridge relays Claude requests to the active authenticated traffic server', async t => {
  const authToken = 'runtime-only-secret';
  const apiServer = {
    trafficLog: [],
    _broadcast() {},
    _isAllowedBrowserOrigin: () => true,
    _isAuthorizedRequest: request => request.get('authorization') === `Bearer ${authToken}`
  };
  const bridge = new McpServerBridge({
    apiServer,
    proxyServer: { getStats: () => ({}), mockRules: [], breakpointRules: [] },
    interceptorManager: { getAll: async () => [] }
  });
  const app = express();
  app.use(express.json());
  bridge.startSse(app);
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-mcp-bridge-'));
  const descriptorPath = path.join(directory, 'runtime.json');
  writeMcpRuntimeDescriptor({
    descriptorPath,
    sseUrl: `http://127.0.0.1:${server.address().port}/mcp/sse`,
    authToken,
    instanceId: 'integration-test'
  });
  const launchConfig = createMcpLaunchConfig({
    executablePath: process.execPath,
    bridgeScript: path.join(repoRoot, 'src', 'mcp', 'stdio-bridge.js'),
    descriptorPath
  });
  assert.doesNotMatch(JSON.stringify(launchConfig), new RegExp(authToken));
  const child = spawn(launchConfig.command, launchConfig.args, {
    cwd: os.tmpdir(),
    env: { ...process.env, ...(launchConfig.env || {}) },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
  t.after(async () => {
    child.kill();
    await bridge.stop();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const nextMessage = jsonLineReader(child.stdout);
  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'bridge-test', version: '1.0.0' }
    }
  }) + '\n');
  const initialized = await nextMessage();
  assert.equal(initialized.id, 1, stderr);
  assert.equal(initialized.result.serverInfo.name, 'http-freekit');

  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0',
    method: 'notifications/initialized'
  }) + '\n');
  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {}
  }) + '\n');
  const tools = await nextMessage();
  assert.equal(tools.id, 2, stderr);
  assert.ok(tools.result.tools.some(tool => tool.name === 'search_traffic'));
});

test('MCP status exposes only the supplied secret-free launch configuration', () => {
  const launchConfig = createMcpLaunchConfig({
    executablePath: process.execPath,
    bridgeScript: path.join(repoRoot, 'src', 'mcp', 'stdio-bridge.js'),
    descriptorPath: path.join(repoRoot, 'data', 'mcp-runtime.json')
  });
  const bridge = new McpServerBridge({
    apiServer: { trafficLog: [], _broadcast() {} },
    proxyServer: { getStats: () => ({}), mockRules: [], breakpointRules: [] },
    interceptorManager: { getAll: async () => [] },
    options: { launchConfig }
  });

  assert.deepEqual(bridge.getStatus().claudeDesktopConfig, launchConfig);
  assert.doesNotMatch(JSON.stringify(bridge.getStatus().claudeDesktopConfig), /AUTH_TOKEN|authToken/i);
});

test('renderer formats runtime launch metadata instead of hard-coded relative commands', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'src', 'ui', 'app.js'), 'utf8');
  const start = source.indexOf('async function loadMcpStatus');
  const end = source.indexOf('async function toggleMcp', start);
  const statusSource = source.slice(start, end);

  assert.match(statusSource, /data\.claudeDesktopConfig/);
  assert.doesNotMatch(statusSource, /command:\s*['"]node['"]/);
  assert.doesNotMatch(statusSource, /args:\s*\[['"]src\/index\.js/);
});
