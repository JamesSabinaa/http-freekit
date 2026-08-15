export const TLS_FINGERPRINT_MODES = Object.freeze(['default', 'passthrough']);

export class TlsFingerprintConfigError extends TypeError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'TlsFingerprintConfigError';
    this.code = 'ERR_INVALID_TLS_FINGERPRINT';
  }
}

export function validateTlsFingerprint(value, presets = {}) {
  const supported = typeof value === 'string' && (
    TLS_FINGERPRINT_MODES.includes(value) ||
    Object.prototype.hasOwnProperty.call(presets, value)
  );
  if (!supported) {
    const choices = [...Object.keys(presets), ...TLS_FINGERPRINT_MODES].join(', ');
    throw new TlsFingerprintConfigError(
      `Invalid TLS fingerprint. Use one of: ${choices}`
    );
  }
  return value;
}

export function restoreSavedTlsFingerprintSetting(proxy, settings, logger = console) {
  const saved = settings.get('tlsFingerprint');
  if (saved === undefined) return false;

  try {
    proxy.setTlsFingerprint(saved);
    return true;
  } catch (error) {
    if (error?.code !== 'ERR_INVALID_TLS_FINGERPRINT') throw error;
    logger.error?.(`[Boot] Ignoring invalid saved TLS fingerprint: ${error.message}`);
    return false;
  }
}
