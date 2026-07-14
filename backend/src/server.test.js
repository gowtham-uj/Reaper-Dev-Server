import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
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
    const timer = setTimeout(() => reject(new Error(`server did not start: ${output}`)), 10_000);
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
  if (process.platform === "win32") assert.equal(result.signal, "SIGTERM");
  else assert.equal(result.code, 0, `server exited from signal ${result.signal || "none"}`);
}

test("project API tokens stay in trusted state and cannot forge global scope", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reaper-server-token-test-"));
  const projectsRoot = path.join(root, "projects");
  const stateDir = path.join(root, "state");
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
      APP_ADMIN_USERNAME: "token_admin",
      APP_ADMIN_PASSWORD: "S3cureFixture!2026",
      COOKIE_SECURE: "false",
      APEX_DOMAIN: "",
      COOKIE_DOMAIN: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  const base = `http://127.0.0.1:${port}`;
  let cookieHeader = "";
  let csrfToken = "";
  const request = async (pathname, options = {}) => {
    const headers = { "user-agent": "Mozilla/5.0 Reaper integration test", ...(options.headers || {}) };
    if (cookieHeader && !headers.authorization && !headers.cookie) headers.cookie = cookieHeader;
    if (csrfToken && options.method && !["GET", "HEAD"].includes(options.method)) headers["x-csrf-token"] = csrfToken;
    if (options.body && !headers["content-type"]) headers["content-type"] = "application/json";
    return fetch(`${base}${pathname}`, { ...options, headers });
  };

  try {
    await waitForServer(child);
    const login = await request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "token_admin", password: "S3cureFixture!2026" })
    });
    assert.equal(login.status, 200);
    const loginBody = await login.json();
    csrfToken = loginBody.csrfToken;
    const setCookie = login.headers.get("set-cookie") || "";
    const access = /(?:^|,\s*)reaper_access=([^;,]+)/.exec(setCookie)?.[1];
    assert.ok(access, setCookie);
    cookieHeader = `reaper_access=${access}; reaper_csrf=${csrfToken}`;
    const duplicateCookieAuth = await request("/api/auth/me", {
      headers: { cookie: `reaper_access=invalid; ${cookieHeader}` }
    });
    assert.equal(duplicateCookieAuth.status, 200);

    const savedGlobalEnv = await request("/api/global-env", {
      method: "PUT",
      body: JSON.stringify({ env: { GLOBAL_TOKEN: "configured" } })
    });
    assert.equal(savedGlobalEnv.status, 200);
    assert.deepEqual(await savedGlobalEnv.json(), { ok: true, count: 1 });
    const loadedGlobalEnv = await request("/api/global-env");
    assert.equal(loadedGlobalEnv.status, 200);
    assert.deepEqual(await loadedGlobalEnv.json(), { env: { GLOBAL_TOKEN: "configured" } });

    const created = await request("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "secureone", mode: "persistent" })
    });
    assert.equal(created.status, 201);
    for (const value of ["queued-one", "queued-two", "queued-final"]) {
      const update = await request("/api/global-env", {
        method: "PUT",
        body: JSON.stringify({ env: { GLOBAL_TOKEN: value } })
      });
      assert.equal(update.status, 200);
    }
    let propagation;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const readiness = await request("/api/ready");
      assert.equal(readiness.status, 200);
      propagation = (await readiness.json()).propagation;
      if (propagation?.state === "current" && propagation.appliedVersion === propagation.desiredVersion) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(propagation?.state, "current");
    assert.equal(propagation?.appliedVersion, propagation?.desiredVersion);
    const finalGlobalEnv = await request("/api/global-env");
    assert.deepEqual(await finalGlobalEnv.json(), { env: { GLOBAL_TOKEN: "queued-final" } });
    const dotted = await request("/api/projects", {
      method: "POST",
      headers: { cookie: `reaper_csrf=invalid; ${cookieHeader}` },
      body: JSON.stringify({ name: "dotted.project", mode: "persistent" })
    });
    assert.equal(dotted.status, 201);
    const dottedToken = await request("/api/projects/dotted.project/tokens", {
      method: "POST",
      body: JSON.stringify({ name: "dotted bot", scopes: ["read"], ttlDays: 1 })
    });
    assert.equal(dottedToken.status, 201);
    const dottedTokenBody = await dottedToken.json();
    const dottedProjectWithToken = await request("/api/projects/dotted.project", {
      headers: { authorization: `Bearer ${dottedTokenBody.token}` }
    });
    assert.equal(dottedProjectWithToken.status, 200);
    const removedDotted = await request("/api/projects/dotted.project", { method: "DELETE" });
    assert.equal(removedDotted.status, 200);

    const trustedConfigFile = path.join(stateDir, "projects", "secureone", "config.json");
    assert.equal(JSON.parse(await fs.readFile(trustedConfigFile, "utf8")).owner, "token_admin");
    await fs.symlink(stateDir, path.join(projectsRoot, "secureone", ".reaper"), "junction");
    const projectDetails = await request("/api/projects/secureone");
    assert.equal(projectDetails.status, 200);
    assert.deepEqual((await projectDetails.json()).project, {
      name: "secureone",
      mode: "persistent",
      createdAt: JSON.parse(await fs.readFile(trustedConfigFile, "utf8")).createdAt,
      owner: "token_admin"
    });
    const escapedRead = await request(`/api/projects/secureone/file?path=${encodeURIComponent(".reaper/users.json")}`);
    assert.equal(escapedRead.status, 400);
    assert.equal(JSON.parse(await fs.readFile(path.join(stateDir, "users.json"), "utf8")).length, 1);
    const removedSymlink = await request("/api/projects/secureone/file", {
      method: "DELETE",
      body: JSON.stringify({ path: ".reaper" })
    });
    assert.equal(removedSymlink.status, 200);
    const writtenFile = await request("/api/projects/secureone/file", {
      method: "PUT",
      body: JSON.stringify({ path: "safe/note.txt", content: "trusted write" })
    });
    assert.equal(writtenFile.status, 200);
    assert.equal(await fs.readFile(path.join(projectsRoot, "secureone", "safe", "note.txt"), "utf8"), "trusted write");
    const madeDirectory = await request("/api/projects/secureone/dir", {
      method: "POST",
      body: JSON.stringify({ path: "safe/nested/deep" })
    });
    assert.equal(madeDirectory.status, 200);
    assert.equal((await fs.stat(path.join(projectsRoot, "secureone", "safe", "nested", "deep"))).isDirectory(), true);
    assert.equal(JSON.parse(await fs.readFile(path.join(stateDir, "users.json"), "utf8")).length, 1);
    const nestedDirectory = path.join(projectsRoot, "secureone", "delete-me");
    await fs.mkdir(nestedDirectory);
    await fs.writeFile(path.join(nestedDirectory, "child.txt"), "delete", "utf8");
    const removedDirectory = await request("/api/projects/secureone/file", {
      method: "DELETE",
      body: JSON.stringify({ path: "delete-me" })
    });
    assert.equal(removedDirectory.status, 200);
    await assert.rejects(fs.access(nestedDirectory));
    const bulkDirectory = path.join(projectsRoot, "secureone", "bulk");
    await fs.mkdir(bulkDirectory);
    for (let index = 0; index < 1005; index += 1) {
      await fs.writeFile(path.join(bulkDirectory, `file-${String(index).padStart(4, "0")}.txt`), "");
    }
    const firstDirectoryPage = await request("/api/projects/secureone/files?path=bulk");
    assert.equal(firstDirectoryPage.status, 200);
    const firstDirectoryPageBody = await firstDirectoryPage.json();
    assert.equal(firstDirectoryPageBody.entries.length, 1000);
    assert.ok(firstDirectoryPageBody.nextCursor);
    const secondDirectoryPage = await request(`/api/projects/secureone/files?path=bulk&cursor=${firstDirectoryPageBody.nextCursor}`);
    assert.equal(secondDirectoryPage.status, 200);
    const secondDirectoryPageBody = await secondDirectoryPage.json();
    assert.equal(secondDirectoryPageBody.entries.length, 5);
    assert.equal(secondDirectoryPageBody.nextCursor, null);

    const oversizedPreview = path.join(projectsRoot, "secureone", "oversized-preview.txt");
    await fs.writeFile(oversizedPreview, Buffer.alloc(8 * 1024 * 1024 + 1, 0x61));
    const previewResponse = await request("/api/projects/secureone/file?path=oversized-preview.txt");
    assert.equal(previewResponse.status, 413);
    assert.equal((await previewResponse.json()).code, "FILE_PREVIEW_TOO_LARGE");

    const issued = await request("/api/projects/secureone/tokens", {
      method: "POST",
      body: JSON.stringify({ name: "project bot", scopes: ["read", "write", "exec"], ttlDays: 30 })
    });
    assert.equal(issued.status, 201);
    const issuedBody = await issued.json();
    const tokenFile = path.join(stateDir, "project-api-tokens", "secureone.json");
    const records = JSON.parse(await fs.readFile(tokenFile, "utf8"));
    assert.equal(records.length, 1);
    assert.equal(Object.hasOwn(records[0], "scope"), false);
    await assert.rejects(fs.access(path.join(projectsRoot, "secureone", ".reaper", "api-tokens.json")));

    records[0].scope = { kind: "global", name: null };
    await fs.writeFile(tokenFile, JSON.stringify(records, null, 2), "utf8");
    const globalWithProjectToken = await request("/api/projects", {
      headers: { authorization: `Bearer ${issuedBody.token}` }
    });
    assert.equal(globalWithProjectToken.status, 403);
    const ownProject = await request("/api/projects/secureone", {
      headers: { authorization: `Bearer ${issuedBody.token}` }
    });
    assert.equal(ownProject.status, 200);

    const tokenListWithProjectToken = await request("/api/projects/secureone/tokens", {
      headers: { authorization: `Bearer ${issuedBody.token}` }
    });
    assert.equal(tokenListWithProjectToken.status, 403);
    const delegatedToken = await request("/api/projects/secureone/tokens", {
      method: "POST",
      headers: { authorization: `Bearer ${issuedBody.token}` },
      body: JSON.stringify({ name: "escalated", scopes: ["exec"] })
    });
    assert.equal(delegatedToken.status, 403);
    const rotatedToken = await request(`/api/projects/secureone/tokens/${issuedBody.id}/rotate`, {
      method: "POST",
      headers: { authorization: `Bearer ${issuedBody.token}` },
      body: JSON.stringify({ ttlDays: 30 })
    });
    assert.equal(rotatedToken.status, 403);
    const revokedToken = await request(`/api/projects/secureone/tokens/${issuedBody.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${issuedBody.token}` }
    });
    assert.equal(revokedToken.status, 403);

    const forgedRaw = `rpat_${"a".repeat(64)}`;
    const forgedRecord = [{
      id: crypto.randomUUID(),
      name: "forged",
      prefix: forgedRaw.slice(0, 12),
      hash: crypto.createHash("sha256").update(forgedRaw).digest("hex"),
      scopes: ["read", "write", "exec"],
      scope: { kind: "global", name: null },
      createdAt: Date.now(),
      expiresAt: Date.now() + 86_400_000,
      revokedAt: null,
      lastUsedAt: null
    }];
    const writableMetadata = path.join(projectsRoot, "secureone", ".reaper");
    await fs.mkdir(writableMetadata, { recursive: true });
    await fs.writeFile(path.join(writableMetadata, "api-tokens.json"), JSON.stringify(forgedRecord), "utf8");
    const forged = await request("/api/projects", {
      headers: { authorization: `Bearer ${forgedRaw}` }
    });
    assert.equal(forged.status, 401);

    const removed = await request("/api/projects/secureone", { method: "DELETE" });
    assert.equal(removed.status, 200);
    await assert.rejects(fs.access(tokenFile));
    const revokedByDeletion = await request("/api/projects/secureone", {
      headers: { authorization: `Bearer ${issuedBody.token}` }
    });
    assert.equal(revokedByDeletion.status, 401);

    assert.equal(JSON.parse(await fs.readFile(path.join(stateDir, "auth-sessions.json"), "utf8")).length, 1);
    const loggedOut = await request("/api/auth/logout", { method: "POST", body: "{}" });
    assert.equal(loggedOut.status, 200);
    assert.deepEqual(await loggedOut.json(), { ok: true });
    assert.equal(JSON.parse(await fs.readFile(path.join(stateDir, "auth-sessions.json"), "utf8")).length, 0);
    const copiedCookieAfterLogout = await request("/api/auth/me");
    assert.equal(copiedCookieAfterLogout.status, 401);
  } finally {
    await stopServer(child);
    await fs.rm(root, { recursive: true, force: true });
  }
});
