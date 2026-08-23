import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import forge from 'node-forge';

import { CertificateAuthority } from '../../src/proxy/certificate-authority.js';

const { pki } = forge;

function createPersistedCa(dataDir) {
  const keys = pki.rsa.generateKeyPair({ bits: 1024 });
  const certificate = pki.createCertificate();
  const subject = [{ name: 'commonName', value: 'Persisted permissions test CA' }];
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = '01';
  certificate.validity.notBefore = new Date(Date.now() - 60_000);
  certificate.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  certificate.setSubject(subject);
  certificate.setIssuer(subject);
  certificate.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true }
  ]);
  certificate.sign(keys.privateKey, forge.md.sha256.create());

  const certPath = path.join(dataDir, 'ca.pem');
  const keyPath = path.join(dataDir, 'ca.key');
  fs.writeFileSync(certPath, pki.certificateToPem(certificate));
  fs.writeFileSync(keyPath, pki.privateKeyToPem(keys.privateKey), { mode: 0o644 });
  fs.chmodSync(keyPath, 0o644);
  return { certPath, keyPath };
}

test('validated existing CA keys are repaired to owner-only permissions', async t => {
  t.mock.method(console, 'log', () => {});
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-ca-key-mode-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const { keyPath } = createPersistedCa(dataDir);
  const chmodSync = fs.chmodSync;
  const chmodCalls = [];
  t.mock.method(fs, 'chmodSync', (filePath, mode) => {
    chmodCalls.push([filePath, mode]);
    return chmodSync(filePath, mode);
  });
  const ca = new CertificateAuthority(dataDir);
  ca._platform = () => 'linux';

  await ca.initialize({ autoRenewExpiring: false });

  assert.deepEqual(chmodCalls, [[keyPath, 0o600]]);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
  }
});

test('CA startup fails actionably when a validated key cannot be hardened', async t => {
  t.mock.method(console, 'log', () => {});
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-ca-key-denied-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const { certPath, keyPath } = createPersistedCa(dataDir);
  const originalCertificate = fs.readFileSync(certPath, 'utf8');
  const originalKey = fs.readFileSync(keyPath, 'utf8');
  const ca = new CertificateAuthority(dataDir);
  ca._platform = () => 'linux';
  ca._generateKeyPair = async () => assert.fail('permission failures must not regenerate the CA');
  t.mock.method(fs, 'chmodSync', (filePath) => {
    assert.equal(filePath, keyPath);
    throw new Error('simulated permission denial');
  });

  await assert.rejects(
    ca.initialize({ autoRenewExpiring: false }),
    error => {
      assert.match(error.message, /Could not secure existing CA private key/);
      assert.match(error.message, /owner-only access/);
      assert.match(error.message, /simulated permission denial/);
      assert.match(error.message, /owned by the current user/);
      return true;
    }
  );
  assert.equal(fs.readFileSync(certPath, 'utf8'), originalCertificate);
  assert.equal(fs.readFileSync(keyPath, 'utf8'), originalKey);
});

test('Windows does not claim POSIX chmod hardening for an existing CA key', async t => {
  t.mock.method(console, 'log', () => {});
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-ca-key-windows-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  createPersistedCa(dataDir);
  const ca = new CertificateAuthority(dataDir);
  ca._platform = () => 'win32';
  t.mock.method(fs, 'chmodSync', () => assert.fail('Windows must not use chmod as access hardening'));

  await assert.doesNotReject(ca.initialize({ autoRenewExpiring: false }));
});
