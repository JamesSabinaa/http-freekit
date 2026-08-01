import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const read = relativePath => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');

test('renderer bootstrap loads shared traffic modules before the classic application', () => {
  const html = read('src/ui/index.html');
  const bootstrap = read('src/ui/bootstrap.js');
  const application = read('src/ui/app.js');
  const server = read('src/index.js');

  assert.match(html, /<script type="module" src="\/bootstrap\.js"><\/script>/);
  assert.doesNotMatch(html, /<script src="\/app\.js"><\/script>/);
  assert.match(bootstrap, /from '\/shared\/traffic\/default-exclusions\.js'/);
  assert.match(bootstrap, /from '\/shared\/traffic\/traffic-lists\.js'/);
  assert.ok(
    bootstrap.indexOf('window.FreeKitTrafficLists =') <
      bootstrap.indexOf("applicationScript.src = '/app.js'")
  );
  assert.match(
    server,
    /api\.app\.use\('\/shared\/traffic', express\.static\(SHARED_TRAFFIC_DIR\)\)/
  );
  assert.match(application, /window\.FreeKitTrafficLists/);
  assert.doesNotMatch(application, /const initialDefaultExclusions =/);
  assert.doesNotMatch(application, /function defaultExclusionHostMatches\(/);
});
