import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const read = relativePath => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');

test('README timeout claims match internal defaults and available settings surfaces', () => {
  const readme = read('README.md');
  const proxySource = read('src/proxy/proxy-server.js');
  const connectDefault = proxySource.match(/_upstreamConnectTimeoutMs\s*=\s*options\.upstreamConnectTimeoutMs\s*\?\?\s*(\d+)/);
  const idleDefault = proxySource.match(/_upstreamIdleTimeoutMs\s*=\s*options\.upstreamIdleTimeoutMs\s*\?\?\s*(\d+)/);

  assert.ok(connectDefault, 'upstream connection timeout default must remain discoverable');
  assert.ok(idleDefault, 'upstream idle timeout default must remain discoverable');
  const expectedClaim = `- **Upstream request timeouts** — built-in ${Number(connectDefault[1]) / 1000}s connection and ${Number(idleDefault[1]) / 1000}s idle-response limits`;
  assert.ok(readme.includes(expectedClaim));

  const timeoutClaim = readme.split('\n').find(line => line.includes('**Upstream request timeouts**')) || '';
  assert.doesNotMatch(timeoutClaim, /configurable|configuration setting|user-selectable/i);

  const productSurfaces = [
    read('src/index.js'),
    read('src/api/api-server.js'),
    read('src/ui/app.js'),
    read('src/ui/index.html')
  ].join('\n');
  assert.doesNotMatch(productSurfaces, /upstream(?:Connect|Idle)TimeoutMs/);
});
