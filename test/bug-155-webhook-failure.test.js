import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { ProxyServer } from '../src/proxy/proxy-server.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1');
    server.once('listening', resolve);
    server.once('error', reject);
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function createClientResponse() {
  return {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    }
  };
}

async function serveWebhook(proxy, webhookUrl, body = Buffer.from('payload')) {
  const response = createClientResponse();
  await proxy._serveMockResponse(
    'request-id',
    { method: 'POST', headers: { 'content-type': 'text/plain' } },
    response,
    new URL('http://target.test/resource'),
    body,
    { action: { type: 'webhook', webhookUrl } },
    Date.now()
  );
  return response;
}

test('plain HTTP webhook transport failures return and record an error', async t => {
  const webhook = http.createServer((request) => request.socket.destroy());
  await listen(webhook);
  t.after(() => close(webhook));

  const events = [];
  const proxy = new ProxyServer(null, { onRequest: event => events.push(event) });
  const response = await serveWebhook(
    proxy,
    `http://127.0.0.1:${webhook.address().port}/hook`
  );

  assert.equal(response.statusCode, 502);
  assert.match(response.body, /^Webhook Error:/);
  assert.equal(events.length, 1);
  assert.equal(events[0].statusCode, 502);
  assert.equal(events[0].statusMessage, 'Webhook delivery failed');
  assert.ok(events[0].error);
});

test('plain HTTP webhook success is recorded only after the endpoint responds', async t => {
  let receivedBody = '';
  const webhook = http.createServer((request, response) => {
    request.setEncoding('utf8');
    request.on('data', chunk => { receivedBody += chunk; });
    request.on('end', () => {
      response.writeHead(204);
      response.end();
    });
  });
  await listen(webhook);
  t.after(() => close(webhook));

  const events = [];
  const proxy = new ProxyServer(null, { onRequest: event => events.push(event) });
  const response = await serveWebhook(
    proxy,
    `http://127.0.0.1:${webhook.address().port}/hook`,
    Buffer.from('delivered')
  );

  assert.equal(response.statusCode, 200);
  assert.equal(receivedBody, 'delivered');
  assert.equal(events.length, 1);
  assert.equal(events[0].statusCode, 200);
  assert.equal(events[0].statusMessage, 'Webhook sent');
  assert.equal(events[0].error, undefined);
});

test('invalid webhook URLs do not report success', async () => {
  const events = [];
  const proxy = new ProxyServer(null, { onRequest: event => events.push(event) });
  const response = await serveWebhook(proxy, 'not a URL');

  assert.equal(response.statusCode, 502);
  assert.equal(events[0].statusMessage, 'Webhook delivery failed');
  assert.ok(events[0].error);
});
