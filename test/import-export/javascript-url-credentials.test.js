import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

import { generateExportSnippet } from '../../src/ui/request-export.js';

const require = createRequire(import.meta.url);

function requestFor(bodyType, url, requestHeaders = {}) {
  const request = {
    method: bodyType === 'multipart' ? 'POST' : 'GET',
    url,
    bodyType,
    requestHeaders
  };
  if (bodyType === 'multipart') {
    request.multipartBoundary = '----CredentialsBoundary';
    request.formFields = [{ key: 'field', value: 'value', enabled: true }];
  } else {
    request.requestBody = '';
  }
  return request;
}

function basic(username, password = '') {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

function withoutUserInfo(value) {
  const url = new URL(value);
  url.username = '';
  url.password = '';
  return url.href;
}

async function executeFetchSnippet(request) {
  const calls = [];
  class FormDataStub {
    append() {}
  }
  const context = vm.createContext({
    FormData: FormDataStub,
    document: { querySelector: () => null },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { status: 200, text: async () => 'ok' };
    },
    console: { log() {} },
    Uint8Array,
    atob
  });
  const snippet = generateExportSnippet(request, 'javascript-fetch');
  await vm.runInContext(`(async () => {\n${snippet}\n})()`, context);
  return { calls, snippet };
}

test('Fetch exports convert URL userinfo to Basic auth and honor explicit Authorization', async () => {
  const username = 'føø user@corp';
  const password = 'päss:@/?#%+';
  const credentialUrl = `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}` +
    '@example.test/resource?visible=1';

  for (const bodyType of ['raw', 'multipart']) {
    const generated = await executeFetchSnippet(requestFor(bodyType, credentialUrl));
    assert.equal(generated.calls.length, 1, bodyType);
    assert.equal(generated.calls[0].url, withoutUserInfo(credentialUrl), bodyType);
    assert.equal(generated.calls[0].options.headers.Authorization, basic(username, password), bodyType);
    assert.doesNotMatch(generated.calls[0].url, /f%C3%B8|p%C3%A4ss/i, bodyType);

    const explicitUrl = 'http://ignored:credentials@example.test/explicit';
    const explicit = await executeFetchSnippet(requestFor(bodyType, explicitUrl, {
      aUtHoRiZaTiOn: 'Bearer explicit-token'
    }));
    assert.equal(explicit.calls[0].url, withoutUserInfo(explicitUrl), bodyType);
    assert.equal(explicit.calls[0].options.headers.aUtHoRiZaTiOn, 'Bearer explicit-token', bodyType);
    assert.equal(explicit.calls[0].options.headers.Authorization, undefined, bodyType);
  }
});

test('Node exports send URL userinfo as Basic auth to a real origin and honor explicit Authorization', {
  timeout: 10000
}, async t => {
  const origin = http.createServer();
  t.after(() => {
    origin.closeAllConnections();
    return new Promise(resolve => origin.close(resolve));
  });
  await new Promise((resolve, reject) => {
    origin.once('error', reject);
    origin.listen(0, '127.0.0.1', resolve);
  });
  const port = origin.address().port;
  const username = 'føø user@corp';
  const password = 'päss:@/?#%+';

  for (const bodyType of ['raw', 'multipart']) {
    for (const scenario of [
      {
        name: 'URL credentials',
        url: `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}` +
          `@127.0.0.1:${port}/${bodyType}-basic?visible=1`,
        headers: {},
        expectedAuthorization: basic(username, password)
      },
      {
        name: 'explicit Authorization',
        url: `http://ignored:credentials@127.0.0.1:${port}/${bodyType}-explicit`,
        headers: { aUtHoRiZaTiOn: 'Bearer explicit-token' },
        expectedAuthorization: 'Bearer explicit-token'
      }
    ]) {
      const received = new Promise(resolve => {
        origin.once('request', (request, response) => {
          const chunks = [];
          request.on('data', chunk => chunks.push(chunk));
          request.on('end', () => {
            response.end('ok');
            resolve({
              authorization: request.headers.authorization,
              host: request.headers.host,
              path: request.url,
              body: Buffer.concat(chunks)
            });
          });
        });
      });
      const snippet = generateExportSnippet(
        requestFor(bodyType, scenario.url, scenario.headers),
        'javascript-node'
      );
      let resolveClientDone;
      const clientDone = new Promise(resolve => { resolveClientDone = resolve; });
      new Function('require', 'console', snippet)(require, { log: resolveClientDone });

      const [wireRequest] = await Promise.all([received, clientDone]);
      assert.equal(wireRequest.authorization, scenario.expectedAuthorization, `${bodyType}: ${scenario.name}`);
      assert.equal(wireRequest.host, `127.0.0.1:${port}`, `${bodyType}: ${scenario.name}`);
      assert.doesNotMatch(wireRequest.path, /ignored|f%C3%B8|p%C3%A4ss/i, `${bodyType}: ${scenario.name}`);
      if (bodyType === 'multipart') {
        assert.match(wireRequest.body.toString('utf8'), /name="field"\r\n\r\nvalue/);
      }
    }
  }
});

test('JavaScript exports refuse undecodable URL credentials instead of dropping them', () => {
  for (const bodyType of ['raw', 'multipart']) {
    for (const format of ['javascript-fetch', 'javascript-node']) {
      const snippet = generateExportSnippet(
        requestFor(bodyType, 'http://user%ZZ:password@example.test/private'),
        format
      );
      assert.match(snippet, /EXACT REPLAY UNAVAILABLE/, `${bodyType}: ${format}`);
      assert.match(snippet, /invalid percent-encoding/, `${bodyType}: ${format}`);
      assert.equal(snippet.includes('example.test'), false, `${bodyType}: ${format}`);
    }
  }
});
