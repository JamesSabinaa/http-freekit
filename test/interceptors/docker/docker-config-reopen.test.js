import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { DockerInterceptor } from '../../../src/interceptors/docker-interceptor.js';

const source = fs.readFileSync('src/ui/app.js', 'utf8');
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}

test('reopening active Docker configuration refreshes authoritative connection instructions', async () => {
  const docker = new DockerInterceptor();
  docker._platform = () => 'win32';
  docker._getFreeKitCaPath = () => 'C:\\FreeKit\\ca.pem';
  let port = 8080;
  let activations = 0;
  const context = {
    console,
    fetch: async url => {
      if (url.endsWith('/activate')) {
        activations++;
        const result = await docker.activate(port);
        return { json: async () => result };
      }
      return { json: async () => ({ interceptors: [{ id: 'docker', active: true }] }) };
    }
  };
  vm.runInNewContext(`
    let interceptorStateGeneration = 0;
    const API_BASE = 'http://api.test';
    ${section('let allInterceptors = [];', '// Interceptors that have expandable config components')}
    function filterInterceptors() {}
    function renderConnectedSources() {}
    function toast(message, type) { if (type === 'error') throw new Error(message); }
    ${section('async function handleExpandableCardClick(', 'function renderInterceptorConfig(')}
    globalThis.open = active => handleExpandableCardClick('docker', active);
    globalThis.close = collapseInterceptorCard;
    globalThis.metadata = () => expandedInterceptorMetadata;
  `, context);
  await context.open(false);
  const initial = context.metadata();
  assert.match(initial.instructions.run, /host\.docker\.internal:8080/);
  context.close();
  port = 9090;
  await context.open(true);
  assert.equal(activations, 2);
  const reopened = context.metadata();
  assert.match(reopened.instructions.run, /host\.docker\.internal:9090/);
  assert.match(reopened.instructions.run, /--mount/);
  assert.match(reopened.instructions.run, /NODE_EXTRA_CA_CERTS/);
  assert.match(reopened.instructions.compose, /ca\.pem/);
});
