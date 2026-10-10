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
