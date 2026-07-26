import fs from 'node:fs';

import {
  removeMcpRuntimeDescriptor,
  writeMcpRuntimeDescriptor
} from '../../src/mcp/launch-config.js';

const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

function signal(filePath, value) {
  if (filePath) fs.writeFileSync(filePath, value, { encoding: 'utf8', flag: 'wx' });
}

function waitForRelease(filePath, timeoutMs = 10000) {
  if (!filePath) return;
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for test release signal');
    Atomics.wait(waitBuffer, 0, 0, 10);
  }
}

function pauseAt(config, stage) {
  return () => {
    signal(config.readyPath, stage);
    waitForRelease(config.releasePath);
  };
}

function main(config) {
  const options = {
    lockTimeoutMs: config.lockTimeoutMs ?? 5000,
    lockRetryMs: 5,
    ...(config.pauseStage ? { [config.pauseStage]: pauseAt(config, config.pauseStage) } : {}),
    ...(config.contentionPath ? {
      onLockContention: () => signal(config.contentionPath, 'contended')
    } : {})
  };

  try {
    let result;
    if (config.operation === 'write') {
      result = writeMcpRuntimeDescriptor(config.descriptor, options);
    } else if (config.operation === 'remove') {
      result = removeMcpRuntimeDescriptor(config.descriptorPath, config.instanceId, options);
    } else {
      throw new Error(`Unknown worker operation: ${config.operation}`);
    }
    process.stdout.write(JSON.stringify({ ok: true, result }) + '\n');
  } catch (err) {
    process.stderr.write((err?.stack || String(err)) + '\n');
    process.exitCode = 1;
  }
}

if (process.argv[2]) {
  main(JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8')));
}
