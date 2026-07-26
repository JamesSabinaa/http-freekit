import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

export function readRuntimeDescriptor(descriptorPath) {
  if (!path.isAbsolute(descriptorPath)) throw new Error('MCP runtime descriptor path must be absolute');
  const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
  const url = new URL(descriptor.sseUrl);
  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
  if (url.protocol !== 'http:' || !loopbackHosts.has(url.hostname) ||
      url.pathname !== '/mcp/sse' || url.username || url.password) {
    throw new Error('MCP runtime descriptor must target a loopback HTTP endpoint');
  }
  if (descriptor.authToken !== undefined && typeof descriptor.authToken !== 'string') {
    throw new Error('MCP runtime descriptor contains an invalid auth token');
  }
  return { url, authToken: descriptor.authToken || null };
}

export async function startStdioBridge(descriptorPath, {
  stdin = process.stdin,
  stdout = process.stdout,
  createRemoteTransport = (url, options) => new SSEClientTransport(url, options),
  createStdioTransport = (input, output) => new StdioServerTransport(input, output)
} = {}) {
  const { url, authToken } = readRuntimeDescriptor(descriptorPath);
  const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
  const remote = createRemoteTransport(url, { requestInit: { headers } });
  const stdio = createStdioTransport(stdin, stdout);
  let closing = false;
  let resolveCleanupRequested;
  let resolveClosed;
  const cleanupRequested = new Promise(resolve => { resolveCleanupRequested = resolve; });
  const closed = new Promise(resolve => { resolveClosed = resolve; });

  const relayToStdio = message => {
    if (closing) return;
    void Promise.resolve().then(() => stdio.send(message)).catch(close);
  };
  const relayToRemote = message => {
    if (closing) return;
    void Promise.resolve().then(() => remote.send(message)).catch(close);
  };
  const handleRemoteError = error => { void close(error); };
  const handleStdioError = error => { void close(error); };
  const handleRemoteClose = () => { void close(); };
  const handleInputClose = () => { void close(); };

  const removeOwnedListeners = () => {
    stdin.removeListener('end', handleInputClose);
    stdin.removeListener('close', handleInputClose);
    if (remote.onmessage === relayToStdio) remote.onmessage = undefined;
    if (stdio.onmessage === relayToRemote) stdio.onmessage = undefined;
    if (remote.onerror === handleRemoteError) remote.onerror = undefined;
    if (stdio.onerror === handleStdioError) stdio.onerror = undefined;
    if (remote.onclose === handleRemoteClose) remote.onclose = undefined;
  };

  function close(error) {
    if (closing) return closed;
    closing = true;
    resolveCleanupRequested();
    removeOwnedListeners();
    if (error) console.error('[MCP Bridge]', error.message || String(error));
    if (error && !process.exitCode) process.exitCode = 1;
    void Promise.allSettled([
      Promise.resolve().then(() => remote.close()),
      Promise.resolve().then(() => stdio.close())
    ]).then(transports => {
      resolveClosed(Object.freeze({ error: error || null, transports }));
    });
    return closed;
  }

  remote.onmessage = relayToStdio;
  stdio.onmessage = relayToRemote;
  remote.onerror = handleRemoteError;
  stdio.onerror = handleStdioError;
  remote.onclose = handleRemoteClose;
  stdin.once('end', handleInputClose);
  stdin.once('close', handleInputClose);

  const bridge = { remote, stdio, close };
  Object.defineProperties(bridge, {
    closed: { enumerable: true, value: closed },
    isClosed: { enumerable: true, get: () => closing }
  });

  if (stdin.readableEnded || stdin.destroyed) {
    void close();
    return bridge;
  }

  const startTransport = async transport => {
    if (closing) return false;
    const settled = Promise.resolve().then(() => {
      if (closing) return { cancelled: true };
      return Promise.resolve()
        .then(() => transport.start())
        .then(
          () => ({ started: true }),
          error => ({ started: false, error })
        );
    });
    const outcome = await Promise.race([
      settled,
      cleanupRequested.then(() => null)
    ]);
    if (outcome === null || outcome.cancelled || closing) return false;
    if (!outcome.started) {
      await close(outcome.error);
      throw outcome.error;
    }
    return true;
  };

  if (!await startTransport(remote)) return bridge;
  await startTransport(stdio);
  return bridge;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startStdioBridge(process.argv[2]).catch(err => {
    console.error('[MCP Bridge] Could not connect:', err.message);
    process.exit(1);
  });
}
