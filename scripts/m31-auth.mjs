#!/usr/bin/env node
/**
 * M3.1 accounts with a real pi TUI, real RPC children and pi's own login code: API-key login from the
 * browser protocol, literal key storage, in-process apply, privacy of steps, logout.
 * Temporary HOME/agent directories, sentinel keys, PI_OFFLINE: nothing is sent to any provider.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { startFixture, openClient, commandResult, workbenchQuery, waitFor } from "./m0-smoke.mjs";

const out = resolve(process.env.PI_M31_REPORT_DIR || "build-artifacts/m3.1/auth");
await mkdir(out, { recursive: true });
const report = { startedAt: new Date().toISOString(), scope: "M31-3 accounts: login, apply, privacy, logout", realTui: true, realModelCalls: 0, providerRequests: 0,
  isolation: "temporary HOME + agent dir, sentinel keys, PI_OFFLINE=1", checks: [], status: "running" };
const fixtures = [], clients = [];
const SENTINEL = "sk-m31-SENTINEL-not-a-real-key-0123456789";
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const exists = path => stat(path).then(() => true, () => false);
async function check(id, name, fn) {
  const started = Date.now();
  try { const details = await fn(); report.checks.push({ id, name, status: "passed", durationMs: Date.now() - started, ...(details ? { details } : {}) }); console.log(`PASS ${id} ${name}`); }
  catch (error) { report.checks.push({ id, name, status: "failed", durationMs: Date.now() - started, error: String(error.stack ?? error).split(SENTINEL).join("[SENTINEL]") }); throw error; }
}
let requestNo = 0;
async function hostQuery(client, action, args = {}) {
  const reqId = `q${++requestNo}`; client.send({ t: "host_query", reqId, action, args });
  const frame = await waitFor(() => client.frames.find(item => item.t === "host_result" && item.reqId === reqId), `host_result ${action}`);
  if (frame.error) throw Object.assign(new Error(frame.error.message), { code: frame.error.code });
  return frame.value;
}
async function hostCommand(client, command, args = {}) {
  const state = client.frames.filter(item => item.t === "host_state").at(-1);
  const commandNo = client.nextCommandNo++; const id = `${client.clientId}:${commandNo}`;
  client.send({ t: "host_command", clientId: client.clientId, commandNo, id, hostRevision: state?.revision ?? 0, command, args });
  const ack = await waitFor(() => client.frames.find(item => item.t === "ack" && item.id === id), `ack ${command}`);
  if (ack.status !== "dispatched") throw Object.assign(new Error(ack.error?.message ?? "rejected"), { code: ack.error?.code });
  const result = await waitFor(() => client.frames.find(item => item.t === "command_result" && item.id === id), `result ${command}`, 40_000);
  if (result.status !== "completed") throw Object.assign(new Error(result.error?.message ?? "failed"), { code: result.error?.code });
  return result.value;
}
const rejects = (promise, code) => assert.rejects(promise, error => { assert.equal(error.code, code, error.message); return true; });
const operationOf = client => client.frames.filter(item => item.t === "account_state").at(-1)?.operation ?? null;
const provider = async (client, id) => (await hostQuery(client, "accounts")).providers.find(item => item.id === id);
/** Begins an API-key login and returns once pi asks for the key. */
async function begin(client, providerId) {
  const { operationId } = await hostCommand(client, "account_begin", { provider: providerId, method: "api_key" });
  const step = await waitFor(() => { const operation = operationOf(client); return operation?.id === operationId && operation.step; }, "key step");
  return { operationId, step };
}
async function login(client, providerId, key) {
  const { operationId, step } = await begin(client, providerId);
  assert.equal(step.kind, "secret");
  client.send({ t: "account_answer", operationId, stepId: step.id, value: key });
  await waitFor(() => { const operation = operationOf(client); return operation?.id === operationId && operation.status !== "running" && operation; }, "login result");
  assert.equal(operationOf(client).status, "saved", JSON.stringify(operationOf(client).error));
}
const applied = client => waitFor(async () => !(await hostQuery(client, "accounts")).pendingApply, "credential applied", 20_000);
async function reply(client, text) {
  const operation = await client.command("prompt", { text, mode: "followUp" }); assert.equal(operation.ack.status, "dispatched", operation.ack.error?.message);
  assert.equal((await commandResult(client, operation.frame)).status, "completed");
  await waitFor(() => client.snapshot?.state.idle && client.snapshot.session.messages.some(message => message.role === "assistant" && JSON.stringify(message.content).includes(`M0_REPLY:${text}:`)), `reply to ${text}`, 30_000);
}

try {
  const fixture = await startFixture({ extraExtensions: ["tests/fixtures/handoff-fixture.ts", "tests/fixtures/m31-probe.ts"] }); fixtures.push(fixture);
  const client = await openClient(fixture.url); clients.push(client);
  const other = await openClient(fixture.url); clients.push(other);
  await waitFor(() => client.snapshot && other.snapshot, "snapshots");
  const authPath = join(fixture.agentDir, "auth.json");
  const stored = async () => JSON.parse(await readFile(authPath, "utf8").catch(() => "{}"));
  const children = async () => (await fixture.events()).filter((item, index, all) => item.event === "m31_session" && item.mode === "rpc" && all.findIndex(entry => entry.event === "m31_session" && entry.mode === "rpc" && entry.pid === item.pid) === index);
  const sessionId = client.snapshot.session.id; const base = await realpath(fixture.directory); const marker = join(base, "EXECUTED_BY_KEY");

  await check("AUTH-01", "the account list shows pi's built-in providers, the fixture's extension provider, and no secret", async () => {
    const view = await hostQuery(client, "accounts");
    assert.ok(view.providers.length > 20); assert.equal(view.pendingApply, false); assert.equal(view.storeError, undefined);
    const openai = view.providers.find(item => item.id === "openai"); assert.equal(openai.stored, undefined); assert.equal(openai.models, 0); assert.ok(openai.knownModels > 0);
    assert.deepEqual(openai.methods.map(method => [method.type, method.web]), [["api_key", true], ["oauth", false]]);
    assert.deepEqual(view.providers.find(item => item.id === "kimi-coding").methods.map(method => [method.type, method.web]), [["api_key", true], ["oauth", true]]);
    const fixtureProvider = view.providers.find(item => item.id === "pi-pane-m0"); assert.ok(fixtureProvider.models > 0); assert.equal(fixtureProvider.methods[0].reason, "extension");
    assert.equal(view.providers[0].id, "pi-pane-m0", "usable providers come first");
    await rejects(hostCommand(client, "account_begin", { provider: "pi-pane-m0", method: "api_key" }), "unknown_provider");
    await rejects(hostCommand(client, "account_begin", { provider: "openai", method: "oauth" }), "unsupported_method");
    await rejects(hostCommand(client, "account_logout", { provider: "openai" }), "not_stored");
    return { providers: view.providers.length };
  });
  await check("AUTH-02", "a key entered through the browser protocol is saved by pi's own login and applied in process", async () => {
    const before = (await children()).length;
    const { operationId, step } = await begin(client, "openai");
    // Another signed-in page: knows a login is running, sees no step, cannot answer, cannot start another.
    const seen = await waitFor(() => operationOf(other), "other viewer state");
    assert.equal(seen.owner, false); assert.equal(seen.step, undefined); assert.equal(seen.notices, undefined);
    other.send({ t: "account_answer", operationId, stepId: step.id, value: "sk-from-the-wrong-page" });
    const refused = await waitFor(() => other.frames.find(item => item.t === "account_error"), "refusal"); assert.equal(refused.error.code, "not_owner");
    await rejects(hostCommand(other, "account_begin", { provider: "anthropic", method: "api_key" }), "account_busy");
    await reply(client, "M31_WHILE_LOGGING_IN"); // a pending login does not block the conversation
    client.send({ t: "account_answer", operationId, stepId: step.id, value: SENTINEL });
    await waitFor(() => operationOf(client)?.status === "saved", "saved"); await applied(client);
    const openai = await provider(client, "openai"); assert.equal(openai.stored, "api_key"); assert.ok(openai.models > 0);
    assert.ok((await workbenchQuery(client, "resources")).models.some(model => model.provider === "openai"), "the model picker offers the provider");
    assert.equal((await children()).length, before, "no child was restarted"); assert.equal(client.snapshot.session.id, sessionId);
    assert.ok(client.snapshot.session.messages.some(message => JSON.stringify(message.content).includes("M31_WHILE_LOGGING_IN")), "history kept");
    assert.equal(client.snapshot.state.model?.id, "deterministic", "the current model is unchanged");
    assert.equal((await stored()).openai.key, SENTINEL); assert.equal((await stat(authPath)).mode & 0o777, 0o600);
    assert.equal(operationOf(other), null);
    return { models: openai.models };
  });
  await check("AUTH-03", "a key that would be a shell command is stored literally and never runs, in the host or in the child", async () => {
    await login(client, "anthropic", `!touch ${marker}`); await applied(client);
    assert.equal((await stored()).anthropic.key, `$!touch ${marker}`);
    assert.ok((await provider(client, "anthropic")).models > 0, "the child resolved the key (as text) and offers the provider");
    await login(client, "google", "$HOME-${PATH}-$$"); await applied(client);
    assert.equal((await stored()).google.key, "$$HOME-$${PATH}-$$$$");
    await reply(client, "M31_AFTER_LITERAL_KEYS");
    assert.equal(await exists(marker), false, "the command was not executed");
    assert.equal((await stored()).openai.key, SENTINEL, "other providers are untouched");
  });
  await check("AUTH-04", "a credential saved while pi is replying waits; it is applied only when asked, once idle", async () => {
    const slow = await client.command("prompt", { text: "M0_SLOW_M31_AUTH", mode: "followUp" }); assert.equal(slow.ack.status, "dispatched");
    await waitFor(() => client.snapshot?.state.running, "running reply");
    await login(client, "deepseek", "sk-m31-while-busy");
    let view = await hostQuery(client, "accounts"); assert.equal(view.pendingApply, true); assert.equal(view.providers.find(item => item.id === "deepseek").models, 0);
    await rejects(hostCommand(other, "account_apply"), "busy");
    await waitFor(() => client.snapshot?.state.idle && !client.snapshot.state.running, "reply settled", 30_000);
    assert.ok(client.snapshot.session.messages.some(message => JSON.stringify(message.content).includes("M0_REPLY:M0_SLOW_M31_AUTH:")), "the reply was not interrupted");
    assert.equal((await hostQuery(client, "accounts")).pendingApply, true, "the end of the reply did not apply it");
    await hostCommand(other, "account_apply"); view = await hostQuery(client, "accounts");
    assert.equal(view.pendingApply, false); assert.ok(view.providers.find(item => item.id === "deepseek").models > 0);
  });
  await check("AUTH-05", "a login outlives its page: the same lease reconnects to the pending step, and another page can cancel", async () => {
    const { operationId, step } = await begin(client, "mistral");
    const lease = client.clientId; await client.close();
    const back = await openClient(fixture.url, lease); clients.push(back);
    const resumed = await waitFor(() => operationOf(back), "step after reconnect");
    assert.equal(resumed.id, operationId); assert.equal(resumed.step.id, step.id); assert.equal(resumed.owner, true);
    back.send({ t: "account_answer", operationId, stepId: step.id, value: "sk-m31-after-reconnect" });
    await waitFor(() => operationOf(back)?.status === "saved", "saved after reconnect"); await applied(back);
    assert.ok((await provider(back, "mistral")).models > 0);
    const second = await begin(back, "groq");
    await hostCommand(other, "account_cancel", { operationId: second.operationId });
    const cancelled = await waitFor(() => operationOf(back)?.status === "cancelled" && operationOf(back), "cancelled by the other page");
    assert.equal(cancelled.error.code, "cancelled"); assert.equal((await stored()).groq, undefined);
    back.send({ t: "account_answer", operationId: second.operationId, stepId: second.step.id, value: "sk-too-late" });
    const late = await waitFor(() => back.frames.find(item => item.t === "account_error" && item.operationId === second.operationId), "late answer refused");
    assert.equal(late.error.code, "operation_closed"); assert.equal((await stored()).groq, undefined);
    clients[0] = back;
  });
  const main = clients[0];
  await check("AUTH-06", "signing out removes only pi's stored entry and the session stops offering that provider", async () => {
    assert.deepEqual(await hostCommand(main, "account_logout", { provider: "openai" }), { pendingApply: true }); await applied(main);
    const openai = await provider(main, "openai"); assert.equal(openai.stored, undefined); assert.equal(openai.models, 0);
    const file = await stored(); assert.equal(file.openai, undefined); assert.equal(file.anthropic.key, `$!touch ${marker}`); assert.equal(file.mistral.key, "sk-m31-after-reconnect");
    assert.equal(main.snapshot.session.id, sessionId); await reply(main, "M31_AFTER_LOGOUT");
  });
  await check("AUTH-07", "in an unsaved session the credential is applied by a new session, with no child restart", async () => {
    const empty = join(base, "empty"); await mkdir(empty);
    await hostCommand(main, "project_open", { path: empty }); await waitFor(() => main.snapshot?.session.cwd === empty, "empty project");
    const count = (await children()).length; const before = main.snapshot.session.id;
    await login(main, "xai", "sk-m31-unsaved"); await applied(main);
    assert.ok((await provider(main, "xai")).models > 0); assert.equal((await children()).length, count);
    await waitFor(() => main.snapshot?.session.id && main.snapshot.session.id !== before, "new unsaved session"); assert.equal(main.snapshot.session.cwd, empty);
    assert.deepEqual(main.snapshot.session.messages, []);
  });
  await check("AUTH-08", "no key appears in anything a browser receives, in the terminal, in fixture events or in session files", async () => {
    const secrets = [SENTINEL, "sk-m31-while-busy", "sk-m31-after-reconnect", "sk-m31-unsaved", "sk-from-the-wrong-page", "sk-too-late", `touch ${marker}`];
    const haystacks = { frames: JSON.stringify(clients.flatMap(item => item.frames)), terminal: fixture.terminal, events: JSON.stringify(await fixture.events()), stderr: fixture.processError };
    const sessionDir = join(fixture.agentDir, "sessions");
    for (const name of await readdir(sessionDir, { recursive: true })) if (name.endsWith(".jsonl")) haystacks[`session:${name}`] = await readFile(join(sessionDir, name), "utf8");
    haystacks.registry = await readFile(join(fixture.agentDir, "pi-pane", "projects.json"), "utf8").catch(() => "");
    for (const [where, text] of Object.entries(haystacks)) for (const secret of secrets) assert.ok(!text.includes(secret), `a key appears in ${where}`);
    await rejects((async () => { const operation = await main.command("prompt", { text: "/login" }); if (operation.ack.status !== "dispatched") throw Object.assign(new Error("rejected"), { code: operation.ack.error?.code }); const result = await commandResult(main, operation.frame); if (result.status !== "completed") throw Object.assign(new Error("failed"), { code: result.error?.code }); })(), "picker_required");
    return { searched: Object.keys(haystacks).length };
  });
  await check("AUTH-09", "Ctrl+C during a login stops the service and saves nothing for that login", async () => {
    await begin(main, "groq");
    const list = await children();
    fixture.write("\u0003"); await waitFor(() => fixture.exitCode !== undefined, "Ctrl+C stop", 20_000);
    assert.equal(fixture.exitCode, 0); for (const item of list) await waitFor(() => !alive(item.pid), `child ${item.pid} exited`);
    assert.equal((await stored()).groq, undefined); assert.equal(await exists(marker), false);
  });
  report.status = "passed";
} catch (error) { report.status = "failed"; report.error = String(error.stack ?? error).split(SENTINEL).join("[SENTINEL]"); process.exitCode = 1; console.error(report.error); }
finally {
  for (const client of clients) await client.close().catch(() => {});
  for (const fixture of fixtures) { await fixture.close().catch(() => {}); await fixture.remove().catch(() => {}); }
  report.finishedAt = new Date().toISOString();
  await writeFile(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.status.toUpperCase()} — ${report.checks.filter(item => item.status === "passed").length}/${report.checks.length} checks; report: ${join(out, "report.json")}`);
}
