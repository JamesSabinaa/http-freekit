import net from 'node:net';
import { domainToASCII } from 'node:url';

export const SUPPORTED_UPSTREAM_PROXY_TYPES = new Set([
  'http', 'https', 'socks4', 'socks4a', 'socks5', 'socks5h'
]);

const DEFAULT_PORTS = {
  http: 8080,
  https: 443,
  socks4: 1080,
  socks4a: 1080,
  socks5: 1080,
  socks5h: 1080
};

export class UpstreamProxyConfigError extends TypeError {
  constructor(message) {
    super(message);
    this.name = 'UpstreamProxyConfigError';
    this.code = 'ERR_INVALID_UPSTREAM_PROXY_CONFIG';
  }
}

function invalid(message) {
  throw new UpstreamProxyConfigError(message);
}

export function normalizeNoProxyEntries(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(',');
  return values
    .flatMap(entry => String(entry).split(','))
    .map(entry => entry.trim())
    .filter(Boolean);
}

function normalizeHost(value) {
  if (typeof value !== 'string') invalid('Upstream proxy host must be a string');
  const host = value.trim();
  if (!host) invalid('Upstream proxy host is required');
  if (/^[\d.]+$/.test(host) && net.isIP(host) !== 4) {
    invalid('Upstream proxy host is not a valid IPv4 address');
  }

  if (host.startsWith('[') || host.endsWith(']')) {
    const match = host.match(/^\[([^\]]+)\]$/);
    if (!match || net.isIP(match[1]) !== 6) {
      invalid('Upstream proxy host is not a valid bracketed IPv6 address');
    }
    return host;
  }
  if (net.isIP(host)) return host;
  if (/[:\s/?#@\\]/.test(host)) invalid('Upstream proxy host is not a valid hostname');

  const hasTrailingDot = host.endsWith('.');
  const asciiHost = domainToASCII(hasTrailingDot ? host.slice(0, -1) : host);
  const labels = asciiHost.split('.');
  if (!asciiHost || asciiHost.length > 253 || labels.some(label =>
    !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
  )) {
    invalid('Upstream proxy host is not a valid hostname');
  }
  return asciiHost + (hasTrailingDot ? '.' : '');
}

export function normalizeUpstreamProxyConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    invalid('Upstream proxy configuration must be an object');
  }

  const type = config.type === undefined ? 'http' :
    typeof config.type === 'string' ? config.type.trim().toLowerCase() : '';
  if (!SUPPORTED_UPSTREAM_PROXY_TYPES.has(type)) {
    invalid(`Unsupported upstream proxy type: ${String(config.type)}`);
  }

  const host = normalizeHost(config.host);
  const port = config.port === undefined ? DEFAULT_PORTS[type] : config.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    invalid('Upstream proxy port must be an integer between 1 and 65535');
  }
  if (config.auth !== undefined && config.auth !== null && typeof config.auth !== 'string') {
    invalid('Upstream proxy auth must be a string or null');
  }

  return {
    host,
    port,
    auth: config.auth || null,
    type,
    noProxy: normalizeNoProxyEntries(config.noProxy)
  };
}

export function restoreUpstreamProxySetting(proxy, settings, logger = console) {
  const saved = settings.get('upstreamProxy');
  if (!saved) return false;
  try {
    proxy.setUpstreamProxy(saved);
    return true;
  } catch (error) {
    if (error?.code !== 'ERR_INVALID_UPSTREAM_PROXY_CONFIG') throw error;
    logger.error?.(`[Boot] Ignoring invalid saved upstream proxy: ${error.message}`);
    try {
      settings.set('upstreamProxy', null);
    } catch (persistError) {
      logger.error?.(`[Boot] Could not clear invalid saved upstream proxy: ${persistError.message}`);
    }
    return false;
  }
}
