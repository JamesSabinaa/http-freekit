import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ApiServer } from '../src/api/api-server.js';
import { ProxyServer } from '../src/proxy/proxy-server.js';
import { Settings } from '../src/settings.js';

function requestJson(port, method, pathname, body = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
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

async function createHarness(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-bug-352-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const settings = new Settings(dataDir);
  const proxy = new ProxyServer(null);
  const api = new ApiServer(proxy, null, null);
  api.settings = settings;
  const server = http.createServer(api.app);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { dataDir, settings, proxy, port: server.address().port };
}

test('the item API preserves a supplied passphrase through persistence and restart', async t => {
  const { dataDir, settings, proxy, port } = await createHarness(t);
  const pfxPath = path.join(dataDir, 'client.pfx');
  fs.writeFileSync(pfxPath, Buffer.from('encrypted-pfx-placeholder'));
  const passphrase = '  exact secret with spaces  ';

  const added = await requestJson(port, 'POST', '/api/client-certificates/items', {
    host: 'secure.example.test',
    pfxPath,
    passphrase
  });

  assert.equal(added.statusCode, 200);
  assert.deepEqual(added.body.certificates, [{ host: 'secure.example.test', pfxPath }]);
  assert.deepEqual(proxy.clientCertificates, [{ host: 'secure.example.test', pfxPath, passphrase }]);
  assert.deepEqual(settings.get('clientCertificates'), proxy.clientCertificates);

  const restartedSettings = new Settings(dataDir);
  const restartedProxy = new ProxyServer(null);
  restartedProxy.setClientCertificates(restartedSettings.get('clientCertificates'));
  const options = restartedProxy._getClientCertificateOptions('secure.example.test');

  assert.deepEqual(options.pfx, Buffer.from('encrypted-pfx-placeholder'));
  assert.equal(options.passphrase, passphrase);
});

test('same-host replacements update explicit passphrases and preserve omitted ones', async t => {
  const { dataDir, proxy, port } = await createHarness(t);
  const pfxPath = path.join(dataDir, 'replacement.pfx');
  fs.writeFileSync(pfxPath, Buffer.from('replacement-pfx'));

  let response = await requestJson(port, 'POST', '/api/client-certificates/items', {
    host: 'secure.example.test',
    pfxPath,
    passphrase: 'first secret'
  });
  assert.equal(response.statusCode, 200);

  response = await requestJson(port, 'POST', '/api/client-certificates/items', {
    host: 'secure.example.test',
    pfxPath,
    passphrase: 'replacement secret'
  });
  assert.equal(response.statusCode, 200);
  assert.equal(proxy.clientCertificates[0].passphrase, 'replacement secret');

  response = await requestJson(port, 'POST', '/api/client-certificates/items', {
    host: 'SECURE.EXAMPLE.TEST.',
    pfxPath
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(proxy.clientCertificates, [{
    host: 'SECURE.EXAMPLE.TEST.',
    pfxPath,
    passphrase: 'replacement secret'
  }]);
  assert.equal(
    proxy._getClientCertificateOptions('secure.example.test').passphrase,
    'replacement secret'
  );
});

test('certificate list responses do not expose persisted passphrases', async t => {
  const { proxy, port } = await createHarness(t);
  proxy.clientCertificates = [{
    host: 'secure.example.test',
    pfxPath: 'client.pfx',
    passphrase: 'do not return me'
  }];

  const response = await requestJson(port, 'GET', '/api/client-certificates');

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.certificates, [{
    host: 'secure.example.test',
    pfxPath: 'client.pfx'
  }]);
  assert.equal(JSON.stringify(response.body).includes('do not return me'), false);
});

test('the item API rejects non-string passphrases without mutating configuration', async t => {
  const { settings, proxy, port } = await createHarness(t);

  for (const passphrase of [null, 123, true, {}, []]) {
    const response = await requestJson(port, 'POST', '/api/client-certificates/items', {
      host: 'secure.example.test',
      pfxPath: 'client.pfx',
      passphrase
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.body.error, /passphrase must be a string/);
  }

  assert.deepEqual(proxy.clientCertificates, []);
  assert.equal(settings.get('clientCertificates'), undefined);
});

test('the client-certificate form sends and clears a password input without rendering secrets', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'index.html'), 'utf8');
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
  const start = source.indexOf('async function addClientCert');
  const end = source.indexOf('async function removeClientCert', start);
  const addSource = source.slice(start, end);
  const renderStart = source.indexOf('function renderClientCerts');
  const renderEnd = source.indexOf('async function selectCertificatePath', renderStart);
  const renderSource = source.slice(renderStart, renderEnd);

  assert.match(html, /<input type="password" id="clientCertPassphrase"/);
  assert.match(addSource, /const passphrase = passphraseInput\?\.value \?\? '';/);
  assert.doesNotMatch(addSource, /passphraseInput\?\.value\?\.trim/);
  assert.match(addSource, /\{ passphrase \}/);
  assert.match(addSource, /if \(!response\.ok\)[\s\S]*passphraseInput\.value = '';/);
  assert.doesNotMatch(renderSource, /passphrase/);
});
