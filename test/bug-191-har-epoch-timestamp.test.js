import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { ApiServer } from '../src/api/api-server.js';

function postJson(port, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/traffic/import-har',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ statusCode: response.statusCode, body: text ? JSON.parse(text) : null });
      });
    });
    request.once('error', reject);
    request.end(payload);
  });
}

function harEntry(startedDateTime, id) {
  return {
    ...(startedDateTime === undefined ? {} : { startedDateTime }),
    request: {
      method: 'GET',
      url: `https://example.test/${id}`,
      headers: []
    },
    response: {
      status: 200,
      statusText: 'OK',
      headers: [],
      content: { text: '' }
    }
  };
}

test('HAR import preserves epoch and pre-epoch timestamps and consistently falls back for invalid dates', async t => {
  const fallbackTimestamp = Date.UTC(2035, 3, 5, 6, 7, 8);
  t.mock.method(Date, 'now', () => fallbackTimestamp);
  const proxy = {};
  const api = new ApiServer(proxy, null, null);
  const server = http.createServer(api.app);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));

  const response = await postJson(server.address().port, {
    log: {
      entries: [
        harEntry('1970-01-01T00:00:00.000Z', 'epoch'),
        harEntry('1969-12-31T23:59:59.000Z', 'pre-epoch'),
        harEntry('not-a-date', 'invalid'),
        harEntry(undefined, 'missing')
      ]
    }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.imported, 4);
  assert.deepEqual(
    api.trafficLog.map(entry => entry.timestamp),
    [0, -1000, fallbackTimestamp, fallbackTimestamp]
  );
});
