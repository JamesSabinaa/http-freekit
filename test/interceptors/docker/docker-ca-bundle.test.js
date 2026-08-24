import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { DockerInterceptor } from '../../../src/interceptors/docker-interceptor.js';
import { CertificateAuthority } from '../../../src/proxy/certificate-authority.js';

const rendererSource = fs.readFileSync(new URL('../../../src/ui/app.js', import.meta.url), 'utf8');
const REPLACING_TRUST_VARIABLES = [
  'SSL_CERT_FILE',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE'
];
const PROXY_VARIABLES = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'NO_PROXY',
  'no_proxy'
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

test('Docker mounts only the FreeKit CA and preserves image-specific trust roots', async t => {
  t.mock.method(console, 'log', () => {});
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http freekit docker ca-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const ca = new CertificateAuthority(dataDir);
  await ca.initialize();
  const interceptor = new DockerInterceptor();
  interceptor.ca = ca;
  interceptor._platform = () => 'linux';
  interceptor._getDockerHost = async () => '172.18.0.1';

  const result = await interceptor.activate(8310);
  const { run, compose } = result.metadata.instructions;
  const runEnv = runEnvironment(run);
  const composeEnv = composeEnvironment(compose);
  const caPath = ca.caCertPath;
  const containerCaPath = '/etc/http-freekit/http-freekit-ca.pem';
  const freeKitCa = fs.readFileSync(ca.caCertPath, 'utf8');

  assert.equal(result.metadata.caPath, caPath);
  assert.equal(result.metadata.caBundlePath, caPath);
  assert.equal(result.metadata.containerCaPath, containerCaPath);
  assert.equal(result.metadata.containerCaBundlePath, containerCaPath);
  assert.match(result.metadata.caBundleDescription, /added to Node trust with NODE_EXTRA_CA_CERTS/);
  assert.match(result.metadata.caBundleDescription, /trust stores remain unchanged/);
  assert.ok(run.includes(`--mount 'type=bind,"source=${caPath}",target=${containerCaPath},readonly'`));
  assert.ok(compose.includes(JSON.stringify(`${caPath}:${containerCaPath}:ro`)));

  assert.deepEqual(runEnv, composeEnv);
  assert.deepEqual(select(runEnv, PROXY_VARIABLES), {
    HTTP_PROXY: 'http://172.18.0.1:8310',
    HTTPS_PROXY: 'http://172.18.0.1:8310',
    http_proxy: 'http://172.18.0.1:8310',
    https_proxy: 'http://172.18.0.1:8310',
    NO_PROXY: '',
    no_proxy: ''
  });
  assert.equal(runEnv.NODE_EXTRA_CA_CERTS, containerCaPath);
  for (const variable of REPLACING_TRUST_VARIABLES) {
    assert.equal(Object.hasOwn(runEnv, variable), false, variable);
  }
  assert.equal(runEnv.NODE_USE_ENV_PROXY, '1');
  assert.doesNotMatch(run, /NODE_TLS_REJECT_UNAUTHORIZED|--insecure|-k(?:\s|$)/);
  assert.doesNotMatch(compose, /NODE_TLS_REJECT_UNAUTHORIZED|--insecure/);

  assert.match(freeKitCa, /-----BEGIN CERTIFICATE-----/);
  assert.notEqual(ca.getTerminalCaBundlePath(), caPath);

  const rendered = renderDockerConfig(result.metadata);
  assert.ok(rendered.includes('trust stores remain unchanged'));
  assert.ok(rendered.includes('http-freekit-ca.pem'));
  assert.doesNotMatch(rendered, /NODE_TLS_REJECT_UNAUTHORIZED/);
});

test('Docker activation rejects unavailable or empty FreeKit CA files before becoming active', async t => {
  t.mock.method(console, 'log', () => {});
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-docker-empty-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const emptyBundle = path.join(dataDir, 'empty bundle.pem');
  fs.writeFileSync(emptyBundle, '   \n');

  for (const [name, ca, errorPattern] of [
    ['missing service', null, /certificate path is not configured/],
    ['missing file', { getCertInfo: () => ({ certificatePath: path.join(dataDir, 'missing.pem') }) }, /certificate is unavailable/],
    ['empty file', { getCertInfo: () => ({ certificatePath: emptyBundle }) }, /certificate is empty/]
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
  assert.match(rendered, /mount the raw FreeKit CA at \/etc\/http-freekit\/http-freekit-ca\.pem/);
  assert.match(rendered, /add it to Node trust with NODE_EXTRA_CA_CERTS/);
  assert.match(rendered, /proxy-only fallback does not change TLS verification/);
  assert.doesNotMatch(rendered, /NODE_TLS_REJECT_UNAUTHORIZED|SSL_CERT_FILE|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE/);
  assert.doesNotMatch(rendered, /-e NODE_EXTRA_CA_CERTS|  - NODE_EXTRA_CA_CERTS/);
  assert.match(rendered, /HTTP_PROXY=http:\/\/172\.17\.0\.1:8310/);
  assert.match(rendered, /http_proxy=http:\/\/172\.17\.0\.1:8310/);
  assert.match(rendered, /NODE_USE_ENV_PROXY=1/);
});
