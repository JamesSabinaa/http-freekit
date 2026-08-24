export const INVALID_SEND_URL_CODE = 'ERR_INVALID_SEND_URL';

export class SendUrlValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SendUrlValidationError';
    this.code = INVALID_SEND_URL_CODE;
  }
}

function hasExplicitUrlScheme(value) {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/.exec(value);
  if (!match) return false;
  // cURL treats the common HOST:PORT form as an HTTP destination when no
  // scheme was supplied. Everything else with a leading scheme token is
  // explicit and must not be silently rewritten.
  return !/^\d+(?:[/?#]|$)/.test(match[2]);
}

export function normalizeSendUrl(value, options = {}) {
  if (typeof value !== 'string') {
    throw new SendUrlValidationError('Send URL must be a string');
  }
  const trimmed = value.trim();
  if (!trimmed) throw new SendUrlValidationError('Send URL must not be empty');
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new SendUrlValidationError('Send URL cannot contain control characters');
  }

  const inferHttp = options.inferHttp === true;
  const candidate = inferHttp && !hasExplicitUrlScheme(trimmed)
    ? `http://${trimmed}`
    : trimmed;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new SendUrlValidationError('Send URL must be a valid absolute HTTP or HTTPS URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SendUrlValidationError(`Unsupported Send URL protocol: ${parsed.protocol}`);
  }
  if (!/^https?:\/\/[^/\\]/i.test(candidate)) {
    throw new SendUrlValidationError('Send URL must be a valid absolute HTTP or HTTPS URL');
  }
  if (!parsed.hostname) {
    throw new SendUrlValidationError('Send URL must include a hostname');
  }
  if (!parsed.hostname.includes(':')) {
    const hostname = parsed.hostname.endsWith('.')
      ? parsed.hostname.slice(0, -1)
      : parsed.hostname;
    const labels = hostname.split('.');
    if (labels.some(label => !label || label.length > 63 ||
        label.startsWith('-') || label.endsWith('-'))) {
      throw new SendUrlValidationError('Send URL contains an invalid hostname');
    }
  }
  if (parsed.port === '0') {
    throw new SendUrlValidationError('Send URL port must be between 1 and 65535');
  }
  try {
    decodeURIComponent(parsed.username);
    decodeURIComponent(parsed.password);
  } catch {
    throw new SendUrlValidationError('Send URL contains invalid percent-encoding in its credentials');
  }
  return parsed;
}

export function normalizeCurlDestination(value) {
  if (typeof value !== 'string') normalizeSendUrl(value, { inferHttp: true });
  const trimmed = value.trim();
  const candidate = hasExplicitUrlScheme(trimmed) ? trimmed : `http://${trimmed}`;
  normalizeSendUrl(candidate);
  return candidate;
}
