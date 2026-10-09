import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat, unlink } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import { ProtocolError } from "../protocol/index.js";

interface LockRecord { version: 1; pid: number; token: string; sessionFile: string; created: string; writerPid?: number }
interface Fingerprint { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }
async function fingerprint(path: string): Promise<Fingerprint | undefined> {
  try { const s = await stat(path); return { dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
async function canonicalSessionPath(path: string): Promise<string> {
  return realpath(path).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return join(await realpath(dirname(path)), basename(path));
  });
}

/**
 * Cooperative pi-pane ownership, not an operating-system lock on upstream pi.
 * Other pi-pane TUIs/hosts refuse the same sidecar. Upstream TUI does not observe it;
 * assertUnchanged detects an unexpected transcript change while our writer is idle.
 */
export class SessionFileLock {
  private expected?: Fingerprint;
  private released = false;
  private constructor(readonly sessionFile: string, readonly lockPath: string, private readonly record: LockRecord) {}

  static async acquire(path: string): Promise<SessionFileLock> {
    const sessionFile = await canonicalSessionPath(path);
    const lockPath = `${sessionFile}.pi-pane.lock`;
    const record: LockRecord = { version: 1, pid: process.pid, token: randomUUID(), sessionFile, created: new Date().toISOString() };
    // Serialize acquire/reap even when the previous owner is dead. Without this guard,
    // two reapers could both stat the stale inode and one could unlink a new live lock.
    const guardPath = `${lockPath}.guard`;
    const guard = await open(guardPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") throw new ProtocolError("session_locked", "Session ownership is being acquired, or an acquisition guard needs manual inspection.");
      throw error;
    });
    try {
    await guard.writeFile(JSON.stringify({ pid: process.pid, created: record.created }));
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const file = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await file.writeFile(JSON.stringify(record)); await file.sync(); } finally { await file.close(); }
        const lock = new SessionFileLock(sessionFile, lockPath, record);
        lock.expected = await fingerprint(sessionFile);
        return lock;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const file = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        let existing: LockRecord;
        const before = await file.stat();
        try {
          if (before.size > 4096) throw new Error("Oversized session lock");
          existing = JSON.parse(await file.readFile("utf8")) as LockRecord;
        } catch { throw new ProtocolError("session_locked", "The session has an unreadable ownership lock. Inspect it before removing it."); }
        finally { await file.close(); }
        if (existing.version !== 1 || !Number.isSafeInteger(existing.pid) || existing.pid <= 0 || typeof existing.token !== "string" || alive(existing.pid)
          || existing.writerPid !== undefined && (!Number.isSafeInteger(existing.writerPid) || existing.writerPid <= 0 || alive(existing.writerPid)))
          throw new ProtocolError("session_locked", "This session is already owned by another pi-pane terminal or web host.");
        const after = await stat(lockPath);
        if (after.ino !== before.ino || after.dev !== before.dev) continue;
        await unlink(lockPath); // stale crashed owner; never delete a live owner's lock
      }
    }
    throw new ProtocolError("session_locked", "Session ownership changed while acquiring its lock.");
    } finally { await guard.close(); await unlink(guardPath); }
  }
  async assertUnchanged(): Promise<void> {
    await this.assertOwned();
    if (JSON.stringify(await fingerprint(this.sessionFile)) !== JSON.stringify(this.expected))
      throw new ProtocolError("session_conflict", "The session file changed outside this host while idle. Stop the web host and inspect the session before resuming.");
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
  /** Call only after an acknowledged write by the owned child, or after the TUI has shut down. */
  async acceptChanges(): Promise<void> { await this.assertOwned(); this.expected = await fingerprint(this.sessionFile); }
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
