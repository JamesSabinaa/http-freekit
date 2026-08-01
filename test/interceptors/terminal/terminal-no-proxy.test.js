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
  SSL_CERT_FILE: certPath,
  NODE_EXTRA_CA_CERTS: certPath,
  REQUESTS_CA_BUNDLE: certPath,
  CURL_CA_BUNDLE: certPath
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
      PRESERVED_VALUE: 'yes'
    });
    interceptor._createPidFilePath = () => `/tmp/http-freekit-${platform}.pid`;
    const sessionPid = 9250 + index;
    let sessionRunning = true;
    interceptor._waitForShellPid = async () => sessionPid;
    if (platform === 'win32') {
      const identity = {
        pid: sessionPid,
        startTime: String(sessionPid),
        executable: 'c:\\windows\\powershell.exe'
      };
      interceptor._waitForWindowsShellReport = async () => identity;
      interceptor._inspectSessionIdentity = async () => sessionRunning
        ? { state: 'running', identity }
        : { state: 'absent' };
      interceptor._acknowledgeWindowsShell = async () => {};
    }
    interceptor._killSession = () => { sessionRunning = false; };
    interceptor._spawnDetached = async (command, args, options) => {
      launch = { command, args, options };
      return launcher;
    };

    await interceptor.activate(8080);

    assert.equal(launch.options.env.NO_PROXY, '', platform);
    assert.equal(launch.options.env.no_proxy, '', platform);
    assert.equal(launch.options.env.PRESERVED_VALUE, 'yes', platform);
    assert.deepEqual(
      Object.fromEntries(Object.keys(expectedEnvironment).map(name => [name, launch.options.env[name]])),
      expectedEnvironment,
      platform
    );
    if (platform !== 'win32') {
      const commandText = launch.args.join(' ');
      assert.match(commandText, /export NO_PROXY=''/, platform);
      assert.match(commandText, /export no_proxy=''/, platform);
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
