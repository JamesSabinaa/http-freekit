import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = fs.readFileSync(path.join(repoRoot, 'src/ui/app.js'), 'utf8');

test('completion updates the selected detail panel request object', () => {
  assert.match(
    app,
    /case 'request-update':[\s\S]*?selectedRequestId === msg\.data\.id[\s\S]*?detailPanel'\)\._request = msg\.data;[\s\S]*?renderDetailCards\(msg\.data\)/
  );
});
