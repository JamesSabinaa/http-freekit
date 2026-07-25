import path from 'path';
import fs from 'fs';

export function createMcpLaunchConfig({
  executablePath = process.execPath,
  bridgeScript,
  descriptorPath,
  electronRuntime = false,
  packagedAppRuntime = false
}) {
  if (!path.isAbsolute(executablePath)) {
    throw new Error('MCP executable path must be absolute');
  }
  if (!path.isAbsolute(bridgeScript)) {
    throw new Error('MCP bridge script path must be absolute');
  }
  if (!path.isAbsolute(descriptorPath)) {
    throw new Error('MCP runtime descriptor path must be absolute');
  }

  if (packagedAppRuntime) {
    return {
      command: executablePath,
      args: ['--mcp-stdio-bridge', descriptorPath]
    };
  }

  return {
    command: executablePath,
    args: [bridgeScript, descriptorPath],
    ...(electronRuntime ? { env: { ELECTRON_RUN_AS_NODE: '1' } } : {})
  };
}

export function writeMcpRuntimeDescriptor({ descriptorPath, sseUrl, authToken, instanceId }) {
  if (!path.isAbsolute(descriptorPath)) throw new Error('MCP runtime descriptor path must be absolute');
  const descriptor = {
    sseUrl,
    instanceId,
    ...(authToken ? { authToken } : {})
  };
  fs.mkdirSync(path.dirname(descriptorPath), { recursive: true });
  fs.writeFileSync(descriptorPath, JSON.stringify(descriptor), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(descriptorPath, 0o600); } catch {}
  return descriptor;
}

export function removeMcpRuntimeDescriptor(descriptorPath, instanceId) {
  try {
    const current = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
    if (current.instanceId === instanceId) fs.unlinkSync(descriptorPath);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[MCP] Could not remove runtime descriptor:', err.message);
  }
}
