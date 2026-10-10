import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, writeFile, readFile, rename, rm, stat, symlink, truncate, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionFileLock, type KnownEntry } from "../src/extension/session-lock.js";

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
async function transcript(run: (path: string, lock: SessionFileLock, known: KnownEntry[], asked: Array<string | undefined>) => Promise<void>) {
  return fixture(async path => {
    await writeFile(path, line({ type: "session", id: "session-1", cwd: "/" }) + line({ type: "message", id: "a", parentId: null }));
    const lock = await SessionFileLock.acquire(path); const known: KnownEntry[] = [{ id: "a", type: "message", parentId: null }]; const asked: Array<string | undefined> = [];
    try { await run(path, lock, known, asked); } finally { await lock.release(); }
  });
}
const writer = (known: KnownEntry[], asked: Array<string | undefined>) => async (since?: string) => {
  asked.push(since); const index = since ? known.findIndex(entry => entry.id === since) : -1; return index >= 0 ? known.slice(index + 1) : known;
};
test("entries the owned writer appends at any time are accepted, read incrementally from the last one", async () => transcript(async (path, lock, known, asked) => {
  await appendFile(path, line({ type: "custom", id: "b", parentId: "a" })); known.push({ id: "b", type: "custom", parentId: "a" });
  await lock.verifyAppends(writer(known, asked));
  await appendFile(path, line({ type: "message", id: "c", parentId: "b" })); known.push({ id: "c", type: "message", parentId: "b" });
  await lock.verifyAppends(writer(known, asked));
  assert.deepEqual(asked, ["a", "b"]); await lock.assertUnchanged();
}));
test("an incomplete last line waits for completion instead of failing", async () => transcript(async (path, lock, known, asked) => {
  const next = line({ type: "message", id: "b", parentId: "a" }); known.push({ id: "b", type: "message", parentId: "a" });
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
    const text = await readFile(path, "utf8"); await writeFile(path, `${text.replace('"a"', '"z"')}${line({ type: "message", id: "b", parentId: "a" })}`); known.push({ id: "b", type: "message", parentId: "a" });
    await assert.rejects(lock.verifyAppends(writer(known, asked)), { code: "session_conflict" });
  });
});
test("a replacement that preserves accepted history and appends complete writer entries is accepted", async () => transcript(async (path, lock, known, asked) => {
  const content = await readFile(path, "utf8"); await rm(path); await writeFile(path, content + line({ type: "message", id: "b", parentId: "a" }));
  known.push({ id: "b", type: "message", parentId: "a" }); await lock.verifyAppends(writer(known, asked)); assert.deepEqual(asked, [undefined]);
  await rm(path); await writeFile(path, content + line({ type: "message", id: "x", parentId: "a" }));
  await assert.rejects(lock.verifyAppends(writer(known, asked)), { code: "session_conflict" });
}));
test("rewriting accepted history before the last 4 KiB conflicts, with or without an owned append", async () => {
  for (const append of [false, true]) await transcript(async (path, lock, known, asked) => {
    const large = { type: "custom", id: "large", parentId: "a", data: "x".repeat(128 * 1024) };
    await appendFile(path, line(large)); known.push(large); await lock.verifyAppends(writer(known, asked));
    const contents = await readFile(path, "utf8");
    const next = { type: "custom", id: "next", parentId: "large", data: "owned" }; known.push(next);
    await writeFile(path, contents.replace('"a"', '"z"') + (append ? line(next) : ""));
    await assert.rejects(lock.verifyAppends(writer(known, asked)), { code: "session_conflict" });
  });
});
test("atomic replacement cannot truncate accepted history, change its contents, or alter its header", async () => {
  for (const mutation of ["truncate", "content", "header"]) await transcript(async (path, lock, known, asked) => {
    const next = { type: "custom", id: "b", parentId: "a", data: "original" };
    const original = await readFile(path, "utf8");
    await appendFile(path, line(next)); known.push(next); await lock.verifyAppends(writer(known, asked));
    const contents = await readFile(path, "utf8");
    const replacement = mutation === "truncate" ? original : mutation === "content" ? contents.replace("original", "tampered") : contents.replace("session-1", "session-2");
    await writeFile(`${path}.replacement`, replacement); await rename(`${path}.replacement`, path);
    await assert.rejects(lock.verifyAppends(writer(known, asked)), { code: "session_conflict" });
  });
});
test("an appended entry must match the writer's full contents, not only its ID and type", async () => transcript(async (path, lock, known, asked) => {
  known.push({ type: "custom", id: "b", parentId: "a", data: "owned" });
  await appendFile(path, line({ type: "custom", id: "b", parentId: "a", data: "foreign" }));
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
const jsonLine = (value: unknown) => `${JSON.stringify(value)}\n`;
test("shutdown-window appends are accepted only as complete non-message entries on an unchanged file", async () => {
  const header = jsonLine({ type: "session", id: "s", cwd: "/p" }); const first = jsonLine({ type: "message", id: "m1", message: { role: "user", content: "hi" } });
  const withLock = async (run: (path: string, lock: SessionFileLock) => Promise<void>) => fixture(async path => {
    await writeFile(path, header + first); const lock = await SessionFileLock.acquire(path);
    try { await run(path, lock); } finally { await lock.release(); }
  });
  await withLock(async (path, lock) => {
    assert.equal(await lock.acceptShutdownAppends(), 0);
    await appendFile(path, jsonLine({ type: "custom", id: "c1", customType: "note" }) + jsonLine({ type: "session_info", id: "c2", name: "n" }));
    assert.equal(await lock.acceptShutdownAppends(), 2);
    await lock.assertUnchanged(); // the accepted ending is the new baseline for a restore
  });
  for (const [appended, reason] of [
    [jsonLine({ type: "message", id: "m2", message: { role: "assistant", content: [] } }), /turn was still running/],
    [jsonLine({ type: "custom", id: "c1" }).slice(0, -1), /incomplete/],
    ["not json\n", /not a transcript entry/],
    [jsonLine({ type: "custom" }), /not a transcript entry/],
    [jsonLine(["array"]), /not a transcript entry/],
  ] as const) await withLock(async (path, lock) => {
    await appendFile(path, appended);
    await assert.rejects(lock.acceptShutdownAppends(), error => (error as { code?: string }).code === "session_conflict" && reason.test((error as Error).message));
    await assert.rejects(lock.assertUnchanged(), { code: "session_conflict" }); // a refused ending is never adopted
  });
  await withLock(async (path, lock) => { await writeFile(path, header + jsonLine({ type: "message", id: "mX", message: { role: "user", content: "hi" } })); await assert.rejects(lock.acceptShutdownAppends(), /rewritten/); });
  await withLock(async (path, lock) => { await truncate(path, header.length); await assert.rejects(lock.acceptShutdownAppends(), /truncated/); });
  await withLock(async (path, lock) => { const copy = `${path}.new`; await writeFile(copy, header + first + jsonLine({ type: "custom", id: "c1" })); await rename(copy, path); await assert.rejects(lock.acceptShutdownAppends(), /replaced/); });
  await withLock(async (path, lock) => { await rm(path); await assert.rejects(lock.acceptShutdownAppends(), /disappeared/); });
});
test("a session first written during shutdown is accepted only without conversation messages", async () => fixture(async (_path, root) => {
  const path = join(root, "new.jsonl"); const lock = await SessionFileLock.acquire(path);
  try {
    assert.equal(await lock.acceptShutdownAppends(), 0);
    await writeFile(path, jsonLine({ type: "session", id: "s", cwd: "/p" }) + jsonLine({ type: "model_change", id: "e1", provider: "p", modelId: "m" }));
    assert.equal(await lock.acceptShutdownAppends(), 1);
  } finally { await lock.release(); }
}));
