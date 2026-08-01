import assert from 'node:assert/strict';
import test from 'node:test';
import { JvmInterceptor } from '../../../src/interceptors/jvm-interceptor.js';

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
  assert.match(source, /systemTrust\.getAcceptedIssuers\(\)/);
  assert.match(source, /combinedStore\.setCertificateEntry\("system-" \+ issuerIndex, issuer\)/);
  assert.match(source, /combinedStore\.setCertificateEntry\("http-freekit", caCertificate\)/);
  assert.match(source, /combinedFactory\.init\(combinedStore\)/);
  assert.doesNotMatch(source, /new X509TrustManager\(\) \{/);
  assert.match(source, /SSLContext\.setDefault\(context\)/);
  assert.match(source, /HttpsURLConnection\.setDefaultSSLSocketFactory/);
});

test('manual JVM fallback launches the same CA-capable proxy agent', async () => {
  const interceptor = new JvmInterceptor({ agentDir: 'C:\\FreeKit Files\\jvm-agent' });
  const certificatePath = 'C:\\FreeKit Files\\ca.pem';
  const agentPath = 'C:\\FreeKit Files\\jvm-agent\\proxy-agent.jar';
  interceptor.ca = { getCertInfo: () => ({ certificatePath }) };
  interceptor._getAgentJarPath = async () => agentPath;
  interceptor._getRunningProcesses = async () => [];

  const result = await interceptor.activate(8080);
  const command = result.metadata.fallbackCommand;

  assert.equal(result.success, true);
  assert.match(command, /-javaagent:/);
  assert.ok(command.includes(agentPath));
  assert.match(command, /http\.proxyHost=127\.0\.0\.1/);
  assert.match(command, /http\.nonProxyHosts=/);
  assert.match(command, /https\.proxyHost=127\.0\.0\.1/);
  const encodedPath = command.match(/freekit\.caPathBase64=([^,"']+)/)?.[1];
  assert.equal(Buffer.from(encodedPath, 'base64').toString('utf8'), certificatePath);
  assert.doesNotMatch(command, /^['"]?-Dhttp\./);
});

test('manual JVM fallback is omitted when the CA-capable agent cannot be prepared', async () => {
  const interceptor = new JvmInterceptor();
  interceptor.ca = { getCertInfo: () => ({ certificatePath: '/tmp/ca.pem' }) };
  interceptor._getAgentJarPath = async () => null;
  interceptor._getRunningProcesses = async () => [];

  const result = await interceptor.activate(8080);

  assert.equal(result.metadata.fallbackCommand, null);
});
