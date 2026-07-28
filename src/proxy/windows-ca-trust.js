import { execFileSync } from 'node:child_process';
import path from 'node:path';

function normalizeSha1Fingerprint(value) {
  const fingerprint = String(value || '').trim().replace(/:/g, '').toUpperCase();
  return /^[0-9A-F]{40}$/.test(fingerprint) ? fingerprint : null;
}

function isMissingTrustEntry(error) {
  const diagnostic = [error?.message, error?.stdout, error?.stderr]
    .filter(value => value !== undefined && value !== null)
    .map(value => Buffer.isBuffer(value) ? value.toString('utf8') : String(value))
    .join('\n');
  return /\b(?:0x80092004|CRYPT_E_NOT_FOUND)\b/i.test(diagnostic);
}

export function getWindowsCertutilPath(environment = process.env) {
  const windowsRoot = path.win32.isAbsolute(environment.SystemRoot || '')
    ? environment.SystemRoot
    : 'C:\\Windows';
  return path.win32.join(windowsRoot, 'System32', 'certutil.exe');
}

export function installWindowsCaTrust(certInfo, run = execFileSync) {
  const certutilPath = getWindowsCertutilPath();
  run(certutilPath, [
    '-addstore',
    '-user',
    '-f',
    'Root',
    certInfo.certPath
  ], { stdio: 'ignore' });

  const replacementFingerprints = [...new Set([
    ...(Array.isArray(certInfo.replacedCertificateFingerprints)
      ? certInfo.replacedCertificateFingerprints
      : []),
    certInfo.replacedCertificateFingerprint
  ].map(normalizeSha1Fingerprint).filter(Boolean))];
  const replacementRemovalErrors = [];
  const remainingReplacementFingerprints = [];
  for (const replacedFingerprint of replacementFingerprints) {
    try {
      run(certutilPath, [
        '-delstore',
        '-user',
        'Root',
        replacedFingerprint
      ], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (error) {
      if (isMissingTrustEntry(error)) continue;
      // The new CA is already trusted. Retaining an obsolete exact-thumbprint
      // entry is safer than reporting installation failure or deleting broadly.
      replacementRemovalErrors.push({ fingerprint: replacedFingerprint, error });
      remainingReplacementFingerprints.push(replacedFingerprint);
    }
  }

  return {
    replacedFingerprint: replacementFingerprints[0] || null,
    replacementFingerprints,
    replacementRemovalError: replacementRemovalErrors[0]?.error || null,
    replacementRemovalErrors,
    remainingReplacementFingerprints
  };
}
