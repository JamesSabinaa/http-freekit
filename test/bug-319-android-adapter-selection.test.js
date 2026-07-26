import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { AndroidAdbInterceptor } from '../src/interceptors/android-adb-interceptor.js';

const physicalDevice = {
  serial: 'physical-device',
  status: 'device',
  model: 'Physical Device',
  deviceName: 'physical'
};

const hostInterfaces = [
  { name: 'Wi-Fi', address: '192.168.50.6', netmask: '255.255.255.0', prefixLength: 24 },
  { name: 'Ethernet', address: '192.168.50.5', netmask: '255.255.255.0', prefixLength: 24 },
  { name: 'USB', address: '10.1.0.5', netmask: '255.255.255.0', prefixLength: 24 }
];

test('Android discovery exposes deterministic choices only for ambiguous fallback devices', async () => {
  const interceptor = new AndroidAdbInterceptor();
  const devices = [
    physicalDevice,
    { ...physicalDevice, serial: 'unique-device', model: 'Unique Device' },
    { ...physicalDevice, serial: 'emulator-5554', model: 'Emulator' },
    { ...physicalDevice, serial: 'toolkit-device', model: 'Toolkit Device' }
  ];
  interceptor._getConnectedDevices = async () => devices;
  interceptor._queryHttpToolkitAppInstalled = async serial => {
    assert.notEqual(serial, 'emulator-5554', 'emulators need no adapter discovery');
    return serial === 'toolkit-device';
  };
  interceptor._getHostInterfaces = () => hostInterfaces;
  interceptor._getDeviceIpv4Addresses = async serial => {
    if (serial === 'physical-device') return ['192.168.50.42'];
    if (serial === 'unique-device') return ['10.1.0.42'];
    assert.fail(`adapter discovery is unnecessary for ${serial}`);
  };
  interceptor._getQrMetadata = async () => ({ qrAvailable: false });
  interceptor._isAdbAvailable = async () => true;

  const result = await interceptor.activate(8080, {});
  const bySerial = new Map(result.metadata.devices.map(device => [device.serial, device]));

  assert.equal(bySerial.get('physical-device').requiresHostIpSelection, true);
  assert.deepEqual(bySerial.get('physical-device').hostIpCandidates, [
    { name: 'Ethernet', address: '192.168.50.5', prefixLength: 24 },
    { name: 'Wi-Fi', address: '192.168.50.6', prefixLength: 24 }
  ]);
  assert.equal(bySerial.get('unique-device').requiresHostIpSelection, false);
  assert.deepEqual(bySerial.get('unique-device').hostIpCandidates, [
    { name: 'USB', address: '10.1.0.5', prefixLength: 24 }
  ]);
  assert.equal('requiresHostIpSelection' in bySerial.get('emulator-5554'), false);
  assert.equal('hostIpCandidates' in bySerial.get('emulator-5554'), false);
  assert.equal(bySerial.get('toolkit-device').httpToolkitAppInstalled, true);
  assert.equal('hostIpCandidates' in bySerial.get('toolkit-device'), false);
});

test('ambiguous fallback activation returns structured candidates without mutating proxy state', async () => {
  const interceptor = new AndroidAdbInterceptor();
  interceptor._getConnectedDevices = async () => [physicalDevice];
  interceptor._getQrMetadata = async () => ({ qrAvailable: false });
  interceptor._activateHttpToolkitApp = async () => ({
    success: false,
    appInstalled: false,
    tunnelActive: false,
    error: 'companion app is unavailable'
  });
  interceptor._getHostInterfaces = () => hostInterfaces.slice(0, 2);
  interceptor._getDeviceIpv4Addresses = async () => ['192.168.50.42'];
  interceptor._getProxy = async () => assert.fail('proxy reads must wait for adapter selection');
  interceptor._pushCaCert = async () => assert.fail('certificate writes must wait for adapter selection');
  interceptor._setProxy = async () => assert.fail('proxy writes must wait for adapter selection');

  const result = await interceptor.activate(8080, { deviceId: 'physical-device' });

  assert.equal(result.success, false);
  assert.equal(result.metadata.requiresHostIpSelection, true);
  assert.deepEqual(result.metadata.hostIpCandidates.map(candidate => candidate.address), [
    '192.168.50.5',
    '192.168.50.6'
  ]);
  assert.equal(result.metadata.devices[0].requiresHostIpSelection, true);
});

test('Android activation uses an explicitly selected local host IP and rejects arbitrary hosts', async () => {
  const interceptor = new AndroidAdbInterceptor();
  interceptor._getConnectedDevices = async () => [physicalDevice];
  interceptor._getQrMetadata = async () => ({ qrAvailable: false });
  interceptor._getHostInterfaces = () => hostInterfaces;
  interceptor._getDeviceIpv4Addresses = async () => assert.fail('explicit local selections need no rediscovery');
  interceptor._getProxy = async () => ({ success: true, value: 'null' });
  interceptor._pushCaCert = async () => null;
  let configuredHostIp;
  interceptor._setProxy = async (_serial, hostIp) => {
    configuredHostIp = hostIp;
    return true;
  };

  const result = await interceptor.activate(8080, {
    deviceId: 'physical-device',
    useHttpToolkitApp: false,
    hostIp: '192.168.50.6'
  });
  assert.equal(result.success, true);
  assert.equal(configuredHostIp, '192.168.50.6');

  await assert.rejects(
    interceptor._getHostIp('physical-device', '203.0.113.99'),
    /is not a local IPv4 address/
  );
  interceptor._getHostInterfaces = () => assert.fail('emulators need no host adapter choice');
  assert.equal(await interceptor._getHostIp('emulator-5554'), '10.0.2.2');
});

const rendererSource = fs.readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
const androidStart = rendererSource.indexOf('function renderAndroidConfig(');
const androidEnd = rendererSource.indexOf('async function readInterceptorRefreshMetadata(', androidStart);
assert.notEqual(androidStart, -1);
assert.notEqual(androidEnd, -1);
const androidRenderer = rendererSource.slice(androidStart, androidEnd);

function rendererHarness(metadata, fetchImpl = async () => assert.fail('unexpected fetch')) {
  const container = { innerHTML: '' };
  const requests = [];
  const toasts = [];
  const context = {
    API_BASE: '',
    console,
    expandedInterceptorMetadata: metadata,
    androidHostIpSelections: new Map(),
    interceptorsInProgress: new Set(),
    allInterceptors: [],
    esc: value => String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;'),
    document: {
      getElementById: id => id === 'interceptConfig-android-adb' ? container : null,
      querySelector: () => null
    },
    beginInterceptorOperation: () => ({ id: 'android-adb' }),
    isCurrentInterceptorOperation: () => true,
    filterInterceptors: () => {},
    renderConnectedSources: () => {},
    toast: (message, type) => toasts.push({ message, type }),
    fetch: async (url, options) => {
      requests.push({ url, options });
      return await fetchImpl(url, options);
    }
  };
  vm.createContext(context);
  vm.runInContext(androidRenderer, context);
  return { context, container, requests, toasts };
}

test('Android device DOM shows a choice only for ambiguous backend candidates', () => {
  const ambiguous = {
    ...physicalDevice,
    requiresHostIpSelection: true,
    hostIpCandidates: [
      { name: 'Ethernet', address: '192.168.50.5', prefixLength: 24 },
      { name: 'Wi-Fi', address: '192.168.50.6', prefixLength: 24 }
    ]
  };
  const unique = {
    ...physicalDevice,
    serial: 'unique-device',
    requiresHostIpSelection: false,
    hostIpCandidates: [{ name: 'USB', address: '10.1.0.5', prefixLength: 24 }]
  };
  const emulator = { ...physicalDevice, serial: 'emulator-5554' };
  const harness = rendererHarness({ devices: [ambiguous, unique, emulator], activatedDevices: [] });

  harness.context.renderAndroidConfig(harness.container);

  assert.equal((harness.container.innerHTML.match(/<select /g) || []).length, 1);
  assert.match(harness.container.innerHTML, /Ethernet · 192\.168\.50\.5/);
  assert.match(harness.container.innerHTML, /Wi-Fi · 192\.168\.50\.6/);
  assert.match(harness.container.innerHTML, /class="android-device-activate" disabled/);
  assert.doesNotMatch(harness.container.innerHTML, /USB · 10\.1\.0\.5/);
});

test('Android UI posts only the selected backend candidate as hostIp', async () => {
  const device = {
    ...physicalDevice,
    requiresHostIpSelection: true,
    hostIpCandidates: [
      { name: 'Ethernet', address: '192.168.50.5', prefixLength: 24 },
      { name: 'Wi-Fi', address: '192.168.50.6', prefixLength: 24 }
    ]
  };
  let activationRequests = 0;
  const harness = rendererHarness(
    { devices: [device], activatedDevices: [] },
    async (url) => {
      if (url.endsWith('/api/interceptors/android-adb/activate')) {
        activationRequests++;
        return {
          ok: true,
          json: async () => ({
            success: true,
            metadata: { model: device.model, devices: [device], activatedDevices: [] }
          })
        };
      }
      return { ok: true, json: async () => ({ interceptors: [] }) };
    }
  );

  harness.context.selectAndroidHostIp('physical-device', '192.168.50.6');
  await harness.context.activateAndroidDevice('physical-device');

  assert.equal(activationRequests, 1);
  assert.deepEqual(JSON.parse(harness.requests[0].options.body), {
    deviceId: 'physical-device',
    hostIp: '192.168.50.6'
  });

  const invalidHarness = rendererHarness({ devices: [device], activatedDevices: [] });
  invalidHarness.context.androidHostIpSelections.set('physical-device', '203.0.113.99');
  await invalidHarness.context.activateAndroidDevice('physical-device');
  assert.equal(invalidHarness.requests.length, 0);
  assert.match(invalidHarness.toasts[0].message, /Choose the host network adapter/);
});
