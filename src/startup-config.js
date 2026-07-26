const DEFAULT_API_PORT = 8001;
const API_PORT_PATTERN = /^[0-9]+$/;
const INVALID_API_PORT_MESSAGE = 'Invalid API_PORT: expected a decimal integer from 1 to 65535.';

export function parseApiPort(value) {
  if (value === undefined || value === '') return DEFAULT_API_PORT;

  if (typeof value !== 'string' || !API_PORT_PATTERN.test(value)) {
    throw new Error(INVALID_API_PORT_MESSAGE);
  }

  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(INVALID_API_PORT_MESSAGE);
  }

  return port;
}

export async function startWithValidatedApiPort(value, start) {
  const port = parseApiPort(value);
  return start(port);
}
