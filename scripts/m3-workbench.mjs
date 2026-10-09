#!/usr/bin/env node
/** Real pi TUI / WS verification of the first M3 workbench increment. */
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { openClient, waitFor, textOf } from "./m0-smoke.mjs";
import { startWorkbenchFixture } from "./m3-fixture.mjs";

const out = resolve(process.env.PI_M3_REPORT_DIR || "build-artifacts/m3/workbench");
const serve = process.argv.includes("--serve");
const redact = value => String(value).replace(/#t=[A-Za-z0-9_-]+/g, "#t=[REDACTED]").replace(/pi-pane\.bearer\.[A-Za-z0-9_-]+/g, "pi-pane.bearer.[REDACTED]");
await mkdir(out, { recursive: true });
const report = { startedAt: new Date().toISOString(), realTui: true, realModelCalls: 0,
  isolation: "Task-owned HOME, agent directory, session directory and Git workspace; credential-free deterministic provider",
  checks: [], limitations: ["No remote provider calls", "Interactive approvals/settings mutations and process handoff are separate M3-C/D work"] };
let fixture, client, observer;
const cleanup = async () => {
  await Promise.allSettled([client?.close(), observer?.close()].filter(Boolean));
  await fixture?.close(); await fixture?.remove();
  await rm(join(out, "access.json"), { force: true });
};
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void cleanup().finally(() => process.exit(0)));
const check = async (name, fn) => {
  const started = Date.now();
  try { const details = await fn(); report.checks.push({ name, status: "passed", durationMs: Date.now() - started, ...(details ? { details } : {}) }); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({ name, status: "failed", durationMs: Date.now() - started, error: redact(error) }); throw error; }
};
async function query(action, args = {}, target = client, version = target.snapshot) {
  assert.ok(version);
  const reqId = randomUUID();
  target.send({ t: "workbench_query", reqId, epoch: version.epoch, sessionId: version.session.id, branchRevision: version.session.branchRevision, action, args });
  const result = await waitFor(() => target.frames.find(frame => frame.reqId === reqId && (frame.t === "workbench_result" || frame.t === "error")), `workbench query ${action}`);
  if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  return result.value;
}
async function mutate(command, args = {}, version) {
  const { ack, frame } = await client.command(command, args, version);
  assert.equal(ack.status, "dispatched", `${command}: ${ack.error?.message}`);
  const result = await waitFor(() => client.frames.find(item => item.t === "command_result" && item.id === frame.id), `${command} result`);
  return { result, frame };
}
try {
  fixture = await startWorkbenchFixture();
  report.piVersion = fixture.piVersion;
  assert.equal(fixture.piVersion, "1.1.0", "M3 uses the selected pi 1.1.0 host");
  client = await openClient(fixture.url);
  observer = await openClient(fixture.url);
  let originalId, originalSnapshot;
  await check("workbench capability, sessions, commands and resources", async () => {
    assert.equal(client.snapshot.caps.workbench, true);
    const sessions = await query("sessions");
    assert.ok(sessions.sessions.some(item => item.id === client.snapshot.session.id && item.current));
    const commands = (await query("commands")).commands;
    for (const name of ["new", "resume", "tree", "m3-mark", "m3-template", "skill:m3-reference"]) assert.ok(commands.some(item => item.name === name), `discover ${name}`);
    assert.ok(!commands.some(item => /internal|gateway/.test(item.name)), "private gateway is not advertised");
    const resources = await query("resources");
    assert.ok(resources.tools.some(item => item.name === "m0_echo" && item.active));
    assert.ok(resources.models.length >= 1);
    return { commands: commands.length, tools: resources.tools.length };
  });
  await check("file discovery, bounded preview and workspace confinement", async () => {
    const files = await query("files", { query: "greet" });
    assert.ok(files.files.some(item => item.path === "src/greet.ts"));
    const file = await query("file", { path: "src/greet.ts" });
    assert.match(file.text, /Welcome/); assert.equal(file.truncated, false);
    await assert.rejects(query("file", { path: "../agent/auth.json" }), error => /path|outside|workspace|invalid/i.test(error.message));
    const spaced = await query("file", { path: "notes with spaces.md" });
    assert.match(spaced.text, /Explicit file context/);
  });
  await check("Git status and actual tracked/untracked diffs", async () => {
    const git = await query("git_status");
    assert.equal(git.isRepository, true);
    assert.ok(git.files.some(item => item.path === "src/greet.ts" && item.unstaged));
    assert.ok(git.files.some(item => item.path === "notes with spaces.md"));
    const diff = await query("git_diff", { path: "src/greet.ts" });
    assert.match(diff.text, /-.*Hello/); assert.match(diff.text, /\+.*Welcome/);
    assert.match((await query("git_diff", { path: "notes with spaces.md" })).text, /Explicit file context/);
    return { changedFiles: git.files.length };
  });
  await check("explicit extension command runs once without a model turn", async () => {
    const before = (await fixture.events()).filter(event => event.event === "provider_call").length;
    const { frame, ack } = await client.command("run_command", { name: "m3-mark", args: "literal $() `text`" });
    assert.equal(ack.status, "dispatched");
    await fixture.waitEvent("m3_mark");
    client.send(frame);
    await waitFor(() => client.frames.filter(item => item.t === "ack" && item.id === frame.id).length === 2, "duplicate command receipt");
    const events = await fixture.events();
    assert.equal(events.filter(event => event.event === "m3_mark").length, 1);
    assert.equal(events.filter(event => event.event === "provider_call").length, before);
  });
  await check("ordinary prompts preserve literal slash behavior", async () => {
    const { ack } = await client.command("prompt", { text: "/m3-mark literal prompt", mode: "followUp" });
    assert.equal(ack.status, "dispatched");
    await client.settled("/m3-mark literal prompt");
    assert.equal((await fixture.events()).filter(event => event.event === "m3_mark").length, 1);
  });
  await check("selected prompt template expands through the real host", async () => {
    const count = (await fixture.events()).filter(event => event.event === "provider_call").length;
    assert.equal((await client.command("run_command", { name: "m3-template", args: "from-browser" })).ack.status, "dispatched");
    const event = await fixture.waitEvent("provider_call", count);
    assert.match(event.input, /M3_TEMPLATE_EXPANDED:from-browser/);
    await waitFor(() => client.snapshot?.state.idle && client.snapshot.session.messages.some(item => item.role === "assistant" && textOf(item).includes("M3_TEMPLATE_EXPANDED")), "template completion");
  });
  await check("selected skill expands through the real host", async () => {
    const count = (await fixture.events()).filter(event => event.event === "provider_call").length;
    assert.equal((await client.command("run_command", { name: "skill:m3-reference", args: "from-browser" })).ack.status, "dispatched");
    const event = await fixture.waitEvent("provider_call", count);
    assert.match(event.input, /M3_SKILL_EXPANDED/);
    await waitFor(() => client.snapshot?.state.idle && client.snapshot.session.messages.some(item => item.role === "assistant" && textOf(item).includes("M3_SKILL_EXPANDED")), "skill completion");
    originalId = client.snapshot.session.id;
    originalSnapshot = structuredClone(client.snapshot);
  });
  await check("new session synchronizes both clients and rejects old operations", async () => {
    const { result } = await mutate("session_new");
    assert.equal(result.status, "completed");
    await waitFor(() => client.snapshot?.session.id !== originalId && observer.snapshot?.session.id === client.snapshot?.session.id, "both clients new session");
    assert.equal(client.snapshot.session.messages.length, 0);
    const stale = await client.command("prompt", { text: "M3_OLD_MUST_NOT_EXECUTE" }, originalSnapshot);
    assert.equal(stale.ack.status, "rejected"); assert.equal(stale.ack.error.code, "stale_session");
    assert.equal((await client.command("prompt", { text: "M3_NEW_PERSISTED" })).ack.status, "dispatched");
    await client.settled("M3_NEW_PERSISTED");
  });
  await check("cancelled new session retains the active session", async () => {
    const id = client.snapshot.session.id;
    assert.equal((await client.command("run_command", { name: "m3-cancel-next" })).ack.status, "dispatched");
    await fixture.waitEvent("m3_cancel_ready");
    const { result } = await mutate("session_new");
    assert.ok(result.status === "failed" || result.value?.cancelled === true, "cancel does not masquerade as a new session");
    assert.equal(client.snapshot.session.id, id);
    assert.equal((await query("file", { path: "src/greet.ts" })).path, "src/greet.ts", "queries continue after cancellation");
  });
  await check("pending session change rejects prompts before the host replaces context", async () => {
    const before = (await fixture.events()).filter(event => event.event === "provider_call").length;
    assert.equal((await client.command("run_command", { name: "m3-delay-next" })).ack.status, "dispatched");
    await fixture.waitEvent("m3_delay_ready");
    const moving = await client.command("session_new");
    assert.equal(moving.ack.status, "dispatched");
    await fixture.waitEvent("m3_switch_waiting");
    const prompt = await observer.command("prompt", { text: "M3_SWITCH_RACE_MUST_NOT_EXECUTE" });
    assert.equal(prompt.ack.status, "rejected");
    assert.equal(prompt.ack.error.code, "busy");
    const result = await waitFor(() => client.frames.find(item => item.t === "command_result" && item.id === moving.frame.id), "delayed switch result");
    assert.equal(result.status, "completed");
    assert.equal((await fixture.events()).filter(event => event.event === "provider_call").length, before);
    assert.equal(client.snapshot.session.messages.length, 0);
  });
  await check("resume uses the discovered session ID and fresh command context", async () => {
    const catalog = await query("sessions");
    assert.ok(catalog.sessions.some(item => item.id === originalId));
    const { result } = await mutate("session_switch", { sessionId: originalId });
    assert.equal(result.status, "completed");
    await waitFor(() => client.snapshot?.session.id === originalId && observer.snapshot?.session.id === originalId, "both clients resumed");
    assert.ok(client.snapshot.session.messages.some(item => textOf(item) === "/m3-mark literal prompt"));
    const invalid = await client.command("session_switch", { sessionId: "not-a-discovered-session" });
    if (invalid.ack.status === "dispatched") {
      const result = await waitFor(() => client.frames.find(item => item.t === "command_result" && item.id === invalid.frame.id), "invalid resume result");
      assert.equal(result.status, "failed");
    } else assert.equal(invalid.ack.status, "rejected");
  });
  await check("cross-workspace resume rebuilds context, files and command gateway together", async () => {
    const sessions = await query("sessions", { scope: "all", query: "另一工作区" });
    assert.ok(sessions.sessions.some(item => item.id === fixture.foreignSessionId));
    assert.equal((await mutate("session_switch", { sessionId: fixture.foreignSessionId })).result.status, "completed");
    await waitFor(() => client.snapshot?.session.id === fixture.foreignSessionId && observer.snapshot?.session.id === fixture.foreignSessionId, "foreign workspace synchronized");
    assert.equal(client.snapshot.session.cwd, fixture.foreignWorkspace);
    assert.match((await query("file", { path: "alternate.txt" })).text, /M3_FOREIGN_WORKSPACE_ONLY/);
    await assert.rejects(query("file", { path: "src/greet.ts" }), error => /exist|found|file/i.test(error.message));
    await query("sessions", { scope: "all" });
    assert.equal((await mutate("session_switch", { sessionId: originalId })).result.status, "completed");
    await waitFor(() => client.snapshot?.session.id === originalId, "original workspace restored");
    assert.match((await query("file", { path: "src/greet.ts" })).text, /Welcome/);
  });
  await check("fork from a real branch entry and navigate the tree", async () => {
    const tree = await query("tree");
    const assistant = tree.entries.find(entry => entry.role === "assistant");
    assert.ok(assistant);
    assert.equal((await mutate("session_fork", { entryId: assistant.id, position: "at" })).result.status, "completed");
    await waitFor(() => client.snapshot?.session.id !== originalId && observer.snapshot?.session.id === client.snapshot?.session.id, "fork synchronized");
    const forkTree = await query("tree");
    const user = forkTree.entries.find(entry => entry.role === "user");
    assert.ok(user);
    const navigated = (await mutate("session_tree", { entryId: user.id })).result;
    assert.equal(navigated.status, "completed");
    assert.equal(navigated.value.draftText, user.preview, "user navigation restores its input text");
    // pi navigates to the parent of a user message and restores that message to the editor.
    await waitFor(() => client.snapshot?.session.leafId === user.parentId && observer.snapshot?.session.leafId === user.parentId, "tree synchronized");
  });
  await check("session mutations are deduplicated even after epoch replacement", async () => {
    const count = (await fixture.events()).filter(event => event.event === "session_start" && event.reason === "new").length;
    const { frame, result } = await mutate("session_new");
    assert.equal(result.status, "completed");
    const id = client.snapshot?.session.id;
    client.send(frame);
    await waitFor(() => client.frames.filter(item => item.t === "ack" && item.id === frame.id).length === 2, "new session duplicate receipt");
    assert.equal(client.snapshot.session.id, id);
    assert.equal((await fixture.events()).filter(event => event.event === "session_start" && event.reason === "new").length, count + 1);
    const lease = client.clientId;
    await client.close(); client = await openClient(fixture.url, lease);
    client.send({ t: "receipt_query", clientId: lease, id: frame.id });
    const retained = await waitFor(() => client.frames.find(item => item.t === "command_result" && item.id === frame.id), "old-epoch receipt survives reconnect");
    assert.equal(retained.status, "completed");
    assert.equal(retained.epoch, frame.epoch);
  });
  await check("busy mutation rejects while live messages and reconnection survive", async () => {
    assert.equal((await client.command("prompt", { text: "M0_SLOW_M3_LIVE" })).ack.status, "dispatched");
    await waitFor(() => client.snapshot?.state.running, "fixture streaming");
    const busy = await client.command("session_new");
    assert.equal(busy.ack.status, "rejected");
    const lease = client.clientId;
    await client.close(); client = await openClient(fixture.url, lease);
    assert.equal(client.clientId, lease);
    await client.settled("M0_SLOW_M3_LIVE");
    assert.equal(observer.snapshot.session.id, client.snapshot.session.id);
    const currentQuery = await query("files", { query: "greet" });
    assert.ok(currentQuery.files.length);
    assert.equal(client.protocolErrors.length, 0); assert.equal(observer.protocolErrors.length, 0);
  });
  report.status = "passed";
  report.completedAt = new Date().toISOString();
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  if (serve) {
    fixture.command("/name M3 工作台验收");
    await writeFile(join(out, "access.json"), JSON.stringify({ pi: fixture.url }), { mode: 0o600 });
    await writeFile(join(out, "runtime.json"), JSON.stringify({ pid: process.pid, piPort: fixture.port, piVersion: fixture.piVersion, workspace: fixture.cwd, realModelCalls: 0 }, null, 2) + "\n");
    console.log(`READY local workbench preview; ${report.checks.length} checks passed; access.json is private.`);
    await new Promise(() => {});
  }
} catch (error) {
  report.status = "failed";
  report.error = redact(error);
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  if (fixture) {
    await writeFile(join(out, "failure-terminal.log"), redact(fixture.terminal));
    await writeFile(join(out, "failure-events.json"), JSON.stringify(await fixture.events(), null, 2) + "\n");
    await writeFile(join(out, "failure-clients.json"), JSON.stringify({
      client: { snapshot: client?.snapshot, frames: client?.frames.slice(-80), protocolErrors: client?.protocolErrors },
      observer: { snapshot: observer?.snapshot, frames: observer?.frames.slice(-80), protocolErrors: observer?.protocolErrors },
    }, null, 2) + "\n");
  }
  console.error(redact(error));
  process.exitCode = 1;
} finally { await cleanup(); }
