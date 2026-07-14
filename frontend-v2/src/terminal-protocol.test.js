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
const encoder = new TextEncoder();

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

const raw = new Uint8Array([0x00, 0x1b, 0x5b, 0x41, ...encoder.encode("終端🙂")]);
const fixtures = [
  { type: TYPES.HELLO, payload: encodeJson({ csrfToken: "csrf", clientVersion: "1", capabilities: ["binary", "multiplex", "history"] }) },
  { type: TYPES.HELLO_ACK, payload: encodeJson({ protocol: "RTP/1", heartbeatMs: 15000, maxUnackedBytes: 2097152 }) },
  { type: TYPES.OPEN, sequence: 1, payload: encodeJson({ requestId: "request-1", project: "demo", sessionName: "main", cols: 80, rows: 24 }) },
  { type: TYPES.OPENED, streamId: 42, payload: encodeJson({ requestId: "request-1", project: "demo", sessionName: "main", title: "main", degraded: false }) },
  { type: TYPES.HISTORY, flags: FLAGS.FINAL, streamId: 42, sequence: 1, payload: raw },
  { type: TYPES.READY, streamId: 42, sequence: 2, payload: encodeJson({ cols: 80, rows: 24 }) },
  { type: TYPES.CLOSE_STREAM, streamId: 42, sequence: 3 },
  { type: TYPES.OUTPUT, streamId: 42, sequence: 4, payload: raw },
  { type: TYPES.INPUT, streamId: 42, sequence: 5, payload: raw },
  { type: TYPES.RESIZE, streamId: 42, sequence: 6, payload: encodeResize(80, 24) },
  { type: TYPES.ACK, streamId: 42, sequence: 0x89abcdef },
  { type: TYPES.STATUS, sequence: 7, payload: encodeJson({ state: "connected", degraded: false }) },
  { type: TYPES.SESSION_EVENT, sequence: 8, payload: encodeJson({ event: "updated", project: "demo", session: "main" }) },
  { type: TYPES.PING, sequence: 9, payload: encodePing(1234567890123n) },
  { type: TYPES.PONG, sequence: 10, payload: encodePing(1234567890123n) },
  { type: TYPES.PROTOCOL_ERROR, flags: FLAGS.ERROR, sequence: 11, payload: encodeJson({ code: "BAD_FRAME", message: "bad frame" }) },
];

test("browser codec exposes the exact RTP/1 constants and limits", () => {
  assert.equal(MAGIC, 0x52);
  assert.equal(VERSION, 1);
  assert.equal(HEADER_SIZE, 12);
  assert.deepEqual(FLAGS, { FINAL: 1, ERROR: 2 });
  assert.equal(INPUT_MAX_PAYLOAD, 4096);
  assert.equal(OUTPUT_MAX_PAYLOAD, 32768);
  assert.equal(HISTORY_CHUNK_SIZE, 65536);
  assert.equal(MAX_UNACKED_BYTES, 2097152);
  assert.equal(MAX_BUFFERED_AMOUNT, 1048576);
  assert.equal(BACKPRESSURE_TIMEOUT_MS, 10000);
  assert.equal(HEARTBEAT_MS, 15000);
});

test("round-trips all frame types as Uint8Array without altering terminal bytes", () => {
  assert.deepEqual(new Set(fixtures.map(({ type }) => type)), new Set(Object.values(TYPES)));
  for (const fixture of fixtures) {
    const encoded = encodeFrame(fixture);
    assert.ok(encoded instanceof Uint8Array);
    const decoded = decodeFrame(encoded.buffer);
    assert.ok(decoded.payload instanceof Uint8Array);
    assert.deepEqual(
      { type: decoded.type, flags: decoded.flags, streamId: decoded.streamId, sequence: decoded.sequence },
      {
        type: fixture.type,
        flags: fixture.flags ?? 0,
        streamId: fixture.streamId ?? 0,
        sequence: fixture.sequence ?? 0,
      },
    );
    assert.deepEqual(bytes(decoded.payload), bytes(fixture.payload ?? new Uint8Array()));
  }
  assert.deepEqual(bytes(decodeFrame(encodeFrame({ type: TYPES.OUTPUT, streamId: 1, payload: raw })).payload), bytes(raw));
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

test("encodes exact big-endian headers, including cumulative ACK sequence", () => {
  const encoded = encodeFrame({ type: TYPES.ACK, streamId: 0x10203040, sequence: 0x89abcdef });
  assert.deepEqual(bytes(encoded), [0x52, 0x01, 0x23, 0x00, 0x10, 0x20, 0x30, 0x40, 0x89, 0xab, 0xcd, 0xef]);
  assert.equal(decodeFrame(encoded).sequence, 0x89abcdef);
});

test("JSON helpers use UTF-8 and reject invalid JSON, invalid UTF-8, and non-object control payloads", () => {
  const value = { text: "NUL \u0000 ESC \u001b λ 終端 🙂", nested: [1, true] };
  assert.deepEqual(decodeJson(encodeJson(value)), value);
  assert.throws(() => decodeJson(encoder.encode("{")), /valid JSON/);
  assert.throws(() => decodeJson(new Uint8Array([0xc3, 0x28])), /UTF-8 JSON/);
  assert.throws(() => decodeFrame(uncheckedFrame(TYPES.OPEN, { payload: encoder.encode("[]") })), /JSON object/);
  assert.throws(() => decodeFrame(uncheckedFrame(TYPES.STATUS, { payload: encoder.encode("broken") })), /valid JSON/);
  assert.throws(
    () => encodeFrame({ type: TYPES.OPEN, payload: encodeJson({ value: "x".repeat(JSON_MAX_PAYLOAD) }) }),
    /must not exceed/
  );
});

test("RESIZE and PING fixed-field helpers cover bounds and malformed lengths", () => {
  assert.deepEqual(bytes(encodeResize(0x1234, 0xabcd)), [0x12, 0x34, 0xab, 0xcd]);
  assert.deepEqual(decodeResize(encodeResize(1, 65535)), { cols: 1, rows: 65535 });
  assert.throws(() => encodeResize(0, 24), /cols/);
  assert.throws(() => encodeResize(80, 0), /rows/);
  assert.throws(() => decodeResize(new Uint8Array(5)), /exactly 4/);
  assert.throws(() => decodeResize(new Uint8Array(4)), /greater than zero/);
  const max = 0xffffffffffffffffn;
  assert.equal(decodePing(encodePing(max)), max);
  assert.deepEqual(bytes(encodePing(max)), [255, 255, 255, 255, 255, 255, 255, 255]);
  assert.throws(() => encodePing(-1n), /uint64/);
  assert.throws(() => decodePing(new Uint8Array(9)), /exactly 8/);
  assert.throws(() => decodeFrame(uncheckedFrame(TYPES.PONG, { payload: new Uint8Array(7) })), /exactly 8/);
});

test("rejects short, bad-magic, bad-version, unknown-type, and unknown-flag frames", () => {
  assert.throws(() => decodeFrame(new Uint8Array(0)), /at least 12/);
  const base = encodeFrame({ type: TYPES.ACK, streamId: 1 });
  for (const [offset, replacement, expected] of [
    [0, 0x51, /magic/],
    [1, 0x02, /version/],
    [2, 0x99, /Unknown RTP frame type/],
    [3, 0x04, /Unknown RTP flags/],
  ]) {
    const changed = base.slice();
    changed[offset] = replacement;
    assert.throws(() => decodeFrame(changed), expected);
  }
});

test("enforces stream, direction, flag, empty-payload, and resize-shape invariants", () => {
  assert.throws(() => encodeFrame({ type: TYPES.HELLO, streamId: 1, payload: encodeJson({}) }), /streamId 0/);
  assert.throws(() => encodeFrame({ type: TYPES.INPUT, payload: raw }), /assigned streamId/);
  assert.throws(() => encodeFrame({ type: TYPES.OUTPUT, flags: FLAGS.ERROR, streamId: 1 }), /does not accept flags/);
  assert.throws(() => encodeFrame({ type: TYPES.HISTORY, flags: FLAGS.ERROR, streamId: 1 }), /cannot have the ERROR/);
  assert.throws(() => encodeFrame({ type: TYPES.ACK, streamId: 1, payload: new Uint8Array([0]) }), /ACK payload/);
  assert.throws(() => encodeFrame({ type: TYPES.CLOSE_STREAM, streamId: 1, payload: raw }), /must be empty/);
  assert.throws(
    () => decodeFrame(uncheckedFrame(TYPES.RESIZE, { streamId: 1, payload: new Uint8Array([0, 80, 0, 0]) })),
    /greater than zero/,
  );
  assert.throws(() => encodeFrame({ type: TYPES.INPUT, streamId: 1, payload: new Uint8Array(INPUT_MAX_PAYLOAD + 1) }), /INPUT payload/);
  assert.throws(() => encodeFrame({ type: TYPES.OUTPUT, streamId: 1, payload: new Uint8Array(OUTPUT_MAX_PAYLOAD + 1) }), /OUTPUT payload/);
  assert.throws(() => encodeFrame({ type: TYPES.HISTORY, streamId: 1, payload: new Uint8Array(HISTORY_CHUNK_SIZE + 1) }), /HISTORY payload/);

  const input = { type: TYPES.INPUT, streamId: 1, payload: raw };
  assert.equal(validateFrame(input, DIRECTIONS.CLIENT_TO_SERVER), input);
  assert.throws(() => validateFrame(input, DIRECTIONS.SERVER_TO_CLIENT), /not valid server-to-client/);
  assert.throws(
    () => decodeFrame(encodeFrame({ type: TYPES.HELLO_ACK, payload: encodeJson({ protocol: "RTP/1" }) }), DIRECTIONS.CLIENT_TO_SERVER),
    /not valid client-to-server/,
  );
});

test("supports JSON error CLOSE_STREAM frames", () => {
  const encoded = encodeFrame({
    type: TYPES.CLOSE_STREAM,
    flags: FLAGS.ERROR,
    streamId: 4,
    payload: encodeJson({ code: "SLOW_CLIENT", message: "consumer stalled" }),
  });
  assert.equal(decodeJson(decodeFrame(encoded).payload).code, "SLOW_CLIENT");
});
