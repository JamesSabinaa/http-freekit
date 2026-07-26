import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import test from 'node:test';
import vm from 'node:vm';
import fs from 'node:fs';
import { DockerInterceptor } from '../src/interceptors/docker-interceptor.js';

const rendererSource = fs.readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');

const PROXY_NAMES = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'NO_PROXY'
];

function runEnvironment(instruction) {
  return Object.fromEntries(
    [...instruction.matchAll(/(?:^|\s)-e\s+([A-Za-z_][A-Za-z0-9_]*)=([^\s]*)/g)]
      .map(([, name, value]) => [name, value])
  );
}

function composeEnvironment(instruction) {
  const environment = instruction.split('environment:\n')[1];
  assert.ok(environment, 'Compose instructions must contain an environment section');
  return Object.fromEntries(
    environment.split('\n').map(line => line.match(/^  - ([A-Za-z_][A-Za-z0-9_]*)=(.*)$/))
      .filter(Boolean)
      .map(([, name, value]) => [name, value])
  );
}

function select(object, names) {
  return Object.fromEntries(names.map(name => [name, object[name]]));
}

async function generatedDockerInstructions(proxyUrl) {
  const interceptor = new DockerInterceptor();
  interceptor._getDockerHost = async () => new URL(proxyUrl).hostname;
  interceptor._getCombinedCaBundlePath = () => '/tmp/FreeKit CA bundle.pem';
  const result = await interceptor.activate(new URL(proxyUrl).port);
  return result.metadata.instructions;
}

function rendererFallback(proxyPort) {
  const start = rendererSource.indexOf('function renderDockerConfig(');
  const end = rendererSource.indexOf('function quoteTerminalBashValue(', start);
  assert.ok(start >= 0 && end > start);
  const context = {
    config: { proxyPort },
    esc: String,
    expandedInterceptorMetadata: null,
    NODE_ENV_PROXY_SUPPORT_NOTE: 'test note'
  };
  vm.createContext(context);
  vm.runInContext(`${rendererSource.slice(start, end)}; globalThis.render = renderDockerConfig;`, context);
  const container = {};
  context.render(container);
  return container.innerHTML;
}

function runProcess(command, args, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
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

test('Docker run, Compose, and renderer fallback emit the exact lowercase proxy contract', async t => {
  t.mock.method(console, 'log', () => {});
  const proxyUrl = 'http://172.17.0.1:8297';
  const expectedProxyEnvironment = {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: ''
  };
  const instructions = await generatedDockerInstructions(proxyUrl);
  const run = runEnvironment(instructions.run);
  const compose = composeEnvironment(instructions.compose);

  assert.deepEqual(select(run, PROXY_NAMES), expectedProxyEnvironment);
  assert.deepEqual(select(compose, PROXY_NAMES), expectedProxyEnvironment);
  assert.deepEqual(run, compose);
  assert.equal(run.NODE_USE_ENV_PROXY, '1');
  assert.equal(run.SSL_CERT_FILE, '/etc/http-freekit/ca-bundle.pem');
  assert.equal(run.REQUESTS_CA_BUNDLE, '/etc/http-freekit/ca-bundle.pem');
  assert.equal(run.CURL_CA_BUNDLE, '/etc/http-freekit/ca-bundle.pem');
  assert.equal(run.NODE_EXTRA_CA_CERTS, '/etc/http-freekit/ca-bundle.pem');
  assert.match(instructions.run, /source="\/tmp\/FreeKit CA bundle\.pem",target=\/etc\/http-freekit\/ca-bundle\.pem,readonly/);
  assert.match(instructions.compose, /"\/tmp\/FreeKit CA bundle\.pem:\/etc\/http-freekit\/ca-bundle\.pem:ro"/);

  const fallback = rendererFallback(8297);
  const fallbackRunText = fallback.match(/<h3>Docker Run<\/h3>[\s\S]*?<div[^>]*>([\s\S]*?)<\/div>/)?.[1] || '';
  const fallbackComposeText = fallback.match(/<h3>Docker Compose<\/h3>[\s\S]*?<div[^>]*>([\s\S]*?)<\/div>/)?.[1] || '';
  const fallbackRun = runEnvironment(fallbackRunText);
  const fallbackCompose = composeEnvironment(fallbackComposeText);
  assert.deepEqual(select(fallbackRun, PROXY_NAMES), expectedProxyEnvironment);
  assert.deepEqual(select(fallbackCompose, PROXY_NAMES), expectedProxyEnvironment);
  assert.equal(fallbackRun.NODE_USE_ENV_PROXY, '1');
  assert.equal(fallbackCompose.NODE_USE_ENV_PROXY, '1');
});

test('curl HTTP traffic uses the lowercase proxy URL from generated Docker environment', async t => {
  const curlCheck = spawnSync('curl', ['--version'], { windowsHide: true });
  if (curlCheck.status !== 0) {
    t.skip('curl is not available locally; exact generation and parity coverage still applies');
    return;
  }

  let requests = 0;
  const proxy = http.createServer((request, response) => {
    requests += 1;
    assert.equal(request.url, 'http://bug-297.invalid/count');
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('counted-by-proxy');
  });
  await new Promise((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => proxy.close(resolve)));

  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const instructions = await generatedDockerInstructions(proxyUrl);
  const generatedEnvironment = runEnvironment(instructions.run);
  const environment = Object.fromEntries(
    ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']
      .filter(name => process.env[name] != null)
      .map(name => [name, process.env[name]])
  );
  Object.assign(environment, generatedEnvironment);
  if (process.platform === 'win32') {
    // Windows environment names are case-insensitive. Retain the generated
    // lowercase variants so curl receives the form it deliberately supports.
    delete environment.HTTP_PROXY;
    delete environment.HTTPS_PROXY;
  }

  const result = await runProcess(
    'curl',
    ['--silent', '--show-error', '--max-time', '5', 'http://bug-297.invalid/count'],
    environment
  );

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, 'counted-by-proxy');
  assert.equal(requests, 1);
});
