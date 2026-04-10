export function trafficToHar(requests) {
  return {
    log: {
      version: '1.2',
      creator: { name: 'HTTP FreeKit', version: '1.0.0' },
      entries: requests.map(req => {
        const reqHeaders = Object.entries(req.requestHeaders || {}).map(([name, value]) => ({
          name,
          value: Array.isArray(value) ? value.join(', ') : String(value)
        }));
        const resHeaders = Object.entries(req.responseHeaders || {}).map(([name, value]) => ({
          name,
          value: Array.isArray(value) ? value.join(', ') : String(value)
        }));

        const reqContentType = req.requestHeaders?.['content-type'] || '';
        const resContentType = req.responseHeaders?.['content-type'] || '';

        return {
          startedDateTime: new Date(req.timestamp).toISOString(),
          time: req.duration || 0,
          request: {
            method: req.method || 'GET',
            url: req.url || '',
            httpVersion: 'HTTP/1.1',
            cookies: [],
            headers: reqHeaders,
            queryString: parseQueryString(req.url),
            postData: req.requestBody ? {
              mimeType: reqContentType,
              text: req.requestBody
            } : undefined,
            headersSize: -1,
            bodySize: req.requestBodySize || 0
          },
          response: {
            status: req.statusCode || 0,
            statusText: req.statusMessage || '',
            httpVersion: 'HTTP/1.1',
            cookies: [],
            headers: resHeaders,
            content: {
              size: req.responseBodySize || 0,
              mimeType: resContentType,
              text: req.responseBody || ''
            },
            redirectURL: req.responseHeaders?.location || '',
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
