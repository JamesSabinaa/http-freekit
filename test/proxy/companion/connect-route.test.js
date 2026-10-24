import assert from 'node:assert/strict';
import test from 'node:test';
import {
  boundH1RequestStatus,
  boundH2Authority,
  connectDestination,
  connectRouteForUrl,
  createConnectRoute
} from '../../../src/proxy/connect-route.js';

test('CONNECT route binds a validated DNS SNI to the original literal and port', () => {
  const route = createConnectRoute('2001:db8::1', 443, 'App.Example.Invalid.');
  assert.equal(route.address, '2001:db8::1');
  assert.equal(route.logicalAuthority, 'app.example.invalid');
  assert.equal(Object.isFrozen(route), true);
  assert.equal(connectDestination(route, new URL('https://app.example.invalid/path')), '2001:db8::1');
  for (const name of [null, '', '*.invalid', 'bad/name', '127.0.0.1']) {
    assert.equal(createConnectRoute('127.0.0.1', 443, name), null);
  }
  assert.equal(createConnectRoute('normal.example', 443, 'app.example.invalid'), null);
});

test('same-origin transforms retain the IP while explicit origin changes do not', () => {
  const route = createConnectRoute('127.0.0.1', 8443, 'app.example.invalid');
  assert.equal(connectRouteForUrl(route, new URL('https://app.example.invalid:8443/changed?q=1')), route);
  assert.equal(connectDestination(route, new URL('wss://app.example.invalid:8443/socket')), '127.0.0.1');
  for (const url of ['https://other.invalid:8443/path', 'https://app.example.invalid/path', 'http://app.example.invalid:8443/path']) {
    assert.equal(connectRouteForUrl(route, new URL(url)), null);
  }
  assert.notEqual(route.poolKey, createConnectRoute('127.0.0.2', 8443, 'app.example.invalid').poolKey);
  assert.notEqual(route.poolKey, createConnectRoute('127.0.0.1', 8443, 'other.example.invalid').poolKey);
});

test('bound H1 rejects ambiguous Host, authority changes and non-origin targets', () => {
  const route = createConnectRoute('127.0.0.1', 443, 'app.example.invalid');
  const request = { method: 'GET', url: '/path?q=1', rawHeaders: ['Host', 'APP.EXAMPLE.INVALID:443'] };
  assert.equal(boundH1RequestStatus(route, request), 0);
  assert.equal(boundH1RequestStatus(route, { ...request, method: 'OPTIONS', url: '*' }), 0);
  for (const value of ['other.invalid', 'app.example.invalid:444', 'user@app.example.invalid', 'app.example.invalid/path', 'app.example.invalid#fragment']) {
    assert.equal(boundH1RequestStatus(route, { ...request, rawHeaders: ['Host', value] }), 421);
  }
  assert.equal(boundH1RequestStatus(route, { ...request, rawHeaders: [] }), 400);
  assert.equal(boundH1RequestStatus(route, { ...request, rawHeaders: ['Host', 'app.example.invalid', 'host', 'other.invalid'] }), 400);
  for (const target of ['https://other.invalid/', '@other.invalid/', '*', '/bad#fragment']) {
    assert.equal(boundH1RequestStatus(route, { ...request, url: target }), 400);
  }
});

test('bound H2 accepts only the logical authority and HTTPS with no conflicting Host', () => {
  const route = createConnectRoute('127.0.0.1', 443, 'app.example.invalid');
  assert.equal(boundH2Authority(route, 'APP.EXAMPLE.INVALID:443', 'https'), 'app.example.invalid');
  assert.equal(boundH2Authority(route, undefined, 'https'), 'app.example.invalid');
  for (const [value, scheme, host] of [
    ['other.invalid', 'https'], ['app.example.invalid:444', 'https'], ['app.example.invalid', 'http'],
    ['app.example.invalid', 'https', 'other.invalid'], ['app.example.invalid', 'https', ['app.example.invalid']]
  ]) assert.equal(boundH2Authority(route, value, scheme, host), null);
});
