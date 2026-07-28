import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = fs.readFileSync(path.join(repoRoot, 'src/ui/app.js'), 'utf8');

test('MCP selection opens an already-selected request instead of toggling it closed', () => {
  assert.match(app, /function selectRequest\(id, toggle = true, trafficLifecycleId\)/);
  assert.match(app, /if \(isSelectedTrafficRequest\(req\) && toggle\)/);
  assert.match(app, /selectRequest\([\s\S]*?msg\.requestId,[\s\S]*?false,[\s\S]*?msg\.trafficLifecycleId/);
});
