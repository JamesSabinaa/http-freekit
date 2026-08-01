const PROTOCOL_SCHEME = 'http-freekit';
const MAX_DEEP_LINK_LENGTH = 20 * 1024;
const { isHarTarget } = require('./har-deep-link.cjs');

function parseOpenDeepLink(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Missing HTTP FreeKit link');
  }
  if (value.length > MAX_DEEP_LINK_LENGTH) {
    throw new Error('HTTP FreeKit link is too long');
  }

  let deepLink;
  try {
    deepLink = new URL(value);
  } catch {
    throw new Error('Invalid HTTP FreeKit link');
  }

  if (deepLink.protocol.toLowerCase() !== `${PROTOCOL_SCHEME}:`) {
    throw new Error(`Expected an ${PROTOCOL_SCHEME}: link`);
  }
  if (deepLink.hostname.toLowerCase() !== 'open' || !['', '/'].includes(deepLink.pathname)) {
    throw new Error('Unknown HTTP FreeKit link action');
  }

  const target = deepLink.searchParams.get('url');
  if (!target) {
    throw new Error('The HTTP FreeKit link is missing its url parameter');
  }

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    throw new Error('The target URL is invalid');
  }
  const webTarget = targetUrl.protocol === 'http:' || targetUrl.protocol === 'https:';
  const localHarTarget = targetUrl.protocol === 'file:' && isHarTarget(targetUrl);
  if (!webTarget && !localHarTarget) {
    throw new Error('Only HTTP, HTTPS, and .har file URLs can be opened');
  }

  return targetUrl.href;
}

function findDeepLinkArg(argv) {
  if (!Array.isArray(argv)) return null;
  return argv.find(arg => (
    typeof arg === 'string' && arg.toLowerCase().startsWith(`${PROTOCOL_SCHEME}:`)
  )) || null;
}

module.exports = { PROTOCOL_SCHEME, parseOpenDeepLink, findDeepLinkArg };
