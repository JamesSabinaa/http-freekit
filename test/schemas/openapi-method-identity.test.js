import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import { ApiServer } from '../../src/api/api-server.js';
import { ProxyServer } from '../../src/proxy/proxy-server.js';

const methods = ['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH', 'TRACE'];

test('OpenAPI annotations preserve method identity through import, Send, capture and explicit matching', { timeout: 15000 }, async t => {
  const wireMethods = [];
  const sockets = new Set();
  const origin = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let data = '';
    socket.on('data', chunk => {
      data += chunk.toString('latin1');
      if (!data.includes('\r\n\r\n')) return;
      wireMethods.push(data.split(' ', 1)[0]);
      socket.removeAllListeners('data');
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    });
  });
  let api;
  const proxy = new ProxyServer(null, { port: 0, onRequest: data => api.onTrafficEvent(data) });
  api = new ApiServer(proxy, null, null, { port: 0 });
  api.port = 0;
  t.after(async () => {
    await api.stop();
    await proxy.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => origin.close(resolve));
  });
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
  await proxy.start();
  await api.start();
  const baseUrl = `http://127.0.0.1:${origin.address().port}`;
  const jsonRequest = (pathname, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1', port: api.httpServer.address().port, path: pathname,
      method: payload === undefined ? 'GET' : 'POST',
      headers: payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    request.on('error', reject);
    request.end(payload);
  });
  const imported = await jsonRequest('/api/specs', {
    title: 'Method identity', baseUrl,
    spec: { openapi: '3.0.3', info: { title: 'Method identity', version: '1' },
      paths: { '/same': Object.fromEntries(methods.map(method => [method.toLowerCase(), {
        operationId: `${method}Resource`, responses: { '200': { description: 'OK' } }
      }])) }
    }
  });
  assert.equal(imported.status, 200);
  assert.equal(imported.body.success, true);
  for (const standard of methods) {
    for (const method of [standard, standard.toLowerCase(), standard[0] + standard.slice(1).toLowerCase()]) {
      await t.test(method, async () => {
        const result = await jsonRequest('/api/send', {
          url: `${baseUrl}/same`, method, headers: { 'content-length': '0' }, body: ''
        });
        assert.equal(result.status, 200);
        assert.equal(result.body.statusCode, 200);
        const traffic = api.trafficLog.find(row => row.id === result.body.trafficId);
        assert.equal(traffic.method, method);
        assert.equal(wireMethods.at(-1), method);
        const expected = method === standard ? `${standard}Resource` : null;
        assert.equal(traffic.apiMatch?.operationId ?? null, expected);
        const explicit = await jsonRequest('/api/specs/match?' + new URLSearchParams({ method, path: '/same', host: '127.0.0.1' }));
        assert.equal(explicit.status, 200);
        assert.equal(explicit.body.match?.operationId ?? null, expected);
      });
    }
  }
  assert.equal(proxy.matchApiSpec('MiXeD', '/same', '127.0.0.1'), null);
});
