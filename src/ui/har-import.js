export function normalizeHarBodySize(value) {
  return Number.isSafeInteger(value) && (value >= 0 || value === -1)
    ? value
    : 0;
}

function assertHarObject(value, fieldPath) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${fieldPath} must be an object`);
  }
  return value;
}

function normalizeHarString(value, fieldPath, options = {}) {
  if (value === undefined && options.optional) return options.defaultValue || '';
  if (typeof value !== 'string') throw new Error(`${fieldPath} must be a string`);
  if (!options.allowEmpty && value.length === 0) throw new Error(`${fieldPath} must not be empty`);
  return value;
}

function normalizeHarNonNegativeNumber(value, fieldPath, options = {}) {
  if (value === undefined && options.optional) return options.defaultValue || 0;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${fieldPath} must be a finite number`);
  }
  if (value < 0) throw new Error(`${fieldPath} must be non-negative`);
  return value;
}

function normalizeHarSize(value, fieldPath) {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${fieldPath} must be a finite number`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${fieldPath} must be a safe integer`);
  }
  if (value < 0 && value !== -1) {
    throw new Error(`${fieldPath} must be non-negative or -1 for an unknown size`);
  }
  return normalizeHarBodySize(value);
}

function normalizeHarTimestamp(value, fieldPath) {
  if (typeof value !== 'string') throw new Error(`${fieldPath} must be a date string`);
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) throw new Error(`${fieldPath} must be a valid date`);
  if (timestamp < 0) throw new Error(`${fieldPath} must be non-negative`);
  return timestamp;
}

function normalizeHarHeaders(headers, fieldPath) {
  if (!Array.isArray(headers)) throw new Error(`${fieldPath} must be an array`);
  const normalized = Object.create(null);
  headers.forEach((header, index) => {
    const headerPath = `${fieldPath}[${index}]`;
    assertHarObject(header, headerPath);
    const name = normalizeHarString(header.name, `${headerPath}.name`).toLowerCase();
    const value = normalizeHarString(header.value, `${headerPath}.value`, { allowEmpty: true });
    if (!Object.hasOwn(normalized, name)) {
      normalized[name] = value;
    } else if (Array.isArray(normalized[name])) {
      normalized[name].push(value);
    } else {
      normalized[name] = [normalized[name], value];
    }
  });
  return normalized;
}

function normalizeHarBody(body, fieldPath) {
  if (body === undefined) return { body: '', encoding: 'utf8' };
  assertHarObject(body, fieldPath);
  if (body.text === undefined) return { body: '', encoding: 'utf8' };
  const text = normalizeHarString(body.text, `${fieldPath}.text`, { allowEmpty: true });
  const encoding = normalizeHarString(body.encoding, `${fieldPath}.encoding`, {
    optional: true,
    allowEmpty: true
  });
  if (encoding.toLowerCase() !== 'base64') return { body: text, encoding: 'utf8' };
  const mimeType = normalizeHarString(body.mimeType, `${fieldPath}.mimeType`, {
    optional: true,
    allowEmpty: true,
    defaultValue: 'application/octet-stream'
  }).replace(/[\r\n,]/g, '') || 'application/octet-stream';
  return {
    body: `data:${mimeType};base64,${text.replace(/\s+/g, '')}`,
    encoding: 'base64'
  };
}

function normalizeHarTruncation(body, fieldPath) {
  if (body === undefined || !Object.hasOwn(body, '_truncated')) return null;
  if (typeof body._truncated !== 'boolean') {
    throw new Error(`${fieldPath}._truncated must be a boolean`);
  }
  if (!body._truncated) return null;

  const capturedSize = body._capturedSize;
  if (!Number.isSafeInteger(capturedSize) || capturedSize < 0) {
    throw new Error(`${fieldPath}._capturedSize must be a non-negative safe integer`);
  }
  const originalSize = body._originalSize;
  if (!Number.isSafeInteger(originalSize) || originalSize < -1) {
    throw new Error(
      `${fieldPath}._originalSize must be a non-negative safe integer or -1`
    );
  }
  if (originalSize >= 0 && capturedSize > originalSize) {
    throw new Error(`${fieldPath}._capturedSize cannot exceed _originalSize`);
  }
  return { capturedSize, originalSize };
}

function normalizeHarEntry(entry, index, createId) {
  const entryPath = `log.entries[${index}]`;
  assertHarObject(entry, entryPath);
  const request = assertHarObject(entry.request, `${entryPath}.request`);
  const response = assertHarObject(entry.response, `${entryPath}.response`);
  const method = normalizeHarString(request.method, `${entryPath}.request.method`);
  const url = normalizeHarString(request.url, `${entryPath}.request.url`);
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`${entryPath}.request.url must be a valid absolute URL`);
  }
  const requestHttpVersion = normalizeHarString(
    request.httpVersion,
    `${entryPath}.request.httpVersion`,
    { optional: true, allowEmpty: true }
  );
  const status = response.status;
  if (!Number.isInteger(status) || (status !== 0 && (status < 100 || status > 999))) {
    throw new Error(`${entryPath}.response.status must be 0 or an integer from 100 to 999`);
  }
  const content = response.content === undefined
    ? undefined
    : assertHarObject(response.content, `${entryPath}.response.content`);
  const requestBodySize = normalizeHarSize(
    request.bodySize,
    `${entryPath}.request.bodySize`
  );
  const responseBodySize = normalizeHarSize(
    response.bodySize,
    `${entryPath}.response.bodySize`
  );
  const timestamp = normalizeHarTimestamp(entry.startedDateTime, `${entryPath}.startedDateTime`);
  const duration = normalizeHarNonNegativeNumber(entry.time, `${entryPath}.time`, { optional: true });
  const requestPostData = request.postData === undefined
    ? undefined
    : assertHarObject(request.postData, `${entryPath}.request.postData`);
  const statusMessage = normalizeHarString(response.statusText, `${entryPath}.response.statusText`, {
    optional: true,
    allowEmpty: true
  });
  const responseHttpVersion = normalizeHarString(
    response.httpVersion,
    `${entryPath}.response.httpVersion`,
    { optional: true, allowEmpty: true }
  );
  const requestPostDataMimeType = requestPostData === undefined
    ? ''
    : normalizeHarString(requestPostData.mimeType, `${entryPath}.request.postData.mimeType`, {
        optional: true,
        allowEmpty: true
      });
  const responseContentMimeType = content === undefined
    ? ''
    : normalizeHarString(content.mimeType, `${entryPath}.response.content.mimeType`, {
        optional: true,
        allowEmpty: true
      });
  const normalizedRequestBody = normalizeHarBody(
    requestPostData,
    `${entryPath}.request.postData`
  );
  const normalizedResponseBody = normalizeHarBody(
    content,
    `${entryPath}.response.content`
  );
  const requestTruncation = normalizeHarTruncation(
    requestPostData,
    `${entryPath}.request.postData`
  );
  const responseTruncation = normalizeHarTruncation(
    content,
    `${entryPath}.response.content`
  );
  const responseBodyDecodedSize = responseTruncation?.originalSize
    ?? (content?.size === undefined
      ? undefined
      : normalizeHarSize(content.size, `${entryPath}.response.content.size`));

  return {
    id: createId(),
    protocol: /^HTTP\/2(?:\.\d+)?$/i.test(requestHttpVersion)
      ? 'h2'
      : parsedUrl.protocol.toLowerCase() === 'https:' ? 'https' : 'http',
    method,
    url,
    host: parsedUrl.hostname,
    path: parsedUrl.pathname + parsedUrl.search,
    requestHeaders: normalizeHarHeaders(request.headers, `${entryPath}.request.headers`),
    requestBody: normalizedRequestBody.body,
    requestBodyEncoding: normalizedRequestBody.encoding,
    requestCookies: Array.isArray(request.cookies) ? request.cookies : [],
    requestPostDataParams: Array.isArray(requestPostData?.params) ? requestPostData.params : undefined,
    requestPostDataMimeType,
    requestHttpVersion,
    requestBodySize,
    ...(requestTruncation ? {
      requestBodyTruncated: true,
      requestBodyCapturedSize: requestTruncation.capturedSize,
      requestBodyDecodedSize: requestTruncation.originalSize
    } : {}),
    statusCode: status,
    statusMessage,
    responseHeaders: normalizeHarHeaders(response.headers, `${entryPath}.response.headers`),
    responseBody: normalizedResponseBody.body,
    responseBodyEncoding: normalizedResponseBody.encoding,
    responseCookies: Array.isArray(response.cookies) ? response.cookies : [],
    responseContentMimeType,
    responseHttpVersion,
    responseBodySize,
    ...(responseBodyDecodedSize === undefined ? {} : { responseBodyDecodedSize }),
    ...(responseTruncation ? {
      responseBodyTruncated: true,
      responseBodyCapturedSize: responseTruncation.capturedSize
    } : {}),
    duration,
    timestamp,
    source: 'import'
  };
}

export function normalizeHarEntries(har, options = {}) {
  assertHarObject(har, 'HAR root');
  const log = assertHarObject(har.log, 'log');
  if (!Array.isArray(log.entries)) throw new Error('log.entries must be an array');
  const createId = options.createId || (() => crypto.randomUUID());
  return log.entries.map((entry, index) => normalizeHarEntry(entry, index, createId));
}
