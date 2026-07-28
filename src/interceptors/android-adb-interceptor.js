import fs from 'fs';
import os from 'os';
import path from 'path';
import QRCode from 'qrcode';
import { execFileAsync } from './command-runner.js';
import {
  PROXY_BIND_UNREACHABLE_ERROR_CODE,
  canAdvertisedHostReachProxy,
  classifyProxyBindHost,
  createProxyBindUnreachableError
} from './proxy-bind-reachability.js';

const HTTP_TOOLKIT_ANDROID_PACKAGE = 'tech.httptoolkit.android.v1';
const HTTP_TOOLKIT_ANDROID_ACTIVATE = 'tech.httptoolkit.android.ACTIVATE';
const HTTP_TOOLKIT_ANDROID_DEACTIVATE = 'tech.httptoolkit.android.DEACTIVATE';
const HTTP_TOOLKIT_ANDROID_CONNECT_URL = 'https://android.httptoolkit.tech/connect/';
const EMULATOR_HOST_IPS = ['10.0.2.2', '10.0.3.2'];
const ANDROID_CA_STAGING_PATH = '/data/local/tmp/http-freekit-ca.pem';
const ANDROID_LEGACY_RECOVERY_VERSION = 1;
const ANDROID_REVERSE_RECOVERY_VERSION = 2;
const ANDROID_UNCERTAIN_RECOVERY_VERSION = 3;
const ANDROID_COMPANION_RECOVERY_VERSION = 4;
const ANDROID_RECOVERY_VERSION = 5;
const MAX_ANDROID_RECOVERY_BYTES = 128 * 1024;
const ANDROID_INTERCEPTING_MODES = new Set(['global-proxy', 'http-toolkit-app']);
const ANDROID_CLEANUP_MODES = new Set(['staging-cleanup', 'reverse-cleanup']);

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

function reportsMissingHttpToolkitPackage(output) {
  const escapedPackage = HTTP_TOOLKIT_ANDROID_PACKAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const text = String(output || '');
  return new RegExp(
    `(?:package\\s+${escapedPackage}\\s+(?:was\\s+)?not\\s+found|unknown\\s+package:?\\s*${escapedPackage})`,
    'i'
  ).test(text);
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

function createHostIpSelectionError(candidates) {
  const error = new Error(
    `Multiple host adapters can reach the Android device; select a host IP (${candidates.map(candidate => candidate.address).join(', ')})`
  );
  error.code = 'ANDROID_HOST_IP_SELECTION_REQUIRED';
  error.hostIpCandidates = candidates;
  return error;
}

export class AndroidAdbInterceptor {
  constructor(options = {}) {
    this.id = 'android-adb';
    this.name = 'Android Device (ADB)';
    this.active = false;
    this.ca = null;
    this.activatedDevices = new Map(); // deviceId -> { serial, model }
    this.reverseTunnels = new Set(); // `${deviceId}:${proxyPort}`
    this.previousReverseMappings = new Map(); // `${deviceId}:${proxyPort}` -> prior remote endpoint or null
    this.proxyBindHost = options.proxyBindHost || null;
    this.recoveryFile = options.dataDir
      ? path.join(options.dataDir, 'android-adb-global-proxy-recovery.json')
      : options.recoveryFile || null;
    this.journaledGlobalDevices = new Map();
    this._adoptJournaledGlobalDevices();
  }

  _isSafeJournalString(value, maxLength = 2048) {
    return typeof value === 'string' && value.length <= maxLength && !/[\0\r\n]/.test(value);
  }

  _isSafeReverseEndpoint(value) {
    if (!this._isSafeJournalString(value, 1024) || /\s/.test(value)) return false;
    const tcpMatch = value.match(/^tcp:(\d{1,5})$/);
    if (tcpMatch) {
      const port = Number(tcpMatch[1]);
      return port >= 1 && port <= 65535;
    }
    const jdwpMatch = value.match(/^jdwp:(\d{1,10})$/);
    if (jdwpMatch) return Number(jdwpMatch[1]) <= 0xffffffff;
    const vsockMatch = value.match(/^vsock:(\d{1,10}):(\d{1,5})$/);
    if (vsockMatch) {
      return Number(vsockMatch[1]) <= 0xffffffff &&
        Number(vsockMatch[2]) >= 1 && Number(vsockMatch[2]) <= 65535;
    }
    return /^(?:localabstract|localreserved|localfilesystem|dev):[^\s]{1,1000}$/.test(value);
  }

  _normalizeJournalDevice(entry, version = ANDROID_RECOVERY_VERSION) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const allowedModes = version >= ANDROID_COMPANION_RECOVERY_VERSION
      ? [
          'global-proxy', 'proxy-uncertain', 'staging-cleanup',
          'reverse-cleanup', 'app-uncertain', 'http-toolkit-app'
        ]
      : version === ANDROID_UNCERTAIN_RECOVERY_VERSION
        ? ['global-proxy', 'proxy-uncertain', 'staging-cleanup', 'reverse-cleanup', 'app-uncertain']
        : version === ANDROID_REVERSE_RECOVERY_VERSION
        ? ['global-proxy', 'proxy-uncertain', 'staging-cleanup', 'reverse-cleanup']
        : ['global-proxy', 'staging-cleanup'];
    if (!allowedModes.includes(entry.mode)) return null;
    const reverseOnly = entry.mode === 'reverse-cleanup';
    const appOnly = entry.mode === 'app-uncertain' || entry.mode === 'http-toolkit-app';
    const allowedFields = new Set(reverseOnly || appOnly
      ? [
          'serial', 'mode', 'proxyPort', 'previousReverseMapping', 'model', 'deviceName',
          ...(appOnly && version >= ANDROID_RECOVERY_VERSION ? ['vpnStatusConfirmed'] : [])
        ]
      : [
          'serial', 'mode', 'previousProxy', 'hostIp', 'proxyPort',
          'remoteCertPath', 'model', 'deviceName',
          ...(version >= ANDROID_REVERSE_RECOVERY_VERSION ? ['previousReverseMapping'] : [])
        ]);
    if (Object.keys(entry).some(field => !allowedFields.has(field))) return null;
    if (!this._isSafeJournalString(entry.serial, 255) ||
        !/^(?!-)[A-Za-z0-9._:[\]-]+$/.test(entry.serial)) return null;
    if (!Number.isInteger(entry.proxyPort) || entry.proxyPort < 1 || entry.proxyPort > 65535) return null;
    for (const field of ['model', 'deviceName']) {
      if (entry[field] !== undefined && !this._isSafeJournalString(entry[field], 512)) return null;
    }
    const hasReverseCleanup = Object.prototype.hasOwnProperty.call(entry, 'previousReverseMapping');
    const hasVpnConfirmation = Object.prototype.hasOwnProperty.call(entry, 'vpnStatusConfirmed');
    if ((reverseOnly || (appOnly && version < ANDROID_COMPANION_RECOVERY_VERSION)) &&
        !hasReverseCleanup) return null;
    if (hasReverseCleanup && entry.previousReverseMapping !== null &&
        !this._isSafeReverseEndpoint(entry.previousReverseMapping)) return null;
    if (appOnly && version >= ANDROID_RECOVERY_VERSION &&
        (!hasVpnConfirmation || typeof entry.vpnStatusConfirmed !== 'boolean')) return null;
    if (reverseOnly || appOnly) {
      return {
        serial: entry.serial,
        mode: entry.mode,
        proxyPort: entry.proxyPort,
        ...(hasReverseCleanup ? { previousReverseMapping: entry.previousReverseMapping } : {}),
        ...(entry.model !== undefined ? { model: entry.model } : {}),
        ...(entry.deviceName !== undefined ? { deviceName: entry.deviceName } : {}),
        ...(hasVpnConfirmation ? { vpnStatusConfirmed: entry.vpnStatusConfirmed } : {})
      };
    }
    if (!this._isSafeJournalString(entry.previousProxy)) return null;
    if (ipv4ToInteger(entry.hostIp) === null) return null;
    if (entry.remoteCertPath !== ANDROID_CA_STAGING_PATH) return null;
    return {
      serial: entry.serial,
      mode: entry.mode,
      previousProxy: entry.previousProxy,
      hostIp: entry.hostIp,
      proxyPort: entry.proxyPort,
      remoteCertPath: entry.remoteCertPath,
      ...(entry.model !== undefined ? { model: entry.model } : {}),
      ...(entry.deviceName !== undefined ? { deviceName: entry.deviceName } : {}),
      ...(hasReverseCleanup ? { previousReverseMapping: entry.previousReverseMapping } : {})
    };
  }

  _adoptJournaledGlobalDevices() {
    if (!this.recoveryFile || !fs.existsSync(this.recoveryFile)) return;
    try {
      const stats = fs.lstatSync(this.recoveryFile);
      if (!stats.isFile() || stats.size > MAX_ANDROID_RECOVERY_BYTES) {
        throw new Error('Recovery journal is not a trusted regular file');
      }
      const parsed = JSON.parse(fs.readFileSync(this.recoveryFile, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
          ![
            ANDROID_LEGACY_RECOVERY_VERSION,
            ANDROID_REVERSE_RECOVERY_VERSION,
            ANDROID_UNCERTAIN_RECOVERY_VERSION,
            ANDROID_COMPANION_RECOVERY_VERSION,
            ANDROID_RECOVERY_VERSION
          ].includes(parsed.version) ||
          !Array.isArray(parsed.devices) ||
          parsed.devices.length > 128 ||
          Object.keys(parsed).some(field => !['version', 'devices'].includes(field))) {
        throw new Error('Recovery journal has an invalid schema');
      }

      const adopted = new Map();
      for (const rawEntry of parsed.devices) {
        const entry = this._normalizeJournalDevice(rawEntry, parsed.version);
        if (!entry || adopted.has(entry.serial)) {
          throw new Error('Recovery journal contains an invalid device entry');
        }
        adopted.set(entry.serial, entry);
      }
      if (adopted.size === 0) throw new Error('Recovery journal contains no devices');

      this.journaledGlobalDevices = adopted;
      for (const [serial, entry] of adopted) {
        const proxyStillReachable = entry.mode !== 'global-proxy' ||
          this._isProxyHostReachable(entry.hostIp);
        this.activatedDevices.set(serial, {
          ...entry,
          ...((entry.mode === 'app-uncertain' || entry.mode === 'http-toolkit-app')
            ? {
                vpnStatusConfirmed: entry.vpnStatusConfirmed === true ||
                  entry.mode === 'http-toolkit-app'
              }
            : {}),
          ...(proxyStillReachable
            ? {}
            : {
                mode: 'proxy-uncertain',
                proxyBindError: this._proxyBindError(
                  'Recovered Android global proxy',
                  entry.hostIp
                ).message
              }),
          recovered: true
        });
        if (Object.prototype.hasOwnProperty.call(entry, 'previousReverseMapping')) {
          const key = `${serial}:${entry.proxyPort}`;
          this.reverseTunnels.add(key);
          this.previousReverseMappings.set(key, entry.previousReverseMapping);
        }
      }
      this.active = true;
    } catch (err) {
      console.warn('[Interceptor] Ignoring invalid Android recovery journal:', err.message);
    }
  }

  _writeGlobalProxyJournal(devices) {
    if (!this.recoveryFile) return;
    if (devices.size === 0) {
      try {
        fs.unlinkSync(this.recoveryFile);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      return;
    }

    fs.mkdirSync(path.dirname(this.recoveryFile), { recursive: true });
    const tempPath = path.join(
      path.dirname(this.recoveryFile),
      `.${path.basename(this.recoveryFile)}.${process.pid}.${Date.now()}.tmp`
    );
    const payload = {
      version: ANDROID_RECOVERY_VERSION,
      devices: Array.from(devices.values())
    };
    try {
      fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
        flush: true
      });
      fs.renameSync(tempPath, this.recoveryFile);
    } catch (err) {
      try { fs.unlinkSync(tempPath); } catch {}
      throw err;
    }
  }

  _journalEntry(serial, activeInfo) {
    const identity = {
      ...(this._isSafeJournalString(activeInfo.model, 512) ? { model: activeInfo.model } : {}),
      ...(this._isSafeJournalString(activeInfo.deviceName, 512)
        ? { deviceName: activeInfo.deviceName }
        : {})
    };
    if (activeInfo.mode === 'reverse-cleanup' || activeInfo.mode === 'app-uncertain' ||
        activeInfo.mode === 'http-toolkit-app') {
      return {
        serial,
        mode: activeInfo.mode,
        proxyPort: activeInfo.proxyPort,
        ...(Object.prototype.hasOwnProperty.call(activeInfo, 'previousReverseMapping')
          ? { previousReverseMapping: activeInfo.previousReverseMapping }
          : {}),
        ...((activeInfo.mode === 'app-uncertain' || activeInfo.mode === 'http-toolkit-app')
          ? { vpnStatusConfirmed: activeInfo.vpnStatusConfirmed === true }
          : {}),
        ...identity
      };
    }
    return {
      serial,
      mode: activeInfo.mode,
      previousProxy: activeInfo.previousProxy,
      hostIp: activeInfo.hostIp,
      proxyPort: activeInfo.proxyPort,
      remoteCertPath: ANDROID_CA_STAGING_PATH,
      ...identity,
      ...(Object.prototype.hasOwnProperty.call(activeInfo, 'previousReverseMapping')
        ? { previousReverseMapping: activeInfo.previousReverseMapping }
        : {})
    };
  }

  _rememberGlobalProxyOwnership(serial, activeInfo) {
    const entry = this._journalEntry(serial, activeInfo);
    if (!this._normalizeJournalDevice(entry)) {
      throw new Error('Refusing to persist invalid Android cleanup ownership');
    }
    const next = new Map(this.journaledGlobalDevices);
    next.set(serial, entry);
    this._writeGlobalProxyJournal(next);
    this.journaledGlobalDevices = next;
  }

  _forgetGlobalProxyOwnership(serial) {
    if (!this.journaledGlobalDevices.has(serial)) return;
    const next = new Map(this.journaledGlobalDevices);
    next.delete(serial);
    this._writeGlobalProxyJournal(next);
    this.journaledGlobalDevices = next;
  }

  async isActivable() {
    return true;
  }

  async isActive() {
    if (!this.active || this.activatedDevices.size === 0) return false;
    await this._reconcileActivationStatus();
    this.active = this.activatedDevices.size > 0;
    return this.active;
  }

  async _reconcileActivationStatus() {
    if (this.activationStatusReconciliation) {
      return await this.activationStatusReconciliation;
    }

    const hasStatusToCheck = Array.from(this.activatedDevices.values()).some(info =>
      ANDROID_INTERCEPTING_MODES.has(info?.mode) ||
      info?.mode === 'proxy-uncertain' ||
      info?.mode === 'app-uncertain'
    );
    if (!hasStatusToCheck) return;

    const reconciliation = this._performActivationStatusReconciliation();
    this.activationStatusReconciliation = reconciliation;
    try {
      await reconciliation;
      this.active = this.activatedDevices.size > 0;
    } finally {
      if (this.activationStatusReconciliation === reconciliation) {
        this.activationStatusReconciliation = null;
      }
    }
  }

  async _performActivationStatusReconciliation() {
    const connectedDevices = new Map(
      (await this._getConnectedDevices())
        .filter(device => device.status === 'device')
        .map(device => [device.serial, device])
    );

    for (const [serial, activeInfo] of Array.from(this.activatedDevices.entries())) {
      if (!ANDROID_INTERCEPTING_MODES.has(activeInfo?.mode) &&
          activeInfo?.mode !== 'proxy-uncertain' &&
          activeInfo?.mode !== 'app-uncertain') continue;

      const isGlobalProxy = activeInfo.mode === 'global-proxy' ||
        activeInfo.mode === 'proxy-uncertain';
      if (!connectedDevices.has(serial)) {
        this._setUncertainActivation(serial, activeInfo, isGlobalProxy
          ? 'proxy-uncertain'
          : 'app-uncertain');
        continue;
      }

      if (isGlobalProxy) {
        await this._reconcileGlobalProxyActivation(serial, activeInfo);
      } else {
        await this._reconcileCompanionActivation(serial, activeInfo);
      }
    }
  }

  _setUncertainActivation(serial, activeInfo, mode) {
    if (activeInfo.mode === mode) {
      this.activatedDevices.set(serial, activeInfo);
      return;
    }
    const uncertainInfo = { ...activeInfo, mode };
    try {
      this._rememberGlobalProxyOwnership(serial, uncertainInfo);
    } catch (err) {
      // The existing ownership record is still sufficient for cleanup after a
      // restart. In memory, fail closed so a status refresh never claims that
      // an unverified interception is live.
      console.warn(`[Interceptor] Failed to persist reconciled Android status for ${serial}:`, err.message);
    }
    this.activatedDevices.set(serial, uncertainInfo);
  }

  _setPersistedActivation(serial, activeInfo, mode) {
    const nextInfo = { ...activeInfo, mode };
    try {
      this._rememberGlobalProxyOwnership(serial, nextInfo);
    } catch (err) {
      console.warn(`[Interceptor] Failed to persist reconciled Android status for ${serial}:`, err.message);
      return false;
    }
    this.activatedDevices.set(serial, nextInfo);
    return true;
  }

  _clearInactiveCompanion(serial, activeInfo) {
    const key = `${serial}:${activeInfo.proxyPort}`;
    const ownsReverseTunnel = this.reverseTunnels.has(key) ||
      Object.prototype.hasOwnProperty.call(activeInfo, 'previousReverseMapping');
    if (ownsReverseTunnel) {
      return this._setPersistedActivation(serial, activeInfo, 'reverse-cleanup');
    }

    try {
      this._forgetGlobalProxyOwnership(serial);
    } catch (err) {
      console.warn(`[Interceptor] Failed to clear reconciled Android status for ${serial}:`, err.message);
      this._setUncertainActivation(serial, activeInfo, 'app-uncertain');
      return false;
    }
    this.activatedDevices.delete(serial);
    return true;
  }

  async _reconcileGlobalProxyActivation(serial, activeInfo) {
    const ownedProxy = ipv4ToInteger(activeInfo.hostIp) !== null &&
      Number.isInteger(activeInfo.proxyPort) &&
      activeInfo.proxyPort >= 1 && activeInfo.proxyPort <= 65535
      ? `${activeInfo.hostIp}:${activeInfo.proxyPort}`
      : null;
    const currentProxy = await this._getProxy(serial);
    if (!ownedProxy || currentProxy?.success !== true ||
        !this._isSafeJournalString(currentProxy.value)) {
      this._setUncertainActivation(serial, activeInfo, 'proxy-uncertain');
      return;
    }

    if (currentProxy.value === ownedProxy) {
      if (activeInfo.mode !== 'global-proxy') {
        this._setPersistedActivation(serial, activeInfo, 'global-proxy');
      }
      return;
    }

    // The proxy was conclusively replaced by somebody else. Preserve that
    // setting and retain only the certificate/tunnel cleanup still owned here.
    this._setPersistedActivation(serial, activeInfo, 'staging-cleanup');
  }

  _parseHttpToolkitVpnStatus(output, { authoritative = false } = {}) {
    const text = String(output || '').trim();
    if (!text) return null;
    const boundaryPattern = /^[ \t]*(?:User\s+\d+\s*:|Active package name\s*:|mPackage\s*=)/gim;
    const boundaries = [...text.matchAll(boundaryPattern)];
    const packageRecords = [];

    for (let index = 0; index < boundaries.length; index++) {
      const start = boundaries[index].index;
      const markerLineEnd = text.indexOf('\n', start);
      const markerLine = text.slice(start, markerLineEnd === -1 ? text.length : markerLineEnd);
      const packageMatch = markerLine.match(
        /(?:Active package name\s*:\s*|mPackage\s*=\s*)([^\r\n]+)/i
      );
      if (!packageMatch || packageMatch[1].trim().replace(/^["']|["']$/g, '') !==
          HTTP_TOOLKIT_ANDROID_PACKAGE) continue;

      const end = boundaries[index + 1]?.index ?? text.length;
      packageRecords.push(text.slice(start, end));
    }

    if (packageRecords.length === 0) {
      const escapedPackage = HTTP_TOOLKIT_ANDROID_PACKAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(?:^|[^A-Za-z0-9._])${escapedPackage}(?=$|[^A-Za-z0-9._])`).test(text)) {
        // Older vpn_management dumps list only "<user>: <package>" without a
        // detailed status block. Presence there is not proof of either a live
        // or stopped VPN, so let connectivity provide the detailed fallback.
        return null;
      }
      return authoritative && /(?:^|\n)\s*(?:VPNs?\s*:|User\s+\d+\s*:|mPackage\s*=|Active package name\s*:)/im.test(text)
        ? false
        : null;
    }

    const statuses = packageRecords.map(record => {
      const activeType = record.match(/\bActive vpn type\s*:\s*([^\s\r\n]+)/i)?.[1];
      if (activeType !== undefined) {
        return /^(?:0|-1|TYPE_VPN_NONE|none)$/i.test(activeType) ? false : true;
      }
      if (/\bstate\s*:\s*(?:DISCONNECTED|IDLE|FAILED)\b/i.test(record)) return false;
      if (/\bstate\s*:\s*CONNECTED(?:\/CONNECTED)?\b/i.test(record) ||
          /\bmNetworkInfo\s*=\s*\[[^\]\r\n]*\bCONNECTED(?:\/CONNECTED)?\b/i.test(record)) {
        return true;
      }
      if (/\bmNetworkAgent\s*=\s*null\b/i.test(record)) return false;
      if (/\bmNetworkAgent\s*=\s*\S+/i.test(record)) return true;
      return null;
    });
    return statuses.every(status => status === statuses[0]) ? statuses[0] : null;
  }

  async _getHttpToolkitVpnStatus(deviceId) {
    try {
      const output = await this._adb(
        deviceId,
        ['shell', 'dumpsys', 'vpn_management'],
        { timeout: 5000 }
      );
      const value = this._parseHttpToolkitVpnStatus(output, { authoritative: true });
      if (value !== null) return { success: true, value };
    } catch {
      // Older Android versions do not expose vpn_management. Connectivity can
      // still positively identify an active companion VPN on those releases.
    }

    try {
      const output = await this._adb(
        deviceId,
        ['shell', 'dumpsys', 'connectivity'],
        { timeout: 5000 }
      );
      const value = this._parseHttpToolkitVpnStatus(output);
      return value === null
        ? { success: false, error: 'Android VPN state was not reported' }
        : { success: true, value };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async _reconcileCompanionActivation(serial, activeInfo) {
    let appInstalled;
    try {
      appInstalled = await this._queryHttpToolkitAppInstalled(serial);
    } catch {
      this._setUncertainActivation(serial, activeInfo, 'app-uncertain');
      return;
    }
    if (!appInstalled) {
      this._clearInactiveCompanion(serial, activeInfo);
      return;
    }

    const vpnStatus = await this._getHttpToolkitVpnStatus(serial);
    if (vpnStatus?.success !== true) {
      this._setUncertainActivation(serial, activeInfo, 'app-uncertain');
      return;
    }
    if (!vpnStatus.value) {
      if (activeInfo.vpnStatusConfirmed === true) {
        this._clearInactiveCompanion(serial, activeInfo);
      } else {
        // ACTIVATE launches an activity before the user accepts Android's VPN
        // prompt. Until this process has observed a live VPN, an inactive
        // readback is pending/ambiguous rather than a confirmed later stop.
        this._setUncertainActivation(serial, activeInfo, 'app-uncertain');
      }
      return;
    }

    const confirmedInfo = { ...activeInfo, vpnStatusConfirmed: true };
    const key = `${serial}:${activeInfo.proxyPort}`;
    const ownsReverseTunnel = this.reverseTunnels.has(key) ||
      Object.prototype.hasOwnProperty.call(activeInfo, 'previousReverseMapping');
    if (ownsReverseTunnel) {
      try {
        const currentMapping = await this._getReverseMapping(serial, activeInfo.proxyPort);
        if (currentMapping !== `tcp:${activeInfo.proxyPort}`) {
          this._setUncertainActivation(serial, confirmedInfo, 'app-uncertain');
          return;
        }
      } catch {
        this._setUncertainActivation(serial, confirmedInfo, 'app-uncertain');
        return;
      }
    }

    if (activeInfo.mode !== 'http-toolkit-app') {
      this._setPersistedActivation(serial, confirmedInfo, 'http-toolkit-app');
    } else {
      this.activatedDevices.set(serial, confirmedInfo);
    }
  }

  _isProxyHostReachable(host) {
    const bind = classifyProxyBindHost(this.proxyBindHost);
    if (EMULATOR_HOST_IPS.includes(host) && bind.host === '127.0.0.1') {
      // Android Emulator and Genymotion route these special aliases to the
      // host's IPv4 loopback interface rather than to a normal host adapter.
      return true;
    }
    return canAdvertisedHostReachProxy(this.proxyBindHost, host);
  }

  _proxyBindError(feature, advertisedHost) {
    return createProxyBindUnreachableError(feature, this.proxyBindHost, advertisedHost);
  }

  _assertProxyHostReachable(feature, host) {
    if (!this._isProxyHostReachable(host)) throw this._proxyBindError(feature, host);
    return host;
  }

  _canAdbReverseReachProxy() {
    // ADB reverse connects back to the host's IPv4 loopback endpoint. A
    // successfully installed mapping is not a usable route when the proxy is
    // bound only to a different local address.
    return canAdvertisedHostReachProxy(this.proxyBindHost, '127.0.0.1');
  }

  _usesAndroidEmulatorHostAliases(deviceId) {
    // ADB only identifies the built-in emulator deterministically with this
    // serial format. TCP and vendor serials can also belong to physical
    // devices, so conservatively require ADB reverse or a normal host address.
    return /^emulator-\d+$/.test(String(deviceId));
  }

  _getInterceptionSummary() {
    let interceptionDeviceCount = 0;
    let uncertainDeviceCount = 0;
    let cleanupDeviceCount = 0;

    for (const info of this.activatedDevices.values()) {
      if (ANDROID_INTERCEPTING_MODES.has(info?.mode)) {
        interceptionDeviceCount++;
      } else if (ANDROID_CLEANUP_MODES.has(info?.mode)) {
        cleanupDeviceCount++;
      } else {
        // Known uncertain modes, and any future state not yet understood by an
        // older renderer, must never be presented as definitely intercepting.
        uncertainDeviceCount++;
      }
    }

    return {
      interceptionActive: interceptionDeviceCount > 0,
      interceptionDeviceCount,
      activationUncertain: uncertainDeviceCount > 0,
      uncertainDeviceCount,
      cleanupPending: cleanupDeviceCount > 0,
      cleanupDeviceCount
    };
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
    await this._reconcileActivationStatus();
    const devices = await this._getConnectedDevicesWithHostIpMetadata();
    return {
      devices,
      activatedDevices: Array.from(this.activatedDevices.entries()).map(([serial, info]) => ({
        serial,
        ...info
      })),
      ...this._getInterceptionSummary(),
      httpToolkitAppPackage: HTTP_TOOLKIT_ANDROID_PACKAGE,
      prefersHttpToolkitApp: true
    };
  }

  async _getConnectedDevicesWithHostIpMetadata() {
    const devices = await this._getConnectedDevices();
    return await Promise.all(devices.map(async device => {
      if (device.status !== 'device' || device.serial.startsWith('emulator-')) return device;

      let appInstalled;
      try {
        appInstalled = await this._queryHttpToolkitAppInstalled(device.serial);
      } catch {
        // Do not ask for fallback configuration when the preferred app path
        // could not be checked. Activation will return structured choices if
        // it eventually needs the global-proxy fallback.
        return device;
      }
      if (appInstalled) {
        return { ...device, httpToolkitAppInstalled: true };
      }

      try {
        const discoveredCandidates = await this._getReachableHostIpCandidates(device.serial);
        const hostIpCandidates = discoveredCandidates.filter(
          candidate => this._isProxyHostReachable(candidate.address)
        );
        if (discoveredCandidates.length > 0 && hostIpCandidates.length === 0) {
          return {
            ...device,
            httpToolkitAppInstalled: false,
            hostIpCandidates: [],
            requiresHostIpSelection: false,
            globalProxyAvailable: false,
            globalProxyError: this._proxyBindError(
              'Android global proxy setup',
              discoveredCandidates[0].address
            ).message
          };
        }
        return {
          ...device,
          httpToolkitAppInstalled: false,
          hostIpCandidates,
          requiresHostIpSelection: hostIpCandidates.length > 1
        };
      } catch {
        return { ...device, httpToolkitAppInstalled: false };
      }
    }));
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

  async _queryHttpToolkitAppInstalled(deviceId) {
    try {
      const output = await this._adb(
        deviceId,
        ['shell', 'pm', 'path', HTTP_TOOLKIT_ANDROID_PACKAGE],
        { timeout: 5000 }
      );
      const packageOutput = String(output || '').trim();
      if (!packageOutput || reportsMissingHttpToolkitPackage(packageOutput)) return false;
      if (packageOutput.split(/\r?\n/).some(line => /^package:\S+\s*$/.test(line.trim()))) {
        return true;
      }
      throw new Error(`Unexpected package query response for ${HTTP_TOOLKIT_ANDROID_PACKAGE}`);
    } catch (err) {
      const errorOutput = [err?.stdout, err?.stderr, err?.message]
        .filter(value => value !== undefined && value !== null)
        .join('\n');
      if (reportsMissingHttpToolkitPackage(errorOutput)) return false;
      throw err;
    }
  }

  async _isHttpToolkitAppInstalled(deviceId, options = {}) {
    try {
      return await this._queryHttpToolkitAppInstalled(deviceId);
    } catch (err) {
      if (options.requireConfirmedResult) throw err;
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

  async _getReverseMapping(deviceId, proxyPort) {
    const localEndpoint = `tcp:${proxyPort}`;
    const reverseList = await this._adb(deviceId, ['reverse', '--list'], { timeout: 5000 });
    return String(reverseList || '')
      .split(/\r?\n/)
      .map(line => line.trim().split(/\s+/))
      .find(parts => parts.length >= 2 && parts.at(-2) === localEndpoint)
      ?.at(-1) || null;
  }

  async _createReverseTunnel(deviceId, proxyPort, preparedPreviousMapping) {
    const localEndpoint = `tcp:${proxyPort}`;
    const key = `${deviceId}:${proxyPort}`;

    if (this.reverseTunnels.has(key)) return true;

    let previousMapping;
    let writeAttempted = false;
    try {
      previousMapping = preparedPreviousMapping === undefined
        ? await this._getReverseMapping(deviceId, proxyPort)
        : preparedPreviousMapping;

      if (previousMapping !== localEndpoint) {
        const createArgs = previousMapping === null
          ? ['reverse', '--no-rebind', localEndpoint, localEndpoint]
          : ['reverse', localEndpoint, localEndpoint];
        writeAttempted = true;
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
      if (writeAttempted) {
        try {
          const currentMapping = await this._getReverseMapping(deviceId, proxyPort);
          if (currentMapping === localEndpoint) {
            this.previousReverseMappings.set(key, previousMapping);
            this.reverseTunnels.add(key);
            console.warn(`[Interceptor] ADB reverse result was uncertain on ${deviceId}, but readback confirmed ${localEndpoint}`);
            return true;
          }
          if (currentMapping !== previousMapping) {
            console.warn(`[Interceptor] ADB reverse changed externally on ${deviceId}; preserving ${currentMapping}`);
          }
        } catch {
          // The prepared prior mapping makes this possible mutation safe to
          // own even if a disconnect prevents immediate readback.
          this.previousReverseMappings.set(key, previousMapping);
          this.reverseTunnels.add(key);
          console.warn(`[Interceptor] ADB reverse result is uncertain on ${deviceId}; retaining cleanup ownership`);
          return true;
        }
      }
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
        const currentMapping = await this._getReverseMapping(deviceId, proxyPort);
        if (currentMapping !== localEndpoint) {
          console.warn(
            `[Interceptor] ADB reverse changed externally on ${deviceId}; preserving ${currentMapping || 'no mapping'}`
          );
          this.previousReverseMappings.delete(key);
          this.reverseTunnels.delete(key);
          return true;
        }
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

  _buildHttpToolkitConnectUrl(
    proxyPort,
    addresses = [...EMULATOR_HOST_IPS, ...this._getHostIps()]
  ) {
    const certInfo = this.ca?.getCertInfo?.();
    const setupParams = {
      addresses,
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

  _getReachableRemoteProxyAddresses({ includeEmulatorAliases = true } = {}) {
    return [
      ...(includeEmulatorAliases ? EMULATOR_HOST_IPS : []),
      ...this._getHostIps()
    ]
      .filter(address => this._isProxyHostReachable(address));
  }

  async _getQrMetadata(proxyPort) {
    if (!this.ca?.getCertInfo?.()?.certificateSpkiFingerprint) {
      return {
        qrAvailable: false,
        qrError: 'CA certificate is not available for QR setup'
      };
    }

    const emulatorAddresses = EMULATOR_HOST_IPS.filter(
      address => this._isProxyHostReachable(address)
    );
    const hostAddresses = this._getHostIps().filter(
      address => this._isProxyHostReachable(address)
    );
    const qrAddresses = [...emulatorAddresses, ...hostAddresses];
    if (qrAddresses.length === 0) {
      return {
        qrAvailable: false,
        qrError: this._proxyBindError('Android QR setup').message
      };
    }

    const connectUrl = this._buildHttpToolkitConnectUrl(proxyPort, qrAddresses);
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
      qrImageDataUrl,
      ...(hostAddresses.length === 0 && emulatorAddresses.length > 0
        ? {
            qrAvailabilityScope: 'emulator-only',
            qrAvailabilityNote: 'This QR code is reachable only from an Android emulator through its host-loopback alias. Physical devices require a remotely bound proxy.'
          }
        : {})
    };
  }

  async _prepareHttpToolkitAppActivation(deviceId, proxyPort, options = {}) {
    if (!this.ca?.getCertInfo?.()?.certificateSpkiFingerprint) {
      return { success: false, error: 'CA certificate is not available for HTTP Toolkit Android app setup' };
    }

    if (!await this._isHttpToolkitAppInstalled(deviceId, {
      requireConfirmedResult: options.requireConfirmedPrerequisites === true
    })) {
      return {
        success: false,
        error: `HTTP Toolkit Android app is not installed (${HTTP_TOOLKIT_ANDROID_PACKAGE})`,
        appInstalled: false
      };
    }

    const preparation = {
      success: true,
      appInstalled: true,
      connectUrl: this._buildHttpToolkitConnectUrl(
        proxyPort,
        this._getReachableRemoteProxyAddresses({
          includeEmulatorAliases: this._usesAndroidEmulatorHostAliases(deviceId)
        })
      )
    };
    if (options.prepareReverseMapping) {
      preparation.previousReverseMapping = await this._getReverseMapping(deviceId, proxyPort);
    }
    return preparation;
  }

  async _activateHttpToolkitApp(deviceId, proxyPort, preparedActivation = null) {
    const preparation = preparedActivation ||
      await this._prepareHttpToolkitAppActivation(deviceId, proxyPort);
    if (!preparation.success) return preparation;

    const tunnelActive = await this._createReverseTunnel(
      deviceId,
      proxyPort,
      preparation.previousReverseMapping
    );
    const { connectUrl } = preparation;
    const remotelyReachable = this._getReachableRemoteProxyAddresses({
      includeEmulatorAliases: this._usesAndroidEmulatorHostAliases(deviceId)
    });
    if ((!tunnelActive || !this._canAdbReverseReachProxy()) && remotelyReachable.length === 0) {
      return {
        success: false,
        error: this._proxyBindError(
          tunnelActive
            ? 'Android companion setup through an ADB reverse tunnel'
            : 'Android companion setup without an ADB reverse tunnel'
        ).message,
        appInstalled: true,
        tunnelActive,
        activationIntentAttempted: false,
        ...(tunnelActive
          ? {
              previousReverseMapping: this.previousReverseMappings.get(
                `${deviceId}:${proxyPort}`
              )
            }
          : {})
      };
    }

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
        activationIntentAttempted: true,
        connectUrl
      };
    } catch (err) {
      const key = `${deviceId}:${proxyPort}`;
      return {
        success: false,
        error: err.message,
        appInstalled: true,
        tunnelActive,
        activationIntentAttempted: true,
        ...(tunnelActive
          ? { previousReverseMapping: this.previousReverseMappings.get(key) }
          : {})
      };
    }
  }

  async _prepareGlobalProxyActivation(deviceId, requestedHostIp) {
    const hostIp = await this._getHostIp(deviceId, requestedHostIp);
    const currentProxy = await this._getProxy(deviceId);
    if (currentProxy?.success !== true) {
      return {
        success: false,
        error: `Failed to read existing proxy on ${deviceId}: ${currentProxy?.error || 'unknown error'}`
      };
    }
    if (!this._isSafeJournalString(currentProxy.value)) {
      return {
        success: false,
        error: `Failed to read an unambiguous existing proxy on ${deviceId}`
      };
    }
    return { success: true, hostIp };
  }

  async _deactivateHttpToolkitApp(deviceId, proxyPort) {
    let appDeactivated;
    try {
      const appInstalled = await this._isHttpToolkitAppInstalled(deviceId, {
        requireConfirmedResult: true
      });
      appDeactivated = !appInstalled;
      if (appInstalled) {
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
    const remotePath = ANDROID_CA_STAGING_PATH;

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
   * Restore the global HTTP proxy value that existed before activation, but
   * only while the device still has the exact proxy value owned by FreeKit.
   */
  async _restoreProxy(deviceId, previousProxy, ownedProxy) {
    if (!this._isSafeJournalString(ownedProxy) || ownedProxy.length === 0) {
      console.error(`[Interceptor] Cannot verify proxy ownership on ${deviceId}: owned proxy is unavailable`);
      return false;
    }

    const currentProxy = await this._getProxy(deviceId);
    if (currentProxy?.success !== true || !this._isSafeJournalString(currentProxy.value)) {
      console.error(`[Interceptor] Cannot verify current proxy ownership on ${deviceId}`);
      return false;
    }
    if (currentProxy.value !== ownedProxy) {
      console.warn(`[Interceptor] Proxy changed externally on ${deviceId}; preserving the current setting`);
      return true;
    }

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
      await this._adb(deviceId, ['shell', 'rm', '-f', ANDROID_CA_STAGING_PATH], {
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
    if (this._usesAndroidEmulatorHostAliases(deviceId)) {
      return this._assertProxyHostReachable('Android global proxy setup', '10.0.2.2');
    }

    if (requestedHostIp) {
      const hostInterfaces = this._getHostInterfaces();
      if (!hostInterfaces.some(iface => iface.address === requestedHostIp)) {
        throw new Error(`Android proxy host ${requestedHostIp} is not a local IPv4 address`);
      }
      return this._assertProxyHostReachable('Android global proxy setup', requestedHostIp);
    }

    const discoveredCandidates = await this._getReachableHostIpCandidates(deviceId);
    if (discoveredCandidates.length === 0) {
      throw new Error('Could not find a host network adapter reachable from the Android device');
    }
    const candidates = discoveredCandidates.filter(
      candidate => this._isProxyHostReachable(candidate.address)
    );
    if (candidates.length === 0) {
      throw this._proxyBindError('Android global proxy setup', discoveredCandidates[0].address);
    }
    if (candidates.length !== 1) {
      throw createHostIpSelectionError(candidates);
    }
    return candidates[0].address;
  }

  async _getReachableHostIpCandidates(deviceId) {
    const hostInterfaces = this._getHostInterfaces();
    const deviceAddresses = await this._getDeviceIpv4Addresses(deviceId);
    const matches = hostInterfaces
      .filter(iface => deviceAddresses.some(address => sharesSubnet(iface.address, address, iface.netmask)))
      .sort((first, second) =>
        second.prefixLength - first.prefixLength ||
        (ipv4ToInteger(first.address) ?? 0) - (ipv4ToInteger(second.address) ?? 0) ||
        first.name.localeCompare(second.name)
      );
    if (matches.length === 0) return [];

    const bestPrefixLength = matches[0].prefixLength;
    const candidatesByAddress = new Map();
    for (const iface of matches) {
      if (iface.prefixLength !== bestPrefixLength || candidatesByAddress.has(iface.address)) continue;
      candidatesByAddress.set(iface.address, {
        name: iface.name,
        address: iface.address,
        prefixLength: iface.prefixLength
      });
    }
    return [...candidatesByAddress.values()];
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
    if (activeInfo?.mode === 'http-toolkit-app' || activeInfo?.mode === 'app-uncertain') {
      return await this._deactivateHttpToolkitApp(serial, activeInfo.proxyPort);
    }
    if (activeInfo?.mode === 'staging-cleanup') {
      const certificateRemoved = await this._removeCaCert(serial);
      if (!certificateRemoved) return false;
      return await this._cleanupRetainedReverseTunnel(serial, activeInfo);
    }
    if (activeInfo?.mode === 'reverse-cleanup') {
      return await this._cleanupRetainedReverseTunnel(serial, activeInfo);
    }
    const ownedProxy = ipv4ToInteger(activeInfo?.hostIp) !== null &&
      Number.isInteger(activeInfo?.proxyPort) &&
      activeInfo.proxyPort >= 1 && activeInfo.proxyPort <= 65535
      ? `${activeInfo.hostIp}:${activeInfo.proxyPort}`
      : null;
    const proxyRestored = await this._restoreProxy(
      serial,
      activeInfo?.previousProxy,
      ownedProxy
    );
    const certificateRemoved = await this._removeCaCert(serial);
    if (!proxyRestored || !certificateRemoved) return false;
    return await this._cleanupRetainedReverseTunnel(serial, activeInfo);
  }

  async _cleanupRetainedReverseTunnel(serial, activeInfo) {
    if (!Object.prototype.hasOwnProperty.call(activeInfo || {}, 'previousReverseMapping')) {
      return true;
    }
    const key = `${serial}:${activeInfo.proxyPort}`;
    if (!this.reverseTunnels.has(key)) this.reverseTunnels.add(key);
    if (!this.previousReverseMappings.has(key)) {
      this.previousReverseMappings.set(key, activeInfo.previousReverseMapping);
    }
    return await this._removeReverseTunnel(serial, activeInfo.proxyPort);
  }

  async activate(proxyPort, options = {}) {
    const { deviceId, useHttpToolkitApp = true, hostIp: requestedHostIp } = options;

    if (!deviceId) {
      // No specific device — return metadata with device list for UI selection
      const devices = await this._getConnectedDevicesWithHostIpMetadata();
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
    const currentStateMetadata = () => ({
      deviceId,
      model: device.model,
      devices,
      activatedDevices: Array.from(this.activatedDevices.entries()).map(([serial, info]) => ({
        serial,
        ...info
      })),
      ...this._getInterceptionSummary(),
      ...qrMetadata
    });

    let hostIp = null;
    let mode = 'global-proxy';
    let appInstalled = false;
    let tunnelActive = false;
    let appActivationError = null;
    let previousReverseMapping;
    let remoteCertPath = null;
    let previousProxy = null;
    let preparedAppActivation = null;
    let preparedGlobalActivation = null;

    const hostIpSelectionResponse = err => {
      const hostIpCandidates = err.hostIpCandidates;
      return {
        success: false,
        error: err.message,
        metadata: {
          deviceId,
          model: device.model,
          devices: devices.map(candidateDevice => candidateDevice.serial === deviceId
            ? {
                ...candidateDevice,
                httpToolkitAppInstalled: appInstalled,
                requiresHostIpSelection: true,
                hostIpCandidates
              }
            : candidateDevice),
          activatedDevices: Array.from(this.activatedDevices.entries()).map(([serial, info]) => ({
            serial,
            ...info
          })),
          ...this._getInterceptionSummary(),
          requiresHostIpSelection: true,
          hostIpCandidates,
          httpToolkitAppInstalled: appInstalled,
          httpToolkitAppError: appActivationError,
          ...qrMetadata
        }
      };
    };
    const proxyBindFailureResponse = err => ({
      success: false,
      error: err.message,
      metadata: currentStateMetadata()
    });

    const previousActivation = this.activatedDevices.get(deviceId);
    if (useHttpToolkitApp) {
      try {
        preparedAppActivation = await this._prepareHttpToolkitAppActivation(
          deviceId,
          proxyPort,
          {
            prepareReverseMapping: true,
            requireConfirmedPrerequisites: Boolean(previousActivation)
          }
        );
      } catch (err) {
        // Replacement preparation failures must preserve the current mode.
        // A first activation has not mutated the device yet, so it can safely
        // report the companion as unavailable and continue to proxy fallback.
        if (previousActivation) throw err;
        preparedAppActivation = {
          success: false,
          error: err.message,
          appInstalled: true
        };
      }

      const previousTunnelKey = `${deviceId}:${proxyPort}`;
      if (previousActivation && preparedAppActivation.success &&
          previousActivation.proxyPort === proxyPort &&
          this.reverseTunnels.has(previousTunnelKey) &&
          this.previousReverseMappings.has(previousTunnelKey)) {
        // Preparation observes the currently owned mapping. Same-port old
        // cleanup will restore the mapping that preceded it, which is the
        // actual baseline the replacement must preserve.
        preparedAppActivation = {
          ...preparedAppActivation,
          previousReverseMapping: this.previousReverseMappings.get(previousTunnelKey)
        };
      }
      appInstalled = preparedAppActivation.appInstalled === true;
      if (!preparedAppActivation.success) {
        appActivationError = preparedAppActivation.error;
      }
    }

    if (previousActivation) {
      if (!useHttpToolkitApp || !preparedAppActivation?.success) {
        try {
          preparedGlobalActivation = await this._prepareGlobalProxyActivation(
            deviceId,
            requestedHostIp
          );
        } catch (err) {
          if (err?.code === PROXY_BIND_UNREACHABLE_ERROR_CODE) {
            return proxyBindFailureResponse(err);
          }
          if (err?.code !== 'ANDROID_HOST_IP_SELECTION_REQUIRED' ||
              !Array.isArray(err.hostIpCandidates)) {
            throw err;
          }
          return hostIpSelectionResponse(err);
        }
        if (!preparedGlobalActivation.success) {
          return { success: false, error: preparedGlobalActivation.error };
        }
      }
    }

    if (previousActivation) {
      if (!await this._cleanupActivatedDevice(deviceId, previousActivation)) {
        throw new Error(`Could not clean up the existing Android interception for ${deviceId}; reconnect it and retry`);
      }
      this._forgetGlobalProxyOwnership(deviceId);
      this.activatedDevices.delete(deviceId);
      this.active = this.activatedDevices.size > 0;
    }

    let pendingAppActivation = null;
    if (useHttpToolkitApp && preparedAppActivation?.success) {
      // Companion activation is not atomic: the intent may reach Android even
      // if ADB reports an error. Claim that uncertainty durably before the
      // first mutation, including the reverse mapping that the prepared commit
      // may replace.
      pendingAppActivation = {
        model: device.model,
        deviceName: device.deviceName,
        proxyPort,
        mode: 'app-uncertain',
        appInstalled: true,
        vpnStatusConfirmed: false,
        tunnelActive: false,
        ...(Object.prototype.hasOwnProperty.call(preparedAppActivation, 'previousReverseMapping')
          ? { previousReverseMapping: preparedAppActivation.previousReverseMapping }
          : {})
      };
      this._rememberGlobalProxyOwnership(deviceId, pendingAppActivation);
      this.activatedDevices.set(deviceId, pendingAppActivation);
      this.active = true;
    }

    if (useHttpToolkitApp) {
      const appActivation = preparedAppActivation
        ? preparedAppActivation.success
          ? await this._activateHttpToolkitApp(deviceId, proxyPort, preparedAppActivation)
          : preparedAppActivation
        : await this._activateHttpToolkitApp(deviceId, proxyPort);
      appInstalled = appActivation.appInstalled === true;
      tunnelActive = appActivation.tunnelActive === true;

      if (appActivation.success) {
        mode = 'http-toolkit-app';
        if (tunnelActive) {
          const tunnelKey = `${deviceId}:${proxyPort}`;
          previousReverseMapping = this.previousReverseMappings.has(tunnelKey)
            ? this.previousReverseMappings.get(tunnelKey)
            : Object.prototype.hasOwnProperty.call(appActivation, 'previousReverseMapping')
              ? appActivation.previousReverseMapping
              : preparedAppActivation?.previousReverseMapping;
          if (previousReverseMapping !== null &&
              !this._isSafeReverseEndpoint(previousReverseMapping)) {
            throw new Error(`Successful companion reverse tunnel ownership for ${deviceId} could not be tracked safely`);
          }
        }
        if (pendingAppActivation) {
          pendingAppActivation = null;
        }
      } else {
        if (pendingAppActivation) {
          // Before the ACTIVATE intent, only the reverse mapping can have been
          // mutated. Restore that mapping without sending an unrelated
          // companion DEACTIVATE intent. Once ACTIVATE was attempted, the app
          // state is ambiguous and requires the full companion cleanup.
          // Treat legacy/custom activation results without this field as
          // post-intent failures. Only the explicit false result produced by
          // the pre-intent route check may skip companion deactivation.
          const activationIntentAttempted = appActivation.activationIntentAttempted !== false;
          const appCleanupSucceeded = activationIntentAttempted
            ? await this._deactivateHttpToolkitApp(deviceId, proxyPort)
            : await this._removeReverseTunnel(deviceId, proxyPort);
          if (!appCleanupSucceeded) {
            const key = `${deviceId}:${proxyPort}`;
            const uncertainAppActivation = activationIntentAttempted
              ? {
                  ...pendingAppActivation,
                  appActivationError: appActivation.error,
                  tunnelActive: this.reverseTunnels.has(key) || tunnelActive,
                  ...(this.previousReverseMappings.has(key)
                    ? { previousReverseMapping: this.previousReverseMappings.get(key) }
                    : {})
                }
              : {
                  model: device.model,
                  deviceName: device.deviceName,
                  proxyPort,
                  mode: 'reverse-cleanup',
                  appInstalled,
                  tunnelActive: this.reverseTunnels.has(key) || tunnelActive,
                  previousReverseMapping: this.previousReverseMappings.get(key),
                  appActivationError: appActivation.error
                };
            this._rememberGlobalProxyOwnership(deviceId, uncertainAppActivation);
            this.activatedDevices.set(deviceId, uncertainAppActivation);
            this.active = true;
            return {
              success: false,
              error: activationIntentAttempted
                ? `Failed to confirm companion activation cleanup on ${deviceId}; reconnect it and retry Stop`
                : `Failed to restore the companion ADB reverse mapping on ${deviceId}; reconnect it and retry Stop`,
              metadata: currentStateMetadata()
            };
          }
          this._forgetGlobalProxyOwnership(deviceId);
          this.activatedDevices.delete(deviceId);
          this.active = this.activatedDevices.size > 0;
          pendingAppActivation = null;
          tunnelActive = false;
        }
        if (tunnelActive) {
          if (!Object.prototype.hasOwnProperty.call(appActivation, 'previousReverseMapping') ||
              (appActivation.previousReverseMapping !== null &&
                !this._isSafeReverseEndpoint(appActivation.previousReverseMapping))) {
            throw new Error(`Failed companion reverse tunnel cleanup for ${deviceId} could not be tracked safely`);
          }
          previousReverseMapping = appActivation.previousReverseMapping;
        }
        appActivationError = appActivation.error;
        console.warn(`[Interceptor] HTTP Toolkit Android app activation unavailable for ${deviceId}: ${appActivationError}`);
        if (tunnelActive) {
          // The reverse mapping already exists, so own it before any fallible
          // fallback discovery. This state deliberately claims no proxy or CA.
          const reverseCleanup = {
            model: device.model,
            deviceName: device.deviceName,
            proxyPort,
            mode: 'reverse-cleanup',
            appInstalled,
            tunnelActive,
            appActivationError,
            previousReverseMapping
          };
          this.activatedDevices.set(deviceId, reverseCleanup);
          this.active = true;
          this._rememberGlobalProxyOwnership(deviceId, reverseCleanup);
        }
      }
    }

    if (mode !== 'http-toolkit-app') {
      if (preparedGlobalActivation) {
        hostIp = preparedGlobalActivation.hostIp;
      } else {
        try {
          hostIp = await this._getHostIp(deviceId, requestedHostIp);
        } catch (err) {
          if (err?.code === PROXY_BIND_UNREACHABLE_ERROR_CODE) {
            return proxyBindFailureResponse(err);
          }
          if (err?.code !== 'ANDROID_HOST_IP_SELECTION_REQUIRED' ||
              !Array.isArray(err.hostIpCandidates)) {
            throw err;
          }
          return hostIpSelectionResponse(err);
        }
      }
      try {
        this._assertProxyHostReachable('Android global proxy setup', hostIp);
      } catch (err) {
        if (err?.code === PROXY_BIND_UNREACHABLE_ERROR_CODE) {
          return proxyBindFailureResponse(err);
        }
        throw err;
      }
      const currentProxy = await this._getProxy(deviceId);
      if (!currentProxy.success) {
        return {
          success: false,
          error: `Failed to read existing proxy on ${deviceId}: ${currentProxy.error}`,
          metadata: currentStateMetadata()
        };
      }
      previousProxy = currentProxy.value;

      // Persist cleanup ownership before the first durable device mutation. The
      // staged path is safe to remove with `rm -f` even if the following push
      // never creates it.
      const pendingGlobalActivation = {
        model: device.model,
        deviceName: device.deviceName,
        hostIp,
        remoteCertPath: ANDROID_CA_STAGING_PATH,
        proxyPort,
        mode: 'proxy-uncertain',
        appInstalled,
        tunnelActive,
        appActivationError,
        previousProxy,
        ...(tunnelActive ? { previousReverseMapping } : {})
      };
      this._rememberGlobalProxyOwnership(deviceId, pendingGlobalActivation);
      this.activatedDevices.set(deviceId, pendingGlobalActivation);
      this.active = true;

      // Push CA certificate for the global proxy fallback.
      remoteCertPath = await this._pushCaCert(deviceId);

      // Set proxy
      const proxySet = await this._setProxy(deviceId, hostIp, proxyPort);

      if (!proxySet) {
        const intendedProxy = `${hostIp}:${proxyPort}`;
        const currentProxy = await this._getProxy(deviceId);
        const proxyReadbackConfirmed = currentProxy?.success === true &&
          this._isSafeJournalString(currentProxy.value);

        if (proxyReadbackConfirmed && currentProxy.value === intendedProxy) {
          console.warn(`[Interceptor] Proxy write result was uncertain on ${deviceId}, but readback confirmed ${intendedProxy}`);
        } else if (proxyReadbackConfirmed) {
          const certificateRemoved = !remoteCertPath || await this._removeCaCert(deviceId);
          const reverseTunnelRemoved = certificateRemoved
            ? await this._cleanupRetainedReverseTunnel(deviceId, pendingGlobalActivation)
            : false;
          if (!certificateRemoved || !reverseTunnelRemoved) {
            const stagingCleanup = {
              ...pendingGlobalActivation,
              remoteCertPath,
              mode: 'staging-cleanup'
            };
            this._rememberGlobalProxyOwnership(deviceId, stagingCleanup);
            this.activatedDevices.set(deviceId, stagingCleanup);
            this.active = true;
          } else {
            this._forgetGlobalProxyOwnership(deviceId);
            this.activatedDevices.delete(deviceId);
            this.active = this.activatedDevices.size > 0;
          }
          return {
            success: false,
            error: certificateRemoved && reverseTunnelRemoved
              ? `Failed to set proxy on ${deviceId}`
              : `Failed to set proxy on ${deviceId} and finish fallback cleanup; reconnect it and retry Stop`,
            metadata: currentStateMetadata()
          };
        } else {
          return {
            success: false,
            error: `Failed to set proxy on ${deviceId} and could not verify whether it was applied; reconnect it and retry Stop`,
            metadata: currentStateMetadata()
          };
        }
      }

      // The command completed, or an ambiguous command result was resolved by
      // exact readback. Only now may durable state claim the proxy is active.
      this._rememberGlobalProxyOwnership(deviceId, {
        ...pendingGlobalActivation,
        remoteCertPath,
        mode: 'global-proxy'
      });
    }

    const activationMode = mode === 'http-toolkit-app' ? 'app-uncertain' : mode;
    const activatedInfo = {
      model: device.model,
      deviceName: device.deviceName,
      hostIp,
      remoteCertPath,
      proxyPort,
      mode: activationMode,
      appInstalled,
      tunnelActive,
      appActivationError,
      previousProxy,
      ...(mode === 'http-toolkit-app' ? { vpnStatusConfirmed: false } : {}),
      ...(tunnelActive ? { previousReverseMapping } : {})
    };
    if (mode === 'http-toolkit-app') {
      this._rememberGlobalProxyOwnership(deviceId, activatedInfo);
    }
    this.activatedDevices.set(deviceId, activatedInfo);
    this.active = true;

    console.log(`[Interceptor] Android ADB interceptor activated for ${deviceId} (${device.model}) via ${activationMode}`);

    return {
      success: true,
      metadata: {
        deviceId,
        model: device.model,
        mode: activationMode,
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
        })),
        ...this._getInterceptionSummary()
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
      this._forgetGlobalProxyOwnership(deviceId);
      this.activatedDevices.delete(deviceId);
      console.log(`[Interceptor] Android ADB interceptor deactivated for ${deviceId}`);
    } else {
      // Deactivate all devices
      const failures = [];
      for (const [serial, activeInfo] of Array.from(this.activatedDevices.entries())) {
        try {
          if (await this._cleanupActivatedDevice(serial, activeInfo)) {
            this._forgetGlobalProxyOwnership(serial);
            this.activatedDevices.delete(serial);
            continue;
          }
        } catch (err) {
          console.warn(`[Interceptor] Failed to finalize Android cleanup for ${serial}:`, err.message);
        }
        if (this.activatedDevices.has(serial)) {
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
      ...this._getInterceptionSummary(),
      pid: null
    };
  }
}
