import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';

import { CertificateAuthority } from '../src/proxy/certificate-authority.js';

test('generated leaf certificates build a trusted chain to the FreeKit CA', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-leaf-chain-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const ca = new CertificateAuthority(dataDir);
  await ca._generateCA();
  const hostname = 'authority-key-id.test';
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
});
