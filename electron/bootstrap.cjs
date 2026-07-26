const { pathToFileURL } = require('url');
const {
  findMcpStdioDescriptor,
  resolveBundledMcpBridgeScript
} = require('./mcp-launch.cjs');
const { runMcpStdioHost } = require('./mcp-stdio-host.cjs');

const descriptorPath = findMcpStdioDescriptor();
if (descriptorPath !== null) {
  const exit = process.versions.electron
    ? status => require('electron').app.exit(status)
    : status => { if (status) process.exitCode = status; };
  void runMcpStdioHost({
    descriptorPath,
    loadBridge: () => {
      const bridgeScript = resolveBundledMcpBridgeScript(__dirname);
      return import(pathToFileURL(bridgeScript).href);
    },
    exit
  });
} else {
  require('./main.cjs');
}
