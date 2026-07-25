const DEFAULT_PROXY_PORT = 8081;

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
  const override = parsePort(environmentPort);
  if (override !== null) return { minPort: override, maxPort: override };

  const saved = settings?.get('proxyPortRange');
  return validatePortRange(saved?.minPort, saved?.maxPort) || {
    minPort: DEFAULT_PROXY_PORT,
    maxPort: DEFAULT_PROXY_PORT
  };
}
