#!/usr/bin/env node
/**
 * M3.1 runtime control with a real pi TUI and real RPC children: planned child replacement across
 * projects, recovery after a failed replacement, and fail-closed handling of a child that changes
 * project by itself. Temporary HOME/agent directories and the local deterministic provider only.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { startFixture, openClient, commandResult, workbenchQuery, waitFor } from "./m0-smoke.mjs";

const out = resolve(process.env.PI_M31_REPORT_DIR || "build-artifacts/m3.1/runtime");
await mkdir(out, { recursive: true });
const report = { startedAt: new Date().toISOString(), scope: "M31-1 runtime replacement, recovery and project invariant", realTui: true, realModelCalls: 0,
  isolation: "temporary HOME + agent/session dirs + local deterministic provider", checks: [], status: "running" };
const fixtures = [], clients = [];
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const plain = text => text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
const exists = path => readFile(path).then(() => true, () => false);
const lockOf = async file => JSON.parse(await readFile(`${await realpath(file)}.pi-pane.lock`, "utf8"));
async function check(name, fn) {
  const started = Date.now();
  try { const details = await fn(); report.checks.push({ name, status: "passed", durationMs: Date.now() - started, ...(details ? { details } : {}) }); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({ name, status: "failed", durationMs: Date.now() - started, error: String(error.stack ?? error) }); throw error; }
}
/** A handed-off host in project A plus a saved session of project B. */
async function start(envOverrides = {}) {
  const fixture = await startFixture({ extraExtensions: ["tests/fixtures/handoff-fixture.ts", "tests/fixtures/m31-probe.ts"], envOverrides });
  fixtures.push(fixture);
  const other = join(fixture.directory, "project-b"); await mkdir(other); await writeFile(join(other, "only-b.txt"), "M31_PROJECT_B\n");
  const foreign = SessionManager.create(other, join(fixture.agentDir, "sessions", "project-b"));
  foreign.appendMessage({ role: "user", content: [{ type: "text", text: "M31_B_HISTORY" }], timestamp: Date.now() });
  foreign.appendMessage({ role: "assistant", content: [{ type: "text", text: "M31_B_REPLY" }], api: "pi-pane-m0-api", provider: "pi-pane-m0", model: "deterministic", timestamp: Date.now(), stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const client = await openClient(fixture.url); clients.push(client);
  await waitFor(() => client.snapshot, "first snapshot");
  // One entry per RPC child process: its first session. A child's own later session changes are not new children.
  const rpc = async () => (await fixture.events()).filter((item, index, all) => item.event === "m31_session" && item.mode === "rpc"
    && all.findIndex(other => other.event === "m31_session" && other.mode === "rpc" && other.pid === item.pid) === index);
  const first = await waitFor(async () => (await rpc())[0], "first RPC child");
  return { fixture, client, other, otherReal: await realpath(other), foreign: { id: foreign.getSessionId(), file: foreign.getSessionFile() }, rpc, first,
    original: { id: client.snapshot.session.id, file: first.sessionFile, cwd: client.snapshot.session.cwd } };
}
async function run(client, name, args = {}) {
  const operation = await client.command(name, args); assert.equal(operation.ack.status, "dispatched", operation.ack.error?.message);
  return commandResult(client, operation.frame);
}
async function hostCommand(client, command) {
  const state = client.frames.filter(item => item.t === "host_state").at(-1); assert.ok(state, "host state is known");
  const commandNo = client.nextCommandNo++; const id = `${client.clientId}:${commandNo}`;
  client.send({ t: "host_command", clientId: client.clientId, commandNo, id, hostRevision: state.revision, command, args: {} });
  const ack = await waitFor(() => client.frames.find(item => item.t === "ack" && item.id === id), `ack ${command}`);
  assert.equal(ack.status, "dispatched", ack.error?.message);
  return waitFor(() => client.frames.find(item => item.t === "command_result" && item.id === id), `result ${command}`, 30_000);
}
const hostPhases = client => client.frames.filter(item => item.t === "host_state").map(item => item.phase);
async function reply(client, text) {
  assert.equal((await run(client, "prompt", { text, mode: "followUp" })).status, "completed");
  await waitFor(() => client.snapshot?.state.idle && client.snapshot.session.messages.some(message => message.role === "assistant" && JSON.stringify(message.content).includes(`M0_REPLY:${text}:`)), `reply to ${text}`, 20_000);
}

try {
  {
    const { fixture, client, other, otherReal, foreign, rpc, first, original } = await start();
    let second;
    await check("a session of another project is opened by a new child started in that project", async () => {
      await workbenchQuery(client, "sessions", { scope: "all" });
      const result = await run(client, "session_switch", { sessionId: foreign.id }); assert.equal(result.status, "completed", result.error?.message);
      await waitFor(() => client.snapshot?.session.id === foreign.id, "project B snapshot");
      second = await waitFor(async () => (await rpc()).find(item => item.pid !== first.pid), "second RPC child");
      assert.equal(await realpath(second.processCwd), otherReal); assert.equal(await realpath(second.ctxCwd), otherReal); assert.equal(second.sessionFile, foreign.file);
      await waitFor(() => !alive(first.pid), "first child exited");
      const events = await fixture.events();
      assert.ok(events.some(item => item.event === "m31_shutdown_end" && item.pid === first.pid), "the old child's shutdown handlers finished");
      assert.equal(fixture.exitCode, undefined); assert.equal(client.closed, false); assert.ok(alive(fixture.hostPid));
      assert.deepEqual(hostPhases(client).slice(-2), ["replacing", "ready"]);
      assert.equal(client.snapshot.session.cwd, other);
      assert.equal(await exists(`${await realpath(original.file)}.pi-pane.lock`), false);
      const lock = await lockOf(foreign.file); assert.equal(lock.writerPid, second.pid);
      assert.match((await workbenchQuery(client, "file", { path: "only-b.txt" })).text, /M31_PROJECT_B/);
      return { firstChild: first.pid, secondChild: second.pid, processCwd: second.processCwd };
    });
    await check("the replaced runtime answers and writes only to its own project's session", async () => {
      const before = (await readFile(original.file, "utf8")).length;
      await reply(client, "M31_IN_B");
      assert.match(await readFile(foreign.file, "utf8"), /M31_IN_B/); assert.equal((await readFile(original.file, "utf8")).length, before);
      assert.equal(fixture.exitCode, undefined);
    });
    await check("a child that switches itself to another project's session stops the service, with the right resume command", async () => {
      const operation = await client.command("run_command", { name: "m31-switch", args: original.file });
      assert.equal(operation.ack.status, "dispatched", operation.ack.error?.message);
      await waitFor(() => fixture.exitCode !== undefined, "fail-closed stop", 20_000);
      const result = client.frames.find(item => item.t === "command_result" && item.id === operation.frame.id);
      if (result) { assert.equal(result.status, "failed"); assert.equal(result.error.code, "project_mismatch"); }
      const terminal = plain(fixture.terminal);
      assert.match(terminal, /another project/); assert.match(terminal, /No automatic restart/);
      assert.ok(terminal.includes(`pi --session '${original.file}'`), "resume names the session the child ended on");
      await waitFor(() => !alive(second.pid), "second child exited");
      assert.equal(await exists(`${await realpath(original.file)}.pi-pane.lock`), false); assert.equal(await exists(`${await realpath(foreign.file)}.pi-pane.lock`), false);
      assert.equal((await rpc()).length, 2, "nothing was restarted");
    });
  }
  {
    const { fixture, client, other, foreign, rpc, first, original } = await start({ PI_M31_SHUTDOWN_DIALOG: "1" });
    await check("a shutdown dialog makes the planned stop incomplete: the target is not started and the host asks", async () => {
      await workbenchQuery(client, "sessions", { scope: "all" });
      const result = await run(client, "session_switch", { sessionId: foreign.id });
      assert.equal(result.status, "failed"); assert.equal(result.error.code, "recovery_required");
      const state = await waitFor(() => client.frames.filter(item => item.t === "host_state").at(-1)?.phase === "recovery_required" && client.frames.filter(item => item.t === "host_state").at(-1), "recovery state");
      assert.equal(state.recovery.reason, "stop_incomplete"); assert.equal(state.recovery.canRestore, true); assert.equal(state.recovery.targetCwd, other);
      assert.ok(!JSON.stringify(state).includes(".jsonl"));
      assert.equal((await rpc()).length, 1, "no child was started for the target"); await waitFor(() => !alive(first.pid), "old child exited");
      assert.equal(fixture.exitCode, undefined); assert.equal(client.closed, false);
      assert.equal(await exists(`${await realpath(foreign.file)}.pi-pane.lock`), false); assert.equal((await lockOf(original.file)).pid, fixture.hostPid);
      // A page opened now learns the recovery state before anything else about a session.
      const late = await openClient(fixture.url, undefined, { sessionless: true }); clients.push(late);
      await waitFor(() => late.frames.some(item => item.t === "switching"), "late viewer state");
      assert.deepEqual(late.frames.map(item => item.t).slice(0, 3), ["welcome", "host_state", "switching"]); assert.equal(late.snapshot, undefined);
      assert.match(plain(fixture.terminal), /opened a dialog while the session runtime was shutting down/);
    });
    await check("restore is one explicit step and brings back the previous session with its history", async () => {
      const result = await hostCommand(client, "recover_restore"); assert.equal(result.status, "completed", result.error?.message);
      await waitFor(() => client.snapshot?.session.id === original.id, "previous session snapshot");
      const children = await rpc(); assert.equal(children.length, 2); assert.equal(children[1].sessionFile, original.file);
      assert.equal(hostPhases(client).at(-1), "ready");
      await reply(client, "M31_AFTER_RESTORE");
      assert.equal((await lockOf(original.file)).writerPid, children[1].pid);
    });
    await check("stop from the recovery page ends the service cleanly and prints the resume command", async () => {
      await workbenchQuery(client, "sessions", { scope: "all" });
      assert.equal((await run(client, "session_switch", { sessionId: foreign.id })).error?.code, "recovery_required");
      await waitFor(() => hostPhases(client).at(-1) === "recovery_required", "second recovery state");
      const operation = hostCommand(client, "host_stop").catch(() => undefined);
      await waitFor(() => fixture.exitCode !== undefined, "host stop", 20_000); await operation;
      assert.equal(fixture.exitCode, 0);
      const terminal = plain(fixture.terminal);
      assert.ok(terminal.includes(`pi --session '${original.file}'`)); assert.doesNotMatch(terminal, /No automatic restart/);
      assert.equal(await exists(`${await realpath(original.file)}.pi-pane.lock`), false);
      for (const child of await rpc()) assert.equal(alive(child.pid), false);
    });
  }
  {
    const { fixture, client, foreign, rpc, first, original } = await start({ PI_M31_SHUTDOWN_DELAY: "3000", PI_M31_SHUTDOWN_APPEND: "1" });
    await check("a slow shutdown handler is waited for, and its non-message entry is accepted and reported", async () => {
      await workbenchQuery(client, "sessions", { scope: "all" });
      const started = Date.now();
      const result = await run(client, "session_switch", { sessionId: foreign.id }); assert.equal(result.status, "completed", result.error?.message);
      assert.ok(Date.now() - started >= 2900, "the handler's delay was honoured, not cut at the emergency timeout");
      const events = await fixture.events();
      assert.ok(events.some(item => item.event === "m31_shutdown_end" && item.pid === first.pid && item.mode !== "tui"));
      assert.match(await readFile(original.file, "utf8"), /m31-shutdown/);
      assert.match(plain(fixture.terminal), /Accepted 1 transcript entries written while the previous session runtime shut down/);
      assert.equal((await rpc()).length, 2);
      return { waitedMs: Date.now() - started };
    });
    await check("Ctrl+C after a replacement stops the current child and names the current project's session", async () => {
      const current = (await rpc())[1];
      fixture.write("\u0003"); await waitFor(() => fixture.exitCode !== undefined, "Ctrl+C stop", 20_000);
      assert.equal(fixture.exitCode, 0); await waitFor(() => !alive(current.pid), "current child stopped");
      assert.ok(plain(fixture.terminal).includes(`pi --session '${foreign.file}'`));
      assert.equal(await exists(`${await realpath(foreign.file)}.pi-pane.lock`), false);
    });
  }
  report.status = "passed";
} catch (error) { report.status = "failed"; report.error = String(error.stack ?? error); process.exitCode = 1; console.error(error); }
finally {
  for (const client of clients) await client.close().catch(() => {});
  for (const fixture of fixtures) { await fixture.close().catch(() => {}); await fixture.remove().catch(() => {}); }
  report.finishedAt = new Date().toISOString();
  await writeFile(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.status.toUpperCase()} — ${report.checks.filter(item => item.status === "passed").length}/${report.checks.length} checks; report: ${join(out, "report.json")}`);
}
