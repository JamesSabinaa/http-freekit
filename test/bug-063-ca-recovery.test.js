import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import forge from 'node-forge';

import { CertificateAuthority } from '../src/proxy/certificate-authority.js';

const { pki } = forge;

function publicKeyDerFromCertificate(pem) {
  return new crypto.X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' });
}

function publicKeyDerFromPrivateKey(pem) {
  return crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' });
}

async function assertRecoveredCa(dataDir, originalCertificate, recoveryKeys) {
  const recovered = new CertificateAuthority(dataDir);
  recovered._generateKeyPair = async () => recoveryKeys;
  const info = await recovered.initialize();
  const certificatePem = fs.readFileSync(info.certPath, 'utf8');
  const keyPem = fs.readFileSync(info.keyPath, 'utf8');

  assert.notEqual(certificatePem, originalCertificate);
  assert.deepEqual(
    publicKeyDerFromCertificate(certificatePem),
    publicKeyDerFromPrivateKey(keyPem)
  );

  const leaf = await recovered.generateCertForHost('recovered.example');
  const caCertificate = pki.certificateFromPem(certificatePem);
  const leafCertificate = pki.certificateFromPem(leaf.cert);
  assert.equal(caCertificate.verify(leafCertificate), true);
}

test('startup regenerates corrupt or mismatched CA files', { timeout: 30000 }, async t => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-ca-fixture-'));
  t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));
  const original = new CertificateAuthority(fixtureDir);
  await original.initialize();
  const originalCertificate = fs.readFileSync(original.caCertPath, 'utf8');
  const originalKey = fs.readFileSync(original.caKeyPath, 'utf8');
  const recoveryKeys = pki.rsa.generateKeyPair({ bits: 1024 });
  const mismatchedKey = pki.privateKeyToPem(recoveryKeys.privateKey);

  const cases = [
    ['corrupt private key', 'not valid PEM data', originalCertificate],
    ['corrupt certificate', originalKey, 'not valid PEM data'],
    ['mismatched private key', mismatchedKey, originalCertificate]
  ];

  for (const [name, keyPem, certificatePem] of cases) {
    await t.test(name, async t => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-ca-recovery-'));
      t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
      fs.writeFileSync(path.join(dataDir, 'ca.key'), keyPem, { mode: 0o600 });
      fs.writeFileSync(path.join(dataDir, 'ca.pem'), certificatePem);

      await assertRecoveredCa(dataDir, originalCertificate, recoveryKeys);
    });
  }
});
