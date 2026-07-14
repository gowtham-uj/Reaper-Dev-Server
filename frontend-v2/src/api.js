// API client for Reaper V2. Uses cookies + CSRF token for browser auth,
// and Authorization: Bearer for API tokens.
// REAPER_V2_API_BASE is injected by Vite (see vite.config.js deployBase + API_BASE).
function apiBase() {
  const raw = (import.meta.env && import.meta.env.VITE_API_BASE) || "";
  return raw.replace(/\/$/, "");
}

const inflight = new Map();
let csrfToken = null;
let csrfPromise = null;

async function ensureCsrfToken() {
  if (csrfToken) return csrfToken;
  if (!csrfPromise) {
    csrfPromise = fetch(joinUrl("/api/auth/csrf"), { credentials: "include" })
      .then(parse)
      .then((body) => {
        if (!body.csrfToken) throw new Error("CSRF token unavailable");
        return body.csrfToken;
      })
      .finally(() => { csrfPromise = null; });
  }
  return csrfPromise;
}

export async function terminalCsrfToken() {
  return ensureCsrfToken();
}

export function invalidateTerminalCsrfToken() {
  csrfToken = null;
}

function isCsrfFailure(error) {
  return error?.status === 403 && /csrf/i.test(error.message || "");
}

async function refreshCsrfAfterFailure(sentToken) {
  // Several mutations can fail on the same stale token concurrently. Only the
  // first rotates it; the rest reuse that in-flight/new token.
  if (csrfToken === sentToken) csrfToken = null;
  if (!csrfToken) await ensureCsrfToken();
}

function joinUrl(path) {
  const b = apiBase();
  if (!b) return path;
  if (path.startsWith("/")) return b + path;
  return b + "/" + path;
}

export function terminalWebSocketUrl() {
  const base = new URL(apiBase() || window.location.origin, window.location.href);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = `${base.pathname.replace(/\/$/, "")}/terminal/ws`;
  base.search = "";
  base.hash = "";
  return base.toString();
}

const UNAUTHENTICATED_PATHS = new Set([
  "/api/auth/login",
  "/api/auth/me",
  "/api/auth/csrf"
]);

function dispatchUnauthorized(path, status) {
  if (status !== 401 || typeof window === "undefined") return;
  let pathname;
  try {
    pathname = new URL(path, window.location.origin).pathname;
  } catch {
    pathname = path;
  }
  if (UNAUTHENTICATED_PATHS.has(pathname)) return;
  const next = window.location.pathname + window.location.search + window.location.hash;
  window.dispatchEvent(new CustomEvent("reaper:unauthorized", { detail: { next } }));
}

function handleApiError(path, error) {
  dispatchUnauthorized(path, error?.status);
  throw error;
}

export async function api(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const unsafe = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
  const protectedMutation = unsafe && path !== "/api/auth/login";
  if (protectedMutation && !csrfToken) await ensureCsrfToken();
  const sentToken = csrfToken;

  const request = async () => {
    const headers = { ...(options.headers || {}) };
    if (!(options.body instanceof FormData) && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    if (protectedMutation && csrfToken) headers["X-CSRF-Token"] = csrfToken;
    try {
      return await fetch(joinUrl(path), { credentials: "include", ...options, headers, method }).then(parse);
    } catch (error) {
      handleApiError(path, error);
    }
  };

  if (method === "GET" && !options.signal) {
    const key = method + ":" + path;
    if (inflight.has(key)) return inflight.get(key);
    const pending = request().finally(() => inflight.delete(key));
    inflight.set(key, pending);
    return pending;
  }

  try {
    const body = await request();
    if (path === "/api/auth/logout") csrfToken = null;
    return body;
  } catch (error) {
    if (!protectedMutation || !isCsrfFailure(error)) throw error;
    await refreshCsrfAfterFailure(sentToken);
    const body = await request();
    if (path === "/api/auth/logout") csrfToken = null;
    return body;
  }
}

async function parse(r) {
  const ct = r.headers.get("content-type") || "";
  const body = ct.includes("application/json") ? await r.json() : { error: await r.text() };
  if (!r.ok) {
    const error = new Error(body.error || "Request failed: " + r.status);
    error.status = r.status;
    throw error;
  }
  if (body.csrfToken) csrfToken = body.csrfToken;
  return body;
}

// Raw CSRF-aware fetch for streamed bodies (large uploads/downloads). It never
// JSON-wraps the body, so a File/Blob streams straight to the server and a
// response streams straight back — no base64, no full-file buffering.
export async function authFetch(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const unsafe = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
  if (unsafe && !csrfToken) await ensureCsrfToken();
  const sentToken = csrfToken;

  const request = () => {
    const headers = { ...(options.headers || {}) };
    if (unsafe && csrfToken) headers["X-CSRF-Token"] = csrfToken;
    return fetch(joinUrl(path), { credentials: "include", ...options, headers, method });
  };

  let response = await request();
  if (unsafe && response.status === 403) {
    const detail = await response.clone().text().catch(() => "");
    if (/csrf/i.test(detail)) {
      await refreshCsrfAfterFailure(sentToken);
      response = await request();
    }
  }
  dispatchUnauthorized(path, response.status);
  return response;
}

export function downloadUrl(path) {
  return joinUrl(path);
}
