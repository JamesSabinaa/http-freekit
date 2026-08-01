import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const app = fs.readFileSync(path.join(repoRoot, 'src/ui/app.js'), 'utf8');

test('hash navigation updates sidebar ARIA selection state', () => {
  assert.match(
    app,
    /function setActiveSidebarTab\(el\)[\s\S]*?setAttribute\('aria-selected', 'false'\)[\s\S]*?setAttribute\('aria-selected', 'true'\)/
  );
  const navigationSource = app.match(/function navigateFromHash\(\)[\s\S]*?window\.addEventListener\('hashchange'/)?.[0];
  assert.ok(navigationSource);
  assert.equal(navigationSource.match(/setActiveSidebarTab\(el\)/g)?.length, 3);
});
