import forge from 'node-forge';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import net from 'net';
import { refreshTerminalCaBundle, terminalCaBundlePath } from './terminal-ca-bundle.js';

const { pki, md, asn1 } = forge;
const CA_CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;
const CA_AUTO_RENEWAL_WINDOW_MS = 48 * 60 * 60 * 1000;
const CA_RENEWAL_NOTICE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const CA_REPLACEMENT_STATE_VERSION = 2;

export class CertificateAuthority {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.caKeyPath = path.join(dataDir, 'ca.key');
    this.caCertPath = path.join(dataDir, 'ca.pem');
    this.caReplacementStatePath = path.join(dataDir, 'ca-replacements.json');
    this.caMigrationStatePath = path.join(dataDir, 'ca-migration.json');
    this.caRenewalStatePath = path.join(dataDir, 'ca-renewal.json');
    this.terminalCaBundlePath = terminalCaBundlePath(this.caCertPath);
    this.caKey = null;
    this.caCert = null;
    this.certCache = new Map();
    this.certPromises = new Map();
    this.pendingReplacementFingerprints = [];
    this.pendingMigrationFingerprint = null;
    this.renewalScheduled = false;
    this.automaticRenewalDeferred = false;
    this.autoRenewExpiring = true;
  }

  async initialize(options = {}) {
    const autoRenewExpiring = options.autoRenewExpiring !== false;
    this.autoRenewExpiring = autoRenewExpiring;
    const replacementState = this._loadReplacementFingerprints();
    let replacedCertificateFingerprints = replacementState.fingerprints;
    this.pendingReplacementFingerprints = replacedCertificateFingerprints;
    this.pendingMigrationFingerprint = this._loadMigrationFingerprint();
    let scheduledRenewal = this._loadScheduledRenewal();
    this.renewalScheduled = scheduledRenewal !== null;
    this.automaticRenewalDeferred = false;
    let existingCertPem = null;
    let existingCertReadError = null;
    if (fs.existsSync(this.caCertPath)) {
      try {
        existingCertPem = fs.readFileSync(this.caCertPath, 'utf8');
      } catch (error) {
        existingCertReadError = error;
      }
    }
    const rememberReplacedCertificate = () => {
      if (!existingCertPem) return;
      let fingerprint;
      try {
        fingerprint = new crypto.X509Certificate(existingCertPem)
          .fingerprint.replace(/:/g, '').toUpperCase();
      } catch {
        // Corrupt certificate data cannot correspond to an installed identity.
        return;
      }
      if (!replacedCertificateFingerprints.includes(fingerprint)) {
        replacedCertificateFingerprints = [...replacedCertificateFingerprints, fingerprint];
        // Persist before replacing either CA file. A crash or trust-store
        // failure can then retry exact-thumbprint cleanup on the next start.
        this.setPendingReplacementFingerprints(replacedCertificateFingerprints);
      }
      this.setPendingMigrationFingerprint(fingerprint);
    };
    if (existingCertReadError) {
      throw new Error(`Could not read existing CA certificate: ${existingCertReadError.message}`);
    }

    const existingCertificateFingerprint = this._sha1Fingerprint(existingCertPem);
    if (scheduledRenewal && existingCertificateFingerprint
        && scheduledRenewal.fingerprint !== existingCertificateFingerprint) {
      // A crash after writing the replacement but before deleting the marker
      // must not rotate the new identity a second time.
      this.cancelScheduledRenewal();
      scheduledRenewal = null;
    }

    let generatedCa = false;
    if (fs.existsSync(this.caCertPath) && fs.existsSync(this.caKeyPath)) {
      let loadedExistingCa = false;
      try {
        const certPem = existingCertPem;
        const keyPem = fs.readFileSync(this.caKeyPath, 'utf8');
        this._validateCaPair(certPem, keyPem);
        this.caCert = pki.certificateFromPem(certPem);
        this.caKey = pki.privateKeyFromPem(keyPem);
        loadedExistingCa = true;
      } catch (error) {
        rememberReplacedCertificate();
        console.warn(`[CA] Existing CA files are invalid, regenerating: ${error.message}`);
      }

      if (loadedExistingCa) {
        const expiry = this.caCert.validity.notAfter;
        const renewalDue = expiry.getTime() - Date.now() < CA_AUTO_RENEWAL_WINDOW_MS;
        if (scheduledRenewal || (renewalDue && autoRenewExpiring)) {
          rememberReplacedCertificate();
          console.log(scheduledRenewal
            ? '[CA] Applying explicitly scheduled CA renewal...'
            : '[CA] Certificate expiring soon, regenerating...');
          await this._generateCA();
          generatedCa = true;
        } else if (renewalDue) {
          this.automaticRenewalDeferred = true;
          console.warn(
            '[CA] Certificate expires soon; automatic renewal is deferred to preserve external trust'
          );
        } else {
          console.log('[CA] Loaded existing CA certificate');
        }
      } else {
        await this._generateCA();
        generatedCa = true;
      }
    } else {
      rememberReplacedCertificate();
      await this._generateCA();
      generatedCa = true;
    }

    if (scheduledRenewal && generatedCa) {
      this.cancelScheduledRenewal();
    }

    const certContent = fs.readFileSync(this.caCertPath, 'utf8');
    const activeCertificateFingerprint = new crypto.X509Certificate(certContent)
      .fingerprint.replace(/:/g, '').toUpperCase();
    const obsoleteCertificateFingerprints = replacedCertificateFingerprints
      .filter(fingerprint => fingerprint !== activeCertificateFingerprint);
    if (obsoleteCertificateFingerprints.length !== replacedCertificateFingerprints.length) {
      // A crash after journaling but before replacement leaves the old CA active.
      // Never schedule that active identity for trust-store deletion.
      // A legacy v1 journal must not be rewritten as v2 until its separate
      // migration marker is committed below, or a crash could make the warning
      // look acknowledged forever.
      if (!replacementState.needsMigration) {
        this.setPendingReplacementFingerprints(obsoleteCertificateFingerprints);
      }
      replacedCertificateFingerprints = obsoleteCertificateFingerprints;
    }
    this.pendingReplacementFingerprints = replacedCertificateFingerprints;
    if (this.pendingMigrationFingerprint === activeCertificateFingerprint) {
      // A crash after recording intent but before replacing the active CA did
      // not create a client migration. Do not show a false re-trust warning.
      this.setPendingMigrationFingerprint(null);
    }
    if (replacementState.needsMigration && this.pendingMigrationFingerprint === null &&
        replacedCertificateFingerprints.length > 0) {
      // Releases before the migration/cleanup journals were separated stored
      // only these obsolete fingerprints. Preserve their unacknowledged client
      // migration warning when upgrading instead of silently losing it.
      this.setPendingMigrationFingerprint(replacedCertificateFingerprints.at(-1));
    }
    if (replacementState.needsMigration && replacedCertificateFingerprints.length > 0) {
      // Persist the split-state version only after the migration marker is
      // present and its directory entry is durable. This synchronization must
      // also run when a prior failed startup left the renamed marker visible:
      // visibility alone does not prove that the rename survived a crash.
      this._syncMigrationStateDirectory();
      // A later acknowledgement can then remain acknowledged while Windows
      // exact-thumbprint cleanup continues independently.
      this.setPendingReplacementFingerprints(replacedCertificateFingerprints);
    } else if (replacementState.needsMigration) {
      // The legacy journal contained only the still-active identity, so there
      // is neither cleanup nor a client migration to retain.
      this.setPendingReplacementFingerprints([]);
    }

    return {
      certPath: this.caCertPath,
      certContent,
      keyPath: this.caKeyPath,
      fingerprint: this._getFingerprint(),
      replacedCertificateFingerprint: replacedCertificateFingerprints[0] || null,
      replacedCertificateFingerprints,
      renewalRequired: this._isRenewalRequired(),
      renewalScheduled: this.renewalScheduled,
      automaticRenewalDeferred: this.automaticRenewalDeferred
    };
  }

  _sha1Fingerprint(certPem) {
    if (!certPem) return null;
    try {
      return new crypto.X509Certificate(certPem)
        .fingerprint.replace(/:/g, '').toUpperCase();
    } catch {
      return null;
    }
  }

  _normalizeSha1Fingerprint(value) {
    const fingerprint = String(value || '').trim().replace(/:/g, '').toUpperCase();
    return /^[0-9A-F]{40}$/.test(fingerprint) ? fingerprint : null;
  }

  _loadReplacementFingerprints() {
    if (!fs.existsSync(this.caReplacementStatePath)) {
      return { fingerprints: [], needsMigration: false };
    }
    const state = JSON.parse(fs.readFileSync(this.caReplacementStatePath, 'utf8'));
    if (!state || ![1, CA_REPLACEMENT_STATE_VERSION].includes(state.version) ||
        !Array.isArray(state.fingerprints)) {
      throw new Error('Pending CA replacement state has an unsupported format');
    }
    const fingerprints = state.fingerprints.map(value => this._normalizeSha1Fingerprint(value));
    if (fingerprints.some(value => value === null)) {
      throw new Error('Pending CA replacement state contains an invalid fingerprint');
    }
    return {
      fingerprints: [...new Set(fingerprints)],
      needsMigration: state.version === 1
    };
  }

  setPendingReplacementFingerprints(values) {
    const fingerprints = [...new Set(
      (Array.isArray(values) ? values : [])
        .map(value => this._normalizeSha1Fingerprint(value))
        .filter(Boolean)
    )];
    if (fingerprints.length === 0) {
      try { fs.unlinkSync(this.caReplacementStatePath); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      this.pendingReplacementFingerprints = [];
      return;
    }

    const temporaryPath = `${this.caReplacementStatePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let descriptor = null;
    try {
      descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
      fs.writeFileSync(
        descriptor,
        JSON.stringify({ version: CA_REPLACEMENT_STATE_VERSION, fingerprints }),
        'utf8'
      );
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      fs.renameSync(temporaryPath, this.caReplacementStatePath);
      fs.chmodSync(this.caReplacementStatePath, 0o600);
      if (process.platform !== 'win32') {
        const directoryDescriptor = fs.openSync(path.dirname(this.caReplacementStatePath), 'r');
        try {
          fs.fsyncSync(directoryDescriptor);
        } finally {
          fs.closeSync(directoryDescriptor);
        }
      }
      this.pendingReplacementFingerprints = fingerprints;
    } catch (error) {
      if (descriptor !== null) {
        try { fs.closeSync(descriptor); } catch {}
      }
      try { fs.unlinkSync(temporaryPath); } catch {}
      throw error;
    }
  }

  _loadMigrationFingerprint() {
    if (!fs.existsSync(this.caMigrationStatePath)) return null;
    const state = JSON.parse(fs.readFileSync(this.caMigrationStatePath, 'utf8'));
    const fingerprint = this._normalizeSha1Fingerprint(state?.previousFingerprint);
    if (!state || state.version !== 1 || !fingerprint) {
      throw new Error('Pending CA migration state has an unsupported format');
    }
    return fingerprint;
  }

  _syncMigrationStateDirectory() {
    if (process.platform === 'win32') return;
    const directoryDescriptor = fs.openSync(path.dirname(this.caMigrationStatePath), 'r');
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
  }

  setPendingMigrationFingerprint(value) {
    const fingerprint = value === null ? null : this._normalizeSha1Fingerprint(value);
    if (value !== null && !fingerprint) {
      throw new Error('Pending CA migration fingerprint is invalid');
    }
    if (!fingerprint) {
      try { fs.unlinkSync(this.caMigrationStatePath); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      this.pendingMigrationFingerprint = null;
      return;
    }

    const temporaryPath = `${this.caMigrationStatePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let descriptor = null;
    try {
      descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
      fs.writeFileSync(
        descriptor,
        JSON.stringify({ version: 1, previousFingerprint: fingerprint }),
        'utf8'
      );
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      fs.renameSync(temporaryPath, this.caMigrationStatePath);
    } catch (error) {
      if (descriptor !== null) {
        try { fs.closeSync(descriptor); } catch {}
      }
      try { fs.unlinkSync(temporaryPath); } catch {}
      throw error;
    }

    this.pendingMigrationFingerprint = fingerprint;
    try {
      fs.chmodSync(this.caMigrationStatePath, 0o600);
    } catch (error) {
      // The temporary file was created with mode 0600, which rename preserves.
      // A redundant chmod failure must not strand an otherwise durable marker.
      console.warn(`[CA] Migration marker was saved but permission hardening failed: ${error.message}`);
    }
    try {
      this._syncMigrationStateDirectory();
    } catch (error) {
      // Atomic rename does not make the directory entry crash-durable by
      // itself. Keep legacy v1 recovery evidence intact by aborting startup
      // before its cleanup state can be rewritten as v2.
      console.warn(`[CA] Migration marker directory could not be synchronized: ${error.message}`);
      throw error;
    }
  }

  acknowledgeReplacementMigration() {
    this.setPendingMigrationFingerprint(null);
  }

  _loadScheduledRenewal() {
    if (!fs.existsSync(this.caRenewalStatePath)) return null;
    const state = JSON.parse(fs.readFileSync(this.caRenewalStatePath, 'utf8'));
    const fingerprint = this._normalizeSha1Fingerprint(state?.fingerprint);
    if (!state || state.version !== 1 || !fingerprint) {
      throw new Error('Scheduled CA renewal state has an unsupported format');
    }
    return { fingerprint };
  }

  scheduleRenewal() {
    if (!this.caCert) throw new Error('Certificate Authority is not initialized');
    if (this.renewalScheduled) return;
    const fingerprint = this._sha1Fingerprint(pki.certificateToPem(this.caCert));
    if (!fingerprint) throw new Error('Current CA fingerprint is unavailable');
    const temporaryPath = `${this.caRenewalStatePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let descriptor = null;
    let committed = false;
    try {
      descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ version: 1, fingerprint }), 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      fs.renameSync(temporaryPath, this.caRenewalStatePath);
      committed = true;
      this.renewalScheduled = true;
      fs.chmodSync(this.caRenewalStatePath, 0o600);
      if (process.platform !== 'win32') {
        const directoryDescriptor = fs.openSync(path.dirname(this.caRenewalStatePath), 'r');
        try {
          fs.fsyncSync(directoryDescriptor);
        } finally {
          fs.closeSync(directoryDescriptor);
        }
      }
    } catch (error) {
      if (committed) {
        // The visible state must match the committed marker. A chmod or
        // directory-fsync failure after rename is not allowed to report an
        // unscheduled renewal which will nevertheless run after restart.
        this.renewalScheduled = true;
        console.warn(`[CA] Renewal was scheduled but marker hardening failed: ${error.message}`);
        return;
      }
      if (descriptor !== null) {
        try { fs.closeSync(descriptor); } catch {}
      }
      try { fs.unlinkSync(temporaryPath); } catch {}
      throw error;
    }
  }

  cancelScheduledRenewal() {
    try { fs.unlinkSync(this.caRenewalStatePath); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    this.renewalScheduled = false;
  }

  _isRenewalRequired(now = Date.now()) {
    return Boolean(this.caCert)
      && this.caCert.validity.notAfter.getTime() - now < CA_RENEWAL_NOTICE_WINDOW_MS;
  }

  _validateCaPair(certPem, keyPem) {
    const certificate = new crypto.X509Certificate(certPem);
    const forgeCertificate = pki.certificateFromPem(certPem);
    const privateKey = crypto.createPrivateKey(keyPem);
    const certificatePublicKey = certificate.publicKey.export({ type: 'spki', format: 'der' });
    const privatePublicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
    const validFrom = new Date(certificate.validFrom).getTime();

    if (!this._isPositiveSerial(forgeCertificate.serialNumber)) {
      throw new Error('certificate serial number is not positive');
    }

    if (!certificate.ca) {
      throw new Error('certificate is not a certificate authority');
    }
    if (!certificate.checkIssued(certificate) || !certificate.verify(certificate.publicKey)) {
      throw new Error('certificate is not self-signed');
    }
    if (!certificatePublicKey.equals(privatePublicKey)) {
      throw new Error('certificate and private key do not match');
    }
    if (!Number.isFinite(validFrom) || validFrom > Date.now() + CA_CLOCK_SKEW_TOLERANCE_MS) {
      throw new Error('certificate is not yet valid');
    }
  }

  _isPositiveSerial(serialNumber) {
    let serial = String(serialNumber || '').trim();
    if (!serial || serial.startsWith('-') || !/^[0-9a-f]+$/i.test(serial)) return false;
    if (serial.length % 2 !== 0) serial = `0${serial}`;
    const bytes = Buffer.from(serial, 'hex');
    return bytes.length > 0 && (bytes[0] & 0x80) === 0
      && bytes.some(byte => byte !== 0);
  }

  async _generateCA() {
    console.log('[CA] Generating new CA certificate...');
    const keys = await this._generateKeyPair();
    const cert = pki.createCertificate();

    cert.publicKey = keys.publicKey;
    cert.serialNumber = this._randomSerial();

    const generatedAt = Date.now();
    cert.validity.notBefore = new Date(generatedAt - CA_CLOCK_SKEW_TOLERANCE_MS);
    cert.validity.notAfter = new Date(generatedAt);
    cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + 1);

    const attrs = [
      { name: 'commonName', value: 'HTTP FreeKit CA' },
      { name: 'organizationName', value: 'HTTP FreeKit' },
      { name: 'countryName', value: 'US' }
    ];

    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([
      { name: 'basicConstraints', cA: true, critical: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
      {
        name: 'subjectKeyIdentifier'
      }
    ]);

    cert.sign(keys.privateKey, md.sha256.create());

    this.caCert = cert;
    this.caKey = keys.privateKey;

    const certPem = pki.certificateToPem(cert);
    const keyPem = pki.privateKeyToPem(keys.privateKey);

    fs.writeFileSync(this.caCertPath, certPem);
    fs.writeFileSync(this.caKeyPath, keyPem, { mode: 0o600 });
    fs.chmodSync(this.caKeyPath, 0o600);
    console.log('[CA] CA certificate generated and saved');
  }

  async generateCertForHost(hostname) {
    // Return cached cert if available
    if (this.certCache.has(hostname)) {
      return this.certCache.get(hostname);
    }

    if (this.certPromises.has(hostname)) {
      return this.certPromises.get(hostname);
    }

    const pending = this._generateCertForHost(hostname);
    this.certPromises.set(hostname, pending);
    try {
      return await pending;
    } finally {
      this.certPromises.delete(hostname);
    }
  }

  async _generateCertForHost(hostname) {
    const keys = await this._generateKeyPair();
    const cert = pki.createCertificate();

    cert.publicKey = keys.publicKey;
    cert.serialNumber = this._randomSerial();

    const generatedAt = Date.now();
    cert.validity.notBefore = new Date(generatedAt - CA_CLOCK_SKEW_TOLERANCE_MS);
    cert.validity.notAfter = new Date(generatedAt);
    cert.validity.notAfter.setDate(cert.validity.notAfter.getDate() + 365);

    cert.setSubject([
      { name: 'commonName', value: hostname },
      { name: 'organizationName', value: 'HTTP FreeKit' }
    ]);

    cert.setIssuer(this.caCert.subject.attributes);

    // IP literals (IPv4 and IPv6) must use an iPAddress SAN. A dNSName SAN
    // does not match an IP literal during certificate verification.
    const altNames = net.isIP(hostname)
      ? [{ type: 7, ip: hostname }]
      : [{ type: 2, value: hostname }];

    cert.setExtensions([
      { name: 'basicConstraints', cA: false },
      {
        name: 'keyUsage',
        digitalSignature: true,
        keyEncipherment: true,
        critical: true
      },
      {
        name: 'extKeyUsage',
        serverAuth: true
      },
      {
        name: 'subjectAltName',
        altNames
      },
      {
        name: 'subjectKeyIdentifier'
      },
      {
        name: 'authorityKeyIdentifier',
        keyIdentifier: true
      }
    ]);

    cert.sign(this.caKey, md.sha256.create());

    const result = {
      key: pki.privateKeyToPem(keys.privateKey),
      cert: pki.certificateToPem(cert),
      ca: pki.certificateToPem(this.caCert)
    };

    // Cache (limit cache to 1000 entries)
    if (this.certCache.size >= 1000) {
      const firstKey = this.certCache.keys().next().value;
      this.certCache.delete(firstKey);
    }
    this.certCache.set(hostname, result);

    return result;
  }

  _generateKeyPair() {
    return new Promise((resolve, reject) => {
      pki.rsa.generateKeyPair({ bits: 2048 }, (error, keys) => {
        if (error) reject(error);
        else resolve(keys);
      });
    });
  }

  _randomSerial(randomBytes = crypto.randomBytes(16)) {
    const bytes = Buffer.from(randomBytes);
    // X.509 serials are positive ASN.1 INTEGERs. Clear the sign bit and avoid zero.
    bytes[0] &= 0x7f;
    if (!bytes.some(byte => byte !== 0)) bytes[bytes.length - 1] = 1;
    return bytes.toString('hex');
  }

  _getFingerprint() {
    const certDer = asn1.toDer(pki.certificateToAsn1(this.caCert)).getBytes();
    const hash = crypto.createHash('sha256').update(Buffer.from(certDer, 'binary')).digest('base64');
    return hash;
  }

  // SPKI fingerprint — this is what Chrome's --ignore-certificate-errors-spki-list needs
  getSpkiFingerprint() {
    const pubKeyDer = asn1.toDer(pki.publicKeyToAsn1(this.caCert.publicKey)).getBytes();
    return crypto.createHash('sha256').update(Buffer.from(pubKeyDer, 'binary')).digest('base64');
  }

  getCertInfo() {
    const certificateExpiry = this.caCert.validity.notAfter.getTime();
    return {
      certificatePath: this.caCertPath,
      certificateContent: pki.certificateToPem(this.caCert),
      certificateFingerprint: this._getFingerprint(),
      certificateSpkiFingerprint: this.getSpkiFingerprint(),
      certificateExpiry,
      certificateExpired: certificateExpiry <= Date.now(),
      certificateRenewalRequired: this._isRenewalRequired(),
      certificateRenewalScheduled: this.renewalScheduled,
      certificateAutomaticRenewalEnabled: this.autoRenewExpiring,
      certificateAutomaticRenewalDeferred: this.automaticRenewalDeferred,
      certificateReplacementPending: this.pendingMigrationFingerprint !== null,
      terminalCaBundlePath: this.terminalCaBundlePath
    };
  }

  getTerminalCaBundlePath() {
    // This stable file is shared by independently managed terminals. It is
    // refreshed atomically and intentionally persists beyond deactivation.
    return refreshTerminalCaBundle(this.caCertPath);
  }
}
