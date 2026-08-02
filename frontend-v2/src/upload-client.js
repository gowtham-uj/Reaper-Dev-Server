import {
  authFetch,
  downloadUrl,
  invalidateTerminalCsrfToken,
  terminalCsrfToken
} from "./api.js";

const RETRYABLE_STATUS = new Set([0, 403, 408, 409, 425, 429]);
const MAX_RETRY_DELAY_MS = 30_000;

function abortError() {
  const error = new Error("Upload paused");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function apiError(status, body, fallback = "Upload request failed") {
  const error = new Error(body?.error || fallback);
  error.status = status;
  if (Number.isSafeInteger(body?.offset)) error.offset = body.offset;
  return error;
}

async function responseBody(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { return { error: text }; }
}

async function requestJson(path, options = {}) {
  const response = await authFetch(path, options);
  const body = await responseBody(response);
  if (!response.ok) throw apiError(response.status, body);
  return body;
}

export function uploadResumeKey(file, relativePath = file?.name || "") {
  return `v1:${relativePath}:${Number(file?.size || 0)}:${Number(file?.lastModified || 0)}`;
}

export function uploadPercent(uploaded, total) {
  if (!Number.isFinite(total) || total <= 0) return 100;
  return Math.max(0, Math.min(100, (Number(uploaded || 0) / total) * 100));
}

export function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const scaled = bytes / (1024 ** index);
  const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(digits)} ${units[index]}`;
}

export function formatRate(bytesPerSecond) {
  const rate = Number(bytesPerSecond || 0);
  return rate > 0 ? `${formatBytes(rate)}/s` : "Calculating speed…";
}

export function formatDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return "Estimating time…";
  if (value < 60) return `${Math.max(1, Math.ceil(value))}s remaining`;
  if (value < 3600) return `${Math.ceil(value / 60)}m remaining`;
  if (value < 86400) return `${Math.ceil(value / 3600)}h remaining`;
  return `${Math.ceil(value / 86400)}d remaining`;
}

export function isRetryableUploadError(error) {
  return RETRYABLE_STATUS.has(Number(error?.status || 0)) || Number(error?.status || 0) >= 500;
}

export async function listPendingUploads(project) {
  const base = `/api/projects/${encodeURIComponent(project)}/uploads`;
  const body = await requestJson(base);
  return Array.isArray(body.uploads) ? body.uploads : [];
}

export async function beginResumableUpload(project, file, relativePath = file.name) {
  const base = `/api/projects/${encodeURIComponent(project)}/uploads`;
  const body = await requestJson(base, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: relativePath,
      size: file.size,
      lastModified: file.lastModified || 0,
      resumeKey: uploadResumeKey(file, relativePath)
    })
  });
  return body.upload;
}

export async function getResumableUpload(project, uploadId) {
  const path = `/api/projects/${encodeURIComponent(project)}/uploads/${encodeURIComponent(uploadId)}`;
  const body = await requestJson(path);
  return body.upload;
}

export async function cancelResumableUpload(project, uploadId) {
  const path = `/api/projects/${encodeURIComponent(project)}/uploads/${encodeURIComponent(uploadId)}`;
  const body = await requestJson(path, { method: "DELETE" });
  return body.upload;
}

async function completeResumableUpload(project, uploadId) {
  const path = `/api/projects/${encodeURIComponent(project)}/uploads/${encodeURIComponent(uploadId)}/complete`;
  const body = await requestJson(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  return body.upload;
}

function uploadChunk({ project, uploadId, offset, blob, signal, onProgress }) {
  return new Promise(async (resolve, reject) => {
    let xhr;
    let settled = false;
    let token;
    const path = `/api/projects/${encodeURIComponent(project)}/uploads/${encodeURIComponent(uploadId)}`;

    const cleanup = () => signal?.removeEventListener("abort", handleAbort);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const handleAbort = () => {
      xhr?.abort();
      finish(reject, abortError());
    };

    try {
      throwIfAborted(signal);
      token = await terminalCsrfToken();
      throwIfAborted(signal);
      xhr = new XMLHttpRequest();
      xhr.open("PATCH", downloadUrl(path), true);
      xhr.withCredentials = true;
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.setRequestHeader("Upload-Offset", String(offset));
      xhr.setRequestHeader("X-CSRF-Token", token);
      xhr.upload.addEventListener("progress", (event) => {
        if (!settled) onProgress?.(Math.min(blob.size, event.loaded));
      });
      xhr.addEventListener("load", () => {
        let body = {};
        try { body = xhr.responseText ? JSON.parse(xhr.responseText) : {}; }
        catch { body = { error: xhr.responseText }; }
        if (xhr.status >= 200 && xhr.status < 300) {
          finish(resolve, body.upload || { offset: Number(xhr.getResponseHeader("Upload-Offset")) });
          return;
        }
        if (xhr.status === 403) invalidateTerminalCsrfToken();
        finish(reject, apiError(xhr.status, body));
      });
      xhr.addEventListener("error", () => finish(reject, apiError(0, {}, "Network connection interrupted")));
      xhr.addEventListener("timeout", () => finish(reject, apiError(408, {}, "Upload chunk timed out")));
      xhr.addEventListener("abort", () => finish(reject, abortError()));
      signal?.addEventListener("abort", handleAbort, { once: true });
      xhr.send(blob);
    } catch (error) {
      finish(reject, error);
    }
  });
}

function retryDelay(attempt) {
  return Math.min(MAX_RETRY_DELAY_MS, 1000 * (2 ** Math.min(attempt, 5)));
}

function wait(delay, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, delay);
    const stop = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", stop, { once: true });
  });
}

export async function uploadFileResumably({ project, file, relativePath = file.name, signal, onProgress }) {
  throwIfAborted(signal);
  onProgress?.({ phase: "preparing", uploaded: 0, confirmed: 0, total: file.size, speed: 0, eta: null });
  let upload = null;
  let offset = 0;
  let initialOffset = 0;
  const startedAt = performance.now();
  let retryAttempt = 0;

  const report = (phase, uploaded = offset, confirmed = offset, retryIn = null) => {
    const elapsedSeconds = Math.max(0.001, (performance.now() - startedAt) / 1000);
    const sessionBytes = Math.max(0, uploaded - initialOffset);
    const speed = sessionBytes / elapsedSeconds;
    const eta = speed > 0 ? Math.max(0, file.size - uploaded) / speed : null;
    onProgress?.({
      phase,
      uploadId: upload?.id || null,
      uploaded,
      confirmed,
      total: file.size,
      speed,
      eta,
      retryIn,
      resumed: Boolean(upload?.resumed || initialOffset > 0)
    });
  };

  while (!upload) {
    throwIfAborted(signal);
    try {
      upload = await beginResumableUpload(project, file, relativePath);
      offset = upload.offset;
      initialOffset = offset;
      retryAttempt = 0;
    } catch (error) {
      if (error.name === "AbortError" || signal?.aborted) throw abortError();
      if (!isRetryableUploadError(error)) throw error;
      const delay = retryDelay(retryAttempt++);
      report("retrying", 0, 0, delay);
      await wait(delay, signal);
    }
  }

  report("uploading");
  while (offset < file.size) {
    throwIfAborted(signal);
    const end = Math.min(file.size, offset + upload.chunkSize);
    const blob = file.slice(offset, end);
    try {
      const result = await uploadChunk({
        project,
        uploadId: upload.id,
        offset,
        blob,
        signal,
        onProgress: (loaded) => report("uploading", offset + loaded, offset)
      });
      offset = Number.isSafeInteger(result?.offset) ? result.offset : end;
      retryAttempt = 0;
      report("uploading", offset, offset);
    } catch (error) {
      if (error.name === "AbortError" || signal?.aborted) throw abortError();
      if (!isRetryableUploadError(error)) throw error;
      if (error.status === 403) invalidateTerminalCsrfToken();

      try {
        upload = await getResumableUpload(project, upload.id);
        offset = upload.offset;
        if (upload.completed) {
          report("complete", upload.size, upload.size);
          return upload;
        }
      } catch (statusError) {
        if (!isRetryableUploadError(statusError)) throw statusError;
      }

      const delay = error.status === 403 || error.status === 409 ? 0 : retryDelay(retryAttempt++);
      report("retrying", offset, offset, delay);
      if (delay) await wait(delay, signal);
    }
  }

  report("finalizing", file.size, file.size);
  retryAttempt = 0;
  while (true) {
    throwIfAborted(signal);
    try {
      upload = await completeResumableUpload(project, upload.id);
      report("complete", upload.size, upload.size);
      return upload;
    } catch (error) {
      if (error.name === "AbortError" || signal?.aborted) throw abortError();
      if (!isRetryableUploadError(error)) throw error;
      try {
        upload = await getResumableUpload(project, upload.id);
        if (upload.completed) {
          report("complete", upload.size, upload.size);
          return upload;
        }
      } catch (statusError) {
        if (!isRetryableUploadError(statusError)) throw statusError;
      }
      const delay = retryDelay(retryAttempt++);
      report("retrying", file.size, file.size, delay);
      await wait(delay, signal);
    }
  }
}
