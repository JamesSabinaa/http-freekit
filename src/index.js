import path from 'path';
import fs from 'fs';
import express from 'express';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { CertificateAuthority } from './proxy/certificate-authority.js';
import { ProxyServer } from './proxy/proxy-server.js';
import { ApiServer } from './api/api-server.js';
import { InterceptorManager } from './interceptors/interceptor-manager.js';
import { McpServerBridge } from './mcp/mcp-server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
// When running inside Electron, use a writable user data path for CA certs
const DATA_DIR = process.env.ELECTRON
  ? path.join(process.env.APPDATA || process.env.HOME || __dirname, 'http-freekit', 'data')
  : path.join(__dirname, '..', 'data');
const UI_DIR = path.join(__dirname, 'ui');
const PROXY_PORT = parseInt(process.env.PROXY_PORT) || 8081;
const API_PORT = parseInt(process.env.API_PORT) || 8001;

async function main() {
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
      console.log('[Boot] CA certificate present in Windows user trust store');
    } catch (err) {
      console.log('[Boot] Could not install CA cert in trust store (non-critical):', err.message);
    }
  }

  // 2. Initialize Interceptor Manager (pass CA for SPKI fingerprints)
  const interceptors = new InterceptorManager(ca);

  // 3. Initialize Proxy Server
  console.log(`[Boot] Starting proxy on port ${PROXY_PORT}...`);
  const proxy = new ProxyServer(ca, {
    port: PROXY_PORT,
    onRequest: (data) => {
      api.onTrafficEvent(data);
    }
  });

  // 4. Initialize API Server (with UI serving)
  const api = new ApiServer(proxy, ca, interceptors, { port: API_PORT });

  // Serve UI static files (index.html, styles.css, app.js)
  api.app.use(express.static(UI_DIR));

  // Serve Phosphor Icons assets from node_modules
  const PHOSPHOR_DIR = path.join(__dirname, '..', 'node_modules', '@phosphor-icons', 'web', 'src');
  api.app.use('/vendor/phosphor', express.static(PHOSPHOR_DIR));

  // Serve Monaco Editor assets from node_modules
  const MONACO_DIR = path.join(__dirname, '..', 'node_modules', 'monaco-editor', 'min');
  api.app.use('/vendor/monaco', express.static(MONACO_DIR));

  // 5. Start servers
  await proxy.start();
  await api.start();

  // 6. Initialize MCP Server (Model Context Protocol)
  const mcpBridge = new McpServerBridge({
    apiServer: api,
    proxyServer: proxy,
    interceptorManager: interceptors,
    options: { enabled: true }
  });
  api.setMcpBridge(mcpBridge);
  mcpBridge.startSse(api.app);

  // If launched with --mcp-stdio, enable stdio transport for Claude Desktop
  if (process.argv.includes('--mcp-stdio')) {
    // Redirect console to stderr so stdout is reserved for MCP protocol
    const origLog = console.log;
    console.log = (...args) => process.stderr.write(args.join(' ') + '\n');
    await mcpBridge.startStdio();
  }

  console.log('');
  console.log('  ┌─────────────────────────────────────┐');
  const proxyStr = `http://127.0.0.1:${PROXY_PORT}`;
  const uiStr = `http://127.0.0.1:${API_PORT}`;
  const apiStr = `http://127.0.0.1:${API_PORT}/api`;
  const mcpStr = `http://127.0.0.1:${API_PORT}/mcp/sse`;
  console.log(`  │  Proxy:  ${proxyStr.padEnd(26)}│`);
  console.log(`  │  UI:     ${uiStr.padEnd(26)}│`);
  console.log(`  │  API:    ${apiStr.padEnd(26)}│`);
  console.log(`  │  MCP:    ${mcpStr.padEnd(26)}│`);
  console.log('  └─────────────────────────────────────┘');
  console.log('');
  console.log('  Configure your browser/app to use proxy: 127.0.0.1:' + PROXY_PORT);
  console.log('  Or use the Intercept tab in the UI to launch a pre-configured browser.');
  console.log('');
  console.log('  Press Ctrl+C to stop.');
  console.log('');

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n[Shutdown] Stopping servers...');
    await mcpBridge.stop();
    await interceptors.deactivateAll();
    await proxy.stop();
    await api.stop();
    console.log('[Shutdown] Goodbye!');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[Fatal]', err);
  process.exit(1);
});
