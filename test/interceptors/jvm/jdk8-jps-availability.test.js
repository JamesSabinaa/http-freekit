import assert from 'node:assert/strict';
import test from 'node:test';

import { JvmInterceptor } from '../../../src/interceptors/jvm-interceptor.js';

test('JDK 8 availability uses its supported quiet jps probe and accepts empty output', async () => {
  const interceptor = new JvmInterceptor();
  const calls = [];
  interceptor._runAvailabilityCommand = async (file, args, options) => {
    calls.push({ file, args, options });
    if (file === 'java') return 'java version "1.8.0"';
    if (args[0] === '-h') {
      throw Object.assign(new Error('illegal argument: -h'), { code: 1 });
    }
    assert.deepEqual(args, ['-q']);
    return '';
  };

  assert.equal(await interceptor.isActivable(), true);
  assert.deepEqual(calls, [
    { file: 'java', args: ['-version'], options: { timeout: 5000 } },
    { file: 'jps', args: ['-q'], options: { timeout: 3000 } }
  ]);
});

test('modern JDK availability accepts successful quiet jps output', async () => {
  const interceptor = new JvmInterceptor();
  interceptor._runAvailabilityCommand = async (file, args) => {
    if (file === 'java') return 'openjdk version "25"';
    assert.deepEqual(args, ['-q']);
    return '12345\n67890\n';
  };

  assert.equal(await interceptor.isActivable(), true);
});

test('JVM interception remains unavailable when java is missing', async () => {
  const interceptor = new JvmInterceptor();
  let jpsCalled = false;
  interceptor._runAvailabilityCommand = async file => {
    if (file === 'java') {
      throw Object.assign(new Error('spawn java ENOENT'), { code: 'ENOENT' });
    }
    jpsCalled = true;
    return '';
  };

  assert.equal(await interceptor.isActivable(), false);
  assert.equal(jpsCalled, false);
});

test('JVM interception remains unavailable when jps is missing', async () => {
  const interceptor = new JvmInterceptor();
  interceptor._runAvailabilityCommand = async file => {
    if (file === 'java') return 'openjdk version "21"';
    throw Object.assign(new Error('spawn jps ENOENT'), { code: 'ENOENT' });
  };

  assert.equal(await interceptor.isActivable(), false);
});
