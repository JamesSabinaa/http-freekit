import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from 'js-yaml';
import { DockerInterceptor } from '../../../src/interceptors/docker-interceptor.js';

test('Docker instructions add the FreeKit CA for Node without replacing image trust roots', async () => {
  const interceptor = new DockerInterceptor();
  interceptor._platform = () => 'linux';
  interceptor._exec = () => '172.17.0.1\n';
  interceptor._getFreeKitCaPath = () => '/home/user/FreeKit CA bundle.pem';

  const result = await interceptor.activate(8080);
  const { run, compose } = result.metadata.instructions;

  assert.match(run, /--mount 'type=bind,"source=\/home\/user\/FreeKit CA bundle\.pem",target=\/etc\/http-freekit\/http-freekit-ca\.pem,readonly'/);
  assert.match(run, /NODE_EXTRA_CA_CERTS=\/etc\/http-freekit\/http-freekit-ca\.pem/);
  assert.doesNotMatch(run, /SSL_CERT_FILE|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE/);
  assert.doesNotMatch(run, /NODE_TLS_REJECT_UNAUTHORIZED/);

  assert.match(compose, /volumes:/);
  assert.match(compose, /FreeKit CA bundle\.pem:\/etc\/http-freekit\/http-freekit-ca\.pem:ro/);
  assert.match(compose, /NODE_EXTRA_CA_CERTS=\/etc\/http-freekit\/http-freekit-ca\.pem/);
  assert.doesNotMatch(compose, /SSL_CERT_FILE|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE/);
  assert.doesNotMatch(compose, /NODE_TLS_REJECT_UNAUTHORIZED/);
});

test('Docker activation does not claim HTTPS support without a CA', async () => {
  const interceptor = new DockerInterceptor();
  interceptor._platform = () => 'linux';
  interceptor._exec = () => '172.17.0.1\n';

  await assert.rejects(interceptor.activate(8080), /FreeKit CA certificate path is not configured/);
  assert.equal(interceptor.active, false);
});

test('Compose mount paths escape interpolation independently of YAML quoting', async t => {
  t.mock.method(console, 'log', () => {});
  const cases = [
    ['/home/dev/$project/ca.pem', '/home/dev/$$project/ca.pem'],
    ['/home/dev/${project:-default}/ca.pem', '/home/dev/$${project:-default}/ca.pem'],
    ['/home/dev/$$cash$/ca.pem', '/home/dev/$$$$cash$$/ca.pem'],
    ['C:\\Users\\$dev\\FreeKit CA.pem', 'C:\\Users\\$$dev\\FreeKit CA.pem'],
    ['/home/dev/CA "quoted".pem', '/home/dev/CA "quoted".pem']
  ];
  for (const [source, escaped] of cases) {
    const interceptor = new DockerInterceptor();
    interceptor._platform = () => 'linux';
    interceptor._getDockerHost = async () => '172.17.0.1';
    interceptor._getFreeKitCaPath = () => source;
    const result = await interceptor.activate(8080);
    const config = load(result.metadata.instructions.compose);
    assert.deepEqual(config.volumes, [`${escaped}:/etc/http-freekit/http-freekit-ca.pem:ro`]);
    assert.equal(result.metadata.caPath, source);
    assert.ok(config.environment.includes('NODE_EXTRA_CA_CERTS=/etc/http-freekit/http-freekit-ca.pem'));
  }
});
