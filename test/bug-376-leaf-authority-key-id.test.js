import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import forge from 'node-forge';

import { CertificateAuthority } from '../src/proxy/certificate-authority.js';

const { asn1, md, pki, util } = forge;

async function assertTrustedTlsChain(ca, hostname) {
  const generated = await ca.generateCertForHost(hostname);
  const rootCertificate = new X509Certificate(generated.ca);
  const leafCertificate = new X509Certificate(generated.cert);

  assert.equal(leafCertificate.checkIssued(rootCertificate), true);

  const server = tls.createServer({ key: generated.key, cert: generated.cert }, socket => {
    socket.end('ok');
  });
  server.on('tlsClientError', () => {});
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const client = tls.connect({
    host: '127.0.0.1',
    port: server.address().port,
    servername: hostname,
    ca: generated.ca,
    rejectUnauthorized: true
  });
  try {
    await once(client, 'secureConnect');
    assert.equal(client.authorized, true);
  } finally {
    client.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}

test('generated leaf certificates build a trusted chain to the FreeKit CA', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-leaf-chain-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const ca = new CertificateAuthority(dataDir);
  await ca._generateCA();
  await assertTrustedTlsChain(ca, 'authority-key-id.test');
});

test('leaf authority identity copies an alternate SKI from a persisted CA', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-alternate-ski-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const keys = pki.rsa.generateKeyPair({ bits: 2048 });
  const certificate = pki.createCertificate();
  const subject = [{ name: 'commonName', value: 'Alternate SKI CA' }];
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = '01';
  certificate.validity.notBefore = new Date(Date.now() - 60_000);
  certificate.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  certificate.setSubject(subject);
  certificate.setIssuer(subject);
  certificate.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' }
  ]);

  const fullIdentifier = certificate.generateSubjectKeyIdentifier().getBytes();
  const lowEightBytes = fullIdentifier.slice(-8);
  const alternateIdentifier = String.fromCharCode(
    0x40 | (lowEightBytes.charCodeAt(0) & 0x0f)
  ) + lowEightBytes.slice(1);
  const skiExtension = certificate.getExtension('subjectKeyIdentifier');
  skiExtension.subjectKeyIdentifier = util.bytesToHex(alternateIdentifier);
  skiExtension.value = asn1.create(
    asn1.Class.UNIVERSAL,
    asn1.Type.OCTETSTRING,
    false,
    alternateIdentifier
  );
  certificate.sign(keys.privateKey, md.sha256.create());

  fs.writeFileSync(path.join(dataDir, 'ca.pem'), pki.certificateToPem(certificate));
  fs.writeFileSync(path.join(dataDir, 'ca.key'), pki.privateKeyToPem(keys.privateKey), {
    mode: 0o600
  });

  const ca = new CertificateAuthority(dataDir);
  await ca.initialize({ autoRenewExpiring: false });
  assert.equal(
    ca.caCert.getExtension('subjectKeyIdentifier').subjectKeyIdentifier,
    util.bytesToHex(alternateIdentifier)
  );
  await assertTrustedTlsChain(ca, 'persisted-authority-key-id.test');
});
