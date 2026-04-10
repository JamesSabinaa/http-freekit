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

export class WsFrameParser {
  /**
   * @param {function} onFrame - Called with each parsed frame object:
   *   { fin, opcode, masked, payload: Buffer, timestamp }
   */
  constructor(onFrame) {
    this.onFrame = onFrame;
    this._buffer = Buffer.alloc(0);
  }

  /**
   * Feed a chunk of data into the parser.
   * May emit zero or more frames via the onFrame callback.
   * @param {Buffer} chunk
   */
  push(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    this._drain();
  }

  _drain() {
    while (this._buffer.length >= 2) {
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
    const buf = this._buffer;
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
      // Read as two 32-bit values (JS doesn't support 64-bit ints natively)
      const high = buf.readUInt32BE(offset);
      const low = buf.readUInt32BE(offset + 4);
      // For practical purposes, limit to Number.MAX_SAFE_INTEGER
      payloadLength = high * 0x100000000 + low;
      offset += 8;
    }

    // Masking key (4 bytes if masked)
    let maskingKey = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskingKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }

    // Payload data
    if (buf.length < offset + payloadLength) return null;

    const payload = Buffer.from(buf.subarray(offset, offset + payloadLength));
    offset += payloadLength;

    // Unmask payload if masked
    if (masked && maskingKey) {
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= maskingKey[i & 3];
      }
    }

    // Consume parsed bytes from buffer
    this._buffer = Buffer.from(buf.subarray(offset));

    return {
      fin,
      opcode,
      masked,
      payload,
      timestamp: Date.now()
    };
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
