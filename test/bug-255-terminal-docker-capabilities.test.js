import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import test from 'node:test';

import { DockerInterceptor } from '../src/interceptors/docker-interceptor.js';
import { FreshTerminalInterceptor } from '../src/interceptors/terminal-interceptors.js';

const uiSource = fs.readFileSync('src/ui/app.js', 'utf8');
const readme = fs.readFileSync('README.md', 'utf8');

function fakeLauncher(pid) {
  const proc = new EventEmitter();
  proc.pid = pid;
  proc.killed = false;
  proc.exitCode = null;
  proc.signalCode = null;
  proc.unref = () => {};
  proc.kill = () => {
    proc.killed = true;
    return true;
  };
  return proc;
}

test('Fresh Terminal copy limits its promise to host processes and directs containers to Docker', () => {
  assert.match(
    uiSource,
    /'fresh-terminal': \['Intercept host commands and processes launched from a new terminal\.', `Sets proxy and certificate environment variables; use the Docker interceptor for container traffic\. \$\{NODE_ENV_PROXY_SUPPORT_NOTE\}`\]/
  );
  assert.doesNotMatch(uiSource, /fresh-terminal[^\n]+all processes/i);
  assert.doesNotMatch(uiSource, /'fresh-terminal': \['terminal', 'cli', 'docker'/);
  assert.doesNotMatch(uiSource, /'existing-terminal': \['terminal', 'cli', 'docker'/);
  assert.match(
    uiSource,
    /'docker': \['Intercept traffic from Docker containers\.', `Set proxy environment variables when running containers\. \$\{NODE_ENV_PROXY_SUPPORT_NOTE\}`\]/
  );
  assert.match(
    readme,
    /Fresh Terminal configures host commands and processes started in that shell; container traffic uses the dedicated Docker interceptor\./
  );
});

test('Fresh Terminal configures its host shell while Docker emits container-reachable setup', async t => {
  t.mock.method(console, 'log', () => {});
  const launcher = fakeLauncher(7255);
  let terminalLaunch;
  const terminal = new FreshTerminalInterceptor();
  terminal.ca = { getCertInfo: () => ({ certificatePath: 'C:\\FreeKit\\ca.pem' }) };
  terminal._platform = () => 'win32';
  terminal._spawnDetached = async (command, args, options) => {
    terminalLaunch = { command, args, options };
    return launcher;
  };
  terminal._confirmLauncherStartup = async () => {};
  terminal._startStatusMonitor = () => {};

  await terminal.activate(8080);

  const docker = new DockerInterceptor();
  docker._getCombinedCaBundlePath = () => 'C:\\FreeKit\\ca-bundle.pem';
  docker._platform = () => 'win32';
  docker._exec = () => assert.fail('Docker Desktop should use its container host gateway');
  const dockerResult = await docker.activate(8080);

  assert.equal(terminalLaunch.command, 'wt.exe');
  assert.equal(terminalLaunch.options.env.HTTP_PROXY, 'http://127.0.0.1:8080');
  assert.equal(dockerResult.metadata.proxyUrl, 'http://host.docker.internal:8080');
  assert.notEqual(
    terminalLaunch.options.env.HTTP_PROXY,
    dockerResult.metadata.proxyUrl,
    'the host shell loopback address must not be presented as container configuration'
  );
  assert.match(
    dockerResult.metadata.instructions.run,
    /HTTP_PROXY=http:\/\/host\.docker\.internal:8080/
  );

  await terminal.deactivate();
});
