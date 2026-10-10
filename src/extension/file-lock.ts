import { constants } from "node:fs";
import { open, readFile, rename, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, basename } from "node:path";

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } };
const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

/**
 * Serializes read-modify-write of one pi-pane-owned file across hosts. The lock file names its holder;
 * a holder that is gone, or a lock older than `staleMs`, is reclaimed.
 */
export async function withFileLock<T>(path: string, run: () => Promise<T>, { timeoutMs = 5000, staleMs = 30_000 } = {}): Promise<T> {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const file = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(JSON.stringify({ pid: process.pid, created: Date.now() })); } finally { await file.close(); }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const before = await stat(lockPath).catch(() => undefined);
      if (before) {
        let stale = Date.now() - before.mtimeMs >= staleMs;
        try { const holder = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown }; if (typeof holder.pid === "number" && !alive(holder.pid)) stale = true; }
        catch { /* being written, or damaged: age decides */ }
        if (stale) {
          const after = await stat(lockPath).catch(() => undefined);
          if (after && after.ino === before.ino && after.dev === before.dev) await unlink(lockPath).catch(() => undefined);
          continue;
        }
      }
      if (Date.now() >= deadline) throw Object.assign(new Error(`${basename(path)} is being changed by another process; retry in a moment.`), { code: "file_locked" });
      await pause(25);
    }
  }
  try { return await run(); } finally { await unlink(lockPath).catch(() => undefined); }
}

/** Replaces `path` with `text` in one rename, so a reader never sees a partial file. */
export async function writeFileAtomic(path: string, text: string, mode = 0o600): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { await file.writeFile(text); await file.sync(); }
  catch (error) { await file.close(); await unlink(temporary).catch(() => undefined); throw error; }
  await file.close();
  try { await rename(temporary, path); } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
}
