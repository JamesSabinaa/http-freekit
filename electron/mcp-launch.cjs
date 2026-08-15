const path = require('path');
const { rewriteResourcesAsarToUnpacked } = require('./asar-path.cjs');

const MCP_STDIO_BRIDGE_FLAG = '--mcp-stdio-bridge';

function resolveDesktopMcpExecutable({
  platform = process.platform,
  execPath = process.execPath,
  appImage = process.env.APPIMAGE,
  isPackaged = false
} = {}) {
  const executable = platform === 'linux' && isPackaged && appImage
    ? appImage
    : execPath;
  return path.resolve(executable);
}

function resolveBundledMcpBridgeScript(appDirectory, pathApi = path) {
  const packedBridge = pathApi.resolve(appDirectory, '..', 'src', 'mcp', 'stdio-bridge.js');
  return rewriteResourcesAsarToUnpacked(packedBridge);
}

function findMcpStdioDescriptor(argv = process.argv) {
  const flagIndex = argv.indexOf(MCP_STDIO_BRIDGE_FLAG);
  return flagIndex === -1 ? null : argv[flagIndex + 1] || '';
}

module.exports = {
  MCP_STDIO_BRIDGE_FLAG,
  findMcpStdioDescriptor,
  resolveBundledMcpBridgeScript,
  resolveDesktopMcpExecutable
};
