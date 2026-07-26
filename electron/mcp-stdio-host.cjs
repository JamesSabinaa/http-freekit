'use strict';

async function runMcpStdioHost({
  descriptorPath,
  loadBridge,
  exit,
  logError = (...args) => console.error(...args)
}) {
  let exited = false;
  const reportError = (...args) => {
    try { logError(...args); } catch {}
  };
  const exitOnce = status => {
    if (exited) return;
    exited = true;
    try {
      exit(status);
    } catch (error) {
      reportError('[MCP Bridge] Could not terminate host:', error?.message || String(error));
    }
  };

  if (!descriptorPath) {
    reportError('[MCP Bridge] Runtime descriptor path is required');
    exitOnce(1);
    return 1;
  }

  let status = 1;
  try {
    const { startStdioBridge } = await loadBridge();
    const bridge = await startStdioBridge(descriptorPath);
    const result = await bridge.closed;
    const cleanupFailed = !result || result.error ||
      !Array.isArray(result.transports) ||
      result.transports.some(transport => transport.status === 'rejected');
    status = cleanupFailed ? 1 : 0;
  } catch (error) {
    reportError('[MCP Bridge] Could not connect:', error?.message || String(error));
  }

  exitOnce(status);
  return status;
}

module.exports = { runMcpStdioHost };
