export const MAGIC = 0x52;
export const VERSION = 0x01;
export const HEADER_SIZE = 12;

export const TYPES = Object.freeze({
  HELLO: 0x01,
  HELLO_ACK: 0x02,
  OPEN: 0x10,
  OPENED: 0x11,
  HISTORY: 0x12,
  READY: 0x13,
  CLOSE_STREAM: 0x14,
  OUTPUT: 0x20,
  INPUT: 0x21,
  RESIZE: 0x22,
  ACK: 0x23,
  STATUS: 0x24,
  SESSION_EVENT: 0x30,
  PING: 0x40,
  PONG: 0x41,
  PROTOCOL_ERROR: 0x7f,
});

export const FLAGS = Object.freeze({
  FINAL: 0x01,
  ERROR: 0x02,
});

export const DIRECTIONS = Object.freeze({
  CLIENT_TO_SERVER: "client-to-server",
  SERVER_TO_CLIENT: "server-to-client",
});

export const INPUT_MAX_PAYLOAD = 4 * 1024;
export const OUTPUT_MAX_PAYLOAD = 32 * 1024;
export const HISTORY_CHUNK_SIZE = 64 * 1024;
export const JSON_MAX_PAYLOAD = 16 * 1024;
export const MAX_UNACKED_BYTES = 2 * 1024 * 1024;
export const MAX_BUFFERED_AMOUNT = 1024 * 1024;
export const BACKPRESSURE_TIMEOUT_MS = 10_000;
export const HEARTBEAT_MS = 15_000;

const KNOWN_FLAGS = FLAGS.FINAL | FLAGS.ERROR;
const TYPE_NAMES = new Map(Object.entries(TYPES).map(([name, type]) => [type, name]));
const JSON_TYPES = new Set([
  TYPES.HELLO,
  TYPES.HELLO_ACK,
  TYPES.OPEN,
  TYPES.OPENED,
  TYPES.READY,
  TYPES.STATUS,
  TYPES.SESSION_EVENT,
  TYPES.PROTOCOL_ERROR,
]);
const CONTROL_STREAM_TYPES = new Set([
  TYPES.HELLO,
  TYPES.HELLO_ACK,
  TYPES.OPEN,
  TYPES.SESSION_EVENT,
  TYPES.PING,
  TYPES.PONG,
]);
const ASSIGNED_STREAM_TYPES = new Set([
  TYPES.OPENED,
  TYPES.HISTORY,
  TYPES.READY,
  TYPES.CLOSE_STREAM,
  TYPES.OUTPUT,
  TYPES.INPUT,
  TYPES.RESIZE,
  TYPES.ACK,
]);
const CLIENT_TO_SERVER_TYPES = new Set([
  TYPES.HELLO,
  TYPES.OPEN,
  TYPES.INPUT,
  TYPES.RESIZE,
]);
const SERVER_TO_CLIENT_TYPES = new Set([
  TYPES.HELLO_ACK,
  TYPES.OPENED,
  TYPES.HISTORY,
  TYPES.READY,
  TYPES.OUTPUT,
  TYPES.STATUS,
  TYPES.SESSION_EVENT,
  TYPES.PROTOCOL_ERROR,
]);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function asBytes(value, name = "payload") {
  if (value === undefined || value === null) return new Uint8Array(0);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError(`${name} must be a Uint8Array, ArrayBuffer, or ArrayBuffer view`);
}

function assertUint(value, maximum, name) {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${name} must be an integer from 0 to ${maximum}`);
  }
}

function normalizeDirection(direction) {
  const value = direction && typeof direction === "object" ? direction.direction : direction;
  if (value === undefined || value === null) return null;
  if (value !== DIRECTIONS.CLIENT_TO_SERVER && value !== DIRECTIONS.SERVER_TO_CLIENT) {
    throw new TypeError(`Unknown RTP direction: ${String(value)}`);
  }
  return value;
}

function assertJsonObject(payload, type) {
  const value = decodeJson(payload);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${typeName(type)} payload must be a JSON object`);
  }
}

function validateFlags(type, flags) {
  if ((flags & ~KNOWN_FLAGS) !== 0) {
    throw new RangeError(`Unknown RTP flags: 0x${flags.toString(16)}`);
  }
  if (type === TYPES.HISTORY) {
    if ((flags & FLAGS.ERROR) !== 0) throw new TypeError("HISTORY cannot have the ERROR flag");
    return;
  }
  if (type === TYPES.CLOSE_STREAM) {
    if ((flags & FLAGS.FINAL) !== 0) throw new TypeError("CLOSE_STREAM cannot have the FINAL flag");
    return;
  }
  if (type === TYPES.PROTOCOL_ERROR) {
    if (flags !== FLAGS.ERROR) throw new TypeError("PROTOCOL_ERROR must have only the ERROR flag");
    return;
  }
  if (flags !== 0) throw new TypeError(`${typeName(type)} does not accept flags`);
}

export function typeName(type) {
  return TYPE_NAMES.get(type) ?? `UNKNOWN(0x${Number(type).toString(16)})`;
}

export function encodeJson(value) {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError("Value is not JSON-serializable");
  return textEncoder.encode(json);
}

export function decodeJson(payload) {
  const bytes = asBytes(payload);
  let text;
  try {
    text = textDecoder.decode(bytes);
  } catch (error) {
    throw new TypeError("Payload is not valid UTF-8 JSON", { cause: error });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new TypeError("Payload is not valid JSON", { cause: error });
  }
}

export function encodeResize(cols, rows) {
  if (!Number.isInteger(cols) || cols < 1 || cols > 0xffff) {
    throw new RangeError("cols must be an integer from 1 to 65535");
  }
  if (!Number.isInteger(rows) || rows < 1 || rows > 0xffff) {
    throw new RangeError("rows must be an integer from 1 to 65535");
  }
  const payload = new Uint8Array(4);
  const view = new DataView(payload.buffer);
  view.setUint16(0, cols, false);
  view.setUint16(2, rows, false);
  return payload;
}

export function decodeResize(payload) {
  const bytes = asBytes(payload);
  if (bytes.byteLength !== 4) throw new RangeError("RESIZE payload must be exactly 4 bytes");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cols = view.getUint16(0, false);
  const rows = view.getUint16(2, false);
  if (cols === 0 || rows === 0) throw new RangeError("RESIZE dimensions must be greater than zero");
  return { cols, rows };
}

export function encodePing(timestamp) {
  let value;
  if (typeof timestamp === "bigint") {
    value = timestamp;
  } else if (Number.isSafeInteger(timestamp) && timestamp >= 0) {
    value = BigInt(timestamp);
  } else {
    throw new RangeError("PING timestamp must be a non-negative safe integer or bigint");
  }
  if (value < 0n || value > 0xffffffffffffffffn) {
    throw new RangeError("PING timestamp must fit in uint64");
  }
  const payload = new Uint8Array(8);
  new DataView(payload.buffer).setBigUint64(0, value, false);
  return payload;
}

export function decodePing(payload) {
  const bytes = asBytes(payload);
  if (bytes.byteLength !== 8) throw new RangeError("PING/PONG payload must be exactly 8 bytes");
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, false);
}

export function validateFrame(frame, direction) {
  if (frame === null || typeof frame !== "object") throw new TypeError("frame must be an object");
  const { type, flags = 0, streamId = 0, sequence = 0 } = frame;
  assertUint(type, 0xff, "type");
  if (!TYPE_NAMES.has(type)) throw new RangeError(`Unknown RTP frame type: 0x${type.toString(16)}`);
  assertUint(flags, 0xff, "flags");
  assertUint(streamId, 0xffffffff, "streamId");
  assertUint(sequence, 0xffffffff, "sequence");
  const payload = asBytes(frame.payload);

  validateFlags(type, flags);

  if (CONTROL_STREAM_TYPES.has(type) && streamId !== 0) {
    throw new TypeError(`${typeName(type)} requires streamId 0`);
  }
  if (ASSIGNED_STREAM_TYPES.has(type) && streamId === 0) {
    throw new TypeError(`${typeName(type)} requires an assigned streamId`);
  }

  const normalizedDirection = normalizeDirection(direction);
  if (normalizedDirection === DIRECTIONS.CLIENT_TO_SERVER && SERVER_TO_CLIENT_TYPES.has(type)) {
    throw new TypeError(`${typeName(type)} is not valid client-to-server`);
  }
  if (normalizedDirection === DIRECTIONS.SERVER_TO_CLIENT && CLIENT_TO_SERVER_TYPES.has(type)) {
    throw new TypeError(`${typeName(type)} is not valid server-to-client`);
  }

  if ((JSON_TYPES.has(type) || (type === TYPES.CLOSE_STREAM && (flags & FLAGS.ERROR) !== 0)) &&
      payload.byteLength > JSON_MAX_PAYLOAD) {
    throw new RangeError(`JSON control payload must not exceed ${JSON_MAX_PAYLOAD} bytes`);
  }
  if (JSON_TYPES.has(type)) {
    assertJsonObject(payload, type);
  } else if (type === TYPES.CLOSE_STREAM) {
    if ((flags & FLAGS.ERROR) !== 0) assertJsonObject(payload, type);
    else if (payload.byteLength !== 0) throw new RangeError("Normal CLOSE_STREAM payload must be empty");
  } else if (type === TYPES.RESIZE) {
    decodeResize(payload);
  } else if (type === TYPES.ACK) {
    if (payload.byteLength !== 0) throw new RangeError("ACK payload must be empty");
  } else if (type === TYPES.PING || type === TYPES.PONG) {
    decodePing(payload);
  }
  if (type === TYPES.INPUT && payload.byteLength > INPUT_MAX_PAYLOAD) {
    throw new RangeError(`INPUT payload must not exceed ${INPUT_MAX_PAYLOAD} bytes`);
  }
  if (type === TYPES.OUTPUT && payload.byteLength > OUTPUT_MAX_PAYLOAD) {
    throw new RangeError(`OUTPUT payload must not exceed ${OUTPUT_MAX_PAYLOAD} bytes`);
  }
  if (type === TYPES.HISTORY && payload.byteLength > HISTORY_CHUNK_SIZE) {
    throw new RangeError(`HISTORY payload must not exceed ${HISTORY_CHUNK_SIZE} bytes`);
  }

  return frame;
}

export function encodeFrame({ type, flags = 0, streamId = 0, sequence = 0, payload } = {}) {
  const bytes = asBytes(payload);
  validateFrame({ type, flags, streamId, sequence, payload: bytes });
  const encoded = new Uint8Array(HEADER_SIZE + bytes.byteLength);
  const view = new DataView(encoded.buffer);
  view.setUint8(0, MAGIC);
  view.setUint8(1, VERSION);
  view.setUint8(2, type);
  view.setUint8(3, flags);
  view.setUint32(4, streamId, false);
  view.setUint32(8, sequence, false);
  encoded.set(bytes, HEADER_SIZE);
  return encoded;
}

export function decodeFrame(data, direction) {
  const bytes = asBytes(data, "frame");
  if (bytes.byteLength < HEADER_SIZE) {
    throw new RangeError(`RTP frame must be at least ${HEADER_SIZE} bytes`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== MAGIC) throw new RangeError("Invalid RTP magic");
  if (view.getUint8(1) !== VERSION) throw new RangeError("Unsupported RTP version");
  const frame = {
    type: view.getUint8(2),
    flags: view.getUint8(3),
    streamId: view.getUint32(4, false),
    sequence: view.getUint32(8, false),
    payload: bytes.subarray(HEADER_SIZE),
  };
  validateFrame(frame, direction);
  return frame;
}
