import assert from 'node:assert/strict';
import test from 'node:test';

import { CertificateAuthority } from '../src/proxy/certificate-authority.js';

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
