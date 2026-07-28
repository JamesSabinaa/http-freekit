import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AndroidAdbInterceptor } from '../src/interceptors/android-adb-interceptor.js';

const DEVICE_ID = 'device-197';
const PROXY_PORT = 8197;
const TUNNEL_KEY = `${DEVICE_ID}:${PROXY_PORT}`;

function connectedDevice() {
  return {
    serial: DEVICE_ID,
    status: 'device',
    model: 'Status Device',
    deviceName: 'status-device'
  };
}

function configureGlobal(interceptor) {
  interceptor.activatedDevices.set(DEVICE_ID, {
    mode: 'global-proxy',
    hostIp: '192.0.2.10',
    proxyPort: PROXY_PORT,
    previousProxy: 'null',
    remoteCertPath: '/data/local/tmp/http-freekit-ca.pem'
  });
  interceptor.active = true;
}

function configureCompanion(interceptor, { tunnel = true } = {}) {
  interceptor.activatedDevices.set(DEVICE_ID, {
    mode: 'http-toolkit-app',
    proxyPort: PROXY_PORT,
    appInstalled: true,
    vpnStatusConfirmed: true,
    tunnelActive: tunnel,
    ...(tunnel ? { previousReverseMapping: null } : {})
  });
  if (tunnel) {
    interceptor.reverseTunnels.add(TUNNEL_KEY);
    interceptor.previousReverseMappings.set(TUNNEL_KEY, null);
  }
  interceptor.active = true;
}

test('global proxy status is revalidated and recovers after a disconnect', async () => {
  const interceptor = new AndroidAdbInterceptor();
  configureGlobal(interceptor);
  let connected = false;
  interceptor._getConnectedDevices = async () => connected ? [connectedDevice()] : [];
  interceptor._getProxy = async () => ({ success: true, value: `192.0.2.10:${PROXY_PORT}` });

  assert.equal(await interceptor.isActive(), true, 'cleanup ownership remains stoppable');
  assert.equal(interceptor.activatedDevices.get(DEVICE_ID).mode, 'proxy-uncertain');
  assert.equal(interceptor.toJSON().interceptionActive, false);
  assert.equal(interceptor.toJSON().activationUncertain, true);

  connected = true;
  assert.equal(await interceptor.isActive(), true);
  assert.equal(interceptor.activatedDevices.get(DEVICE_ID).mode, 'global-proxy');
  assert.equal(interceptor.toJSON().interceptionActive, true);
  assert.equal(interceptor.toJSON().activationUncertain, false);
});

test('externally replaced global proxy becomes cleanup-only without overwriting it', async () => {
  const interceptor = new AndroidAdbInterceptor();
  configureGlobal(interceptor);
  interceptor._getConnectedDevices = async () => [connectedDevice()];
  interceptor._getProxy = async () => ({ success: true, value: 'corporate.proxy:8888' });

  assert.equal(await interceptor.isActive(), true);
  assert.equal(interceptor.activatedDevices.get(DEVICE_ID).mode, 'staging-cleanup');
  assert.deepEqual({
    interceptionActive: interceptor.toJSON().interceptionActive,
    cleanupPending: interceptor.toJSON().cleanupPending
  }, {
    interceptionActive: false,
    cleanupPending: true
  });

  let restoredProxy = false;
  interceptor._restoreProxy = async () => { restoredProxy = true; return true; };
  interceptor._removeCaCert = async () => true;
  await interceptor.deactivate({ deviceId: DEVICE_ID });
  assert.equal(restoredProxy, false, 'an external proxy setting must be preserved');
  assert.equal(interceptor.active, false);
});

test('stopped companion VPN retains only reverse-tunnel cleanup ownership', async () => {
  const interceptor = new AndroidAdbInterceptor();
  configureCompanion(interceptor);
  interceptor._getConnectedDevices = async () => [connectedDevice()];
  interceptor._queryHttpToolkitAppInstalled = async () => true;
  interceptor._getHttpToolkitVpnStatus = async () => ({ success: true, value: false });

  assert.equal(await interceptor.isActive(), true);
  assert.equal(interceptor.activatedDevices.get(DEVICE_ID).mode, 'reverse-cleanup');
  assert.equal(interceptor.toJSON().interceptionActive, false);
  assert.equal(interceptor.toJSON().cleanupPending, true);
});

test('stopped companion without a tunnel is removed from active lifecycle state', async () => {
  const interceptor = new AndroidAdbInterceptor();
  configureCompanion(interceptor, { tunnel: false });
  interceptor._getConnectedDevices = async () => [connectedDevice()];
  interceptor._queryHttpToolkitAppInstalled = async () => true;
  interceptor._getHttpToolkitVpnStatus = async () => ({ success: true, value: false });

  assert.equal(await interceptor.isActive(), false);
  assert.equal(interceptor.activatedDevices.size, 0);
  assert.equal(interceptor.active, false);
});

test('a newly launched companion stays uncertain until the VPN prompt is accepted', async () => {
  const interceptor = new AndroidAdbInterceptor();
  configureCompanion(interceptor);
  interceptor.activatedDevices.get(DEVICE_ID).vpnStatusConfirmed = false;
  interceptor._getConnectedDevices = async () => [connectedDevice()];
  interceptor._queryHttpToolkitAppInstalled = async () => true;
  let vpnActive = false;
  interceptor._getHttpToolkitVpnStatus = async () => ({ success: true, value: vpnActive });
  interceptor._getReverseMapping = async () => `tcp:${PROXY_PORT}`;

  assert.equal(await interceptor.isActive(), true);
  assert.equal(interceptor.activatedDevices.get(DEVICE_ID).mode, 'app-uncertain');
  assert.equal(interceptor.toJSON().interceptionActive, false);

  vpnActive = true;
  assert.equal(await interceptor.isActive(), true);
  assert.equal(interceptor.activatedDevices.get(DEVICE_ID).mode, 'http-toolkit-app');
  assert.equal(interceptor.activatedDevices.get(DEVICE_ID).vpnStatusConfirmed, true);
  assert.equal(interceptor.toJSON().interceptionActive, true);
});

test('missing owned reverse tunnel makes a running companion activation uncertain', async () => {
  const interceptor = new AndroidAdbInterceptor();
  configureCompanion(interceptor);
  interceptor._getConnectedDevices = async () => [connectedDevice()];
  interceptor._queryHttpToolkitAppInstalled = async () => true;
  interceptor._getHttpToolkitVpnStatus = async () => ({ success: true, value: true });
  interceptor._getReverseMapping = async () => null;

  assert.equal(await interceptor.isActive(), true);
  assert.equal(interceptor.activatedDevices.get(DEVICE_ID).mode, 'app-uncertain');
  assert.equal(interceptor.toJSON().interceptionActive, false);
  assert.equal(interceptor.toJSON().activationUncertain, true);
});

test('Stop preserves a reverse mapping replaced by another owner', async t => {
  t.mock.method(console, 'warn', () => {});
  const interceptor = new AndroidAdbInterceptor();
  configureCompanion(interceptor);
  const commands = [];
  interceptor._adb = async (_deviceId, args) => {
    commands.push(args);
    if (args[0] === 'reverse' && args[1] === '--list') {
      return `${DEVICE_ID} tcp:${PROXY_PORT} tcp:9999\n`;
    }
    return '';
  };

  assert.equal(await interceptor._removeReverseTunnel(DEVICE_ID, PROXY_PORT), true);
  assert.deepEqual(commands, [['reverse', '--list']]);
  assert.equal(interceptor.reverseTunnels.has(TUNNEL_KEY), false);
  assert.equal(interceptor.previousReverseMappings.has(TUNNEL_KEY), false);
});

test('confirmed companion ownership survives restart and remains stoppable', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-bug-197-recovery-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const original = new AndroidAdbInterceptor({ dataDir });
  configureCompanion(original);
  original.activatedDevices.get(DEVICE_ID).mode = 'app-uncertain';
  original._rememberGlobalProxyOwnership(
    DEVICE_ID,
    original.activatedDevices.get(DEVICE_ID)
  );
  original._getConnectedDevices = async () => [connectedDevice()];
  original._queryHttpToolkitAppInstalled = async () => true;
  original._getHttpToolkitVpnStatus = async () => ({ success: true, value: true });
  original._getReverseMapping = async () => `tcp:${PROXY_PORT}`;

  assert.equal(await original.isActive(), true);
  assert.equal(original.activatedDevices.get(DEVICE_ID).mode, 'http-toolkit-app');
  assert.deepEqual(JSON.parse(fs.readFileSync(original.recoveryFile, 'utf8')), {
    version: 4,
    devices: [{
      serial: DEVICE_ID,
      mode: 'http-toolkit-app',
      proxyPort: PROXY_PORT,
      previousReverseMapping: null
    }]
  });

  const restarted = new AndroidAdbInterceptor({ dataDir });
  assert.equal(restarted.active, true);
  assert.equal(restarted.activatedDevices.get(DEVICE_ID).mode, 'http-toolkit-app');
  assert.equal(restarted.reverseTunnels.has(TUNNEL_KEY), true);
  restarted._deactivateHttpToolkitApp = async () => true;
  await restarted.deactivate({ deviceId: DEVICE_ID });
  assert.equal(restarted.active, false);
  assert.equal(fs.existsSync(restarted.recoveryFile), false);
});

test('version 4 can recover companion ownership without an ADB reverse tunnel', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-bug-197-no-tunnel-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, 'android-adb-global-proxy-recovery.json'), JSON.stringify({
    version: 4,
    devices: [{
      serial: DEVICE_ID,
      mode: 'app-uncertain',
      proxyPort: PROXY_PORT
    }]
  }));

  const restarted = new AndroidAdbInterceptor({ dataDir });
  assert.equal(restarted.active, true);
  assert.equal(restarted.activatedDevices.get(DEVICE_ID).mode, 'app-uncertain');
  assert.equal(restarted.reverseTunnels.size, 0);
});

test('VPN dumpsys parsing distinguishes connected, stopped, absent, and unknown state', () => {
  const interceptor = new AndroidAdbInterceptor();
  assert.equal(interceptor._parseHttpToolkitVpnStatus(`
    VPNs:
      User 0:
        mPackage=tech.httptoolkit.android.v1
        mNetworkInfo=[type: VPN[], state: CONNECTED/CONNECTED]
  `, { authoritative: true }), true);
  assert.equal(interceptor._parseHttpToolkitVpnStatus(`
    VPNs:
      User 0:
        mPackage=tech.httptoolkit.android.v1
        state: DISCONNECTED
  `, { authoritative: true }), false);
  assert.equal(interceptor._parseHttpToolkitVpnStatus(`
    Active package name: tech.httptoolkit.android.v1
    Active vpn type: 1
    NetworkCapabilities: [ Transports: VPN ]
  `, { authoritative: true }), true);
  assert.equal(interceptor._parseHttpToolkitVpnStatus(`
    Active package name: tech.httptoolkit.android.v1
    Active vpn type: 0
  `, { authoritative: true }), false);
  assert.equal(interceptor._parseHttpToolkitVpnStatus('VPNs:\n  User 0:\n    mPackage=com.example.other', {
    authoritative: true
  }), false);
  assert.equal(interceptor._parseHttpToolkitVpnStatus('Connectivity service ready'), null);
  assert.equal(interceptor._parseHttpToolkitVpnStatus(`
    VPNs:
      User 0:
        Active package name: tech.httptoolkit.android.v1
        Active vpn type: -1
        mNetworkAgent=null
      User 10:
        Active package name: com.corporate.vpn
        Active vpn type: 1
        mNetworkAgent=NetworkAgentInfo{VPN}
  `, { authoritative: true }), false);
  assert.equal(interceptor._parseHttpToolkitVpnStatus(`
    VPNs:
      User 0:
        Active package name: tech.httptoolkit.android.v1
        Active vpn type: -1
        mNetworkAgent=NetworkAgentInfo{stale}
  `, { authoritative: true }), false, 'the authoritative active type wins contradictory fields');
  assert.equal(interceptor._parseHttpToolkitVpnStatus(`
    VPNs:
      User 0:
        Active package name: tech.httptoolkit.android.v1
        Active vpn type: -1
      User 10:
        Active package name: tech.httptoolkit.android.v1
        Active vpn type: 1
  `, { authoritative: true }), null, 'conflicting target-package users are ambiguous');
});

test('pending companion launches use warning feedback instead of an activated success toast', () => {
  const appSource = fs.readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  const stylesSource = fs.readFileSync(new URL('../src/ui/styles.css', import.meta.url), 'utf8');

  assert.match(
    appSource,
    /activationUncertain\s*===\s*true[\s\S]*complete the VPN prompts on the device`\s*,\s*'warning'/
  );
  assert.match(stylesSource, /\.toast-warning\s*\{[^}]*var\(--warning-color\)/);
});
