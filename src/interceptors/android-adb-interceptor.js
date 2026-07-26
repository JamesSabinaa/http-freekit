import fs from 'fs';
import os from 'os';
import QRCode from 'qrcode';
import { execFileAsync } from './command-runner.js';

const HTTP_TOOLKIT_ANDROID_PACKAGE = 'tech.httptoolkit.android.v1';
const HTTP_TOOLKIT_ANDROID_ACTIVATE = 'tech.httptoolkit.android.ACTIVATE';
const HTTP_TOOLKIT_ANDROID_DEACTIVATE = 'tech.httptoolkit.android.DEACTIVATE';
const HTTP_TOOLKIT_ANDROID_CONNECT_URL = 'https://android.httptoolkit.tech/connect/';
const EMULATOR_HOST_IPS = ['10.0.2.2', '10.0.3.2'];

function getActivityLaunchError(output) {
  const statuses = String(output || '')
    .split(/\r\n?|\n/)
    .map(line => line.match(/^\s*Status\s*:\s*(.*?)\s*$/i)?.[1])
    .filter(status => status !== undefined);
  const status = statuses.at(-1)?.trim();
  if (status?.toLowerCase() === 'ok') return null;
  return status
    ? `Android activity launch reported Status: ${status}`
    : 'Android activity launch did not report Status: ok';
}

function ipv4ToInteger(address) {
  const parts = String(address).split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return parts.reduce((value, part) => ((value << 8) | part) >>> 0, 0);
}

function sharesSubnet(firstAddress, secondAddress, netmask) {
  const first = ipv4ToInteger(firstAddress);
  const second = ipv4ToInteger(secondAddress);
  const mask = ipv4ToInteger(netmask);
  return first !== null && second !== null && mask !== null && (first & mask) === (second & mask);
}

function netmaskPrefixLength(netmask) {
  const mask = ipv4ToInteger(netmask);
  if (mask === null) return 0;
  return mask.toString(2).replace(/0/g, '').length;
}

export class AndroidAdbInterceptor {
  constructor() {
    this.id = 'android-adb';
    this.name = 'Android Device (ADB)';
    this.active = false;
    this.ca = null;
    this.activatedDevices = new Map(); // deviceId -> { serial, model }
    this.reverseTunnels = new Set(); // `${deviceId}:${proxyPort}`
    this.previousReverseMappings = new Map(); // `${deviceId}:${proxyPort}` -> prior remote endpoint or null
  }

  async isActivable() {
    return true;
  }

  async isActive() {
    return this.active && this.activatedDevices.size > 0;
  }

  /**
   * Parse `adb devices -l` output into a list of connected devices.
   */
  async _getConnectedDevices() {
    try {
      const output = await execFileAsync('adb', ['devices', '-l'], { encoding: 'utf8', timeout: 5000 });
      const lines = output.split('\n').slice(1); // skip header "List of devices attached"
      const devices = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Format: <serial>  <status>  <properties...>
        const parts = trimmed.split(/\s+/);
        if (parts.length < 2) continue;

        const serial = parts[0];
        const status = parts[1]; // device, offline, unauthorized, etc.

        // Extract model from properties like "model:Pixel_6"
        let model = serial;
        const modelMatch = trimmed.match(/model:(\S+)/);
        if (modelMatch) {
          model = modelMatch[1].replace(/_/g, ' ');
        }

        // Extract device name from properties like "device:oriole"
        let deviceName = '';
        const deviceMatch = trimmed.match(/device:(\S+)/);
        if (deviceMatch) {
          deviceName = deviceMatch[1];
        }

        devices.push({ serial, status, model, deviceName });
      }

      return devices;
    } catch (err) {
      console.error('[Interceptor] ADB devices list failed:', err.message);
      return [];
    }
  }

  async getMetadata() {
    const devices = await this._getConnectedDevices();
    return {
      devices,
      activatedDevices: Array.from(this.activatedDevices.entries()).map(([serial, info]) => ({
        serial,
        ...info
      })),
      httpToolkitAppPackage: HTTP_TOOLKIT_ANDROID_PACKAGE,
      prefersHttpToolkitApp: true
    };
  }

  async _isAdbAvailable() {
    try {
      await execFileAsync('adb', ['version'], { timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  _adb(deviceId, args, options = {}) {
    return execFileAsync('adb', ['-s', deviceId, ...args], {
      encoding: options.encoding || 'utf8',
      timeout: options.timeout || 10000
    });
  }

  async _isHttpToolkitAppInstalled(deviceId) {
    try {
      await this._adb(deviceId, ['shell', 'pm', 'path', HTTP_TOOLKIT_ANDROID_PACKAGE], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async _bringHttpToolkitAppToFront(deviceId) {
    try {
      await this._adb(deviceId, ['shell', 'monkey', '-p', HTTP_TOOLKIT_ANDROID_PACKAGE, '1'], {
        stdio: 'ignore',
        timeout: 5000
      });
    } catch (err) {
      console.warn(`[Interceptor] Failed to foreground HTTP Toolkit Android app on ${deviceId}:`, err.message);
    }
  }

  async _createReverseTunnel(deviceId, proxyPort) {
    const localEndpoint = `tcp:${proxyPort}`;
    const key = `${deviceId}:${proxyPort}`;

    if (this.reverseTunnels.has(key)) return true;

    try {
      const reverseList = await this._adb(deviceId, ['reverse', '--list'], { timeout: 5000 });
      const previousMapping = String(reverseList || '')
        .split(/\r?\n/)
        .map(line => line.trim().split(/\s+/))
        .find(parts => parts.length >= 2 && parts.at(-2) === localEndpoint)
        ?.at(-1) || null;

      if (previousMapping !== localEndpoint) {
        const createArgs = previousMapping === null
          ? ['reverse', '--no-rebind', localEndpoint, localEndpoint]
          : ['reverse', localEndpoint, localEndpoint];
        await this._adb(deviceId, createArgs, {
          stdio: 'ignore',
          timeout: 5000
        });
      }

      this.previousReverseMappings.set(key, previousMapping);
      this.reverseTunnels.add(key);
      console.log(`[Interceptor] ADB reverse tunnel active on ${deviceId}: ${localEndpoint} -> ${localEndpoint}`);
      return true;
    } catch (err) {
      console.warn(`[Interceptor] ADB reverse tunnel failed on ${deviceId}:`, err.message);
      return false;
    }
  }

  async _removeReverseTunnel(deviceId, proxyPort) {
    if (!proxyPort) return true;
    const key = `${deviceId}:${proxyPort}`;
    if (!this.reverseTunnels.has(key)) return true;

    try {
      const localEndpoint = `tcp:${proxyPort}`;
      const previousMapping = this.previousReverseMappings.get(key) ?? null;

      if (previousMapping !== localEndpoint) {
        const restoreArgs = previousMapping === null
          ? ['reverse', '--remove', localEndpoint]
          : ['reverse', localEndpoint, previousMapping];
        await this._adb(deviceId, restoreArgs, {
          stdio: 'ignore',
          timeout: 5000
        });
      }

      this.previousReverseMappings.delete(key);
      this.reverseTunnels.delete(key);
      return true;
    } catch (err) {
      console.warn(`[Interceptor] Failed to remove ADB reverse tunnel on ${deviceId}:`, err.message);
      return false;
    }
  }

  _buildHttpToolkitConnectUrl(proxyPort) {
    const certInfo = this.ca?.getCertInfo?.();
    const setupParams = {
      addresses: [...EMULATOR_HOST_IPS, ...this._getHostIps()],
      port: proxyPort,
      localTunnelPort: proxyPort,
      certFingerprint: certInfo?.certificateSpkiFingerprint || certInfo?.certificateFingerprint
    };
    const data = Buffer.from(JSON.stringify(setupParams), 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

    return `${HTTP_TOOLKIT_ANDROID_CONNECT_URL}?data=${encodeURIComponent(data)}`;
  }

  async _getQrMetadata(proxyPort) {
    if (!this.ca?.getCertInfo?.()?.certificateSpkiFingerprint) {
      return {
        qrAvailable: false,
        qrError: 'CA certificate is not available for QR setup'
      };
    }

    const connectUrl = this._buildHttpToolkitConnectUrl(proxyPort);
    const qrImageDataUrl = await QRCode.toDataURL(connectUrl, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 220,
      color: {
        dark: '#111111',
        light: '#ffffff'
      }
    });

    return {
      qrAvailable: true,
      qrConnectUrl: connectUrl,
      qrImageDataUrl
    };
  }

  async _activateHttpToolkitApp(deviceId, proxyPort) {
    if (!this.ca?.getCertInfo?.()?.certificateSpkiFingerprint) {
      return { success: false, error: 'CA certificate is not available for HTTP Toolkit Android app setup' };
    }

    if (!await this._isHttpToolkitAppInstalled(deviceId)) {
      return {
        success: false,
        error: `HTTP Toolkit Android app is not installed (${HTTP_TOOLKIT_ANDROID_PACKAGE})`,
        appInstalled: false
      };
    }

    const tunnelActive = await this._createReverseTunnel(deviceId, proxyPort);
    const connectUrl = this._buildHttpToolkitConnectUrl(proxyPort);

    await this._bringHttpToolkitAppToFront(deviceId);

    try {
      const output = await this._adb(deviceId, [
        'shell',
        'am',
        'start',
        '-W',
        '-a',
        HTTP_TOOLKIT_ANDROID_ACTIVATE,
        '-d',
        connectUrl
      ], { timeout: 15000 });
      const launchError = getActivityLaunchError(output);
      if (launchError) throw new Error(launchError);

      console.log(`[Interceptor] HTTP Toolkit Android app activation intent sent to ${deviceId}`);
      return {
        success: true,
        appInstalled: true,
        tunnelActive,
        connectUrl
      };
    } catch (err) {
      const tunnelRemoved = await this._removeReverseTunnel(deviceId, proxyPort);
      return {
        success: false,
        error: err.message,
        appInstalled: true,
        tunnelActive: tunnelActive && !tunnelRemoved
      };
    }
  }

  async _deactivateHttpToolkitApp(deviceId, proxyPort) {
    let appDeactivated = false;
    try {
      if (await this._isHttpToolkitAppInstalled(deviceId)) {
        await this._bringHttpToolkitAppToFront(deviceId);
        const output = await this._adb(deviceId, [
          'shell',
          'am',
          'start',
          '-W',
          '-a',
          HTTP_TOOLKIT_ANDROID_DEACTIVATE
        ], { timeout: 10000 });
        const launchError = getActivityLaunchError(output);
        if (launchError) throw new Error(launchError);
        console.log(`[Interceptor] HTTP Toolkit Android app deactivation intent sent to ${deviceId}`);
        appDeactivated = true;
      }
    } catch (err) {
      console.warn(`[Interceptor] Failed to deactivate HTTP Toolkit Android app on ${deviceId}:`, err.message);
      return false;
    }
    const tunnelRemoved = await this._removeReverseTunnel(deviceId, proxyPort);
    return appDeactivated && tunnelRemoved;
  }

  /**
   * Push the CA certificate to the device's user certificate store.
   * Returns the remote cert path on the device.
   */
  async _pushCaCert(deviceId) {
    if (!this.ca) {
      console.warn('[Interceptor] No CA available for ADB interceptor');
      return null;
    }

    const certInfo = this.ca.getCertInfo();
    const certPath = certInfo.certificatePath;

    if (!certPath || !fs.existsSync(certPath)) {
      console.warn('[Interceptor] CA certificate file not found');
      return null;
    }

    // Android needs DER format cert for user certificate store
    // First push the PEM cert to the device
    const remotePath = '/data/local/tmp/http-freekit-ca.pem';

    try {
      await this._adb(deviceId, ['push', certPath, remotePath], {
        stdio: 'ignore',
        timeout: 10000
      });
      console.log(`[Interceptor] CA cert pushed to ${deviceId}:${remotePath}`);
      return remotePath;
    } catch (err) {
      console.error(`[Interceptor] Failed to push CA cert to ${deviceId}:`, err.message);
      return null;
    }
  }

  /**
   * Set HTTP proxy on the device via ADB shell.
   */
  async _setProxy(deviceId, proxyHost, proxyPort) {
    try {
      await this._adb(deviceId, ['shell', 'settings', 'put', 'global', 'http_proxy', `${proxyHost}:${proxyPort}`], {
        stdio: 'ignore',
        timeout: 5000
      });
      console.log(`[Interceptor] Proxy set on ${deviceId}: ${proxyHost}:${proxyPort}`);
      return true;
    } catch (err) {
      console.error(`[Interceptor] Failed to set proxy on ${deviceId}:`, err.message);
      return false;
    }
  }

  /**
   * Read the current global HTTP proxy so it can be restored later.
   */
  async _getProxy(deviceId) {
    try {
      const value = await this._adb(deviceId, ['shell', 'settings', 'get', 'global', 'http_proxy'], {
        timeout: 5000
      });
      return { success: true, value: String(value).trim() };
    } catch (err) {
      console.error(`[Interceptor] Failed to read proxy on ${deviceId}:`, err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * Restore the global HTTP proxy value that existed before activation.
   */
  async _restoreProxy(deviceId, previousProxy) {
    const wasUnset = previousProxy == null || previousProxy === '' || previousProxy === 'null';
    const settingsArgs = wasUnset
      ? ['shell', 'settings', 'delete', 'global', 'http_proxy']
      : ['shell', 'settings', 'put', 'global', 'http_proxy', previousProxy];
    try {
      await this._adb(deviceId, settingsArgs, {
        stdio: 'ignore',
        timeout: 5000
      });
      console.log(`[Interceptor] Previous proxy restored on ${deviceId}`);
      return true;
    } catch (err) {
      console.error(`[Interceptor] Failed to restore proxy on ${deviceId}:`, err.message);
      return false;
    }
  }

  /**
   * Remove the pushed CA certificate from the device.
   */
  async _removeCaCert(deviceId) {
    try {
      await this._adb(deviceId, ['shell', 'rm', '-f', '/data/local/tmp/http-freekit-ca.pem'], {
        stdio: 'ignore',
        timeout: 5000
      });
      console.log(`[Interceptor] CA cert removed from ${deviceId}`);
      return true;
    } catch (err) {
      console.error(`[Interceptor] Failed to remove CA cert from ${deviceId}:`, err.message);
      return false;
    }
  }

  /**
   * Get the host IP that the Android device can reach.
   * For emulators, use 10.0.2.2 (special alias for host loopback).
   * For physical devices, use the machine's LAN IP.
   */
  async _getHostIp(deviceId, requestedHostIp) {
    // Android emulators typically have serial like "emulator-5554"
    if (deviceId.startsWith('emulator-')) {
      return '10.0.2.2';
    }

    const hostInterfaces = this._getHostInterfaces();
    if (requestedHostIp) {
      if (!hostInterfaces.some(iface => iface.address === requestedHostIp)) {
        throw new Error(`Android proxy host ${requestedHostIp} is not a local IPv4 address`);
      }
      return requestedHostIp;
    }

    const deviceAddresses = await this._getDeviceIpv4Addresses(deviceId);
    const matches = hostInterfaces
      .filter(iface => deviceAddresses.some(address => sharesSubnet(iface.address, address, iface.netmask)))
      .sort((first, second) => second.prefixLength - first.prefixLength);
    if (matches.length === 0) {
      throw new Error('Could not find a host network adapter reachable from the Android device');
    }

    const bestPrefixLength = matches[0].prefixLength;
    const bestAddresses = [...new Set(
      matches.filter(iface => iface.prefixLength === bestPrefixLength).map(iface => iface.address)
    )];
    if (bestAddresses.length !== 1) {
      throw new Error(`Multiple host adapters can reach the Android device; specify hostIp (${bestAddresses.join(', ')})`);
    }
    return bestAddresses[0];
  }

  async _getDeviceIpv4Addresses(deviceId) {
    const output = await this._adb(deviceId, ['shell', 'ip', '-o', '-4', 'addr', 'show', 'scope', 'global'], {
      timeout: 5000
    });
    return [...String(output).matchAll(/\binet\s+(\d+(?:\.\d+){3})\/\d+/g)].map(match => match[1]);
  }

  _getHostInterfaces() {
    const interfaces = os.networkInterfaces();
    const candidates = [];
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] || []) {
        if ((iface.family === 'IPv4' || iface.family === 4) && !iface.internal) {
          candidates.push({
            name,
            address: iface.address,
            netmask: iface.netmask,
            prefixLength: Number(iface.cidr?.split('/')[1]) || netmaskPrefixLength(iface.netmask)
          });
        }
      }
    }
    return candidates;
  }

  _getHostIps() {
    return [...new Set(this._getHostInterfaces().map(iface => iface.address))];
  }

  async _cleanupActivatedDevice(serial, activeInfo) {
    if (activeInfo?.mode === 'http-toolkit-app') {
      return await this._deactivateHttpToolkitApp(serial, activeInfo.proxyPort);
    }
    if (activeInfo?.mode === 'staging-cleanup') {
      return await this._removeCaCert(serial);
    }
    const proxyRestored = await this._restoreProxy(serial, activeInfo?.previousProxy);
    const certificateRemoved = await this._removeCaCert(serial);
    return proxyRestored && certificateRemoved;
  }

  async activate(proxyPort, options = {}) {
    const { deviceId, useHttpToolkitApp = true, hostIp: requestedHostIp } = options;

    if (!deviceId) {
      // No specific device — return metadata with device list for UI selection
      const devices = await this._getConnectedDevices();
      const qrMetadata = await this._getQrMetadata(proxyPort);
      return {
        success: true,
        metadata: {
          devices,
          activatedDevices: Array.from(this.activatedDevices.entries()).map(([serial, info]) => ({
            serial,
            ...info
          })),
          adbAvailable: await this._isAdbAvailable(),
          httpToolkitAppPackage: HTTP_TOOLKIT_ANDROID_PACKAGE,
          prefersHttpToolkitApp: true,
          ...qrMetadata,
          requiresDeviceSelection: true
        }
      };
    }

    // Verify device is connected and authorized
    const devices = await this._getConnectedDevices();
    const device = devices.find(d => d.serial === deviceId);

    if (!device) {
      return { success: false, error: `Device ${deviceId} not found` };
    }

    if (device.status !== 'device') {
      return {
        success: false,
        error: `Device ${deviceId} is ${device.status} (must be authorized)`
      };
    }

    // Build response-only metadata before replacing an existing activation or
    // changing device state. QR generation is fallible and must not turn a
    // committed activation into an API failure with live, untracked changes.
    const qrMetadata = await this._getQrMetadata(proxyPort);

    const previousActivation = this.activatedDevices.get(deviceId);
    if (previousActivation) {
      if (!await this._cleanupActivatedDevice(deviceId, previousActivation)) {
        throw new Error(`Could not clean up the existing Android interception for ${deviceId}; reconnect it and retry`);
      }
      this.activatedDevices.delete(deviceId);
      this.active = this.activatedDevices.size > 0;
    }

    let hostIp = null;
    let mode = 'global-proxy';
    let appInstalled = false;
    let tunnelActive = false;
    let appActivationError = null;
    let remoteCertPath = null;
    let previousProxy = null;

    if (useHttpToolkitApp) {
      const appActivation = await this._activateHttpToolkitApp(deviceId, proxyPort);
      appInstalled = appActivation.appInstalled === true;
      tunnelActive = appActivation.tunnelActive === true;

      if (appActivation.success) {
        mode = 'http-toolkit-app';
      } else {
        appActivationError = appActivation.error;
        console.warn(`[Interceptor] HTTP Toolkit Android app activation unavailable for ${deviceId}: ${appActivationError}`);
      }
    }

    if (mode !== 'http-toolkit-app') {
      hostIp = await this._getHostIp(deviceId, requestedHostIp);
      const currentProxy = await this._getProxy(deviceId);
      if (!currentProxy.success) {
        return { success: false, error: `Failed to read existing proxy on ${deviceId}: ${currentProxy.error}` };
      }
      previousProxy = currentProxy.value;

      // Push CA certificate for the global proxy fallback.
      remoteCertPath = await this._pushCaCert(deviceId);

      // Set proxy
      const proxySet = await this._setProxy(deviceId, hostIp, proxyPort);

      if (!proxySet) {
        const certificateRemoved = !remoteCertPath || await this._removeCaCert(deviceId);
        if (!certificateRemoved) {
          this.activatedDevices.set(deviceId, {
            model: device.model,
            deviceName: device.deviceName,
            remoteCertPath,
            mode: 'staging-cleanup'
          });
          this.active = true;
        }
        return {
          success: false,
          error: certificateRemoved
            ? `Failed to set proxy on ${deviceId}`
            : `Failed to set proxy on ${deviceId} and remove its staged CA; reconnect it and retry Stop`
        };
      }
    }

    this.activatedDevices.set(deviceId, {
      model: device.model,
      deviceName: device.deviceName,
      hostIp,
      remoteCertPath,
      proxyPort,
      mode,
      appInstalled,
      tunnelActive,
      appActivationError,
      previousProxy
    });
    this.active = true;

    console.log(`[Interceptor] Android ADB interceptor activated for ${deviceId} (${device.model}) via ${mode}`);

    return {
      success: true,
      metadata: {
        deviceId,
        model: device.model,
        mode,
        proxyUrl: mode === 'http-toolkit-app'
          ? `HTTP Toolkit Android VPN app -> http://127.0.0.1:${proxyPort} via ADB reverse`
          : `http://${hostIp}:${proxyPort}`,
        httpToolkitAppInstalled: appInstalled,
        httpToolkitTunnelActive: tunnelActive,
        httpToolkitAppError: appActivationError,
        ...qrMetadata,
        certPushed: !!remoteCertPath,
        certInstallNote: mode === 'http-toolkit-app'
          ? 'HTTP Toolkit Android app launched. Accept the VPN/certificate prompts on the device if shown.'
          : remoteCertPath
          ? 'CA certificate pushed to device. Install it via Settings > Security > Install from storage > /data/local/tmp/http-freekit-ca.pem'
          : 'No CA certificate available. HTTPS interception will show certificate warnings.',
        devices,
        activatedDevices: Array.from(this.activatedDevices.entries()).map(([serial, info]) => ({
          serial,
          ...info
        }))
      }
    };
  }

  async deactivate(options = {}) {
    const { deviceId } = options;

    if (deviceId) {
      // Deactivate a specific device
      const activeInfo = this.activatedDevices.get(deviceId);
      if (!activeInfo) return;
      if (!await this._cleanupActivatedDevice(deviceId, activeInfo)) {
        this.active = this.activatedDevices.size > 0;
        throw new Error(`Failed to clean up Android device ${deviceId}; reconnect it and retry Stop`);
      }
      this.activatedDevices.delete(deviceId);
      console.log(`[Interceptor] Android ADB interceptor deactivated for ${deviceId}`);
    } else {
      // Deactivate all devices
      const failures = [];
      for (const [serial, activeInfo] of Array.from(this.activatedDevices.entries())) {
        if (await this._cleanupActivatedDevice(serial, activeInfo)) {
          this.activatedDevices.delete(serial);
        } else {
          failures.push(serial);
        }
      }
      if (failures.length > 0) {
        this.active = this.activatedDevices.size > 0;
        throw new Error(`Failed to clean up Android device(s): ${failures.join(', ')}; reconnect and retry Stop`);
      }
      console.log('[Interceptor] Android ADB interceptor deactivated (all devices)');
    }

    this.active = this.activatedDevices.size > 0;
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      type: 'android-adb',
      active: this.active,
      pid: null
    };
  }
}
