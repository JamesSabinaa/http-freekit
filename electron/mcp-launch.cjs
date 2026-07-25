const path = require('path');

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

function resolveBundledMcpBridgeScript(appDirectory) {
  const packedBridge = path.resolve(appDirectory, '..', 'src', 'mcp', 'stdio-bridge.js');
  return packedBridge.replace(
    /([\\/])app\.asar([\\/])/,
    '$1app.asar.unpacked$2'
  );
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
