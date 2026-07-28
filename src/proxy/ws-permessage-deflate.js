import zlib from 'node:zlib';

const PERMESSAGE_DEFLATE_TAIL = Buffer.from([0x00, 0x00, 0xff, 0xff]);

function splitExtensionHeader(value, delimiter) {
  const parts = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (escaped) {
      escaped = false;
    } else if (quoted && character === '\\') {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && character === delimiter) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quoted || escaped) return null;
  parts.push(value.slice(start).trim());
  return parts;
}

export function parsePerMessageDeflate(headers) {
  const entry = Object.entries(headers || {})
    .find(([name]) => name.toLowerCase() === 'sec-websocket-extensions');
  if (!entry) return null;
  const headerValue = Array.isArray(entry[1]) ? entry[1].join(',') : String(entry[1] || '');
  const extensions = splitExtensionHeader(headerValue, ',');
  if (!extensions) return null;

  for (const extension of extensions) {
    const fields = splitExtensionHeader(extension, ';');
    if (!fields || fields[0].toLowerCase() !== 'permessage-deflate') continue;
    const negotiation = {
      client: { noContextTakeover: false, windowBits: 15 },
      server: { noContextTakeover: false, windowBits: 15 }
    };
    const seen = new Set();

    for (const rawParameter of fields.slice(1)) {
      const separator = rawParameter.indexOf('=');
      const name = (separator < 0 ? rawParameter : rawParameter.slice(0, separator)).trim().toLowerCase();
      let value = separator < 0 ? null : rawParameter.slice(separator + 1).trim();
      if (!name || seen.has(name)) return null;
      seen.add(name);
      if (value?.startsWith('"') && value.endsWith('"') && value.length >= 2) {
        value = value.slice(1, -1).replace(/\\(.)/g, '$1');
      }

      if (name === 'client_no_context_takeover' || name === 'server_no_context_takeover') {
        if (value !== null) return null;
        negotiation[name.startsWith('client_') ? 'client' : 'server'].noContextTakeover = true;
        continue;
      }
      if (name === 'client_max_window_bits' || name === 'server_max_window_bits') {
        if (!/^(?:[89]|1[0-5])$/.test(value || '')) return null;
        negotiation[name.startsWith('client_') ? 'client' : 'server'].windowBits = Number(value);
        continue;
      }
      return null;
    }
    return negotiation;
  }
  return null;
}

export function createPerMessageDeflateDecoder(options, maxOutputLength) {
  if (!options) return null;
  const outputLimit = Number.isFinite(maxOutputLength)
    ? Math.max(0, Math.trunc(maxOutputLength))
    : 0;
  const windowSize = 2 ** options.windowBits;
  let history = Buffer.alloc(0);
  let contextError = null;
  let decodeQueue = Promise.resolve();

  const retainHistory = (decoded) => {
    const retainedLength = Math.min(windowSize, history.length + decoded.length);
    const nextHistory = Buffer.allocUnsafe(retainedLength);
    if (decoded.length >= retainedLength) {
      decoded.copy(nextHistory, 0, decoded.length - retainedLength);
    } else {
      const previousLength = retainedLength - decoded.length;
      history.copy(nextHistory, 0, history.length - previousLength);
      decoded.copy(nextHistory, previousLength);
    }
    history = nextHistory;
  };

  const decodeOne = async (payload) => {
    if (contextError) {
      throw new Error(`permessage-deflate context is unavailable after: ${contextError}`);
    }
    try {
      const inflateOptions = {
        finishFlush: zlib.constants.Z_SYNC_FLUSH,
        maxOutputLength: Math.max(1, outputLimit + 1),
        windowBits: options.windowBits
      };
      if (!options.noContextTakeover && history.length > 0) {
        inflateOptions.dictionary = history;
      }
      const decoded = await new Promise((resolve, reject) => {
        zlib.inflateRaw(
          Buffer.concat([payload, PERMESSAGE_DEFLATE_TAIL]),
          inflateOptions,
          (error, result) => error ? reject(error) : resolve(result)
        );
      });
      if (decoded.length > outputLimit) {
        const error = new RangeError(
          `decompressed WebSocket message exceeds the ${outputLimit} byte capture limit`
        );
        error.code = 'ERR_WS_DECOMPRESSED_MESSAGE_TOO_LARGE';
        throw error;
      }
      if (!options.noContextTakeover) retainHistory(decoded);
      return decoded;
    } catch (error) {
      if (!options.noContextTakeover) contextError = error.message;
      throw error;
    }
  };

  return {
    decode(payload) {
      const operation = decodeQueue.then(() => decodeOne(payload));
      decodeQueue = operation.then(() => undefined, () => undefined);
      return operation;
    },
    retainedHistoryAllocation() {
      return {
        length: history.length,
        byteLength: history.buffer.byteLength
      };
    }
  };
}
