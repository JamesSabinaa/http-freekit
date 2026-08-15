import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import forge from 'node-forge';

import { ApiServer } from '../../src/api/api-server.js';
import {
  MAX_TLS_MATERIAL_ENTRIES,
  restoreSavedTlsMaterialSettings
} from '../../src/proxy/tls-material-config.js';
import { ProxyServer } from '../../src/proxy/proxy-server.js';
import { Settings } from '../../src/settings.js';
import { tlsMaterialValidationStubs } from '../fixtures/tls-material-validation-stubs.js';

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
        const text = Buffer.concat(chunks).toString('utf8');
        let responseBody = text;
        try { responseBody = JSON.parse(text); } catch {}
        resolve({ statusCode: response.statusCode, body: responseBody });
      });
    });
    request.once('error', reject);
    request.end(payload);
  });
}

function fixtureFile(dataDir, name, contents) {
  const filePath = path.join(dataDir, name);
  fs.writeFileSync(filePath, contents);
  return filePath;
}

function readTlsMaterial(filePath, encoding) {
  if (filePath.endsWith('.denied')) {
    const error = new Error('simulated permission denial');
    error.code = 'EACCES';
    throw error;
  }
  return fs.readFileSync(filePath, encoding);
}

async function createHarness(t, proxyOptions = tlsMaterialValidationStubs) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-tls-material-'));
  const settings = new Settings(dataDir);
  const proxy = new ProxyServer(null, {
    ...proxyOptions,
    readTlsMaterialFileSync: readTlsMaterial
  });
  const api = new ApiServer(proxy, null, null);
  api.settings = settings;
  const server = http.createServer(api.app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return {
    dataDir,
    settings,
    proxy,
    port: server.address().port,
    fixture: (name, contents) => fixtureFile(dataDir, name, contents)
  };
}

function generateKeyPair() {
  return new Promise((resolve, reject) => {
    forge.pki.rsa.generateKeyPair({ bits: 2048 }, (error, keys) => {
      if (error) reject(error);
      else resolve(keys);
    });
  });
}

async function createUsableTlsMaterial(dataDir, passphrase = 'correct secret') {
  const keys = await generateKeyPair();
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = '01';
  certificate.validity.notBefore = new Date(Date.now() - 60_000);
  certificate.validity.notAfter = new Date(Date.now() + 86_400_000);
  const attributes = [{ name: 'commonName', value: 'TLS material test CA' }];
  certificate.setSubject(attributes);
  certificate.setIssuer(attributes);
  certificate.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, digitalSignature: true },
    { name: 'subjectKeyIdentifier' }
  ]);
  certificate.sign(keys.privateKey, forge.md.sha256.create());

  const caPem = forge.pki.certificateToPem(certificate);
  const pfxAsn1 = forge.pkcs12.toPkcs12Asn1(
    keys.privateKey,
    [certificate],
    passphrase,
    { algorithm: '3des' }
  );
  const pfxPath = fixtureFile(
    dataDir,
    'usable.pfx',
    Buffer.from(forge.asn1.toDer(pfxAsn1).getBytes(), 'binary')
  );
  const certificateOnlyPfx = forge.pkcs12.toPkcs12Asn1(
    null,
    [certificate],
    passphrase,
    { algorithm: '3des' }
  );
  const certificateOnlyPfxPath = fixtureFile(
    dataDir,
    'certificate-only.pfx',
    Buffer.from(forge.asn1.toDer(certificateOnlyPfx).getBytes(), 'binary')
  );
  return { caPem, certificateOnlyPfxPath, passphrase, pfxPath };
}

function captureRuntime(proxy) {
  return {
    clientCertificates: proxy.clientCertificates,
    clientOptions: proxy._clientCertificateOptions,
    trustedCAs: proxy.trustedCAs,
    trustedCertificates: proxy._trustedCaCertificates
  };
}

function assertRuntimeIdentity(proxy, previous) {
  assert.equal(proxy.clientCertificates, previous.clientCertificates);
  assert.equal(proxy._clientCertificateOptions, previous.clientOptions);
  assert.equal(proxy.trustedCAs, previous.trustedCAs);
  assert.equal(proxy._trustedCaCertificates, previous.trustedCertificates);
}

function installBaseline(proxy, pfxPath, caPath) {
  proxy.setClientCertificates([{
    host: 'before.example.test',
    pfxPath,
    passphrase: 'before-secret'
  }]);
  proxy.setTrustedCAs([caPath]);
}

function countConnectionResets(proxy) {
  const counts = { agents: 0, sessions: 0 };
  proxy._destroyUpstreamAgent = () => { counts.agents++; };
  proxy._closeAllH2Sessions = () => { counts.sessions++; };
  return counts;
}

test('readable TLS material is cryptographically validated before every mutation boundary',
  async t => {
    const { dataDir, proxy, settings, port, fixture } = await createHarness(t, {});
    const {
      caPem,
      certificateOnlyPfxPath,
      passphrase,
      pfxPath
    } = await createUsableTlsMaterial(dataDir);
    const commentedCaPath = fixture(
      'commented-ca.pem',
      `# Local trust bundle\nGenerated for compatibility testing\n${caPem}# End bundle\n`
    );
    const malformedPfxPath = fixture('readable-invalid.pfx', Buffer.from('ordinary text'));
    const textCaPath = fixture('readable-invalid-ca.pem', 'ordinary text');
    const incompleteCaPath = fixture(
      'incomplete-ca.pem',
      `${caPem}\n-----BEGIN CERTIFICATE-----\ntruncated`
    );

    proxy.setClientCertificates([{
      host: 'before.example.test',
      pfxPath,
      passphrase
    }]);
    proxy.setTrustedCAs([commentedCaPath]);
    assert.match(proxy._trustedCaCertificates[0], /Generated for compatibility testing/);
    settings.setAll({
      clientCertificates: proxy.clientCertificates,
      trustedCAs: proxy.trustedCAs
    });
    const previous = captureRuntime(proxy);
    const beforeSettings = fs.readFileSync(settings.filePath);
    const resets = countConnectionResets(proxy);

    for (const candidate of [
      [{ host: 'invalid.example.test', pfxPath: malformedPfxPath }],
      [{ host: 'invalid.example.test', pfxPath: certificateOnlyPfxPath, passphrase }],
      [{ host: 'invalid.example.test', pfxPath, passphrase: 'wrong secret' }]
    ]) {
      assert.throws(
        () => proxy.setClientCertificates(candidate),
        error => error?.code === 'ERR_INVALID_TLS_MATERIAL_CONFIG' && /usable PFX/.test(error.message)
      );
      assertRuntimeIdentity(proxy, previous);
    }
    for (const candidate of [[textCaPath], [incompleteCaPath]]) {
      assert.throws(
        () => proxy.setTrustedCAs(candidate),
        error => error?.code === 'ERR_INVALID_TLS_MATERIAL_CONFIG' && /usable PEM/.test(error.message)
      );
      assertRuntimeIdentity(proxy, previous);
    }

    for (const [pathname, body, message] of [
      ['/api/client-certificates', {
        certificates: [{ host: 'invalid.example.test', pfxPath: malformedPfxPath }]
      }, /usable PFX/],
      ['/api/client-certificates', {
        certificates: [{
          host: 'invalid.example.test',
          pfxPath: certificateOnlyPfxPath,
          passphrase
        }]
      }, /usable PFX/],
      ['/api/client-certificates', {
        certificates: [{ host: 'invalid.example.test', pfxPath, passphrase: 'wrong secret' }]
      }, /usable PFX/],
      ['/api/trusted-cas', { cas: [textCaPath] }, /usable PEM/],
      ['/api/trusted-cas', { cas: [incompleteCaPath] }, /usable PEM/]
    ]) {
      const response = await requestJson(port, 'POST', pathname, body);
      assert.equal(response.statusCode, 400, pathname);
      assert.match(response.body.error, message);
      assertRuntimeIdentity(proxy, previous);
      assert.deepEqual(fs.readFileSync(settings.filePath), beforeSettings);
    }

    settings.setAll({
      clientCertificates: [{
        host: 'invalid.example.test',
        pfxPath,
        passphrase: 'wrong secret'
      }],
      trustedCAs: [incompleteCaPath]
    });
    const invalidSavedSettings = fs.readFileSync(settings.filePath);
    const errors = [];
    const restored = restoreSavedTlsMaterialSettings(proxy, settings, {
      error: message => errors.push(message)
    });
    assert.deepEqual(restored, { clientCertificates: false, trustedCAs: false });
    assertRuntimeIdentity(proxy, previous);
    assert.deepEqual(fs.readFileSync(settings.filePath), invalidSavedSettings);
    assert.deepEqual(resets, { agents: 0, sessions: 0 });
    assert.equal(errors.length, 2);
    assert.match(errors[0], /Ignoring invalid saved client certificates.*usable PFX/);
    assert.match(errors[1], /Ignoring invalid saved trusted CAs.*usable PEM/);
  });

test('direct TLS material setters reject every unreadable candidate before mutation', async t => {
  const { dataDir, proxy, fixture } = await createHarness(t);
  const beforePfx = fixture('before.pfx', Buffer.from('before-pfx'));
  const beforeCa = fixture('before.pem', 'before-ca');
  const validPfx = fixture('valid.pfx', Buffer.from('valid-pfx'));
  const validCa = fixture('valid.pem', 'valid-ca');
  const missingPfx = path.join(dataDir, 'missing.pfx');
  const missingCa = path.join(dataDir, 'missing.pem');
  installBaseline(proxy, beforePfx, beforeCa);
  const previous = captureRuntime(proxy);
  const resets = countConnectionResets(proxy);
  let coerced = false;

  for (const candidate of [
    [{ host: 'valid.example.test', pfxPath: validPfx }, {
      host: 'missing.example.test', pfxPath: missingPfx
    }],
    [{ host: 'denied.example.test', pfxPath: path.join(dataDir, 'client.denied') }],
    [{ host: { toString() { coerced = true; return 'coerced.test'; } }, pfxPath: validPfx }],
    Array(MAX_TLS_MATERIAL_ENTRIES + 1).fill({ host: 'valid.example.test', pfxPath: validPfx })
  ]) {
    assert.throws(
      () => proxy.setClientCertificates(candidate),
      error => error?.code === 'ERR_INVALID_TLS_MATERIAL_CONFIG'
    );
    assertRuntimeIdentity(proxy, previous);
  }

  for (const candidate of [
    [validCa, missingCa],
    [path.join(dataDir, 'ca.denied')],
    [validCa, 42],
    Array(MAX_TLS_MATERIAL_ENTRIES + 1).fill(validCa)
  ]) {
    assert.throws(
      () => proxy.setTrustedCAs(candidate),
      error => error?.code === 'ERR_INVALID_TLS_MATERIAL_CONFIG'
    );
    assertRuntimeIdentity(proxy, previous);
  }

  assert.equal(coerced, false);
  assert.deepEqual(resets, { agents: 0, sessions: 0 });

  proxy.setClientCertificates([{ host: '*', pfxPath: validPfx }]);
  proxy.setTrustedCAs([validCa]);
  assert.deepEqual(proxy._getClientCertificateOptions('other.test').pfx, Buffer.from('valid-pfx'));
  assert.deepEqual(proxy._trustedCaCertificates, ['valid-ca']);
});

test('bulk and item APIs reject missing or unreadable files without writes or resets', async t => {
  const { dataDir, proxy, settings, port, fixture } = await createHarness(t);
  const beforePfx = fixture('before.pfx', Buffer.from('before-pfx'));
  const beforeCa = fixture('before.pem', 'before-ca');
  const validPfx = fixture('valid.pfx', Buffer.from('valid-pfx'));
  const validCa = fixture('valid.pem', 'valid-ca');
  const itemPfx = fixture('item.pfx', Buffer.from('item-pfx'));
  const itemCa = fixture('item.pem', 'item-ca');
  installBaseline(proxy, beforePfx, beforeCa);
  settings.setAll({
    clientCertificates: proxy.clientCertificates,
    trustedCAs: proxy.trustedCAs
  });
  const previous = captureRuntime(proxy);
  const beforeSettings = fs.readFileSync(settings.filePath);
  const resets = countConnectionResets(proxy);

  const invalidRequests = [
    ['/api/client-certificates', {
      certificates: [
        { host: 'valid.example.test', pfxPath: validPfx },
        { host: 'missing.example.test', pfxPath: path.join(dataDir, 'missing.pfx') }
      ]
    }],
    ['/api/client-certificates', {
      certificates: [{ host: 'denied.example.test', pfxPath: path.join(dataDir, 'api.denied') }]
    }],
    ['/api/client-certificates/items', {
      host: 'missing.example.test', pfxPath: path.join(dataDir, 'item-missing.pfx')
    }],
    ['/api/trusted-cas', { cas: [validCa, path.join(dataDir, 'missing.pem')] }],
    ['/api/trusted-cas', { cas: [path.join(dataDir, 'api-ca.denied')] }],
    ['/api/trusted-cas/items', { ca: path.join(dataDir, 'item-missing.pem') }]
  ];

  for (const [pathname, body] of invalidRequests) {
    const response = await requestJson(port, 'POST', pathname, body);
    assert.equal(response.statusCode, 400, pathname);
    assert.match(response.body.error, /Could not read/);
    assertRuntimeIdentity(proxy, previous);
    assert.deepEqual(fs.readFileSync(settings.filePath), beforeSettings);
  }
  assert.deepEqual(resets, { agents: 0, sessions: 0 });

  const clientSuccess = await requestJson(port, 'POST', '/api/client-certificates', {
    certificates: [{ host: 'AFTER.EXAMPLE.TEST.', pfxPath: validPfx }]
  });
  const caSuccess = await requestJson(port, 'POST', '/api/trusted-cas', { cas: [validCa] });
  assert.equal(clientSuccess.statusCode, 200);
  assert.equal(caSuccess.statusCode, 200);
  assert.deepEqual(proxy._getClientCertificateOptions('after.example.test').pfx,
    Buffer.from('valid-pfx'));
  assert.deepEqual(proxy._trustedCaCertificates, ['valid-ca']);
  assert.deepEqual(settings.get('clientCertificates'), proxy.clientCertificates);
  assert.deepEqual(settings.get('trustedCAs'), proxy.trustedCAs);

  const clientItemSuccess = await requestJson(port, 'POST', '/api/client-certificates/items', {
    host: 'item.example.test',
    pfxPath: itemPfx
  });
  const caItemSuccess = await requestJson(port, 'POST', '/api/trusted-cas/items', { ca: itemCa });
  assert.equal(clientItemSuccess.statusCode, 200);
  assert.equal(caItemSuccess.statusCode, 200);
  assert.deepEqual(proxy._getClientCertificateOptions('item.example.test').pfx,
    Buffer.from('item-pfx'));
  assert.deepEqual(proxy._trustedCaCertificates, ['valid-ca', 'item-ca']);
});

test('identical item updates revalidate complete TLS material collections without mutation',
  async t => {
    const { proxy, settings, port, fixture } = await createHarness(t);
    const firstPfx = fixture('first.pfx', Buffer.from('first-pfx'));
    const secondPfx = fixture('second.pfx', Buffer.from('second-pfx'));
    const firstCa = fixture('first.pem', 'first-ca');
    const secondCa = fixture('second.pem', 'second-ca');
    proxy.setClientCertificates([
      { host: 'first.example.test', pfxPath: firstPfx, passphrase: 'first-secret' },
      { host: 'second.example.test', pfxPath: secondPfx }
    ]);
    proxy.setTrustedCAs([firstCa, secondCa]);
    settings.setAll({
      clientCertificates: proxy.clientCertificates,
      trustedCAs: proxy.trustedCAs
    });
    const previous = captureRuntime(proxy);
    const configured = {
      clientCertificates: structuredClone(proxy.clientCertificates),
      trustedCAs: [...proxy.trustedCAs]
    };
    const beforeSettings = fs.readFileSync(settings.filePath);
    const resets = countConnectionResets(proxy);
    const clientBody = { host: 'first.example.test', pfxPath: firstPfx };
    const caBody = { ca: firstCa };

    const readableClient = await requestJson(
      port, 'POST', '/api/client-certificates/items', clientBody
    );
    const readableCa = await requestJson(port, 'POST', '/api/trusted-cas/items', caBody);
    assert.equal(readableClient.statusCode, 200);
    assert.equal(readableCa.statusCode, 200);
    assertRuntimeIdentity(proxy, previous);
    assert.deepEqual(proxy.clientCertificates, configured.clientCertificates);
    assert.deepEqual(proxy.trustedCAs, configured.trustedCAs);
    assert.deepEqual(fs.readFileSync(settings.filePath), beforeSettings);
    assert.deepEqual(resets, { agents: 0, sessions: 0 });

    fs.rmSync(firstPfx);
    fs.rmSync(firstCa);
    for (const [pathname, body, missingPath] of [
      ['/api/client-certificates/items', clientBody, firstPfx],
      ['/api/trusted-cas/items', caBody, firstCa]
    ]) {
      const response = await requestJson(port, 'POST', pathname, body);
      assert.equal(response.statusCode, 400, pathname);
      assert.match(response.body.error, /Could not read/);
      assert.match(response.body.error, new RegExp(
        missingPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      ));
      assertRuntimeIdentity(proxy, previous);
      assert.deepEqual(fs.readFileSync(settings.filePath), beforeSettings);
    }

    fs.writeFileSync(firstPfx, Buffer.from('first-pfx'));
    fs.writeFileSync(firstCa, 'first-ca');
    fs.rmSync(secondPfx);
    fs.rmSync(secondCa);
    for (const [pathname, body, missingPath] of [
      ['/api/client-certificates/items', clientBody, secondPfx],
      ['/api/trusted-cas/items', caBody, secondCa]
    ]) {
      const response = await requestJson(port, 'POST', pathname, body);
      assert.equal(response.statusCode, 400, pathname);
      assert.match(response.body.error, /Could not read/);
      assert.match(response.body.error, new RegExp(
        missingPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      ));
      assertRuntimeIdentity(proxy, previous);
      assert.deepEqual(fs.readFileSync(settings.filePath), beforeSettings);
    }

    assert.deepEqual(proxy.clientCertificates, configured.clientCertificates);
    assert.deepEqual(proxy.trustedCAs, configured.trustedCAs);
    assert.deepEqual(resets, { agents: 0, sessions: 0 });
  });

test('persistence rollback restores exact loaded snapshots without rereading removed files', async t => {
  const { proxy, settings, port, fixture } = await createHarness(t);
  const beforePfx = fixture('before.pfx', Buffer.from('before-pfx'));
  const beforeCa = fixture('before.pem', 'before-ca');
  const afterPfx = fixture('after.pfx', Buffer.from('after-pfx'));
  const afterCa = fixture('after.pem', 'after-ca');
  installBaseline(proxy, beforePfx, beforeCa);
  settings.setAll({
    clientCertificates: proxy.clientCertificates,
    trustedCAs: proxy.trustedCAs
  });
  const previous = captureRuntime(proxy);
  const beforeSettings = fs.readFileSync(settings.filePath);
  settings._save = () => {
    fs.rmSync(beforePfx, { force: true });
    fs.rmSync(beforeCa, { force: true });
    throw new Error('disk full after old material disappeared');
  };

  const clientResponse = await requestJson(port, 'POST', '/api/client-certificates', {
    certificates: [{ host: 'after.example.test', pfxPath: afterPfx }]
  });
  assert.equal(clientResponse.statusCode, 500);
  assertRuntimeIdentity(proxy, previous);
  assert.deepEqual(proxy._clientCertificateOptions[0].pfx, Buffer.from('before-pfx'));
  assert.deepEqual(fs.readFileSync(settings.filePath), beforeSettings);

  const caResponse = await requestJson(port, 'POST', '/api/trusted-cas', { cas: [afterCa] });
  assert.equal(caResponse.statusCode, 500);
  assertRuntimeIdentity(proxy, previous);
  assert.deepEqual(proxy._trustedCaCertificates, ['before-ca']);
  assert.deepEqual(fs.readFileSync(settings.filePath), beforeSettings);
});

test('startup ignores invalid saved TLS material without rewriting settings', async t => {
  const { dataDir, proxy, settings, fixture } = await createHarness(t);
  const beforePfx = fixture('before.pfx', Buffer.from('before-pfx'));
  const beforeCa = fixture('before.pem', 'before-ca');
  const restoredPfx = fixture('restored.pfx', Buffer.from('restored-pfx'));
  const restoredCa = fixture('restored.pem', 'restored-ca');
  installBaseline(proxy, beforePfx, beforeCa);
  settings.setAll({
    clientCertificates: [
      { host: 'valid.example.test', pfxPath: beforePfx },
      { host: 'missing.example.test', pfxPath: path.join(dataDir, 'startup-missing.pfx') }
    ],
    trustedCAs: [beforeCa, path.join(dataDir, 'startup-missing.pem')]
  });
  const previous = captureRuntime(proxy);
  const beforeSettings = fs.readFileSync(settings.filePath);
  const resets = countConnectionResets(proxy);
  const errors = [];

  const ignored = restoreSavedTlsMaterialSettings(proxy, settings, {
    error: message => errors.push(message)
  });
  assert.deepEqual(ignored, { clientCertificates: false, trustedCAs: false });
  assertRuntimeIdentity(proxy, previous);
  assert.deepEqual(resets, { agents: 0, sessions: 0 });
  assert.deepEqual(fs.readFileSync(settings.filePath), beforeSettings);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /Ignoring invalid saved client certificates.*Could not read/);
  assert.match(errors[1], /Ignoring invalid saved trusted CAs.*Could not read/);

  settings.setAll({
    clientCertificates: [{ host: 'RESTORED.EXAMPLE.TEST.', pfxPath: restoredPfx }],
    trustedCAs: [restoredCa]
  });
  const restored = restoreSavedTlsMaterialSettings(proxy, settings);
  assert.deepEqual(restored, { clientCertificates: true, trustedCAs: true });
  assert.deepEqual(proxy._getClientCertificateOptions('restored.example.test').pfx,
    Buffer.from('restored-pfx'));
  assert.deepEqual(proxy._trustedCaCertificates, ['restored-ca']);
});
