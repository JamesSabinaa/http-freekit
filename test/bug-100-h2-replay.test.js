import assert from 'node:assert/strict';
import test from 'node:test';

import { ProxyServer } from '../src/proxy/proxy-server.js';

function createDownstream() {
  return {
    completed: 0,
    complete() {
      this.completed += 1;
    }
  };
}

test('an attempted H2 mutation is settled instead of falling back and replaying', () => {
  const proxy = new ProxyServer();
  const error = new Error('stream reset after origin processed request');

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'CONNECT']) {
    const downstream = createDownstream();
    const responses = [];

    const settled = proxy._settleNonReplayableH2Failure(
      method, true, error, downstream, value => responses.push(value)
    );

    assert.equal(settled, true, method);
    assert.equal(downstream.completed, 1, method);
    assert.deepEqual(responses, [error], method);
  }
});

test('H2 setup failures and safe methods may still fall back to HTTP/1.1', () => {
  const proxy = new ProxyServer();
  const error = new Error('h2 unavailable');

  for (const [method, requestAttempted] of [
    ['POST', false],
    ['GET', true],
    ['HEAD', true],
    ['OPTIONS', true],
    ['TRACE', true]
  ]) {
    const downstream = createDownstream();
    let responded = false;

    const settled = proxy._settleNonReplayableH2Failure(
      method, requestAttempted, error, downstream, () => { responded = true; }
    );

    assert.equal(settled, false, `${method}/${requestAttempted}`);
    assert.equal(downstream.completed, 0, `${method}/${requestAttempted}`);
    assert.equal(responded, false, `${method}/${requestAttempted}`);
  }
});
