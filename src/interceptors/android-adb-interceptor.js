import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import QRCode from 'qrcode';

const HTTP_TOOLKIT_ANDROID_PACKAGE = 'tech.httptoolkit.android.v1';
const HTTP_TOOLKIT_ANDROID_ACTIVATE = 'tech.httptoolkit.android.ACTIVATE';
const HTTP_TOOLKIT_ANDROID_DEACTIVATE = 'tech.httptoolkit.android.DEACTIVATE';
const HTTP_TOOLKIT_ANDROID_CONNECT_URL = 'https://android.httptoolkit.tech/connect/';
const EMULATOR_HOST_IPS = ['10.0.2.2', '10.0.3.2'];

export class AndroidAdbInterceptor {
  constructor() {
    this.id = 'android-adb';
    this.name = 'Android Device (ADB)';
    this.active = false;
    this.ca = null;
    this.activatedDevices = new Map(); // deviceId -> { serial, model }
    this.reverseTunnels = new Set(); // `${deviceId}:${proxyPort}`
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
  _getConnectedDevices() {
    try {
      const output = execFileSync('adb', ['devices', '-l'], { encoding: 'utf8', timeout: 5000 });
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
    const devices = this._getConnectedDevices();
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

  _isAdbAvailable() {
    try {
      execFileSync('adb', ['version'], { stdio: 'ignore', timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  _adb(deviceId, args, options = {}) {
    return execFileSync('adb', ['-s', deviceId, ...args], {
      encoding: options.encoding || 'utf8',
      stdio: options.stdio || 'pipe',
      timeout: options.timeout || 10000
    });
  }

  _isHttpToolkitAppInstalled(deviceId) {
    try {
      this._adb(deviceId, ['shell', 'pm', 'path', HTTP_TOOLKIT_ANDROID_PACKAGE], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  _bringHttpToolkitAppToFront(deviceId) {
    try {
      this._adb(deviceId, ['shell', 'monkey', '-p', HTTP_TOOLKIT_ANDROID_PACKAGE, '1'], {
        stdio: 'ignore',
        timeout: 5000
      });
    } catch (err) {
      console.warn(`[Interceptor] Failed to foreground HTTP Toolkit Android app on ${deviceId}:`, err.message);
    }
  }

  _createReverseTunnel(deviceId, proxyPort) {
    try {
      this._adb(deviceId, ['reverse', `tcp:${proxyPort}`, `tcp:${proxyPort}`], {
        stdio: 'ignore',
        timeout: 5000
      });
      this.reverseTunnels.add(`${deviceId}:${proxyPort}`);
      console.log(`[Interceptor] ADB reverse tunnel active on ${deviceId}: tcp:${proxyPort} -> tcp:${proxyPort}`);
      return true;
    } catch (err) {
      console.warn(`[Interceptor] ADB reverse tunnel failed on ${deviceId}:`, err.message);
      return false;
    }
  }

  _removeReverseTunnel(deviceId, proxyPort) {
    if (!proxyPort) return;
    const key = `${deviceId}:${proxyPort}`;
    if (!this.reverseTunnels.has(key)) return;

    try {
      this._adb(deviceId, ['reverse', '--remove', `tcp:${proxyPort}`], {
        stdio: 'ignore',
        timeout: 5000
      });
    } catch (err) {
      console.warn(`[Interceptor] Failed to remove ADB reverse tunnel on ${deviceId}:`, err.message);
    } finally {
      this.reverseTunnels.delete(key);
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

  _activateHttpToolkitApp(deviceId, proxyPort) {
    if (!this.ca?.getCertInfo?.()?.certificateSpkiFingerprint) {
      return { success: false, error: 'CA certificate is not available for HTTP Toolkit Android app setup' };
    }

    if (!this._isHttpToolkitAppInstalled(deviceId)) {
      return {
        success: false,
        error: `HTTP Toolkit Android app is not installed (${HTTP_TOOLKIT_ANDROID_PACKAGE})`,
        appInstalled: false
      };
    }

    const tunnelActive = this._createReverseTunnel(deviceId, proxyPort);
    const connectUrl = this._buildHttpToolkitConnectUrl(proxyPort);

    this._bringHttpToolkitAppToFront(deviceId);

    try {
      this._adb(deviceId, [
        'shell',
        'am',
        'start',
        '-W',
        '-a',
        HTTP_TOOLKIT_ANDROID_ACTIVATE,
        '-d',
        connectUrl
      ], { timeout: 15000 });

      console.log(`[Interceptor] HTTP Toolkit Android app activation intent sent to ${deviceId}`);
      return {
        success: true,
        appInstalled: true,
        tunnelActive,
        connectUrl
      };
    } catch (err) {
      this._removeReverseTunnel(deviceId, proxyPort);
      return {
        success: false,
        error: err.message,
        appInstalled: true,
        tunnelActive
      };
    }
  }

  _deactivateHttpToolkitApp(deviceId, proxyPort) {
    if (!this._isHttpToolkitAppInstalled(deviceId)) return false;

    this._bringHttpToolkitAppToFront(deviceId);

    try {
      this._adb(deviceId, [
        'shell',
        'am',
        'start',
        '-W',
        '-a',
        HTTP_TOOLKIT_ANDROID_DEACTIVATE
      ], { timeout: 10000 });
      console.log(`[Interceptor] HTTP Toolkit Android app deactivation intent sent to ${deviceId}`);
      return true;
    } catch (err) {
      console.warn(`[Interceptor] Failed to deactivate HTTP Toolkit Android app on ${deviceId}:`, err.message);
      return false;
    } finally {
      this._removeReverseTunnel(deviceId, proxyPort);
    }
  }

  /**
   * Push the CA certificate to the device's user certificate store.
   * Returns the remote cert path on the device.
   */
  _pushCaCert(deviceId) {
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
      this._adb(deviceId, ['push', certPath, remotePath], {
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
  _setProxy(deviceId, proxyHost, proxyPort) {
    try {
      this._adb(deviceId, ['shell', 'settings', 'put', 'global', 'http_proxy', `${proxyHost}:${proxyPort}`], {
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
   * Remove HTTP proxy from the device.
   */
  _clearProxy(deviceId) {
    try {
      this._adb(deviceId, ['shell', 'settings', 'put', 'global', 'http_proxy', ':0'], {
        stdio: 'ignore',
        timeout: 5000
      });
      console.log(`[Interceptor] Proxy cleared on ${deviceId}`);
      return true;
    } catch (err) {
      console.error(`[Interceptor] Failed to clear proxy on ${deviceId}:`, err.message);
      return false;
    }
  }

  /**
   * Remove the pushed CA certificate from the device.
   */
  _removeCaCert(deviceId) {
    try {
      this._adb(deviceId, ['shell', 'rm', '-f', '/data/local/tmp/http-freekit-ca.pem'], {
        stdio: 'ignore',
        timeout: 5000
      });
      console.log(`[Interceptor] CA cert removed from ${deviceId}`);
    } catch (err) {
      console.error(`[Interceptor] Failed to remove CA cert from ${deviceId}:`, err.message);
    }
  }

  /**
   * Get the host IP that the Android device can reach.
   * For emulators, use 10.0.2.2 (special alias for host loopback).
   * For physical devices, use the machine's LAN IP.
   */
  _getHostIp(deviceId) {
    // Android emulators typically have serial like "emulator-5554"
    if (deviceId.startsWith('emulator-')) {
      return '10.0.2.2';
    }

    return this._getHostIps()[0] || '127.0.0.1';
  }

  _getHostIps() {
    // For physical devices, find the host machine's LAN IP
    const interfaces = os.networkInterfaces();
    const addresses = [];
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          addresses.push(iface.address);
        }
      }
    }

    return [...new Set(addresses)];
  }

  async activate(proxyPort, options = {}) {
    const { deviceId, useHttpToolkitApp = true } = options;

    if (!deviceId) {
      // No specific device — return metadata with device list for UI selection
      const devices = this._getConnectedDevices();
      const qrMetadata = await this._getQrMetadata(proxyPort);
      return {
        success: true,
        metadata: {
          devices,
          activatedDevices: Array.from(this.activatedDevices.entries()).map(([serial, info]) => ({
            serial,
            ...info
          })),
          adbAvailable: this._isAdbAvailable(),
          httpToolkitAppPackage: HTTP_TOOLKIT_ANDROID_PACKAGE,
          prefersHttpToolkitApp: true,
          ...qrMetadata,
          requiresDeviceSelection: true
        }
      };
    }

    // Verify device is connected and authorized
    const devices = this._getConnectedDevices();
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

    const hostIp = this._getHostIp(deviceId);
    let mode = 'global-proxy';
    let appInstalled = false;
    let tunnelActive = false;
    let appActivationError = null;
    let remoteCertPath = null;

    if (useHttpToolkitApp) {
      const appActivation = this._activateHttpToolkitApp(deviceId, proxyPort);
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
      // Push CA certificate for the global proxy fallback.
      remoteCertPath = this._pushCaCert(deviceId);

      // Set proxy
      const proxySet = this._setProxy(deviceId, hostIp, proxyPort);

      if (!proxySet) {
        return { success: false, error: `Failed to set proxy on ${deviceId}` };
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
      appActivationError
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
        ...(await this._getQrMetadata(proxyPort)),
        certPushed: !!remoteCertPath,
        certInstallNote: mode === 'http-toolkit-app'
          ? 'HTTP Toolkit Android app launched. Accept the VPN/certificate prompts on the device if shown.'
          : remoteCertPath
          ? 'CA certificate pushed to device. Install it via Settings > Security > Install from storage > /data/local/tmp/http-freekit-ca.pem'
          : 'No CA certificate available. HTTPS interception will show certificate warnings.',
        devices: this._getConnectedDevices(),
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
      if (activeInfo?.mode === 'http-toolkit-app') {
        this._deactivateHttpToolkitApp(deviceId, activeInfo.proxyPort);
      } else {
        this._clearProxy(deviceId);
        this._removeCaCert(deviceId);
      }
      this.activatedDevices.delete(deviceId);
      console.log(`[Interceptor] Android ADB interceptor deactivated for ${deviceId}`);
    } else {
      // Deactivate all devices
      for (const [serial, activeInfo] of this.activatedDevices) {
        if (activeInfo?.mode === 'http-toolkit-app') {
          this._deactivateHttpToolkitApp(serial, activeInfo.proxyPort);
        } else {
          this._clearProxy(serial);
          this._removeCaCert(serial);
        }
      }
      this.activatedDevices.clear();
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
