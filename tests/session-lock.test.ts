import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionFileLock } from "../src/extension/session-lock.js";

async function fixture(run: (path: string, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "pi-pane-lock-")); const path = join(root, "session.jsonl");
  await writeFile(path, "original\n"); try { await run(path, root); } finally { await rm(root, { recursive: true, force: true }); }
}
test("a live cooperative owner excludes a second writer, including a symlink alias", async () => fixture(async (path, root) => {
  const lock = await SessionFileLock.acquire(path); const alias = join(root, "alias.jsonl"); await symlink(path, alias);
  assert.equal((await stat(lock.lockPath)).mode & 0o777, 0o600);
  await assert.rejects(SessionFileLock.acquire(path), { code: "session_locked" }); await assert.rejects(SessionFileLock.acquire(alias), { code: "session_locked" });
  await lock.release(); const other = await SessionFileLock.acquire(alias); await other.release();
}));
test("stale crashed ownership is reclaimed; malformed locks are never silently removed", async () => fixture(async path => {
  await writeFile(`${path}.pi-pane.lock`, JSON.stringify({ version: 1, pid: 2147483647, token: "stale" }));
  const lock = await SessionFileLock.acquire(path); await lock.release();
  await writeFile(`${path}.pi-pane.lock`, "unreadable"); await assert.rejects(SessionFileLock.acquire(path), { code: "session_locked" });
  assert.equal(await readFile(`${path}.pi-pane.lock`, "utf8"), "unreadable");
}));
test("a dead host cannot be reclaimed while its recorded RPC writer is still alive", async () => fixture(async path => {
  await writeFile(`${path}.pi-pane.lock`, JSON.stringify({ version: 1, pid: 2147483647, writerPid: process.pid, token: "active-child" }));
  await assert.rejects(SessionFileLock.acquire(path), { code: "session_locked" });
}));
test("concurrent stale-owner acquisition has exactly one winner and preserves its live lock", async () => fixture(async path => {
  await writeFile(`${path}.pi-pane.lock`, JSON.stringify({ version: 1, pid: 2147483647, token: "stale" }));
  const attempts = await Promise.allSettled([SessionFileLock.acquire(path), SessionFileLock.acquire(path)]);
  const winners = attempts.filter((result): result is PromiseFulfilledResult<SessionFileLock> => result.status === "fulfilled");
  assert.equal(winners.length, 1); await winners[0]!.value.assertUnchanged(); await winners[0]!.value.release();
}));
test("uncooperative changes while idle fail closed; acknowledged own writes update the fingerprint", async () => fixture(async path => {
  const lock = await SessionFileLock.acquire(path); await lock.assertUnchanged(); await writeFile(path, "external writer\n");
  await assert.rejects(lock.assertUnchanged(), { code: "session_conflict" }); await lock.acceptChanges(); await lock.assertUnchanged(); await lock.release();
}));
test("lock replacement or disappearance is detected and release never deletes another owner", async () => fixture(async path => {
  const lock = await SessionFileLock.acquire(path); await writeFile(lock.lockPath, JSON.stringify({ token: "other-owner" }));
  await assert.rejects(lock.assertUnchanged(), { code: "session_lock_lost" }); await lock.release();
  assert.equal(JSON.parse(await readFile(lock.lockPath, "utf8")).token, "other-owner");
}));
