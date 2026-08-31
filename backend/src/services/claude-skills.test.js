import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildClaudeSkillsArchive,
  initClaudeSkillsStore,
  syncClaudeSkillsToPod,
  validateClaudeSkillsStore
} from "./claude-skills.js";

async function temporaryStore() {
  return fs.mkdtemp(path.join(os.tmpdir(), "reaper-claude-skills-"));
}

async function temporaryState() {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "reaper-claude-state-"));
  return {
    state,
    root: path.join(state, "claude-skills"),
    setup: path.join(state, "claude-setup", "settings.json")
  };
}

test("initialization installs and updates the deterministic managed skill without changing custom skills", async (t) => {
  const { state, root, setup } = await temporaryState();
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const custom = path.join(root, "custom", "SKILL.md");
  const managed = path.join(root, "reaper-port-publishing", "SKILL.md");
  await fs.mkdir(path.dirname(custom), { recursive: true });
  await fs.writeFile(custom, Buffer.from([0x23, 0x20, 0x43, 0x75, 0x73, 0x74, 0x6f, 0x6d, 0x0a]));
  await fs.mkdir(path.dirname(managed));
  await fs.writeFile(managed, "stale managed content\n");

  await initClaudeSkillsStore(root, setup);
  const customBefore = await fs.readFile(custom);
  const managedBefore = await fs.readFile(managed, "utf8");
  const first = await buildClaudeSkillsArchive(root);
  assert.match(managedBefore, /^---\nname: reaper-port-publishing\n/);
  assert.match(managedBefore, /bind the server to `0\.0\.0\.0`/i);
  assert.match(managedBefore, /Automatically run `reaper-port publish <port>`/);
  assert.match(managedBefore, /only when the user explicitly requests unauthenticated public access/);
  assert.match(managedBefore, /`reaper-port list`/);
  assert.match(managedBefore, /`reaper-port unpublish <port>`/);
  assert.match(managedBefore, /never call the admin ports API directly/i);

  await initClaudeSkillsStore(root, setup);
  const second = await buildClaudeSkillsArchive(root);
  assert.deepEqual(await fs.readFile(custom), customBefore);
  assert.equal(await fs.readFile(managed, "utf8"), managedBefore);
  assert.equal(second.checksum, first.checksum);
  assert.deepEqual(second.archive, first.archive);
});

test("initialization enables the managed skill while preserving setup settings and overrides", async (t) => {
  const { state, root, setup } = await temporaryState();
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  await fs.mkdir(path.dirname(setup), { recursive: true });
  await fs.writeFile(setup, JSON.stringify({
    model: "claude-sonnet",
    env: { CUSTOM: "unchanged" },
    skillOverrides: { "user-skill": "off", "reaper-port-publishing": "off" }
  }));

  await initClaudeSkillsStore(root, setup);
  const settings = JSON.parse(await fs.readFile(setup, "utf8"));
  assert.equal(settings.model, "claude-sonnet");
  assert.deepEqual(settings.env, { CUSTOM: "unchanged" });
  assert.equal(settings.skillOverrides["user-skill"], "off");
  assert.equal(settings.skillOverrides["reaper-port-publishing"], "on");
  const enabledSource = await fs.readFile(setup);
  await initClaudeSkillsStore(root, setup);
  assert.deepEqual(await fs.readFile(setup), enabledSource);
});

test("initialization does not create an absent Claude setup file", async (t) => {
  const { state, root, setup } = await temporaryState();
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  await initClaudeSkillsStore(root, setup);
  await assert.rejects(fs.access(setup), { code: "ENOENT" });
});

test("initialization preserves invalid setup JSON while still installing the managed skill", async (t) => {
  const { state, root, setup } = await temporaryState();
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  await fs.mkdir(path.dirname(setup), { recursive: true });
  const invalid = Buffer.from("{ not valid json\n");
  await fs.writeFile(setup, invalid);
  await initClaudeSkillsStore(root, setup);
  assert.deepEqual(await fs.readFile(setup), invalid);
  assert.match(
    await fs.readFile(path.join(root, "reaper-port-publishing", "SKILL.md"), "utf8"),
    /^---\nname: reaper-port-publishing\n/
  );
});

test("empty Claude skill store has a deterministic archive and syncs to the reserved target", async (t) => {
  const root = await temporaryStore();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = await buildClaudeSkillsArchive(root);
  const second = await buildClaudeSkillsArchive(root);
  assert.equal(first.checksum, second.checksum);
  assert.equal(first.files, 0);
  let call;
  const status = await syncClaudeSkillsToPod("alpha", async (project, argv, options) => {
    call = { project, argv, options };
    return { code: 0, stdout: "", stderr: "" };
  }, root);
  assert.equal(status.checksum, first.checksum);
  assert.equal(call.project, "alpha");
  assert.equal(call.argv.at(-1), "/work/.reaper/claude");
  assert.ok(Buffer.isBuffer(call.options.input));
  assert.match(call.argv[2], /target="\$config\/skills"/);
  assert.match(call.argv[2], /mv -- "\$stage" "\$target"/);
});

test("recursive skill files and executable bits affect a deterministic checksum", async (t) => {
  const root = await temporaryStore();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "review", "scripts"), { recursive: true });
  await fs.writeFile(path.join(root, "review", "SKILL.md"), "# Review\n");
  const executable = path.join(root, "review", "scripts", "check.sh");
  await fs.writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const first = await buildClaudeSkillsArchive(root);
  const second = await buildClaudeSkillsArchive(root);
  assert.equal(first.checksum, second.checksum);
  assert.equal(first.files, 4);
  assert.ok(second.archive.includes(Buffer.from("review/scripts/check.sh")));
  await fs.writeFile(executable, "#!/bin/sh\nexit 1\n");
  assert.notEqual((await buildClaudeSkillsArchive(root)).checksum, first.checksum);
});

test("malformed top-level entries, missing SKILL.md, and symlinks are rejected", async (t) => {
  const root = await temporaryStore();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "loose.txt"), "no");
  await assert.rejects(validateClaudeSkillsStore(root), /invalid top-level skill entry/);
  await fs.rm(path.join(root, "loose.txt"));
  await fs.mkdir(path.join(root, "broken"));
  await assert.rejects(validateClaudeSkillsStore(root), /missing SKILL\.md/);
  await fs.rm(path.join(root, "broken"), { recursive: true });
  await fs.mkdir(path.join(root, "linked"));
  await fs.writeFile(path.join(root, "linked", "SKILL.md"), "# Linked\n");
  const outside = path.join(root, "outside.txt");
  await fs.writeFile(outside, "secret");
  try {
    await fs.symlink(outside, path.join(root, "linked", "escape"), "file");
  } catch (error) {
    if (error.code === "EPERM") return t.skip("symlink creation is unavailable");
    throw error;
  }
  await assert.rejects(validateClaudeSkillsStore(root), /symlinks are not allowed/);
});

test("pod synchronization fails closed on installer failure", async (t) => {
  const root = await temporaryStore();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(
    syncClaudeSkillsToPod("alpha", async () => ({ code: 9, stdout: "", stderr: "tar failed" }), root),
    /tar failed/
  );
});
