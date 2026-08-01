import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';
import { parseApiPort, startWithValidatedApiPort } from '../../src/startup-config.js';

const INVALID_API_PORT_MESSAGE = 'Invalid API_PORT: expected a decimal integer from 1 to 65535.';

test('API_PORT accepts decimal ports and defaults only when unset or empty', () => {
  assert.equal(parseApiPort(undefined), 8001);
  assert.equal(parseApiPort(''), 8001);
  assert.equal(parseApiPort('1'), 1);
  assert.equal(parseApiPort('00080'), 80);
  assert.equal(parseApiPort('65535'), 65535);
});

test('API_PORT rejects malformed and out-of-range values without exposing their contents', () => {
  const invalidValues = [
    '0',
    '-1',
    '+80',
    '12.5',
    '1e3',
    '70000',
    '8001junk',
    ' 8001',
    '8001 ',
    ' ',
    '999999999999999999999999999999999999',
    null,
    8001
  ];

  for (const value of invalidValues) {
    assert.throws(
      () => parseApiPort(value),
      error => error.message === INVALID_API_PORT_MESSAGE
    );
  }
});

test('startup validates API_PORT before initializing proxy or API listeners', async () => {
  const startupEvents = [];
  const initializeServers = async port => {
    startupEvents.push(['proxy initialized', port]);
    startupEvents.push(['proxy listening', port]);
    startupEvents.push(['API listening', port]);
  };

  for (const value of ['-1', '12.5', '70000', '8001junk']) {
    await assert.rejects(
      startWithValidatedApiPort(value, initializeServers),
      error => error.message === INVALID_API_PORT_MESSAGE
    );
  }
  assert.deepEqual(startupEvents, []);

  await startWithValidatedApiPort(undefined, initializeServers);
  await startWithValidatedApiPort('', initializeServers);
  await startWithValidatedApiPort('9000', initializeServers);
  assert.deepEqual(startupEvents, [
    ['proxy initialized', 8001],
    ['proxy listening', 8001],
    ['API listening', 8001],
    ['proxy initialized', 8001],
    ['proxy listening', 8001],
    ['API listening', 8001],
    ['proxy initialized', 9000],
    ['proxy listening', 9000],
    ['API listening', 9000]
  ]);
});

test('application startup is wired through the API_PORT validation boundary', () => {
  const source = fs.readFileSync(new URL('../../src/index.js', import.meta.url), 'utf8');

  assert.match(source, /startWithValidatedApiPort\(process\.env\.API_PORT, initializeApplication\)/);
  assert.doesNotMatch(source, /parseInt\(process\.env\.API_PORT\)/);
});

test('entrypoint reports invalid API_PORT before emitting boot or socket errors', () => {
  const invalidValue = 'not-a-port-sensitive-value';
  const result = spawnSync(process.execPath, ['src/index.js'], {
    cwd: new URL('../../', import.meta.url),
    encoding: 'utf8',
    env: { ...process.env, API_PORT: invalidValue }
  });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1, output);
  assert.match(result.stderr, /Invalid API_PORT: expected a decimal integer from 1 to 65535\./);
  assert.doesNotMatch(output, /\[Boot\]|ERR_SOCKET_BAD_PORT/);
  assert.equal(output.includes(invalidValue), false);
});
