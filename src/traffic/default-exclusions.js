export const DEFAULT_EXCLUSIONS = Object.freeze([
  'update.googleapis.com',
  'optimizationguide-pa.googleapis.com',
  'safebrowsing.googleapis.com',
  'safebrowsing.google.com',
  'clients1.google.com',
  'clients2.google.com',
  'clients3.google.com',
  'clients4.google.com',
  'clients5.google.com',
  'clients6.google.com',
  'content-autofill.googleapis.com',
  'google-ohttp-relay-safebrowsing.fastly-edge.com',
  'redirector.gvt1.com',
  '*.gvt1.com',
  '*.gvt2.com',
  '*update*.googleapis.com',
  '*safebrowsing*.googleapis.com',
  '*optimizationguide*.googleapis.com',
  'bam.nr-data.net/jserrors',
  'android.clients.google.com/c2dm/register3',
  'android.clients.google.com/checkin',
  'clients2.googleusercontent.com/crx/blobs',
  'accounts.google.com/listaccounts',
  'clientservices.googleapis.com/chrome-variations/seed',
  'clientservices.googleapis.com/uma/v2',
  'www.googleapis.com/chromewebstore/v1.1/items/verify',
  'chromewebstore.googleapis.com/v2/items/-/storemetadata:batchget',
  'www.gstatic.com/og/_/js',
  'www.gstatic.com/images/branding/googlelogo',
  'www.gstatic.com/images/branding/searchlogo/ico/favicon.ico',
  'play.google.com/log',
  'ogads-pa.clients6.google.com/$rpc/google.internal.onegoogle.asyncdata.v1.asyncdataservice/getasyncdata',
  'www.google.com/async/folae',
  'www.google.com/async/ddljson',
  'www.google.com/async/newtab_ogb',
  'www.google.com/xjs/_/js',
  'www.google.com/complete/s',
  'www.google.com/complete/search',
  'www.google.com/gen_204',
  'www.google.com/chrome/',
  'google.com/domainreliability/upload',
  'www.google.com/domainreliability/upload',
  'google.co.uk/domainreliability/upload',
  'www.google.co.uk/domainreliability/upload'
]);

export const MAX_DEFAULT_EXCLUSIONS = 500;
const MAX_PATTERN_LENGTH = 1024;

function normalizeRequestHost(value) {
  let host = String(value || '').trim().toLowerCase();
  if (host.startsWith('[')) {
    const closingBracket = host.indexOf(']');
    if (closingBracket !== -1) host = host.slice(0, closingBracket + 1);
  } else {
    host = host.replace(/:\d+$/, '');
  }
  return host.replace(/\.$/, '');
}

function requestTarget(request) {
  let host = normalizeRequestHost(request?.host);
  let requestPath = String(request?.path || '');
  if ((!host || !requestPath) && request?.url) {
    try {
      const url = new URL(String(request.url));
      if (!host) host = normalizeRequestHost(url.hostname);
      if (!requestPath) requestPath = `${url.pathname}${url.search}`;
    } catch {}
  }
  if (requestPath && !requestPath.startsWith('/')) requestPath = `/${requestPath}`;
  return { host, path: requestPath.toLowerCase() };
}

function normalizePattern(pattern, index) {
  if (typeof pattern !== 'string') {
    throw new TypeError(`patterns[${index}] must be a string`);
  }
  let value = pattern.trim();
  if (!value || value.startsWith('#')) return null;
  if (value.length > MAX_PATTERN_LENGTH) {
    throw new TypeError(`patterns[${index}] must be at most ${MAX_PATTERN_LENGTH} characters`);
  }

  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new TypeError(`patterns[${index}] is not a valid URL or hostname pattern`);
    }
    value = `${parsed.hostname}${parsed.pathname}${parsed.search}`;
  }

  const slashIndex = value.indexOf('/');
  let host = (slashIndex === -1 ? value : value.slice(0, slashIndex)).toLowerCase();
  const path = slashIndex === -1 ? '' : value.slice(slashIndex).toLowerCase();
  host = normalizeRequestHost(host);
  if (!host || host === '*' || !/^[a-z\d*.-]+$/.test(host) || host.includes('..')) {
    throw new TypeError(`patterns[${index}] has an invalid hostname pattern`);
  }
  if (path && /[\r\n\0]/.test(path)) {
    throw new TypeError(`patterns[${index}] has an invalid path prefix`);
  }
  return `${host}${path}`;
}

export function normalizeDefaultExclusions(patterns) {
  if (!Array.isArray(patterns)) throw new TypeError('patterns must be an array');
  if (patterns.length > MAX_DEFAULT_EXCLUSIONS) {
    throw new TypeError(`patterns must contain no more than ${MAX_DEFAULT_EXCLUSIONS} entries`);
  }
  const normalized = [];
  const seen = new Set();
  for (let index = 0; index < patterns.length; index++) {
    const pattern = normalizePattern(patterns[index], index);
    if (!pattern || seen.has(pattern)) continue;
    seen.add(pattern);
    normalized.push(pattern);
  }
  return normalized;
}

function wildcardHostMatches(host, pattern) {
  let hostIndex = 0;
  let patternIndex = 0;
  let starIndex = -1;
  let retryHostIndex = 0;
  while (hostIndex < host.length) {
    if (patternIndex < pattern.length && pattern[patternIndex] === host[hostIndex]) {
      hostIndex++;
      patternIndex++;
    } else if (patternIndex < pattern.length && pattern[patternIndex] === '*') {
      starIndex = patternIndex++;
      retryHostIndex = hostIndex;
    } else if (starIndex !== -1) {
      patternIndex = starIndex + 1;
      hostIndex = ++retryHostIndex;
    } else {
      return false;
    }
  }
  while (patternIndex < pattern.length && pattern[patternIndex] === '*') patternIndex++;
  return patternIndex === pattern.length;
}

export function createDefaultExclusionMatcher(patterns = DEFAULT_EXCLUSIONS) {
  const rules = patterns.map(pattern => {
    const slashIndex = pattern.indexOf('/');
    const hostPattern = slashIndex === -1 ? pattern : pattern.slice(0, slashIndex);
    const pathPrefix = slashIndex === -1 ? '' : pattern.slice(slashIndex);
    return {
      pathPrefix,
      matchesHost: hostPattern.includes('*')
        ? host => wildcardHostMatches(host, hostPattern)
        : host => host === hostPattern
    };
  });
  return request => {
    const { host, path } = requestTarget(request);
    if (!host) return false;
    return rules.some(rule =>
      rule.matchesHost(host) && (!rule.pathPrefix || path.startsWith(rule.pathPrefix))
    );
  };
}

export function matchesDefaultExclusion(request, patterns = DEFAULT_EXCLUSIONS) {
  return createDefaultExclusionMatcher(patterns)(request);
}

export function filterDefaultExclusions(requests, patterns = DEFAULT_EXCLUSIONS) {
  const matches = createDefaultExclusionMatcher(patterns);
  return requests.filter(request => !matches(request));
}
