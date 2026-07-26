import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import express from 'express';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { CertificateAuthority } from './proxy/certificate-authority.js';
import { ProxyServer } from './proxy/proxy-server.js';
import { ApiServer } from './api/api-server.js';
import { InterceptorManager } from './interceptors/interceptor-manager.js';
import { McpServerBridge } from './mcp/mcp-server.js';
import {
  createMcpLaunchConfig,
  removeMcpRuntimeDescriptor,
  writeMcpRuntimeDescriptor
} from './mcp/launch-config.js';
import { Settings } from './settings.js';
import { resolveProxyPortRange } from './proxy/port-range.js';
import { restoreUpstreamProxySetting } from './proxy/upstream-proxy-config.js';
import { startWithValidatedApiPort } from './startup-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
// When running inside Electron, use a writable user data path for CA certs
const DATA_DIR = process.env.ELECTRON
  ? path.join(process.env.APPDATA || process.env.HOME || __dirname, 'http-freekit', 'data')
  : path.join(__dirname, '..', 'data');
const UI_DIR = path.join(__dirname, 'ui');
const MCP_STDIO_ENABLED = process.argv.includes('--mcp-stdio');
const MCP_RUNTIME_DESCRIPTOR_PATH = process.env.HTTP_FREEKIT_MCP_DESCRIPTOR_PATH
  || path.join(DATA_DIR, 'mcp-runtime.json');

// Stdio MCP reserves stdout for JSON-RPC framing. Redirect before any startup logs.
if (MCP_STDIO_ENABLED) {
  console.log = (...args) => console.error(...args);
}

async function main() {
  return startWithValidatedApiPort(process.env.API_PORT, initializeApplication);
}

async function initializeApplication(apiPort) {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║          HTTP FreeKit v1.0.0          ║');
  console.log('  ║   HTTP(S) Debugging & Testing Tool    ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');

  // Ensure data directory exists
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // 1. Initialize Certificate Authority
  console.log('[Boot] Initializing Certificate Authority...');
  const ca = new CertificateAuthority(DATA_DIR);
  const certInfo = await ca.initialize();
  console.log(`[Boot] CA certificate: ${certInfo.certPath}`);
  console.log(`[Boot] CA fingerprint: ${certInfo.fingerprint.substring(0, 16)}...`);

  // Install CA cert into OS trust store (Windows) so browsers trust our MITM certs.
  // Uses -f (force) which is a no-op if the identical cert is already present,
  // and replaces it if the cert was regenerated (e.g. after expiry).
  // The cert stays in the store across restarts — we never remove it on shutdown.
  if (process.platform === 'win32') {
    try {
      execSync(`certutil -addstore -user -f Root "${certInfo.certPath}"`, { stdio: 'ignore' });
      ca.systemTrustInstalled = true;
      console.log('[Boot] CA certificate present in Windows user trust store');
    } catch (err) {
      ca.systemTrustInstalled = false;
      console.log('[Boot] Could not install CA cert in trust store (non-critical):', err.message);
    }
  } else {
    ca.systemTrustInstalled = false;
  }

  // 2. Load persistent settings
  const settings = new Settings(DATA_DIR);
  console.log(`[Boot] Settings loaded from ${DATA_DIR}/settings.json`);

  // 3. Initialize Interceptor Manager (pass CA for SPKI fingerprints)
  const interceptors = new InterceptorManager(ca, { dataDir: DATA_DIR });

  // 4. Initialize Proxy Server
  const proxyPortRange = resolveProxyPortRange(settings, process.env.PROXY_PORT);
  const proxyBindHost = process.env.PROXY_BIND_HOST || settings.get('proxyBindHost', '127.0.0.1');
  const rangeLabel = proxyPortRange.minPort === proxyPortRange.maxPort
    ? String(proxyPortRange.minPort)
    : `${proxyPortRange.minPort}-${proxyPortRange.maxPort}`;
  console.log(`[Boot] Starting proxy in port range ${rangeLabel}...`);
  const proxy = new ProxyServer(ca, {
    port: proxyPortRange.minPort,
    bindHost: proxyBindHost,
    ...proxyPortRange,
    onRequest: (data) => {
      api.onTrafficEvent(data);
    }
  });

  // Restore saved proxy settings
  restoreUpstreamProxySetting(proxy, settings);
  const savedTlsPassthrough = settings.get('tlsPassthrough');
  if (savedTlsPassthrough) proxy.setTlsPassthrough(savedTlsPassthrough);
  const savedHttp2 = settings.get('http2Enabled');
  if (savedHttp2) proxy.setHttp2Config(savedHttp2);
  const savedClientCerts = settings.get('clientCertificates');
  if (savedClientCerts) proxy.setClientCertificates(savedClientCerts);
  const savedTrustedCAs = settings.get('trustedCAs');
  if (savedTrustedCAs) proxy.setTrustedCAs(savedTrustedCAs);
  const savedHttpsWhitelist = settings.get('httpsWhitelist');
  if (savedHttpsWhitelist) proxy.setHttpsWhitelist(savedHttpsWhitelist);
  const savedTlsFingerprint = settings.get('tlsFingerprint');
  if (savedTlsFingerprint) proxy.setTlsFingerprint(savedTlsFingerprint);
  const savedMockRules = settings.get('mockRules');
  if (savedMockRules && Array.isArray(savedMockRules) && savedMockRules.length > 0) {
    const restored = proxy.loadMockRules(savedMockRules);
    if (restored.migrated) settings.set('mockRules', restored.rules);
    console.log(`[Boot] Restored ${restored.rules.length} mock rules from settings`);
  }
  const savedBreakpointRules = settings.get('breakpointRules');
  if (savedBreakpointRules !== undefined) {
    const restored = proxy.loadBreakpoints(savedBreakpointRules);
    if (restored.migrated) settings.set('breakpointRules', restored.rules);
    console.log(`[Boot] Restored ${restored.rules.length} breakpoint rules from settings`);
  }

  // 5. Initialize API Server (with UI serving)
  const api = new ApiServer(proxy, ca, interceptors, {
    port: apiPort,
    authToken: process.env.AUTH_TOKEN || null
  });
  api.settings = settings; // Give API server access to persist settings
  proxy.filterSafeFonts = settings.get('filterSafeFonts', false) === true;

  // Serve UI static files (index.html, styles.css, app.js)
  api.app.use(express.static(UI_DIR));

  // Serve Phosphor Icons assets from node_modules
  const PHOSPHOR_DIR = path.join(__dirname, '..', 'node_modules', '@phosphor-icons', 'web', 'src');
  api.app.use('/vendor/phosphor', express.static(PHOSPHOR_DIR));

  // Serve Monaco Editor assets from node_modules
  const MONACO_DIR = path.join(__dirname, '..', 'node_modules', 'monaco-editor', 'min');
  api.app.use('/vendor/monaco', express.static(MONACO_DIR));

  // Serve protobufjs browser bundle for schema-aware protobuf/gRPC body decoding
  const PROTOBUFJS_DIR = path.join(__dirname, '..', 'node_modules', 'protobufjs', 'dist');
  api.app.use('/vendor/protobufjs', express.static(PROTOBUFJS_DIR));

  // Serve pako browser bundle for gzip/deflate gRPC message decompression
  const PAKO_DIR = path.join(__dirname, '..', 'node_modules', 'pako', 'dist', 'browser');
  api.app.use('/vendor/pako', express.static(PAKO_DIR));

  // 5. Start servers
  await proxy.start();
  await api.start();

  // 6. Initialize MCP Server (Model Context Protocol)
  const mcpBridge = new McpServerBridge({
    apiServer: api,
    proxyServer: proxy,
    interceptorManager: interceptors,
    options: {
      enabled: true,
      launchConfig: createMcpLaunchConfig({
        executablePath: process.env.HTTP_FREEKIT_MCP_EXECUTABLE || process.execPath,
        bridgeScript: path.join(__dirname, 'mcp', 'stdio-bridge.js'),
        descriptorPath: MCP_RUNTIME_DESCRIPTOR_PATH,
        electronRuntime: process.env.ELECTRON === '1',
        packagedAppRuntime: process.env.HTTP_FREEKIT_MCP_PACKAGED_APP === '1'
      })
    }
  });
  api.setMcpBridge(mcpBridge);
  mcpBridge.startSse(api.app);
  const mcpRuntimeInstanceId = crypto.randomUUID();
  writeMcpRuntimeDescriptor({
    descriptorPath: MCP_RUNTIME_DESCRIPTOR_PATH,
    sseUrl: `http://127.0.0.1:${apiPort}/mcp/sse`,
    authToken: process.env.AUTH_TOKEN || null,
    instanceId: mcpRuntimeInstanceId
  });
  const removeOwnMcpRuntimeDescriptor = () => {
    removeMcpRuntimeDescriptor(MCP_RUNTIME_DESCRIPTOR_PATH, mcpRuntimeInstanceId);
  };
  process.once('exit', removeOwnMcpRuntimeDescriptor);

  // If launched with --mcp-stdio, enable stdio transport for Claude Desktop
  if (MCP_STDIO_ENABLED) {
    await mcpBridge.startStdio();
  }

  console.log('');
  console.log('  ┌─────────────────────────────────────┐');
  const proxyStr = `http://127.0.0.1:${proxy.port}`;
  const uiStr = `http://127.0.0.1:${apiPort}`;
  const apiStr = `http://127.0.0.1:${apiPort}/api`;
  const mcpStr = `http://127.0.0.1:${apiPort}/mcp/sse`;
  console.log(`  │  Proxy:  ${proxyStr.padEnd(26)}│`);
  console.log(`  │  UI:     ${uiStr.padEnd(26)}│`);
  console.log(`  │  API:    ${apiStr.padEnd(26)}│`);
  console.log(`  │  MCP:    ${mcpStr.padEnd(26)}│`);
  console.log('  └─────────────────────────────────────┘');
  console.log('');
  console.log('  Configure your browser/app to use proxy: 127.0.0.1:' + proxy.port);
  console.log('  Or use the Intercept tab in the UI to launch a pre-configured browser.');
  console.log('');
  console.log('  Press Ctrl+C to stop.');
  console.log('');

  // Graceful shutdown
  let shutdownPromise = null;
  const shutdown = () => {
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
        console.log('\n[Shutdown] Stopping servers...');
        removeOwnMcpRuntimeDescriptor();
        await mcpBridge.stop();
        await interceptors.deactivateAll();
        await proxy.stop();
        await api.stop();
        console.log('[Shutdown] Goodbye!');
        process.exit(0);
      })();
    }
    return shutdownPromise;
  };

  api.setShutdownHandler(shutdown);

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[Fatal]', err);
  process.exit(1);
});
