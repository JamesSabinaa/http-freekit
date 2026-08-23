export const HTTP2_MODES = Object.freeze(['all', 'h2-only', 'disabled']);
export const DEFAULT_HTTP2_MODE = 'disabled';

export class Http2ConfigError extends TypeError {
  constructor(message) {
    super(message);
    this.name = 'Http2ConfigError';
    this.code = 'ERR_INVALID_HTTP2_MODE';
  }
}

export function validateHttp2Mode(value) {
  if (!HTTP2_MODES.includes(value)) {
    throw new Http2ConfigError(`Invalid HTTP/2 mode. Use one of: ${HTTP2_MODES.join(', ')}`);
  }
  return value;
}

export function restoreSavedHttp2Setting(proxy, settings, logger = console) {
  const saved = settings.get('http2Enabled');
  if (saved === undefined) return false;
  try {
    proxy.setHttp2Config(saved);
    return true;
  } catch (error) {
    if (error?.code !== 'ERR_INVALID_HTTP2_MODE') throw error;
    proxy.setHttp2Config(DEFAULT_HTTP2_MODE);
    logger.error?.(
      `[Boot] Invalid saved HTTP/2 mode; using ${DEFAULT_HTTP2_MODE}: ${error.message}`
    );
    return false;
  }
}
