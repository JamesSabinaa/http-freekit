const { URL } = require('url');

/** Return true only for documents served by this app's exact loopback origin. */
function isAllowedRendererUrl(value, apiPort) {
  if (!value || apiPort == null) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      url.port === String(apiPort) &&
      url.username === '' &&
      url.password === '';
  } catch {
    return false;
  }
}

module.exports = { isAllowedRendererUrl };
