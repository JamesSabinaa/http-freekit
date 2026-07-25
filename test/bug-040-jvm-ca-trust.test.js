import assert from 'node:assert/strict';
import test from 'node:test';
import { JvmInterceptor } from '../src/interceptors/jvm-interceptor.js';

test('JVM agent arguments carry the CA path without delimiter corruption', () => {
  const interceptor = new JvmInterceptor();
  const certificatePath = 'C:\\certificates\\FreeKit, Local CA.pem';
  interceptor.ca = { getCertInfo: () => ({ certificatePath }) };

  const args = interceptor._getAgentArgs('127.0.0.1', 8080);
  const encodedPath = args.split(',').find(part => part.startsWith('freekit.caPathBase64=')).split('=')[1];

  assert.equal(Buffer.from(encodedPath, 'base64').toString('utf8'), certificatePath);
  assert.match(args, /https\.proxyHost=127\.0\.0\.1/);
  assert.match(args, /https\.proxyPort=8080/);
});

test('generated JVM agent combines system trust with the FreeKit CA', () => {
  const source = new JvmInterceptor()._getAgentSource();

  assert.match(source, /CertificateFactory\.getInstance\("X\.509"\)/);
  assert.match(source, /systemFactory\.init\(\(KeyStore\) null\)/);
  assert.match(source, /caStore\.setCertificateEntry\("http-freekit", caCertificate\)/);
  assert.match(source, /systemTrust\.checkServerTrusted/);
  assert.match(source, /caTrust\.checkServerTrusted/);
  assert.match(source, /SSLContext\.setDefault\(context\)/);
  assert.match(source, /HttpsURLConnection\.setDefaultSSLSocketFactory/);
});
