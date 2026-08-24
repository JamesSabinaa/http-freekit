import assert from 'node:assert/strict';
import test from 'node:test';
import { DockerInterceptor } from '../../../src/interceptors/docker-interceptor.js';

test('Docker activation rejects an unchanged running container', async () => {
  const interceptor = new DockerInterceptor();
  interceptor.ca = { getCertInfo: () => ({ certificatePath: '/tmp/freekit-ca.pem' }) };
  interceptor._getDockerHost = () => '172.17.0.1';

  await assert.rejects(
    interceptor.activate(8080, { containerId: 'already-running' }),
    /Running Docker containers cannot have proxy or CA environment added/
  );

  assert.equal(interceptor.active, false);
  assert.equal(await interceptor.isActive(), false);
  assert.equal(interceptor.toJSON().active, false);
});

test('instruction-only Docker activation reports a coherent active lifecycle', async t => {
  t.mock.method(console, 'log', () => {});
  const interceptor = new DockerInterceptor();
  interceptor._platform = () => 'linux';
  interceptor._getDockerHost = async () => '172.17.0.1';
  interceptor._getFreeKitCaPath = () => '/tmp/freekit-ca-bundle.pem';

  const result = await interceptor.activate(8080);

  assert.equal(result.success, true);
  assert.equal(interceptor.active, true);
  assert.equal(await interceptor.isActive(), true);
  assert.equal(interceptor.toJSON().active, true);

  await interceptor.deactivate();
  assert.equal(interceptor.active, false);
  assert.equal(await interceptor.isActive(), false);
  assert.equal(interceptor.toJSON().active, false);
});
