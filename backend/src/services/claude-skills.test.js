import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildClaudeSkillsArchive, syncClaudeSkillsToPod, validateClaudeSkillsStore } from "./claude-skills.js";

async function temporaryStore() {
  return fs.mkdtemp(path.join(os.tmpdir(), "reaper-claude-skills-"));
}

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
