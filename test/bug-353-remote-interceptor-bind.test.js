import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { AndroidAdbInterceptor } from '../src/interceptors/android-adb-interceptor.js';
import { DockerInterceptor } from '../src/interceptors/docker-interceptor.js';
import { InterceptorManager } from '../src/interceptors/interceptor-manager.js';
import {
  canAdvertisedHostReachProxy,
  classifyProxyBindHost,
  resolveProxyBindAddress
} from '../src/interceptors/proxy-bind-reachability.js';

const device = {
  serial: 'device-1',
  status: 'device',
  model: 'Test Device',
  deviceName: 'test-device'
};

function configureCa(interceptor) {
  interceptor.ca = {
    getCertInfo: () => ({ certificateSpkiFingerprint: 'test-spki' })
  };
}

function decodeConnectUrl(connectUrl) {
  const encoded = new URL(connectUrl).searchParams.get('data');
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/')
    .padEnd(Math.ceil(encoded.length / 4) * 4, '=');
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
}

test('proxy bind classification distinguishes loopback, wildcard, and specific hosts', () => {
  for (const host of [
    '127.0.0.1',
    '127.42.0.9',
    'localhost',
    '::1',
    '[::1]',
    '0:0:0:0:0:0:0:1',
    '::ffff:127.0.0.1'
  ]) {
    assert.equal(classifyProxyBindHost(host).kind, 'loopback', host);
  }
  for (const host of ['0.0.0.0', '::', '[::]', '0:0:0:0:0:0:0:0']) {
    assert.equal(classifyProxyBindHost(host).kind, 'wildcard', host);
  }
  for (const host of ['192.0.2.10', '2001:db8::10', 'proxy.example.test']) {
    assert.equal(classifyProxyBindHost(host).kind, 'specific', host);
  }

  assert.equal(canAdvertisedHostReachProxy('127.0.0.1', '192.0.2.10'), false);
  assert.equal(canAdvertisedHostReachProxy('::1', 'host.docker.internal'), false);
  assert.equal(canAdvertisedHostReachProxy('0.0.0.0', '192.0.2.10'), true);
  assert.equal(canAdvertisedHostReachProxy('::', '192.0.2.10'), true);
  assert.equal(canAdvertisedHostReachProxy('192.0.2.10', '192.0.2.10'), true);
  assert.equal(canAdvertisedHostReachProxy('192.0.2.11', '192.0.2.10'), false);
});

test('proxy bind hostnames resolve once to the numeric address shared by startup', async () => {
  const lookups = [];
  const lookup = async host => {
    lookups.push(host);
    return { address: '127.0.0.1', family: 4 };
  };

  assert.equal(await resolveProxyBindAddress('LOCALHOST.', lookup), '127.0.0.1');
  assert.deepEqual(lookups, ['localhost']);
  assert.equal(await resolveProxyBindAddress('[::1]', () => assert.fail()), '::1');
});

test('interceptor constructors receive the manager proxy bind host', () => {
  const manager = new InterceptorManager(null, { proxyBindHost: '::' });

  assert.equal(manager.interceptors.get('docker').proxyBindHost, '::');
  assert.equal(manager.interceptors.get('android-adb').proxyBindHost, '::');
});

test('Docker rejects unreachable gateway instructions and honors explicit remote binding', async () => {
  const loopback = new DockerInterceptor({ proxyBindHost: '127.0.0.1' });
  loopback._platform = () => 'win32';
  loopback._getCombinedCaBundlePath = () => assert.fail('unreachable activation must stop before CA setup');

  const rejected = await loopback.activate(8080);

  assert.equal(rejected.success, false);
  assert.match(rejected.error, /host\.docker\.internal/);
  assert.match(rejected.error, /PROXY_BIND_HOST=0\.0\.0\.0/);
  assert.equal(loopback.active, false);

  const remote = new DockerInterceptor({ proxyBindHost: '0.0.0.0' });
  remote._platform = () => 'win32';
  remote._getCombinedCaBundlePath = () => '/tmp/freekit-ca-bundle.pem';
  const activated = await remote.activate(8080);

  assert.equal(activated.success, true);
  assert.equal(activated.metadata.proxyUrl, 'http://host.docker.internal:8080');
});

test('Android global proxy fails before mutation when its host address is not bound', async () => {
  const interceptor = new AndroidAdbInterceptor({ proxyBindHost: '127.0.0.1' });
  configureCa(interceptor);
  interceptor._getConnectedDevices = async () => [device];
  interceptor._getHostInterfaces = () => [{
    name: 'Wi-Fi',
    address: '192.0.2.10',
    netmask: '255.255.255.0',
    prefixLength: 24
  }];
  interceptor._getHostIp = async () => '192.0.2.10';
  interceptor._getProxy = async () => assert.fail('unreachable activation must not read or write device proxy state');
  interceptor._pushCaCert = async () => assert.fail('unreachable activation must not stage a CA');
  interceptor._setProxy = async () => assert.fail('unreachable activation must not set a proxy');

  const result = await interceptor.activate(8080, {
    deviceId: device.serial,
    useHttpToolkitApp: false
  });

  assert.equal(result.success, false);
  assert.match(result.error, /Android global proxy setup/);
  assert.match(result.error, /PROXY_BIND_HOST=0\.0\.0\.0/);
  assert.equal(interceptor.active, false);
  assert.equal(interceptor.activatedDevices.size, 0);
});

test('IPv4 loopback binding remains reachable through Android emulator aliases', async () => {
  const interceptor = new AndroidAdbInterceptor({ proxyBindHost: '127.0.0.1' });
  configureCa(interceptor);
  interceptor._getHostInterfaces = () => [{
    name: 'Wi-Fi',
    address: '192.0.2.10',
    netmask: '255.255.255.0',
    prefixLength: 24
  }];

  assert.equal(await interceptor._getHostIp('emulator-5554'), '10.0.2.2');
  const qrMetadata = await interceptor._getQrMetadata(8080);
  assert.equal(qrMetadata.qrAvailable, true);
  assert.equal(qrMetadata.qrAvailabilityScope, 'emulator-only');
  assert.match(qrMetadata.qrAvailabilityNote, /only from an Android emulator/);
  assert.deepEqual(decodeConnectUrl(qrMetadata.qrConnectUrl).addresses, [
    '10.0.2.2',
    '10.0.3.2'
  ]);

  await assert.rejects(
    interceptor._getHostIp(device.serial, '192.0.2.10'),
    /PROXY_BIND_HOST=0\.0\.0\.0/
  );
});

test('loopback binding keeps Android companion activation available through ADB reverse', async () => {
  const interceptor = new AndroidAdbInterceptor({ proxyBindHost: '127.0.0.1' });
  configureCa(interceptor);
  interceptor._getConnectedDevices = async () => [device];
  interceptor._getHostInterfaces = () => [{
    name: 'Wi-Fi',
    address: '192.0.2.10',
    netmask: '255.255.255.0',
    prefixLength: 24
  }];
  interceptor._prepareHttpToolkitAppActivation = async () => ({
    success: true,
    appInstalled: true,
    previousReverseMapping: null
  });
  interceptor._activateHttpToolkitApp = async (_deviceId, proxyPort) => {
    const key = `${device.serial}:${proxyPort}`;
    interceptor.reverseTunnels.add(key);
    interceptor.previousReverseMappings.set(key, null);
    return { success: true, appInstalled: true, tunnelActive: true };
  };
  interceptor._getHostIp = async () => assert.fail('companion activation must not use a remote host address');

  const result = await interceptor.activate(8080, {
    deviceId: device.serial,
    useHttpToolkitApp: true
  });

  assert.equal(result.success, true);
  assert.equal(result.metadata.mode, 'http-toolkit-app');
  assert.match(result.metadata.proxyUrl, /127\.0\.0\.1:8080 via ADB reverse/);
  assert.equal(interceptor.activatedDevices.get(device.serial).mode, 'http-toolkit-app');
});

test('loopback companion activation does not claim success when ADB reverse fails', async () => {
  const interceptor = new AndroidAdbInterceptor({ proxyBindHost: '127.0.0.1' });
  configureCa(interceptor);
  interceptor._getHostInterfaces = () => [{
    name: 'Wi-Fi',
    address: '192.0.2.10',
    netmask: '255.255.255.0',
    prefixLength: 24
  }];
  interceptor._isHttpToolkitAppInstalled = async () => true;
  interceptor._createReverseTunnel = async () => false;
  interceptor._bringHttpToolkitAppToFront = async () => {
    assert.fail('the app must not launch without any reachable proxy route');
  };

  const result = await interceptor._activateHttpToolkitApp(device.serial, 8080);

  assert.equal(result.success, false);
  assert.equal(result.tunnelActive, false);
  assert.equal(result.activationIntentAttempted, false);
  assert.match(result.error, /ADB reverse tunnel/);
  assert.match(result.error, /PROXY_BIND_HOST=0\.0\.0\.0/);
});

test('ADB reverse companion URLs remain valid with no remote addresses', async () => {
  const interceptor = new AndroidAdbInterceptor({ proxyBindHost: '127.0.0.1' });
  configureCa(interceptor);
  interceptor._getHostInterfaces = () => [{
    name: 'Wi-Fi',
    address: '192.0.2.10',
    netmask: '255.255.255.0',
    prefixLength: 24
  }];
  interceptor._isHttpToolkitAppInstalled = async () => true;
  interceptor._createReverseTunnel = async () => true;
  interceptor._bringHttpToolkitAppToFront = async () => {};
  interceptor._adb = async (_deviceId, args) => {
    assert.ok(args.includes('tech.httptoolkit.android.ACTIVATE'));
    return 'Status: ok\n';
  };

  const preparation = await interceptor._prepareHttpToolkitAppActivation(device.serial, 8080);
  const setup = decodeConnectUrl(preparation.connectUrl);
  const result = await interceptor._activateHttpToolkitApp(device.serial, 8080, preparation);

  assert.deepEqual(setup.addresses, []);
  assert.equal(setup.localTunnelPort, 8080);
  assert.equal(result.success, true);
  assert.equal(result.tunnelActive, true);
  assert.equal(result.activationIntentAttempted, true);
});

test('a created ADB reverse is not treated as reachable for a non-loopback bind', async () => {
  const interceptor = new AndroidAdbInterceptor({ proxyBindHost: '2001:db8::10' });
  configureCa(interceptor);
  interceptor._getHostInterfaces = () => [];
  interceptor._isHttpToolkitAppInstalled = async () => true;
  interceptor._createReverseTunnel = async (_deviceId, proxyPort) => {
    const key = `${device.serial}:${proxyPort}`;
    interceptor.reverseTunnels.add(key);
    interceptor.previousReverseMappings.set(key, null);
    return true;
  };
  interceptor._bringHttpToolkitAppToFront = async () => {
    assert.fail('the app must not launch when the reverse cannot reach the listener');
  };

  const result = await interceptor._activateHttpToolkitApp(device.serial, 8080);

  assert.equal(result.success, false);
  assert.equal(result.tunnelActive, true);
  assert.equal(result.activationIntentAttempted, false);
  assert.equal(result.previousReverseMapping, null);
  assert.match(result.error, /ADB reverse tunnel/);
});

test('full activation clears pending ownership after a pre-intent reverse failure', async () => {
  const interceptor = new AndroidAdbInterceptor({ proxyBindHost: '127.0.0.1' });
  configureCa(interceptor);
  interceptor._getConnectedDevices = async () => [device];
  interceptor._getHostInterfaces = () => [];
  interceptor._getQrMetadata = async () => ({ qrAvailable: false });
  interceptor._isHttpToolkitAppInstalled = async () => true;
  interceptor._getReverseMapping = async () => null;
  interceptor._createReverseTunnel = async () => false;
  interceptor._bringHttpToolkitAppToFront = async () => assert.fail('ACTIVATE must not be attempted');
  interceptor._deactivateHttpToolkitApp = async () => assert.fail('DEACTIVATE must not be sent pre-intent');
  let reverseCleanupCalls = 0;
  interceptor._removeReverseTunnel = async () => {
    reverseCleanupCalls++;
    return true;
  };
  interceptor._getHostIp = async () => {
    throw interceptor._proxyBindError('Android global proxy setup', '192.0.2.10');
  };

  const result = await interceptor.activate(8080, {
    deviceId: device.serial,
    useHttpToolkitApp: true
  });

  assert.equal(result.success, false);
  assert.equal(reverseCleanupCalls, 1);
  assert.equal(interceptor.activatedDevices.size, 0);
  assert.equal(interceptor.journaledGlobalDevices.size, 0);
  assert.equal(interceptor.active, false);
});

test('full activation restores an unusable reverse before clearing pending ownership', async () => {
  const interceptor = new AndroidAdbInterceptor({ proxyBindHost: '2001:db8::10' });
  configureCa(interceptor);
  interceptor._getConnectedDevices = async () => [device];
  interceptor._getHostInterfaces = () => [];
  interceptor._getQrMetadata = async () => ({ qrAvailable: false });
  interceptor._isHttpToolkitAppInstalled = async () => true;
  interceptor._getReverseMapping = async () => null;
  interceptor._createReverseTunnel = async (_deviceId, proxyPort) => {
    const key = `${device.serial}:${proxyPort}`;
    interceptor.reverseTunnels.add(key);
    interceptor.previousReverseMappings.set(key, null);
    return true;
  };
  interceptor._bringHttpToolkitAppToFront = async () => assert.fail('ACTIVATE must not be attempted');
  interceptor._deactivateHttpToolkitApp = async () => assert.fail('DEACTIVATE must not be sent pre-intent');
  let reverseCleanupCalls = 0;
  interceptor._removeReverseTunnel = async (_deviceId, proxyPort) => {
    reverseCleanupCalls++;
    const key = `${device.serial}:${proxyPort}`;
    interceptor.reverseTunnels.delete(key);
    interceptor.previousReverseMappings.delete(key);
    return true;
  };
  interceptor._getHostIp = async () => {
    throw interceptor._proxyBindError('Android global proxy setup', '192.0.2.10');
  };

  const result = await interceptor.activate(8080, {
    deviceId: device.serial,
    useHttpToolkitApp: true
  });

  assert.equal(result.success, false);
  assert.equal(reverseCleanupCalls, 1);
  assert.equal(interceptor.reverseTunnels.size, 0);
  assert.equal(interceptor.activatedDevices.size, 0);
  assert.equal(interceptor.journaledGlobalDevices.size, 0);
});

test('failed pre-intent reverse cleanup retains only explicit tunnel ownership', async () => {
  const interceptor = new AndroidAdbInterceptor({ proxyBindHost: '2001:db8::10' });
  configureCa(interceptor);
  interceptor._getConnectedDevices = async () => [device];
  interceptor._getHostInterfaces = () => [];
  interceptor._getQrMetadata = async () => ({ qrAvailable: false });
  interceptor._isHttpToolkitAppInstalled = async () => true;
  interceptor._getReverseMapping = async () => null;
  interceptor._createReverseTunnel = async (_deviceId, proxyPort) => {
    const key = `${device.serial}:${proxyPort}`;
    interceptor.reverseTunnels.add(key);
    interceptor.previousReverseMappings.set(key, null);
    return true;
  };
  interceptor._bringHttpToolkitAppToFront = async () => assert.fail('ACTIVATE must not be attempted');
  interceptor._deactivateHttpToolkitApp = async () => assert.fail('DEACTIVATE must not be sent pre-intent');
  interceptor._removeReverseTunnel = async () => false;

  const result = await interceptor.activate(8080, {
    deviceId: device.serial,
    useHttpToolkitApp: true
  });

  assert.equal(result.success, false);
  assert.match(result.error, /Failed to restore the companion ADB reverse mapping/);
  assert.equal(interceptor.activatedDevices.get(device.serial).mode, 'reverse-cleanup');
  assert.equal(interceptor.journaledGlobalDevices.get(device.serial).mode, 'reverse-cleanup');
  assert.equal(interceptor.active, true);
});

test('nonstandard emulator serials do not receive unverified emulator aliases', async () => {
  const interceptor = new AndroidAdbInterceptor({ proxyBindHost: '127.0.0.1' });
  configureCa(interceptor);
  interceptor._getHostInterfaces = () => [];
  interceptor._isHttpToolkitAppInstalled = async () => true;
  interceptor._createReverseTunnel = async () => false;
  interceptor._bringHttpToolkitAppToFront = async () => assert.fail('ACTIVATE must not be attempted');

  const preparation = await interceptor._prepareHttpToolkitAppActivation('127.0.0.1:5555', 8080);
  const setup = decodeConnectUrl(preparation.connectUrl);
  const result = await interceptor._activateHttpToolkitApp('127.0.0.1:5555', 8080, preparation);

  assert.deepEqual(setup.addresses, []);
  assert.equal(result.success, false);
  assert.equal(result.activationIntentAttempted, false);
});

test('Android metadata hides unreachable global and QR setup addresses', async () => {
  const loopback = new AndroidAdbInterceptor({ proxyBindHost: '[::1]' });
  configureCa(loopback);
  loopback._getHostInterfaces = () => [{
    name: 'Wi-Fi',
    address: '192.0.2.10',
    netmask: '255.255.255.0',
    prefixLength: 24
  }];
  loopback._getConnectedDevices = async () => [device];
  loopback._queryHttpToolkitAppInstalled = async () => false;
  loopback._getReachableHostIpCandidates = async () => [{
    name: 'Wi-Fi',
    address: '192.0.2.10',
    prefixLength: 24
  }];

  const qrMetadata = await loopback._getQrMetadata(8080);
  const metadata = await loopback.getMetadata();

  assert.equal(qrMetadata.qrAvailable, false);
  assert.match(qrMetadata.qrError, /PROXY_BIND_HOST=0\.0\.0\.0/);
  assert.equal('qrConnectUrl' in qrMetadata, false);
  assert.equal(metadata.devices[0].globalProxyAvailable, false);
  assert.deepEqual(metadata.devices[0].hostIpCandidates, []);
  assert.match(metadata.devices[0].globalProxyError, /bound to ::1/);

  const specific = new AndroidAdbInterceptor({ proxyBindHost: '192.0.2.10' });
  configureCa(specific);
  specific._getHostInterfaces = loopback._getHostInterfaces;
  const availableQr = await specific._getQrMetadata(8080);
  const setup = decodeConnectUrl(availableQr.qrConnectUrl);

  assert.equal(availableQr.qrAvailable, true);
  assert.deepEqual(setup.addresses, ['192.0.2.10']);
  assert.equal('qrAvailabilityScope' in availableQr, false);
});

test('recovered global proxy ownership is not reported as intercepting after a loopback restart', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-bug-353-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(dataDir, 'android-adb-global-proxy-recovery.json'),
    JSON.stringify({
      version: 3,
      devices: [{
        serial: device.serial,
        mode: 'global-proxy',
        previousProxy: 'null',
        hostIp: '192.0.2.10',
        proxyPort: 8080,
        remoteCertPath: '/data/local/tmp/http-freekit-ca.pem',
        model: device.model,
        deviceName: device.deviceName
      }]
    })
  );

  const interceptor = new AndroidAdbInterceptor({
    dataDir,
    proxyBindHost: '127.0.0.1'
  });
  interceptor._getConnectedDevicesWithHostIpMetadata = async () => [];
  const metadata = await interceptor.getMetadata();

  assert.equal(await interceptor.isActive(), true, 'cleanup ownership must remain stoppable');
  assert.equal(metadata.interceptionActive, false);
  assert.equal(metadata.activationUncertain, true);
  assert.equal(metadata.activatedDevices[0].mode, 'proxy-uncertain');
  assert.match(metadata.activatedDevices[0].proxyBindError, /PROXY_BIND_HOST=0\.0\.0\.0/);
});

test('renderer labels alias-only QR setup as emulator-only', () => {
  const source = fs.readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function renderAndroidConfig(');
  const end = source.indexOf('function selectAndroidHostIp(', start);
  const context = {
    expandedInterceptorMetadata: {
      devices: [],
      activatedDevices: [],
      qrAvailable: true,
      qrConnectUrl: 'https://android.httptoolkit.tech/connect/?data=test',
      qrImageDataUrl: 'data:image/png;base64,test',
      qrAvailabilityScope: 'emulator-only',
      qrAvailabilityNote: 'This QR code is available only to Android emulators.'
    },
    androidHostIpSelections: new Map(),
    esc: value => String(value ?? '')
  };
  vm.createContext(context);
  vm.runInContext(`${source.slice(start, end)}\nglobalThis.render = renderAndroidConfig;`, context);
  const container = { innerHTML: '' };

  context.render(container);

  assert.match(container.innerHTML, /available only to Android emulators/);
  assert.doesNotMatch(container.innerHTML, /Open the HTTP Toolkit Android app and scan this code/);
});

test('renderer surfaces global proxy bind errors without disabling companion activation', () => {
  const source = fs.readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function renderAndroidConfig(');
  const end = source.indexOf('function selectAndroidHostIp(', start);
  const context = {
    expandedInterceptorMetadata: {
      devices: [{
        ...device,
        globalProxyAvailable: false,
        globalProxyError: 'Android global proxy setup cannot reach the listener.',
        hostIpCandidates: [],
        requiresHostIpSelection: false
      }],
      activatedDevices: [],
      qrAvailable: false,
      qrError: 'QR unavailable'
    },
    androidHostIpSelections: new Map(),
    esc: value => String(value ?? '')
  };
  vm.createContext(context);
  vm.runInContext(`${source.slice(start, end)}\nglobalThis.render = renderAndroidConfig;`, context);
  const container = { innerHTML: '' };

  context.render(container);

  assert.match(container.innerHTML, /Global proxy unavailable/);
  assert.match(container.innerHTML, /companion app can still be activated through ADB/);
  assert.match(container.innerHTML, /class="android-device-activate"/);
  assert.doesNotMatch(container.innerHTML, /class="android-device-activate" disabled/);
});

test('startup resolves the override once and passes it to proxy and interceptors', () => {
  const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const configuredBind = source.indexOf('const configuredProxyBindHost = process.env.PROXY_BIND_HOST ||');
  const bindResolution = source.indexOf(
    'const proxyBindHost = await resolveProxyBindAddress(configuredProxyBindHost)'
  );
  const interceptorConstruction = source.indexOf('new InterceptorManager(ca, {');
  const proxyConstruction = source.indexOf('new ProxyServer(ca, {');

  assert.notEqual(configuredBind, -1);
  assert.notEqual(bindResolution, -1);
  assert.ok(configuredBind < bindResolution);
  assert.ok(bindResolution < interceptorConstruction);
  assert.ok(bindResolution < proxyConstruction);
  assert.match(source.slice(interceptorConstruction, proxyConstruction), /proxyBindHost/);
  assert.match(source.slice(proxyConstruction, proxyConstruction + 300), /bindHost: proxyBindHost/);
});
