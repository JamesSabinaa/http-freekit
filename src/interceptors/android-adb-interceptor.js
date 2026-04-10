import { execSync, exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

export class AndroidAdbInterceptor {
  constructor() {
    this.id = 'android-adb';
    this.name = 'Android Device (ADB)';
    this.active = false;
    this.ca = null;
    this.activatedDevices = new Map(); // deviceId -> { serial, model }
  }

  async isActivable() {
    try {
      execSync('adb version', { stdio: 'ignore', timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  async isActive() {
    return this.active && this.activatedDevices.size > 0;
  }

  /**
   * Parse `adb devices -l` output into a list of connected devices.
   */
  _getConnectedDevices() {
    try {
      const output = execSync('adb devices -l', { encoding: 'utf8', timeout: 5000 });
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
      }))
    };
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
      execSync(`adb -s ${deviceId} push "${certPath}" ${remotePath}`, {
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
      execSync(
        `adb -s ${deviceId} shell settings put global http_proxy ${proxyHost}:${proxyPort}`,
        { stdio: 'ignore', timeout: 5000 }
      );
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
      execSync(
        `adb -s ${deviceId} shell settings put global http_proxy :0`,
        { stdio: 'ignore', timeout: 5000 }
      );
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
      execSync(
        `adb -s ${deviceId} shell rm -f /data/local/tmp/http-freekit-ca.pem`,
        { stdio: 'ignore', timeout: 5000 }
      );
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

    // For physical devices, find the host machine's LAN IP
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }

    return '127.0.0.1';
  }

  async activate(proxyPort, options = {}) {
    const { deviceId } = options;

    if (!deviceId) {
      // No specific device — return metadata with device list for UI selection
      const devices = this._getConnectedDevices();
      this.active = true;
      return {
        success: true,
        metadata: {
          devices,
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

    // Push CA certificate
    const remoteCertPath = this._pushCaCert(deviceId);

    // Set proxy
    const proxySet = this._setProxy(deviceId, hostIp, proxyPort);

    if (!proxySet) {
      return { success: false, error: `Failed to set proxy on ${deviceId}` };
    }

    this.activatedDevices.set(deviceId, {
      model: device.model,
      deviceName: device.deviceName,
      hostIp,
      remoteCertPath
    });
    this.active = true;

    console.log(`[Interceptor] Android ADB interceptor activated for ${deviceId} (${device.model})`);

    return {
      success: true,
      metadata: {
        deviceId,
        model: device.model,
        proxyUrl: `http://${hostIp}:${proxyPort}`,
        certPushed: !!remoteCertPath,
        certInstallNote: remoteCertPath
          ? 'CA certificate pushed to device. Install it via Settings > Security > Install from storage > /data/local/tmp/http-freekit-ca.pem'
          : 'No CA certificate available. HTTPS interception will show certificate warnings.',
        devices: this._getConnectedDevices()
      }
    };
  }

  async deactivate(options = {}) {
    const { deviceId } = options;

    if (deviceId) {
      // Deactivate a specific device
      this._clearProxy(deviceId);
      this._removeCaCert(deviceId);
      this.activatedDevices.delete(deviceId);
      console.log(`[Interceptor] Android ADB interceptor deactivated for ${deviceId}`);
    } else {
      // Deactivate all devices
      for (const [serial] of this.activatedDevices) {
        this._clearProxy(serial);
        this._removeCaCert(serial);
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
