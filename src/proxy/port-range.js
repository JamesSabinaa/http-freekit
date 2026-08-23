const DEFAULT_PROXY_PORT = 8081;
const PROXY_PORT_PATTERN = /^[0-9]+$/;
const INVALID_PROXY_PORT_MESSAGE =
  'Invalid PROXY_PORT: expected a decimal integer from 1 to 65535.';

function parsePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

export function validatePortRange(minPort, maxPort) {
  const min = parsePort(minPort);
  const max = parsePort(maxPort);
  if (min === null || max === null || min > max) return null;
  return { minPort: min, maxPort: max };
}

export function resolveProxyPortRange(settings, environmentPort) {
  if (environmentPort !== undefined) {
    if (typeof environmentPort !== 'string' || !PROXY_PORT_PATTERN.test(environmentPort)) {
      throw new Error(INVALID_PROXY_PORT_MESSAGE);
    }
    const override = Number(environmentPort);
    if (!Number.isSafeInteger(override) || override < 1 || override > 65535) {
      throw new Error(INVALID_PROXY_PORT_MESSAGE);
    }
    return { minPort: override, maxPort: override };
  }

  const saved = settings?.get('proxyPortRange');
  return validatePortRange(saved?.minPort, saved?.maxPort) || {
    minPort: DEFAULT_PROXY_PORT,
    maxPort: DEFAULT_PROXY_PORT
  };
}
