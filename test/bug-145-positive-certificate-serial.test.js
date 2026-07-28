import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import forge from 'node-forge';

import { CertificateAuthority } from '../src/proxy/certificate-authority.js';
import { installWindowsCaTrust } from '../src/proxy/windows-ca-trust.js';

const { pki } = forge;

function createPersistedCa(dataDir, serialNumber) {
  const keys = pki.rsa.generateKeyPair({ bits: 1024 });
  const certificate = pki.createCertificate();
  const subject = [{ name: 'commonName', value: 'Persisted serial test CA' }];
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = serialNumber;
  certificate.validity.notBefore = new Date(Date.now() - 60_000);
  certificate.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  certificate.setSubject(subject);
  certificate.setIssuer(subject);
  certificate.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true }
  ]);
  certificate.sign(keys.privateKey, forge.md.sha256.create());
  const certificatePem = pki.certificateToPem(certificate);
  fs.writeFileSync(path.join(dataDir, 'ca.pem'), certificatePem);
  fs.writeFileSync(path.join(dataDir, 'ca.key'), pki.privateKeyToPem(keys.privateKey));
  return certificatePem;
}

test('certificate serial generation clears the ASN.1 sign bit', () => {
  const ca = new CertificateAuthority('.');
  const serial = ca._randomSerial(Buffer.alloc(16, 0xff));

  assert.equal(serial.length, 32);
  assert.equal(serial, '7f' + 'ff'.repeat(15));
  assert.ok(parseInt(serial[0], 16) < 8);
});

test('certificate serial generation never returns zero', () => {
  const ca = new CertificateAuthority('.');
  const serial = ca._randomSerial(Buffer.alloc(16));

  assert.equal(serial, '00'.repeat(15) + '01');
});

test('persisted serial validation accepts positive padding and rejects zero or negative encodings', () => {
  const ca = new CertificateAuthority('.');

  assert.equal(ca._isPositiveSerial('01'), true);
  assert.equal(ca._isPositiveSerial('0080'), true);
  assert.equal(ca._isPositiveSerial('00'), false);
  assert.equal(ca._isPositiveSerial('80'), false);
  assert.equal(ca._isPositiveSerial('-01'), false);
});

test('startup replaces a persisted CA with a negative serial', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-negative-serial-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const oldCertificatePem = createPersistedCa(dataDir, '80' + '01'.repeat(15));
  const oldFingerprint = new crypto.X509Certificate(oldCertificatePem)
    .fingerprint.replace(/:/g, '').toUpperCase();
  const replacementKeys = pki.rsa.generateKeyPair({ bits: 1024 });
  const ca = new CertificateAuthority(dataDir);
  ca._generateKeyPair = async () => replacementKeys;

  const info = await ca.initialize();
  const replacementPem = fs.readFileSync(info.certPath, 'utf8');
  const replacement = pki.certificateFromPem(replacementPem);

  assert.notEqual(replacementPem, oldCertificatePem);
  assert.equal(info.replacedCertificateFingerprint, oldFingerprint);
  assert.equal(ca._isPositiveSerial(replacement.serialNumber), true);
});

test('Windows trust installs the replacement before deleting the exact old thumbprint', () => {
  const calls = [];
  const oldFingerprint = 'AB'.repeat(20);
  const result = installWindowsCaTrust({
    certPath: 'C:\\FreeKit Data\\ca.pem',
    replacedCertificateFingerprint: oldFingerprint.match(/../g).join(':')
  }, (command, args, options) => calls.push([command, args, options]));

  assert.deepEqual(calls, [
    ['certutil', ['-addstore', '-user', '-f', 'Root', 'C:\\FreeKit Data\\ca.pem'], {
      stdio: 'ignore'
    }],
    ['certutil', ['-delstore', '-user', 'Root', oldFingerprint], { stdio: 'ignore' }]
  ]);
  assert.equal(result.replacedFingerprint, oldFingerprint);
  assert.equal(result.replacementRemovalError, null);
});

test('Windows trust never removes the old CA unless replacement installation succeeds', () => {
  const calls = [];
  assert.throws(() => installWindowsCaTrust({
    certPath: 'C:\\ca.pem',
    replacedCertificateFingerprint: '01'.repeat(20)
  }, (command, args) => {
    calls.push([command, args]);
    throw new Error('access denied');
  }), /access denied/);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1].slice(0, 4), ['-addstore', '-user', '-f', 'Root']);
});

test('an obsolete trust-entry cleanup failure keeps the new CA installed', () => {
  const calls = [];
  const result = installWindowsCaTrust({
    certPath: 'C:\\ca.pem',
    replacedCertificateFingerprint: '01'.repeat(20)
  }, (command, args) => {
    calls.push([command, args]);
    if (args[0] === '-delstore') throw new Error('old entry already absent');
  });

  assert.equal(calls.length, 2);
  assert.match(result.replacementRemovalError.message, /already absent/);
});
