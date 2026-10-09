import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, writeFile, readFile, rm, stat, symlink, truncate, utimes } from "node:fs/promises";
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
test("uncooperative changes while idle fail the strict check; accepted contents become the baseline", async () => fixture(async path => {
  const lock = await SessionFileLock.acquire(path); await lock.assertUnchanged(); await writeFile(path, "external writer\n");
  await assert.rejects(lock.assertUnchanged(), { code: "session_conflict" }); await lock.acceptChanges(); await lock.assertUnchanged(); await lock.release();
}));

const line = (value: Record<string, unknown>) => `${JSON.stringify(value)}\n`;
async function transcript(run: (path: string, lock: SessionFileLock, known: Array<{ id: string; type: string }>, asked: Array<string | undefined>) => Promise<void>) {
  return fixture(async path => {
    await writeFile(path, line({ type: "session", id: "session-1", cwd: "/" }) + line({ type: "message", id: "a", parentId: null }));
    const lock = await SessionFileLock.acquire(path); const known = [{ id: "a", type: "message" }]; const asked: Array<string | undefined> = [];
    try { await run(path, lock, known, asked); } finally { await lock.release(); }
  });
}
const writer = (known: Array<{ id: string; type: string }>, asked: Array<string | undefined>) => async (since?: string) => {
  asked.push(since); const index = since ? known.findIndex(entry => entry.id === since) : -1; return index >= 0 ? known.slice(index + 1) : known;
};
test("entries the owned writer appends at any time are accepted, read incrementally from the last one", async () => transcript(async (path, lock, known, asked) => {
  await appendFile(path, line({ type: "custom", id: "b", parentId: "a" })); known.push({ id: "b", type: "custom" });
  await lock.verifyAppends(writer(known, asked));
  await appendFile(path, line({ type: "message", id: "c", parentId: "b" })); known.push({ id: "c", type: "message" });
  await lock.verifyAppends(writer(known, asked));
  assert.deepEqual(asked, ["a", "b"]); await lock.assertUnchanged();
}));
test("an incomplete last line waits for completion instead of failing", async () => transcript(async (path, lock, known, asked) => {
  const next = line({ type: "message", id: "b", parentId: "a" }); known.push({ id: "b", type: "message" });
  await appendFile(path, next.slice(0, 10)); await lock.verifyAppends(writer(known, asked)); assert.deepEqual(asked, []);
  await appendFile(path, next.slice(10)); await lock.verifyAppends(writer(known, asked)); assert.deepEqual(asked, ["a"]);
}));
test("unknown entries, blank lines, truncation and rewritten history are conflicts", async () => {
  await transcript(async (path, lock, known, asked) => {
    await appendFile(path, line({ type: "message", id: "foreign", parentId: "a" }));
    await assert.rejects(lock.verifyAppends(writer(known, asked)), { code: "session_conflict" });
  });
  await transcript(async (path, lock, known, asked) => {
    await appendFile(path, "\n"); await assert.rejects(lock.verifyAppends(writer(known, asked)), { code: "session_conflict" });
  });
  await transcript(async (path, lock, known, asked) => {
    await truncate(path, 10); await assert.rejects(lock.verifyAppends(writer(known, asked)), { code: "session_conflict" });
  });
  await transcript(async (path, lock, known, asked) => {
    const text = await readFile(path, "utf8"); await writeFile(path, `${text.replace('"a"', '"z"')}${line({ type: "message", id: "b", parentId: "a" })}`); known.push({ id: "b", type: "message" });
    await assert.rejects(lock.verifyAppends(writer(known, asked)), { code: "session_conflict" });
  });
});
test("a replaced transcript is accepted only when every entry is the writer's", async () => transcript(async (path, lock, known, asked) => {
  const content = await readFile(path, "utf8"); await rm(path); await writeFile(path, content + line({ type: "message", id: "b", parentId: "a" }));
  known.push({ id: "b", type: "message" }); await lock.verifyAppends(writer(known, asked)); assert.deepEqual(asked, [undefined]);
  await rm(path); await writeFile(path, content + line({ type: "message", id: "x", parentId: "a" }));
  await assert.rejects(lock.verifyAppends(writer(known, asked)), { code: "session_conflict" });
}));
test("an acquisition guard left by a dead or finished process is reclaimed; a live one refuses", async () => fixture(async path => {
  const guard = `${path}.pi-pane.lock.guard`;
  await writeFile(guard, JSON.stringify({ pid: 2147483647, created: new Date().toISOString() }));
  await (await SessionFileLock.acquire(path)).release();
  await writeFile(guard, JSON.stringify({ pid: process.pid, created: new Date(Date.now() - 60_000).toISOString() }));
  await (await SessionFileLock.acquire(path)).release();
  await writeFile(guard, ""); const old = new Date(Date.now() - 60_000); await utimes(guard, old, old);
  await (await SessionFileLock.acquire(path)).release();
  await writeFile(guard, JSON.stringify({ pid: process.pid, created: new Date().toISOString() }));
  await assert.rejects(SessionFileLock.acquire(path), { code: "session_locked" });
  assert.equal(JSON.parse(await readFile(guard, "utf8")).pid, process.pid);
}));
test("inspect reports only a live, well-formed owner and never changes anything", async () => fixture(async path => {
  assert.equal(await SessionFileLock.inspect(path), undefined);
  const lock = await SessionFileLock.acquire(path); assert.equal((await SessionFileLock.inspect(path))?.pid, process.pid); await lock.release();
  await writeFile(`${path}.pi-pane.lock`, JSON.stringify({ version: 1, pid: 2147483647, token: "stale" }));
  assert.equal(await SessionFileLock.inspect(path), undefined); assert.ok(await readFile(`${path}.pi-pane.lock`, "utf8"));
}));
test("lock replacement or disappearance is detected and release never deletes another owner", async () => fixture(async path => {
  const lock = await SessionFileLock.acquire(path); await writeFile(lock.lockPath, JSON.stringify({ token: "other-owner" }));
  await assert.rejects(lock.assertUnchanged(), { code: "session_lock_lost" }); await lock.release();
  assert.equal(JSON.parse(await readFile(lock.lockPath, "utf8")).token, "other-owner");
}));
