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

  const firstHeaderValue = value => Array.isArray(value) ? (value[0] || '') : (value || '');

  return {
    log: {
      version: '1.2',
      creator: { name: 'HTTP FreeKit', version: '1.0.0' },
      entries: requests.map(req => {
        const reqHeaders = toHarHeaders(req.requestHeaders);
        const resHeaders = toHarHeaders(req.responseHeaders);

        const reqContentType = firstHeaderValue(req.requestHeaders?.['content-type']);
        const resContentType = firstHeaderValue(req.responseHeaders?.['content-type']);
        const requestBody = toHarBody(req.requestBody);
        const responseBody = toHarBody(req.responseBody);
        const httpVersion = req.protocol === 'h2' ? 'HTTP/2' : 'HTTP/1.1';

        return {
          startedDateTime: new Date(req.timestamp).toISOString(),
          time: req.duration || 0,
          request: {
            method: req.method || 'GET',
            url: req.url || '',
            httpVersion,
            cookies: [],
            headers: reqHeaders,
            queryString: parseQueryString(req.url),
            postData: requestBody ? {
              mimeType: reqContentType,
              text: requestBody.text,
              ...(requestBody.encoding ? { encoding: requestBody.encoding } : {})
            } : undefined,
            headersSize: -1,
            bodySize: req.requestBodySize || 0
          },
          response: {
            status: req.statusCode || 0,
            statusText: req.statusMessage || '',
            httpVersion,
            cookies: [],
            headers: resHeaders,
            content: {
              size: req.responseBodySize || 0,
              mimeType: resContentType,
              text: responseBody?.text || '',
              ...(responseBody?.encoding ? { encoding: responseBody.encoding } : {})
            },
            redirectURL: firstHeaderValue(req.responseHeaders?.location),
            headersSize: -1,
            bodySize: req.responseBodySize || 0
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

function toHarBody(body) {
  if (!body) return null;
  if (typeof body !== 'string') body = String(body);

  const dataUriMatch = body.match(/^data:([^;,]+(?:;[^,]*)?);base64,([A-Za-z0-9+/=\r\n]*)$/);
  if (dataUriMatch) {
    return {
      text: dataUriMatch[2].replace(/\s+/g, ''),
      encoding: 'base64'
    };
  }

  return { text: body };
}
