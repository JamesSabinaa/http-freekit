import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const source = fs.readFileSync(path.join(repoRoot, 'src/ui/app.js'), 'utf8');
const html = fs.readFileSync(path.join(repoRoot, 'src/ui/index.html'), 'utf8');

test('unsupported system upstream proxy settings are not offered or reported', () => {
  assert.doesNotMatch(html, /<option value="system">/);
  assert.match(html, /System proxy settings are not imported automatically/);
  assert.doesNotMatch(source, /type === 'system'/);
  assert.doesNotMatch(source, /Using system proxy settings/);
});
