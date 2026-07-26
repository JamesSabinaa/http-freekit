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

  const firstHeaderValue = value => Array.isArray(value) ? (value[0] || '') : (value || '');
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
        const hasPostData = !!requestBody || requestPostDataParams !== null || !!requestTruncation;

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
              ...(requestBody ? { text: requestBody.text } : {}),
              ...(requestBody?.encoding ? { encoding: requestBody.encoding } : {}),
              ...(requestPostDataParams !== null ? { params: requestPostDataParams } : {}),
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
  return typeof value === 'number' && Number.isFinite(value) && (value >= 0 || value === -1)
    ? value
    : fallback;
}

function toHarTruncation(request, side, body) {
  if (request[`${side}BodyTruncated`] !== true) return null;
  const capturedSize = Number.isFinite(request[`${side}BodyCapturedSize`])
    ? request[`${side}BodyCapturedSize`]
    : body?.encoding === 'base64'
      ? Buffer.byteLength(body.text, 'base64')
      : Buffer.byteLength(body?.text || '');
  const originalSize = toHarSize(
    request[`${side}BodyDecodedSize`],
    toHarSize(request[`${side}BodySize`])
  );
  return {
    comment: `Body capture truncated: ${capturedSize} of ${originalSize} bytes retained`,
    _truncated: true,
    _capturedSize: capturedSize,
    _originalSize: originalSize
  };
}
