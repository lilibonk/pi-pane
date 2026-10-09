import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcChild } from "../src/extension/rpc-child.js";

async function fixture(run: (root: string, entry: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "pi-pane-rpc-child-")); const entry = join(root, "entry.mjs");
  await writeFile(entry, `import {writeFileSync} from 'node:fs'; import {createInterface} from 'node:readline';
writeFileSync(process.env.MARKER,JSON.stringify(process.argv.slice(2)));
const lines=createInterface({input:process.stdin}); lines.on('line',line=>{const message=JSON.parse(line); if(message.type==='hang')return; process.stdout.write(JSON.stringify({type:'response',id:message.id,success:true,data:{type:message.type,payload:message.payload}})+'\\n');}); lines.on('close',()=>process.exit(0));`);
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
test("an uncertain RPC timeout stops the child and never replays the write", async () => fixture(async (root, entry) => {
  const child = new RpcChild([], root, entry, { HOME: root, MARKER: join(root, "started.json") });
  child.start(); child.activate(); await child.request("ready", {}, 1000);
  await assert.rejects(child.request("hang", {}, 20), /timed out/); await child.stop(); assert.equal(child.running, false);
}));
test("spawn failure resolves the exit promise and pending calls reject without hanging shutdown", async () => fixture(async (root, entry) => {
  const child = new RpcChild([], join(root, "missing"), entry, { HOME: root }); child.start();
  await assert.rejects(child.request("ready", {}, 1000)); assert.equal(await child.exited, null); await child.stop();
}));
