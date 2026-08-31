import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const STATE_DIR = process.env.STATE_DIR || path.join(process.cwd(), ".reaper-local");
export const CLAUDE_SKILLS_DIR = process.env.CLAUDE_SKILLS_STORE || path.join(STATE_DIR, "claude-skills");
export const CLAUDE_CONFIG_DIR = "/work/.reaper/claude";
export const CLAUDE_SKILLS_TARGET = `${CLAUDE_CONFIG_DIR}/skills`;
// Single source of truth for the user's Claude custom setup (settings.json:
// env, permissions, default model, availableModels picker, flags). Lives in
// the cloud_proxy pod next to the skills store; synced to every Claude pod.
export const CLAUDE_SETUP_FILE = process.env.CLAUDE_SETUP_FILE ||
  path.join(path.dirname(CLAUDE_SKILLS_DIR), "claude-setup", "settings.json");
export const CLAUDE_SETUP_TARGET = `${CLAUDE_CONFIG_DIR}/settings.json`;
const MAX_FILES = 4096;
const MAX_PATH_BYTES = 1024;
const MAX_FILE_SIZE = 16 * 1024 * 1024;
const MAX_TOTAL_SIZE = 128 * 1024 * 1024;
const TAR_BLOCK = 512;

const MANAGED_SKILL_NAME = "reaper-port-publishing";
const MANAGED_SKILL_CONTENT = `---
name: reaper-port-publishing
description: Publish development servers from a Reaper project pod
---

# Reaper port publishing

When you start a user-facing development server in a Reaper project pod:

1. Bind the server to \`0.0.0.0\`, not only \`localhost\` or \`127.0.0.1\`.
2. Verify the server locally inside the pod.
3. Automatically run \`reaper-port publish <port>\`.
4. Report the externally reachable URL printed by the command.

Published routes are Reaper-auth protected by default. Use \`reaper-port publish <port> --public\` only when the user explicitly requests unauthenticated public access. Do not use \`--public\` merely because the user asks to share, preview, expose, or publish the server.

Use \`reaper-port list\` to inspect this pod's published routes and \`reaper-port unpublish <port>\` to remove one. Never edit ports metadata and never call the admin ports API directly.

Port publishing is available only in project pods that provide the \`reaper-port\` command and pod capability. If the command reports that IP-mode networking cannot publish a route, explain that restriction; do not speculate about IP-mode otherwise.
`;

function temporarySibling(target, label) {
  return path.join(path.dirname(target), `.${path.basename(target)}-${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

async function installManagedSkill(root) {
  const target = path.join(root, MANAGED_SKILL_NAME);
  const stage = temporarySibling(target, "stage");
  const old = temporarySibling(target, "old");
  await fs.mkdir(stage, { mode: 0o700 });
  try {
    await fs.writeFile(path.join(stage, "SKILL.md"), MANAGED_SKILL_CONTENT, { mode: 0o600 });
    let replaced = false;
    try {
      await fs.rename(target, old);
      replaced = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      await fs.rename(stage, target);
    } catch (error) {
      if (replaced) await fs.rename(old, target);
      throw error;
    }
    if (replaced) await fs.rm(old, { recursive: true, force: true });
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
    await fs.rm(old, { recursive: true, force: true });
  }
}

async function enableManagedSkill(setupFile) {
  let source;
  let stat;
  try {
    [source, stat] = await Promise.all([fs.readFile(setupFile, "utf8"), fs.stat(setupFile)]);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  let settings;
  try {
    settings = JSON.parse(source);
  } catch {
    console.warn(`Skipping Claude skill defaults: invalid JSON at ${setupFile}`);
    return;
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    console.warn(`Skipping Claude skill defaults: expected a JSON object at ${setupFile}`);
    return;
  }
  if (settings.skillOverrides !== undefined &&
      (!settings.skillOverrides || typeof settings.skillOverrides !== "object" || Array.isArray(settings.skillOverrides))) {
    console.warn(`Skipping Claude skill defaults: invalid skillOverrides at ${setupFile}`);
    return;
  }
  if (settings.skillOverrides?.[MANAGED_SKILL_NAME] === "on") return;
  settings.skillOverrides ??= {};
  settings.skillOverrides[MANAGED_SKILL_NAME] = "on";
  const stage = temporarySibling(setupFile, "stage");
  await fs.writeFile(stage, `${JSON.stringify(settings, null, 2)}\n`, { mode: stat.mode & 0o777 });
  try {
    await fs.rename(setupFile, `${stage}.old`);
    try {
      await fs.rename(stage, setupFile);
    } catch (error) {
      await fs.rename(`${stage}.old`, setupFile);
      throw error;
    }
    await fs.rm(`${stage}.old`, { force: true });
  } finally {
    await fs.rm(stage, { force: true });
    await fs.rm(`${stage}.old`, { force: true });
  }
}

function safeName(name) {
  return name && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\") && !name.includes("\0");
}

export async function initClaudeSkillsStore(root = CLAUDE_SKILLS_DIR, setupFile = CLAUDE_SETUP_FILE) {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Claude skills store must be a regular directory");
  await installManagedSkill(root);
  await enableManagedSkill(setupFile);
  return root;
}

export async function validateClaudeSkillsStore(root = CLAUDE_SKILLS_DIR) {
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Claude skills store must be a regular directory");
  const files = [];
  let totalSize = 0;
  let count = 0;
  const top = await fs.readdir(root, { withFileTypes: true });
  for (const entry of top) {
    if (!safeName(entry.name) || entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`invalid top-level skill entry: ${entry.name}`);
    const skillFile = path.join(root, entry.name, "SKILL.md");
    let skillStat;
    try { skillStat = await fs.lstat(skillFile); } catch (error) {
      if (error.code === "ENOENT") throw new Error(`skill ${entry.name} is missing SKILL.md`);
      throw error;
    }
    if (!skillStat.isFile() || skillStat.isSymbolicLink()) throw new Error(`skill ${entry.name} must contain a regular SKILL.md`);
    const walk = async (directory, relative) => {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      entries.sort((a, b) => Buffer.from(a.name).compare(Buffer.from(b.name)));
      for (const child of entries) {
        if (!safeName(child.name)) throw new Error(`invalid skill path component: ${child.name}`);
        const rel = path.posix.join(relative, child.name);
        if (Buffer.byteLength(rel) > MAX_PATH_BYTES) throw new Error(`skill path is too long: ${rel}`);
        const full = path.join(directory, child.name);
        const stat = await fs.lstat(full);
        if (stat.isSymbolicLink()) throw new Error(`symlinks are not allowed in Claude skills: ${rel}`);
        if (stat.isDirectory()) {
          files.push({ path: `${rel}/`, type: "directory", mode: stat.mode & 0o777 });
          await walk(full, rel);
        } else if (stat.isFile()) {
          if (stat.size > MAX_FILE_SIZE) throw new Error(`Claude skill file is too large: ${rel}`);
          totalSize += stat.size;
          if (totalSize > MAX_TOTAL_SIZE) throw new Error("Claude skills store is too large");
          files.push({ path: rel, type: "file", mode: stat.mode & 0o777, size: stat.size, full });
        } else {
          throw new Error(`unsupported Claude skill entry: ${rel}`);
        }
        count += 1;
        if (count > MAX_FILES) throw new Error(`Claude skills store cannot exceed ${MAX_FILES} entries`);
      }
    };
    files.push({ path: `${entry.name}/`, type: "directory", mode: 0o755 });
    count += 1;
    await walk(path.join(root, entry.name), entry.name);
  }
  return { root, files, totalSize };
}

function writeOctal(buffer, offset, length, value) {
  const text = Math.max(0, value).toString(8).padStart(length - 1, "0") + "\0";
  buffer.write(text.slice(-length), offset, length, "ascii");
}

function tarHeader(entry) {
  const header = Buffer.alloc(TAR_BLOCK);
  const name = Buffer.from(entry.path);
  if (name.length > 100) throw new Error(`skill path is too long for archive: ${entry.path}`);
  name.copy(header, 0);
  writeOctal(header, 100, 8, entry.mode & 0o777);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.type === "file" ? entry.size : 0);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = entry.type === "directory" ? 0x35 : 0x30;
  Buffer.from("ustar\0", "ascii").copy(header, 257);
  Buffer.from("00", "ascii").copy(header, 263);
  writeOctal(header, 148, 8, [...header].reduce((sum, byte) => sum + byte, 0));
  return header;
}

export async function buildClaudeSkillsArchive(root = CLAUDE_SKILLS_DIR) {
  const validated = await validateClaudeSkillsStore(root);
  const chunks = [];
  const hash = createHash("sha256");
  for (const entry of validated.files) {
    const header = tarHeader(entry);
    chunks.push(header);
    hash.update(entry.type).update("\0").update(entry.path).update("\0").update(String(entry.mode & 0o777)).update("\0");
    if (entry.type === "file") {
      const content = await fs.readFile(entry.full);
      chunks.push(content);
      hash.update(content);
      const padding = (TAR_BLOCK - (content.length % TAR_BLOCK)) % TAR_BLOCK;
      if (padding) chunks.push(Buffer.alloc(padding));
    }
  }
  chunks.push(Buffer.alloc(TAR_BLOCK * 2));
  return { archive: Buffer.concat(chunks), checksum: hash.digest("hex"), files: validated.files.length, size: validated.totalSize };
}

const INSTALL_SCRIPT = [
  "set -eu",
  'config="$1"; target="$config/skills"; stage="$config/.skills-stage.$$"; old="$config/.skills-old.$$"',
  'mkdir -p -- "$config"',
  'rm -rf -- "$stage" "$old"',
  'trap \'rm -rf -- "$stage" "$old"\' EXIT',
  'mkdir -m 700 -- "$stage"',
  'tar -xf - -C "$stage" --no-same-owner --no-same-permissions',
  'if [ -e "$target" ] || [ -L "$target" ]; then mv -- "$target" "$old"; fi',
  'if mv -- "$stage" "$target"; then rm -rf -- "$old"; else [ ! -e "$old" ] || mv -- "$old" "$target"; exit 1; fi',
  'trap - EXIT'
].join("\n");

export async function syncClaudeSkillsToPod(project, podExec, root = CLAUDE_SKILLS_DIR) {
  if (typeof podExec !== "function") throw new TypeError("podExec must be a function");
  if (root === CLAUDE_SKILLS_DIR) await initClaudeSkillsStore();
  const built = await buildClaudeSkillsArchive(root);
  const result = await podExec(project, ["sh", "-c", INSTALL_SCRIPT, "reaper-sync-claude-skills", CLAUDE_CONFIG_DIR], { input: built.archive, maxBuffer: 1024 * 1024 });
  if (result.code !== 0) throw new Error(result.stderr || `failed to synchronize Claude skills for ${project}`);
  return { checksum: built.checksum, files: built.files, size: built.size };
}
