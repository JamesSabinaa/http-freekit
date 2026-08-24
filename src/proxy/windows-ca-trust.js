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

export function removeWindowsCaTrust(fingerprints, run = execFileSync) {
  const normalizedFingerprints = [...new Set(
    (Array.isArray(fingerprints) ? fingerprints : [fingerprints])
      .map(normalizeSha1Fingerprint)
      .filter(Boolean)
  )];
  const errors = [];
  const remainingFingerprints = [];

  for (const fingerprint of normalizedFingerprints) {
    try {
      run(getWindowsCertutilPath(), [
        '-delstore',
        '-user',
        'Root',
        fingerprint
      ], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (error) {
      if (isMissingTrustEntry(error)) continue;
      errors.push({ fingerprint, error });
      remainingFingerprints.push(fingerprint);
    }
  }

  return { fingerprints: normalizedFingerprints, errors, remainingFingerprints };
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
  const replacementRemoval = removeWindowsCaTrust(replacementFingerprints, run);

  return {
    replacedFingerprint: replacementFingerprints[0] || null,
    replacementFingerprints,
    replacementRemovalError: replacementRemoval.errors[0]?.error || null,
    replacementRemovalErrors: replacementRemoval.errors,
    remainingReplacementFingerprints: replacementRemoval.remainingFingerprints
  };
}
