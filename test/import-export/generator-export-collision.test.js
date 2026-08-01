import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ApiServer } from '../../src/api/api-server.js';

function createApi() {
  return new ApiServer({}, null, null);
}

function trafficRecord(id) {
  return {
    timestamp: Date.UTC(2035, 3, 5, 6, 7, 8),
    method: 'GET',
    url: `https://example.test/export-${id}`,
    requestHeaders: {},
    responseHeaders: { 'content-type': 'text/plain' },
    responseBody: `response-${id}`,
    responseBodySize: 10,
    statusCode: 200,
    statusMessage: 'OK'
  };
}

test('concurrent generator exports atomically reserve distinct sessions', async t => {
  t.mock.method(Date.prototype, 'toISOString', () => '2035-04-05T06:07:08.000Z');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'http-freekit-bug-189-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const harBaseDir = path.join(root, 'hars');
  const api = createApi();
  const launches = [];
  let exportNumber = 0;
  api._getGeneratorDir = () => path.join(root, 'generator');
  api._getGeneratorPythonCandidates = () => [{ command: 'python-test', args: [] }];
  api._getGeneratorHarBaseDir = async () => harBaseDir;
  api._getHarExportTraffic = () => [trafficRecord(++exportNumber)];
  api._spawnGeneratorPython = async (candidates, args, options) => {
    launches.push({ candidates, args, options });
  };

  const exports = await Promise.all([
    api._exportToGenerator(),
    api._exportToGenerator()
  ]);

  assert.equal(new Set(exports.map(result => result.sessionName)).size, 2);
  assert.equal(new Set(exports.map(result => result.harPath)).size, 2);
  for (const result of exports) {
    assert.match(result.sessionName, /^http-freekit-2035-04-05-06-07-08-[0-9A-Za-z]+$/);
    assert.match(result.sessionName, /^[0-9A-Za-z_-]+$/);
    assert.equal(path.basename(path.dirname(result.harPath)), result.sessionName);
    assert.equal(path.basename(result.harPath), `${result.sessionName}.har`);
  }

  const hars = await Promise.all(exports.map(result =>
    fs.readFile(result.harPath, 'utf8').then(JSON.parse)
  ));
  assert.deepEqual(
    new Set(hars.map(har => har.log.entries[0].request.url)),
    new Set(['https://example.test/export-1', 'https://example.test/export-2'])
  );
  assert.deepEqual(
    new Set(hars.map(har => har.log.entries[0].response.content.text)),
    new Set(['response-1', 'response-2'])
  );

  assert.equal(launches.length, 2);
  assert.deepEqual(
    new Set(launches.map(launch => launch.args[2])),
    new Set(exports.map(result => result.sessionName))
  );
  for (const launch of launches) {
    assert.deepEqual(launch.args.slice(0, 2), ['main_app.py', '--session']);
    assert.equal(launch.options.cwd, path.join(root, 'generator'));
  }
});

test('a failed generator launch removes only its reserved session', async t => {
  t.mock.method(Date.prototype, 'toISOString', () => '2035-04-05T06:07:08.000Z');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'http-freekit-bug-189-cleanup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const harBaseDir = path.join(root, 'hars');
  await fs.mkdir(harBaseDir, { recursive: true });
  const unrelatedDir = path.join(harBaseDir, 'existing-session');
  await fs.mkdir(unrelatedDir);
  await fs.writeFile(path.join(unrelatedDir, 'keep.txt'), 'keep', 'utf8');

  const api = createApi();
  api._getGeneratorDir = () => path.join(root, 'generator');
  api._getGeneratorPythonCandidates = () => [{ command: 'python-test', args: [] }];
  api._getGeneratorHarBaseDir = async () => harBaseDir;
  api._getHarExportTraffic = () => [trafficRecord(1)];
  api._spawnGeneratorPython = async () => {
    throw new Error('launch failed');
  };

  await assert.rejects(api._exportToGenerator(), /launch failed/);
  assert.deepEqual(await fs.readdir(harBaseDir), ['existing-session']);
  assert.equal(await fs.readFile(path.join(unrelatedDir, 'keep.txt'), 'utf8'), 'keep');
});
