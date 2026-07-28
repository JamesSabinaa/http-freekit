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
const {
  MCP_STDIO_BRIDGE_FLAG,
  findMcpStdioDescriptor,
  resolveBundledMcpBridgeScript,
  resolveDesktopMcpExecutable
} = require('../electron/mcp-launch.cjs');
const builderConfig = require('../electron-builder.config.cjs');
const electronPath = require('electron');
const packageJson = require('../package.json');
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

function waitForChildExit(child, timeout = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      reject(new Error('Timed out waiting for the MCP bridge child to exit'));
    }, timeout);
    const onExit = (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    child.once('exit', onExit);
  });
}

async function waitForCondition(predicate, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
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

test('development Electron keeps direct bridge-script Node mode', () => {
  const bridgeScript = path.join(repoRoot, 'src', 'mcp', 'stdio-bridge.js');
  const descriptorPath = path.join(repoRoot, 'data', 'mcp-runtime.json');
  const config = createMcpLaunchConfig({
    executablePath: process.execPath,
    bridgeScript,
    descriptorPath,
    electronRuntime: true
  });

  assert.deepEqual(config.args, [bridgeScript, descriptorPath]);
  assert.deepEqual(config.env, { ELECTRON_RUN_AS_NODE: '1' });
});

test('stable packaged Electron uses direct Node mode for clean stdio framing', () => {
  const bridgeScript = path.join(repoRoot, 'src', 'mcp', 'stdio-bridge.js');
  const descriptorPath = path.join(repoRoot, 'data', 'mcp-runtime.json');
  const config = createMcpLaunchConfig({
    executablePath: electronPath,
    bridgeScript,
    descriptorPath,
    electronRuntime: true,
    packagedAppRuntime: true
  });

  assert.deepEqual(config, {
    command: electronPath,
    args: [bridgeScript, descriptorPath],
    env: { ELECTRON_RUN_AS_NODE: '1' }
  });
});

test('packaged MCP config re-enters the stable application across AppImage remounts', () => {
  const installedAppImage = path.join(repoRoot, 'fixtures', 'HTTP-FreeKit.AppImage');
  const firstMount = path.join(repoRoot, 'fixtures', '.mount-first');
  const secondMount = path.join(repoRoot, 'fixtures', '.mount-second');
  const mountedElectron = path.join(firstMount, 'http-freekit');
  const descriptorPath = path.join(repoRoot, 'user-data', 'mcp-runtime.json');
  const executablePath = resolveDesktopMcpExecutable({
    platform: 'linux',
    execPath: mountedElectron,
    appImage: installedAppImage,
    isPackaged: true
  });
  const firstConfig = createMcpLaunchConfig({
    executablePath,
    bridgeScript: path.join(firstMount, 'resources', 'app.asar.unpacked', 'src', 'mcp', 'stdio-bridge.js'),
    descriptorPath,
    electronRuntime: true,
    packagedAppRuntime: true,
    remountingPackagedApp: true
  });
  const secondConfig = createMcpLaunchConfig({
    executablePath,
    bridgeScript: path.join(secondMount, 'resources', 'app.asar.unpacked', 'src', 'mcp', 'stdio-bridge.js'),
    descriptorPath,
    electronRuntime: true,
    packagedAppRuntime: true,
    remountingPackagedApp: true
  });

  assert.deepEqual(firstConfig, secondConfig);
  assert.equal(firstConfig.command, installedAppImage);
  assert.deepEqual(firstConfig.args, [MCP_STDIO_BRIDGE_FLAG, descriptorPath]);
  assert.equal(firstConfig.env, undefined);
  assert.doesNotMatch(JSON.stringify(firstConfig), /\.mount-(?:first|second)/);
  assert.equal(packageJson.main, 'electron/bootstrap.cjs');
  assert.ok(builderConfig.asarUnpack.includes('src/**/*'));
  assert.ok(builderConfig.asarUnpack.includes('node_modules/**/*'));

  const mainSource = fs.readFileSync(path.join(repoRoot, 'electron', 'main.cjs'), 'utf8');
  const indexSource = fs.readFileSync(path.join(repoRoot, 'src', 'index.js'), 'utf8');
  assert.match(mainSource, /HTTP_FREEKIT_MCP_PACKAGED_APP: app\.isPackaged \? '1' : '0'/);
  assert.match(mainSource, /HTTP_FREEKIT_MCP_REMOUNTING_APP: app\.isPackaged && process\.platform === 'linux' && process\.env\.APPIMAGE \? '1' : '0'/);
  assert.match(indexSource, /packagedAppRuntime: process\.env\.HTTP_FREEKIT_MCP_PACKAGED_APP === '1'/);
  assert.match(indexSource, /remountingPackagedApp: process\.env\.HTTP_FREEKIT_MCP_REMOUNTING_APP === '1'/);
});

test('application bootstrap resolves the bridge from each current package mount', () => {
  const firstAppDir = path.join(repoRoot, 'fixtures', '.mount-first', 'resources', 'app.asar', 'electron');
  const secondAppDir = path.join(repoRoot, 'fixtures', '.mount-second', 'resources', 'app.asar', 'electron');

  const firstBridge = resolveBundledMcpBridgeScript(firstAppDir);
  const secondBridge = resolveBundledMcpBridgeScript(secondAppDir);
  assert.match(firstBridge, /\.mount-first/);
  assert.match(secondBridge, /\.mount-second/);
  assert.match(firstBridge, /app\.asar\.unpacked[\\/]src[\\/]mcp[\\/]stdio-bridge\.js$/);
  assert.match(secondBridge, /app\.asar\.unpacked[\\/]src[\\/]mcp[\\/]stdio-bridge\.js$/);
  assert.equal(findMcpStdioDescriptor(['app', MCP_STDIO_BRIDGE_FLAG, '/stable/runtime.json']), '/stable/runtime.json');
  assert.equal(findMcpStdioDescriptor(['app']), null);
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

test('packaged Electron relays Claude requests without leading non-protocol stdout', async t => {
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
    executablePath: electronPath,
    bridgeScript: path.join(repoRoot, 'src', 'mcp', 'stdio-bridge.js'),
    descriptorPath,
    electronRuntime: true,
    packagedAppRuntime: true
  });
  assert.doesNotMatch(JSON.stringify(launchConfig), new RegExp(authToken));
  const child = spawn(launchConfig.command, launchConfig.args, {
    cwd: os.tmpdir(),
    env: { ...process.env, ...(launchConfig.env || {}) },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
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
  assert.equal(stdout[0], '{', `Unexpected leading stdout bytes: ${Buffer.from(stdout).toString('hex')}`);

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

  const exited = waitForChildExit(child);
  child.stdin.end();
  assert.deepEqual(await exited, { code: 0, signal: null }, stderr);
  await waitForCondition(
    () => bridge.sseSessions.size === 0,
    'Authenticated SSE session remained after the stdio client disconnected'
  );
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
