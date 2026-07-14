import test from "node:test";
import assert from "node:assert/strict";
import {
  MAGIC,
  VERSION,
  HEADER_SIZE,
  TYPES,
  FLAGS,
  DIRECTIONS,
  INPUT_MAX_PAYLOAD,
  OUTPUT_MAX_PAYLOAD,
  HISTORY_CHUNK_SIZE,
  JSON_MAX_PAYLOAD,
  MAX_UNACKED_BYTES,
  MAX_BUFFERED_AMOUNT,
  BACKPRESSURE_TIMEOUT_MS,
  HEARTBEAT_MS,
  encodeFrame,
  decodeFrame,
  encodeJson,
  decodeJson,
  encodeResize,
  decodeResize,
  encodePing,
  decodePing,
  validateFrame,
} from "./terminal-protocol.js";

const bytes = (value) => Array.from(value);

function uncheckedFrame(type, { flags = 0, streamId = 0, sequence = 0, payload = new Uint8Array() } = {}) {
  const result = new Uint8Array(HEADER_SIZE + payload.byteLength);
  const view = new DataView(result.buffer);
  view.setUint8(0, MAGIC);
  view.setUint8(1, VERSION);
  view.setUint8(2, type);
  view.setUint8(3, flags);
  view.setUint32(4, streamId, false);
  view.setUint32(8, sequence, false);
  result.set(payload, HEADER_SIZE);
  return result;
}

const json = encodeJson;
const rawTerminalBytes = new Uint8Array([
  0x00,
  0x1b,
  0x5b,
  0x33,
  0x31,
  0x6d,
  ...new TextEncoder().encode("λ🙂"),
]);

const framesByType = [
  { type: TYPES.HELLO, payload: json({ csrfToken: "token", clientVersion: "1", capabilities: ["binary", "multiplex", "history"] }) },
  { type: TYPES.HELLO_ACK, payload: json({ protocol: "RTP/1", heartbeatMs: 15_000, maxUnackedBytes: 2_097_152 }) },
  { type: TYPES.OPEN, sequence: 1, payload: json({ requestId: "r1", project: "demo", sessionName: "main", cols: 120, rows: 40 }) },
  { type: TYPES.OPENED, streamId: 7, payload: json({ requestId: "r1", project: "demo", sessionName: "main", title: "main", degraded: false }) },
  { type: TYPES.HISTORY, flags: FLAGS.FINAL, streamId: 7, sequence: 1, payload: rawTerminalBytes },
  { type: TYPES.READY, streamId: 7, sequence: 2, payload: json({ cols: 120, rows: 40 }) },
  { type: TYPES.CLOSE_STREAM, streamId: 7, sequence: 3 },
  { type: TYPES.OUTPUT, streamId: 7, sequence: 4, payload: rawTerminalBytes },
  { type: TYPES.INPUT, streamId: 7, sequence: 5, payload: rawTerminalBytes },
  { type: TYPES.RESIZE, streamId: 7, sequence: 6, payload: encodeResize(120, 40) },
  { type: TYPES.ACK, streamId: 7, sequence: 0xfedcba98 },
  { type: TYPES.STATUS, streamId: 7, sequence: 7, payload: json({ state: "attached", message: "ready" }) },
  { type: TYPES.SESSION_EVENT, sequence: 8, payload: json({ event: "activity", project: "demo", session: "main" }) },
  { type: TYPES.PING, sequence: 9, payload: encodePing(1_700_000_000_123n) },
  { type: TYPES.PONG, sequence: 10, payload: encodePing(1_700_000_000_123n) },
  { type: TYPES.PROTOCOL_ERROR, flags: FLAGS.ERROR, sequence: 11, payload: json({ code: "BAD_FRAME", message: "invalid" }) },
];

test("exports the frozen RTP/1 constants and backpressure limits", () => {
  assert.equal(MAGIC, 0x52);
  assert.equal(VERSION, 1);
  assert.equal(HEADER_SIZE, 12);
  assert.deepEqual(FLAGS, { FINAL: 1, ERROR: 2 });
  assert.equal(INPUT_MAX_PAYLOAD, 4 * 1024);
  assert.equal(OUTPUT_MAX_PAYLOAD, 32 * 1024);
  assert.equal(HISTORY_CHUNK_SIZE, 64 * 1024);
  assert.equal(MAX_UNACKED_BYTES, 2 * 1024 * 1024);
  assert.equal(MAX_BUFFERED_AMOUNT, 1024 * 1024);
  assert.equal(BACKPRESSURE_TIMEOUT_MS, 10_000);
  assert.equal(HEARTBEAT_MS, 15_000);
});

test("round-trips every frame type and preserves raw NUL, ESC, and Unicode bytes", () => {
  assert.deepEqual(new Set(framesByType.map((frame) => frame.type)), new Set(Object.values(TYPES)));
  for (const input of framesByType) {
    const encoded = encodeFrame(input);
    const decoded = decodeFrame(encoded);
    assert.equal(decoded.type, input.type);
    assert.equal(decoded.flags, input.flags ?? 0);
    assert.equal(decoded.streamId, input.streamId ?? 0);
    assert.equal(decoded.sequence, input.sequence ?? 0);
    assert.deepEqual(bytes(decoded.payload), bytes(input.payload ?? new Uint8Array()));
  }
});

test("decodes payload as a zero-copy view of an offset frame", () => {
  const payload = new Uint8Array([0x00, 0x1b, 0xce, 0xbb]);
  const encoded = encodeFrame({ type: TYPES.OUTPUT, streamId: 7, sequence: 4, payload });
  const padded = new Uint8Array(encoded.byteLength + 9);
  padded.set(encoded, 5);
  const input = padded.subarray(5, 5 + encoded.byteLength);

  const decoded = decodeFrame(input, DIRECTIONS.SERVER_TO_CLIENT);

  assert.equal(decoded.payload.buffer, input.buffer);
  assert.equal(decoded.payload.byteOffset, input.byteOffset + HEADER_SIZE);
  assert.equal(decoded.payload.byteLength, payload.byteLength);
  assert.deepEqual(bytes(decoded.payload), bytes(payload));

  input[HEADER_SIZE] = 0xff;
  assert.equal(decoded.payload[0], 0xff);
  decoded.payload[decoded.payload.byteLength - 1] = 0x7f;
  assert.equal(input[input.byteLength - 1], 0x7f);
});

test("encodes the exact 12-byte big-endian header and cumulative ACK sequence", () => {
  const frame = encodeFrame({ type: TYPES.ACK, streamId: 0x01020304, sequence: 0xfedcba98 });
  assert.deepEqual(bytes(frame), [0x52, 0x01, 0x23, 0x00, 1, 2, 3, 4, 0xfe, 0xdc, 0xba, 0x98]);
  assert.equal(decodeFrame(frame).sequence, 0xfedcba98);
});

test("JSON helpers preserve Unicode and reject malformed JSON and UTF-8", () => {
  const value = { message: "terminal λ 🙂", nested: { ok: true } };
  assert.deepEqual(decodeJson(encodeJson(value)), value);
  assert.throws(() => decodeJson(new TextEncoder().encode("{broken")), /valid JSON/);
  assert.throws(() => decodeJson(new Uint8Array([0xff])), /UTF-8 JSON/);
  assert.throws(
    () => decodeFrame(uncheckedFrame(TYPES.HELLO, { payload: new TextEncoder().encode("null") })),
    /JSON object/,
  );
  assert.throws(
    () => encodeFrame({ type: TYPES.HELLO, payload: encodeJson({ value: "x".repeat(JSON_MAX_PAYLOAD) }) }),
    /must not exceed/
  );
});

test("RESIZE helpers use uint16 big-endian and reject bad lengths or dimensions", () => {
  assert.deepEqual(bytes(encodeResize(0x1234, 0xabcd)), [0x12, 0x34, 0xab, 0xcd]);
  assert.deepEqual(decodeResize(encodeResize(65535, 1)), { cols: 65535, rows: 1 });
  assert.throws(() => encodeResize(0, 24), /cols/);
  assert.throws(() => encodeResize(80, 65536), /rows/);
  assert.throws(() => decodeResize(new Uint8Array(3)), /exactly 4/);
  assert.throws(() => decodeResize(new Uint8Array([0, 0, 0, 24])), /greater than zero/);
  assert.throws(
    () => decodeFrame(uncheckedFrame(TYPES.RESIZE, { streamId: 1, payload: new Uint8Array([0, 80, 0, 0]) })),
    /greater than zero/,
  );
});

test("PING helpers preserve the full uint64 range and enforce eight-byte payloads", () => {
  const maximum = 0xffffffffffffffffn;
  assert.deepEqual(bytes(encodePing(maximum)), new Array(8).fill(0xff));
  assert.equal(decodePing(encodePing(maximum)), maximum);
  assert.equal(decodePing(encodePing(1_700_000_000_123)), 1_700_000_000_123n);
  assert.throws(() => encodePing(-1), /non-negative/);
  assert.throws(() => encodePing(0x1_0000_0000_0000_0000n), /uint64/);
  assert.throws(() => decodePing(new Uint8Array(7)), /exactly 8/);
});

test("rejects short frames and malformed header fields", () => {
  assert.throws(() => decodeFrame(new Uint8Array(11)), /at least 12/);
  const valid = encodeFrame({ type: TYPES.ACK, streamId: 1, sequence: 1 });
  for (const [offset, value, pattern] of [
    [0, 0, /magic/],
    [1, 2, /version/],
    [2, 0x99, /Unknown RTP frame type/],
    [3, 0x80, /Unknown RTP flags/],
  ]) {
    const malformed = valid.slice();
    malformed[offset] = value;
    assert.throws(() => decodeFrame(malformed), pattern);
  }
});

test("rejects invalid type streams, directions, flags, and fixed payload shapes", () => {
  assert.throws(() => encodeFrame({ type: TYPES.HELLO, streamId: 1, payload: json({}) }), /streamId 0/);
  assert.throws(() => encodeFrame({ type: TYPES.OUTPUT, payload: rawTerminalBytes }), /assigned streamId/);
  assert.throws(() => encodeFrame({ type: TYPES.OUTPUT, flags: FLAGS.FINAL, streamId: 1 }), /does not accept flags/);
  assert.throws(() => encodeFrame({ type: TYPES.PROTOCOL_ERROR, payload: json({ code: "x", message: "y" }) }), /ERROR flag/);
  assert.throws(() => encodeFrame({ type: TYPES.ACK, streamId: 1, payload: new Uint8Array([1]) }), /ACK payload/);
  assert.throws(() => encodeFrame({ type: TYPES.CLOSE_STREAM, streamId: 1, payload: new Uint8Array([1]) }), /must be empty/);
  assert.throws(() => encodeFrame({ type: TYPES.PING, payload: new Uint8Array(4) }), /exactly 8/);
  assert.throws(() => encodeFrame({ type: TYPES.INPUT, streamId: 1, payload: new Uint8Array(INPUT_MAX_PAYLOAD + 1) }), /INPUT payload/);
  assert.throws(() => encodeFrame({ type: TYPES.OUTPUT, streamId: 1, payload: new Uint8Array(OUTPUT_MAX_PAYLOAD + 1) }), /OUTPUT payload/);
  assert.throws(() => encodeFrame({ type: TYPES.HISTORY, streamId: 1, payload: new Uint8Array(HISTORY_CHUNK_SIZE + 1) }), /HISTORY payload/);

  const input = { type: TYPES.INPUT, streamId: 1, payload: rawTerminalBytes };
  assert.equal(validateFrame(input, DIRECTIONS.CLIENT_TO_SERVER), input);
  assert.throws(() => validateFrame(input, DIRECTIONS.SERVER_TO_CLIENT), /not valid server-to-client/);
  assert.throws(
    () => decodeFrame(encodeFrame({ type: TYPES.OUTPUT, streamId: 1 }), DIRECTIONS.CLIENT_TO_SERVER),
    /not valid client-to-server/,
  );
});

test("accepts error CLOSE_STREAM JSON and rejects invalid JSON payloads during frame decode", () => {
  const closed = encodeFrame({
    type: TYPES.CLOSE_STREAM,
    flags: FLAGS.ERROR,
    streamId: 9,
    payload: json({ code: "SLOW_CLIENT", message: "backpressure" }),
  });
  assert.equal(decodeJson(decodeFrame(closed).payload).code, "SLOW_CLIENT");
  assert.throws(
    () => decodeFrame(uncheckedFrame(TYPES.STATUS, { payload: new TextEncoder().encode("{") })),
    /valid JSON/,
  );
});
