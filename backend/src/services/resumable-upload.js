import crypto from "node:crypto";
import fs from "node:fs/promises";
import fss from "node:fs";
import path from "node:path";

const UPLOAD_ID_RE = /^[0-9a-f-]{36}$/i;
const RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const NOFOLLOW = fss.constants.O_NOFOLLOW || 0;
const DIRECTORY_FLAGS = fss.constants.O_RDONLY | (fss.constants.O_DIRECTORY || 0) | NOFOLLOW;
const WRITE_FLAGS = fss.constants.O_WRONLY | NOFOLLOW;

function uploadError(statusCode, message, detail = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.detail = detail;
  return error;
}

function isInside(root, target) {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  return resolved === base || resolved.startsWith(base + path.sep);
}

function directChild(root, name) {
  if (typeof name !== "string" || !name || name === "." || name === ".." || /[\\/\0]/.test(name)) {
    throw uploadError(400, "invalid project name");
  }
  const base = path.resolve(root);
  const target = path.resolve(base, name);
  if (path.dirname(target) !== base) throw uploadError(400, "invalid project name");
  return target;
}

function destinationPath(root, relativePath) {
  if (typeof relativePath !== "string" || !relativePath || relativePath.length > 1024 || relativePath.includes("\0") || path.isAbsolute(relativePath)) {
    throw uploadError(400, "invalid upload path");
  }
  const destination = path.resolve(root, relativePath);
  if (destination === path.resolve(root) || !isInside(root, destination)) {
    throw uploadError(400, "path traversal blocked");
  }
  return destination;
}

function positiveSafeInteger(value, name, { allowZero = false } = {}) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw uploadError(400, `${name} must be ${allowZero ? "a non-negative" : "a positive"} safe integer`);
  }
  return parsed;
}

async function assertDirectory(directory) {
  let stat;
  try { stat = await fs.lstat(directory); }
  catch (error) {
    if (error.code === "ENOENT") throw uploadError(404, "project not found");
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw uploadError(400, "unsafe project directory");
  return stat;
}

async function ensureSafeParent(root, destination, { create = false } = {}) {
  await assertDirectory(root);
  const rootReal = await fs.realpath(root);
  const parent = path.dirname(destination);
  if (!isInside(root, parent)) throw uploadError(400, "path traversal blocked");
  const relative = path.relative(path.resolve(root), parent);
  let current = path.resolve(root);
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) {
      if (error.code !== "ENOENT" || !create) throw error;
      await fs.mkdir(current);
      stat = await fs.lstat(current);
    }
    if (stat.isSymbolicLink()) throw uploadError(400, "symlink traversal blocked");
    if (!stat.isDirectory()) throw uploadError(400, "path component is not a directory");
  }
  const parentReal = await fs.realpath(parent);
  if (!isInside(rootReal, parentReal)) throw uploadError(400, "symlink traversal blocked");
  return { parent, parentReal, rootReal };
}

async function writeJsonAtomic(directory, destination, value) {
  const temporary = path.join(directory, `.record-${crypto.randomBytes(8).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, destination);
    try {
      const directoryHandle = await fs.open(directory, DIRECTORY_FLAGS);
      try { await directoryHandle.sync(); }
      finally { await directoryHandle.close(); }
    } catch {
      // Directory fsync is unsupported on some development filesystems.
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function writeAll(handle, data, position) {
  let written = 0;
  while (written < data.length) {
    const result = await handle.write(data, written, data.length - written, position + written);
    if (result.bytesWritten < 1) throw new Error("upload write made no progress");
    written += result.bytesWritten;
  }
}

function isInterruptedRequest(req, error) {
  return Boolean(req.aborted || ["ABORT_ERR", "ECONNRESET", "EPIPE"].includes(error?.code));
}

export class ResumableUploadStore {
  constructor({ projectsRoot, chunkBytes = 16 * 1024 * 1024, storageReserveBytes = 1024 * 1024 * 1024 } = {}) {
    this.projectsRoot = path.resolve(projectsRoot || ".");
    this.storageRoot = path.join(this.projectsRoot, ".reaper-uploads");
    this.chunkBytes = positiveSafeInteger(chunkBytes, "UPLOAD_CHUNK_BYTES");
    if (this.chunkBytes < 1024 * 1024 || this.chunkBytes > 256 * 1024 * 1024) {
      throw new Error("UPLOAD_CHUNK_BYTES must be between 1 MiB and 256 MiB");
    }
    this.storageReserveBytes = positiveSafeInteger(storageReserveBytes, "UPLOAD_STORAGE_RESERVE_BYTES", { allowZero: true });
    this.locks = new Map();
    this.deletingProjects = new Set();
  }

  projectRoot(project) {
    return directChild(this.projectsRoot, project);
  }

  stateDirectory(project) {
    return directChild(this.storageRoot, project);
  }

  recordPath(project, id) {
    if (!UPLOAD_ID_RE.test(String(id || ""))) throw uploadError(400, "invalid upload id");
    return path.join(this.stateDirectory(project), `${id}.json`);
  }

  partPath(project, id) {
    if (!UPLOAD_ID_RE.test(String(id || ""))) throw uploadError(400, "invalid upload id");
    return path.join(this.stateDirectory(project), `${id}.part`);
  }

  async ensureStateDirectory(project) {
    await assertDirectory(this.projectsRoot);
    await assertDirectory(this.projectRoot(project));
    for (const directory of [this.storageRoot, this.stateDirectory(project)]) {
      try { await fs.mkdir(directory, { mode: 0o700 }); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      const stat = await fs.lstat(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw uploadError(400, "unsafe upload state directory");
    }
    return this.stateDirectory(project);
  }

  async withLock(project, id, operation) {
    if (this.deletingProjects.has(project)) throw uploadError(409, "project uploads are shutting down");
    const key = `${project}:${id}`;
    const previous = this.locks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    this.locks.set(key, current);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }

  async readMetadata(project, id) {
    await this.ensureStateDirectory(project);
    let record;
    try { record = JSON.parse(await fs.readFile(this.recordPath(project, id), "utf8")); }
    catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) throw uploadError(404, "upload not found");
      throw error;
    }
    if (!record || record.version !== 1 || record.id !== id || record.project !== project || !Number.isSafeInteger(record.size)) {
      throw uploadError(409, "upload metadata is invalid");
    }
    return record;
  }

  async writeMetadata(project, record) {
    const directory = await this.ensureStateDirectory(project);
    await writeJsonAtomic(directory, this.recordPath(project, record.id), record);
  }

  async partOffset(project, record) {
    if (record.completedAt) return record.size;
    try {
      const stat = await fs.lstat(this.partPath(project, record.id));
      if (stat.isSymbolicLink() || !stat.isFile()) throw uploadError(409, "upload data is invalid");
      if (!Number.isSafeInteger(stat.size) || stat.size > record.size) throw uploadError(409, "upload data exceeds declared size");
      const confirmed = Number.isSafeInteger(record.offset) ? record.offset : stat.size;
      if (confirmed < 0 || confirmed > record.size || stat.size < confirmed) {
        throw uploadError(409, "persisted upload offset is invalid");
      }
      return confirmed;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (record.completingAt && await this.destinationMatches(project, record)) {
        const completed = {
          ...record,
          offset: record.size,
          completedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        delete completed.completingAt;
        await this.writeMetadata(project, completed);
        Object.assign(record, completed);
        return record.size;
      }
      throw uploadError(409, "upload data is missing");
    }
  }

  async destinationMatches(project, record) {
    const root = this.projectRoot(project);
    const destination = destinationPath(root, record.path);
    try {
      await ensureSafeParent(root, destination);
      const stat = await fs.lstat(destination);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== record.size) return false;
      const real = await fs.realpath(destination);
      return isInside(await fs.realpath(root), real);
    } catch {
      return false;
    }
  }

  response(record, offset, extra = {}) {
    return {
      id: record.id,
      path: record.path,
      size: record.size,
      offset,
      lastModified: record.lastModified,
      resumeKey: record.resumeKey,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      completed: Boolean(record.completedAt),
      chunkSize: this.chunkBytes,
      ...extra
    };
  }

  async readUpload(project, id) {
    const record = await this.readMetadata(project, id);
    const offset = await this.partOffset(project, record);
    return { record, offset };
  }

  async metadataFiles(project) {
    const directory = await this.ensureStateDirectory(project);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && UPLOAD_ID_RE.test(entry.name.replace(/\.json$/, "")) && entry.name.endsWith(".json"));
  }

  async list(project) {
    const uploads = [];
    for (const entry of await this.metadataFiles(project)) {
      const id = entry.name.slice(0, -5);
      try {
        const { record, offset } = await this.readUpload(project, id);
        if (record.completedAt) {
          if (Date.now() - Date.parse(record.completedAt) > RECEIPT_RETENTION_MS) {
            await fs.rm(this.recordPath(project, id), { force: true });
          }
          continue;
        }
        uploads.push(this.response(record, offset));
      } catch {
        // A corrupt record is isolated; healthy resumable uploads remain usable.
      }
    }
    uploads.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
    return uploads;
  }

  async reservedBytes() {
    let reserved = 0n;
    let projects = [];
    try { projects = await fs.readdir(this.storageRoot, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return reserved; throw error; }
    for (const project of projects.filter((entry) => entry.isDirectory())) {
      let records = [];
      try { records = await fs.readdir(path.join(this.storageRoot, project.name), { withFileTypes: true }); }
      catch { continue; }
      for (const entry of records.filter((candidate) => candidate.isFile() && candidate.name.endsWith(".json"))) {
        try {
          const record = JSON.parse(await fs.readFile(path.join(this.storageRoot, project.name, entry.name), "utf8"));
          if (!Number.isSafeInteger(record.size) || record.completedAt) continue;
          const offset = Number.isSafeInteger(record.offset) ? record.offset : 0;
          reserved += BigInt(Math.max(0, record.size - offset));
        } catch {}
      }
    }
    return reserved;
  }

  async availableBytes() {
    try {
      const stat = await fs.statfs(this.projectsRoot, { bigint: true });
      return stat.bavail * stat.bsize;
    } catch {
      return null;
    }
  }

  async assertInitialCapacity(size) {
    const available = await this.availableBytes();
    if (available === null) return;
    const reserved = await this.reservedBytes();
    const required = BigInt(size) + reserved + BigInt(this.storageReserveBytes);
    if (required > available) {
      throw uploadError(507, "not enough persistent storage for this upload", {
        availableBytes: available.toString(),
        requiredBytes: required.toString()
      });
    }
  }

  async assertChunkCapacity(length) {
    const available = await this.availableBytes();
    if (available === null) return;
    const required = BigInt(length) + BigInt(this.storageReserveBytes);
    if (required > available) {
      throw uploadError(507, "persistent storage is full", {
        availableBytes: available.toString(),
        requiredBytes: required.toString()
      });
    }
  }

  validateBegin(body) {
    const relativePath = body?.path;
    const size = positiveSafeInteger(body?.size, "size", { allowZero: true });
    const lastModified = positiveSafeInteger(body?.lastModified ?? 0, "lastModified", { allowZero: true });
    const resumeKey = String(body?.resumeKey || "");
    if (!resumeKey || resumeKey.length > 2048 || /[\r\n\0]/.test(resumeKey)) throw uploadError(400, "invalid resume key");
    return { path: relativePath, size, lastModified, resumeKey };
  }

  async begin(project, body) {
    const root = this.projectRoot(project);
    await this.ensureStateDirectory(project);
    const input = this.validateBegin(body);
    destinationPath(root, input.path);
    const beginKey = `begin:${crypto.createHash("sha256").update(input.resumeKey).digest("hex")}`;

    return this.withLock(project, beginKey, async () => {
      for (const entry of await this.metadataFiles(project)) {
        const id = entry.name.slice(0, -5);
        try {
          const { record, offset } = await this.readUpload(project, id);
          if (!record.completedAt && record.resumeKey === input.resumeKey && record.path === input.path && record.size === input.size && record.lastModified === input.lastModified) {
            return this.response(record, offset, { resumed: true });
          }
        } catch {}
      }

      await this.assertInitialCapacity(input.size);
      const id = crypto.randomUUID();
      const directory = this.stateDirectory(project);
      const now = new Date().toISOString();
      const record = { version: 1, id, project, ...input, offset: 0, createdAt: now, updatedAt: now };
      let handle;
      try {
        handle = await fs.open(this.partPath(project, id), "wx", 0o600);
        await handle.sync();
        await handle.close();
        handle = null;
        await this.writeMetadata(project, record);
      } catch (error) {
        if (handle) await handle.close().catch(() => {});
        await fs.rm(path.join(directory, `${id}.part`), { force: true }).catch(() => {});
        await fs.rm(path.join(directory, `${id}.json`), { force: true }).catch(() => {});
        throw error;
      }
      return this.response(record, 0, { resumed: false });
    });
  }

  async status(project, id) {
    const { record, offset } = await this.readUpload(project, id);
    return this.response(record, offset);
  }

  async writeChunk(project, id, req) {
    const expectedOffset = positiveSafeInteger(req.headers["upload-offset"], "Upload-Offset", { allowZero: true });
    const contentLength = positiveSafeInteger(req.headers["content-length"], "Content-Length");
    if (contentLength > this.chunkBytes) {
      throw uploadError(413, "upload chunk exceeds the server chunk limit", { maxChunkBytes: this.chunkBytes });
    }

    return this.withLock(project, id, async () => {
      const { record, offset } = await this.readUpload(project, id);
      if (record.completedAt) return { upload: this.response(record, record.size), aborted: false };
      if (record.completingAt) throw uploadError(409, "upload is being finalized", { offset });
      if (expectedOffset !== offset) throw uploadError(409, "upload offset does not match persisted data", { offset });
      if (contentLength > record.size - offset) throw uploadError(400, "upload chunk exceeds declared file size", { offset });
      await this.assertChunkCapacity(contentLength);

      let handle;
      let received = 0;
      let interrupted = false;
      let failure = null;
      let durable = false;
      try {
        handle = await fs.open(this.partPath(project, id), WRITE_FLAGS);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size < offset) {
          throw uploadError(409, "upload data changed before writing", { offset: stat.size });
        }
        if (stat.size > offset) await handle.truncate(offset);
        try {
          for await (const chunk of req) {
            if (received + chunk.length > contentLength || received + chunk.length > this.chunkBytes) {
              throw uploadError(413, "upload chunk exceeded its declared length");
            }
            await writeAll(handle, chunk, offset + received);
            received += chunk.length;
          }
        } catch (error) {
          if (isInterruptedRequest(req, error)) interrupted = true;
          else failure = error;
        }
        if (!failure && (req.aborted || !req.complete)) interrupted = true;
        if (!interrupted && !failure && received !== contentLength) {
          failure = uploadError(400, "upload chunk was incomplete", { offset: offset + received });
        }
      } catch (error) {
        failure = error;
      } finally {
        if (handle) {
          if (received > 0) {
            try {
              await handle.sync();
              durable = true;
            } catch (error) {
              failure ||= error;
            }
          }
          await handle.close().catch((error) => { failure ||= error; });
        }
        if (received > 0 && durable) {
          record.offset = offset + received;
          record.updatedAt = new Date().toISOString();
          await this.writeMetadata(project, record).catch((error) => { failure ||= error; });
        }
      }

      if (failure) throw failure;
      return {
        upload: this.response(record, offset + received),
        aborted: interrupted || req.aborted || !req.complete
      };
    });
  }

  async promote(project, record) {
    const root = this.projectRoot(project);
    const source = this.partPath(project, record.id);
    const destination = destinationPath(root, record.path);
    const parent = await ensureSafeParent(root, destination, { create: true });
    const sourceStat = await fs.lstat(source);
    if (sourceStat.isSymbolicLink() || !sourceStat.isFile() || sourceStat.size !== record.size) {
      throw uploadError(409, "upload data is not ready to finalize");
    }

    if (process.platform === "linux") {
      const parentHandle = await fs.open(parent.parent, DIRECTORY_FLAGS);
      try {
        const opened = await parentHandle.stat();
        const current = await fs.stat(parent.parent);
        if (opened.dev !== current.dev || opened.ino !== current.ino) throw uploadError(409, "destination directory changed");
        const descriptorParent = await fs.realpath(`/proc/self/fd/${parentHandle.fd}`);
        if (!isInside(parent.rootReal, descriptorParent)) throw uploadError(400, "symlink traversal blocked");
        const target = `/proc/self/fd/${parentHandle.fd}/${path.basename(destination)}`;
        try {
          const targetStat = await fs.lstat(target);
          if (targetStat.isSymbolicLink()) throw uploadError(400, "symlink destination blocked");
          if (targetStat.isDirectory()) throw uploadError(400, "destination is a directory");
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        await fs.rename(source, target);
        await parentHandle.sync().catch(() => {});
      } finally {
        await parentHandle.close().catch(() => {});
      }
      return;
    }

    try {
      const targetStat = await fs.lstat(destination);
      if (targetStat.isSymbolicLink()) throw uploadError(400, "symlink destination blocked");
      if (targetStat.isDirectory()) throw uploadError(400, "destination is a directory");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await fs.rename(source, destination);
  }

  async complete(project, id) {
    return this.withLock(project, id, async () => {
      const { record, offset } = await this.readUpload(project, id);
      if (record.completedAt) return this.response(record, record.size);
      if (offset !== record.size) throw uploadError(409, "upload is not complete", { offset, size: record.size });

      if (!record.completingAt) {
        record.completingAt = new Date().toISOString();
        record.updatedAt = record.completingAt;
        await this.writeMetadata(project, record);
      }
      await this.promote(project, record);
      record.completedAt = new Date().toISOString();
      record.updatedAt = record.completedAt;
      delete record.completingAt;
      await this.writeMetadata(project, record);
      return this.response(record, record.size);
    });
  }

  async cancel(project, id) {
    return this.withLock(project, id, async () => {
      const record = await this.readMetadata(project, id);
      await fs.rm(this.partPath(project, id), { force: true });
      await fs.rm(this.recordPath(project, id), { force: true });
      return { id: record.id, path: record.path, cancelled: true };
    });
  }

  async removeProject(project) {
    this.deletingProjects.add(project);
    try {
      const prefix = `${project}:`;
      const active = [...this.locks.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, operation]) => operation);
      await Promise.allSettled(active);
      await fs.rm(this.stateDirectory(project), { recursive: true, force: true });
    } finally {
      this.deletingProjects.delete(project);
    }
  }
}
