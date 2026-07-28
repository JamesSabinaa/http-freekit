import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import forge from 'node-forge';

import { CertificateAuthority } from '../src/proxy/certificate-authority.js';
import {
  getWindowsCertutilPath,
  installWindowsCaTrust
} from '../src/proxy/windows-ca-trust.js';

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
  assert.deepEqual(info.replacedCertificateFingerprints, [oldFingerprint]);
  assert.equal(ca._isPositiveSerial(replacement.serialNumber), true);
});

test('startup records an obsolete certificate even when its private key is missing', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-missing-ca-key-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  t.mock.method(console, 'log', () => {});
  const oldCertificatePem = createPersistedCa(dataDir, '01');
  const oldFingerprint = new crypto.X509Certificate(oldCertificatePem)
    .fingerprint.replace(/:/g, '').toUpperCase();
  fs.unlinkSync(path.join(dataDir, 'ca.key'));
  const ca = new CertificateAuthority(dataDir);
  ca._generateKeyPair = async () => pki.rsa.generateKeyPair({ bits: 1024 });

  const info = await ca.initialize();

  assert.equal(info.replacedCertificateFingerprint, oldFingerprint);
  assert.deepEqual(info.replacedCertificateFingerprints, [oldFingerprint]);
  assert.equal(fs.existsSync(ca.caReplacementStatePath), true);
});

test('pending replacement cleanup survives trust failures and restarts', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-ca-cleanup-retry-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const oldCertificatePem = createPersistedCa(dataDir, '80' + '02'.repeat(15));
  const oldFingerprint = new crypto.X509Certificate(oldCertificatePem)
    .fingerprint.replace(/:/g, '').toUpperCase();
  const firstCa = new CertificateAuthority(dataDir);
  firstCa._generateKeyPair = async () => pki.rsa.generateKeyPair({ bits: 1024 });
  const firstInfo = await firstCa.initialize();

  assert.throws(() => installWindowsCaTrust(firstInfo, () => {
    throw new Error('temporary add failure');
  }), /temporary add failure/);
  const afterAddFailure = await new CertificateAuthority(dataDir).initialize();
  assert.deepEqual(afterAddFailure.replacedCertificateFingerprints, [oldFingerprint]);

  const removalResult = installWindowsCaTrust(afterAddFailure, (_command, args) => {
    if (args[0] === '-delstore') throw new Error('temporary delete failure');
  });
  firstCa.setPendingReplacementFingerprints(removalResult.remainingReplacementFingerprints);
  const afterDeleteFailure = await new CertificateAuthority(dataDir).initialize();
  assert.deepEqual(afterDeleteFailure.replacedCertificateFingerprints, [oldFingerprint]);

  const success = installWindowsCaTrust(afterDeleteFailure, () => {});
  firstCa.setPendingReplacementFingerprints(success.remainingReplacementFingerprints);
  const afterSuccess = await new CertificateAuthority(dataDir).initialize();
  assert.deepEqual(afterSuccess.replacedCertificateFingerprints, []);
  assert.equal(fs.existsSync(firstCa.caReplacementStatePath), false);
});

test('replacement stops before overwriting the CA when its cleanup journal cannot be saved', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-ca-journal-failure-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  t.mock.method(console, 'warn', () => {});
  const oldCertificatePem = createPersistedCa(dataDir, '80' + '03'.repeat(15));
  const oldKeyPem = fs.readFileSync(path.join(dataDir, 'ca.key'), 'utf8');
  const ca = new CertificateAuthority(dataDir);
  ca.setPendingReplacementFingerprints = () => {
    throw new Error('journal is read-only');
  };

  await assert.rejects(ca.initialize(), /journal is read-only/);
  assert.equal(fs.readFileSync(path.join(dataDir, 'ca.pem'), 'utf8'), oldCertificatePem);
  assert.equal(fs.readFileSync(path.join(dataDir, 'ca.key'), 'utf8'), oldKeyPem);
});

test('malformed pending replacement state fails closed', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-ca-journal-corrupt-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  createPersistedCa(dataDir, '01');
  fs.writeFileSync(path.join(dataDir, 'ca-replacements.json'), '{broken');

  await assert.rejects(new CertificateAuthority(dataDir).initialize(), SyntaxError);
});

test('startup never schedules the active CA fingerprint for deletion', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-ca-active-journal-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  t.mock.method(console, 'log', () => {});
  const certificatePem = createPersistedCa(dataDir, '01');
  const activeFingerprint = new crypto.X509Certificate(certificatePem)
    .fingerprint.replace(/:/g, '').toUpperCase();
  fs.writeFileSync(path.join(dataDir, 'ca-replacements.json'), JSON.stringify({
    version: 1,
    fingerprints: ['44'.repeat(20), activeFingerprint]
  }));

  const ca = new CertificateAuthority(dataDir);
  const info = await ca.initialize();

  assert.deepEqual(info.replacedCertificateFingerprints, ['44'.repeat(20)]);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(ca.caReplacementStatePath, 'utf8')).fingerprints,
    ['44'.repeat(20)]
  );
});

test('Windows trust installs the replacement before deleting the exact old thumbprint', () => {
  const calls = [];
  const oldFingerprint = 'AB'.repeat(20);
  const result = installWindowsCaTrust({
    certPath: 'C:\\FreeKit Data\\ca.pem',
    replacedCertificateFingerprint: oldFingerprint.match(/../g).join(':')
  }, (command, args, options) => calls.push([command, args, options]));

  assert.deepEqual(calls, [
    [getWindowsCertutilPath(), ['-addstore', '-user', '-f', 'Root', 'C:\\FreeKit Data\\ca.pem'], {
      stdio: 'ignore'
    }],
    [getWindowsCertutilPath(), ['-delstore', '-user', 'Root', oldFingerprint], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    }]
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
  assert.deepEqual(result.remainingReplacementFingerprints, ['01'.repeat(20)]);
});

test('an already absent exact trust entry completes idempotent cleanup', () => {
  const result = installWindowsCaTrust({
    certPath: 'C:\\ca.pem',
    replacedCertificateFingerprint: '01'.repeat(20)
  }, (_command, args) => {
    if (args[0] !== '-delstore') return;
    const error = new Error('certutil deletion failed');
    error.stderr = Buffer.from('CertUtil: 0x80092004 (CRYPT_E_NOT_FOUND)');
    throw error;
  });

  assert.deepEqual(result.replacementRemovalErrors, []);
  assert.deepEqual(result.remainingReplacementFingerprints, []);
});

test('Windows trust retains only failed fingerprints from a multi-CA cleanup', () => {
  const firstFingerprint = '11'.repeat(20);
  const secondFingerprint = '22'.repeat(20);
  const deleted = [];
  const result = installWindowsCaTrust({
    certPath: 'C:\\ca.pem',
    replacedCertificateFingerprints: [firstFingerprint, secondFingerprint]
  }, (_command, args) => {
    if (args[0] !== '-delstore') return;
    deleted.push(args[3]);
    if (args[3] === secondFingerprint) throw new Error('still in use');
  });

  assert.deepEqual(deleted, [firstFingerprint, secondFingerprint]);
  assert.deepEqual(result.remainingReplacementFingerprints, [secondFingerprint]);
  assert.equal(result.replacementRemovalErrors[0].fingerprint, secondFingerprint);
});

test('Windows trust uses an absolute System32 certutil path', () => {
  assert.equal(
    getWindowsCertutilPath({ SystemRoot: 'D:\\Windows' }),
    'D:\\Windows\\System32\\certutil.exe'
  );
  assert.equal(path.win32.isAbsolute(getWindowsCertutilPath({})), true);
});
