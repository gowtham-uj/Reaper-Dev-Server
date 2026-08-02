import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ResumableUploadStore } from "./services/resumable-upload.js";
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`server start timed out: ${output}`)), 15_000);
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes("[reaper] listening")) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with ${code}: ${output}`));
    });
  });
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

function startServer({ port, projectsRoot, stateDir, globalEnv }) {
  return spawn(process.execPath, ["src/server.js"], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    env: {
      ...process.env,
      NODE_ENV: "test",
      REAPER_FORCE_BACKEND: "subprocess",
      REAPER_PORT: String(port),
      VPS_PROJECTS: projectsRoot,
      STATE_DIR: stateDir,
      GLOBAL_ENV: globalEnv,
      JWT_ACCESS_SECRET: "test-upload-secret-that-is-longer-than-thirty-two-characters",
      APP_ADMIN_USERNAME: "upload_admin",
      APP_ADMIN_PASSWORD: "S3cureUploadFixture!2026",
      COOKIE_SECURE: "false",
      APEX_DOMAIN: "",
      COOKIE_DOMAIN: "",
      UPLOAD_STORAGE_RESERVE_BYTES: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
}


async function pollForOffset(request, pathname, expected) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await request(pathname);
    if (response.ok) {
      const body = await response.json();
      if (body.upload.offset === expected) return body.upload;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`upload did not persist offset ${expected}`);
}

test("default uploads use the maximum supported 256 MiB request size", () => {
  const store = new ResumableUploadStore({ projectsRoot: ".", storageReserveBytes: 0 });
  assert.equal(store.chunkBytes, 256 * 1024 * 1024);
  assert.throws(
    () => new ResumableUploadStore({
      projectsRoot: ".",
      chunkBytes: 256 * 1024 * 1024 + 1,
      storageReserveBytes: 0
    }),
    /between 1 MiB and 256 MiB/
  );
});

test("batched writes preserve a request larger than the internal I/O buffer", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reaper-batched-upload-"));
  const size = 17 * 1024 * 1024;
  await fs.mkdir(path.join(root, "demo"));
  const store = new ResumableUploadStore({ projectsRoot: root, storageReserveBytes: 0 });
  try {
    const upload = await store.begin("demo", {
      path: "batched.bin",
      size,
      lastModified: 1,
      resumeKey: `batched:${size}:1`
    });
    const request = Readable.from([Buffer.alloc(size, 0x5a)]);
    request.headers = { "upload-offset": "0", "content-length": String(size) };
    request.complete = true;
    request.aborted = false;
    const result = await store.writeChunk("demo", upload.id, request);
    assert.equal(result.aborted, false);
    assert.equal(result.upload.offset, size);
    await store.complete("demo", upload.id);
    const saved = await fs.readFile(path.join(root, "demo", "batched.bin"));
    assert.equal(saved.length, size);
    assert.equal(saved[0], 0x5a);
    assert.equal(saved.at(-1), 0x5a);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an interrupted chunk keeps only bytes durably written before disconnect", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reaper-interrupted-chunk-"));
  await fs.mkdir(path.join(root, "demo"));
  const store = new ResumableUploadStore({ projectsRoot: root, storageReserveBytes: 0 });
  try {
    const upload = await store.begin("demo", {
      path: "resume.bin",
      size: 5,
      lastModified: 1,
      resumeKey: "resume:5:1"
    });
    const request = Readable.from([Buffer.from("hel")]);
    request.headers = { "upload-offset": "0", "content-length": "5" };
    request.complete = false;
    request.aborted = true;
    const result = await store.writeChunk("demo", upload.id, request);
    assert.equal(result.aborted, true);
    assert.equal(result.upload.offset, 3);
    assert.equal((await store.status("demo", upload.id)).offset, 3);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("resumable upload preserves durable offsets and survives backend restart", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reaper-resumable-upload-"));
  const projectsRoot = path.join(root, "projects");
  const stateDir = path.join(root, "state");
  const globalEnv = path.join(root, "global-env.json");
  const project = "upload-fixture";
  await fs.mkdir(path.join(projectsRoot, project), { recursive: true });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let child = startServer({ port, projectsRoot, stateDir, globalEnv });
  let cookieHeader = "";
  let csrfToken = "";

  const request = async (pathname, options = {}) => {
    const headers = { "user-agent": "Mozilla/5.0 Reaper upload integration test", ...(options.headers || {}) };
    if (cookieHeader) headers.cookie = cookieHeader;
    if (csrfToken && options.method && !["GET", "HEAD"].includes(options.method)) headers["x-csrf-token"] = csrfToken;
    if (options.body && !headers["content-type"]) headers["content-type"] = "application/json";
    return fetch(`${base}${pathname}`, { ...options, headers });
  };

  try {
    await waitForServer(child);
    const login = await request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "upload_admin", password: "S3cureUploadFixture!2026" })
    });
    assert.equal(login.status, 200);
    const loginBody = await login.json();
    csrfToken = loginBody.csrfToken;
    const setCookie = login.headers.get("set-cookie") || "";
    const access = /(?:^|,\s*)reaper_access=([^;,]+)/.exec(setCookie)?.[1];
    assert.ok(access, setCookie);
    cookieHeader = `reaper_access=${access}; reaper_csrf=${csrfToken}`;

    const uploadsPath = `/api/projects/${project}/uploads`;
    const started = await request(uploadsPath, {
      method: "POST",
      body: JSON.stringify({
        path: "large.bin",
        size: 11,
        lastModified: 123,
        resumeKey: "fixture:large.bin:11:123"
      })
    });
    assert.equal(started.status, 201);
    const upload = (await started.json()).upload;
    assert.equal(upload.offset, 0);

    const firstChunk = Buffer.from("hel");
    const saved = await request(`${uploadsPath}/${upload.id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(firstChunk.length),
        "upload-offset": "0"
      },
      body: firstChunk
    });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).upload.offset, 3);

    await stopServer(child);
    child = startServer({ port, projectsRoot, stateDir, globalEnv });
    await waitForServer(child);
    const afterRestart = await pollForOffset(request, `${uploadsPath}/${upload.id}`, 3);
    assert.equal(afterRestart.completed, false);

    // Simulate bytes that reached the filesystem but were never fsynced and
    // acknowledged before a hard process failure. Status must remain at the
    // durable metadata offset, and the next chunk truncates the unsafe tail.
    const partPath = path.join(projectsRoot, ".reaper-uploads", project, `${upload.id}.part`);
    await fs.appendFile(partPath, "XX");
    const conservative = await request(`${uploadsPath}/${upload.id}`);
    assert.equal(conservative.status, 200);
    assert.equal((await conservative.json()).upload.offset, 3);

    const remainder = Buffer.from("lo world");
    const chunk = await request(`${uploadsPath}/${upload.id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(remainder.length),
        "upload-offset": "3"
      },
      body: remainder
    });
    const chunkBody = await chunk.json();
    assert.equal(chunk.status, 200, JSON.stringify(chunkBody));
    assert.equal(chunk.headers.get("upload-offset"), "11");

    const completed = await request(`${uploadsPath}/${upload.id}/complete`, {
      method: "POST",
      body: "{}"
    });
    const completedBody = await completed.json();
    assert.equal(completed.status, 200, JSON.stringify(completedBody));
    assert.equal(completedBody.upload.completed, true);
    assert.equal(await fs.readFile(path.join(projectsRoot, project, "large.bin"), "utf8"), "hello world");

    const pending = await request(uploadsPath);
    assert.equal(pending.status, 200);
    assert.deepEqual((await pending.json()).uploads, []);

    const repeatedComplete = await request(`${uploadsPath}/${upload.id}/complete`, {
      method: "POST",
      body: "{}"
    });
    assert.equal(repeatedComplete.status, 200);
    assert.equal((await repeatedComplete.json()).upload.completed, true);
  } finally {
    await stopServer(child);
    await fs.rm(root, { recursive: true, force: true });
  }
});
