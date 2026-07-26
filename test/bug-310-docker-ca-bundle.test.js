import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import tls from 'node:tls';
import vm from 'node:vm';

import { DockerInterceptor } from '../src/interceptors/docker-interceptor.js';
import { CertificateAuthority } from '../src/proxy/certificate-authority.js';

const rendererSource = fs.readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
const TRUST_VARIABLES = [
  'SSL_CERT_FILE',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'NODE_EXTRA_CA_CERTS'
];
const PROXY_VARIABLES = [
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
  return Object.fromEntries(
    instruction.split('environment:\n')[1].split('\n')
      .map(line => line.match(/^  - ([A-Za-z_][A-Za-z0-9_]*)=(.*)$/))
      .filter(Boolean)
      .map(([, name, value]) => [name, value])
  );
}

function select(object, names) {
  return Object.fromEntries(names.map(name => [name, object[name]]));
}

function renderDockerConfig(metadata) {
  const start = rendererSource.indexOf('function renderDockerConfig(');
  const end = rendererSource.indexOf('function quoteTerminalBashValue(', start);
  assert.ok(start >= 0 && end > start);
  const context = {
    config: { proxyPort: 8310 },
    esc: String,
    expandedInterceptorMetadata: metadata,
    NODE_ENV_PROXY_SUPPORT_NOTE: 'Node proxy contract'
  };
  vm.createContext(context);
  vm.runInContext(`${rendererSource.slice(start, end)}; globalThis.render = renderDockerConfig;`, context);
  const container = {};
  context.render(container);
  return container.innerHTML;
}

function normalizePem(pem) {
  return `${String(pem).trim()}\n`;
}

test('Docker run and Compose mount the complete public-roots-plus-FreeKit bundle', async t => {
  t.mock.method(console, 'log', () => {});
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http freekit docker ca-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const ca = new CertificateAuthority(dataDir);
  await ca.initialize();
  const interceptor = new DockerInterceptor();
  interceptor.ca = ca;
  interceptor._getDockerHost = async () => '172.18.0.1';

  const result = await interceptor.activate(8310);
  const { run, compose } = result.metadata.instructions;
  const runEnv = runEnvironment(run);
  const composeEnv = composeEnvironment(compose);
  const bundlePath = ca.getTerminalCaBundlePath();
  const containerBundlePath = '/etc/http-freekit/ca-bundle.pem';
  const bundle = fs.readFileSync(bundlePath, 'utf8');
  const freeKitCa = fs.readFileSync(ca.caCertPath, 'utf8');
  const certificates = bundle.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----\n/g);

  assert.equal(result.metadata.caPath, bundlePath);
  assert.equal(result.metadata.caBundlePath, bundlePath);
  assert.equal(result.metadata.containerCaBundlePath, containerBundlePath);
  assert.match(result.metadata.caBundleDescription, /combines public trust roots with the HTTP FreeKit CA/);
  assert.match(result.metadata.caBundleDescription, /verification remain enabled/);
  assert.ok(run.includes(`--mount type=bind,source="${bundlePath}",target=${containerBundlePath},readonly`));
  assert.ok(compose.includes(JSON.stringify(`${bundlePath}:${containerBundlePath}:ro`)));

  assert.deepEqual(runEnv, composeEnv);
  assert.deepEqual(select(runEnv, PROXY_VARIABLES), {
    HTTP_PROXY: 'http://172.18.0.1:8310',
    HTTPS_PROXY: 'http://172.18.0.1:8310',
    http_proxy: 'http://172.18.0.1:8310',
    https_proxy: 'http://172.18.0.1:8310',
    NO_PROXY: ''
  });
  for (const variable of TRUST_VARIABLES) assert.equal(runEnv[variable], containerBundlePath);
  assert.equal(runEnv.NODE_USE_ENV_PROXY, '1');
  assert.doesNotMatch(run, /NODE_TLS_REJECT_UNAUTHORIZED|--insecure|-k(?:\s|$)/);
  assert.doesNotMatch(compose, /NODE_TLS_REJECT_UNAUTHORIZED|--insecure/);

  assert.equal(certificates.length, tls.rootCertificates.length + 1);
  assert.deepEqual(certificates.slice(0, -1), tls.rootCertificates.map(normalizePem));
  assert.equal(certificates.at(-1), normalizePem(freeKitCa));
  assert.ok(bundle.includes(tls.rootCertificates[0].trim()), 'a known public root remains trusted');
  assert.ok(bundle.includes(freeKitCa.trim()), 'the FreeKit CA is appended');
  assert.doesNotThrow(() => tls.createSecureContext({ ca: bundle }));

  const rendered = renderDockerConfig(result.metadata);
  assert.ok(rendered.includes('public trust roots with the HTTP FreeKit CA'));
  assert.ok(rendered.includes('ca-bundle.pem'));
  assert.doesNotMatch(rendered, /NODE_TLS_REJECT_UNAUTHORIZED/);
});

test('Docker activation rejects unavailable or empty combined bundles before becoming active', async t => {
  t.mock.method(console, 'log', () => {});
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-docker-empty-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const emptyBundle = path.join(dataDir, 'empty bundle.pem');
  fs.writeFileSync(emptyBundle, '   \n');

  for (const [name, ca, errorPattern] of [
    ['missing service', null, /bundle is not configured/],
    ['missing file', { getTerminalCaBundlePath: () => path.join(dataDir, 'missing.pem') }, /bundle is unavailable/],
    ['empty file', { getTerminalCaBundlePath: () => emptyBundle }, /bundle is empty/]
  ]) {
    await t.test(name, async () => {
      const interceptor = new DockerInterceptor();
      interceptor.ca = ca;
      interceptor._getDockerHost = async () => '172.18.0.1';
      await assert.rejects(interceptor.activate(8310), errorPattern);
      assert.equal(interceptor.active, false);
    });
  }
});

test('renderer proxy-only fallback never disables TLS or claims a generated CA mount', () => {
  const rendered = renderDockerConfig(null);
  assert.match(rendered, /Activate Docker interception to generate a read-only combined public-roots-plus-FreeKit CA bundle mount/);
  assert.match(rendered, /proxy-only fallback does not change TLS verification/);
  assert.doesNotMatch(rendered, /NODE_TLS_REJECT_UNAUTHORIZED|SSL_CERT_FILE|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|NODE_EXTRA_CA_CERTS/);
  assert.match(rendered, /HTTP_PROXY=http:\/\/172\.17\.0\.1:8310/);
  assert.match(rendered, /http_proxy=http:\/\/172\.17\.0\.1:8310/);
  assert.match(rendered, /NODE_USE_ENV_PROXY=1/);
});
