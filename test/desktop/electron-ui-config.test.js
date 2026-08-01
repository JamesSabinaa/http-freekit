import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');

test('Electron interceptor card exposes application selection and launch controls', () => {
  assert.match(source, /EXPANDABLE_INTERCEPTORS = new Set\(\[[^\]]*'electron'/);
  assert.match(source, /id === 'electron'[\s\S]*renderElectronConfig\(container\)/);
  assert.match(source, /window\.electronApi\?\.selectFilePath/);
  assert.match(source, /id="electronAppPath"/);
});

test('Electron UI activation sends the selected executable path', () => {
  assert.match(source, /api\/interceptors\/electron\/activate/);
  assert.match(source, /body: JSON\.stringify\(\{ appPath \}\)/);
  assert.match(source, /!response\.ok \|\| data\.error \|\| data\.success === false/);
});
