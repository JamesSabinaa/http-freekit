import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';

const TERMINAL_CA_BUNDLE_NAME = 'terminal-ca-bundle.pem';
const TERMINAL_CA_BUNDLE_MODE = 0o644;

function normalizePem(pem) {
  return `${String(pem).trim()}\n`;
}

export function terminalCaBundlePath(certificatePath) {
  if (!certificatePath) throw new Error('Cannot create terminal CA bundle without a CA certificate path');
  return path.join(path.dirname(path.resolve(certificatePath)), TERMINAL_CA_BUNDLE_NAME);
}

export function refreshTerminalCaBundle(certificatePath, options = {}) {
  const publicRoots = options.publicRoots ?? tls.rootCertificates;
  const renameFile = options.renameFile || fs.renameSync;
  const bundlePath = terminalCaBundlePath(certificatePath);
  const freeKitCa = fs.readFileSync(certificatePath, 'utf8');
  const bundle = [...publicRoots, freeKitCa].map(normalizePem).join('\n');
  const temporaryPath = `${bundlePath}.${process.pid}.${crypto.randomUUID()}.tmp`;

  try {
    if (fs.readFileSync(bundlePath, 'utf8') === bundle) {
      fs.chmodSync(bundlePath, TERMINAL_CA_BUNDLE_MODE);
      return bundlePath;
    }
  } catch {}

  try {
    const descriptor = fs.openSync(temporaryPath, 'wx', TERMINAL_CA_BUNDLE_MODE);
    try {
      fs.writeFileSync(descriptor, bundle, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.chmodSync(temporaryPath, TERMINAL_CA_BUNDLE_MODE);
    try {
      renameFile(temporaryPath, bundlePath);
    } catch (error) {
      // A concurrent terminal activation may have installed this exact bundle.
      let installedByPeer = false;
      try { installedByPeer = fs.readFileSync(bundlePath, 'utf8') === bundle; } catch {}
      if (!installedByPeer) throw error;
      fs.unlinkSync(temporaryPath);
    }
    fs.chmodSync(bundlePath, TERMINAL_CA_BUNDLE_MODE);
    return bundlePath;
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch {}
    throw error;
  }
}
