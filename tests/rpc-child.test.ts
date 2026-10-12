import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcChild, RpcReadTimeoutError } from "../src/extension/rpc-child.js";

async function fixture(run: (root: string, entry: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "pi-pane-rpc-child-")); const entry = join(root, "entry.mjs");
  await writeFile(entry, `import {writeFileSync} from 'node:fs'; import {createInterface} from 'node:readline';
writeFileSync(process.env.MARKER,JSON.stringify(process.argv.slice(2)));
const lines=createInterface({input:process.stdin}); lines.on('line',line=>{const message=JSON.parse(line); if(message.type==='hang'||message.type===process.env.HANG)return; process.stdout.write(JSON.stringify({type:'response',id:message.id,success:true,data:message.payload===undefined?{type:message.type}:{type:message.type,payload:message.payload}})+'\\n');}); lines.on('close',()=>process.exit(0));`);
  try { await run(root, entry); } finally { await rm(root, { recursive: true, force: true }); }
}
test("RPC startup is gated until durable writer registration and retains argv/response association", async () => fixture(async (root, entry) => {
  const marker = join(root, "started.json"); const child = new RpcChild(["--model", "fixture", "--session", "test.jsonl"], root, entry, { HOME: root, MARKER: marker });
  try {
    child.start(); assert(child.pid); await new Promise(resolve => setTimeout(resolve, 30)); await assert.rejects(access(marker));
    child.activate(); const values = await Promise.all([child.request("one", { payload: "first" }), child.request("two", { payload: "second" })]);
    assert.deepEqual(values, [{ type: "one", payload: "first" }, { type: "two", payload: "second" }]);
    assert.deepEqual(JSON.parse(await readFile(marker, "utf8")), ["--model", "fixture", "--session", "test.jsonl"]);
  } finally { await child.stop(); }
  assert.equal(child.running, false); assert.equal(await child.exited, 0);
}));
test("a slow read fails on its own and leaves the child running", async () => fixture(async (root, entry) => {
  const child = new RpcChild([], root, entry, { HOME: root, MARKER: join(root, "started.json"), HANG: "get_state" }, 50);
  try {
    child.start(); child.activate(); await child.request("ready");
    await assert.rejects(child.request("get_state"), error => error instanceof RpcReadTimeoutError && error.code === "rpc_read_timeout" && error.command === "get_state"); assert.equal(child.running, true);
    assert.deepEqual(await child.request("ready"), { type: "ready" });
  } finally { await child.stop(); }
}));
test("commands that can run extension code (dialogs, long commands) have no timeout", async () => fixture(async (root, entry) => {
  const child = new RpcChild([], root, entry, { HOME: root, MARKER: join(root, "started.json"), HANG: "prompt" }, 50);
  child.start(); child.activate(); await child.request("ready");
  let settled = false;
  const prompt = child.request("prompt", {}, 20).finally(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(settled, false, "a waiting prompt is not timed out, even with an explicit timeout argument"); assert.equal(child.running, true);
  await child.stop(); await assert.rejects(prompt, /exited/);
}));
test("spawn failure resolves the exit promise and pending calls reject without hanging shutdown", async () => fixture(async (root, entry) => {
  const child = new RpcChild([], join(root, "missing"), entry, { HOME: root }); child.start();
  await assert.rejects(child.request("ready", {}, 1000)); assert.equal(await child.exited, null); await child.stop();
}));
test("stop reports whether the child ended on its own or had to be signalled; a later urgent stop shortens the wait", async () => fixture(async (root, entry) => {
  const env = { HOME: root, MARKER: join(root, "started.json") };
  const orderly = new RpcChild([], root, entry, env); orderly.start(); orderly.activate(); await orderly.request("ready");
  assert.deepEqual(await orderly.stop({ graceMs: 5000 }), { code: 0, forced: false });
  assert.deepEqual(await orderly.stop(), { code: 0, forced: false });
  // A child that ignores stdin closing, like a shutdown handler that never returns.
  const stubborn = join(root, "stubborn.mjs");
  await writeFile(stubborn, `import {createInterface} from 'node:readline'; const lines=createInterface({input:process.stdin}); lines.on('line',line=>{const message=JSON.parse(line); process.stdout.write(JSON.stringify({type:'response',id:message.id,success:true,data:{}})+'\\n');}); setInterval(()=>{},1000);`);
  const slow = new RpcChild([], root, stubborn, env); slow.start(); slow.activate(); await slow.request("ready");
  const started = Date.now(); const planned = slow.stop({ graceMs: 60_000 });
  const urgent = await slow.stop({ graceMs: 50 });
  assert.equal(urgent.forced, true); assert.equal((await planned).forced, true); assert(Date.now() - started < 5000); assert.equal(slow.running, false);
}));

/**
 * A stand-in for pi's RPC mode: one detached command, stopped only by the termination handler or by
 * orderly shutdown. Like pi, it also carries a dependency's handler that re-raises the signal when it
 * is the only listener left.
 */
async function guarded(run: (root: string, entry: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "pi-pane-rpc-guard-")); const entry = join(root, "entry.mjs");
  await writeFile(entry, `import {spawn} from 'node:child_process'; import {createInterface} from 'node:readline';
process.on('SIGTERM',()=>{if(process.listeners('SIGTERM').length===1)process.kill(process.pid,'SIGKILL');});
if (process.env.STARTUP==='hang') { setInterval(()=>{},1000); await new Promise(()=>{}); }
const command=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); command.unref();
const stopCommand=()=>{try{process.kill(-command.pid,'SIGKILL')}catch{}};
const terminate=()=>{stopCommand(); if(process.env.HOOK!=='hang')process.exit(143);};
process.on('SIGTERM',terminate);
process.stdin.on('end',()=>{process.off('SIGTERM',terminate); setTimeout(()=>{stopCommand(); process.exit(0);},Number(process.env.SHUTDOWN_MS||0));});
setInterval(()=>{},1000);
createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line); process.stdout.write(JSON.stringify({type:'response',id:message.id,success:true,data:{command:command.pid}})+'\\n');});`);
  try { await run(root, entry); } finally { await rm(root, { recursive: true, force: true }); }
}
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function gone(pid: number, withinMs: number): Promise<boolean> {
  for (const deadline = Date.now() + withinMs; Date.now() < deadline;) { if (!alive(pid)) return true; await new Promise(resolve => setTimeout(resolve, 20)); }
  return !alive(pid);
}
/** What a crashed host looks like to the child: the lifecycle channel closes with no stop request. */
const owned = (child: RpcChild) => (child as unknown as { process: { disconnect(): void; stdin: { end(): void } } }).process;
const crash = (child: RpcChild): void => owned(child).disconnect();
test("a lost host makes a running child take pi's own termination path, so the command it runs is stopped too", async () => guarded(async (root, entry) => {
  const child = new RpcChild([], root, entry, { HOME: root }); child.start(); child.activate();
  const { command } = await child.request<{ command: number }>("ready");
  try {
    assert.equal(alive(command), true);
    crash(child);
    assert.equal(await child.exited, 143, "the child's own handler ran");
    assert.equal(await gone(command, 2000), true, "no command is left without an owner");
  } finally { try { process.kill(-command, "SIGKILL"); } catch { /* stopped */ } await child.stop({ graceMs: 0, killAfterMs: 0 }); }
}));
test("a termination handler that never finishes cannot keep an orphaned child alive", async () => guarded(async (root, entry) => {
  const child = new RpcChild([], root, entry, { HOME: root, HOOK: "hang" }); child.start(); child.activate();
  const { command } = await child.request<{ command: number }>("ready");
  try {
    const started = Date.now(); crash(child);
    assert.equal(await child.exited, 0); assert(Date.now() - started < 5000, "bounded by the orphan deadline");
    assert.equal(await gone(command, 2000), true);
  } finally { try { process.kill(-command, "SIGKILL"); } catch { /* stopped */ } await child.stop({ graceMs: 0, killAfterMs: 0 }); }
}));
test("a shutdown already in progress is left to finish: the dependency's handler is not allowed to cut it off", async () => guarded(async (root, entry) => {
  const child = new RpcChild([], root, entry, { HOME: root, SHUTDOWN_MS: "300" }); child.start(); child.activate();
  const { command } = await child.request<{ command: number }>("ready");
  try {
    // Input closes first and the child begins its own shutdown; only then does it learn the host is gone.
    owned(child).stdin.end(); await new Promise(resolve => setTimeout(resolve, 100)); crash(child);
    assert.equal(await child.exited, 0, "its own shutdown completed");
    assert.equal(await gone(command, 2000), true);
  } finally { try { process.kill(-command, "SIGKILL"); } catch { /* stopped */ } await child.stop({ graceMs: 0, killAfterMs: 0 }); }
}));
test("startup code that never returns cannot keep an orphaned child alive either", async () => guarded(async (root, entry) => {
  const child = new RpcChild([], root, entry, { HOME: root, STARTUP: "hang" }); child.start(); child.activate();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(child.running, true);
  const started = Date.now(); crash(child);
  assert.equal(await child.exited, 0); assert(Date.now() - started < 5000, "bounded by the orphan deadline");
}));
test("a host lost before the start gate opens stops the child at once", async () => guarded(async (root, entry) => {
  const child = new RpcChild([], root, entry, { HOME: root }); child.start();
  await new Promise(resolve => setTimeout(resolve, 200));
  const started = Date.now(); crash(child);
  assert.equal(await child.exited, 0); assert(Date.now() - started < 1000, "pi was never loaded");
}));
