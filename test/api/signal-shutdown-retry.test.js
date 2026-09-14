import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const source = fs.readFileSync('src/index.js', 'utf8');
const start = source.indexOf('  const shutdown = (exitCode = 0) =>');
const end = source.indexOf("  process.on('SIGTERM'", start);
const blockEnd = source.indexOf('\n', end);
assert.ok(start >= 0 && end > start && blockEnd > end);

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`${signal} cleanup failure keeps servers running and allows a successful retry`, async () => {
    const script = `
      let shutdownPromise = null;
      let attempts = 0;
      const interceptors = {
        beginShutdown() {},
        async deactivateAll() { if (++attempts === 1) throw new Error('cleanup must be retried'); }
      };
      const removeOwnMcpRuntimeDescriptor = () => {};
      const mcpBridge = { async stop() {} };
      const proxy = { async stop() { console.log('PROXY STOP'); } };
      const api = { setShutdownHandler() {}, async stop() { console.log('API STOP'); } };
      const notifyDesktopShutdownProgress = () => {};
      const notifyDesktopShutdownFailed = async () => {};
      const notifyDesktopShutdownComplete = async () => {};
      const MCP_STDIO_ENABLED = false;
      ${source.slice(start, blockEnd)}
      process.emit('${signal}');
      setTimeout(() => { console.log('RETRY'); process.emit('${signal}'); }, 50);
    `;
    const { stdout, stderr } = await run(process.execPath, ['--input-type=module', '-e', script], { timeout: 10000, windowsHide: true });
    assert.match(stderr, /cleanup must be retried/);
    assert.match(stdout, /RETRY[\s\S]*PROXY STOP[\s\S]*API STOP/);
    assert.equal(stdout.split('PROXY STOP').length - 1, 1);
    assert.doesNotMatch(stdout.split('RETRY')[0], /PROXY STOP|API STOP/);
  });
}
