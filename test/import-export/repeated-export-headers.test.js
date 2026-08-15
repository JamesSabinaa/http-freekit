import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';

import {
  generateExportSnippet,
  getExportHeaders
} from '../../src/ui/request-export.js';

const formats = [
  'curl',
  'python',
  'javascript-fetch',
  'javascript-node',
  'powershell',
  'wget',
  'php',
  'go'
];
const exactFormats = new Set(['curl', 'javascript-node', 'wget', 'php', 'go']);
const repeatedValues = [
  "first 'quoted' \\ path",
  'second, "double" $value; semi'
];

function requestFor(bodyType, requestHeaders) {
  const request = {
    method: 'POST',
    url: 'https://example.test/export-target',
    bodyType,
    requestHeaders
  };
  if (bodyType === 'raw') {
    request.requestBody = 'raw payload';
  } else {
    request.formFields = [{ key: 'field', value: `${bodyType} payload`, enabled: true }];
    if (bodyType === 'multipart') request.multipartBoundary = '----RegressionBoundary';
  }
  return request;
}

function shellSingleQuoted(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function phpSingleQuoted(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function powerShellSingleQuoted(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function headerMarker(format, name, value) {
  const line = `${name}: ${value}`;
  if (format === 'curl' || format === 'wget') return shellSingleQuoted(line);
  if (format === 'php') return phpSingleQuoted(line);
  if (format === 'go') return `req.Header.Add(${JSON.stringify(name)}, ${JSON.stringify(value)})`;
  if (format === 'powershell') return powerShellSingleQuoted(value);
  return JSON.stringify(value);
}

function normalized(value) {
  return JSON.parse(JSON.stringify(value));
}

test('captured array headers flatten into filtered scalar pairs in source order', () => {
  const headers = getExportHeaders({
    requestHeaders: {
      'A-First': 'before',
      'X-Repeat': repeatedValues,
      Host: ['ignored-host-1', 'ignored-host-2'],
      'Proxy-Connection': ['ignored-proxy-1', 'ignored-proxy-2'],
      'Z-Last': 'after'
    }
  });

  assert.deepEqual(normalized(headers), [
    ['A-First', 'before'],
    ['X-Repeat', repeatedValues[0]],
    ['X-Repeat', repeatedValues[1]],
    ['Z-Last', 'after']
  ]);
  assert.ok(headers.every(([, value]) => !Array.isArray(value)));
});

for (const bodyType of ['raw', 'urlencoded', 'multipart']) {
  test(`${bodyType} exports preserve or explicitly reject repeated header fields in all formats`, async t => {
    const repeatedHeaders = {
      'A-First': 'before',
      'X-Repeat': repeatedValues,
      'Z-Last': 'after',
      Host: ['ignored-host-1', 'ignored-host-2'],
      'Proxy-Connection': ['ignored-proxy-1', 'ignored-proxy-2']
    };

    for (const format of formats) {
      await t.test(format, () => {
        const snippet = generateExportSnippet(requestFor(bodyType, repeatedHeaders), format);

        if (!exactFormats.has(format)) {
          assert.match(snippet, /EXACT REPLAY UNAVAILABLE/);
          assert.match(snippet, /cannot guarantee.*separate wire fields/);
          assert.match(snippet, /No request was generated/);
          assert.equal(snippet.includes('https://example.test/export-target'), false);
          return;
        }

        assert.doesNotMatch(snippet, /EXACT REPLAY UNAVAILABLE/);
        const markers = [
          headerMarker(format, 'A-First', 'before'),
          headerMarker(format, 'X-Repeat', repeatedValues[0]),
          headerMarker(format, 'X-Repeat', repeatedValues[1]),
          headerMarker(format, 'Z-Last', 'after')
        ];
        const positions = markers.map(marker => snippet.indexOf(marker));
        assert.ok(positions.every(position => position >= 0), `${format} must contain every scalar field`);
        assert.deepEqual(positions, positions.slice().sort((a, b) => a - b), `${format} must preserve field order`);
        assert.equal(snippet.includes(`X-Repeat: ${repeatedValues.join(',')}`), false);

        if (format === 'javascript-node') {
          for (const value of repeatedValues) {
            assert.ok(snippet.includes(`${JSON.stringify('X-Repeat')}, ${JSON.stringify(value)}`));
          }
          assert.doesNotThrow(() => new Function(snippet));
        }
        if (format === 'go') {
          assert.equal((snippet.match(/req\.Header\.Add\("X-Repeat"/g) || []).length, 2);
          assert.doesNotMatch(snippet, /req\.Header\.Set\("X-Repeat"/);
        }
      });
    }
  });

  test(`${bodyType} scalar headers retain every format's existing export path`, () => {
    for (const format of formats) {
      const snippet = generateExportSnippet(requestFor(bodyType, {
        'X-Scalar': "solo ' \\ value"
      }), format);
      assert.doesNotMatch(snippet, /EXACT REPLAY UNAVAILABLE/, format);
      assert.ok(snippet.includes(headerMarker(format, 'X-Scalar', "solo ' \\ value")), format);
    }
  });
}

test('excluded repeated headers do not cause refusals or leak into snippets', () => {
  for (const format of formats) {
    const raw = generateExportSnippet(requestFor('raw', {
      Host: ['ignored-host-1', 'ignored-host-2'],
      'Proxy-Connection': ['ignored-proxy-1', 'ignored-proxy-2'],
      'X-Scalar': 'kept'
    }), format);
    assert.doesNotMatch(raw, /EXACT REPLAY UNAVAILABLE/, format);
    assert.equal(raw.includes('ignored-host'), false, format);
    assert.equal(raw.includes('ignored-proxy'), false, format);

    const multipart = generateExportSnippet(requestFor('multipart', {
      'Content-Type': [
        'multipart/form-data; boundary=stale-one',
        'multipart/form-data; boundary=stale-two'
      ],
      'X-Scalar': 'kept'
    }), format);
    assert.doesNotMatch(multipart, /EXACT REPLAY UNAVAILABLE/, format);
    assert.equal(multipart.includes('stale-one'), false, format);
    assert.equal(multipart.includes('stale-two'), false, format);
    assert.match(multipart, /multipart|Form|formData|postFields/i, format);
    if (format === 'javascript-node') {
      assert.match(multipart, /headers: \[/);
      assert.ok(multipart.includes('"Content-Type", \'multipart/form-data; boundary=\' + boundary'));
      assert.ok(multipart.includes('"Content-Length", String(body.length)'));
      assert.doesNotMatch(multipart, /headers: \{/);
    }
  }
});

test('rebuilt multipart exports discard captured body metadata and framing in every format', () => {
  const request = requestFor('multipart', {
    'Content-Encoding': 'audit-stale-content-coding',
    'cOnTeNt-LeNgTh': 'audit-stale-length',
    'Transfer-Encoding': 'audit-stale-transfer-coding',
    Trailer: 'audit-stale-trailer',
    'Content-Type': 'multipart/form-data; boundary=audit-stale-boundary',
    'X-Retained': 'audit-retained-header'
  });

  for (const format of formats) {
    const snippet = generateExportSnippet(request, format);
    assert.doesNotMatch(snippet, /EXACT REPLAY UNAVAILABLE/, format);
    assert.ok(snippet.includes('audit-retained-header'), format);
    for (const staleValue of [
      'audit-stale-content-coding',
      'audit-stale-length',
      'audit-stale-transfer-coding',
      'audit-stale-trailer',
      'audit-stale-boundary'
    ]) {
      assert.equal(snippet.includes(staleValue), false, `${format} retained ${staleValue}`);
    }
  }
});

test('a generated Node multipart request sends one accurate length and no stale framing', {
  timeout: 5000
}, async t => {
  let resolveReceived;
  const received = new Promise(resolve => { resolveReceived = resolve; });
  const origin = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      resolveReceived({
        headers: request.headers,
        rawHeaders: request.rawHeaders,
        body: Buffer.concat(chunks)
      });
      response.end('ok');
    });
  });
  t.after(() => new Promise(resolve => origin.close(resolve)));
  await new Promise((resolve, reject) => {
    origin.once('error', reject);
    origin.listen(0, '127.0.0.1', resolve);
  });

  const snippet = generateExportSnippet({
    method: 'POST',
    url: `http://127.0.0.1:${origin.address().port}/multipart-framing`,
    bodyType: 'multipart',
    multipartBoundary: '----RuntimeBoundary',
    requestHeaders: {
      'Content-Length': '1',
      'Transfer-Encoding': 'chunked',
      Trailer: 'X-Stale-Trailer',
      'Content-Encoding': 'gzip',
      Connection: 'close'
    },
    formFields: [{ key: 'field', value: 'runtime multipart value', enabled: true }]
  }, 'javascript-node');
  const require = createRequire(import.meta.url);
  let resolveClientDone;
  const clientDone = new Promise(resolve => { resolveClientDone = resolve; });
  new Function('require', 'console', snippet)(require, { log: resolveClientDone });

  const [wireRequest] = await Promise.all([received, clientDone]);
  const contentLengthLines = [];
  for (let index = 0; index < wireRequest.rawHeaders.length; index += 2) {
    if (wireRequest.rawHeaders[index].toLowerCase() === 'content-length') {
      contentLengthLines.push(wireRequest.rawHeaders[index + 1]);
    }
  }
  assert.deepEqual(contentLengthLines, [String(wireRequest.body.length)]);
  assert.equal(wireRequest.headers['transfer-encoding'], undefined);
  assert.equal(wireRequest.headers.trailer, undefined);
  assert.equal(wireRequest.headers['content-encoding'], undefined);
  assert.match(wireRequest.headers['content-type'], /^multipart\/form-data; boundary=----RuntimeBoundary$/);
  assert.match(wireRequest.body.toString('utf8'), /runtime multipart value/);
});

test('Node flat header arrays retain non-contiguous case variants in scalar-pair order', () => {
  const requestHeaders = {
    'X-Test': 'first',
    'A-Between': 'middle',
    'x-test': 'second'
  };
  const pairs = normalized(getExportHeaders({ requestHeaders }));
  assert.deepEqual(pairs, [
    ['X-Test', 'first'],
    ['A-Between', 'middle'],
    ['x-test', 'second']
  ]);

  const snippet = generateExportSnippet(requestFor('raw', requestHeaders), 'javascript-node');
  const markers = [
    `${JSON.stringify('X-Test')}, ${JSON.stringify('first')}`,
    `${JSON.stringify('A-Between')}, ${JSON.stringify('middle')}`,
    `${JSON.stringify('x-test')}, ${JSON.stringify('second')}`
  ];
  const positions = markers.map(marker => snippet.indexOf(marker));
  assert.ok(positions.every(position => position >= 0));
  assert.deepEqual(positions, positions.slice().sort((a, b) => a - b));
  assert.doesNotMatch(snippet, /"X-Test"\s*:/);
});

test('a generated Node snippet sends repeated headers as separate ordered wire lines', async t => {
  let resolveHeaders;
  let rejectHeaders;
  const rawHeaders = new Promise((resolve, reject) => {
    resolveHeaders = resolve;
    rejectHeaders = reject;
  });
  const server = net.createServer(socket => {
    let received = '';
    socket.setEncoding('latin1');
    socket.setTimeout(5000, () => {
      rejectHeaders(new Error('Timed out waiting for generated request headers'));
      socket.destroy();
    });
    socket.on('error', rejectHeaders);
    socket.on('data', chunk => {
      received += chunk;
      const headerEnd = received.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      socket.setTimeout(0);
      resolveHeaders(received.slice(0, headerEnd));
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    });
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();
  let resolveClientDone;
  const clientDone = new Promise(resolve => { resolveClientDone = resolve; });
  const snippet = generateExportSnippet({
    method: 'GET',
    url: `http://127.0.0.1:${port}/raw-headers`,
    bodyType: 'raw',
    requestHeaders: {
      'X-Test': ['first value', 'second, separate value'],
      Cookie: ['first=cookie', 'second=cookie'],
      'Z-After': 'last',
      Connection: 'close'
    },
    requestBody: ''
  }, 'javascript-node');
  const require = createRequire(import.meta.url);
  new Function('require', 'console', snippet)(require, { log: resolveClientDone });

  const lines = (await rawHeaders).split('\r\n');
  assert.deepEqual(lines.filter(line => line.startsWith('X-Test:')), [
    'X-Test: first value',
    'X-Test: second, separate value'
  ]);
  assert.deepEqual(lines.filter(line => line.startsWith('Cookie:')), [
    'Cookie: first=cookie',
    'Cookie: second=cookie'
  ]);
  assert.ok(lines.indexOf('X-Test: first value') < lines.indexOf('X-Test: second, separate value'));
  assert.ok(lines.indexOf('X-Test: second, separate value') < lines.indexOf('Z-After: last'));
  await clientDone;
});
