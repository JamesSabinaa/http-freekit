import net from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

export const PROXY_BIND_UNREACHABLE_ERROR_CODE = 'PROXY_BIND_UNREACHABLE';

function normalizeIpv6Host(host) {
  try {
    return new URL(`http://[${host}]/`).hostname.slice(1, -1);
  } catch {
    return host;
  }
}

function isIpv4Loopback(host) {
  if (net.isIP(host) !== 4) return false;
  return Number(host.split('.')[0]) === 127;
}

function isIpv4MappedLoopback(host) {
  if (!host.startsWith('::ffff:')) return false;
  const mappedIpv4 = host.slice('::ffff:'.length);
  if (net.isIP(mappedIpv4) === 4) return isIpv4Loopback(mappedIpv4);
  const groups = mappedIpv4.split(':');
  if (groups.length !== 2 || groups.some(group => !/^[0-9a-f]{1,4}$/i.test(group))) return false;
  const value = (parseInt(groups[0], 16) * 0x10000) + parseInt(groups[1], 16);
  return (value >>> 24) === 127;
}

export function classifyProxyBindHost(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return { kind: 'unknown', host: null, family: 0 };
  }

  let host = value.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (net.isIP(host) === 6) host = normalizeIpv6Host(host);
  else if (host.endsWith('.')) host = host.slice(0, -1);

  const family = net.isIP(host);
  if (host === '0.0.0.0' || host === '::') return { kind: 'wildcard', host, family };
  if (host === 'localhost' || isIpv4Loopback(host) || host === '::1' || isIpv4MappedLoopback(host)) {
    return { kind: 'loopback', host, family };
  }
  return { kind: 'specific', host, family };
}

export async function resolveProxyBindAddress(value, lookup = dnsLookup) {
  const bind = classifyProxyBindHost(value);
  if (bind.kind === 'unknown') {
    throw new TypeError('Proxy bind host must be a non-empty hostname or IP address');
  }
  if (bind.family !== 0) return bind.host;

  const result = await lookup(bind.host);
  const resolved = classifyProxyBindHost(result?.address);
  if (resolved.family === 0) {
    throw new Error(`Proxy bind hostname ${bind.host} did not resolve to an IP address`);
  }
  return resolved.host;
}

export function canAdvertisedHostReachProxy(proxyBindHost, advertisedHost) {
  const bind = classifyProxyBindHost(proxyBindHost);
  if (bind.kind === 'unknown') return true;

  const advertised = classifyProxyBindHost(advertisedHost);
  if (advertised.kind === 'unknown') return false;
  if (bind.kind === 'wildcard') {
    // Node's IPv6 wildcard listener is dual-stack unless ipv6Only is enabled;
    // the IPv4 wildcard cannot accept a native IPv6 destination.
    return bind.family === 6 || advertised.family !== 6;
  }
  return bind.host === advertised.host;
}

export function createProxyBindUnreachableError(feature, proxyBindHost, advertisedHost) {
  const bind = classifyProxyBindHost(proxyBindHost);
  const target = advertisedHost ? ` at ${advertisedHost}` : '';
  const error = new Error(
    `${feature} cannot reach the HTTP FreeKit proxy${target} while it is bound to ${bind.host || 'an unknown host'}. ` +
    'Restart FreeKit with PROXY_BIND_HOST=0.0.0.0 on a trusted network, or bind directly to the advertised host address.'
  );
  error.code = PROXY_BIND_UNREACHABLE_ERROR_CODE;
  error.proxyBindHost = bind.host;
  error.advertisedHost = advertisedHost || null;
  return error;
}
