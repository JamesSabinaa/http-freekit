const MAX_BROWSER_URL_LENGTH = 16 * 1024;

/**
 * Validate and normalize a URL before passing it to a browser process.
 * Only web URLs are accepted so a caller cannot inject Chromium command-line
 * flags or trigger local file/custom-protocol handlers.
 */
export function normalizeBrowserUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('A URL is required');
  }

  const rawUrl = value.trim();
  if (rawUrl.length > MAX_BROWSER_URL_LENGTH) {
    throw new Error('URL is too long');
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only HTTP and HTTPS URLs can be opened');
  }

  return parsed.href;
}
