import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { parseCurlCommand } from '../../src/ui/curl-parser.js';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const curlReplacementStart = source.indexOf('function inferCurlSendBodyFormat(');
const curlReplacementEnd = source.indexOf('function switchSendTab(', curlReplacementStart);
const loadTabStart = source.indexOf('function loadSendTabState(');
const pasteStart = source.indexOf("document.getElementById('sendUrl')?.addEventListener('paste'");
const pasteEnd = source.indexOf('// Resizer for Send panel split pane', pasteStart);

for (const boundary of [curlReplacementStart, curlReplacementEnd, loadTabStart, pasteStart, pasteEnd]) {
  assert.notEqual(boundary, -1);
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function createCurlPasteHarness() {
  const listeners = {};
  const persisted = [];
  const toasts = [];
  const elements = {
    sendUrl: {
      value: 'https://stale.example/private',
      addEventListener(type, listener) { listeners[type] = listener; }
    },
    sendMethod: { value: 'PATCH' },
    sendBodyType: { value: 'multipart' },
    sendBodyFormat: { value: 'yaml' },
    'sendBody-fallback': { value: 'stale secret body', dataset: {} },
    sendResponse: { style: { display: 'block' } },
    sendEmptyResponse: { style: { display: 'none' } },
    sendResBodyMode: { style: { display: '' } },
    sendViewInTraffic: { style: { display: 'inline-flex' }, onclick() {} }
  };
  const staleFile = { name: 'secret.txt', marker: 'stale-file-handle' };
  const initialTab = {
    id: 'tab-1',
    method: 'PATCH',
    url: elements.sendUrl.value,
    headers: [{ key: 'Authorization', value: 'Bearer stale-secret', enabled: true }],
    body: elements['sendBody-fallback'].value,
    bodyType: 'multipart',
    bodyFormat: 'yaml',
    urlEncodedFields: [{ key: 'old', value: 'encoded-secret', enabled: true, type: 'text' }],
    multipartFields: [{ key: 'upload', value: '', enabled: true, type: 'file', file: staleFile }],
    multipartBoundary: 'stale-secret-boundary',
    response: { statusCode: 201, body: 'stale response' }
  };

  const context = {
    __initialTab: initialTab,
    __initialHeaders: initialTab.headers,
    __initialUrlEncodedFields: initialTab.urlEncodedFields,
    __initialMultipartFields: initialTab.multipartFields,
    __initialBoundary: initialTab.multipartBoundary,
    __body: initialTab.body,
    __state: null,
    console,
    parseCurlCommand,
    window: { clipboardData: null },
    document: {
      getElementById(id) { return elements[id] || null; }
    },
    normalizeSendTab(tab) { return tab; },
    normalizeSendHeaderRows(headers) {
      return Object.entries(headers || {}).flatMap(([key, storedValue]) => {
        const values = Array.isArray(storedValue) ? storedValue : [storedValue];
        return values.map(value => ({ key, value: String(value), enabled: true }));
      });
    },
    cloneSendFormFields(fields) {
      return (fields || []).map(field => ({ ...field }));
    },
    renderSendHeaders() {},
    setSendBodyValue(value) {
      context.__body = value || '';
      elements['sendBody-fallback'].value = context.__body;
      elements['sendBody-fallback'].dataset.bodyInitialized = 'true';
    },
    updateSendBodyLanguage() {},
    updateSendBodyType() {},
    updateSendMethodColor() {},
    renderSendResponseStatus() {},
    setStandaloneBodyViewer() {},
    disposeBodyEditor() {},
    standaloneBodyViewers: { sendResBody: { stale: true } },
    persistSendTabs(tabs) { persisted.push(tabs.map(tab => ({ ...tab }))); },
    renderSendTabs() {},
    scheduleSendExportUpdate() {},
    toast(message, type) { toasts.push({ message, type }); }
  };

  vm.createContext(context);
  vm.runInContext(`
    let sendTabs = [__initialTab];
    let activeSendTab = 'tab-1';
    let sendHeadersList = __initialHeaders;
    let sendUrlEncodedFields = __initialUrlEncodedFields;
    let sendMultipartFields = __initialMultipartFields;
    let sendMultipartBoundary = __initialBoundary;
    ${source.slice(loadTabStart, curlReplacementStart)}
    ${source.slice(curlReplacementStart, curlReplacementEnd)}
    ${source.slice(pasteStart, pasteEnd)}
    globalThis.__state = () => ({
      tab: sendTabs[0],
      headers: sendHeadersList,
      body: globalThis.__body,
      urlEncodedFields: sendUrlEncodedFields,
      multipartFields: sendMultipartFields,
      multipartBoundary: sendMultipartBoundary
    });
  `, context);

  return {
    elements,
    initialTab,
    persisted,
    toasts,
    paste(text) {
      let prevented = false;
      listeners.paste({
        preventDefault() { prevented = true; },
        clipboardData: { getData() { return text; } }
      });
      return { prevented, state: context.__state() };
    }
  };
}

test('repeated cURL data options are joined in command order', () => {
  const result = parseCurlCommand("curl https://example.test -d 'a=1' --data-raw 'b=2' --data-binary 'c=3'");

  assert.equal(result.method, 'POST');
  assert.equal(result.body, 'a=1&b=2&c=3');
  assert.equal(result.headers['Content-Type'], 'application/x-www-form-urlencoded');
});

test('explicit cURL methods stay authoritative with data in either option order', () => {
  const cases = [
    ["curl -X GET https://example.test -d 'q=one'", 'GET', 'q=one'],
    ["curl --data 'q=one' --request GET https://example.test", 'GET', 'q=one'],
    ["curl -X HEAD https://example.test --data-binary 'payload'", 'HEAD', 'payload'],
    ["curl --data-urlencode 'q=hello world' -X PROPFIND https://example.test", 'PROPFIND', 'q=hello+world']
  ];

  for (const [command, method, body] of cases) {
    const result = parseCurlCommand(command);
    assert.equal(result.method, method, command);
    assert.equal(result.body, body, command);
    assert.equal(result.hasData, true, command);
  }
});

test('data promotes only the implicit default method to POST', () => {
  for (const option of [
    "-d 'value'",
    "--data 'value'",
    "--data-ascii 'value'",
    "--data-raw 'value'",
    "--data-binary 'value'",
    "--data-urlencode 'value'"
  ]) {
    const result = parseCurlCommand(`curl ${option} https://example.test`);
    assert.equal(result.method, 'POST', option);
    assert.equal(result.hasData, true, option);
  }

  const controlsOnly = parseCurlCommand(
    "curl -H 'X-Test: one' -A agent -b session=one -u user:pass https://example.test"
  );
  assert.equal(controlsOnly.method, 'GET');
  assert.equal(controlsOnly.hasData, false);
  assert.equal(controlsOnly.body, '');
});

test('the last explicit cURL request option wins without later data promotion', () => {
  const cases = [
    ["curl -X PUT -d 'value' --request GET https://example.test", 'GET'],
    ["curl --data 'value' -X HEAD -X PATCH https://example.test", 'PATCH'],
    ["curl -X GET --data 'value' -X DELETE --data-raw 'again' https://example.test", 'DELETE']
  ];

  for (const [command, method] of cases) {
    assert.equal(parseCurlCommand(command).method, method, command);
  }
});

test('supported cURL options accept attached short and equals-style long values', () => {
  const result = parseCurlCommand(
    "curl -XPOST -H'X-Short: one' --header='X-Long: two' " +
    "-dalpha=one --data=beta=two --data-ascii=gamma=three " +
    "--data-raw=@literal --data-binary=bytes " +
    "--data-urlencode='space=hello world' -Ashort-agent --user-agent=long-agent " +
    "-bsession=short --cookie=session=long -ushort:secret --user=long:secret " +
    'https://example.test/path'
  );

  assert.equal(result.method, 'POST');
  assert.equal(result.url, 'https://example.test/path');
  assert.equal(
    result.body,
    'alpha=one&beta=two&gamma=three&@literal&bytes&space=hello+world'
  );
  assert.deepEqual(plain(result.headers), {
    'X-Short': 'one',
    'X-Long': 'two',
    'User-Agent': 'long-agent',
    Cookie: 'session=long',
    Authorization: 'Basic ' + Buffer.from('long:secret').toString('base64'),
    'Content-Type': 'application/x-www-form-urlencoded'
  });

  assert.equal(
    parseCurlCommand("curl -XGET --data=value https://example.test").method,
    'GET'
  );
  assert.equal(
    parseCurlCommand("curl --data=value --request=HEAD https://example.test").method,
    'HEAD'
  );
  assert.equal(
    parseCurlCommand("curl -XPUT --request=PROPFIND -dvalue https://example.test").method,
    'PROPFIND'
  );
});

test('unsupported cURL options fail before their operands can become the URL', () => {
  const cases = [
    ['curl --proxy http://proxy.example:3128 https://target.example/path', '--proxy'],
    ['curl --proxy=http://proxy.example:3128 https://target.example/path', '--proxy'],
    ['curl --compressed https://target.example/path', '--compressed'],
    ['curl -xhttp://proxy.example:3128 https://target.example/path', '-x'],
    ["curl -F 'name=value' https://target.example/path", '-F'],
    ['curl -v https://target.example/path', '-v']
  ];

  for (const [command, option] of cases) {
    const result = parseCurlCommand(command);
    assert.deepEqual(Object.keys(result), ['error'], command);
    assert.match(result.error, new RegExp(`^Unsupported cURL option: ${option.replace('-', '\\-')}`), command);
    assert.match(result.error, /Remove it before pasting/, command);
  }
});

test('supported cURL options report truly missing values', () => {
  for (const option of [
    '-X', '--request',
    '-H', '--header',
    '-d', '--data', '--data-ascii', '--data-raw', '--data-binary', '--data-urlencode',
    '-A', '--user-agent',
    '-b', '--cookie',
    '-u', '--user'
  ]) {
    const result = parseCurlCommand(`curl https://example.test ${option}`);
    assert.match(result.error, new RegExp(`^Missing value for cURL option: ${option.replace('-', '\\-')}$`), option);
  }

  for (const command of [
    "curl -X '' https://example.test",
    'curl --request= https://example.test'
  ]) {
    assert.match(parseCurlCommand(command).error, /^Missing value for cURL option:/, command);
  }
});

test('required option values may look like options, matching cURL argument consumption', () => {
  const data = parseCurlCommand('curl --data --compressed https://example.test');
  assert.equal(data.method, 'POST');
  assert.equal(data.body, '--compressed');
  assert.equal(data.url, 'https://example.test');

  const attached = parseCurlCommand('curl --data=-leading-dash https://example.test');
  assert.equal(attached.body, '-leading-dash');

  const method = parseCurlCommand('curl --request -custom https://example.test');
  assert.equal(method.method, '-CUSTOM');
  assert.equal(method.url, 'https://example.test');
});

test('the option terminator protects dash-prefixed URLs and multiple URLs fail explicitly', () => {
  const dashUrl = parseCurlCommand('curl -- -https://example.test/path');
  assert.equal(dashUrl.url, '-https://example.test/path');
  assert.equal(dashUrl.method, 'GET');

  assert.match(
    parseCurlCommand('curl https://one.example https://two.example').error,
    /Multiple cURL URLs/
  );
  assert.match(
    parseCurlCommand('curl https://one.example -- -https://two.example').error,
    /Multiple cURL URLs/
  );
  assert.match(parseCurlCommand('curl -- ').error, /missing a destination URL/);
  assert.match(
    parseCurlCommand("curl 'https://unterminated.example").error,
    /unterminated quote/
  );
});

test('--data-urlencode encodes values before joining them', () => {
  const result = parseCurlCommand(
    "curl https://example.test --data-urlencode 'name=hello world!' --data-urlencode '=plain value' --data-urlencode 'emoji=✓' --data-urlencode 'whole/value'"
  );

  assert.equal(result.body, 'name=hello+world%21&plain+value&emoji=%E2%9C%93&whole%2Fvalue');
});

test('quoted Windows backslashes and Unicode basic auth survive parsing', () => {
  const result = parseCurlCommand(
    String.raw`curl https://example.test -d 'C:\temp\file' --data-raw "D:\other\file" -u 'føø:päss'`
  );

  assert.equal(result.body, String.raw`C:\temp\file&D:\other\file`);
  assert.equal(result.headers.Authorization, 'Basic ' + Buffer.from('føø:päss', 'utf8').toString('base64'));
});

test('an explicitly empty data argument does not consume the following option', () => {
  const result = parseCurlCommand(
    "curl https://example.test -d '' -H 'X-After: retained'"
  );

  assert.equal(result.method, 'POST');
  assert.equal(result.body, '');
  assert.equal(result.hasData, true);
  assert.equal(result.headers['X-After'], 'retained');
});

test('repeated data separators match curl when parts are empty', () => {
  assert.equal(parseCurlCommand("curl https://example.test -d '' -d 'x=1'").body, 'x=1');
  assert.equal(parseCurlCommand("curl https://example.test -d 'x=1' -d ''").body, 'x=1&');
  assert.equal(parseCurlCommand("curl https://example.test -d '' -d ''").body, '');
  assert.equal(parseCurlCommand("curl https://example.test -d 'x=1' -d '' -d 'y=2'").body, 'x=1&&y=2');
});

test('explicit Content-Type matching is case-insensitive', () => {
  const result = parseCurlCommand(
    "curl https://example.test -H 'content-type: application/json' -d '{}'"
  );

  assert.deepEqual(
    JSON.parse(JSON.stringify(result.headers)),
    { 'content-type': 'application/json' }
  );
});

test('prototype-named cURL headers remain own fields with repeated values', () => {
  const result = parseCurlCommand(
    "curl https://example.test -H '__proto__: first' -H '__proto__: second' " +
    "-H 'constructor: ctor' -H 'toString: text'"
  );

  assert.equal(Object.getPrototypeOf(result.headers), null);
  assert.deepEqual(result.headers.__proto__, ['first', 'second']);
  assert.equal(result.headers.constructor, 'ctor');
  assert.equal(result.headers.toString, 'text');
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.headers)),
    JSON.parse('{"__proto__":["first","second"],"constructor":"ctor","toString":"text"}')
  );
});

test('file-backed data is rejected instead of being imported as literal text', () => {
  for (const command of [
    'curl https://example.test -d @payload.txt',
    'curl https://example.test -d@payload.txt',
    'curl https://example.test --data-binary @payload.bin',
    'curl https://example.test --data-binary=@payload.bin',
    'curl https://example.test --data-urlencode name@payload.txt'
  ]) {
    assert.match(parseCurlCommand(command).error, /File-backed/);
  }

  const raw = parseCurlCommand('curl https://example.test --data-raw @literal');
  assert.equal(raw.body, '@literal');
  assert.equal(raw.error, undefined);
});

test('headerless and bodyless cURL paste replaces every prior request field', () => {
  const harness = createCurlPasteHarness();
  const { prevented, state } = harness.paste('curl https://other.example.test/path');

  assert.equal(prevented, true);
  assert.equal(state.tab.id, 'tab-1');
  assert.equal(state.tab.method, 'GET');
  assert.equal(state.tab.url, 'https://other.example.test/path');
  assert.deepEqual(plain(state.headers), []);
  assert.equal(state.body, '');
  assert.equal(state.tab.bodyType, 'raw');
  assert.equal(state.tab.bodyFormat, 'text');
  assert.deepEqual(plain(state.urlEncodedFields), []);
  assert.deepEqual(plain(state.multipartFields), []);
  assert.equal(state.multipartBoundary, '');
  assert.equal(state.tab.response, null);
  assert.equal(harness.elements.sendResponse.style.display, 'none');
  assert.equal(harness.elements.sendEmptyResponse.style.display, 'flex');
  assert.equal(harness.elements.sendViewInTraffic.style.display, 'none');
  assert.equal(harness.persisted.length, 1);
  assert.deepEqual(plain(harness.persisted[0][0].headers), []);
});

test('cURL paste preserves the parsed raw body while replacing stale form modes', () => {
  const harness = createCurlPasteHarness();
  const { state } = harness.paste(
    `curl https://json.example.test/submit -u 'fresh:credential' ` +
    `-H 'Content-Type: application/json' --data-raw '{"fresh":true}'`
  );

  assert.equal(state.tab.method, 'POST');
  assert.equal(state.tab.url, 'https://json.example.test/submit');
  assert.equal(state.body, '{"fresh":true}');
  assert.equal(state.tab.bodyType, 'raw');
  assert.equal(state.tab.bodyFormat, 'json');
  assert.deepEqual(plain(state.urlEncodedFields), []);
  assert.deepEqual(plain(state.multipartFields), []);
  assert.equal(state.multipartBoundary, '');
  assert.deepEqual(
    plain(state.headers.map(({ key, value }) => [key, value])),
    [
      ['Authorization', 'Basic ' + Buffer.from('fresh:credential').toString('base64')],
      ['Content-Type', 'application/json']
    ]
  );
});

test('explicitly empty cURL data clears a previous body without losing POST semantics', () => {
  const harness = createCurlPasteHarness();
  const { state } = harness.paste("curl https://empty.example.test/ -d ''");

  assert.equal(state.tab.method, 'POST');
  assert.equal(state.body, '');
  assert.equal(state.tab.bodyType, 'raw');
  assert.deepEqual(
    plain(state.headers.map(({ key, value }) => [key, value])),
    [['Content-Type', 'application/x-www-form-urlencoded']]
  );
});

test('cURL paste keeps explicit GET with a body in either option order', () => {
  for (const command of [
    "curl -X GET https://get.example.test/items --data 'q=one'",
    "curl --data 'q=one' --request GET https://get.example.test/items"
  ]) {
    const harness = createCurlPasteHarness();
    const { prevented, state } = harness.paste(command);

    assert.equal(prevented, true, command);
    assert.equal(state.tab.method, 'GET', command);
    assert.equal(harness.elements.sendMethod.value, 'GET', command);
    assert.equal(state.body, 'q=one', command);
    assert.equal(state.tab.bodyType, 'raw', command);
    assert.equal(state.tab.response, null, command);
    assert.equal(harness.persisted.length, 1, command);
    assert.equal(harness.persisted[0][0].method, 'GET', command);
  }
});

test('cURL paste applies attached supported options without losing BUG-407 method semantics', () => {
  const harness = createCurlPasteHarness();
  const { prevented, state } = harness.paste(
    "curl --data=q=one --request=GET -H'X-Mode: attached' https://attached.example/items"
  );

  assert.equal(prevented, true);
  assert.equal(state.tab.method, 'GET');
  assert.equal(state.tab.url, 'https://attached.example/items');
  assert.equal(state.body, 'q=one');
  assert.deepEqual(
    plain(state.headers.map(({ key, value }) => [key, value])),
    [
      ['X-Mode', 'attached'],
      ['Content-Type', 'application/x-www-form-urlencoded']
    ]
  );
  assert.equal(harness.persisted.length, 1);
  assert.equal(harness.toasts[0].type, 'success');
});

test('unsupported, malformed, and multi-URL cURL pastes leave Send state atomic', () => {
  for (const command of [
    'curl --proxy http://proxy.example:3128 https://target.example/path',
    'curl https://target.example/path --request',
    'curl https://one.example https://two.example',
    "curl 'https://unterminated.example"
  ]) {
    const harness = createCurlPasteHarness();
    const { prevented, state } = harness.paste(command);

    assert.equal(prevented, true, command);
    assert.strictEqual(state.tab, harness.initialTab, command);
    assert.strictEqual(state.headers, harness.initialTab.headers, command);
    assert.equal(state.body, 'stale secret body', command);
    assert.equal(harness.elements.sendMethod.value, 'PATCH', command);
    assert.equal(harness.elements.sendUrl.value, 'https://stale.example/private', command);
    assert.equal(harness.persisted.length, 0, command);
    assert.equal(harness.toasts.length, 1, command);
    assert.equal(harness.toasts[0].type, 'error', command);
  }
});

test('a rejected cURL paste leaves the entire active request unchanged', () => {
  const harness = createCurlPasteHarness();
  const { state } = harness.paste('curl https://other.example.test -d @secret.txt');

  assert.equal(state.tab, harness.initialTab);
  assert.equal(state.body, 'stale secret body');
  assert.equal(state.multipartFields[0].file.marker, 'stale-file-handle');
  assert.equal(harness.persisted.length, 0);
  assert.match(harness.toasts[0].message, /File-backed/);
  assert.equal(harness.toasts[0].type, 'error');
});
