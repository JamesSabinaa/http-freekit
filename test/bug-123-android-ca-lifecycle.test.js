import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ApiServer } from '../src/api/api-server.js';
import { AndroidAdbInterceptor } from '../src/interceptors/android-adb-interceptor.js';

const DEVICE_ID = 'legacy-device';
const STAGED_CA_PATH = '/data/local/tmp/http-freekit-ca.pem';

function createDataDir(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-bug-123-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

function writeLegacyGlobalProxyJournal(dataDir) {
  fs.writeFileSync(
    path.join(dataDir, 'android-adb-global-proxy-recovery.json'),
    JSON.stringify({
      version: 5,
      devices: [{
        serial: DEVICE_ID,
        mode: 'global-proxy',
        previousProxy: 'corporate.proxy:8888',
        hostIp: '192.0.2.10',
        proxyPort: 8080,
        remoteCertPath: STAGED_CA_PATH,
        model: 'Legacy Android'
      }]
    })
  );
}

function postJson(port, requestPath, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: requestPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }));
    });
    request.once('error', reject);
    request.end(payload);
  });
}

test('the Android global proxy fallback never stages a CA for manual installation', async () => {
  const interceptor = new AndroidAdbInterceptor();
  interceptor.ca = {
    getCertInfo: () => ({ certificatePath: 'C:\\would-have-been-pushed.pem' })
  };
  interceptor._adb = async () => assert.fail('the HTTP-only fallback must not call ADB push');

  assert.equal(await interceptor._pushCaCert('device-1'), null);
});

test('new global proxy activations are explicit HTTP-only sessions', async t => {
  const interceptor = new AndroidAdbInterceptor({ dataDir: createDataDir(t) });
  interceptor._getConnectedDevices = async () => [{
    serial: 'device-1',
    status: 'device',
    model: 'Test Android',
    deviceName: 'test-device'
  }];
  interceptor._getQrMetadata = async () => ({});
  interceptor._getHostIp = async () => '192.0.2.10';
  interceptor._getProxy = async () => ({ success: true, value: 'null' });
  interceptor._setProxy = async () => true;
  const adbCalls = [];
  interceptor._adb = async (_serial, args) => {
    adbCalls.push(args);
    return '';
  };

  const activation = await interceptor.activate(8080, {
    deviceId: 'device-1',
    useHttpToolkitApp: false
  });

  assert.equal(activation.success, true);
  assert.equal(activation.metadata.mode, 'global-proxy');
  assert.equal(activation.metadata.certPushed, false);
  assert.match(activation.metadata.certInstallNote, /HTTP-only/);
  assert.match(activation.metadata.certInstallNote, /did not install a persistent user CA/);
  assert.doesNotMatch(activation.metadata.certInstallNote, /Install from storage/i);
  assert.equal(adbCalls.some(args => args[0] === 'push'), false);
  assert.equal(interceptor.activatedDevices.get('device-1').manualCaRemovalRequired, false);

  const journal = JSON.parse(fs.readFileSync(interceptor.recoveryFile, 'utf8'));
  assert.equal(journal.version, 6);
  assert.equal(journal.devices[0].manualCaRemovalRequired, false);
});

test('legacy sessions retain ownership until CA removal is explicitly confirmed', async t => {
  const dataDir = createDataDir(t);
  writeLegacyGlobalProxyJournal(dataDir);
  const interceptor = new AndroidAdbInterceptor({ dataDir });
  assert.equal(interceptor.activatedDevices.get(DEVICE_ID).manualCaRemovalRequired, true);

  const settingsRequests = [];
  interceptor._openUserCredentialSettings = async serial => {
    settingsRequests.push(serial);
    return true;
  };
  let cleanupCalls = 0;
  interceptor._restoreProxy = async () => {
    cleanupCalls++;
    return true;
  };
  interceptor._removeCaCert = async () => {
    cleanupCalls++;
    return true;
  };

  await assert.rejects(
    interceptor.deactivate({ deviceId: DEVICE_ID }),
    error => {
      assert.equal(error.code, 'ANDROID_CA_REMOVAL_CONFIRMATION_REQUIRED');
      assert.deepEqual(error.deviceIds, [DEVICE_ID]);
      assert.deepEqual(error.settingsOpened, [DEVICE_ID]);
      return true;
    }
  );
  assert.deepEqual(settingsRequests, [DEVICE_ID]);
  assert.equal(cleanupCalls, 0);
  assert.equal(interceptor.activatedDevices.has(DEVICE_ID), true);
  assert.equal(fs.existsSync(interceptor.recoveryFile), true);

  await interceptor.deactivate({ deviceId: DEVICE_ID, confirmCaRemoved: true });
  assert.equal(cleanupCalls, 2);
  assert.equal(interceptor.activatedDevices.has(DEVICE_ID), false);
  assert.equal(fs.existsSync(interceptor.recoveryFile), false);
});

test('every legacy global-proxy descendant is migrated conservatively', () => {
  const interceptor = new AndroidAdbInterceptor();
  const baseEntry = {
    serial: DEVICE_ID,
    previousProxy: 'corporate.proxy:8888',
    hostIp: '192.0.2.10',
    proxyPort: 8080,
    remoteCertPath: STAGED_CA_PATH
  };

  for (const mode of ['global-proxy', 'proxy-uncertain', 'staging-cleanup']) {
    assert.equal(
      interceptor._normalizeJournalDevice({ ...baseEntry, mode }, 5).manualCaRemovalRequired,
      true,
      `${mode} must retain the legacy manual-CA warning`
    );
  }
});

test('the deactivation API returns the structured legacy-CA confirmation requirement', async t => {
  const error = new Error('Remove the legacy CA before Stop');
  error.code = 'ANDROID_CA_REMOVAL_CONFIRMATION_REQUIRED';
  error.deviceIds = [DEVICE_ID];
  error.settingsOpened = [DEVICE_ID];
  const interceptors = {
    onStatusChange: null,
    deactivate: async () => { throw error; }
  };
  const api = new ApiServer({ port: 8080, mockRules: [] }, null, interceptors);
  const server = http.createServer(api.app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));

  const response = await postJson(
    server.address().port,
    '/api/interceptors/android-adb/deactivate',
    {}
  );
  assert.deepEqual(response, {
    statusCode: 409,
    body: {
      error: 'Remove the legacy CA before Stop',
      code: 'ANDROID_CA_REMOVAL_CONFIRMATION_REQUIRED',
      deviceIds: [DEVICE_ID],
      settingsOpened: [DEVICE_ID]
    }
  });
});

test('the renderer preserves the explicit legacy-CA confirmation handshake', () => {
  const rendererSource = fs.readFileSync(
    new URL('../src/ui/app.js', import.meta.url),
    'utf8'
  );

  assert.match(rendererSource, /data\.code === 'ANDROID_CA_REMOVAL_CONFIRMATION_REQUIRED'/);
  assert.match(rendererSource, /requestDeactivation\(\{ confirmCaRemoved: true \}\)/);
  assert.match(rendererSource, /window\.confirm/);
});
