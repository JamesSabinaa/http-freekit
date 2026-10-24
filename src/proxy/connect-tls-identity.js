import net from 'node:net';
import tls from 'node:tls';

// SNI selects only the interception certificate. It must never select the
// CONNECT destination, rewrite an HTTP authority, or relax upstream trust.
export function normalizeConnectServerName(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 253 ||
      !/^[\x21-\x7e]+$/.test(value) || value.includes('%')) return '';
  const hostname = value.toLowerCase().replace(/\.$/, '');
  // Preserve compatibility with clients that send a literal despite SNI's DNS
  // convention. Scoped IPs, brackets, URL syntax and ambiguous IPv4 are rejected.
  if (net.isIP(hostname)) return hostname;
  if (/^[0-9.]+$/.test(hostname)) return '';
  const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  return hostname.split('.').every(part => label.test(part)) ? hostname : '';
}

export function createConnectSniCallback(certificateAuthority) {
  return (serverName, callback) => {
    const hostname = normalizeConnectServerName(serverName);
    if (!hostname) {
      const error = new Error('Invalid TLS server name');
      error.code = 'ERR_INVALID_TLS_SERVERNAME';
      callback(error);
      return;
    }
    const prepareContext = async () => {
      const certificate = await certificateAuthority.generateCertForHost(hostname);
      return tls.createSecureContext({
        key: certificate.key,
        cert: certificate.cert,
        ca: certificate.ca
      });
    };
    void prepareContext().then(context => callback(null, context), cause => {
      const error = new Error('Cannot create TLS interception context', { cause });
      error.code = 'ERR_TLS_INTERCEPTION_CONTEXT';
      callback(error);
    });
  };
}
