import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  ExistingTerminalInterceptor,
  FreshTerminalInterceptor,
  buildExistingTerminalInstructions
} from '../../../src/interceptors/terminal-interceptors.js';

const proxyUrl = 'http://127.0.0.1:8080';
const certPath = "C:\\Program Files\\O'Brien & Partners\\FreeKit CA.pem";
const expectedEnvironment = {
  HTTP_PROXY: proxyUrl,
  HTTPS_PROXY: proxyUrl,
  http_proxy: proxyUrl,
  https_proxy: proxyUrl,
  NO_PROXY: '',
  no_proxy: '',
  NODE_USE_ENV_PROXY: '1',
  NODE_EXTRA_CA_CERTS: certPath
};

function fakeLauncher(pid) {
  const process = new EventEmitter();
  process.pid = pid;
  process.killed = false;
  process.exitCode = null;
  process.signalCode = null;
  process.unref = () => {};
  process.kill = (signal = 'SIGTERM') => {
    process.killed = true;
    process.signalCode = signal;
    queueMicrotask(() => process.emit('exit', null, signal));
    return true;
  };
  return process;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function powerShellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function expectedInstructions(environment) {
  const entries = Object.entries(environment);
  return {
    bash: `unset NODE_TLS_REJECT_UNAUTHORIZED; export ${entries.map(([name, value]) => `${name}=${shellQuote(value)}`).join(' ')}`,
    powershell: [
      'Remove-Item Env:NODE_TLS_REJECT_UNAUTHORIZED -ErrorAction SilentlyContinue',
      ...entries.map(([name, value]) => `$env:${name}=${powerShellQuote(value)}`)
    ].join('; '),
    cmd: [`set "NODE_TLS_REJECT_UNAUTHORIZED="`, ...entries.map(([name, value]) => `set "${name}=${value}"`)].join('&& ')
  };
}

test('Fresh Terminal overrides inherited bypass variables on every platform', async () => {
  for (const [index, platform] of ['win32', 'darwin', 'linux'].entries()) {
    const interceptor = new FreshTerminalInterceptor();
    const launcher = fakeLauncher(8250 + index);
    let launch;
    interceptor.ca = { getCertInfo: () => ({ certificatePath: certPath }) };
    interceptor._platform = () => platform;
    interceptor._environment = () => ({
      PATH: '/usr/bin:/bin',
      NO_PROXY: '*',
      no_proxy: 'localhost,example.test',
      SSL_CERT_FILE: '/target/openssl.pem',
      REQUESTS_CA_BUNDLE: '/target/requests.pem',
      CURL_CA_BUNDLE: '/target/curl.pem',
      PRESERVED_VALUE: 'yes'
    });
    const sessionPid = 9250 + index;
    let sessionRunning = true;
    interceptor._createPosixHandshake = () => ({
      directory: null,
      reportFile: `/tmp/http-freekit-${platform}.json`,
      acknowledgementFile: `/tmp/http-freekit-${platform}.ack`,
      nonce: `no-proxy-${platform}`
    });
    interceptor._waitForPosixShellReport = async () => sessionPid;
    interceptor._acknowledgePosixShell = async () => {};
    interceptor._cleanupTerminalHandshake = () => {};
    const identity = {
      pid: sessionPid,
      startTime: String(sessionPid),
      executable: platform === 'win32' ? 'c:\\windows\\powershell.exe' : '/bin/sh'
    };
    interceptor._inspectSessionIdentity = async () => sessionRunning
      ? { state: 'running', identity }
      : { state: 'absent' };
    if (platform === 'win32') {
      interceptor._waitForWindowsShellReport = async () => identity;
      interceptor._acknowledgeWindowsShell = async () => {};
    }
    interceptor._killSession = () => { sessionRunning = false; };
    interceptor._spawnDetached = async (command, args, options) => {
      launch = { command, args, options };
      return launcher;
    };

    await interceptor.activate(8080);

    assert.equal(launch.options.env.NO_PROXY, platform === 'win32' ? '' : '*', platform);
    assert.equal(
      launch.options.env.no_proxy,
      platform === 'win32' ? '' : 'localhost,example.test',
      platform
    );
    assert.equal(launch.options.env.PRESERVED_VALUE, 'yes', platform);
    assert.equal(launch.options.env.SSL_CERT_FILE, '/target/openssl.pem', platform);
    assert.equal(launch.options.env.REQUESTS_CA_BUNDLE, '/target/requests.pem', platform);
    assert.equal(launch.options.env.CURL_CA_BUNDLE, '/target/curl.pem', platform);
    if (platform === 'win32') {
      assert.deepEqual(
        Object.fromEntries(Object.keys(expectedEnvironment).map(name => [name, launch.options.env[name]])),
        expectedEnvironment,
        platform
      );
    } else {
      for (const name of Object.keys(expectedEnvironment).filter(name => !['NO_PROXY', 'no_proxy'].includes(name))) {
        assert.equal(launch.options.env[name], undefined, `${platform} defers ${name}`);
      }
      const commandText = launch.args.join(' ');
      assert.match(commandText, /export NO_PROXY=''/, platform);
      assert.match(commandText, /export no_proxy=''/, platform);
      assert.doesNotMatch(commandText, /export (?:SSL_CERT_FILE|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE)=/, platform);
    }

    await interceptor.deactivate();
  }
});

test('all Existing Terminal shells explicitly clear uppercase and lowercase bypasses', () => {
  const instructions = buildExistingTerminalInstructions(proxyUrl, certPath);

  assert.deepEqual(instructions, expectedInstructions(expectedEnvironment));
  assert.match(instructions.bash, /NO_PROXY='' no_proxy=''/);
  assert.match(instructions.powershell, /\$env:NO_PROXY=''; \$env:no_proxy=''/);
  assert.match(instructions.cmd, /set "NO_PROXY="&& set "no_proxy="/);
  assert.match(instructions.bash, /NODE_EXTRA_CA_CERTS='C:\\Program Files\\O'"'"'Brien/);
});

test('Existing Terminal metadata preserves shared environment instruction parity', async () => {
  const interceptor = new ExistingTerminalInterceptor();
  interceptor.ca = { getCertInfo: () => ({ certificatePath: certPath }) };

  const result = await interceptor.activate(8080);

  assert.deepEqual(result.metadata.instructions, expectedInstructions(expectedEnvironment));
  assert.deepEqual(
    result.metadata.instructions,
    buildExistingTerminalInstructions(result.metadata.proxyUrl, result.metadata.certPath)
  );
});
