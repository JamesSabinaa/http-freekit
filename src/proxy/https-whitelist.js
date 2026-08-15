export const MAX_HTTPS_WHITELIST_HOSTS = 500;
export const MAX_HTTPS_WHITELIST_PATTERN_LENGTH = 1024;

export class HttpsWhitelistConfigError extends TypeError {
  constructor(message) {
    super(message);
    this.name = 'HttpsWhitelistConfigError';
    this.code = 'ERR_INVALID_HTTPS_WHITELIST';
  }
}

function invalid(message) {
  throw new HttpsWhitelistConfigError(message);
}

export function normalizeTlsHostname(value) {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

function ownDataDescriptor(value, property) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, property);
  } catch {
    invalid('HTTPS whitelist must be a readable plain array');
  }
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    invalid(`HTTPS whitelist entry ${String(property)} must be an own data value`);
  }
  return descriptor;
}

/**
 * Validate an HTTPS verification-whitelist candidate without consulting its
 * prototype or invoking indexed accessors. The returned value is always a new,
 * ordinary array, so caller-owned mutations and exotic array properties cannot
 * reach runtime state or settings persistence.
 */
export function normalizeHttpsWhitelist(hosts) {
  let isArray = false;
  try {
    isArray = Array.isArray(hosts);
  } catch {
    invalid('HTTPS whitelist must be an array');
  }
  if (!isArray) invalid('HTTPS whitelist must be an array');

  const length = ownDataDescriptor(hosts, 'length').value;
  if (!Number.isSafeInteger(length) || length < 0) {
    invalid('HTTPS whitelist has an invalid length');
  }
  if (length > MAX_HTTPS_WHITELIST_HOSTS) {
    invalid(
      `HTTPS whitelist must contain no more than ${MAX_HTTPS_WHITELIST_HOSTS} entries`
    );
  }

  const normalized = [];
  for (let index = 0; index < length; index++) {
    const host = ownDataDescriptor(hosts, String(index)).value;
    if (typeof host !== 'string') {
      invalid(`HTTPS whitelist entry ${index} must be a string`);
    }
    const pattern = host.trim();
    if (!pattern) invalid(`HTTPS whitelist entry ${index} must not be empty`);
    if (pattern.length > MAX_HTTPS_WHITELIST_PATTERN_LENGTH) {
      invalid(
        `HTTPS whitelist entry ${index} must be at most ` +
        `${MAX_HTTPS_WHITELIST_PATTERN_LENGTH} characters`
      );
    }
    if (/[\r\n\0]/.test(pattern)) {
      invalid(`HTTPS whitelist entry ${index} contains invalid control characters`);
    }
    if (!normalizeTlsHostname(pattern)) {
      invalid(`HTTPS whitelist entry ${index} is not a valid host pattern`);
    }
    normalized.push(pattern);
  }
  return normalized;
}

export function restoreHttpsWhitelistSetting(proxy, settings, logger = console) {
  const saved = settings.get('httpsWhitelist');
  if (saved === undefined) return false;

  try {
    proxy.setHttpsWhitelist(saved);
    return true;
  } catch (error) {
    if (error?.code !== 'ERR_INVALID_HTTPS_WHITELIST') throw error;
    logger.error?.(`[Boot] Ignoring invalid saved HTTPS whitelist: ${error.message}`);
    return false;
  }
}
