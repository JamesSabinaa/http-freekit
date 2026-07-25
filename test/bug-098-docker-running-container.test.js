import assert from 'node:assert/strict';
import test from 'node:test';
import { DockerInterceptor } from '../src/interceptors/docker-interceptor.js';

test('Docker activation rejects an unchanged running container', async () => {
  const interceptor = new DockerInterceptor();
  interceptor.ca = { getCertInfo: () => ({ certificatePath: '/tmp/freekit-ca.pem' }) };
  interceptor._getDockerHost = () => '172.17.0.1';

  await assert.rejects(
    interceptor.activate(8080, { containerId: 'already-running' }),
    /Running Docker containers cannot have proxy or CA environment added/
  );

  assert.equal(interceptor.active, false);
  assert.equal(interceptor.interceptedContainers.size, 0);
});
