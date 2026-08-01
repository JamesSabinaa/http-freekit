import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../src/ui/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function getExportFormFields');
const end = source.indexOf('function autoSizeExportEditor', start);
const generators = vm.runInNewContext(
  `(() => { ${source.slice(start, end)}; return { generateExportSnippet, getExportHeaders }; })()`,
  {
    URL,
    URLSearchParams,
    console,
    findHeaderKey: (headers, name) => Object.keys(headers || {})
      .find(key => key.toLowerCase() === name.toLowerCase())
  }
);

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
  const headers = generators.getExportHeaders({
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
        const snippet = generators.generateExportSnippet(requestFor(bodyType, repeatedHeaders), format);

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
      const snippet = generators.generateExportSnippet(requestFor(bodyType, {
        'X-Scalar': "solo ' \\ value"
      }), format);
      assert.doesNotMatch(snippet, /EXACT REPLAY UNAVAILABLE/, format);
      assert.ok(snippet.includes(headerMarker(format, 'X-Scalar', "solo ' \\ value")), format);
    }
  });
}

test('excluded repeated headers do not cause refusals or leak into snippets', () => {
  for (const format of formats) {
    const raw = generators.generateExportSnippet(requestFor('raw', {
      Host: ['ignored-host-1', 'ignored-host-2'],
      'Proxy-Connection': ['ignored-proxy-1', 'ignored-proxy-2'],
      'X-Scalar': 'kept'
    }), format);
    assert.doesNotMatch(raw, /EXACT REPLAY UNAVAILABLE/, format);
    assert.equal(raw.includes('ignored-host'), false, format);
    assert.equal(raw.includes('ignored-proxy'), false, format);

    const multipart = generators.generateExportSnippet(requestFor('multipart', {
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

test('Node flat header arrays retain non-contiguous case variants in scalar-pair order', () => {
  const requestHeaders = {
    'X-Test': 'first',
    'A-Between': 'middle',
    'x-test': 'second'
  };
  const pairs = normalized(generators.getExportHeaders({ requestHeaders }));
  assert.deepEqual(pairs, [
    ['X-Test', 'first'],
    ['A-Between', 'middle'],
    ['x-test', 'second']
  ]);

  const snippet = generators.generateExportSnippet(requestFor('raw', requestHeaders), 'javascript-node');
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
  const snippet = generators.generateExportSnippet({
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
