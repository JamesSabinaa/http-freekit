/**
 * WebSocket frame parser per RFC 6455 Section 5.2.
 *
 * Accepts streaming chunks of data and emits parsed frames via a callback.
 * Handles continuation frames, masking, and all standard opcodes.
 */

// Opcode constants
export const WS_OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xA
};

export const WS_OPCODE_NAMES = {
  [WS_OPCODE.CONTINUATION]: 'continuation',
  [WS_OPCODE.TEXT]: 'text',
  [WS_OPCODE.BINARY]: 'binary',
  [WS_OPCODE.CLOSE]: 'close',
  [WS_OPCODE.PING]: 'ping',
  [WS_OPCODE.PONG]: 'pong'
};

export const DEFAULT_MAX_WS_FRAME_PAYLOAD = 16 * 1024 * 1024;

export class WsFrameParser {
  /**
   * @param {function} onFrame - Called with each parsed frame object:
   *   { fin, opcode, masked, payload: Buffer, timestamp }
   */
  constructor(onFrame, options = {}) {
    this.onFrame = onFrame;
    this.maxPayloadLength = options.maxPayloadLength ?? DEFAULT_MAX_WS_FRAME_PAYLOAD;
    this._chunks = [];
    this._bufferedLength = 0;
    this._disabled = false;
  }

  /**
   * Feed a chunk of data into the parser.
   * May emit zero or more frames via the onFrame callback.
   * @param {Buffer} chunk
   */
  push(chunk) {
    if (this._disabled || !chunk || chunk.length === 0) return;
    this._chunks.push(chunk);
    this._bufferedLength += chunk.length;
    this._drain();
  }

  _drain() {
    while (this._bufferedLength >= 2) {
      const frame = this._tryParseFrame();
      if (!frame) break; // not enough data yet
      this.onFrame(frame);
    }
  }

  /**
   * Attempt to parse a single frame from the buffer.
   * Returns the frame object and consumes the bytes, or returns null if incomplete.
   */
  _tryParseFrame() {
    const headerLength = Math.min(this._bufferedLength, 14);
    const buf = this._peek(headerLength);
    let offset = 0;

    if (buf.length < 2) return null;

    // Byte 0: FIN + RSV + opcode
    const byte0 = buf[offset++];
    const fin = (byte0 & 0x80) !== 0;
    const opcode = byte0 & 0x0F;

    // Byte 1: MASK + payload length
    const byte1 = buf[offset++];
    const masked = (byte1 & 0x80) !== 0;
    let payloadLength = byte1 & 0x7F;

    // Extended payload length
    if (payloadLength === 126) {
      if (buf.length < offset + 2) return null;
      payloadLength = buf.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLength === 127) {
      if (buf.length < offset + 8) return null;
      const payloadLengthBigInt = buf.readBigUInt64BE(offset);
      if (payloadLengthBigInt > BigInt(this.maxPayloadLength)) {
        this._rejectOversizedFrame(payloadLengthBigInt);
      }
      payloadLength = Number(payloadLengthBigInt);
      offset += 8;
    }

    if (payloadLength > this.maxPayloadLength) {
      this._rejectOversizedFrame(payloadLength);
    }

    // Masking key (4 bytes if masked)
    let maskingKey = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskingKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }

    // Payload data
    const frameLength = offset + payloadLength;
    if (this._bufferedLength < frameLength) return null;

    const frameBytes = this._consume(frameLength);
    const payload = frameBytes.subarray(offset, frameLength);

    // Unmask payload if masked
    if (masked && maskingKey) {
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= maskingKey[i & 3];
      }
    }

    return {
      fin,
      opcode,
      masked,
      payload,
      timestamp: Date.now()
    };
  }

  _peek(length) {
    const prefix = Buffer.allocUnsafe(length);
    let copied = 0;
    for (const chunk of this._chunks) {
      const copyLength = Math.min(chunk.length, length - copied);
      chunk.copy(prefix, copied, 0, copyLength);
      copied += copyLength;
      if (copied === length) break;
    }
    return prefix;
  }

  _consume(length) {
    const result = Buffer.allocUnsafe(length);
    let copied = 0;
    while (copied < length) {
      const chunk = this._chunks[0];
      const copyLength = Math.min(chunk.length, length - copied);
      chunk.copy(result, copied, 0, copyLength);
      copied += copyLength;
      this._bufferedLength -= copyLength;
      if (copyLength === chunk.length) {
        this._chunks.shift();
      } else {
        this._chunks[0] = chunk.subarray(copyLength);
      }
    }
    return result;
  }

  _rejectOversizedFrame(payloadLength) {
    this._chunks = [];
    this._bufferedLength = 0;
    this._disabled = true;
    const error = new RangeError(
      `WebSocket frame payload ${payloadLength} exceeds the ${this.maxPayloadLength} byte capture limit`
    );
    error.code = 'ERR_WS_FRAME_TOO_LARGE';
    throw error;
  }
}

/**
 * Builds a human-readable description of a close frame's payload.
 * Close frames contain a 2-byte status code followed by optional UTF-8 reason text.
 * @param {Buffer} payload
 * @returns {{ code: number|null, reason: string }}
 */
export function parseClosePayload(payload) {
  if (!payload || payload.length === 0) {
    return { code: null, reason: '' };
  }
  if (payload.length < 2) {
    return { code: null, reason: '' };
  }
  const code = payload.readUInt16BE(0);
  const reason = payload.length > 2 ? payload.subarray(2).toString('utf-8') : '';
  return { code, reason };
}
