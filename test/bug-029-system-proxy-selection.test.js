import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(repoRoot, 'src/ui/app.js'), 'utf8');

test('selecting system proxy settings deletes the active custom proxy first', () => {
  const start = source.indexOf("if (type === 'system') {");
  const end = source.indexOf('const details =', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const systemBranch = source.slice(start, end);

  assert.match(systemBranch, /fetch\(API_BASE \+ '\/api\/upstream-proxy', \{ method: 'DELETE' \}\)/);
  assert.match(systemBranch, /if \(!res\.ok\) throw new Error/);
  assert.ok(
    systemBranch.indexOf("method: 'DELETE'") < systemBranch.indexOf('Using system proxy settings'),
    'the custom proxy must be cleared before reporting system settings as active'
  );
});
