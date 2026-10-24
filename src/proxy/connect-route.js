import net from 'node:net';
import { normalizeConnectServerName } from './connect-tls-identity.js';

function hostname(value) {
  return String(value || '').replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
}

function authority(host, port) {
  const formatted = net.isIP(host) === 6 ? `[${host}]` : host;
  return Number(port) === 443 ? formatted : `${formatted}:${port}`;
}

/** Internal binding only: SNI may name the HTTP/TLS origin, never a new dial target. */
export function createConnectRoute(connectHostname, port, serverName) {
  const address = hostname(connectHostname);
  const logicalHostname = normalizeConnectServerName(serverName);
  if (!net.isIP(address) || !logicalHostname || net.isIP(logicalHostname)) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const logicalAuthority = authority(logicalHostname, port);
  return Object.freeze({
    address,
    port,
    logicalHostname,
    logicalAuthority,
    logicalOrigin: `https://${logicalAuthority}`,
    poolKey: `${authority(address, port)}|${logicalAuthority}`
  });
}

export function connectRouteForEndpoint(route, logicalHostname, port, protocol = 'https:') {
  if (!route || !['https:', 'wss:'].includes(protocol)) return null;
  return hostname(logicalHostname) === route.logicalHostname && Number(port) === route.port ? route : null;
}

export function connectRouteForUrl(route, url) {
  return connectRouteForEndpoint(route, url.hostname, Number(url.port) || 443, url.protocol);
}

export function connectDestination(route, url) {
  return connectRouteForUrl(route, url)?.address || url.hostname.replace(/^\[|\]$/g, '');
}

function matchesAuthority(route, value) {
  if (typeof value !== 'string' || !/^[a-z0-9.-]+(?::[0-9]{1,5})?$/i.test(value)) return false;
  try {
    const parsed = new URL(`https://${value}`);
    return !parsed.username && !parsed.password && parsed.pathname === '/' && !parsed.search && !parsed.hash &&
      parsed.port !== '0' && hostname(parsed.hostname) === route.logicalHostname &&
      (Number(parsed.port) || 443) === route.port;
  } catch {
    return false;
  }
}

export function isConnectOriginTarget(target, method) {
  return typeof target === 'string' && !/[\x00-\x20\x7f#]/.test(target) &&
    (target.startsWith('/') || (target === '*' && method === 'OPTIONS'));
}

/** Zero means accepted. Static HTTP errors never echo untrusted authority data. */
export function boundH1RequestStatus(route, request) {
  if (!route) return 0;
  if (!isConnectOriginTarget(request.url, request.method)) return 400;
  const hosts = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === 'host') hosts.push(request.rawHeaders[index + 1]);
  }
  if (hosts.length !== 1) return 400;
  return matchesAuthority(route, hosts[0]) ? 0 : 421;
}

export function boundH2Authority(route, value, scheme, hostHeader) {
  if (!route) return null;
  if (scheme !== undefined && scheme !== 'https') return null;
  if (value !== undefined && value !== '' && !matchesAuthority(route, value)) return null;
  if (hostHeader !== undefined && !matchesAuthority(route, hostHeader)) return null;
  return route.logicalAuthority;
}
