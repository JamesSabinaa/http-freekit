import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import forge from 'node-forge';

import { ElectronInterceptor } from '../src/interceptors/electron-interceptor.js';
import { refreshTerminalCaBundle } from '../src/proxy/terminal-ca-bundle.js';

const { pki, md } = forge;

function generateKeyPair() {
  return new Promise((resolve, reject) => {
    pki.rsa.generateKeyPair({ bits: 2048 }, (error, keys) => {
      if (error) reject(error);
      else resolve(keys);
    });
  });
}

async function createTestCa(commonName) {
  const keys = await generateKeyPair();
  const cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 86_400_000);
  const subject = [{ name: 'commonName', value: commonName }];
  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' }
  ]);
  cert.sign(keys.privateKey, md.sha256.create());
  return { cert, key: keys.privateKey };
}

async function createTestLeaf(ca, hostname, serialNumber) {
  const keys = await generateKeyPair();
  const cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serialNumber;
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 86_400_000);
  cert.setSubject([{ name: 'commonName', value: hostname }]);
  cert.setIssuer(ca.cert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    {
      name: 'subjectAltName',
      altNames: net.isIP(hostname)
        ? [{ type: 7, ip: hostname }]
        : [{ type: 2, value: hostname }]
    },
    { name: 'subjectKeyIdentifier' },
    {
      name: 'authorityKeyIdentifier',
      keyIdentifier: ca.cert.generateSubjectKeyIdentifier().getBytes()
    }
  ]);
  cert.sign(ca.key, md.sha256.create());
  return {
    key: pki.privateKeyToPem(keys.privateKey),
    cert: pki.certificateToPem(cert)
  };
}

async function startHttpsServer(credentials) {
  const server = https.createServer(credentials, (_request, response) => {
    response.end('ok');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

async function requestFromChild(url, env) {
  const script = `
    const https = require('node:https');
    https.get(process.argv[1], response => {
      response.resume();
      response.on('end', () => console.log('ok:' + response.statusCode));
    }).on('error', error => console.log('error:' + error.code));
  `;
  const child = spawn(process.execPath, ['-e', script, url], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return { ...exit, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function requestWithServer(credentials, env) {
  const server = await startHttpsServer(credentials);
  try {
    const port = server.address().port;
    return await requestFromChild(`https://127.0.0.1:${port}/`, env);
  } finally {
    await closeServer(server);
  }
}

test('Electron launch refuses to spawn when the combined CA bundle is unavailable', async () => {
  const interceptor = new ElectronInterceptor();
  interceptor.ca = {
    getSpkiFingerprint: () => 'test-spki',
    getTerminalCaBundlePath: () => path.join(os.tmpdir(), `missing-${Date.now()}.pem`)
  };
  let spawned = false;
  interceptor._spawn = () => { spawned = true; };

  await assert.rejects(
    interceptor.activate(8080, { appPath: 'sample-electron-app' }),
    /FreeKit CA trust bundle is unavailable for Electron launch/
  );

  assert.equal(spawned, false);
  assert.equal(interceptor.activating, false);
  assert.equal(interceptor.active, false);
  assert.equal(interceptor.process, null);
});

test('Electron main-process trust accepts FreeKit certificates and rejects unrelated TLS', async t => {
  t.mock.method(console, 'log', () => {});
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-electron-tls-'));
  const unrelatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-electron-unrelated-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(unrelatedDir, { recursive: true, force: true }));

  const ca = await createTestCa('HTTP FreeKit test CA');
  const unrelatedCa = await createTestCa('Unrelated test CA');
  const validCertificate = await createTestLeaf(ca, '127.0.0.1', '02');
  const wrongHostCertificate = await createTestLeaf(ca, 'wrong.example', '03');
  const unrelatedCertificate = await createTestLeaf(unrelatedCa, '127.0.0.1', '04');
  const caPath = path.join(dataDir, 'ca.pem');
  fs.writeFileSync(caPath, pki.certificateToPem(ca.cert));
  const bundlePath = refreshTerminalCaBundle(caPath);

  const interceptor = new ElectronInterceptor();
  interceptor.ca = {
    getTerminalCaBundlePath: () => refreshTerminalCaBundle(caPath)
  };
  interceptor._environment = () => ({
    ...process.env,
    NODE_EXTRA_CA_CERTS: path.join(unrelatedDir, 'stale.pem'),
    NODE_TLS_REJECT_UNAUTHORIZED: '0'
  });
  const launchBundlePath = interceptor._getMainProcessCaBundlePath();
  const env = interceptor._getLaunchEnvironment(8080, launchBundlePath);

  assert.equal(launchBundlePath, bundlePath);
  assert.equal(env.NODE_EXTRA_CA_CERTS, bundlePath);
  assert.equal('NODE_TLS_REJECT_UNAUTHORIZED' in env, false);
  const directTrustTestEnvironment = { ...env, NODE_USE_ENV_PROXY: '0' };

  const valid = await requestWithServer(validCertificate, directTrustTestEnvironment);
  assert.equal(valid.code, 0, valid.stderr);
  assert.equal(valid.stdout, 'ok:200');
  assert.doesNotMatch(valid.stderr, /NODE_TLS_REJECT_UNAUTHORIZED/);

  const wrongHost = await requestWithServer(wrongHostCertificate, directTrustTestEnvironment);
  assert.equal(wrongHost.code, 0, wrongHost.stderr);
  assert.equal(wrongHost.stdout, 'error:ERR_TLS_CERT_ALTNAME_INVALID');

  const unrelated = await requestWithServer(unrelatedCertificate, directTrustTestEnvironment);
  assert.equal(unrelated.code, 0, unrelated.stderr);
  assert.match(
    unrelated.stdout,
    /^error:(?:SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY)$/
  );
});
