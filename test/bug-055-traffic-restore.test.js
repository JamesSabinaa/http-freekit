import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ApiServer } from '../src/api/api-server.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = fs.readFileSync(path.join(repoRoot, 'src/ui/app.js'), 'utf8');

function createApiServer() {
  return new ApiServer({
    onBreakpoint: null,
    onUpstreamProxyRetry: null,
    matchApiSpec: () => null
  }, null, null);
}

test('WebSocket initialization requests the existing traffic log', () => {
  assert.match(app, /case 'init':[\s\S]*?type: 'get-traffic',[\s\S]*?limit: msg\.trafficLimit/);
});

test('traffic dump returns all retained requests when initialized with the log limit', () => {
  const api = createApiServer();
  api.maxTrafficLog = 2;
  api.trafficLog = [{ id: 'older' }, { id: 'newer' }];
  let response;

  api._handleWsMessage({ send: message => { response = JSON.parse(message); } }, {
    type: 'get-traffic',
    limit: api.maxTrafficLog
  });

  assert.deepEqual(response, {
    type: 'traffic-dump',
    requests: api.trafficLog
  });
});
