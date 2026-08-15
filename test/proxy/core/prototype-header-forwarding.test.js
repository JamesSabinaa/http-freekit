import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { ProxyServer } from '../../../src/proxy/proxy-server.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function rawValues(rawHeaders, expectedName) {
  const values = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index].toLowerCase() === expectedName.toLowerCase()) {
      values.push(rawHeaders[index + 1]);
    }
  }
  return values;
}

function ownValue(headers, expectedName) {
  return Object.entries(headers).find(
    ([name]) => name.toLowerCase() === expectedName.toLowerCase()
  )?.[1];
}

test('HTTP/1 proxy retains prototype-named request, response, and trailer fields', async t => {
  let resolveOriginRequest;
  const originRequest = new Promise(resolve => { resolveOriginRequest = resolve; });
  const responseHeaders = JSON.parse(
    '{"__proto__":"response-proto","constructor":"response-ctor","toString":"response-text",' +
    '"trailer":"__proto__, constructor, toString"}'
  );
  const responseTrailers = JSON.parse(
    '{"__proto__":"response-trailer-proto","constructor":"response-trailer-ctor",' +
    '"toString":"response-trailer-text"}'
  );
  const origin = http.createServer((request, response) => {
    request.resume();
    request.once('end', () => {
      resolveOriginRequest({ rawHeaders: request.rawHeaders, rawTrailers: request.rawTrailers });
      for (const [name, value] of Object.entries(responseHeaders)) response.setHeader(name, value);
      response.write('ok');
      response.addTrailers(responseTrailers);
      response.end();
    });
  });
  const originPort = await listen(origin);
  t.after(() => close(origin));

  const captured = [];
  const proxy = new ProxyServer(null, { port: 0, onRequest: event => captured.push(event) });
  await proxy.start();
  t.after(() => proxy.stop());

  const requestHeaders = JSON.parse(
    '{"host":"127.0.0.1","__proto__":"request-proto","constructor":"request-ctor",' +
    '"toString":"request-text","trailer":"__proto__, constructor, toString",' +
    '"transfer-encoding":"chunked"}'
  );
  const requestTrailers = JSON.parse(
    '{"__proto__":"request-trailer-proto","constructor":"request-trailer-ctor",' +
    '"toString":"request-trailer-text"}'
  );
  const downstreamResponse = await new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port: proxy.server.address().port,
      path: `http://127.0.0.1:${originPort}/prototype-headers`,
      method: 'POST',
      headers: requestHeaders
    }, response => {
      response.resume();
      response.once('end', () => resolve({
        rawHeaders: response.rawHeaders,
        rawTrailers: response.rawTrailers
      }));
    });
    request.once('error', reject);
    request.write('body');
    request.addTrailers(requestTrailers);
    request.end();
  });

  const upstreamRequest = await originRequest;
  for (const [name, value] of [
    ['__proto__', 'request-proto'],
    ['constructor', 'request-ctor'],
    ['toString', 'request-text']
  ]) {
    assert.deepEqual(rawValues(upstreamRequest.rawHeaders, name), [value]);
  }
  for (const [name, value] of [
    ['__proto__', 'request-trailer-proto'],
    ['constructor', 'request-trailer-ctor'],
    ['toString', 'request-trailer-text']
  ]) {
    assert.deepEqual(rawValues(upstreamRequest.rawTrailers, name), [value]);
  }
  for (const [name, value] of [
    ['__proto__', 'response-proto'],
    ['constructor', 'response-ctor'],
    ['toString', 'response-text']
  ]) {
    assert.deepEqual(rawValues(downstreamResponse.rawHeaders, name), [value]);
  }
  for (const [name, value] of [
    ['__proto__', 'response-trailer-proto'],
    ['constructor', 'response-trailer-ctor'],
    ['toString', 'response-trailer-text']
  ]) {
    assert.deepEqual(rawValues(downstreamResponse.rawTrailers, name), [value]);
  }

  const completed = captured.findLast(event => event.statusCode === 200);
  assert.equal(ownValue(completed.requestHeaders, '__proto__'), 'request-proto');
  assert.equal(ownValue(completed.requestHeaders, 'constructor'), 'request-ctor');
  assert.equal(ownValue(completed.requestHeaders, 'toString'), 'request-text');
  assert.equal(ownValue(completed.responseHeaders, '__proto__'), 'response-proto');
  assert.equal(ownValue(completed.responseHeaders, 'constructor'), 'response-ctor');
  assert.equal(ownValue(completed.responseHeaders, 'toString'), 'response-text');
  assert.equal(ownValue(completed.trailers, '__proto__'), 'response-trailer-proto');
  assert.equal(ownValue(completed.trailers, 'constructor'), 'response-trailer-ctor');
  assert.equal(ownValue(completed.trailers, 'toString'), 'response-trailer-text');
});
