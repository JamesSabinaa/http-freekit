const fs = require('fs/promises');
const { lookup: dnsLookup } = require('dns/promises');
const { BlockList, isIP } = require('net');
const { fileURLToPath } = require('url');
const { Agent, fetch: undiciFetch } = require('undici');

const MAX_HAR_BYTES = 50 * 1024 * 1024;
const HAR_DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_HAR_REDIRECTS = 5;

const blockedHarAddresses = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
]) {
  blockedHarAddresses.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10],
  ['2001:db8::', 32], ['ff00::', 8]
]) {
  blockedHarAddresses.addSubnet(address, prefix, 'ipv6');
}

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

async function assertPublicHarDestination(target, lookupImpl) {
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error('Remote HAR redirects must use HTTP or HTTPS');
  }
  if (target.username || target.password) {
    throw new Error('Remote HAR URLs cannot contain credentials');
  }
  const hostname = target.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('Remote HAR URLs must resolve only to public network addresses');
  }

  let addresses;
  const literalFamily = isIP(hostname);
  if (literalFamily) {
    addresses = [{ address: hostname, family: literalFamily }];
  } else {
    let result;
    try {
      result = await lookupImpl(hostname, { all: true, verbatim: true });
    } catch (error) {
      throw new Error(`Could not resolve remote HAR host ${hostname}: ${error.message}`);
    }
    addresses = Array.isArray(result) ? result : [result];
  }

  const normalizedAddresses = addresses.map(record => {
    const address = typeof record?.address === 'string' ? record.address : '';
    return { address, family: isIP(address) };
  });
  if (normalizedAddresses.length === 0 || normalizedAddresses.some(record => {
    return ![4, 6].includes(record.family) ||
      blockedHarAddresses.check(record.address, record.family === 4 ? 'ipv4' : 'ipv6');
  })) {
    throw new Error('Remote HAR URLs must resolve only to public network addresses');
  }
  return normalizedAddresses;
}

function createPinnedLookup(addresses) {
  const pinnedAddresses = addresses.map(record => ({ ...record }));
  return (_hostname, options, callback) => {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    const requestedFamily = Number(options?.family) || 0;
    const candidates = requestedFamily
      ? pinnedAddresses.filter(record => record.family === requestedFamily)
      : pinnedAddresses;
    if (candidates.length === 0) {
      const error = new Error('No validated address matches the requested family');
      error.code = 'ENOTFOUND';
      callback(error);
      return;
    }
    if (options?.all) {
      callback(null, candidates.map(record => ({ ...record })));
      return;
    }
    callback(null, candidates[0].address, candidates[0].family);
  };
}

function createPinnedDispatcher(lookup) {
  return new Agent({ connect: { lookup } });
}

async function closeResponseBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // A fully consumed or already canceled body needs no further cleanup.
  }
}

async function downloadHar(target, {
  fetchImpl,
  lookupImpl,
  dispatcherFactory,
  maxBytes,
  timeoutMs,
  maxRedirects
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let currentTarget = target;
    for (let redirects = 0; ; redirects++) {
      const addresses = await assertPublicHarDestination(currentTarget, lookupImpl);
      const dispatcher = dispatcherFactory(createPinnedLookup(addresses));
      let response;
      try {
        response = await fetchImpl(currentTarget.href, {
          redirect: 'manual',
          signal: controller.signal,
          dispatcher
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          if (!location) throw new Error('HAR download redirect is missing its destination');
          if (redirects >= maxRedirects) {
            throw new Error('HAR download followed too many redirects');
          }
          currentTarget = new URL(location, currentTarget);
          continue;
        }
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
      } finally {
        await closeResponseBody(response);
        await dispatcher.close();
      }
    }
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
    fetchImpl: options.fetchImpl ?? undiciFetch,
    lookupImpl: options.lookupImpl ?? dnsLookup,
    dispatcherFactory: options.dispatcherFactory ?? createPinnedDispatcher,
    maxBytes,
    timeoutMs: options.timeoutMs ?? HAR_DOWNLOAD_TIMEOUT_MS,
    maxRedirects: options.maxRedirects ?? MAX_HAR_REDIRECTS
  });
}

module.exports = {
  HAR_DOWNLOAD_TIMEOUT_MS,
  MAX_HAR_REDIRECTS,
  MAX_HAR_BYTES,
  isHarTarget,
  loadHarTarget
};
