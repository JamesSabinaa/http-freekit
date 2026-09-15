const SENSITIVE_HEADERS = ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token', 'proxy-authorization'];

export function trafficToHar(requests, options = {}) {
  const maskSensitive = options.maskSensitive !== undefined ? options.maskSensitive : true;

  const maskHeaderValue = (name, value) => {
    if (maskSensitive && SENSITIVE_HEADERS.includes(name.toLowerCase())) {
      return '[REDACTED]';
    }
    return String(value);
  };

  const toHarHeaders = headers => Object.entries(headers || {}).flatMap(([name, value]) => {
    const values = Array.isArray(value) ? value : [value];
    return values.map(item => ({ name, value: maskHeaderValue(name, item) }));
  });

  const toHarCookies = cookies => {
    if (!Array.isArray(cookies)) return [];
    if (!maskSensitive) return cookies;

    return cookies.map(cookie => {
      if (cookie === null || typeof cookie !== 'object' || Array.isArray(cookie)) return cookie;
      return { ...cookie, value: '[REDACTED]' };
    });
  };

  const firstHeaderValue = value => Array.isArray(value)
    ? String(value[0] ?? '')
    : String(value ?? '');
  const getHeaderValue = (headers, name) => {
    const normalizedName = name.toLowerCase();
    const entry = Object.entries(headers || {}).find(([headerName]) => headerName.toLowerCase() === normalizedName);
    return firstHeaderValue(entry?.[1]);
  };

  return {
    log: {
      version: '1.2',
      creator: { name: 'HTTP FreeKit', version: '1.0.0' },
      entries: requests.map(req => {
        const reqHeaders = toHarHeaders(req.requestHeaders);
        const resHeaders = toHarHeaders(req.responseHeaders);

        const reqContentType = getHeaderValue(req.requestHeaders, 'content-type');
        const resContentType = getHeaderValue(req.responseHeaders, 'content-type');
        const requestBody = toHarBody(
          req.requestBody,
          req.requestBodyEncoding,
          req.requestBodyTruncated && req.requestBodyCapturedSize === 0
        );
        const responseBody = toHarBody(
          req.responseBody,
          req.responseBodyEncoding,
          req.responseBodyTruncated && req.responseBodyCapturedSize === 0
        );
        const requestTruncation = toHarTruncation(req, 'request', requestBody);
        const responseTruncation = toHarTruncation(req, 'response', responseBody);
        const requestContentDecoded = req.requestBodyContentDecoded === true;
        const responseContentDecoded = req.responseBodyContentDecoded === true;
        const requestWireBodySize = toHarSize(req.requestBodySize);
        const responseWireBodySize = toHarSize(req.responseBodySize);
        const responseDecodedBodySize = toHarSize(
          req.responseBodyDecodedSize,
          responseWireBodySize
        );
        const httpVersion = req.protocol === 'h2' ? 'HTTP/2' : 'HTTP/1.1';
        const requestHttpVersion = req.requestHttpVersion || httpVersion;
        const responseHttpVersion = req.responseHttpVersion || httpVersion;
        const requestPostDataParams = Array.isArray(req.requestPostDataParams)
          ? req.requestPostDataParams
          : null;
        const hasPostData = !!requestBody || requestPostDataParams !== null || !!requestTruncation ||
          requestContentDecoded;

        return {
          startedDateTime: new Date(req.timestamp).toISOString(),
          time: req.duration || 0,
          request: {
            method: req.method || 'GET',
            url: req.url || '',
            httpVersion: requestHttpVersion,
            cookies: toHarCookies(req.requestCookies),
            headers: reqHeaders,
            queryString: parseQueryString(req.url),
            postData: hasPostData ? {
              mimeType: req.requestPostDataMimeType || reqContentType,
              ...(requestBody ? { text: requestBody.text }
                : req.requestBodyTextPresent === true ? { text: '' } : {}),
              ...(requestBody?.encoding ? { encoding: requestBody.encoding } : {}),
              ...(requestPostDataParams !== null ? { params: requestPostDataParams } : {}),
              ...(requestContentDecoded ? { _contentDecoded: true } : {}),
              ...(requestTruncation || {})
            } : undefined,
            headersSize: -1,
            bodySize: requestWireBodySize
          },
          response: {
            status: req.statusCode || 0,
            statusText: req.statusMessage || '',
            httpVersion: responseHttpVersion,
            cookies: toHarCookies(req.responseCookies),
            headers: resHeaders,
            content: {
              size: responseTruncation?._capturedSize ?? responseDecodedBodySize,
              mimeType: req.responseContentMimeType || resContentType,
              text: responseBody?.text || '',
              ...(responseBody?.encoding ? { encoding: responseBody.encoding } : {}),
              ...(responseContentDecoded ? { _contentDecoded: true } : {}),
              ...(responseTruncation || {})
            },
            redirectURL: getHeaderValue(req.responseHeaders, 'location'),
            headersSize: -1,
            bodySize: responseWireBodySize
          },
          cache: {},
          timings: {
            send: 0,
            wait: req.duration || 0,
            receive: 0
          }
        };
      })
    }
  };
}

function utf8ByteLength(value) {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff &&
        index + 1 < value.length &&
        value.charCodeAt(index + 1) >= 0xdc00 &&
        value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}

function boundedHarDocument(entries, totalEntries, maxBytes, exportedEntries = entries.length) {
  const omittedEntries = totalEntries - exportedEntries;
  const warning = omittedEntries > 0
    ? `${omittedEntries} older traffic entr${omittedEntries === 1 ? 'y was' : 'ies were'} ` +
      `omitted so this HAR remains within the ${maxBytes}-byte import limit.`
    : '';
  return {
    log: {
      version: '1.2',
      creator: { name: 'HTTP FreeKit', version: '1.0.0' },
      ...(omittedEntries > 0 ? {
        comment: warning,
        _httpFreeKitExport: {
          complete: false,
          totalEntries,
          exportedEntries,
          omittedEntries,
          maxBytes,
          warning
        }
      } : {}),
      entries
    }
  };
}

function boundedHarByteLength(totalEntries, exportedEntries, maxBytes, entriesBytes) {
  const envelope = boundedHarDocument([], totalEntries, maxBytes, exportedEntries);
  // Replace the empty array contents while retaining its two brackets.
  return utf8ByteLength(JSON.stringify(envelope)) - 2 + entriesBytes + 2 +
    Math.max(0, exportedEntries - 1);
}

function bodyJsonLowerBound(request, side) {
  if (request?.[`${side}BodyTruncated`] === true &&
      request?.[`${side}BodyCapturedSize`] === 0) return 0;
  const body = request?.[`${side}Body`];
  if (!body) return 0;
  const text = typeof body === 'string' ? body : String(body);
  if (String(request?.[`${side}BodyEncoding`] || '').toLowerCase() !== 'base64') {
    return text.length;
  }
  const markerIndex = text.indexOf(';base64,');
  if (!text.startsWith('data:') || markerIndex < 0) return text.length;
  // Captured traffic uses canonical base64 without whitespace. If an embedder
  // supplies a non-canonical value, fall back to no lower bound rather than
  // overestimating the text that toHarBody will compact.
  return /\s/.test(text)
    ? 0
    : text.length - markerIndex - ';base64,'.length;
}

// Convert newest entries first and stop before the complete compact JSON
// document would exceed the corresponding import ceiling. Converting one row
// at a time avoids first constructing an unbounded all-traffic HAR merely to
// discover that it cannot be imported again.
export function trafficToBoundedHar(requests, options = {}) {
  if (!Array.isArray(requests)) throw new TypeError('HAR export requests must be an array');
  const maxBytes = options.maxBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError('HAR export byte limit must be a positive safe integer');
  }

  const selectedNewestFirst = [];
  let selectedEntriesBytes = 0;
  for (let index = requests.length - 1; index >= 0; index--) {
    const bodyLowerBound = bodyJsonLowerBound(requests[index], 'request') +
      bodyJsonLowerBound(requests[index], 'response');
    if (selectedEntriesBytes + bodyLowerBound > maxBytes) break;
    const entry = trafficToHar([requests[index]], options).log.entries[0];
    const serializedEntry = JSON.stringify(entry);
    const entryBytes = utf8ByteLength(serializedEntry);
    const candidateCount = selectedNewestFirst.length + 1;
    const candidateBytes = boundedHarByteLength(
      requests.length,
      candidateCount,
      maxBytes,
      selectedEntriesBytes + entryBytes
    );
    if (candidateBytes > maxBytes) break;
    selectedNewestFirst.push(entry);
    selectedEntriesBytes += entryBytes;
  }

  const entries = selectedNewestFirst.reverse();
  const har = boundedHarDocument(entries, requests.length, maxBytes);
  const actualBytes = boundedHarByteLength(
    requests.length,
    entries.length,
    maxBytes,
    selectedEntriesBytes
  );
  if (actualBytes > maxBytes) {
    throw new RangeError('HAR export limit is too small for the bounded export metadata');
  }
  return har;
}

function parseQueryString(url) {
  if (!url) return [];
  try {
    const parsed = new URL(url);
    return [...parsed.searchParams.entries()].map(([name, value]) => ({ name, value }));
  } catch { return []; }
}

function toHarBody(body, bodyEncoding, omitted = false) {
  if (omitted) return null;
  if (!body) return null;
  if (typeof body !== 'string') body = String(body);

  const dataUriMatch = String(bodyEncoding || '').toLowerCase() === 'base64'
    ? body.match(/^data:([^;,]+(?:;[^,]*)?);base64,([A-Za-z0-9+/=\r\n]*)$/)
    : null;
  if (dataUriMatch !== null) {
    return {
      text: dataUriMatch[2].replace(/\s+/g, ''),
      encoding: 'base64'
    };
  }

  return { text: body };
}

function toHarSize(value, fallback = 0) {
  return Number.isSafeInteger(value) && (value >= 0 || value === -1)
    ? value
    : fallback;
}

function toHarTruncation(request, side, body) {
  if (request[`${side}BodyTruncated`] !== true) return null;
  const capturedSize = Number.isSafeInteger(request[`${side}BodyCapturedSize`])
    && request[`${side}BodyCapturedSize`] >= 0
    ? request[`${side}BodyCapturedSize`]
    : body?.encoding === 'base64'
      ? Buffer.byteLength(body.text, 'base64')
      : Buffer.byteLength(body?.text || '');
  const fallbackOriginalSize = toHarSize(request[`${side}BodySize`]);
  const originalSize = toHarSize(
    request[`${side}BodyDecodedSize`],
    fallbackOriginalSize >= capturedSize ? fallbackOriginalSize : -1
  );
  return {
    comment: originalSize === -1
      ? `Body capture truncated: ${capturedSize} bytes retained; original size unknown`
      : `Body capture truncated: ${capturedSize} of ${originalSize} bytes retained`,
    _truncated: true,
    _capturedSize: capturedSize,
    _originalSize: originalSize
  };
}
