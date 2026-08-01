const fs = require('fs/promises');
const { fileURLToPath } = require('url');

const MAX_HAR_BYTES = 50 * 1024 * 1024;
const HAR_DOWNLOAD_TIMEOUT_MS = 30_000;

function isHarTarget(value) {
  try {
    const target = value instanceof URL ? value : new URL(value);
    return decodeURIComponent(target.pathname).toLowerCase().endsWith('.har');
  } catch {
    return false;
  }
}

function assertWithinLimit(byteLength, maxBytes) {
  if (byteLength > maxBytes) {
    throw new Error(`HAR files must be ${maxBytes} bytes or smaller`);
  }
}

async function readLocalHar(target, maxBytes) {
  let handle;
  try {
    handle = await fs.open(fileURLToPath(target), 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('The HAR target is not a file');
    assertWithinLimit(stat.size, maxBytes);
    const contents = await handle.readFile();
    assertWithinLimit(contents.length, maxBytes);
    return contents;
  } catch (error) {
    throw new Error(`Could not read HAR file: ${error.message}`);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function downloadHar(target, { fetchImpl, maxBytes, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(target.href, {
      redirect: 'follow',
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`HAR download returned HTTP ${response.status}`);
    }

    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength)) assertWithinLimit(declaredLength, maxBytes);
    if (!response.body) return Buffer.alloc(0);

    const chunks = [];
    let totalBytes = 0;
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      totalBytes += buffer.length;
      assertWithinLimit(totalBytes, maxBytes);
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, totalBytes);
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Timed out downloading HAR file');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function loadHarTarget(value, options = {}) {
  const target = value instanceof URL ? value : new URL(value);
  if (!isHarTarget(target)) throw new Error('The target URL does not point to a .har file');

  const maxBytes = options.maxBytes ?? MAX_HAR_BYTES;
  if (target.protocol === 'file:') return readLocalHar(target, maxBytes);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error('HAR targets must use HTTP, HTTPS, or file URLs');
  }

  return downloadHar(target, {
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    maxBytes,
    timeoutMs: options.timeoutMs ?? HAR_DOWNLOAD_TIMEOUT_MS
  });
}

module.exports = {
  HAR_DOWNLOAD_TIMEOUT_MS,
  MAX_HAR_BYTES,
  isHarTarget,
  loadHarTarget
};
