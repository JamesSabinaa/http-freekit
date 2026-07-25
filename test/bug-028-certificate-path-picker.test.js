import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(repoRoot, 'src/ui/app.js'), 'utf8');

test('certificate browse buttons use Electron absolute-path selection when available', () => {
  assert.match(source, /window\.electronApi\?\.selectFilePath/);
  assert.match(source, /await window\.electronApi\.selectFilePath\(\{/);
  assert.match(source, /if \(selectedPath\) pathInput\.value = selectedPath/);
  assert.match(source, /'clientCertPath',[\s\S]*\['pfx', 'p12', 'pem', 'crt', 'cert'\]/);
  assert.match(source, /'trustedCAPath',[\s\S]*\['pem', 'crt', 'cert', 'der'\]/);
});

test('browser fallback writes the best available path directly to the saved input', () => {
  assert.match(source, /pathInput\.value = file\.path \|\| file\.name/);
  assert.doesNotMatch(source, /dataset\.fullPath/);
});
