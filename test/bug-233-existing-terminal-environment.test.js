import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  ExistingTerminalInterceptor,
  FreshTerminalInterceptor,
  buildExistingTerminalInstructions
} from '../src/interceptors/terminal-interceptors.js';

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

function instructionVariableNames(instructions) {
  return {
    bash: [...instructions.bash.matchAll(/(?:export | )([A-Za-z_][A-Za-z0-9_]*)=/g)]
      .map(match => match[1]),
    powershell: [...instructions.powershell.matchAll(/\$env:([A-Za-z_][A-Za-z0-9_]*)=/g)]
      .map(match => match[1]),
    cmd: [...instructions.cmd.matchAll(/set "([A-Za-z_][A-Za-z0-9_]*)=/g)]
      .map(match => match[1])
  };
}

function fakeLauncher(pid) {
  const proc = new EventEmitter();
  proc.pid = pid;
  proc.killed = false;
  proc.exitCode = null;
  proc.signalCode = null;
  proc.unref = () => {};
  proc.kill = (signal = 'SIGTERM') => {
    proc.killed = true;
    proc.signalCode = signal;
    queueMicrotask(() => proc.emit('exit', null, signal));
    return true;
  };
  return proc;
}

test('Existing Terminal emits the exact proxy and trust variables with shell-safe quoting', () => {
  const instructions = buildExistingTerminalInstructions(proxyUrl, certPath);
  const expectedNames = Object.keys(expectedEnvironment);

  assert.deepEqual(instructions, expectedInstructions(expectedEnvironment));
  assert.deepEqual(instructionVariableNames(instructions), {
    bash: expectedNames,
    powershell: expectedNames,
    cmd: ['NODE_TLS_REJECT_UNAUTHORIZED', ...expectedNames]
  });
  assert.match(instructions.bash, /O'"'"'Brien/);
  assert.match(instructions.powershell, /O''Brien/);
  assert.match(instructions.cmd, /set "SSL_CERT_FILE=C:\\Program Files\\O'Brien & Partners\\FreeKit CA\.pem"/);
});

test('Existing Terminal includes every trust variable when the certificate path is absent', () => {
  const environment = {
    ...expectedEnvironment,
    SSL_CERT_FILE: '',
    NODE_EXTRA_CA_CERTS: '',
    REQUESTS_CA_BUNDLE: '',
    CURL_CA_BUNDLE: ''
  };

  assert.deepEqual(
    buildExistingTerminalInstructions(proxyUrl, ''),
    expectedInstructions(environment)
  );
});

test('Existing Terminal instructions stay consistent with Fresh Terminal environment', async () => {
  const interceptor = new FreshTerminalInterceptor();
  const launcher = fakeLauncher(7330);
  let launchedEnvironment;
  interceptor.ca = { getCertInfo: () => ({ certificatePath: certPath }) };
  interceptor._platform = () => 'win32';
  interceptor._launcherStartupGraceMs = () => 1;
  const identity = {
    pid: 7331,
    startTime: '7331',
    executable: 'c:\\windows\\powershell.exe'
  };
  let sessionRunning = true;
  interceptor._waitForWindowsShellReport = async () => identity;
  interceptor._inspectSessionIdentity = async () => sessionRunning
    ? { state: 'running', identity }
    : { state: 'absent' };
  interceptor._acknowledgeWindowsShell = async () => {};
  interceptor._killSession = () => { sessionRunning = false; };
  interceptor._spawnDetached = async (command, args, options) => {
    launchedEnvironment = options.env;
    return launcher;
  };

  await interceptor.activate(8080);

  assert.deepEqual(
    Object.fromEntries(Object.keys(expectedEnvironment).map(name => [name, launchedEnvironment[name]])),
    expectedEnvironment
  );
  assert.deepEqual(
    buildExistingTerminalInstructions(proxyUrl, certPath),
    expectedInstructions(expectedEnvironment)
  );

  await interceptor.deactivate();
});

test('Existing Terminal lifecycle remains instructions-only with complete metadata', async () => {
  const interceptor = new ExistingTerminalInterceptor();
  interceptor.ca = { getCertInfo: () => ({ certificatePath: certPath }) };

  const result = await interceptor.activate(8080);

  assert.equal(result.metadata.instructionsOnly, true);
  assert.deepEqual(result.metadata.instructions, expectedInstructions(expectedEnvironment));
  assert.equal(await interceptor.isActive(), false);
});
