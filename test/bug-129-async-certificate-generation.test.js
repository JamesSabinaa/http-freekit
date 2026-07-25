import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CertificateAuthority } from '../src/proxy/certificate-authority.js';

test('uncached certificate generation yields to the event loop', { timeout: 20000 }, async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-async-cert-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const ca = new CertificateAuthority(dataDir);
  await ca.initialize();

  let immediateRan = false;
  const immediate = new Promise(resolve => setImmediate(() => {
    immediateRan = true;
    resolve();
  }));
  const certificatePromise = ca.generateCertForHost('new-host.example');

  assert.equal(certificatePromise instanceof Promise, true);
  await immediate;
  assert.equal(immediateRan, true);
  const certificate = await certificatePromise;
  assert.match(certificate.cert, /BEGIN CERTIFICATE/);
});

test('concurrent requests for one hostname share key generation', { timeout: 20000 }, async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-shared-cert-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const ca = new CertificateAuthority(dataDir);
  await ca.initialize();
  const generateKeyPair = ca._generateKeyPair.bind(ca);
  let generationCount = 0;
  ca._generateKeyPair = () => {
    generationCount++;
    return generateKeyPair();
  };

  const [first, second] = await Promise.all([
    ca.generateCertForHost('same-host.example'),
    ca.generateCertForHost('same-host.example')
  ]);

  assert.equal(generationCount, 1);
  assert.equal(first, second);
});
