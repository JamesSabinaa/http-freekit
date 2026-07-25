import forge from 'node-forge';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import net from 'net';

const { pki, md, asn1 } = forge;

export class CertificateAuthority {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.caKeyPath = path.join(dataDir, 'ca.key');
    this.caCertPath = path.join(dataDir, 'ca.pem');
    this.caKey = null;
    this.caCert = null;
    this.certCache = new Map();
    this.certPromises = new Map();
  }

  async initialize() {
    if (fs.existsSync(this.caCertPath) && fs.existsSync(this.caKeyPath)) {
      const certPem = fs.readFileSync(this.caCertPath, 'utf8');
      const keyPem = fs.readFileSync(this.caKeyPath, 'utf8');
      this.caCert = pki.certificateFromPem(certPem);
      this.caKey = pki.privateKeyFromPem(keyPem);

      // Regenerate if expiring within 48 hours
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

    return {
      certPath: this.caCertPath,
      certContent: fs.readFileSync(this.caCertPath, 'utf8'),
      keyPath: this.caKeyPath,
      fingerprint: this._getFingerprint()
    };
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

  _randomSerial() {
    return crypto.randomBytes(16).toString('hex');
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
      certificateExpiry: this.caCert.validity.notAfter.getTime()
    };
  }
}
