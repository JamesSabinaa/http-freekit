import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { execFileAsync } from '../src/interceptors/command-runner.js';
import { JvmInterceptor } from '../src/interceptors/jvm-interceptor.js';

const runningProcess = {
  pid: '331',
  name: 'Example',
  mainClass: 'example.Main'
};

test('command execution reports only successfully spawned helpers as started', async () => {
  let helperStarted = false;
  const output = await execFileAsync(
    process.execPath,
    ['-e', 'process.stdout.write("started")'],
    {
      encoding: 'utf8',
      onSpawn: () => { helperStarted = true; }
    }
  );
  assert.equal(output, 'started');
  assert.equal(helperStarted, true);

  let missingHelperStarted = false;
  await assert.rejects(execFileAsync(
    path.join(process.cwd(), 'missing-bug-331-helper'),
    [],
    { onSpawn: () => { missingHelperStarted = true; } }
  ));
  assert.equal(missingHelperStarted, false);
});

test('JVM build and helper preparation failures are definitely pre-attach', async () => {
  const buildFailure = new JvmInterceptor();
  buildFailure._getAgentJarPath = async () => null;
  buildFailure._ensureAttachHelper = async () => {
    assert.fail('attach helper must not be prepared after an agent build failure');
  };

  assert.deepEqual(await buildFailure._attachAgent('331', '127.0.0.1', 8000), {
    success: false,
    error: 'Failed to build proxy agent JAR',
    targetMutationPossible: false
  });

  const helperFailure = new JvmInterceptor();
  helperFailure._getAgentJarPath = async () => 'proxy-agent.jar';
  helperFailure._ensureAttachHelper = async () => {
    throw new Error('javac unavailable');
  };
  helperFailure._runAttachHelper = async () => {
    assert.fail('attach helper must not run after preparation fails');
  };

  assert.deepEqual(await helperFailure._attachAgent('331', '127.0.0.1', 8000), {
    success: false,
    error: 'javac unavailable',
    targetMutationPossible: false
  });

  helperFailure._getRunningProcesses = async () => [runningProcess];
  const activation = await helperFailure.activate(8000, { pid: '331' });
  assert.equal(activation.success, false);
  assert.equal(activation.metadata.activationUncertain, false);
  assert.deepEqual(activation.metadata.activatedProcesses, []);
  assert.equal(helperFailure.active, false);
});

test('JVM helper failure after spawn retains uncertain ownership without reporting success', async () => {
  const interceptor = new JvmInterceptor();
  interceptor._getAgentJarPath = async () => 'proxy-agent.jar';
  interceptor._ensureAttachHelper = async () => 'attach-helper';
  interceptor._runAttachHelper = async (attachDir, pid, agentJar, agentArgs, onSpawn) => {
    assert.equal(attachDir, 'attach-helper');
    assert.equal(pid, '331');
    assert.equal(agentJar, 'proxy-agent.jar');
    assert.match(agentArgs, /freekit\.action=activate/);
    onSpawn();
    const error = new Error('attach helper timed out');
    error.killed = true;
    throw error;
  };
  interceptor._getRunningProcesses = async () => [runningProcess];

  const activation = await interceptor.activate(8000, { pid: '331' });

  assert.equal(activation.success, false);
  assert.match(activation.error, /target may have changed; Stop will retry restoration/);
  assert.deepEqual(activation.metadata.activatedProcesses, [{
    pid: '331',
    name: 'Example',
    mainClass: 'example.Main',
    activationUncertain: true
  }]);
  assert.equal(activation.metadata.activationUncertain, true);
  assert.equal(interceptor.active, true);
  assert.deepEqual(interceptor.toJSON(), {
    id: 'jvm',
    name: 'Java/JVM Application',
    type: 'jvm',
    active: true,
    activationUncertain: true,
    pid: null
  });

  const metadata = await interceptor.getMetadata();
  assert.equal(metadata.activationUncertain, true);
  assert.equal(metadata.activatedProcesses[0].activationUncertain, true);
});

test('Stop retries restoration for an uncertain JVM PID until cleanup succeeds', async () => {
  const interceptor = new JvmInterceptor();
  interceptor.activatedProcesses.set('331', {
    name: 'Example',
    mainClass: 'example.Main',
    activationUncertain: true
  });
  interceptor.active = true;
  let attempts = 0;
  interceptor._attachAgent = async (pid, proxyHost, proxyPort, action) => {
    assert.equal(pid, '331');
    assert.equal(proxyHost, null);
    assert.equal(proxyPort, null);
    assert.equal(action, 'deactivate');
    attempts += 1;
    return attempts === 1
      ? { success: false, error: 'restore timed out', targetMutationPossible: true }
      : { success: true };
  };

  await assert.rejects(
    interceptor.deactivate({ pid: '331' }),
    /PID 331: restore timed out/
  );
  assert.equal(interceptor.activatedProcesses.get('331').activationUncertain, true);
  assert.equal(interceptor.active, true);

  await interceptor.deactivate({ pid: '331' });
  assert.equal(attempts, 2);
  assert.equal(interceptor.activatedProcesses.has('331'), false);
  assert.equal(interceptor.active, false);
  assert.equal(interceptor.toJSON().activationUncertain, false);
});
