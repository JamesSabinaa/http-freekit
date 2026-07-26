import assert from 'node:assert/strict';
import test from 'node:test';
import { DockerInterceptor } from '../src/interceptors/docker-interceptor.js';

for (const platform of ['win32', 'darwin']) {
  test(`Docker Desktop on ${platform} uses its host gateway name`, async () => {
    const interceptor = new DockerInterceptor();
    interceptor._getCombinedCaBundlePath = () => '/tmp/freekit-ca-bundle.pem';
    interceptor._platform = () => platform;
    interceptor._exec = () => assert.fail('Docker Desktop must not use the Linux bridge gateway');

    const result = await interceptor.activate(8080);

    assert.equal(result.metadata.hostIp, 'host.docker.internal');
    assert.equal(result.metadata.proxyUrl, 'http://host.docker.internal:8080');
    assert.match(result.metadata.instructions.run, /HTTP_PROXY=http:\/\/host\.docker\.internal:8080/);
  });
}

test('native Linux keeps using its inspected bridge gateway', async () => {
  const interceptor = new DockerInterceptor();
  interceptor._getCombinedCaBundlePath = () => '/tmp/freekit-ca-bundle.pem';
  interceptor._platform = () => 'linux';
  interceptor._exec = () => '"172.18.0.1"\n';

  const result = await interceptor.activate(9090);

  assert.equal(result.metadata.hostIp, '172.18.0.1');
  assert.equal(result.metadata.proxyUrl, 'http://172.18.0.1:9090');
});
