import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { AndroidAdbInterceptor } from '../src/interceptors/android-adb-interceptor.js';

const STAGED_CA_PATH = '/data/local/tmp/http-freekit-ca.pem';
const rendererSource = fs.readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
const stylesSource = fs.readFileSync(new URL('../src/ui/styles.css', import.meta.url), 'utf8');

function summary(value) {
  return {
    interceptionActive: value.interceptionActive,
    interceptionDeviceCount: value.interceptionDeviceCount,
    activationUncertain: value.activationUncertain,
    uncertainDeviceCount: value.uncertainDeviceCount,
    cleanupPending: value.cleanupPending,
    cleanupDeviceCount: value.cleanupDeviceCount
  };
}

function createRendererHarness() {
  const summaryStart = rendererSource.indexOf('const ANDROID_INTERCEPTOR_SUMMARY_FIELDS');
  const summaryEnd = rendererSource.indexOf('function renderConnectedSources(', summaryStart);
  const presentationStart = rendererSource.indexOf('function getAndroidActivationPresentation(');
  const presentationEnd = rendererSource.indexOf('function selectAndroidHostIp(', presentationStart);
  for (const position of [summaryStart, summaryEnd, presentationStart, presentationEnd]) {
    assert.notEqual(position, -1);
  }

  const context = {
    allInterceptors: [],
    expandedInterceptorMetadata: null,
    androidHostIpSelections: new Map(),
    esc: value => String(value ?? '')
  };
  vm.createContext(context);
  vm.runInContext(`
    ${rendererSource.slice(summaryStart, summaryEnd)}
    ${rendererSource.slice(presentationStart, presentationEnd)}
    globalThis.getSummary = getAndroidInterceptorSummary;
    globalThis.renderPills = renderAndroidInterceptorStatusPills;
    globalThis.isConnected = isConnectedInterceptorSource;
    globalThis.updateFromMetadata = updateAndroidInterceptorFromMetadata;
    globalThis.renderAndroid = renderAndroidConfig;
  `, context);
  return context;
}

function connectedDevice(serial = 'device-1') {
  return { serial, status: 'device', model: `Model ${serial}`, deviceName: `name-${serial}` };
}

test('failed proxy setup reports cleanup ownership without claiming interception', async () => {
  const device = connectedDevice();
  const interceptor = new AndroidAdbInterceptor();
  interceptor._getConnectedDevices = async () => [device];
  interceptor._getConnectedDevicesWithHostIpMetadata = async () => [device];
  interceptor._getHostIp = async () => '192.0.2.10';
  interceptor._getProxy = async () => ({ success: true, value: 'null' });
  interceptor._pushCaCert = async () => STAGED_CA_PATH;
  interceptor._setProxy = async () => false;
  interceptor._removeCaCert = async () => false;

  const result = await interceptor.activate(8080, {
    deviceId: device.serial,
    useHttpToolkitApp: false
  });

  assert.equal(result.success, false);
  assert.equal(interceptor.active, true, 'lifecycle ownership keeps Stop available');
  assert.equal(await interceptor.isActive(), true);
  assert.equal(interceptor.activatedDevices.get(device.serial).mode, 'staging-cleanup');
  assert.deepEqual(summary(result.metadata), {
    interceptionActive: false,
    interceptionDeviceCount: 0,
    activationUncertain: false,
    uncertainDeviceCount: 0,
    cleanupPending: true,
    cleanupDeviceCount: 1
  });
  assert.deepEqual(summary(interceptor.toJSON()), summary(result.metadata));
});

test('backend summary separates active, uncertain, and cleanup devices in mixed state', async () => {
  const interceptor = new AndroidAdbInterceptor();
  for (const [serial, mode] of [
    ['global', 'global-proxy'],
    ['app', 'http-toolkit-app'],
    ['proxy-unknown', 'proxy-uncertain'],
    ['app-unknown', 'app-uncertain'],
    ['certificate', 'staging-cleanup'],
    ['tunnel', 'reverse-cleanup']
  ]) {
    interceptor.activatedDevices.set(serial, { mode });
  }
  interceptor.active = true;
  interceptor._getConnectedDevicesWithHostIpMetadata = async () => [];

  const expected = {
    interceptionActive: true,
    interceptionDeviceCount: 2,
    activationUncertain: true,
    uncertainDeviceCount: 2,
    cleanupPending: true,
    cleanupDeviceCount: 2
  };
  assert.deepEqual(summary(interceptor.toJSON()), expected);
  assert.deepEqual(summary(await interceptor.getMetadata()), expected);
});

test('restart recovery retains cleanup-only summary and lifecycle Stop ownership', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-bug-338-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, 'android-adb-global-proxy-recovery.json'), JSON.stringify({
    version: 3,
    devices: [
      {
        serial: 'certificate-device',
        mode: 'staging-cleanup',
        previousProxy: 'null',
        hostIp: '192.0.2.10',
        proxyPort: 8080,
        remoteCertPath: STAGED_CA_PATH
      },
      {
        serial: 'tunnel-device',
        mode: 'reverse-cleanup',
        proxyPort: 8080,
        previousReverseMapping: null
      }
    ]
  }));

  const restarted = new AndroidAdbInterceptor({ dataDir });
  restarted._getConnectedDevicesWithHostIpMetadata = async () => [];
  assert.equal(restarted.active, true);
  assert.equal(await restarted.isActive(), true);
  assert.deepEqual(summary(restarted.toJSON()), {
    interceptionActive: false,
    interceptionDeviceCount: 0,
    activationUncertain: false,
    uncertainDeviceCount: 0,
    cleanupPending: true,
    cleanupDeviceCount: 2
  });
  const metadata = await restarted.getMetadata();
  assert.equal(metadata.activatedDevices.every(device => device.recovered === true), true);
  assert.deepEqual(summary(metadata), summary(restarted.toJSON()));
});

test('renderer maps every Android ownership mode to an honest row state', () => {
  const cases = [
    ['global-proxy', 'activated', 'Global proxy', 'pill-active', 'Activated'],
    ['http-toolkit-app', 'activated', 'VPN app', 'pill-active', 'Activated'],
    ['proxy-uncertain', 'warning', 'Global proxy state uncertain', 'pill-warning', 'Activation uncertain'],
    ['app-uncertain', 'warning', 'VPN app state uncertain', 'pill-warning', 'Activation uncertain'],
    ['staging-cleanup', 'warning', 'Certificate cleanup pending', 'pill-warning', 'Cleanup pending'],
    ['reverse-cleanup', 'warning', 'ADB tunnel cleanup pending', 'pill-warning', 'Cleanup pending']
  ];

  for (const [mode, itemClass, modeLabel, pillClass, statusLabel] of cases) {
    const harness = createRendererHarness();
    harness.expandedInterceptorMetadata = {
      devices: [connectedDevice()],
      activatedDevices: [{ serial: 'device-1', mode }]
    };
    const container = { innerHTML: '' };
    harness.renderAndroid(container);

    assert.match(container.innerHTML, new RegExp(`android-device-item ${itemClass}`), mode);
    assert.match(container.innerHTML, new RegExp(modeLabel), mode);
    assert.match(container.innerHTML, new RegExp(`intercept-pill ${pillClass}`), mode);
    assert.match(container.innerHTML, new RegExp(`>${statusLabel}<`), mode);
    assert.doesNotMatch(container.innerHTML, /android-device-activate/, `${mode} must retain Stop-only ownership`);
    if (itemClass === 'warning') {
      assert.doesNotMatch(container.innerHTML, /android-device-item activated/, mode);
      assert.doesNotMatch(container.innerHTML, /intercept-pill pill-active/, mode);
    }
  }
});

test('cleanup and uncertain Android states are warnings, not connected sources', () => {
  const harness = createRendererHarness();
  const cleanup = {
    id: 'android-adb', active: true,
    interceptionActive: false, interceptionDeviceCount: 0,
    activationUncertain: false, uncertainDeviceCount: 0,
    cleanupPending: true, cleanupDeviceCount: 1
  };
  const uncertain = {
    ...cleanup,
    activationUncertain: true,
    uncertainDeviceCount: 1,
    cleanupPending: false,
    cleanupDeviceCount: 0
  };
  const active = {
    ...cleanup,
    interceptionActive: true,
    interceptionDeviceCount: 1,
    cleanupPending: false,
    cleanupDeviceCount: 0
  };

  assert.equal(harness.isConnected(cleanup), false);
  assert.equal(harness.isConnected(uncertain), false);
  assert.equal(harness.isConnected(active), true);
  assert.doesNotMatch(harness.renderPills(cleanup), /pill-active|Activated/);
  assert.match(harness.renderPills(cleanup), /pill-warning[^>]*>Cleanup pending</);
  assert.doesNotMatch(harness.renderPills(uncertain), /pill-active|>Activated/);
  assert.match(harness.renderPills(uncertain), /pill-warning[^>]*>Activation uncertain</);
});

test('mixed card summary keeps definite activation green and warns for owned uncertainty and cleanup', () => {
  const harness = createRendererHarness();
  const mixed = {
    id: 'android-adb', active: true,
    interceptionActive: true, interceptionDeviceCount: 1,
    activationUncertain: true, uncertainDeviceCount: 2,
    cleanupPending: true, cleanupDeviceCount: 1
  };
  const pills = harness.renderPills(mixed);

  assert.equal(harness.isConnected(mixed), true);
  assert.match(pills, /pill-active[^>]*>Activated · 1</);
  assert.match(pills, /pill-warning[^>]*>Activation uncertain · 2</);
  assert.match(pills, /pill-warning[^>]*>Cleanup pending · 1</);

  harness.allInterceptors.push({ id: 'android-adb', name: 'Android', active: false });
  harness.updateFromMetadata({
    interceptionActive: false, interceptionDeviceCount: 0,
    activationUncertain: false, uncertainDeviceCount: 0,
    cleanupPending: true, cleanupDeviceCount: 1
  });
  assert.equal(harness.allInterceptors[0].active, true, 'failed activation metadata preserves Stop');
  assert.equal(harness.isConnected(harness.allInterceptors[0]), false);
});

test('renderer wires summary refreshes and warning styles without weakening Stop', () => {
  assert.match(rendererSource, /updateAndroidInterceptorFromMetadata\(data\.metadata\);\s*renderConnectedSources/);
  assert.match(rendererSource, /updateAndroidInterceptorFromMetadata\(metadata\);\s*renderConnectedSources/);
  assert.match(rendererSource, /event\.id === 'android-adb' \? getAndroidSummaryFields\(event\)/);
  assert.match(rendererSource, /i\.active && !isExpanded/);
  for (const selector of [
    '.intercept-pill.pill-warning',
    '.intercept-pill-group',
    '.android-device-item.warning',
    '.android-device-mode.warning'
  ]) {
    assert.match(stylesSource, new RegExp(selector.replaceAll('.', '\\.')));
  }
});
