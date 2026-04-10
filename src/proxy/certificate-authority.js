import forge from 'node-forge';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const { pki, md, asn1 } = forge;

export class CertificateAuthority {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.caKeyPath = path.join(dataDir, 'ca.key');
    this.caCertPath = path.join(dataDir, 'ca.pem');
    this.caKey = null;
    this.caCert = null;
    this.certCache = new Map();
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
    const keys = pki.rsa.generateKeyPair(2048);
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

  generateCertForHost(hostname) {
    // Return cached cert if available
    if (this.certCache.has(hostname)) {
      return this.certCache.get(hostname);
    }

    const keys = pki.rsa.generateKeyPair(2048);
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

    const altNames = [{ type: 2, value: hostname }]; // DNS type
    // If it looks like an IP, add IP alt name
    if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
      altNames.push({ type: 7, ip: hostname });
    }

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
    if (this.certCache.size > 1000) {
      const firstKey = this.certCache.keys().next().value;
      this.certCache.delete(firstKey);
    }
    this.certCache.set(hostname, result);

    return result;
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
