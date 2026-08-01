import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';

import { ProxyServer } from '../../src/proxy/proxy-server.js';

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

function captureNextEvent() {
  let resolveEvent;
  const event = new Promise(resolve => { resolveEvent = resolve; });
  return { event, onRequest: resolveEvent };
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

test('plain HTTP webhook transport failures are recorded after the client response', async t => {
  const webhook = http.createServer((request) => request.socket.destroy());
  await listen(webhook);
  t.after(() => close(webhook));

  const captured = captureNextEvent();
  const proxy = new ProxyServer(null, { onRequest: captured.onRequest });
  const response = await serveWebhook(
    proxy,
    `http://127.0.0.1:${webhook.address().port}/hook`
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body, '');
  const event = await captured.event;
  assert.equal(event.statusCode, 502);
  assert.equal(event.statusMessage, 'Webhook delivery failed');
  assert.ok(event.error);
});

test('plain HTTP webhook success is delivered and recorded asynchronously', async t => {
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

  const captured = captureNextEvent();
  const proxy = new ProxyServer(null, { onRequest: captured.onRequest });
  const response = await serveWebhook(
    proxy,
    `http://127.0.0.1:${webhook.address().port}/hook`,
    Buffer.from('delivered')
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body, '');
  const event = await captured.event;
  assert.equal(receivedBody, 'delivered');
  assert.equal(event.statusCode, 200);
  assert.equal(event.statusMessage, 'Webhook sent');
  assert.equal(event.error, undefined);
});

test('non-2xx webhook responses are recorded without changing the client response', async t => {
  const webhook = http.createServer((request, response) => {
    response.writeHead(Number(request.url.slice(1)));
    response.end();
  });
  await listen(webhook);
  t.after(() => close(webhook));

  for (const webhookStatus of [302, 404, 503]) {
    const captured = captureNextEvent();
    const proxy = new ProxyServer(null, { onRequest: captured.onRequest });
    const response = await serveWebhook(
      proxy,
      `http://127.0.0.1:${webhook.address().port}/${webhookStatus}`
    );

    assert.equal(response.statusCode, 200);
    assert.equal(response.body, '');
    const event = await captured.event;
    assert.equal(event.statusCode, 502);
    assert.equal(event.statusMessage, 'Webhook delivery failed');
    assert.equal(event.error, `Webhook endpoint responded with HTTP ${webhookStatus}`);
  }
});

test('invalid webhook URLs are recorded without changing the client response', async () => {
  const captured = captureNextEvent();
  const proxy = new ProxyServer(null, { onRequest: captured.onRequest });
  const response = await serveWebhook(proxy, 'not a URL');

  assert.equal(response.statusCode, 200);
  assert.equal(response.body, '');
  const event = await captured.event;
  assert.equal(event.statusMessage, 'Webhook delivery failed');
  assert.ok(event.error);
});

test('a webhook that never sends headers cannot block the matched response', async t => {
  const webhook = http.createServer(request => request.resume());
  await listen(webhook);
  t.after(async () => {
    webhook.closeAllConnections?.();
    await close(webhook);
  });

  const events = [];
  const proxy = new ProxyServer(null, { onRequest: event => events.push(event) });
  const timeout = Symbol('timeout');
  const response = await Promise.race([
    serveWebhook(proxy, `http://127.0.0.1:${webhook.address().port}/hang`),
    new Promise(resolve => setTimeout(() => resolve(timeout), 250))
  ]);

  assert.notEqual(response, timeout);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, '');
  assert.deepEqual(events, []);
});

test('proxy shutdown cancels and settles an unfinished webhook delivery', async t => {
  const webhook = http.createServer(request => request.resume());
  await listen(webhook);
  t.after(() => close(webhook));

  const requestReceived = once(webhook, 'request');
  const events = [];
  const proxy = new ProxyServer(null, { onRequest: event => events.push(event) });
  const response = await serveWebhook(
    proxy,
    `http://127.0.0.1:${webhook.address().port}/hang`
  );
  await requestReceived;

  assert.equal(response.statusCode, 200);
  assert.equal(proxy._activeWebhookRequests.size, 1);
  await proxy.stop();

  assert.equal(proxy._activeWebhookRequests.size, 0);
  assert.equal(proxy._pendingWebhookFinalizations.size, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].statusCode, 502);
  assert.equal(events[0].statusMessage, 'Webhook delivery failed');
  assert.match(events[0].error, /Proxy stopped before webhook delivery completed/);
});

test('proxy shutdown cancels delayed webhook preparation across a restart', async t => {
  let webhookRequests = 0;
  const webhook = http.createServer((request, response) => {
    webhookRequests++;
    request.resume();
    response.writeHead(204);
    response.end();
  });
  await listen(webhook);
  t.after(() => close(webhook));

  const events = [];
  const proxy = new ProxyServer(null, {
    port: 0,
    onRequest: event => events.push(event)
  });
  const response = createClientResponse();
  let preparationSettled = false;
  const delayedDelivery = proxy._serveMockResponse(
    'delayed-webhook',
    { method: 'POST', headers: { 'content-type': 'text/plain' } },
    response,
    new URL('http://target.test/resource'),
    Buffer.from('payload'),
    {
      preSteps: [{ type: 'delay', ms: 200 }],
      action: {
        type: 'webhook',
        webhookUrl: `http://127.0.0.1:${webhook.address().port}/late`
      }
    },
    Date.now()
  ).finally(() => { preparationSettled = true; });

  await new Promise(resolve => setTimeout(resolve, 20));
  await proxy.stop();
  assert.equal(preparationSettled, true);
  assert.equal(proxy._pendingWebhookPreparations.size, 0);

  await proxy.start();
  await delayedDelivery;
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(response.statusCode, null);
  assert.equal(webhookRequests, 0);
  assert.deepEqual(events, []);
  await proxy.stop();
});
