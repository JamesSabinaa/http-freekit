import forge from 'node-forge';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import net from 'net';
import { refreshTerminalCaBundle, terminalCaBundlePath } from './terminal-ca-bundle.js';

const { pki, md, asn1 } = forge;
const CA_CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

export class CertificateAuthority {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.caKeyPath = path.join(dataDir, 'ca.key');
    this.caCertPath = path.join(dataDir, 'ca.pem');
    this.terminalCaBundlePath = terminalCaBundlePath(this.caCertPath);
    this.caKey = null;
    this.caCert = null;
    this.certCache = new Map();
    this.certPromises = new Map();
  }

  async initialize() {
    if (fs.existsSync(this.caCertPath) && fs.existsSync(this.caKeyPath)) {
      let loadedExistingCa = false;
      try {
        const certPem = fs.readFileSync(this.caCertPath, 'utf8');
        const keyPem = fs.readFileSync(this.caKeyPath, 'utf8');
        this._validateCaPair(certPem, keyPem);
        this.caCert = pki.certificateFromPem(certPem);
        this.caKey = pki.privateKeyFromPem(keyPem);
        loadedExistingCa = true;
      } catch (error) {
        console.warn(`[CA] Existing CA files are invalid, regenerating: ${error.message}`);
      }

      if (loadedExistingCa) {
        const expiry = this.caCert.validity.notAfter;
        const hoursLeft = (expiry - Date.now()) / (1000 * 60 * 60);
        if (hoursLeft < 48) {
          console.log('[CA] Certificate expiring soon, regenerating...');
          await this._generateCA();
        } else {
          console.log('[CA] Loaded existing CA certificate');
        }
      } else {
        await this._generateCA();
      }
    } else {
      await this._generateCA();
    }

    return {
      certPath: this.caCertPath,
      certContent: fs.readFileSync(this.caCertPath, 'utf8'),
      keyPath: this.caKeyPath,
      fingerprint: this._getFingerprint()
    };
  }

  _validateCaPair(certPem, keyPem) {
    const certificate = new crypto.X509Certificate(certPem);
    const privateKey = crypto.createPrivateKey(keyPem);
    const certificatePublicKey = certificate.publicKey.export({ type: 'spki', format: 'der' });
    const privatePublicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
    const validFrom = new Date(certificate.validFrom).getTime();

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

  async _generateCA() {
    console.log('[CA] Generating new CA certificate...');
    const keys = await this._generateKeyPair();
    const cert = pki.createCertificate();

    cert.publicKey = keys.publicKey;
    cert.serialNumber = this._randomSerial();

    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

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

    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setDate(cert.validity.notBefore.getDate() + 365);

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
    return {
      certificatePath: this.caCertPath,
      certificateContent: pki.certificateToPem(this.caCert),
      certificateFingerprint: this._getFingerprint(),
      certificateSpkiFingerprint: this.getSpkiFingerprint(),
      certificateExpiry: this.caCert.validity.notAfter.getTime(),
      terminalCaBundlePath: this.terminalCaBundlePath
    };
  }

  getTerminalCaBundlePath() {
    // This stable file is shared by independently managed terminals. It is
    // refreshed atomically and intentionally persists beyond deactivation.
    return refreshTerminalCaBundle(this.caCertPath);
  }
}
