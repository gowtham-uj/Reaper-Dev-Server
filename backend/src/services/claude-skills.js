import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const STATE_DIR = process.env.STATE_DIR || path.join(process.cwd(), ".reaper-local");
export const CLAUDE_SKILLS_DIR = process.env.CLAUDE_SKILLS_STORE || path.join(STATE_DIR, "claude-skills");
export const CLAUDE_CONFIG_DIR = "/work/.reaper/claude";
export const CLAUDE_SKILLS_TARGET = `${CLAUDE_CONFIG_DIR}/skills`;
const MAX_FILES = 4096;
const MAX_PATH_BYTES = 1024;
const MAX_FILE_SIZE = 16 * 1024 * 1024;
const MAX_TOTAL_SIZE = 128 * 1024 * 1024;
const TAR_BLOCK = 512;

function safeName(name) {
  return name && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\") && !name.includes("\0");
}

export async function initClaudeSkillsStore() {
  await fs.mkdir(CLAUDE_SKILLS_DIR, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(CLAUDE_SKILLS_DIR);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Claude skills store must be a regular directory");
  return CLAUDE_SKILLS_DIR;
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
