import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const helperStart = source.indexOf('function copyTextToClipboard(');
const helperEnd = source.indexOf('// Store current detail headers', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart);
const helperSource = source.slice(helperStart, helperEnd);

function createHelper(writeText) {
  const toasts = [];
  const context = {
    navigator: { clipboard: { writeText } },
    Promise,
    String,
    toast: (message, type) => toasts.push({ message, type })
  };
  vm.createContext(context);
  vm.runInContext(`${helperSource}; globalThis.copy = copyTextToClipboard;`, context);
  return { copy: context.copy, toasts };
}

test('shared Clipboard helper reports synchronous and asynchronous failures', async () => {
  const synchronous = createHelper(() => { throw new Error('denied'); });
  await synchronous.copy('secret');
  assert.deepEqual(synchronous.toasts, [{ message: 'Failed to copy', type: 'error' }]);

  const asynchronous = createHelper(() => Promise.reject(new Error('denied')));
  await asynchronous.copy('secret');
  assert.deepEqual(asynchronous.toasts, [{ message: 'Failed to copy', type: 'error' }]);
});

test('shared Clipboard helper reports success only after the write resolves', async () => {
  const writes = [];
  const harness = createHelper(value => {
    writes.push(value);
    return Promise.resolve();
  });

  await harness.copy(0, 'Value copied');

  assert.deepEqual(writes, ['0']);
  assert.deepEqual(harness.toasts, [{ message: 'Value copied', type: 'success' }]);
});
