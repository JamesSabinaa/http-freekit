import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { startStdioBridge } from '../../src/mcp/stdio-bridge.js';

class FakeTransport {
  constructor(startPromise = Promise.resolve()) {
    this.startPromise = startPromise;
    this.startCalls = 0;
    this.closeCalls = 0;
    this.sendCalls = 0;
  }

  start() {
    this.startCalls += 1;
    return this.startPromise;
  }

  close() {
    this.closeCalls += 1;
    return Promise.resolve();
  }

  send() {
    this.sendCalls += 1;
    return Promise.resolve();
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function withTimeout(promise, message, timeout = 2000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeout);
    })
  ]).finally(() => clearTimeout(timer));
}

function createDescriptor(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-stdio-eof-'));
  const descriptorPath = path.join(directory, 'runtime.json');
  fs.writeFileSync(descriptorPath, JSON.stringify({
    sseUrl: 'http://127.0.0.1:49152/mcp/sse',
    authToken: 'test-secret'
  }));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return descriptorPath;
}

test('stdin EOF during remote startup closes once and prevents late stdio startup', async t => {
  const descriptorPath = createDescriptor(t);

  for (const lateSettlement of ['resolve', 'reject']) {
    await t.test(`remote start can ${lateSettlement} after EOF`, async () => {
      const remoteStart = deferred();
      const stdin = new EventEmitter();
      stdin.readableEnded = false;
      stdin.destroyed = false;
      const remote = new FakeTransport(remoteStart.promise);
      const stdio = new FakeTransport();
      const originalExitCode = process.exitCode;

      const starting = startStdioBridge(descriptorPath, {
        stdin,
        stdout: {},
        createRemoteTransport: () => remote,
        createStdioTransport: () => stdio
      });
      await new Promise(resolve => setImmediate(resolve));

      assert.equal(remote.startCalls, 1);
      assert.equal(stdio.startCalls, 0);
      assert.equal(stdin.listenerCount('end'), 1);
      assert.equal(stdin.listenerCount('close'), 1);

      stdin.emit('end');
      stdin.emit('close');
      const bridge = await withTimeout(starting, 'Bridge startup did not stop after stdin EOF');
      const closeResult = await withTimeout(bridge.closed, 'Bridge cleanup did not finish after stdin EOF');

      assert.equal(bridge.isClosed, true);
      assert.equal(closeResult.error, null);
      assert.deepEqual(closeResult.transports.map(result => result.status), ['fulfilled', 'fulfilled']);
      assert.equal(remote.closeCalls, 1);
      assert.equal(stdio.closeCalls, 1);
      assert.equal(stdio.startCalls, 0);
      assert.equal(stdin.listenerCount('end'), 0);
      assert.equal(stdin.listenerCount('close'), 0);
      assert.equal(process.exitCode, originalExitCode);
      assert.strictEqual(bridge.close(), bridge.closed);
      assert.equal(Object.getOwnPropertyDescriptor(bridge, 'closed').writable, false);

      const lateError = new Error('late remote startup failure');
      if (lateSettlement === 'resolve') remoteStart.resolve();
      else remoteStart.reject(lateError);
      await new Promise(resolve => setImmediate(resolve));

      assert.equal(stdio.startCalls, 0);
      assert.equal(remote.closeCalls, 1);
      assert.equal(stdio.closeCalls, 1);
      assert.equal(process.exitCode, originalExitCode);
    });
  }
});

test('stdin EOF observed before the startup microtask prevents either transport from starting', async t => {
  const descriptorPath = createDescriptor(t);
  const stdin = new EventEmitter();
  stdin.readableEnded = false;
  stdin.destroyed = false;
  const remote = new FakeTransport();
  const stdio = new FakeTransport();

  const starting = startStdioBridge(descriptorPath, {
    stdin,
    stdout: {},
    createRemoteTransport: () => remote,
    createStdioTransport: () => stdio
  });
  stdin.emit('close');
  const bridge = await withTimeout(starting, 'Bridge startup did not stop after early stdin EOF');
  await bridge.closed;

  assert.equal(remote.startCalls, 0);
  assert.equal(stdio.startCalls, 0);
  assert.equal(remote.closeCalls, 1);
  assert.equal(stdio.closeCalls, 1);
});

test('transport errors use the same cleanup completion and retain an error exit code', async t => {
  const descriptorPath = createDescriptor(t);
  const stdin = new EventEmitter();
  stdin.readableEnded = false;
  stdin.destroyed = false;
  const remote = new FakeTransport();
  const stdio = new FakeTransport();
  const originalExitCode = process.exitCode;
  const originalConsoleError = console.error;
  const errors = [];
  console.error = (...args) => { errors.push(args); };
  t.after(() => {
    console.error = originalConsoleError;
    process.exitCode = originalExitCode;
  });

  const bridge = await startStdioBridge(descriptorPath, {
    stdin,
    stdout: {},
    createRemoteTransport: () => remote,
    createStdioTransport: () => stdio
  });
  const remoteError = remote.onerror;
  const remoteClose = remote.onclose;
  const expectedError = new Error('remote failed');

  remoteError(expectedError);
  stdin.emit('end');
  stdin.emit('close');
  remoteClose();
  const duplicateClose = bridge.close();
  const closeResult = await bridge.closed;

  assert.strictEqual(duplicateClose, bridge.closed);
  assert.strictEqual(closeResult.error, expectedError);
  assert.equal(process.exitCode, 1);
  assert.equal(errors.length, 1);
  assert.equal(remote.closeCalls, 1);
  assert.equal(stdio.closeCalls, 1);
  assert.equal(remote.onmessage, undefined);
  assert.equal(stdio.onmessage, undefined);
  assert.equal(remote.onerror, undefined);
  assert.equal(stdio.onerror, undefined);
  assert.equal(remote.onclose, undefined);
  assert.equal(stdin.listenerCount('end'), 0);
  assert.equal(stdin.listenerCount('close'), 0);
});
