import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import { ProtocolError } from "../protocol/index.js";

interface LockRecord { version: 1; pid: number; token: string; sessionFile: string; created: string; writerPid?: number }
interface Fingerprint { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }
/** A transcript entry as the owning writer reports it; enough to recognise its own appended lines. */
export interface KnownEntry { id: string; type: string }
/** What has been accepted: complete lines up to `offset`, the bytes just before it, and the last entry ID. */
interface Baseline { fingerprint?: Fingerprint; offset: number; tail: string; lastId?: string }

const TAIL_BYTES = 4096;
const CHUNK = 64 * 1024;
/** A guard older than this belongs to an acquisition that cannot still be running. */
const GUARD_STALE_MS = 30_000;

async function fingerprint(path: string): Promise<Fingerprint | undefined> {
  try { const s = await stat(path); return { dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function sameFingerprint(a?: Fingerprint, b?: Fingerprint): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
async function canonicalSessionPath(path: string): Promise<string> {
  return realpath(path).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return join(await realpath(dirname(path)), basename(path));
  });
}
async function readRange(file: FileHandle, start: number, end: number): Promise<Buffer> {
  const buffer = Buffer.alloc(Math.max(0, end - start));
  let read = 0;
  while (read < buffer.length) {
    const { bytesRead } = await file.read(buffer, read, buffer.length - read, start + read);
    if (!bytesRead) break;
    read += bytesRead;
  }
  return buffer.subarray(0, read);
}
const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
async function tailDigest(file: FileHandle, offset: number): Promise<string> {
  return digest(await readRange(file, Math.max(0, offset - TAIL_BYTES), offset));
}
/** End of the last complete line at or before `size` (0 when there is none). */
async function lastLineEnd(file: FileHandle, size: number): Promise<number> {
  for (let end = size; end > 0; end -= CHUNK) {
    const start = Math.max(0, end - CHUNK);
    const index = (await readRange(file, start, end)).lastIndexOf(0x0a);
    if (index >= 0) return start + index + 1;
  }
  return 0;
}
/** ID of the complete line ending at `offset`, if it is a JSON entry. */
async function lastLineId(file: FileHandle, offset: number): Promise<string | undefined> {
  if (offset === 0) return undefined;
  const start = await lastLineEnd(file, offset - 1);
  try {
    const value = JSON.parse((await readRange(file, start, offset - 1)).toString("utf8")) as { id?: unknown };
    return typeof value.id === "string" ? value.id : undefined;
  } catch { return undefined; }
}
interface LockOwner { pid: number; writerPid?: number }
/** A well-formed record whose host or recorded writer is still running. */
function liveOwner(record: Partial<LockRecord>): LockOwner | undefined {
  if (record.version !== 1 || !Number.isSafeInteger(record.pid) || record.pid! <= 0 || typeof record.token !== "string") return undefined;
  const writer = record.writerPid !== undefined && Number.isSafeInteger(record.writerPid) && record.writerPid > 0 ? record.writerPid : undefined;
  return alive(record.pid!) || (writer !== undefined && alive(writer)) ? { pid: record.pid!, ...(writer ? { writerPid: writer } : {}) } : undefined;
}

/**
 * Cooperative ownership of one transcript by a `/web` host and its RPC writer. Only `/web`
 * takes it; ordinary TUIs never do. Upstream pi does not observe the sidecar, so the host also
 * checks that every change to the transcript is an append of entries its own writer knows.
 */
export class SessionFileLock {
  private baseline: Baseline = { offset: 0, tail: digest(Buffer.alloc(0)) };
  private released = false;
  private constructor(readonly sessionFile: string, readonly lockPath: string, private readonly record: LockRecord) {}

  /** The live owner of a session's lock, if any. Read-only: never reaps or creates anything. */
  static async inspect(path: string): Promise<LockOwner | undefined> {
    const lockPath = `${await canonicalSessionPath(path)}.pi-pane.lock`;
    const file = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
    if (!file) return undefined;
    try {
      if ((await file.stat()).size > 4096) return undefined;
      return liveOwner(JSON.parse(await file.readFile("utf8")) as Partial<LockRecord>);
    } catch { return undefined; }
    finally { await file.close(); }
  }

  static async acquire(path: string): Promise<SessionFileLock> {
    const sessionFile = await canonicalSessionPath(path);
    const lockPath = `${sessionFile}.pi-pane.lock`;
    const record: LockRecord = { version: 1, pid: process.pid, token: randomUUID(), sessionFile, created: new Date().toISOString() };
    // Serialize acquire/reap even when the previous owner is dead. Without this guard,
    // two reapers could both stat the stale inode and one could unlink a new live lock.
    const guardPath = `${lockPath}.guard`;
    const guard = await SessionFileLock.openGuard(guardPath);
    try {
    await guard.writeFile(JSON.stringify({ pid: process.pid, created: record.created }));
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const file = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await file.writeFile(JSON.stringify(record)); await file.sync(); } finally { await file.close(); }
        const lock = new SessionFileLock(sessionFile, lockPath, record);
        await lock.resetBaseline();
        return lock;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const file = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        let existing: LockRecord;
        const before = await file.stat();
        try {
          if (before.size > 4096) throw new Error("Oversized session lock");
          existing = JSON.parse(await file.readFile("utf8")) as LockRecord;
        } catch { throw new ProtocolError("session_locked", `The session has an unreadable ownership lock. Inspect ${lockPath} before removing it.`); }
        finally { await file.close(); }
        if (existing.version !== 1 || !Number.isSafeInteger(existing.pid) || existing.pid <= 0 || typeof existing.token !== "string")
          throw new ProtocolError("session_locked", `The session has an unrecognised ownership lock. Inspect ${lockPath} before removing it.`);
        if (liveOwner(existing))
          throw new ProtocolError("session_locked", `This session is already running in another /web host (pid ${existing.pid}). If that process is gone, remove ${lockPath}.`);
        const after = await stat(lockPath);
        if (after.ino !== before.ino || after.dev !== before.dev) continue;
        await unlink(lockPath); // stale crashed owner; never delete a live owner's lock
      }
    }
    throw new ProtocolError("session_locked", "Session ownership changed while acquiring its lock.");
    } finally { await guard.close(); await unlink(guardPath); }
  }
  /** Creates the acquisition guard, reclaiming one left behind by a dead or long-finished acquisition. */
  private static async openGuard(guardPath: string): Promise<FileHandle> {
    const create = () => open(guardPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    for (let attempt = 0; ; attempt++) {
      try { return await create(); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ProtocolError("session_locked", "Session ownership is being acquired by another process; retry in a moment.");
          throw error;
        }
        const file = await open(guardPath, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
        if (!file) continue;
        let stale = false;
        const before = await file.stat();
        try {
          const value = JSON.parse(await file.readFile("utf8")) as { pid?: unknown; created?: unknown };
          const pid = typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0 ? value.pid : undefined;
          const created = typeof value.created === "string" ? Date.parse(value.created) : Number.NaN;
          stale = pid === undefined || !alive(pid) || !(Date.now() - created < GUARD_STALE_MS);
        } catch { stale = Date.now() - before.mtimeMs >= GUARD_STALE_MS; } // empty: a crash before writing it
        finally { await file.close(); }
        if (!stale) throw new ProtocolError("session_locked", "Session ownership is being acquired by another process; retry in a moment.");
        const after = await stat(guardPath).catch(() => undefined);
        if (after && after.ino === before.ino && after.dev === before.dev) await unlink(guardPath).catch(() => undefined);
      }
    }
  }
  /** Strict check for moments when nothing may write at all (between TUI shutdown and child start). */
  async assertUnchanged(): Promise<void> {
    await this.assertOwned();
    if (!sameFingerprint(await fingerprint(this.sessionFile), this.baseline.fingerprint))
      throw new ProtocolError("session_conflict", "The session file changed outside this host while idle. Stop the web host and inspect the session before resuming.");
  }
  /**
   * Accepts transcript changes made by the owning writer and rejects anything else. A change is the
   * writer's when the file only grew and every appended complete line is an entry `known` reports.
   * An incomplete last line (a write in progress) is left for the next check.
   */
  async verifyAppends(known: (sinceId?: string) => Promise<readonly KnownEntry[]>): Promise<void> {
    await this.assertOwned();
    const current = await fingerprint(this.sessionFile);
    if (sameFingerprint(current, this.baseline.fingerprint)) return;
    const conflict = (detail: string) => new ProtocolError("session_conflict", `The session file changed outside this host (${detail}). Stop the web host and inspect the session before resuming.`);
    if (!current) {
      if (this.baseline.fingerprint) throw conflict("the file disappeared");
      return;
    }
    const replaced = !this.baseline.fingerprint || current.dev !== this.baseline.fingerprint.dev || current.ino !== this.baseline.fingerprint.ino;
    const start = replaced ? 0 : this.baseline.offset;
    const file = await open(this.sessionFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!replaced) {
        if (current.size < start) throw conflict("it was truncated");
        if (await tailDigest(file, start) !== this.baseline.tail) throw conflict("earlier content was rewritten");
      }
      const end = await lastLineEnd(file, current.size);
      if (end <= start) {
        this.baseline = replaced ? { fingerprint: current, offset: 0, tail: await tailDigest(file, 0) } : { ...this.baseline, fingerprint: current };
        return;
      }
      const lines = (await readRange(file, start, end)).toString("utf8").slice(0, -1).split("\n");
      const entries = new Map((await known(replaced ? undefined : this.baseline.lastId)).map(entry => [entry.id, entry]));
      let lastId: string | undefined;
      for (const [index, line] of lines.entries()) {
        let value: { type?: unknown; id?: unknown };
        try { value = JSON.parse(line) as typeof value; } catch { throw conflict("a line is not a transcript entry"); }
        if (start === 0 && index === 0 && value.type === "session") continue; // the header
        const entry = typeof value.id === "string" ? entries.get(value.id) : undefined;
        if (!entry || entry.type !== value.type) throw conflict("an entry this host did not write was appended");
        lastId = entry.id;
      }
      // An incomplete last line stays beyond `offset` and is checked once it is complete.
      this.baseline = { fingerprint: current, offset: end, tail: await tailDigest(file, end), lastId: lastId ?? (replaced ? undefined : this.baseline.lastId) };
    } finally { await file.close(); }
  }
  private async assertOwned(): Promise<void> {
    if (this.released) throw new ProtocolError("session_lock_lost", "Session ownership has already been released.");
    const file = await open(this.lockPath, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
    if (!file) throw new ProtocolError("session_lock_lost", "The session ownership lock disappeared; the web host must stop.");
    try {
      const value = JSON.parse(await file.readFile("utf8")) as Partial<LockRecord>;
      if (value.token !== this.record.token) throw new ProtocolError("session_lock_lost", "Session ownership changed; the web host must stop.");
    } finally { await file.close(); }
  }
  /** Trusts the current contents: after the TUI has shut down, or after the owned writer opened a session. */
  async acceptChanges(): Promise<void> { await this.assertOwned(); await this.resetBaseline(); }
  private async resetBaseline(): Promise<void> {
    const current = await fingerprint(this.sessionFile);
    if (!current) { this.baseline = { offset: 0, tail: digest(Buffer.alloc(0)) }; return; }
    const file = await open(this.sessionFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const offset = await lastLineEnd(file, current.size);
      this.baseline = { fingerprint: current, offset, tail: await tailDigest(file, offset), lastId: await lastLineId(file, offset) };
    } finally { await file.close(); }
  }
  /** RPC can report lexical /var or symlink paths while the ownership sidecar is canonical. */
  async matchesPath(path: string): Promise<boolean> { return await canonicalSessionPath(path) === this.sessionFile; }
  /** Persist before allowing the launched RPC process to open the session. */
  async setWriterPid(pid: number): Promise<void> {
    if (!Number.isSafeInteger(pid) || pid <= 0 || this.released) throw new Error("Invalid session writer PID.");
    const file = await open(this.lockPath, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      const existing = JSON.parse(await file.readFile("utf8")) as Partial<LockRecord>;
      if (existing.token !== this.record.token) throw new ProtocolError("session_lock_lost", "Session ownership changed before launching the writer.");
      this.record.writerPid = pid;
      const data = Buffer.from(JSON.stringify(this.record));
      await file.write(data, 0, data.length, 0); await file.truncate(data.length); await file.sync();
    } finally { await file.close(); }
  }
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    let file;
    try { file = await open(this.lockPath, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    const before = await file.stat();
    try {
      const value = JSON.parse(await file.readFile("utf8")) as Partial<LockRecord>;
      if (value.token !== this.record.token) return;
      const after = await stat(this.lockPath);
      if (before.ino === after.ino && before.dev === after.dev) await unlink(this.lockPath);
    } finally { await file.close(); }
  }
}
