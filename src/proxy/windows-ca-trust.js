import { execFileSync } from 'node:child_process';

function normalizeSha1Fingerprint(value) {
  const fingerprint = String(value || '').trim().replace(/:/g, '').toUpperCase();
  return /^[0-9A-F]{40}$/.test(fingerprint) ? fingerprint : null;
}

export function installWindowsCaTrust(certInfo, run = execFileSync) {
  run('certutil', [
    '-addstore',
    '-user',
    '-f',
    'Root',
    certInfo.certPath
  ], { stdio: 'ignore' });

  const replacedFingerprint = normalizeSha1Fingerprint(
    certInfo.replacedCertificateFingerprint
  );
  let replacementRemovalError = null;
  if (replacedFingerprint) {
    try {
      run('certutil', [
        '-delstore',
        '-user',
        'Root',
        replacedFingerprint
      ], { stdio: 'ignore' });
    } catch (error) {
      // The new CA is already trusted. Retaining an obsolete exact-thumbprint
      // entry is safer than reporting installation failure or deleting broadly.
      replacementRemovalError = error;
    }
  }

  return { replacedFingerprint, replacementRemovalError };
}
