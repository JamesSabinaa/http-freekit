const { pathToFileURL } = require('url');
const {
  findMcpStdioDescriptor,
  resolveBundledMcpBridgeScript
} = require('./mcp-launch.cjs');

const descriptorPath = findMcpStdioDescriptor();
if (descriptorPath !== null) {
  if (!descriptorPath) {
    console.error('[MCP Bridge] Runtime descriptor path is required');
    process.exitCode = 1;
  } else {
    const bridgeScript = resolveBundledMcpBridgeScript(__dirname);
    import(pathToFileURL(bridgeScript).href)
      .then(({ startStdioBridge }) => startStdioBridge(descriptorPath))
      .catch(err => {
        console.error('[MCP Bridge] Could not connect:', err.message);
        process.exit(1);
      });
  }
} else {
  require('./main.cjs');
}
