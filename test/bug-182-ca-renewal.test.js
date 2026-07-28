import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import forge from 'node-forge';

import { ApiServer } from '../src/api/api-server.js';
import { CertificateAuthority } from '../src/proxy/certificate-authority.js';

const { pki } = forge;
const rendererSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'ui', 'app.js'),
  'utf8'
);
const indexSource = fs.readFileSync(path.join(process.cwd(), 'src', 'index.js'), 'utf8');

function createPersistedCa(dataDir, notAfter) {
  const keys = pki.rsa.generateKeyPair({ bits: 1024 });
  const certificate = pki.createCertificate();
  const subject = [{ name: 'commonName', value: 'Near-expiry FreeKit test CA' }];
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = '01';
  certificate.validity.notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
  certificate.validity.notAfter = notAfter;
  certificate.setSubject(subject);
  certificate.setIssuer(subject);
  certificate.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true }
  ]);
  certificate.sign(keys.privateKey, forge.md.sha256.create());
  const certificatePem = pki.certificateToPem(certificate);
  fs.writeFileSync(path.join(dataDir, 'ca.pem'), certificatePem);
  fs.writeFileSync(path.join(dataDir, 'ca.key'), pki.privateKeyToPem(keys.privateKey));
  return certificatePem;
}

function requestJson(port, method, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }));
    });
    request.once('error', reject);
    request.end();
  });
}

test('non-Windows startup defers near-expiry CA replacement until explicitly scheduled',
  { timeout: 30000 }, async t => {
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'warn', () => {});
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-ca-renewal-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const oldCertificate = createPersistedCa(
      dataDir,
      new Date(Date.now() + 60 * 60 * 1000)
    );
    const oldFingerprint = new crypto.X509Certificate(oldCertificate)
      .fingerprint.replace(/:/g, '').toUpperCase();

    const deferred = new CertificateAuthority(dataDir);
    deferred._generateKeyPair = async () => assert.fail('deferred startup must retain the trusted CA');
    const deferredInfo = await deferred.initialize({ autoRenewExpiring: false });

    assert.equal(fs.readFileSync(deferred.caCertPath, 'utf8'), oldCertificate);
    assert.equal(deferredInfo.automaticRenewalDeferred, true);
    assert.equal(deferredInfo.renewalRequired, true);
    assert.equal(deferred.getCertInfo().certificateAutomaticRenewalEnabled, false);
    assert.equal(deferred.getCertInfo().certificateRenewalScheduled, false);

    deferred.scheduleRenewal();
    assert.equal(deferred.getCertInfo().certificateRenewalScheduled, true);
    assert.equal(
      JSON.parse(fs.readFileSync(deferred.caRenewalStatePath, 'utf8')).fingerprint,
      oldFingerprint
    );

    const replacementKeys = pki.rsa.generateKeyPair({ bits: 1024 });
    const renewed = new CertificateAuthority(dataDir);
    renewed._generateKeyPair = async () => replacementKeys;
    const renewedInfo = await renewed.initialize({ autoRenewExpiring: false });
    const replacementCertificate = fs.readFileSync(renewed.caCertPath, 'utf8');

    assert.notEqual(replacementCertificate, oldCertificate);
    assert.deepEqual(renewedInfo.replacedCertificateFingerprints, [oldFingerprint]);
    assert.equal(renewedInfo.renewalScheduled, false);
    assert.equal(fs.existsSync(renewed.caRenewalStatePath), false);
    assert.equal(renewed.getCertInfo().certificateReplacementPending, true);
    renewed.acknowledgeReplacementMigration();
    assert.deepEqual(
      renewed.pendingReplacementFingerprints,
      [oldFingerprint],
      'migration acknowledgement must not discard Windows cleanup retries'
    );
    renewed.setPendingMigrationFingerprint(oldFingerprint);
    renewed.setPendingReplacementFingerprints([]);
    assert.equal(
      renewed.getCertInfo().certificateReplacementPending,
      true,
      'Windows cleanup state must not acknowledge external-client migration'
    );
    renewed.acknowledgeReplacementMigration();
    assert.equal(renewed.getCertInfo().certificateReplacementPending, false);
  });

test('an applied renewal marker cannot rotate the replacement a second time', async t => {
  t.mock.method(console, 'log', () => {});
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-ca-renewal-crash-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const activeCertificate = createPersistedCa(
    dataDir,
    new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
  );
  fs.writeFileSync(path.join(dataDir, 'ca-renewal.json'), JSON.stringify({
    version: 1,
    fingerprint: 'AB'.repeat(20)
  }));

  const ca = new CertificateAuthority(dataDir);
  ca._generateKeyPair = async () => assert.fail('the active replacement must not rotate again');
  await ca.initialize({ autoRenewExpiring: false });

  assert.equal(fs.readFileSync(ca.caCertPath, 'utf8'), activeCertificate);
  assert.equal(fs.existsSync(ca.caRenewalStatePath), false);
});

test('near-expiry CA replacement remains automatic when trust migration is enabled', async t => {
  t.mock.method(console, 'log', () => {});
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-ca-auto-renewal-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const oldCertificate = createPersistedCa(
    dataDir,
    new Date(Date.now() + 60 * 60 * 1000)
  );
  const ca = new CertificateAuthority(dataDir);
  ca._generateKeyPair = async () => pki.rsa.generateKeyPair({ bits: 1024 });

  await ca.initialize({ autoRenewExpiring: true });

  assert.notEqual(fs.readFileSync(ca.caCertPath, 'utf8'), oldCertificate);
  assert.equal(ca.getCertInfo().certificateAutomaticRenewalEnabled, true);
  assert.equal(ca.getCertInfo().certificateRenewalRequired, false);
});

test('post-rename marker hardening failures remain visibly scheduled', async t => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-ca-marker-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const ca = new CertificateAuthority(dataDir);
  ca._generateKeyPair = async () => pki.rsa.generateKeyPair({ bits: 1024 });
  await ca.initialize({ autoRenewExpiring: false });
  const originalChmodSync = fs.chmodSync;
  t.mock.method(fs, 'chmodSync', (filePath, mode) => {
    if (filePath === ca.caRenewalStatePath) throw new Error('simulated chmod failure');
    return originalChmodSync(filePath, mode);
  });

  assert.doesNotThrow(() => ca.scheduleRenewal());
  assert.equal(fs.existsSync(ca.caRenewalStatePath), true);
  assert.equal(ca.getCertInfo().certificateRenewalScheduled, true);
});

test('legacy replacement cleanup state becomes a separate migration warning on upgrade', async t => {
  t.mock.method(console, 'log', () => {});
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-ca-migration-upgrade-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  createPersistedCa(dataDir, new Date(Date.now() + 365 * 24 * 60 * 60 * 1000));
  const previousFingerprint = 'AB'.repeat(20);
  fs.writeFileSync(path.join(dataDir, 'ca-replacements.json'), JSON.stringify({
    version: 1,
    fingerprints: [previousFingerprint]
  }));

  const ca = new CertificateAuthority(dataDir);
  await ca.initialize({ autoRenewExpiring: false });

  assert.equal(ca.getCertInfo().certificateReplacementPending, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(ca.caMigrationStatePath, 'utf8')), {
    version: 1,
    previousFingerprint
  });
  assert.equal(
    JSON.parse(fs.readFileSync(ca.caReplacementStatePath, 'utf8')).version,
    2
  );
  ca.acknowledgeReplacementMigration();
  assert.equal(ca.getCertInfo().certificateReplacementPending, false);
  assert.equal(fs.existsSync(ca.caMigrationStatePath), false);
  assert.deepEqual(ca.pendingReplacementFingerprints, [previousFingerprint]);

  const restarted = new CertificateAuthority(dataDir);
  await restarted.initialize({ autoRenewExpiring: false });
  assert.equal(
    restarted.getCertInfo().certificateReplacementPending,
    false,
    'an acknowledged split-state migration must not be recreated from cleanup state'
  );
  assert.deepEqual(restarted.pendingReplacementFingerprints, [previousFingerprint]);
});

test('committed migration marker hardening failure does not strand a scheduled renewal', async t => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-ca-migration-marker-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const oldCertificate = createPersistedCa(
    dataDir,
    new Date(Date.now() + 60 * 60 * 1000)
  );
  const schedulingCa = new CertificateAuthority(dataDir);
  await schedulingCa.initialize({ autoRenewExpiring: false });
  schedulingCa.scheduleRenewal();

  const replacement = new CertificateAuthority(dataDir);
  replacement._generateKeyPair = async () => pki.rsa.generateKeyPair({ bits: 1024 });
  const originalChmodSync = fs.chmodSync;
  t.mock.method(fs, 'chmodSync', (filePath, mode) => {
    if (filePath === replacement.caMigrationStatePath) {
      throw new Error('simulated migration chmod failure');
    }
    return originalChmodSync(filePath, mode);
  });

  await assert.doesNotReject(replacement.initialize({ autoRenewExpiring: false }));
  assert.notEqual(fs.readFileSync(replacement.caCertPath, 'utf8'), oldCertificate);
  assert.equal(fs.existsSync(replacement.caMigrationStatePath), true);
  assert.equal(fs.existsSync(replacement.caRenewalStatePath), false);
  assert.equal(replacement.getCertInfo().certificateReplacementPending, true);
  assert.equal(replacement.getCertInfo().certificateRenewalScheduled, false);
});

test('CA renewal routes schedule, cancel, and acknowledge migration state', async t => {
  const state = {
    automatic: false,
    required: true,
    scheduled: false,
    replacementPending: true
  };
  const ca = {
    getCertInfo: () => ({
      certificateAutomaticRenewalEnabled: state.automatic,
      certificateRenewalRequired: state.required
    }),
    scheduleRenewal: () => { state.scheduled = true; },
    cancelScheduledRenewal: () => { state.scheduled = false; },
    acknowledgeReplacementMigration: () => {
      state.replacementPending = false;
    },
    setPendingReplacementFingerprints: values => {
      state.replacementPending = values.length > 0;
    }
  };
  const proxy = {
    port: 8081,
    mockRules: [],
    onBreakpoint: null,
    onUpstreamProxyRetry: null,
    matchApiSpec: () => null
  };
  const api = new ApiServer(proxy, ca, null);
  const server = http.createServer(api.app);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;

  const scheduled = await requestJson(port, 'POST', '/api/certificate/renewal');
  assert.equal(scheduled.statusCode, 200);
  assert.equal(state.scheduled, true);

  const cancelled = await requestJson(port, 'DELETE', '/api/certificate/renewal');
  assert.equal(cancelled.statusCode, 200);
  assert.equal(state.scheduled, false);

  const acknowledged = await requestJson(
    port,
    'POST',
    '/api/certificate/replacement-acknowledgement'
  );
  assert.equal(acknowledged.statusCode, 200);
  assert.equal(state.replacementPending, false);

  state.automatic = true;
  const automatic = await requestJson(port, 'POST', '/api/certificate/renewal');
  assert.equal(automatic.statusCode, 409);
  assert.match(automatic.body.error, /managed automatically/);

  state.automatic = false;
  state.required = false;
  const tooEarly = await requestJson(port, 'POST', '/api/certificate/renewal');
  assert.equal(tooEarly.statusCode, 409);
  assert.match(tooEarly.body.error, /within 30 days/);
});

test('settings show deferred, scheduled, and replacement CA migration states', () => {
  assert.match(
    indexSource,
    /initialize\(\{ autoRenewExpiring: false \}\)/
  );
  assert.match(
    indexSource,
    /if \(ca\.getCertInfo\(\)\.certificateReplacementPending\)/
  );
  assert.doesNotMatch(indexSource, /if \(certInfo\.replacedCertificateFingerprints\.length > 0\)/);
  assert.match(rendererSource, /if \(nextSection === 'tls'\) void loadConfig\(\)/);
  const start = rendererSource.indexOf('function renderCaRenewalState(');
  const end = rendererSource.indexOf('async function loadConfig()', start);
  assert.ok(start >= 0 && end > start);
  const elements = new Map();
  for (const id of [
    'settingsCaExpiry',
    'settingsCaRenewalNotice',
    'settingsCaRenewalActions',
    'settingsCaScheduleRenewal',
    'settingsCaCancelRenewal',
    'settingsCaAcknowledgeReplacement'
  ]) {
    elements.set(id, { textContent: '', style: {} });
  }
  const context = {
    document: { getElementById: id => elements.get(id) || null }
  };
  vm.createContext(context);
  vm.runInContext(`${rendererSource.slice(start, end)}\nglobalThis.render = renderCaRenewalState;`, context);

  context.render({
    certificateExpiry: Date.now() + 60 * 60 * 1000,
    certificateRenewalRequired: true,
    certificateAutomaticRenewalEnabled: false
  });
  assert.match(elements.get('settingsCaRenewalNotice').textContent, /Automatic replacement is paused/);
  assert.doesNotMatch(elements.get('settingsCaRenewalNotice').textContent, /outside Windows/);
  assert.equal(elements.get('settingsCaScheduleRenewal').style.display, '');
  assert.equal(elements.get('settingsCaRenewalActions').style.display, 'flex');

  context.render({
    certificateExpiry: Date.now() + 20 * 24 * 60 * 60 * 1000,
    certificateRenewalRequired: true,
    certificateAutomaticRenewalEnabled: true
  });
  assert.match(elements.get('settingsCaRenewalNotice').textContent, /Windows will install/);
  assert.equal(elements.get('settingsCaScheduleRenewal').style.display, 'none');
  assert.equal(elements.get('settingsCaRenewalActions').style.display, 'none');

  context.render({
    certificateExpiry: Date.now() + 60 * 60 * 1000,
    certificateRenewalScheduled: true,
    certificateRenewalRequired: true,
    certificateAutomaticRenewalEnabled: false
  });
  assert.match(elements.get('settingsCaRenewalNotice').textContent, /scheduled for the next restart/);
  assert.equal(elements.get('settingsCaCancelRenewal').style.display, '');

  context.render({
    certificateExpiry: Date.now() + 365 * 24 * 60 * 60 * 1000,
    certificateReplacementPending: true,
    certificateAutomaticRenewalEnabled: false
  });
  assert.match(elements.get('settingsCaRenewalNotice').textContent, /download and install/i);
  assert.equal(elements.get('settingsCaAcknowledgeReplacement').style.display, '');
});
