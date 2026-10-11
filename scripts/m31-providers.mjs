#!/usr/bin/env node
/**
 * M3.1 custom providers and session extras with a real pi TUI and real RPC children.
 * A loopback stand-in for an OpenAI-compatible endpoint answers the one model request, so a custom
 * provider is exercised end to end without any real provider. Temporary HOME/agent directories,
 * sentinel keys, a stand-in `trash` command that stays inside the fixture, PI_OFFLINE.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmod, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { startFixture, openClient, commandResult, workbenchQuery, waitFor } from "./m0-smoke.mjs";
import { SessionFileLock } from "../src/extension/session-lock.ts";

const out = resolve(process.env.PI_M31_REPORT_DIR || "build-artifacts/m3.1/providers");
await mkdir(out, { recursive: true });
const report = { startedAt: new Date().toISOString(), scope: "M31-4b custom providers and session extras", realTui: true, realModelCalls: 0, providerRequests: 0,
  isolation: "temporary HOME + agent dir, loopback stand-in endpoint, sentinel keys, stand-in trash, PI_OFFLINE=1", checks: [], status: "running" };
const fixtures = [], clients = [];
const exists = path => stat(path).then(() => true, () => false);
async function check(id, name, fn) {
  const started = Date.now();
  try { const details = await fn(); report.checks.push({ id, name, status: "passed", durationMs: Date.now() - started, ...(details ? { details } : {}) }); console.log(`PASS ${id} ${name}`); }
  catch (error) { report.checks.push({ id, name, status: "failed", durationMs: Date.now() - started, error: String(error.stack ?? error) }); throw error; }
}
let requestNo = 0;
async function hostQuery(client, action, args = {}) {
  const reqId = `q${++requestNo}`; client.send({ t: "host_query", reqId, action, args });
  const frame = await waitFor(() => client.frames.find(item => item.t === "host_result" && item.reqId === reqId), `host_result ${action}`);
  if (frame.error) throw Object.assign(new Error(frame.error.message), { code: frame.error.code, field: frame.error.field });
  return frame.value;
}
async function hostCommand(client, command, args = {}) {
  const state = client.frames.filter(item => item.t === "host_state").at(-1);
  const commandNo = client.nextCommandNo++; const id = `${client.clientId}:${commandNo}`;
  client.send({ t: "host_command", clientId: client.clientId, commandNo, id, hostRevision: state?.revision ?? 0, command, args });
  const ack = await waitFor(() => client.frames.find(item => item.t === "ack" && item.id === id), `ack ${command}`);
  if (ack.status !== "dispatched") throw Object.assign(new Error(ack.error?.message ?? "rejected"), { code: ack.error?.code });
  const result = await waitFor(() => client.frames.find(item => item.t === "command_result" && item.id === id), `result ${command}`, 60_000);
  if (result.status !== "completed") throw Object.assign(new Error(result.error?.message ?? "failed"), { code: result.error?.code, field: result.error?.field });
  return result.value;
}
const rejects = (promise, code) => assert.rejects(promise, error => { assert.equal(error.code, code, error.message); return true; });
async function run(client, command, args = {}) {
  const operation = await client.command(command, args); assert.equal(operation.ack.status, "dispatched", operation.ack.error?.message);
  const result = await commandResult(client, operation.frame); assert.equal(result.status, "completed", result.error?.message); return result;
}
const settled = client => waitFor(() => client.snapshot?.state.idle && !client.snapshot.state.running, "settled", 30_000);
const applied = client => waitFor(async () => !(await hostQuery(client, "providers")).pendingApply, "applied", 20_000);
const operationOf = client => client.frames.filter(item => item.t === "account_state").at(-1)?.operation ?? null;
async function setKey(client, provider, key) {
  const { operationId } = await hostCommand(client, "account_begin", { provider, method: "api_key" });
  const step = await waitFor(() => { const operation = operationOf(client); return operation?.id === operationId && operation.step; }, "key step");
  assert.equal(step.kind, "secret");
  client.send({ t: "account_answer", operationId, stepId: step.id, value: key });
  await waitFor(() => { const operation = operationOf(client); return operation?.id === operationId && operation.status !== "running"; }, "login result");
  assert.equal(operationOf(client).status, "saved", JSON.stringify(operationOf(client).error));
}

// A stand-in for an OpenAI-compatible endpoint on loopback. It records what it was sent and answers once per request.
const requests = [];
const endpoint = createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    let parsed; try { parsed = JSON.parse(body); } catch { parsed = undefined; }
    requests.push({ url: request.url, authorization: request.headers.authorization, team: request.headers["x-team"], model: parsed?.model });
    const text = `M31_CUSTOM_REPLY:${parsed?.model}`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "m31", object: "chat.completion.chunk", model: parsed?.model, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: "m31", object: "chat.completion.chunk", model: parsed?.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
});
await new Promise(done => endpoint.listen(0, "127.0.0.1", done));
const baseUrl = `http://127.0.0.1:${endpoint.address().port}/v1`;

try {
  let trashDir;
  const fixture = await startFixture({ extraExtensions: ["tests/fixtures/handoff-fixture.ts", "tests/fixtures/m31-probe.ts"],
    prependPath: async directory => {
      // `trash` as pi and pi-pane call it, kept inside the fixture: nothing reaches the real system trash.
      const bin = join(directory, "bin"); trashDir = join(directory, "trash"); await mkdir(bin); await mkdir(trashDir);
      await writeFile(join(bin, "trash"), `#!/bin/sh\n[ -f "${trashDir}/UNAVAILABLE" ] && exit 1\n[ "$1" = "--" ] && shift\nexec mv -- "$1" "${trashDir}/"\n`); await chmod(join(bin, "trash"), 0o755);
      return bin;
    } });
  fixtures.push(fixture);
  const client = await openClient(fixture.url); clients.push(client);
  const other = await openClient(fixture.url); clients.push(other);
  await waitFor(() => client.snapshot && other.snapshot, "snapshots");
  const base = await realpath(fixture.directory), agentDir = await realpath(fixture.agentDir);
  const modelsPath = join(agentDir, "models.json"), authPath = join(agentDir, "auth.json");
  const models = async () => JSON.parse(await readFile(modelsPath, "utf8"));
  const children = async () => (await fixture.events()).filter((entry, index, all) => entry.event === "m31_session" && entry.mode === "rpc" && all.findIndex(item => item.event === "m31_session" && item.mode === "rpc" && item.pid === entry.pid) === index);
  const marker = join(base, "EXECUTED_BY_KEY"), KEY = `!touch ${marker} $HOME`;
  const firstSession = client.snapshot.session.id;
  const provider = (extra = {}) => ({ id: "m31-local", api: "openai-completions", baseUrl, models: [{ id: "m31-echo", name: "Echo", contextWindow: 32000 }], create: true, ...extra });

  await check("PROV-01", "a provider added from the browser is written alone into models.json, gets its key through pi's login, and answers a request without a restart", async () => {
    const before = (await children()).length;
    let view = await hostQuery(client, "providers"); assert.deepEqual([view.providers, view.revision, view.pendingApply], [[], "absent", false]);
    const saved = await hostCommand(client, "provider_save", provider({ revision: view.revision }));
    assert.deepEqual(await models(), { providers: { "m31-local": { baseUrl, api: "openai-completions", models: [{ id: "m31-echo", name: "Echo", contextWindow: 32000 }] } } });
    assert.equal((await stat(modelsPath)).mode & 0o777, 0o600); await applied(client);
    view = await hostQuery(client, "providers"); assert.equal(view.revision, saved.revision);
    assert.deepEqual([view.providers[0].key, view.providers[0].available, view.providers[0].insecure, view.providers[0].overlay], ["none", 0, false, false]);
    await setKey(client, "m31-local", KEY);
    await waitFor(async () => (await hostQuery(client, "providers")).providers[0].available === 1, "the model is offered", 20_000);
    assert.equal((await hostQuery(other, "providers")).providers[0].key, "stored");
    assert.ok((await workbenchQuery(client, "resources")).models.some(model => model.provider === "m31-local" && model.id === "m31-echo"), "the model is in the selector");
    await run(client, "set_model", { provider: "m31-local", id: "m31-echo" });
    await waitFor(() => client.snapshot?.state.model?.provider === "m31-local", "model selected");
    await run(client, "prompt", { text: "M31_TO_CUSTOM", mode: "followUp" });
    await waitFor(() => client.snapshot?.state.idle && client.snapshot.session.messages.some(message => JSON.stringify(message.content).includes("M31_CUSTOM_REPLY:m31-echo")), "the custom endpoint's reply", 30_000);
    assert.equal(requests.length, 1); assert.equal(requests[0].url, "/v1/chat/completions"); assert.equal(requests[0].model, "m31-echo");
    // pi sent the key exactly as typed: it was stored as a literal, not run and not expanded.
    assert.equal(requests[0].authorization, `Bearer ${KEY}`); assert.equal(await exists(marker), false);
    assert.equal(JSON.parse(await readFile(authPath, "utf8"))["m31-local"].type, "api_key"); assert.equal(JSON.stringify(await models()).includes("touch"), false, "the key is not in models.json");
    assert.equal((await children()).length, before, "no child was restarted"); assert.equal(client.snapshot.session.id, firstSession);
    report.providerRequests = requests.length;
    return { endpointRequests: requests.length };
  });
  await check("PROV-02", "editing keeps headers, model settings, unknown keys and other providers that the form does not show", async () => {
    const raw = await models();
    Object.assign(raw.providers["m31-local"], { headers: { "x-team": "m31-team" }, futureField: { keep: 1 } });
    raw.providers["m31-local"].models[0].input = ["text"];
    raw.providers["m31-scripted"] = { baseUrl: "http://127.0.0.1:9/v1", api: "anthropic-messages", apiKey: `!touch ${marker}`, models: [{ id: "never-called" }] };
    raw.topLevelUnknown = [1, 2, 3];
    await writeFile(modelsPath, JSON.stringify(raw, null, 2));
    let view = await hostQuery(client, "providers");
    const mine = view.providers.find(item => item.id === "m31-local"), scripted = view.providers.find(item => item.id === "m31-scripted");
    assert.deepEqual([mine.extra, mine.modelExtras, scripted.key], [["headers", "futureField"], 1, "file_command"]);
    await hostCommand(client, "provider_save", provider({ create: false, models: [{ id: "m31-echo", contextWindow: 64000 }, { id: "m31-second" }], revision: view.revision }));
    const after = await models();
    assert.deepEqual(after.providers["m31-local"], { baseUrl, api: "openai-completions", models: [{ id: "m31-echo", contextWindow: 64000, input: ["text"] }, { id: "m31-second" }], headers: { "x-team": "m31-team" }, futureField: { keep: 1 } });
    assert.deepEqual(after.providers["m31-scripted"], raw.providers["m31-scripted"]); assert.deepEqual(after.topLevelUnknown, [1, 2, 3]);
    await applied(client);
    await waitFor(async () => (await hostQuery(client, "providers")).providers.find(item => item.id === "m31-local").available === 2, "second model offered", 20_000);
    // The header kept in the file is what pi sends.
    await run(client, "prompt", { text: "M31_TO_CUSTOM_AGAIN", mode: "followUp" }); await settled(client);
    assert.equal(requests.at(-1).team, "m31-team"); assert.equal(requests.at(-1).authorization, `Bearer ${KEY}`);
  });
  await check("PROV-03", "keys: the typed key appears nowhere but pi's auth file; a command already in models.json is reported by kind and never run", async () => {
    const view = await hostQuery(client, "providers"), wire = JSON.stringify(view);
    assert.equal(wire.includes("touch"), false); assert.equal(wire.includes(marker), false);
    const accounts = await hostQuery(client, "accounts");
    assert.deepEqual(accounts.providers.find(item => item.id === "m31-local"), { id: "m31-local", name: "m31-local", methods: [{ type: "api_key", label: "API key", web: true }], stored: "api_key", models: 2, knownModels: 2, custom: true });
    const haystacks = { frames: JSON.stringify(clients.flatMap(item => item.frames)), terminal: fixture.terminal, events: JSON.stringify(await fixture.events()), models: await readFile(modelsPath, "utf8") };
    const sessionDir = join(agentDir, "sessions");
    for (const name of await readdir(sessionDir, { recursive: true })) if (name.endsWith(".jsonl")) haystacks[`session:${name}`] = await readFile(join(sessionDir, name), "utf8");
    // models.json legitimately holds the scripted provider's own command; the typed key must not be there or anywhere else.
    for (const [where, text] of Object.entries(haystacks)) assert.ok(!text.includes("$HOME"), `the typed key appears in ${where}`);
    for (const where of ["frames", "terminal", "events"]) assert.ok(!haystacks[where].includes(marker), `a key command appears in ${where}`);
    assert.equal(await exists(marker), false, "nothing was executed");
  });
  await check("PROV-04", "a stale view and a broken models.json change nothing", async () => {
    const view = await hostQuery(client, "providers"), text = await readFile(modelsPath, "utf8");
    await writeFile(modelsPath, text.replace("m31-team", "m31-team-2"));
    await rejects(hostCommand(other, "provider_save", provider({ create: false, revision: view.revision })), "stale_providers");
    await rejects(hostCommand(other, "provider_remove", { id: "m31-local", revision: view.revision }), "stale_providers");
    assert.ok((await readFile(modelsPath, "utf8")).includes("m31-team-2"));
    const good = await readFile(modelsPath, "utf8");
    await writeFile(modelsPath, "{ \"providers\": ");
    const broken = await hostQuery(client, "providers"); assert.deepEqual(broken.providers, []); assert.ok(broken.error);
    await rejects(hostCommand(client, "provider_save", provider({ id: "m31-new", revision: broken.revision })), "providers_unreadable");
    assert.equal(await readFile(modelsPath, "utf8"), "{ \"providers\": ");
    assert.ok((await hostQuery(client, "accounts")).providers.length > 20, "the account list still works");
    await writeFile(modelsPath, good);
  });
  await check("PROV-05/07", "names pi already uses and invalid fields are refused with the field; an http address to another machine is flagged", async () => {
    const view = await hostQuery(client, "providers");
    const refused = async (extra, code, field) => assert.rejects(hostCommand(client, "provider_save", provider({ id: "m31-x", revision: view.revision, ...extra })), error => { assert.equal(error.code, code, error.message); assert.equal(error.field, field); return true; });
    await refused({ id: "openai" }, "provider_name_taken", "id"); await refused({ id: "pi-pane-m0" }, "provider_name_taken", "id"); await refused({ id: "m31-local" }, "provider_exists", "id");
    await refused({ baseUrl: "file:///etc/passwd" }, "invalid_provider", "baseUrl"); await refused({ baseUrl: "https://user:pw@example.invalid/v1" }, "invalid_provider", "baseUrl");
    await refused({ models: [] }, "invalid_provider", "models"); await refused({ models: [{ id: "a", contextWindow: 0 }] }, "invalid_provider", "models.0.contextWindow");
    await refused({ api: "made-up" }, "invalid_provider", "api");
    const lan = await hostCommand(client, "provider_save", provider({ id: "m31-lan", baseUrl: "http://192.0.2.10:8000/v1", revision: view.revision }));
    assert.equal(lan.insecure, true); await applied(client);
    const after = await hostQuery(client, "providers"); assert.equal(after.providers.find(item => item.id === "m31-lan").insecure, true);
    await hostCommand(client, "provider_remove", { id: "m31-lan", revision: after.revision }); await applied(client);
  });
  await check("PROV-06", "a provider saved while pi is replying waits; the reply is not interrupted", async () => {
    await run(client, "set_model", { provider: "pi-pane-m0", id: "deterministic" });
    await waitFor(() => client.snapshot?.state.model?.provider === "pi-pane-m0", "back on the fixture model");
    const slow = await client.command("prompt", { text: "M0_SLOW_M31_PROVIDERS", mode: "followUp" }); assert.equal(slow.ack.status, "dispatched");
    await waitFor(() => client.snapshot?.state.running, "running reply");
    const view = await hostQuery(client, "providers");
    await hostCommand(other, "provider_save", provider({ id: "m31-busy", revision: view.revision }));
    assert.equal((await hostQuery(client, "providers")).pendingApply, true); await rejects(hostCommand(other, "account_apply"), "busy");
    await settled(client);
    assert.ok(client.snapshot.session.messages.some(message => JSON.stringify(message.content).includes("M0_REPLY:M0_SLOW_M31_PROVIDERS:")));
    assert.equal((await hostQuery(client, "providers")).pendingApply, true, "the end of the reply did not apply it");
    await hostCommand(other, "account_apply"); assert.equal((await hostQuery(client, "providers")).pendingApply, false);
  });
  await check("PROV-05", "removing the provider the session is using removes its key too, and the page is told the model changed", async () => {
    await run(client, "set_model", { provider: "m31-local", id: "m31-echo" });
    await waitFor(() => client.snapshot?.state.model?.provider === "m31-local", "custom model selected");
    const view = await hostQuery(client, "providers"), mine = view.providers.find(item => item.id === "m31-local");
    assert.deepEqual([mine.inUse, mine.key, mine.models.length], [true, "stored", 2]);
    const from = client.frames.length;
    const removed = await hostCommand(client, "provider_remove", { id: "m31-local", revision: view.revision });
    assert.equal(removed.credentialRemoved, true); assert.equal(JSON.parse(await readFile(authPath, "utf8"))["m31-local"], undefined);
    assert.equal((await models()).providers["m31-local"], undefined); await applied(client);
    await waitFor(() => client.snapshot && client.snapshot.state.model?.provider !== "m31-local", "the session no longer uses the removed model", 20_000);
    const notice = client.frames.slice(from).find(item => item.t === "notice");
    assert.ok(notice && notice.message.includes("m31-local"), "a notice names the model that is gone");
    assert.equal((await hostQuery(client, "accounts")).providers.some(item => item.id === "m31-local"), false);
    await rejects(hostCommand(client, "account_begin", { provider: "m31-local", method: "api_key" }), "unknown_provider");
    const count = requests.length; await run(client, "prompt", { text: "M31_AFTER_REMOVAL", mode: "followUp" }); await settled(client);
    assert.equal(requests.length, count, "nothing more is sent to the removed endpoint");
    return { modelAfterRemoval: `${client.snapshot.state.model?.provider}/${client.snapshot.state.model?.id}` };
  });

  let deletable, deletablePath;
  await check("SES-05", "session numbers come from pi and move with each turn; reply text is what pi's /copy gives", async () => {
    const stats = await workbenchQuery(client, "session_stats");
    assert.equal(stats.sessionId, client.snapshot.session.id); assert.ok(stats.sessionFile.endsWith(".jsonl")); assert.ok(stats.totalMessages >= 8);
    assert.equal(stats.userMessages + stats.assistantMessages + stats.toolResults <= stats.totalMessages, true);
    assert.ok(stats.context && stats.context.window > 0);
    await run(client, "prompt", { text: "M31_STATS_TURN", mode: "followUp" });
    await waitFor(() => client.snapshot?.state.idle && client.assistants("M31_STATS_TURN").length, "reply", 30_000);
    const after = await workbenchQuery(client, "session_stats");
    assert.equal(after.userMessages, stats.userMessages + 1); assert.equal(after.assistantMessages, stats.assistantMessages + 1);
    const last = await workbenchQuery(client, "assistant_text");
    assert.ok(last.text.startsWith("M0_REPLY:M31_STATS_TURN:")); assert.equal(last.truncated, false);
    const message = client.snapshot.session.messages.filter(item => item.role === "assistant" && item.entryId).at(-2);
    const one = await workbenchQuery(client, "assistant_text", { entryId: message.entryId });
    assert.equal(one.text, message.content.filter(block => block.type === "text").map(block => block.text).join("").trim());
    const user = client.snapshot.session.messages.find(item => item.role === "user" && item.entryId);
    await rejects(workbenchQuery(client, "assistant_text", { entryId: user.entryId }), "unknown_message");
    return { totalMessages: after.totalMessages, tokens: after.tokens.total };
  });
  await check("SES-03", "export: pi writes the HTML into pi-pane's export directory, never the project, and the browser reads the same bytes", async () => {
    const project = await readdir(fixture.cwd);
    const result = await hostCommand(client, "session_export");
    assert.equal(result.path, join(agentDir, "pi-pane", "exports", result.name)); assert.equal(result.downloadable, true);
    const file = await readFile(result.path); assert.equal(file.length, result.bytes); // pi embeds the session as base64 JSON in the page: find a block that decodes to this conversation.
    const html = file.toString("utf8"); assert.ok(/^<!doctype html>/i.test(html.trimStart()));
    const embedded = (html.match(/[A-Za-z0-9+/=]{2000,}/g) ?? []).map(block => Buffer.from(block, "base64").toString("utf8"));
    assert.ok(embedded.some(text => text.includes("M31_STATS_TURN")), "the export holds the conversation");
    const parts = []; for (let offset = 0; offset !== undefined;) { const page = await hostQuery(client, "export_page", { exportId: result.exportId, offset }); parts.push(Buffer.from(page.data, "base64")); offset = page.next; }
    assert.ok(Buffer.concat(parts).equals(file));
    assert.deepEqual(await readdir(fixture.cwd), project, "nothing was written into the project directory");
    await rejects(hostQuery(client, "export_page", { exportId: "00000000-0000-0000-0000-000000000000", offset: 0 }), "export_missing");
    assert.equal(JSON.stringify(clients.flatMap(item => item.frames).filter(frame => frame.t !== "host_result" && frame.t !== "command_result")).includes(result.path), false, "the export path goes only to the page that asked");
    return { bytes: result.bytes, parts: parts.length };
  });
  await check("SES-01", "deleting a saved session that is not open: it is identified first, moved to the trash, and leaves the listings", async () => {
    await run(client, "session_new"); await waitFor(() => client.snapshot && client.snapshot.session.id !== firstSession, "new session", 20_000);
    deletable = client.snapshot.session.id;
    await run(client, "prompt", { text: "M31_TO_DELETE", mode: "followUp" });
    await waitFor(() => client.snapshot?.state.idle && client.assistants("M31_TO_DELETE").length, "reply in the session to delete", 30_000);
    await run(client, "session_rename", { name: "M31 deletable" });
    deletablePath = (await workbenchQuery(client, "session_stats")).sessionFile;
    await workbenchQuery(client, "sessions", { scope: "workspace" });
    await rejects(hostCommand(client, "session_delete", { sessionId: deletable }), "session_current");
    await run(client, "session_switch", { sessionId: firstSession }); await waitFor(() => client.snapshot?.session.id === firstSession, "back on the first session", 20_000);
    const listed = await workbenchQuery(client, "sessions", { scope: "workspace" }); assert.ok(listed.sessions.some(item => item.id === deletable));
    const view = await hostQuery(client, "session_inspect", { sessionId: deletable });
    assert.deepEqual([view.name, view.cwd, view.path, view.current, view.locked, view.trash], ["M31 deletable", fixture.cwd, await realpath(deletablePath), false, false, true]);
    assert.ok(view.messageCount >= 2);
    assert.deepEqual(await hostCommand(client, "session_delete", { sessionId: deletable }), { id: deletable, method: "trash" });
    assert.equal(await exists(deletablePath), false); assert.equal((await readdir(trashDir)).length, 1, "it is in the trash, not gone");
    assert.equal((await workbenchQuery(client, "sessions", { scope: "all" })).sessions.some(item => item.id === deletable), false);
    assert.equal((await readdir(join(deletablePath, ".."))).some(name => name.includes(".pi-pane.lock") && name.includes(deletable)), false, "no lock file is left for it");
    await rejects(hostCommand(client, "session_delete", { sessionId: deletable }), "unknown_session");
    assert.equal(client.snapshot.session.id, firstSession); await run(client, "prompt", { text: "M31_AFTER_DELETE", mode: "followUp" }); await settled(client);
  });
  await check("SES-02", "the open session, a session another service holds and an ID that was never listed are refused; without a trash the result says permanent", async () => {
    await rejects(hostCommand(client, "session_delete", { sessionId: firstSession }), "session_current");
    await rejects(hostCommand(client, "session_delete", { sessionId: "../../../etc/passwd" }), "unknown_session");
    await rejects(hostQuery(client, "session_inspect", { sessionId: "never-listed" }), "unknown_session");
    await run(client, "session_new"); await waitFor(() => client.snapshot && client.snapshot.session.id !== firstSession, "another session", 20_000);
    const second = client.snapshot.session.id;
    await run(client, "prompt", { text: "M31_SECOND", mode: "followUp" }); await waitFor(() => client.snapshot?.state.idle && client.assistants("M31_SECOND").length, "reply", 30_000);
    const path = (await workbenchQuery(client, "session_stats")).sessionFile;
    await run(client, "session_switch", { sessionId: firstSession }); await waitFor(() => client.snapshot?.session.id === firstSession, "back", 20_000);
    await workbenchQuery(client, "sessions", { scope: "workspace" });
    const held = await SessionFileLock.acquire(path); // another /web service on this machine
    try {
      assert.equal((await hostQuery(client, "session_inspect", { sessionId: second })).locked, true);
      await rejects(hostCommand(client, "session_delete", { sessionId: second }), "session_locked"); assert.equal(await exists(path), true);
    } finally { await held.release(); }
    await writeFile(join(trashDir, "UNAVAILABLE"), "");
    assert.equal((await hostQuery(client, "session_inspect", { sessionId: second })).trash, true, "the command exists; whether it works is only known by trying");
    assert.deepEqual(await hostCommand(client, "session_delete", { sessionId: second }), { id: second, method: "deleted" });
    assert.equal(await exists(path), false); assert.equal((await readdir(trashDir)).filter(name => name.endsWith(".jsonl")).length, 1);
  });
  await check("SES-06", "/export, /copy and /session are handled by the page and never sent to the model", async () => {
    const commands = (await workbenchQuery(client, "commands")).commands;
    assert.deepEqual(["session", "export", "copy"].map(name => commands.find(item => item.name === name)?.browserAction), ["status", "export", "copy"]);
    const before = (await fixture.events()).filter(entry => entry.event === "provider_call").length;
    for (const text of ["/export", "/copy", "/session"])
      await rejects((async () => { const operation = await client.command("prompt", { text }); if (operation.ack.status !== "dispatched") throw Object.assign(new Error("rejected"), { code: operation.ack.error?.code }); const result = await commandResult(client, operation.frame); if (result.status !== "completed") throw Object.assign(new Error("failed"), { code: result.error?.code }); })(), "picker_required");
    assert.equal((await fixture.events()).filter(entry => entry.event === "provider_call").length, before);
  });
  report.status = "passed";
} catch (error) { report.status = "failed"; report.error = String(error.stack ?? error); process.exitCode = 1; console.error(report.error); }
finally {
  for (const client of clients) await client.close().catch(() => {});
  for (const fixture of fixtures) { await fixture.close().catch(() => {}); await fixture.remove().catch(() => {}); }
  await new Promise(done => endpoint.close(done));
  report.finishedAt = new Date().toISOString();
  await writeFile(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.status.toUpperCase()} — ${report.checks.filter(item => item.status === "passed").length}/${report.checks.length} checks; report: ${join(out, "report.json")}`);
}
