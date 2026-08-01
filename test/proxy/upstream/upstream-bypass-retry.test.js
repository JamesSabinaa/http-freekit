import assert from 'node:assert/strict';
import http from 'node:http';
import { setImmediate as waitForImmediate } from 'node:timers/promises';
import test from 'node:test';
import { ApiServer } from '../../../src/api/api-server.js';
import { ProxyServer } from '../../../src/proxy/proxy-server.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise(resolve => server.close(resolve));
}

function requestThroughProxy(proxyPort, url) {
  return new Promise((resolve, reject) => {
    const request = http.get({
      hostname: '127.0.0.1',
      port: proxyPort,
      path: url,
      headers: { connection: 'close' }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    request.once('error', reject);
  });
}

async function startProxy(upstreamPort, noProxy = []) {
  let api;
  const proxy = new ProxyServer(null, {
    port: 0,
    upstreamConnectTimeoutMs: 1000,
    upstreamIdleTimeoutMs: 1000,
    upstreamRetryDelayMs: 0,
    onRequest: data => api.onTrafficEvent(data)
  });
  proxy.setUpstreamProxy({
    host: '127.0.0.1',
    port: upstreamPort,
    type: 'http',
    noProxy
  });
  api = new ApiServer(proxy, null, null);
  api.settings = {
    get: key => key === 'autoRotateProxyOnError'
      ? { enabled: true, provider: 'test-provider' }
      : undefined,
    set: () => {}
  };
  await proxy.start();
  return { proxy, api };
}

test('a noProxy 410 response is returned once without rotating the provider', async (t) => {
  let originHits = 0;
  let upstreamHits = 0;
  let rotations = 0;
  const origin = http.createServer((_request, response) => {
    originHits++;
    response.writeHead(410);
    response.end('direct gone');
  });
  const originPort = await listen(origin);
  const upstream = http.createServer((_request, response) => {
    upstreamHits++;
    response.end('unexpected upstream');
  });
  const upstreamPort = await listen(upstream);
  const { proxy, api } = await startProxy(upstreamPort, ['127.0.0.1']);
  api._rotateBottingToolsProxy = async () => {
    rotations++;
    return { applied: true, provider: 'test-provider', upstreamProxy: proxy.upstreamProxy };
  };
  t.after(async () => {
    await proxy.stop();
    await close(upstream);
    await close(origin);
  });

  const result = await requestThroughProxy(
    proxy.server.address().port,
    `http://127.0.0.1:${originPort}/gone`
  );
  await waitForImmediate();

  assert.equal(result.statusCode, 410);
  assert.equal(result.body, 'direct gone');
  assert.equal(originHits, 1);
  assert.equal(upstreamHits, 0);
  assert.equal(rotations, 0);
  assert.equal(api.trafficLog.at(-1).usedUpstreamProxy, false);
});

test('a transient noProxy failure is attempted once without rotating the provider', async (t) => {
  let originHits = 0;
  let upstreamHits = 0;
  let rotations = 0;
  const origin = http.createServer(request => {
    originHits++;
    request.socket.destroy();
  });
  const originPort = await listen(origin);
  const upstream = http.createServer((_request, response) => {
    upstreamHits++;
    response.end('unexpected upstream');
  });
  const upstreamPort = await listen(upstream);
  const { proxy, api } = await startProxy(upstreamPort, ['127.0.0.1']);
  api._rotateBottingToolsProxy = async () => {
    rotations++;
    return { applied: true, provider: 'test-provider', upstreamProxy: proxy.upstreamProxy };
  };
  t.after(async () => {
    await proxy.stop();
    await close(upstream);
    await close(origin);
  });

  const result = await requestThroughProxy(
    proxy.server.address().port,
    `http://127.0.0.1:${originPort}/disconnect`
  );
  await waitForImmediate();

  assert.equal(result.statusCode, 502);
  assert.match(result.body, /^Proxy Error:/);
  assert.equal(originHits, 1);
  assert.equal(upstreamHits, 0);
  assert.equal(rotations, 0);
  assert.equal(api.trafficLog.at(-1).usedUpstreamProxy, false);
});

test('a proxied 410 response rotates and retries with the new provider', async (t) => {
  let firstProviderHits = 0;
  let secondProviderHits = 0;
  let rotations = 0;
  const firstProvider = http.createServer((_request, response) => {
    firstProviderHits++;
    response.writeHead(410);
    response.end('gone');
  });
  const firstProviderPort = await listen(firstProvider);
  const secondProvider = http.createServer((_request, response) => {
    secondProviderHits++;
    response.end('recovered');
  });
  const secondProviderPort = await listen(secondProvider);
  const { proxy, api } = await startProxy(firstProviderPort);
  api._rotateBottingToolsProxy = async () => {
    rotations++;
    proxy.setUpstreamProxy({ host: '127.0.0.1', port: secondProviderPort, type: 'http' });
    return { applied: true, provider: 'test-provider', upstreamProxy: proxy.upstreamProxy };
  };
  t.after(async () => {
    await proxy.stop();
    await close(secondProvider);
    await close(firstProvider);
  });

  const result = await requestThroughProxy(
    proxy.server.address().port,
    'http://proxied.example.test/gone'
  );

  assert.equal(result.statusCode, 200);
  assert.equal(result.body, 'recovered');
  assert.equal(firstProviderHits, 1);
  assert.equal(secondProviderHits, 1);
  assert.equal(rotations, 1);
  assert.equal(api.trafficLog.at(-1).usedUpstreamProxy, true);
});

test('a transient proxied failure rotates and retries with the new provider', async (t) => {
  let firstProviderHits = 0;
  let secondProviderHits = 0;
  let rotations = 0;
  const firstProvider = http.createServer(request => {
    firstProviderHits++;
    request.socket.destroy();
  });
  const firstProviderPort = await listen(firstProvider);
  const secondProvider = http.createServer((_request, response) => {
    secondProviderHits++;
    response.end('recovered');
  });
  const secondProviderPort = await listen(secondProvider);
  const { proxy, api } = await startProxy(firstProviderPort);
  api._rotateBottingToolsProxy = async () => {
    rotations++;
    proxy.setUpstreamProxy({ host: '127.0.0.1', port: secondProviderPort, type: 'http' });
    return { applied: true, provider: 'test-provider', upstreamProxy: proxy.upstreamProxy };
  };
  t.after(async () => {
    await proxy.stop();
    await close(secondProvider);
    await close(firstProvider);
  });

  const result = await requestThroughProxy(
    proxy.server.address().port,
    'http://proxied.example.test/disconnect'
  );

  assert.equal(result.statusCode, 200);
  assert.equal(result.body, 'recovered');
  assert.equal(firstProviderHits, 1);
  assert.equal(secondProviderHits, 1);
  assert.equal(rotations, 1);
  assert.equal(api.trafficLog.at(-1).usedUpstreamProxy, true);
});
