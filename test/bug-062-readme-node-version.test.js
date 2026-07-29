import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');

test('README Node.js baseline matches the package engine minimum', () => {
  const engineMatch = String(packageJson.engines?.node || '').match(/^>=(\d+)\.(\d+)\.(\d+)$/);
  assert.ok(engineMatch, 'the Node.js engine must declare one explicit inclusive minimum');

  const readmeMatch = readme.match(/\*\*Runtime:\*\* Node\.js (\d+)\.(\d+)(?:\.(\d+))?\+/);
  assert.ok(readmeMatch, 'the README must advertise a concrete Node.js minimum');

  assert.deepEqual(
    readmeMatch.slice(1).map(value => Number(value || 0)),
    engineMatch.slice(1).map(Number)
  );
});
