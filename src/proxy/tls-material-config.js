export const MAX_TLS_MATERIAL_ENTRIES = 500;

export class TlsMaterialConfigError extends TypeError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'TlsMaterialConfigError';
    this.code = 'ERR_INVALID_TLS_MATERIAL_CONFIG';
  }
}

function restoreTlsMaterialCollection(proxy, settings, {
  key,
  label,
  apply,
  logger
}) {
  const saved = settings.get(key);
  if (saved === undefined) return false;

  try {
    apply(saved);
    return true;
  } catch (error) {
    if (error?.code !== 'ERR_INVALID_TLS_MATERIAL_CONFIG') throw error;
    logger.error?.(`[Boot] Ignoring invalid saved ${label}: ${error.message}`);
    return false;
  }
}

export function restoreSavedTlsMaterialSettings(proxy, settings, logger = console) {
  return {
    clientCertificates: restoreTlsMaterialCollection(proxy, settings, {
      key: 'clientCertificates',
      label: 'client certificates',
      apply: value => proxy.setClientCertificates(value),
      logger
    }),
    trustedCAs: restoreTlsMaterialCollection(proxy, settings, {
      key: 'trustedCAs',
      label: 'trusted CAs',
      apply: value => proxy.setTrustedCAs(value),
      logger
    })
  };
}
