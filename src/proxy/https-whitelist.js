import net from 'node:net';

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

export function normalizeExactTlsHostname(value) {
  if (typeof value !== 'string') return '';
  let candidate = value.trim().replace(/\.$/, '');
  if (!candidate || /[\r\n\0\s/\\@?#*]/.test(candidate)) return '';

  const bracketed = candidate.match(/^\[([^\]]+)\]$/);
  if (bracketed) {
    if (!net.isIP(bracketed[1])) return '';
    candidate = bracketed[1];
  }
  if (candidate.includes('[') || candidate.includes(']')) return '';
  const ipVersion = net.isIP(candidate);
  if (ipVersion === 4) return candidate;
  if (ipVersion === 6) {
    // URL parsing gives equivalent IPv6 spellings one identity. Preserve any
    // zone suffix separately because URL hosts do not support scoped addresses.
    const zoneIndex = candidate.indexOf('%');
    const address = zoneIndex === -1 ? candidate : candidate.slice(0, zoneIndex);
    const zone = zoneIndex === -1 ? '' : candidate.slice(zoneIndex).toLowerCase();
    return new URL(`https://[${address}]/`).hostname.slice(1, -1) + zone;
  }
  if (candidate.includes(':')) return '';

  try {
    const parsed = new URL(`https://${candidate}/`);
    if (parsed.username || parsed.password || parsed.port || parsed.pathname !== '/'
      || parsed.search || parsed.hash) return '';
    return parsed.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
}

export function normalizeTlsHostnamePattern(value, {
  allowSubdomainWildcard = false,
  allowGlobalWildcard = false
} = {}) {
  if (typeof value !== 'string') return '';
  const candidate = value.trim();
  if (candidate === '*') return allowGlobalWildcard ? '*' : '';
  if (candidate.startsWith('*.')) {
    if (!allowSubdomainWildcard) return '';
    const suffix = normalizeExactTlsHostname(candidate.slice(2));
    return suffix && !net.isIP(suffix) ? `*.${suffix}` : '';
  }
  if (candidate.includes('*')) return '';
  return normalizeExactTlsHostname(candidate);
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
    if (!normalizeExactTlsHostname(pattern)) {
      invalid(`HTTPS whitelist entry ${index} must be an exact hostname or IP address`);
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
