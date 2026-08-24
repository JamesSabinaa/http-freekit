import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { ApiServer } from '../../src/api/api-server.js';
import { trafficToBoundedHar, trafficToHar } from '../../src/api/har-converter.js';
import {
  HAR_IMPORT_MAX_BATCH_BYTES,
  HAR_IMPORT_MAX_EXPANDED_BYTES,
  HAR_IMPORT_MAX_FILE_BYTES,
  assertHarImportFileSize,
  createHarImportBatches,
  prepareHarImport
} from '../../src/ui/har-import.js';

const CAPTURE_BYTES_PER_SIDE = 32 * 1024 * 1024;

function entry(id) {
  return {
    startedDateTime: '2026-01-01T00:00:00.000Z',
    time: 1,
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

function postRaw(port, pathname, payload) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }));
    });
    request.once('error', reject);
    request.end(payload);
  });
}

test('HAR policy accommodates one maximum binary request and response capture', () => {
  const encodedSideBytes = 4 * Math.ceil(CAPTURE_BYTES_PER_SIDE / 3);
  const twoSidedBodyBytes = encodedSideBytes * 2;

  assert.ok(HAR_IMPORT_MAX_FILE_BYTES > twoSidedBodyBytes);
  assert.ok(HAR_IMPORT_MAX_BATCH_BYTES > twoSidedBodyBytes);
  assert.ok(HAR_IMPORT_MAX_EXPANDED_BYTES > twoSidedBodyBytes * 2);
  assert.ok(HAR_IMPORT_MAX_FILE_BYTES < twoSidedBodyBytes * 2);
});

test('HAR file preflight and expanded-memory failures are explicit', () => {
  assert.equal(assertHarImportFileSize(128, 128), 128);
  assert.throws(
    () => assertHarImportFileSize(129, 128),
    error => error.code === 'ERR_HAR_IMPORT_FILE_TOO_LARGE' && /0 MiB import limit/.test(error.message)
  );

  assert.throws(
    () => createHarImportBatches([{ body: 'expanded' }], {
      maxBatchBytes: 1024,
      maxExpandedBytes: 2
    }),
    error => error.code === 'ERR_HAR_IMPORT_EXPANDED_TOO_LARGE'
  );
});

test('normalized HAR rows are retained newest-first-policy and partitioned under the wire limit', () => {
  const prepared = prepareHarImport({
    log: { entries: [entry('old'), entry('middle'), entry('new')] }
  }, {
    createId: () => 'stable-id',
    transactionId: 'stable-transaction',
    retainLimit: 2,
    maxBatchBytes: 750,
    maxExpandedBytes: 4096
  });

  assert.equal(prepared.totalEntries, 3);
  assert.equal(prepared.retainedEntries, 2);
  assert.equal(prepared.droppedEntries, 1);
  assert.deepEqual(prepared.entries.map(request => request.path), ['/middle', '/new']);
  assert.ok(prepared.batches.length >= 2);
  assert.equal(prepared.payloads.length, prepared.batches.length);
  for (const [index, payload] of prepared.payloads.entries()) {
    assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= 750);
    assert.deepEqual(payload.importTransaction, {
      id: 'stable-transaction',
      index,
      count: prepared.payloads.length
    });
  }
});

test('HAR and normalized traffic parser ceilings return clear JSON 413 responses', async t => {
  const api = new ApiServer({ port: 8080 }, null, null, {
    port: 0,
    harImportMaxRequestBytes: 1024,
    trafficImportMaxRequestBytes: 1024
  });
  api.port = 0;
  await api.start();
  t.after(() => api.stop());
  const port = api.httpServer.address().port;
  const oversized = JSON.stringify({ padding: 'x'.repeat(2048) });

  const rawHar = await postRaw(port, '/api/traffic/import-har', oversized);
  assert.equal(rawHar.statusCode, 413);
  assert.equal(rawHar.body.code, 'ERR_HAR_IMPORT_REQUEST_TOO_LARGE');
  assert.match(rawHar.body.error, /JSON request exceeds/);

  const normalized = await postRaw(port, '/api/traffic/import', oversized);
  assert.equal(normalized.statusCode, 413);
  assert.equal(normalized.body.code, 'ERR_TRAFFIC_IMPORT_BATCH_TOO_LARGE');
  assert.match(normalized.body.error, /JSON request exceeds/);
});

test('multi-batch imports commit atomically and discard a failed transaction', async t => {
  const api = new ApiServer({ port: 8080 }, null, null, { port: 0 });
  api.port = 0;
  api.trafficLog.push({ id: 'existing', timestamp: 1 });
  await api.start();
  t.after(() => api.stop());
  const port = api.httpServer.address().port;
  const valid = id => ({ id, timestamp: Date.now(), url: `https://example.test/${id}` });

  const first = await postRaw(port, '/api/traffic/import', JSON.stringify({
    requests: [valid('first')],
    importTransaction: { id: 'rollback-test', index: 0, count: 2 }
  }));
  assert.equal(first.statusCode, 202);
  assert.equal(first.body.complete, false);
  assert.deepEqual(api.trafficLog.map(request => request.id), ['existing']);

  const invalid = await postRaw(port, '/api/traffic/import', JSON.stringify({
    requests: [{ id: 'invalid-without-timestamp' }],
    importTransaction: { id: 'rollback-test', index: 1, count: 2 }
  }));
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.body.code, 'ERR_TRAFFIC_IMPORT_TRANSACTION');
  assert.match(invalid.body.error, /transaction was discarded/i);
  assert.deepEqual(api.trafficLog.map(request => request.id), ['existing']);

  const orphanedFinal = await postRaw(port, '/api/traffic/import', JSON.stringify({
    requests: [valid('orphaned')],
    importTransaction: { id: 'rollback-test', index: 1, count: 2 }
  }));
  assert.equal(orphanedFinal.statusCode, 400);
  assert.equal(orphanedFinal.body.code, 'ERR_TRAFFIC_IMPORT_TRANSACTION');
  assert.deepEqual(api.trafficLog.map(request => request.id), ['existing']);

  const committedFirst = await postRaw(port, '/api/traffic/import', JSON.stringify({
    requests: [valid('committed-first')],
    importTransaction: { id: 'commit-test', index: 0, count: 2 }
  }));
  assert.equal(committedFirst.statusCode, 202);
  const committedFinal = await postRaw(port, '/api/traffic/import', JSON.stringify({
    requests: [valid('committed-final')],
    importTransaction: { id: 'commit-test', index: 1, count: 2 }
  }));
  assert.equal(committedFinal.statusCode, 200);
  assert.equal(committedFinal.body.complete, true);
  assert.equal(committedFinal.body.imported, 2);
  assert.deepEqual(api.trafficLog.map(request => request.id), [
    'existing', 'committed-first', 'committed-final'
  ]);
});

test('the normalized import route accepts a batch above the former 50 MiB ceiling', {
  timeout: 30_000
}, async t => {
  const api = new ApiServer({ port: 8080 }, null, null, { port: 0 });
  api.port = 0;
  await api.start();
  t.after(() => api.stop());
  const payload = JSON.stringify({
    requests: [{
      id: 'larger-than-old-parser-limit',
      timestamp: Date.now(),
      requestBody: 'x'.repeat(50 * 1024 * 1024 + 1024)
    }],
    importTransaction: { id: 'large-parser-test', index: 0, count: 1 }
  });
  assert.ok(Buffer.byteLength(payload) > 50 * 1024 * 1024);
  assert.ok(Buffer.byteLength(payload) < HAR_IMPORT_MAX_BATCH_BYTES);

  const response = await postRaw(api.httpServer.address().port, '/api/traffic/import', payload);
  assert.equal(response.statusCode, 200, response.body.error);
  assert.equal(response.body.imported, 1);
  assert.equal(api.trafficLog[0].requestBody.length, 50 * 1024 * 1024 + 1024);
});

test('bounded HAR export retains newest entries and records every omission', async t => {
  const records = ['old', 'new'].map((id, index) => ({
    id,
    timestamp: Date.UTC(2026, 0, index + 1),
    method: 'GET',
    url: `https://example.test/${id}`,
    protocol: 'https',
    responseBody: id.repeat(1200),
    responseHeaders: { 'content-type': 'text/plain' },
    statusCode: 200
  }));
  const oneEntryBytes = Buffer.byteLength(JSON.stringify(trafficToHar([records[1]], {
    maskSensitive: false
  })));
  const maxBytes = oneEntryBytes + 512;
  const bounded = trafficToBoundedHar(records, { maskSensitive: false, maxBytes });
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= maxBytes);
  assert.deepEqual(bounded.log.entries.map(item => item.request.url),
    ['https://example.test/new']);
  assert.deepEqual(bounded.log._httpFreeKitExport, {
    complete: false,
    totalEntries: 2,
    exportedEntries: 1,
    omittedEntries: 1,
    maxBytes,
    warning: bounded.log.comment
  });
  assert.match(bounded.log.comment, /1 older traffic entry was omitted/);

  const api = new ApiServer({ port: 8080 }, null, null, {
    port: 0,
    harExportMaxBytes: maxBytes
  });
  api.port = 0;
  api.trafficLog.push(...records);
  await api.start();
  t.after(() => api.stop());
  const route = await new Promise((resolve, reject) => {
    http.get({
      hostname: '127.0.0.1',
      port: api.httpServer.address().port,
      path: '/api/traffic/export.har'
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        raw: Buffer.concat(chunks)
      }));
    }).once('error', reject);
  });
  assert.equal(route.statusCode, 200);
  assert.ok(route.raw.byteLength <= maxBytes);
  const routeHar = JSON.parse(route.raw.toString('utf8'));
  assert.equal(routeHar.log._httpFreeKitExport.omittedEntries, 1);
  assert.equal(routeHar.log.entries[0].request.url, 'https://example.test/new');
});

test('bounded HAR export accounts for the entries array brackets at the exact byte boundary', () => {
  const records = ['older', 'newer'].map((id, index) => ({
    id,
    timestamp: Date.UTC(2026, 1, index + 1),
    method: 'GET',
    url: `https://example.test/${id}`,
    protocol: 'https',
    responseBody: id.repeat(900),
    responseHeaders: { 'content-type': 'text/plain' },
    statusCode: 200
  }));
  const oneEntryBytes = Buffer.byteLength(JSON.stringify(trafficToHar([records[1]], {
    maskSensitive: false
  })));
  const probe = trafficToBoundedHar(records, {
    maskSensitive: false,
    maxBytes: oneEntryBytes + 512
  });
  assert.equal(probe.log.entries.length, 1);
  const exactBytes = Buffer.byteLength(JSON.stringify(probe));

  const exact = trafficToBoundedHar(records, {
    maskSensitive: false,
    maxBytes: exactBytes
  });
  assert.equal(Buffer.byteLength(JSON.stringify(exact)), exactBytes);

  const belowBoundary = exactBytes - 1;
  try {
    const below = trafficToBoundedHar(records, {
      maskSensitive: false,
      maxBytes: belowBoundary
    });
    assert.ok(Buffer.byteLength(JSON.stringify(below)) <= belowBoundary);
  } catch (error) {
    assert.match(error.message, /limit is too small/);
  }
});
