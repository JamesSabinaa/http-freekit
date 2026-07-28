import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { ProxyServer } from '../src/proxy/proxy-server.js';

function buildClientHello(paddingLength = 0) {
  const paddingExtension = Buffer.alloc(4 + paddingLength);
  paddingExtension.writeUInt16BE(0x0015, 0);
  paddingExtension.writeUInt16BE(paddingLength, 2);
  const extensions = paddingLength > 0 ? paddingExtension : Buffer.alloc(0);
  const extensionLength = Buffer.alloc(2);
  extensionLength.writeUInt16BE(extensions.length);
  const body = Buffer.concat([
    Buffer.from([0x03, 0x03]),
    Buffer.alloc(32, 0x01),
    Buffer.from([0x00]),
    Buffer.from([0x00, 0x02, 0x13, 0x01]),
    Buffer.from([0x01, 0x00]),
    extensionLength,
    extensions
  ]);
  const handshake = Buffer.alloc(4);
  handshake[0] = 0x01;
  handshake.writeUIntBE(body.length, 1, 3);
  const record = Buffer.alloc(5);
  record[0] = 0x16;
  record.writeUInt16BE(0x0301, 1);
  record.writeUInt16BE(handshake.length + body.length, 3);
  return Buffer.concat([record, handshake, body]);
}

function tlsHandshakeRecord(payload) {
  const record = Buffer.alloc(5);
  record[0] = 0x16;
  record.writeUInt16BE(0x0301, 1);
  record.writeUInt16BE(payload.length, 3);
  return Buffer.concat([record, payload]);
}

function splitAcrossRecords(clientHello, splitAt) {
  const payload = clientHello.subarray(5);
  return [
    tlsHandshakeRecord(payload.subarray(0, splitAt)),
    tlsHandshakeRecord(payload.subarray(splitAt))
  ];
}

test('ClientHello capture waits for all fragmented record bytes', async () => {
  const proxy = new ProxyServer(null);
  const socket = new PassThrough();
  const wrapper = proxy._createCapturingSocket(socket);
  const forwarded = [];
  wrapper.on('data', chunk => forwarded.push(Buffer.from(chunk)));
  const clientHello = buildClientHello();

  socket.write(clientHello.subarray(0, 7));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(wrapper._captured, null);

  socket.write(clientHello.subarray(7));
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(wrapper._captured?.cipherSuites, [0x1301]);
  assert.equal(wrapper._captured?.tlsVersion, 0x0303);
  assert.deepEqual(Buffer.concat(forwarded), clientHello);
  wrapper.destroy();
});

test('ClientHello parsing reassembles a handshake split across TLS records', () => {
  const [firstRecord, secondRecord] = splitAcrossRecords(buildClientHello(), 2);
  const parsed = ProxyServer._parseClientHello(Buffer.concat([firstRecord, secondRecord]));

  assert.deepEqual(parsed?.cipherSuites, [0x1301]);
  assert.equal(parsed?.tlsVersion, 0x0303);
});

test('capture continues beyond the first TLS record until ClientHello is complete', async () => {
  const proxy = new ProxyServer(null);
  const socket = new PassThrough();
  const [firstRecord, secondRecord] = splitAcrossRecords(buildClientHello(5000), 3000);
  const wrapper = proxy._createCapturingSocket(socket, firstRecord);
  const forwarded = [];
  wrapper.on('data', chunk => forwarded.push(Buffer.from(chunk)));

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(wrapper._captured, null);

  socket.write(secondRecord.subarray(0, 4));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(wrapper._captured, null);

  socket.write(secondRecord.subarray(4));
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(wrapper._captured?.cipherSuites, [0x1301]);
  assert.equal(wrapper._captured?.tlsVersion, 0x0303);
  assert.deepEqual(Buffer.concat(forwarded), Buffer.concat([firstRecord, secondRecord]));
  wrapper.destroy();
});
