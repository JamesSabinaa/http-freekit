import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { bootstrapApplication } from '../../src/ui/bootstrap.js';

const read = relativePath => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');

test('renderer bootstrap loads shared modules before the classic application', async () => {
  const html = read('src/ui/index.html');
  const bootstrap = read('src/ui/bootstrap.js');
  const application = read('src/ui/app.js');
  const server = read('src/index.js');

  assert.match(html, /<script type="module" src="\/bootstrap\.js"><\/script>/);
  assert.doesNotMatch(html, /<script src="\/app\.js"><\/script>/);
  for (const dependency of [
    '/shared/traffic/default-exclusions.js', '/shared/traffic/traffic-lists.js',
    '/har-import.js', '/curl-parser.js', '/send-url.js', '/request-export.js'
  ]) assert.match(bootstrap, new RegExp(JSON.stringify(dependency).slice(1, -1).replaceAll('/', '\\/')));
  assert.match(
    server,
    /api\.app\.use\('\/shared\/traffic', express\.static\(SHARED_TRAFFIC_DIR\)\)/
  );
  assert.match(application, /window\.FreeKitTrafficLists/);
  assert.match(application, /window\.FreeKitHarImport/);
  assert.match(application, /window\.FreeKitCurlParser/);
  assert.match(application, /window\.FreeKitSendUrl/);
  assert.match(application, /window\.FreeKitRequestExport/);
  const imported = [];
  const modules = {
    '/shared/traffic/default-exclusions.js': { DEFAULT_EXCLUSIONS: ['example'] },
    '/shared/traffic/traffic-lists.js': { DEFAULT_TRAFFIC_LIST_ID: 'default', createTrafficListVisibilityMatcher() {} },
    '/har-import.js': { normalizeHarEntries() {} },
    '/curl-parser.js': { parseCurlCommand() {} },
    '/send-url.js': { normalizeSendUrl() {}, INVALID_SEND_URL_CODE: 'ERR_INVALID_SEND_URL' },
    '/request-export.js': { generateExportSnippet() {} }
  };
  const targetWindow = {};
  const appended = [];
  const targetDocument = {
    createElement: () => ({ addEventListener() {} }),
    body: { append: script => appended.push(script) },
    getElementById: () => null
  };
  assert.equal(await bootstrapApplication({
    importModule: async specifier => { imported.push(specifier); return modules[specifier]; },
    targetWindow,
    targetDocument
  }), true);
  assert.deepEqual(imported, Object.keys(modules));
  assert.equal(appended[0].src, '/app.js');
  assert.equal(targetWindow.FreeKitCurlParser.parseCurlCommand, modules['/curl-parser.js'].parseCurlCommand);
  assert.equal(targetWindow.FreeKitSendUrl.normalizeSendUrl, modules['/send-url.js'].normalizeSendUrl);
  assert.doesNotMatch(application, /const initialDefaultExclusions =/);
  assert.doesNotMatch(application, /function defaultExclusionHostMatches\(/);
  assert.doesNotMatch(application, /function normalizeHarEntry\(/);
  assert.doesNotMatch(application, /function parseCurlCommand\(/);
  assert.doesNotMatch(application, /function generateExportSnippet\(/);
});

test('bootstrap dependency and application-script failures replace Connecting status', async () => {
  for (const failApplicationScript of [false, true]) {
    const status = { textContent: 'Connecting...' };
    let errorHandler;
    const appended = [];
    const targetDocument = {
      getElementById: id => id === 'statusText' ? status : null,
      createElement: () => ({
        addEventListener: (name, handler) => { if (name === 'error') errorHandler = handler; }
      }),
      body: { append: script => appended.push(script) }
    };
    const errors = [];
    const importModule = failApplicationScript
      ? async specifier => specifier.includes('default-exclusions')
        ? { DEFAULT_EXCLUSIONS: [] }
        : specifier.includes('traffic-lists')
          ? { DEFAULT_TRAFFIC_LIST_ID: 'default', createTrafficListVisibilityMatcher() {} }
          : specifier.includes('har-import')
            ? { normalizeHarEntries() {} }
            : specifier.includes('curl-parser')
              ? { parseCurlCommand() {} }
              : specifier.includes('send-url')
                ? { normalizeSendUrl() {}, INVALID_SEND_URL_CODE: 'ERR_INVALID_SEND_URL' }
              : { generateExportSnippet() {} }
      : async () => { throw new Error('dependency missing'); };

    const result = await bootstrapApplication({
      importModule,
      targetWindow: {},
      targetDocument,
      logger: { error: (...args) => errors.push(args) }
    });
    if (failApplicationScript) {
      assert.equal(result, true);
      errorHandler(new Error('app parse failed'));
    } else {
      assert.equal(result, false);
      assert.equal(appended.length, 0);
    }
    assert.equal(status.textContent, 'Application failed to load');
    assert.equal(errors.length, 1);
  }
});
