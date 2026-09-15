export function normalizeHarBodySize(value) {
  return Number.isSafeInteger(value) && (value >= 0 || value === -1)
    ? value
    : 0;
}

// A binary capture at the 32 MiB per-side proxy ceiling expands to roughly
// 85.4 MiB of base64 across one request and response. These limits leave room
// for its HAR metadata while bounding file text, normalized objects, and each
// management request independently.
export const HAR_IMPORT_MAX_FILE_BYTES = 128 * 1024 * 1024;
export const HAR_IMPORT_MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
export const HAR_IMPORT_MAX_BATCH_BYTES = 96 * 1024 * 1024;
export const HAR_IMPORT_MAX_RETAINED_ENTRIES = 10_000;
export const HAR_IMPORT_TRANSACTION_ID_MAX_LENGTH = 64;

class HarImportPolicyError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'HarImportPolicyError';
    this.code = code;
  }
}

function formatMiB(bytes) {
  return `${Math.floor(bytes / (1024 * 1024))} MiB`;
}

export function assertHarImportFileSize(
  byteLength,
  maxBytes = HAR_IMPORT_MAX_FILE_BYTES
) {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new TypeError('HAR file size must be a non-negative safe integer');
  }
  if (byteLength > maxBytes) {
    throw new HarImportPolicyError(
      `HAR file exceeds the ${formatMiB(maxBytes)} import limit`,
      'ERR_HAR_IMPORT_FILE_TOO_LARGE'
    );
  }
  return byteLength;
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

export function createHarImportBatches(entries, options = {}) {
  if (!Array.isArray(entries)) throw new TypeError('HAR import entries must be an array');
  const maxBatchBytes = options.maxBatchBytes ?? HAR_IMPORT_MAX_BATCH_BYTES;
  const maxExpandedBytes = options.maxExpandedBytes ?? HAR_IMPORT_MAX_EXPANDED_BYTES;
  if (!Number.isSafeInteger(maxBatchBytes) || maxBatchBytes < 16) {
    throw new TypeError('HAR import batch limit must be a safe integer of at least 16 bytes');
  }
  if (!Number.isSafeInteger(maxExpandedBytes) || maxExpandedBytes < 0) {
    throw new TypeError('HAR expanded-memory limit must be a non-negative safe integer');
  }

  // Reserve enough envelope space for the transaction metadata that the
  // renderer sends with every batch. This makes the documented batch ceiling
  // apply to the complete HTTP payload, not just the requests array.
  const envelopeBytes = utf8ByteLength(JSON.stringify({
    requests: [],
    importTransaction: {
      id: 'x'.repeat(HAR_IMPORT_TRANSACTION_ID_MAX_LENGTH),
      index: Number.MAX_SAFE_INTEGER,
      count: Number.MAX_SAFE_INTEGER
    }
  }));
  const batches = [];
  let batch = [];
  let batchBytes = envelopeBytes;
  let expandedBytes = 0;
  for (let index = 0; index < entries.length; index++) {
    const serialized = JSON.stringify(entries[index]);
    if (serialized === undefined) {
      throw new TypeError(`HAR import entry ${index} is not JSON serializable`);
    }
    const itemBytes = utf8ByteLength(serialized);
    // JavaScript strings occupy up to two bytes per code unit. Counting the
    // normalized JSON shape this way gives the renderer a deterministic bound
    // without allocating a second UTF-8 copy merely to measure it.
    expandedBytes += serialized.length * 2;
    if (expandedBytes > maxExpandedBytes) {
      throw new HarImportPolicyError(
        `Normalized HAR data exceeds the ${formatMiB(maxExpandedBytes)} expanded-memory limit`,
        'ERR_HAR_IMPORT_EXPANDED_TOO_LARGE'
      );
    }
    if (envelopeBytes + itemBytes > maxBatchBytes) {
      throw new HarImportPolicyError(
        `HAR entry ${index} exceeds the ${formatMiB(maxBatchBytes)} import batch limit`,
        'ERR_HAR_IMPORT_ENTRY_TOO_LARGE'
      );
    }
    const addedBytes = itemBytes + (batch.length > 0 ? 1 : 0);
    if (batch.length > 0 && batchBytes + addedBytes > maxBatchBytes) {
      batches.push(batch);
      batch = [];
      batchBytes = envelopeBytes;
    }
    batch.push(entries[index]);
    batchBytes += itemBytes + (batch.length > 1 ? 1 : 0);
  }
  if (batch.length > 0) batches.push(batch);
  if (batches.length === 0) batches.push([]);
  return { batches, expandedBytes };
}

export function createHarImportBatchPayloads(batches, transactionId) {
  if (!Array.isArray(batches) || batches.some(batch => !Array.isArray(batch))) {
    throw new TypeError('HAR import batches must be an array of request arrays');
  }
  if (typeof transactionId !== 'string' ||
      !/^[A-Za-z0-9_-]+$/.test(transactionId) ||
      transactionId.length > HAR_IMPORT_TRANSACTION_ID_MAX_LENGTH) {
    throw new TypeError(
      `HAR import transaction ID must use 1-${HAR_IMPORT_TRANSACTION_ID_MAX_LENGTH} ` +
      'letters, numbers, underscores, or hyphens'
    );
  }
  const count = batches.length;
  return batches.map((requests, index) => ({
    requests,
    importTransaction: { id: transactionId, index, count }
  }));
}

const HTTP_TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const SUPPORTED_HAR_URL_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:']);

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

function normalizeHarMethod(value, fieldPath) {
  const method = normalizeHarString(value, fieldPath);
  if (!HTTP_TOKEN_PATTERN.test(method)) {
    throw new Error(`${fieldPath} must be a valid HTTP token`);
  }
  return method;
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
  return timestamp;
}

function normalizeHarProtocol(parsedUrl, httpVersion) {
  const urlProtocol = parsedUrl.protocol.toLowerCase();
  if (urlProtocol === 'ws:' || urlProtocol === 'wss:') {
    return urlProtocol.slice(0, -1);
  }
  if (/^HTTP\/2(?:\.\d+)?$/i.test(httpVersion)) return 'h2';
  return urlProtocol === 'https:' ? 'https' : 'http';
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

function normalizeHarContentDecoded(body, fieldPath) {
  if (body === undefined || !Object.hasOwn(body, '_contentDecoded')) return false;
  if (typeof body._contentDecoded !== 'boolean') {
    throw new Error(`${fieldPath}._contentDecoded must be a boolean`);
  }
  return body._contentDecoded;
}

function normalizeHarEntry(entry, index, createId) {
  const entryPath = `log.entries[${index}]`;
  assertHarObject(entry, entryPath);
  const request = assertHarObject(entry.request, `${entryPath}.request`);
  const response = assertHarObject(entry.response, `${entryPath}.response`);
  const method = normalizeHarMethod(request.method, `${entryPath}.request.method`);
  const url = normalizeHarString(request.url, `${entryPath}.request.url`);
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`${entryPath}.request.url must be a valid absolute URL`);
  }
  if (!SUPPORTED_HAR_URL_PROTOCOLS.has(parsedUrl.protocol.toLowerCase())) {
    throw new Error(
      `${entryPath}.request.url must use the http, https, ws, or wss scheme`
    );
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
  const requestContentDecoded = normalizeHarContentDecoded(
    requestPostData,
    `${entryPath}.request.postData`
  );
  const responseContentDecoded = normalizeHarContentDecoded(
    content,
    `${entryPath}.response.content`
  );
  const responseBodyDecodedSize = responseTruncation?.originalSize
    ?? (content?.size === undefined
      ? undefined
      : normalizeHarSize(content.size, `${entryPath}.response.content.size`));

  return {
    id: createId(),
    protocol: normalizeHarProtocol(parsedUrl, requestHttpVersion),
    method,
    url,
    host: parsedUrl.hostname,
    path: parsedUrl.pathname + parsedUrl.search,
    requestHeaders: normalizeHarHeaders(request.headers, `${entryPath}.request.headers`),
    requestBody: normalizedRequestBody.body,
    requestBodyEncoding: normalizedRequestBody.encoding,
    ...(requestContentDecoded ? { requestBodyContentDecoded: true } : {}),
    requestCookies: Array.isArray(request.cookies) ? request.cookies : [],
    requestPostDataParams: Array.isArray(requestPostData?.params) ? requestPostData.params : undefined,
    ...(Array.isArray(requestPostData?.params)
      ? { requestBodyTextPresent: requestPostData.text !== undefined } : {}),
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
    ...(responseContentDecoded ? { responseBodyContentDecoded: true } : {}),
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
  const retainLimit = options.retainLimit === undefined
    ? log.entries.length
    : options.retainLimit;
  if (!Number.isSafeInteger(retainLimit) || retainLimit < 0) {
    throw new TypeError('HAR retain limit must be a non-negative safe integer');
  }
  const firstRetainedIndex = Math.max(0, log.entries.length - retainLimit);
  const normalized = [];
  log.entries.forEach((entry, index) => {
    const request = normalizeHarEntry(entry, index, createId);
    if (index >= firstRetainedIndex) normalized.push(request);
  });
  return normalized;
}

export function prepareHarImport(har, options = {}) {
  const retainLimit = options.retainLimit ?? HAR_IMPORT_MAX_RETAINED_ENTRIES;
  const entries = normalizeHarEntries(har, {
    createId: options.createId,
    retainLimit
  });
  const { batches, expandedBytes } = createHarImportBatches(entries, options);
  const transactionId = options.transactionId ?? crypto.randomUUID();
  const payloads = createHarImportBatchPayloads(batches, transactionId);
  return {
    entries,
    batches,
    payloads,
    transactionId,
    expandedBytes,
    totalEntries: har.log.entries.length,
    retainedEntries: entries.length,
    droppedEntries: har.log.entries.length - entries.length
  };
}
