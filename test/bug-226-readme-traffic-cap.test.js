import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const read = relativePath => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');

test('README traffic-table scale matches the retained record cap', () => {
  const readme = read('README.md');
  const apiSource = read('src/api/api-server.js');
  const rendererSource = read('src/ui/app.js');
  const apiCap = apiSource.match(/this\.maxTrafficLog\s*=\s*([\d_]+)/);
  const rendererCap = rendererSource.match(/trimTrafficRows\s*\([^,]+,\s*limit\s*=\s*([\d_]+)/);

  assert.ok(apiCap, 'API traffic cap must remain discoverable');
  assert.ok(rendererCap, 'renderer traffic cap must remain discoverable');
  assert.equal(Number(rendererCap[1].replaceAll('_', '')), Number(apiCap[1].replaceAll('_', '')));

  const formattedCap = Number(apiCap[1].replaceAll('_', '')).toLocaleString('en-US');
  assert.ok(readme.includes(`up to ${formattedCap} retained rows`));
  assert.doesNotMatch(readme, /100,000\+ rows/i);
});
