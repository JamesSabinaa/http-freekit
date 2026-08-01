import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import forge from 'node-forge';

import { CertificateAuthority } from '../../src/proxy/certificate-authority.js';

const { pki } = forge;

function createPersistedCertificate(keys, {
  ca = true,
  selfSigned = true,
  notBefore = new Date(Date.now() - 60_000)
} = {}) {
  const certificate = pki.createCertificate();
  const subject = [{ name: 'commonName', value: 'Persisted test CA' }];

  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = '01';
  certificate.validity.notBefore = notBefore;
  certificate.validity.notAfter = new Date(notBefore);
  certificate.validity.notAfter.setFullYear(notBefore.getFullYear() + 1);
  certificate.setSubject(subject);
  certificate.setIssuer(selfSigned
    ? subject
    : [{ name: 'commonName', value: 'Different issuer' }]);
  certificate.setExtensions([
    { name: 'basicConstraints', cA: ca, critical: true },
    { name: 'keyUsage', keyCertSign: ca, cRLSign: ca, critical: true }
  ]);
  certificate.sign(keys.privateKey, forge.md.sha256.create());
  return pki.certificateToPem(certificate);
}

function publicKeyDerFromCertificate(pem) {
  return new crypto.X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' });
}

function publicKeyDerFromPrivateKey(pem) {
  return crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' });
}

async function assertRecoveredCa(dataDir, persistedCertificate, recoveryKeys) {
  const recovered = new CertificateAuthority(dataDir);
  recovered._generateKeyPair = async () => recoveryKeys;
  const info = await recovered.initialize();
  const certificatePem = fs.readFileSync(info.certPath, 'utf8');
  const keyPem = fs.readFileSync(info.keyPath, 'utf8');

  assert.notEqual(certificatePem, persistedCertificate);
  assert.deepEqual(
    publicKeyDerFromCertificate(certificatePem),
    publicKeyDerFromPrivateKey(keyPem)
  );

  const leaf = await recovered.generateCertForHost('recovered.example');
  const caCertificate = pki.certificateFromPem(certificatePem);
  const leafCertificate = pki.certificateFromPem(leaf.cert);
  assert.equal(caCertificate.verify(leafCertificate), true);
}

test('startup regenerates invalid CA files and secures the replacement key', { timeout: 30000 }, async t => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-ca-fixture-'));
  t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));
  const original = new CertificateAuthority(fixtureDir);
  await original.initialize();
  const originalCertificate = fs.readFileSync(original.caCertPath, 'utf8');
  const originalKey = fs.readFileSync(original.caKeyPath, 'utf8');
  const recoveryKeys = pki.rsa.generateKeyPair({ bits: 1024 });
  const recoveryKey = pki.privateKeyToPem(recoveryKeys.privateKey);
  const nonCaCertificate = createPersistedCertificate(recoveryKeys, { ca: false });
  const nonSelfSignedCertificate = createPersistedCertificate(recoveryKeys, { selfSigned: false });
  const futureCertificate = createPersistedCertificate(recoveryKeys, {
    notBefore: new Date(Date.now() + 60 * 60 * 1000)
  });
  const chmodCalls = [];
  t.mock.method(fs, 'chmodSync', (filePath, mode) => chmodCalls.push([filePath, mode]));

  const cases = [
    ['corrupt private key', 'not valid PEM data', originalCertificate],
    ['corrupt certificate', originalKey, 'not valid PEM data'],
    ['mismatched private key', recoveryKey, originalCertificate],
    ['non-CA certificate', recoveryKey, nonCaCertificate],
    ['non-self-signed certificate', recoveryKey, nonSelfSignedCertificate],
    ['future-dated certificate', recoveryKey, futureCertificate]
  ];

  for (const [name, keyPem, certificatePem] of cases) {
    await t.test(name, async t => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-ca-recovery-'));
      t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
      const keyPath = path.join(dataDir, 'ca.key');
      fs.writeFileSync(keyPath, keyPem, { mode: 0o644 });
      fs.writeFileSync(path.join(dataDir, 'ca.pem'), certificatePem);

      await assertRecoveredCa(dataDir, certificatePem, recoveryKeys);
      assert.deepEqual(chmodCalls.at(-1), [keyPath, 0o600]);
    });
  }
});
