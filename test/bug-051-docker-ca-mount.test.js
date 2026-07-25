import assert from 'node:assert/strict';
import test from 'node:test';
import { DockerInterceptor } from '../src/interceptors/docker-interceptor.js';

test('Docker instructions mount the FreeKit CA for common HTTPS clients', async () => {
  const interceptor = new DockerInterceptor();
  interceptor._platform = () => 'linux';
  interceptor._exec = () => '172.17.0.1\n';
  interceptor.ca = { getCertInfo: () => ({ certificatePath: '/home/user/FreeKit CA.pem' }) };

  const result = await interceptor.activate(8080);
  const { run, compose } = result.metadata.instructions;

  assert.match(run, /--mount type=bind,source="\/home\/user\/FreeKit CA\.pem",target=\/etc\/http-freekit\/ca\.pem,readonly/);
  assert.match(run, /SSL_CERT_FILE=\/etc\/http-freekit\/ca\.pem/);
  assert.match(run, /REQUESTS_CA_BUNDLE=\/etc\/http-freekit\/ca\.pem/);
  assert.match(run, /CURL_CA_BUNDLE=\/etc\/http-freekit\/ca\.pem/);
  assert.match(run, /NODE_EXTRA_CA_CERTS=\/etc\/http-freekit\/ca\.pem/);
  assert.doesNotMatch(run, /NODE_TLS_REJECT_UNAUTHORIZED/);

  assert.match(compose, /volumes:/);
  assert.match(compose, /FreeKit CA\.pem:\/etc\/http-freekit\/ca\.pem:ro/);
  assert.match(compose, /SSL_CERT_FILE=\/etc\/http-freekit\/ca\.pem/);
  assert.doesNotMatch(compose, /NODE_TLS_REJECT_UNAUTHORIZED/);
});

test('Docker activation does not claim HTTPS support without a CA', async () => {
  const interceptor = new DockerInterceptor();
  interceptor._platform = () => 'linux';
  interceptor._exec = () => '172.17.0.1\n';

  await assert.rejects(interceptor.activate(8080), /CA certificate is not available/);
  assert.equal(interceptor.active, false);
});
