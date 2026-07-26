import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { DockerInterceptor } from '../src/interceptors/docker-interceptor.js';
import { ElectronInterceptor } from '../src/interceptors/electron-interceptor.js';
import {
  NODE_ENV_PROXY_SUPPORT_NOTE,
  NODE_USE_ENV_PROXY_VALUE
} from '../src/interceptors/node-environment-proxy.js';
import {
  ExistingTerminalInterceptor,
  FreshTerminalInterceptor,
  buildExistingTerminalInstructions
} from '../src/interceptors/terminal-interceptors.js';

function fakeProcess(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  child.unref = () => {};
  child.kill = () => {
    child.killed = true;
    child.exitCode = 0;
    return true;
  };
  return child;
}

async function captureFreshTerminalEnvironment(proxyPort) {
  const interceptor = new FreshTerminalInterceptor();
  const child = fakeProcess(8296);
  let environment;
  interceptor.ca = { getTerminalCaBundlePath: () => '' };
  interceptor._platform = () => 'win32';
  interceptor._environment = () => ({
    ...process.env,
    HTTP_PROXY: 'http://stale.invalid:1',
    HTTPS_PROXY: 'http://stale.invalid:1',
    http_proxy: 'http://stale.invalid:1',
    https_proxy: 'http://stale.invalid:1',
    NO_PROXY: '*',
    no_proxy: '*',
    NODE_USE_ENV_PROXY: '0'
  });
  interceptor._confirmLauncherStartup = async () => {};
  interceptor._startStatusMonitor = () => {};
  interceptor._spawnDetached = async (_command, _args, options) => {
    environment = options.env;
    return child;
  };

  await interceptor.activate(proxyPort);
  await interceptor.deactivate();
  return environment;
}

function proxyContract(proxyUrl) {
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: '',
    no_proxy: '',
    NODE_USE_ENV_PROXY: NODE_USE_ENV_PROXY_VALUE
  };
}

function selectEnvironment(environment, names) {
  return Object.fromEntries(names.map(name => [name, environment[name]]));
}

function rendererTerminalFallback(source, proxyUrl, certPath) {
  const start = source.indexOf('function quoteTerminalBashValue(');
  const end = source.indexOf('function renderTerminalConfig(', start);
  assert.ok(start >= 0 && end > start);
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    `${source.slice(start, end)}; globalThis.buildFallback = buildTerminalFallbackInstructions;`,
    context
  );
  return JSON.parse(JSON.stringify(context.buildFallback(proxyUrl, certPath)));
}

function rendererDockerFallback(source, proxyPort) {
  const start = source.indexOf('function renderDockerConfig(');
  const end = source.indexOf('function quoteTerminalBashValue(', start);
  assert.ok(start >= 0 && end > start);
  const context = {
    config: { proxyPort },
    esc: value => String(value),
    expandedInterceptorMetadata: null,
    NODE_ENV_PROXY_SUPPORT_NOTE
  };
  vm.createContext(context);
  vm.runInContext(`${source.slice(start, end)}; globalThis.render = renderDockerConfig;`, context);
  const container = {};
  context.render(container);
  return container.innerHTML;
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

function runNodeScript(script, args, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, ...args], {
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test('all advertised Node paths emit the exact environment-proxy contract', async t => {
  t.mock.method(console, 'log', () => {});
  const proxyPort = 8296;
  const localProxyUrl = `http://127.0.0.1:${proxyPort}`;
  const localContract = proxyContract(localProxyUrl);
  const contractNames = Object.keys(localContract);

  const freshEnvironment = await captureFreshTerminalEnvironment(proxyPort);
  assert.deepEqual(selectEnvironment(freshEnvironment, contractNames), localContract);

  const certPath = "C:\\Program Files\\FreeKit\\terminal CA.pem";
  const existing = new ExistingTerminalInterceptor();
  existing.ca = { getTerminalCaBundlePath: () => certPath };
  const existingResult = await existing.activate(proxyPort);
  assert.equal(existingResult.metadata.nodeProxyNote, NODE_ENV_PROXY_SUPPORT_NOTE);
  const rendererSource = fs.readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  assert.deepEqual(
    rendererTerminalFallback(rendererSource, localProxyUrl, certPath),
    buildExistingTerminalInstructions(localProxyUrl, certPath)
  );

  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-bug-296-'));
  t.after(() => fs.rmSync(dataDirectory, { recursive: true, force: true }));
  const bundlePath = path.join(dataDirectory, 'terminal-ca-bundle.pem');
  fs.writeFileSync(bundlePath, 'non-empty test bundle');
  const electronChild = fakeProcess(9296);
  let electronEnvironment;
  const electron = new ElectronInterceptor();
  electron.ca = {
    getSpkiFingerprint: () => 'test-spki',
    getTerminalCaBundlePath: () => bundlePath
  };
  electron._environment = () => ({
    ...process.env,
    HTTP_PROXY: 'http://stale.invalid:1',
    HTTPS_PROXY: 'http://stale.invalid:1',
    http_proxy: 'http://lowercase-stale.invalid:2',
    https_proxy: 'http://lowercase-stale.invalid:2',
    NO_PROXY: '*',
    no_proxy: '*',
    NODE_USE_ENV_PROXY: '0',
    NODE_TLS_REJECT_UNAUTHORIZED: '0'
  });
  electron._spawn = (_appPath, _args, options) => {
    electronEnvironment = options.env;
    queueMicrotask(() => electronChild.emit('spawn'));
    return electronChild;
  };
  await electron.activate(proxyPort, { appPath: 'sample-electron-app' });
  assert.deepEqual(selectEnvironment(electronEnvironment, contractNames), localContract);
  assert.equal(electronEnvironment.NODE_EXTRA_CA_CERTS, bundlePath);
  assert.equal('NODE_TLS_REJECT_UNAUTHORIZED' in electronEnvironment, false);
  electronChild.emit('exit', 0, null);

  const docker = new DockerInterceptor();
  docker._platform = () => 'linux';
  docker._exec = async () => '172.17.0.1\n';
  docker.ca = { getCertInfo: () => ({ certificatePath: '/tmp/freekit-ca.pem' }) };
  const dockerResult = await docker.activate(proxyPort);
  assert.equal(dockerResult.metadata.nodeProxyNote, NODE_ENV_PROXY_SUPPORT_NOTE);
  assert.equal(
    dockerResult.metadata.instructions.run,
    'docker run --mount type=bind,source="/tmp/freekit-ca.pem",target=/etc/http-freekit/ca.pem,readonly ' +
      `-e HTTP_PROXY=http://172.17.0.1:${proxyPort} -e HTTPS_PROXY=http://172.17.0.1:${proxyPort} -e NO_PROXY= ` +
      '-e SSL_CERT_FILE=/etc/http-freekit/ca.pem -e REQUESTS_CA_BUNDLE=/etc/http-freekit/ca.pem ' +
      '-e CURL_CA_BUNDLE=/etc/http-freekit/ca.pem -e NODE_EXTRA_CA_CERTS=/etc/http-freekit/ca.pem ' +
      '-e NODE_USE_ENV_PROXY=1 <image>'
  );
  assert.equal(
    dockerResult.metadata.instructions.compose,
    `volumes:\n  - "/tmp/freekit-ca.pem:/etc/http-freekit/ca.pem:ro"\nenvironment:\n` +
      `  - HTTP_PROXY=http://172.17.0.1:${proxyPort}\n  - HTTPS_PROXY=http://172.17.0.1:${proxyPort}\n` +
      '  - NO_PROXY=\n  - SSL_CERT_FILE=/etc/http-freekit/ca.pem\n' +
      '  - REQUESTS_CA_BUNDLE=/etc/http-freekit/ca.pem\n  - CURL_CA_BUNDLE=/etc/http-freekit/ca.pem\n' +
      '  - NODE_EXTRA_CA_CERTS=/etc/http-freekit/ca.pem\n  - NODE_USE_ENV_PROXY=1'
  );
  assert.doesNotMatch(dockerResult.metadata.instructions.run, /(?:^|\s)(?:http_proxy|https_proxy)=/);

  const dockerFallback = rendererDockerFallback(rendererSource, proxyPort);
  assert.ok(dockerFallback.includes(
    `docker run -e HTTP_PROXY=http://172.17.0.1:${proxyPort} -e HTTPS_PROXY=http://172.17.0.1:${proxyPort} ` +
      '-e NO_PROXY= -e NODE_USE_ENV_PROXY=1 -e NODE_TLS_REJECT_UNAUTHORIZED=0 <image>'
  ));
  assert.ok(dockerFallback.includes(
    `environment:\n  - HTTP_PROXY=http://172.17.0.1:${proxyPort}\n  - HTTPS_PROXY=http://172.17.0.1:${proxyPort}\n` +
      '  - NO_PROXY=\n  - NODE_USE_ENV_PROXY=1\n  - NODE_TLS_REJECT_UNAUTHORIZED=0'
  ));
  assert.ok(dockerFallback.includes(NODE_ENV_PROXY_SUPPORT_NOTE));
  const rendererNote = rendererSource.match(/const NODE_ENV_PROXY_SUPPORT_NOTE = '([^']+)';/)?.[1];
  assert.equal(rendererNote, NODE_ENV_PROXY_SUPPORT_NOTE);
});

test('installed Node routes bare core HTTP and HTTPS default-agent requests through the generated proxy environment', async t => {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const supportsCoreEnvironmentProxy =
    major > 24 || major === 24 && minor >= 5 || major === 22 && minor >= 21;
  assert.equal(supportsCoreEnvironmentProxy, true, `Node ${process.versions.node} lacks core environment proxy support`);

  let httpRequests = 0;
  let httpsConnects = 0;
  const countingProxy = http.createServer((_request, response) => {
    httpRequests += 1;
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('response-from-counting-proxy');
  });
  countingProxy.on('connect', (_request, socket) => {
    httpsConnects += 1;
    socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
  });
  await new Promise((resolve, reject) => {
    countingProxy.once('error', reject);
    countingProxy.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => closeServer(countingProxy));

  const proxyPort = countingProxy.address().port;
  const environment = await captureFreshTerminalEnvironment(proxyPort);
  assert.deepEqual(
    selectEnvironment(environment, Object.keys(proxyContract(`http://127.0.0.1:${proxyPort}`))),
    proxyContract(`http://127.0.0.1:${proxyPort}`)
  );

  const script = `
    const http = require('node:http');
    const https = require('node:https');
    function request(client, url) {
      return new Promise(resolve => {
        const request = client.get(url, response => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', chunk => { body += chunk; });
          response.on('end', () => resolve({ status: response.statusCode, body }));
        });
        request.setTimeout(3000, () => request.destroy(new Error('timeout')));
        request.on('error', error => resolve({ error: error.code || error.message }));
      });
    }
    Promise.all([
      request(http, process.argv[1]),
      request(https, process.argv[2])
    ]).then(results => console.log(JSON.stringify(results)));
  `;
  const childResult = await runNodeScript(
    script,
    ['http://direct-http.invalid/resource', 'https://direct-https.invalid/resource'],
    environment
  );

  assert.equal(childResult.code, 0, childResult.stderr);
  const [httpResult, httpsResult] = JSON.parse(childResult.stdout.trim());
  assert.deepEqual(httpResult, { status: 200, body: 'response-from-counting-proxy' });
  assert.ok(httpsResult.error, 'HTTPS CONNECT rejection should surface to the child');
  assert.equal(httpRequests, 1);
  assert.equal(httpsConnects, 1);
});
