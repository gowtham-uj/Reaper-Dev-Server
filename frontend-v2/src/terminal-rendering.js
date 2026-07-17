export const LIVE_WRITE_BATCH_MS = 8;
export const FIT_VERIFY_DELAYS_MS = Object.freeze([48, 240]);

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

export function terminalDimensionsDiffer(current, proposed) {
  return positiveInteger(current?.cols) !== positiveInteger(proposed?.cols) ||
    positiveInteger(current?.rows) !== positiveInteger(proposed?.rows);
}

export function terminalGeometryOverflows(hostRect, screenRect, tolerance = 1) {
  if (!hostRect || !screenRect) return false;
  return screenRect.width > hostRect.width + tolerance ||
    screenRect.height > hostRect.height + tolerance;
}

export function shouldRefitTerminal({ current, proposed, hostRect, screenRect }) {
  return terminalDimensionsDiffer(current, proposed) ||
    terminalGeometryOverflows(hostRect, screenRect);
}

export function joinTerminalPayloads(payloads) {
  if (!Array.isArray(payloads) || payloads.length === 0) return new Uint8Array();
  if (payloads.length === 1) return payloads[0];
  const length = payloads.reduce((total, payload) => total + payload.byteLength, 0);
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const payload of payloads) {
    joined.set(payload, offset);
    offset += payload.byteLength;
  }
  return joined;
}
