import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ApiServer } from '../src/api/api-server.js';
import { ProxyServer } from '../src/proxy/proxy-server.js';
import { Settings } from '../src/settings.js';

function requestJson(port, method, pathname, body) {
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
      response.on('end', () => {
        const responseText = Buffer.concat(chunks).toString('utf8');
        let responseBody = responseText;
        try { responseBody = JSON.parse(responseText); } catch {}
        resolve({ statusCode: response.statusCode, body: responseBody });
      });
    });
    request.once('error', reject);
    request.end(payload);
  });
}

async function createHarness(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-bug-351-'));
  const certificatePath = (name, contents) => {
    const filePath = path.join(dataDir, name);
    fs.writeFileSync(filePath, contents);
    return filePath;
  };
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
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { certificatePath, dataDir, proxy, settings, port: server.address().port };
}

test('item additions replace the normalized host in place and persist one active certificate', async t => {
  const { certificatePath, proxy, settings, port } = await createHarness(t);
  const beforePath = certificatePath('before.pfx', 'before-certificate');
  const oldPath = certificatePath('old.pfx', 'old-certificate');
  const replacementPath = certificatePath('replacement.pfx', 'replacement-certificate');
  const wildcardPath = certificatePath('wildcard.pfx', 'wildcard-certificate');
  const wildcardReplacementPath = certificatePath(
    'wildcard-replacement.pfx',
    'wildcard-replacement-certificate'
  );
  const afterPath = certificatePath('after.pfx', 'after-certificate');
  const appendedPath = certificatePath('appended.pfx', 'appended-certificate');
  const initial = [
    { host: 'before.example.test', pfxPath: beforePath },
    { host: ' API.EXAMPLE.TEST. ', pfxPath: oldPath },
    { host: '*', pfxPath: wildcardPath },
    { host: 'after.example.test', pfxPath: afterPath }
  ];
  proxy.setClientCertificates(initial);
  settings.set('clientCertificates', initial);

  const result = await requestJson(port, 'POST', '/api/client-certificates/items', {
    host: 'api.example.test',
    pfxPath: replacementPath
  });

  const replacedExact = [
    initial[0],
    { host: 'api.example.test', pfxPath: replacementPath },
    initial[2],
    initial[3]
  ];
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body.certificates, replacedExact);
  assert.deepEqual(
    proxy._getClientCertificateOptions('API.EXAMPLE.TEST.').pfx,
    Buffer.from('replacement-certificate')
  );

  const wildcardResult = await requestJson(port, 'POST', '/api/client-certificates/items', {
    host: ' * ',
    pfxPath: wildcardReplacementPath
  });
  const replacedWildcard = [
    replacedExact[0],
    replacedExact[1],
    { host: '*', pfxPath: wildcardReplacementPath },
    replacedExact[3]
  ];
  assert.equal(wildcardResult.statusCode, 200);
  assert.deepEqual(wildcardResult.body.certificates, replacedWildcard);
  assert.deepEqual(
    proxy._getClientCertificateOptions('api.example.test').pfx,
    Buffer.from('replacement-certificate')
  );
  assert.deepEqual(
    proxy._getClientCertificateOptions('unmatched.example.test').pfx,
    Buffer.from('wildcard-replacement-certificate')
  );

  const appendResult = await requestJson(port, 'POST', '/api/client-certificates/items', {
    host: 'new.example.test',
    pfxPath: appendedPath
  });
  const expected = [
    ...replacedWildcard,
    { host: 'new.example.test', pfxPath: appendedPath }
  ];
  assert.equal(appendResult.statusCode, 200);
  assert.deepEqual(appendResult.body.certificates, expected);
  assert.deepEqual(proxy.clientCertificates, expected);
  assert.deepEqual(settings.get('clientCertificates'), expected);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(settings.filePath, 'utf8')).clientCertificates,
    expected
  );

  const restartedProxy = new ProxyServer(null);
  restartedProxy.setClientCertificates(settings.get('clientCertificates'));
  assert.deepEqual(restartedProxy.clientCertificates, expected);
  assert.deepEqual(
    restartedProxy._getClientCertificateOptions('api.example.test').pfx,
    Buffer.from('replacement-certificate')
  );
});

test('legacy duplicate certificate owners keep the last value in the first owner position', t => {
  const { certificatePath, dataDir, proxy } = createSynchronousHarness(t);
  const wildcardOld = { host: '*', pfxPath: certificatePath('wildcard-old.pfx', 'wildcard-old') };
  const exactOld = { host: 'API.EXAMPLE.TEST.', pfxPath: certificatePath('exact-old.pfx', 'exact-old') };
  const unrelated = { host: 'other.example.test', pfxPath: certificatePath('other.pfx', 'other') };
  const exactNew = { host: ' api.example.test ', pfxPath: certificatePath('exact-new.pfx', 'exact-new') };
  const wildcardNew = { host: ' * ', pfxPath: certificatePath('wildcard-new.pfx', 'wildcard-new') };

  proxy.setClientCertificates([wildcardOld, exactOld, unrelated, exactNew, wildcardNew]);

  assert.deepEqual(proxy.clientCertificates, [wildcardNew, exactNew, unrelated]);
  assert.deepEqual(
    proxy._getClientCertificateOptions('api.example.test').pfx,
    Buffer.from('exact-new')
  );
  assert.deepEqual(
    proxy._getClientCertificateOptions('unmatched.example.test').pfx,
    Buffer.from('wildcard-new')
  );

  const missingReplacement = path.join(dataDir, 'missing-replacement.pfx');
  proxy.setClientCertificates([
    { host: 'secure.example.test', pfxPath: exactOld.pfxPath },
    { host: 'SECURE.EXAMPLE.TEST.', pfxPath: missingReplacement }
  ]);
  assert.deepEqual(proxy.clientCertificates, [
    { host: 'SECURE.EXAMPLE.TEST.', pfxPath: missingReplacement }
  ]);
  assert.deepEqual(proxy._getClientCertificateOptions('secure.example.test'), {});
});

function createSynchronousHarness(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-bug-351-unit-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return {
    dataDir,
    proxy: new ProxyServer(null),
    certificatePath(name, contents) {
      const filePath = path.join(dataDir, name);
      fs.writeFileSync(filePath, contents);
      return filePath;
    }
  };
}

test('failed replacement persistence restores the prior reference, TLS options, and settings', async t => {
  const { certificatePath, proxy, settings, port } = await createHarness(t);
  const oldPath = certificatePath('old.pfx', 'old-certificate');
  const replacementPath = certificatePath('replacement.pfx', 'replacement-certificate');
  const initial = [{ host: 'api.example.test', pfxPath: oldPath, passphrase: 'old-secret' }];
  proxy.setClientCertificates(initial);
  settings.set('clientCertificates', structuredClone(initial));
  const previousCertificates = proxy.clientCertificates;
  const previousSettings = settings.get('clientCertificates');
  const previousFile = fs.readFileSync(settings.filePath, 'utf8');
  settings._save = () => { throw new Error('disk full'); };

  const result = await requestJson(port, 'POST', '/api/client-certificates/items', {
    host: 'API.EXAMPLE.TEST.',
    pfxPath: replacementPath
  });

  assert.equal(result.statusCode, 500);
  assert.equal(proxy.clientCertificates, previousCertificates);
  assert.deepEqual(proxy.clientCertificates, initial);
  const restoredOptions = proxy._getClientCertificateOptions('api.example.test');
  assert.deepEqual(restoredOptions.pfx, Buffer.from('old-certificate'));
  assert.equal(restoredOptions.passphrase, 'old-secret');
  assert.equal(settings.get('clientCertificates'), previousSettings);
  assert.deepEqual(settings.get('clientCertificates'), initial);
  assert.equal(fs.readFileSync(settings.filePath, 'utf8'), previousFile);
});
