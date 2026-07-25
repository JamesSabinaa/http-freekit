import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(repoRoot, 'src/index.js'), 'utf8');

test('stdio mode redirects console logs before application startup', () => {
  const redirectIndex = source.search(/if \(MCP_STDIO_ENABLED\) \{\r?\n  console\.log =/);
  const mainIndex = source.indexOf('async function main()');
  const bannerIndex = source.indexOf("console.log('  ╔");

  assert.notEqual(redirectIndex, -1);
  assert.ok(redirectIndex < mainIndex);
  assert.ok(redirectIndex < bannerIndex);
  assert.equal(source.match(/console\.log =/g)?.length, 1);
  assert.match(source, /if \(MCP_STDIO_ENABLED\) \{\r?\n    await mcpBridge\.startStdio\(\);/);
});
