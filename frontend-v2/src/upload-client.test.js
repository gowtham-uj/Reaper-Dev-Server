import assert from "node:assert/strict";
import test from "node:test";
import {
  formatBytes,
  formatDuration,
  formatRate,
  uploadFileResumably,
  uploadPercent,
  uploadResumeKey
} from "./upload-client.js";

test("upload formatting remains useful from bytes through multi-terabyte files", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(5 * 1024 ** 4), "5.00 TB");
  assert.equal(formatRate(8 * 1024 ** 2), "8.00 MB/s");
  assert.equal(formatDuration(3700), "2h remaining");
  assert.equal(uploadPercent(1, 4), 25);
  assert.equal(uploadPercent(10, 4), 100);
  const file = { name: "archive.bin", size: 5 * 1024 ** 4, lastModified: 123 };
  assert.equal(uploadResumeKey(file), `v1:archive.bin:${5 * 1024 ** 4}:123`);
});

test("chunk upload reports live bytes before each durable server confirmation", async () => {
  const originalFetch = globalThis.fetch;
  const originalXhr = globalThis.XMLHttpRequest;
  const uploadId = "8cf3a81f-c00f-4c22-b53b-9a6aa05fdf39";
  const fetchCalls = [];
  const xhrOffsets = [];

  class FakeXMLHttpRequest {
    constructor() {
      this.listeners = new Map();
      this.uploadListeners = new Map();
      this.headers = {};
      this.upload = {
        addEventListener: (type, listener) => this.uploadListeners.set(type, listener)
      };
    }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(name, value) { this.headers[name.toLowerCase()] = value; }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    getResponseHeader(name) { return name.toLowerCase() === "upload-offset" ? this.responseOffset : null; }
    abort() { this.listeners.get("abort")?.(); }
    send(blob) {
      const offset = Number(this.headers["upload-offset"]);
      xhrOffsets.push(offset);
      queueMicrotask(() => {
        this.uploadListeners.get("progress")?.({ loaded: Math.max(1, Math.floor(blob.size / 2)) });
        this.uploadListeners.get("progress")?.({ loaded: blob.size });
        this.status = 200;
        this.responseOffset = String(offset + blob.size);
        this.responseText = JSON.stringify({ upload: { id: uploadId, offset: offset + blob.size } });
        this.listeners.get("load")?.();
      });
    }
  }

  globalThis.XMLHttpRequest = FakeXMLHttpRequest;
  globalThis.fetch = async (url, options = {}) => {
    const pathname = String(url);
    fetchCalls.push({ pathname, method: options.method || "GET" });
    if (pathname.endsWith("/api/auth/csrf")) {
      return new Response(JSON.stringify({ csrfToken: "test-csrf-token" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (pathname.endsWith("/complete")) {
      return new Response(JSON.stringify({
        upload: { id: uploadId, path: "six.bin", size: 6, offset: 6, completed: true, chunkSize: 4 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (pathname.endsWith("/uploads") && options.method === "POST") {
      return new Response(JSON.stringify({
        upload: { id: uploadId, path: "six.bin", size: 6, offset: 0, completed: false, chunkSize: 4 }
      }), { status: 201, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch ${options.method || "GET"} ${pathname}`);
  };

  try {
    const file = new Blob(["abcdef"]);
    Object.defineProperties(file, {
      name: { value: "six.bin" },
      lastModified: { value: 123 }
    });
    const events = [];
    const completed = await uploadFileResumably({
      project: "demo",
      file,
      onProgress: (event) => events.push({ ...event })
    });

    assert.equal(completed.completed, true);
    assert.deepEqual(xhrOffsets, [0, 4]);
    assert.ok(events.some((event) => event.phase === "uploading" && event.uploaded === 2 && event.confirmed === 0));
    assert.ok(events.some((event) => event.phase === "uploading" && event.uploaded === 5 && event.confirmed === 4));
    assert.equal(events.at(-1).phase, "complete");
    assert.equal(events.at(-1).uploaded, 6);
    assert.equal(events.at(-1).confirmed, 6);
    assert.ok(fetchCalls.some((call) => call.pathname.endsWith("/complete")));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalXhr === undefined) delete globalThis.XMLHttpRequest;
    else globalThis.XMLHttpRequest = originalXhr;
  }
});
