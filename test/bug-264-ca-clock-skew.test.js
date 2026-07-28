import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import forge from 'node-forge';

import { CertificateAuthority } from '../src/proxy/certificate-authority.js';

const { pki } = forge;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const VALIDITY_MS = 365 * 24 * 60 * 60 * 1000;

function assertFiveMinuteBackdate(certificatePem, generationStarted, generationFinished) {
  const certificate = pki.certificateFromPem(certificatePem);
  const notBefore = certificate.validity.notBefore.getTime();

  assert.ok(
    notBefore >= generationStarted - CLOCK_SKEW_MS - 1000,
    'certificate must not be backdated by more than the skew window'
  );
  assert.ok(
    notBefore <= generationFinished - CLOCK_SKEW_MS,
    'certificate must be valid for a client clock trailing by five minutes'
  );
}

test('generated CA and leaf certificates tolerate five minutes of client clock skew', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-ca-skew-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const ca = new CertificateAuthority(dataDir);
  ca._generateKeyPair = async () => pki.rsa.generateKeyPair({ bits: 1024 });

  const caGenerationStarted = Date.now();
  await ca._generateCA();
  const caGenerationFinished = Date.now();
  assertFiveMinuteBackdate(
    fs.readFileSync(ca.caCertPath, 'utf8'),
    caGenerationStarted,
    caGenerationFinished
  );

  const leafGenerationStarted = Date.now();
  const leaf = await ca.generateCertForHost('clock-skew.test');
  const leafGenerationFinished = Date.now();
  assertFiveMinuteBackdate(leaf.cert, leafGenerationStarted, leafGenerationFinished);
});

test('generated certificate expiry is UTC-stable across DST and leap-day boundaries', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-ca-expiry-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let generatedAt = Date.parse('2027-03-27T12:00:00.000Z');
  t.mock.method(Date, 'now', () => generatedAt);
  const keys = pki.rsa.generateKeyPair({ bits: 1024 });
  const ca = new CertificateAuthority(dataDir);
  ca._generateKeyPair = async () => keys;

  for (const [label, timestamp] of [
    ['dst', Date.parse('2027-03-27T12:00:00.000Z')],
    ['leap-day', Date.parse('2028-02-29T12:00:00.000Z')]
  ]) {
    generatedAt = timestamp;
    await ca._generateCA();
    const leaf = await ca.generateCertForHost(`${label}.clock-skew.test`);

    for (const certificatePem of [fs.readFileSync(ca.caCertPath, 'utf8'), leaf.cert]) {
      const validity = pki.certificateFromPem(certificatePem).validity;
      assert.equal(validity.notBefore.getTime(), generatedAt - CLOCK_SKEW_MS);
      assert.equal(validity.notAfter.getTime(), generatedAt + VALIDITY_MS);
    }
  }
});
