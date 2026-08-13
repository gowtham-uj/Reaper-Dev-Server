import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import fss from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync, strFromU8 } from "fflate";
import test from "node:test";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`server did not start: ${output}`)), 15_000);
    const consume = (chunk) => {
      output += chunk.toString();
      if (output.includes("[reaper] listening")) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with code ${code}: ${output}`));
    });
  });
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  child.kill("SIGTERM");
  let timeout;
  const result = await Promise.race([
    exited,
    new Promise((resolve) => { timeout = setTimeout(() => resolve(null), 5_000); })
  ]);
  clearTimeout(timeout);
  if (!result) {
    child.kill("SIGKILL");
    throw new Error("server did not exit within five seconds of SIGTERM");
  }
}

async function withServer(envExtra, run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reaper-folder-zip-"));
  const projectsRoot = path.join(root, "projects");
  const stateDir = path.join(root, "state");
  await fs.mkdir(projectsRoot, { recursive: true });
  const port = await freePort();
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    env: {
      ...process.env,
      NODE_ENV: "test",
      REAPER_FORCE_BACKEND: "subprocess",
      REAPER_PORT: String(port),
      VPS_PROJECTS: projectsRoot,
      STATE_DIR: stateDir,
      GLOBAL_ENV: path.join(root, "global-env.json"),
      JWT_ACCESS_SECRET: "test-access-secret-that-is-longer-than-thirty-two-characters",
      APP_ADMIN_USERNAME: "zip_admin",
      APP_ADMIN_PASSWORD: "S3cureFixture!2026",
      COOKIE_SECURE: "false",
      APEX_DOMAIN: "",
      COOKIE_DOMAIN: "",
      ...envExtra
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  const base = `http://127.0.0.1:${port}`;
  let cookieHeader = "";
  let csrfToken = "";
  const request = async (pathname, options = {}) => {
    const headers = { "user-agent": "Mozilla/5.0 Reaper folder zip test", ...(options.headers || {}) };
    if (cookieHeader && !headers.authorization && !headers.cookie) headers.cookie = cookieHeader;
    if (csrfToken && options.method && !["GET", "HEAD"].includes(options.method)) headers["x-csrf-token"] = csrfToken;
    if (options.body && !headers["content-type"]) headers["content-type"] = "application/json";
    return fetch(`${base}${pathname}`, { ...options, headers });
  };

  try {
    await waitForServer(child);
    const login = await request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "zip_admin", password: "S3cureFixture!2026" })
    });
    assert.equal(login.status, 200);
    const loginBody = await login.json();
    csrfToken = loginBody.csrfToken;
    const setCookie = login.headers.get("set-cookie") || "";
    const access = /(?:^|,\s*)reaper_access=([^;,]+)/.exec(setCookie)?.[1];
    assert.ok(access, setCookie);
    cookieHeader = `reaper_access=${access}; reaper_csrf=${csrfToken}`;

    const created = await request("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "zip-demo" })
    });
    assert.equal(created.status, 201, await created.text());

    await run({
      root,
      projectsRoot,
      projectRoot: path.join(projectsRoot, "zip-demo"),
      request,
      csrfToken,
      cookieHeader
    });
  } finally {
    await stopServer(child).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
}

function dispositionName(header) {
  const match = /filename="([^"]+)"/.exec(header || "");
  return match?.[1] || "";
}

test("folder download zips nested files, empty dirs, and zero-byte files", async () => {
  await withServer({}, async ({ projectRoot, request }) => {
    await fs.mkdir(path.join(projectRoot, "docs", "empty-nested"), { recursive: true });
    await fs.mkdir(path.join(projectRoot, "docs", "nested"), { recursive: true });
    await fs.writeFile(path.join(projectRoot, "docs", "readme.txt"), "hello folder");
    await fs.writeFile(path.join(projectRoot, "docs", "nested", "note.md"), "# note\n");
    await fs.writeFile(path.join(projectRoot, "docs", "nested", "empty.bin"), "");

    const head = await request("/api/projects/zip-demo/download?path=docs", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.match(head.headers.get("content-type") || "", /application\/zip/i);
    assert.equal(dispositionName(head.headers.get("content-disposition")), "docs.zip");
    assert.equal(await head.text(), "");
    assert.ok(Number(head.headers.get("x-reaper-zip-entries")) >= 4);
    assert.ok(Number(head.headers.get("x-reaper-zip-bytes")) >= "hello folder".length);

    const get = await request("/api/projects/zip-demo/download?path=docs");
    assert.equal(get.status, 200);
    assert.match(get.headers.get("content-type") || "", /application\/zip/i);
    assert.equal(dispositionName(get.headers.get("content-disposition")), "docs.zip");
    const bytes = new Uint8Array(await get.arrayBuffer());
    assert.ok(bytes.byteLength > 0);
    const unzipped = unzipSync(bytes);
    const names = Object.keys(unzipped).sort();
    assert.deepEqual(names, [
      "docs/",
      "docs/empty-nested/",
      "docs/nested/",
      "docs/nested/empty.bin",
      "docs/nested/note.md",
      "docs/readme.txt"
    ].sort());
    assert.equal(strFromU8(unzipped["docs/readme.txt"]), "hello folder");
    assert.equal(strFromU8(unzipped["docs/nested/note.md"]), "# note\n");
    assert.equal(unzipped["docs/nested/empty.bin"].byteLength, 0);
  });
});

test("single-file download remains unchanged and empty folders zip", async () => {
  await withServer({}, async ({ projectRoot, request }) => {
    await fs.mkdir(path.join(projectRoot, "lonely"), { recursive: true });
    await fs.writeFile(path.join(projectRoot, "solo.txt"), "just a file");

    const fileHead = await request("/api/projects/zip-demo/download?path=solo.txt", { method: "HEAD" });
    assert.equal(fileHead.status, 200);
    assert.match(fileHead.headers.get("content-type") || "", /application\/octet-stream/i);
    assert.equal(dispositionName(fileHead.headers.get("content-disposition")), "solo.txt");
    assert.equal(fileHead.headers.get("content-length"), String(Buffer.byteLength("just a file")));

    const fileGet = await request("/api/projects/zip-demo/download?path=solo.txt");
    assert.equal(fileGet.status, 200);
    assert.equal(await fileGet.text(), "just a file");

    const emptyGet = await request("/api/projects/zip-demo/download?path=lonely");
    assert.equal(emptyGet.status, 200);
    assert.match(emptyGet.headers.get("content-type") || "", /application\/zip/i);
    const unzipped = unzipSync(new Uint8Array(await emptyGet.arrayBuffer()));
    assert.deepEqual(Object.keys(unzipped).sort(), ["lonely/"]);
  });
});

test("folder zip rejects missing paths, traversal, and required path", async () => {
  await withServer({}, async ({ request }) => {
    const missing = await request("/api/projects/zip-demo/download?path=does-not-exist");
    assert.equal(missing.status, 404);

    const required = await request("/api/projects/zip-demo/download");
    assert.equal(required.status, 400);
    assert.match((await required.json()).error || "", /path is required/i);

    const traversal = await request("/api/projects/zip-demo/download?path=" + encodeURIComponent("../secret"));
    assert.equal(traversal.status, 400);
    assert.match((await traversal.json()).error || "", /path traversal blocked|invalid/i);

    const absolute = await request("/api/projects/zip-demo/download?path=" + encodeURIComponent("/etc/passwd"));
    assert.equal(absolute.status, 400);
  });
});

test("folder zip skips symlinks and keeps nested content intact", async () => {
  await withServer({}, async ({ projectRoot, request }) => {
    const folder = path.join(projectRoot, "with-link");
    await fs.mkdir(path.join(folder, "nested"), { recursive: true });
    await fs.writeFile(path.join(folder, "nested", "inside.txt"), "safe");
    let symlinkCreated = false;
    try {
      await fs.symlink(path.join(folder, "nested", "inside.txt"), path.join(folder, "link-out"));
      symlinkCreated = true;
    } catch {
      // Windows may not allow symlink creation without elevation.
    }

    // Attachment sanitization: quotes/newlines are stripped from Content-Disposition.
    assert.equal(
      String('weird"name\r\n.zip').replace(/["\r\n\\/]/g, "").trim().slice(0, 180),
      "weirdname.zip"
    );

    const response = await request("/api/projects/zip-demo/download?path=with-link");
    assert.equal(response.status, 200);
    assert.equal(dispositionName(response.headers.get("content-disposition")), "with-link.zip");
    const unzipped = unzipSync(new Uint8Array(await response.arrayBuffer()));
    const names = Object.keys(unzipped).sort();
    assert.ok(names.includes("with-link/nested/inside.txt"));
    assert.equal(names.some((name) => name.includes("link-out")), false);
    assert.equal(strFromU8(unzipped["with-link/nested/inside.txt"]), "safe");
    if (symlinkCreated) {
      const linkStat = await fs.lstat(path.join(folder, "link-out"));
      assert.equal(linkStat.isSymbolicLink(), true);
    }
  });
});

test("folder zip enforces entry and byte limits before streaming", async () => {
  await withServer({ ZIP_MAX_ENTRIES: "3", ZIP_MAX_TOTAL_BYTES: "20" }, async ({ projectRoot, request }) => {
    await fs.mkdir(path.join(projectRoot, "too-many", "child"), { recursive: true });
    await fs.writeFile(path.join(projectRoot, "too-many", "a.txt"), "1");
    await fs.writeFile(path.join(projectRoot, "too-many", "child", "b.txt"), "2");
    await fs.writeFile(path.join(projectRoot, "too-many", "child", "c.txt"), "3");

    const many = await request("/api/projects/zip-demo/download?path=too-many");
    assert.equal(many.status, 413);
    assert.equal((await many.json()).code, "ZIP_TOO_MANY_ENTRIES");

    await fs.mkdir(path.join(projectRoot, "too-big"), { recursive: true });
    await fs.writeFile(path.join(projectRoot, "too-big", "payload.bin"), "x".repeat(32));
    const large = await request("/api/projects/zip-demo/download?path=too-big");
    assert.equal(large.status, 413);
    assert.equal((await large.json()).code, "ZIP_TOO_LARGE");
  });
});
