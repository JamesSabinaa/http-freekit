import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const read = relativePath => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');

test('renderer bootstrap loads shared modules before the classic application', () => {
  const html = read('src/ui/index.html');
  const bootstrap = read('src/ui/bootstrap.js');
  const application = read('src/ui/app.js');
  const server = read('src/index.js');

  assert.match(html, /<script type="module" src="\/bootstrap\.js"><\/script>/);
  assert.doesNotMatch(html, /<script src="\/app\.js"><\/script>/);
  assert.match(bootstrap, /from '\/shared\/traffic\/default-exclusions\.js'/);
  assert.match(bootstrap, /from '\/shared\/traffic\/traffic-lists\.js'/);
  assert.match(bootstrap, /from '\/har-import\.js'/);
  assert.match(bootstrap, /from '\/curl-parser\.js'/);
  assert.ok(
    bootstrap.indexOf('window.FreeKitTrafficLists =') <
      bootstrap.indexOf("applicationScript.src = '/app.js'")
  );
  assert.ok(
    bootstrap.indexOf('window.FreeKitHarImport =') <
      bootstrap.indexOf("applicationScript.src = '/app.js'")
  );
  assert.ok(
    bootstrap.indexOf('window.FreeKitCurlParser =') <
      bootstrap.indexOf("applicationScript.src = '/app.js'")
  );
  assert.match(
    server,
    /api\.app\.use\('\/shared\/traffic', express\.static\(SHARED_TRAFFIC_DIR\)\)/
  );
  assert.match(application, /window\.FreeKitTrafficLists/);
  assert.match(application, /window\.FreeKitHarImport/);
  assert.match(application, /window\.FreeKitCurlParser/);
  assert.match(bootstrap, /window\.FreeKitHarImport =/);
  assert.match(bootstrap, /window\.FreeKitCurlParser =/);
  assert.doesNotMatch(application, /const initialDefaultExclusions =/);
  assert.doesNotMatch(application, /function defaultExclusionHostMatches\(/);
  assert.doesNotMatch(application, /function normalizeHarEntry\(/);
  assert.doesNotMatch(application, /function parseCurlCommand\(/);
});
