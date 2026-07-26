import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import tls from 'node:tls';
import vm from 'node:vm';

import {
  ExistingTerminalInterceptor,
  FreshTerminalInterceptor
} from '../src/interceptors/terminal-interceptors.js';
import { CertificateAuthority } from '../src/proxy/certificate-authority.js';
import {
  refreshTerminalCaBundle,
  terminalCaBundlePath
} from '../src/proxy/terminal-ca-bundle.js';

const TRUST_VARIABLES = [
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE'
];

function normalizePem(pem) {
  return `${String(pem).trim()}\n`;
}

function expectedBundle(publicRoots, freeKitCa) {
  return [...publicRoots, freeKitCa].map(normalizePem).join('\n');
}

function fakeLauncher(pid) {
  const proc = new EventEmitter();
  proc.pid = pid;
  proc.killed = false;
  proc.exitCode = null;
  proc.signalCode = null;
  proc.unref = () => {};
  proc.kill = () => { proc.killed = true; };
  return proc;
}

test('terminal CA bundle preserves every public root and appends FreeKit once', async t => {
  t.mock.method(console, 'log', () => {});
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-terminal-ca-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const ca = new CertificateAuthority(dataDir);
  await ca.initialize();
  const freeKitCa = fs.readFileSync(ca.caCertPath, 'utf8');

  const bundlePath = ca.getTerminalCaBundlePath();
  const bundle = fs.readFileSync(bundlePath, 'utf8');
  const certificates = bundle.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----\n/g);

  assert.equal(bundlePath, path.join(dataDir, 'terminal-ca-bundle.pem'));
  assert.equal(bundlePath, terminalCaBundlePath(ca.caCertPath));
  assert.equal(bundle, expectedBundle(tls.rootCertificates, freeKitCa));
  assert.equal(certificates.length, tls.rootCertificates.length + 1);
  assert.deepEqual(certificates.slice(0, -1), tls.rootCertificates.map(normalizePem));
  assert.equal(certificates.at(-1), normalizePem(freeKitCa));
  assert.doesNotThrow(() => tls.createSecureContext({ ca: bundle }));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(bundlePath).mode & 0o777, 0o600);
  }
});

test('terminal CA bundle refresh is atomic and preserves the last complete bundle on failure', async t => {
  t.mock.method(console, 'log', () => {});
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-terminal-ca-refresh-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const ca = new CertificateAuthority(dataDir);
  await ca.initialize();
  const bundlePath = ca.getTerminalCaBundlePath();
  const originalBundle = fs.readFileSync(bundlePath, 'utf8');
  const replacementCa = tls.rootCertificates.at(-1);
  fs.writeFileSync(ca.caCertPath, replacementCa);

  assert.throws(
    () => refreshTerminalCaBundle(ca.caCertPath, {
      renameFile: () => { throw new Error('simulated interrupted replacement'); }
    }),
    /simulated interrupted replacement/
  );
  assert.equal(fs.readFileSync(bundlePath, 'utf8'), originalBundle);
  assert.deepEqual(
    fs.readdirSync(dataDir).filter(name => name.includes('terminal-ca-bundle.pem.') && name.endsWith('.tmp')),
    []
  );

  assert.equal(refreshTerminalCaBundle(ca.caCertPath), bundlePath);
  assert.equal(
    fs.readFileSync(bundlePath, 'utf8'),
    expectedBundle(tls.rootCertificates, replacementCa)
  );
});

test('Fresh and Existing Terminal paths share the bundle without disabling TLS verification', async t => {
  t.mock.method(console, 'log', () => {});
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-terminal-ca-shared-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const bundlePath = path.join(dataDir, 'terminal-ca-bundle.pem');
  fs.writeFileSync(bundlePath, 'shared public plus FreeKit bundle', { mode: 0o600 });
  let bundleRequests = 0;
  const ca = {
    getTerminalCaBundlePath: () => {
      bundleRequests += 1;
      return bundlePath;
    },
    getCertInfo: () => ({ certificatePath: path.join(dataDir, 'ca.pem') })
  };

  for (const [index, platform] of ['win32', 'darwin', 'linux'].entries()) {
    const terminal = new FreshTerminalInterceptor();
    const launcher = fakeLauncher(9270 + index);
    let launch;
    terminal.ca = ca;
    terminal._platform = () => platform;
    terminal._environment = () => ({
      PATH: '/usr/bin:/bin',
      NODE_TLS_REJECT_UNAUTHORIZED: '0'
    });
    terminal._confirmLauncherStartup = async () => {};
    terminal._createPidFilePath = () => path.join(dataDir, `${platform}.pid`);
    terminal._waitForShellPid = async () => 9370 + index;
    terminal._killSession = () => {};
    terminal._startStatusMonitor = () => {};
    terminal._spawnDetached = async (command, args, options) => {
      launch = { command, args, options };
      return launcher;
    };

    await terminal.activate(8080);

    for (const variable of TRUST_VARIABLES) {
      assert.equal(launch.options.env[variable], bundlePath, `${platform} ${variable}`);
    }
    assert.equal('NODE_TLS_REJECT_UNAUTHORIZED' in launch.options.env, false, platform);
    if (platform !== 'win32') {
      const commandText = launch.args.join(' ').replace(/\\\\/g, '\\');
      for (const variable of TRUST_VARIABLES) {
        assert.ok(commandText.includes(`export ${variable}=`), `${platform} ${variable}`);
        assert.ok(commandText.includes(bundlePath), `${platform} bundle path`);
      }
    }

    await terminal.deactivate();
    assert.equal(fs.existsSync(bundlePath), true, `${platform} deactivation keeps shared bundle`);
  }

  const existing = new ExistingTerminalInterceptor();
  existing.ca = ca;
  const result = await existing.activate(8080);
  assert.equal(result.metadata.certPath, bundlePath);
  for (const instructions of Object.values(result.metadata.instructions)) {
    for (const variable of TRUST_VARIABLES) {
      assert.ok(instructions.includes(variable), variable);
      assert.ok(instructions.includes(bundlePath), bundlePath);
    }
    assert.doesNotMatch(instructions, /NODE_TLS_REJECT_UNAUTHORIZED=['"]?0/);
  }
  assert.match(result.metadata.instructions.bash, /^unset NODE_TLS_REJECT_UNAUTHORIZED;/);
  assert.match(result.metadata.instructions.powershell, /^Remove-Item Env:NODE_TLS_REJECT_UNAUTHORIZED/);
  assert.match(result.metadata.instructions.cmd, /^set "NODE_TLS_REJECT_UNAUTHORIZED="/);
  assert.equal(bundleRequests, 4);
  await existing.deactivate();
  assert.equal(fs.existsSync(bundlePath), true);
});

test('renderer fallback instructions use the bundle and restore normal TLS verification', () => {
  const source = fs.readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function quoteTerminalBashValue(');
  const end = source.indexOf('function renderTerminalConfig(', start);
  assert.ok(start >= 0 && end > start);
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${source.slice(start, end)}; globalThis.buildFallback = buildTerminalFallbackInstructions;`, context);
  const bundlePath = '/writable/data/terminal-ca-bundle.pem';
  const instructions = context.buildFallback('http://127.0.0.1:8080', bundlePath);

  for (const command of Object.values(instructions)) {
    for (const variable of TRUST_VARIABLES) {
      assert.ok(command.includes(variable), variable);
      assert.ok(command.includes(bundlePath), bundlePath);
    }
    assert.doesNotMatch(command, /NODE_TLS_REJECT_UNAUTHORIZED=['"]?0/);
  }
});
