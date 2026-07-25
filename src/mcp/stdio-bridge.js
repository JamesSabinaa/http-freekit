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

export async function startStdioBridge(descriptorPath, { stdin = process.stdin, stdout = process.stdout } = {}) {
  const { url, authToken } = readRuntimeDescriptor(descriptorPath);
  const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
  const remote = new SSEClientTransport(url, { requestInit: { headers } });
  const stdio = new StdioServerTransport(stdin, stdout);
  let closing = false;

  const close = async (error) => {
    if (closing) return;
    closing = true;
    if (error) console.error('[MCP Bridge]', error.message || String(error));
    await Promise.allSettled([remote.close(), stdio.close()]);
    if (error) process.exitCode = 1;
  };

  remote.onmessage = message => { void stdio.send(message).catch(close); };
  stdio.onmessage = message => { void remote.send(message).catch(close); };
  remote.onerror = close;
  stdio.onerror = close;
  remote.onclose = () => { void close(); };

  await remote.start();
  await stdio.start();
  return { remote, stdio, close };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startStdioBridge(process.argv[2]).catch(err => {
    console.error('[MCP Bridge] Could not connect:', err.message);
    process.exit(1);
  });
}
