import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testRoot = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = path.resolve(testRoot, '..');

function findTestFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory()
      ? findTestFiles(entryPath)
      : (entry.name.endsWith('.test.js') ? [entryPath] : []);
  });
}

test('tests use descriptive feature folders instead of numbered bug filenames', () => {
  const files = findTestFiles(testRoot);
  assert.ok(files.length > 0);
  for (const file of files) {
    assert.notEqual(path.dirname(file), testRoot, `${path.basename(file)} must be in a feature folder`);
    assert.doesNotMatch(path.basename(file), /^bug-[0-9]+-/);
  }

  const bugHistory = fs.readFileSync(path.join(repoRoot, 'bugs.md'), 'utf8');
  assert.doesNotMatch(bugHistory, /test\/bug-[0-9]+-[^\s`]+\.test\.js/);
});
