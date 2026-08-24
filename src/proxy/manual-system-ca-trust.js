export function isManualSystemCaTrustAcknowledged(platform, environment = {}) {
  return platform !== 'win32' && environment.HTTP_FREEKIT_SYSTEM_CA_TRUSTED === '1';
}

export function applyManualSystemCaTrustAcknowledgement({
  ca,
  initialization,
  platform,
  environment = {},
  logger = console
}) {
  const acknowledged = isManualSystemCaTrustAcknowledged(platform, environment);
  const currentFingerprint = ca?.getCertInfo?.().certificateFingerprint;
  const initializedFingerprint = initialization?.fingerprint;
  const fingerprintMatches = typeof currentFingerprint === 'string' &&
    currentFingerprint.length > 0 && currentFingerprint === initializedFingerprint;
  const generatedThisStartup = initialization?.generatedCa === true;
  const trusted = acknowledged && fingerprintMatches && !generatedThisStartup;

  ca.systemTrustInstalled = false;
  if (!acknowledged) return { acknowledged, trusted, generatedThisStartup };
  if (!fingerprintMatches) {
    logger.warn?.(
      '[Boot] Ignoring manual system-CA trust acknowledgement because the initialized CA fingerprint changed'
    );
    return { acknowledged, trusted, generatedThisStartup };
  }
  if (generatedThisStartup) {
    logger.warn?.(
      '[Boot] Ignoring HTTP_FREEKIT_SYSTEM_CA_TRUSTED=1 for a CA generated during this startup; ' +
      'install this CA and acknowledge it on a later launch'
    );
    return { acknowledged, trusted, generatedThisStartup };
  }

  if (ca.getCertInfo().certificateReplacementPending) {
    ca.acknowledgeReplacementMigration();
  }
  ca.systemTrustInstalled = true;
  return { acknowledged, trusted, generatedThisStartup };
}
