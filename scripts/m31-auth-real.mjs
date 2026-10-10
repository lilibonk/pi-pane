#!/usr/bin/env node
/**
 * Opt-in real-provider trial of the browser login: key entry → saved → applied → one real reply → logout.
 * Runs only with an explicitly authorized credential file. The key is read from that file inside this
 * process, sent once over the loopback connection, and never printed or written to the report. The
 * authorized file is not modified; the trial uses a temporary HOME and agent directory that are removed.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { startFixture, openClient, commandResult, workbenchQuery, waitFor } from "./m0-smoke.mjs";

const source = process.env.PI_PANE_REAL_AUTH_SOURCE?.trim();
const providerId = process.env.PI_PANE_REAL_PROVIDER?.trim();
const modelId = process.env.PI_PANE_REAL_MODEL?.trim();
if (!source || !providerId || !modelId) {
  console.error("Real login trial is disabled. Set PI_PANE_REAL_AUTH_SOURCE (an auth.json you are explicitly authorized to use), PI_PANE_REAL_PROVIDER and PI_PANE_REAL_MODEL.");
  process.exit(2);
}
const out = resolve(process.env.PI_M31_REPORT_DIR || "build-artifacts/m3.1/auth-real");
await mkdir(out, { recursive: true });
const report = { startedAt: new Date().toISOString(), scope: "M31-AUTH-19: browser key login → apply → real reply → logout", provider: providerId, model: modelId,
  realTui: true, realModelCalls: 0, authorization: "explicitly authorized existing credential; value never printed or stored outside the temporary agent directory",
  isolation: "temporary HOME + agent directory; the authorized file is read once and not modified", checks: [], status: "running" };
const digest = async path => createHash("sha256").update(await readFile(path)).digest("hex");
const sourceBefore = { digest: await digest(source), mtimeMs: (await stat(source)).mtimeMs };
// The stored text is a pi config value. Only a literal can be re-entered as a typed key; a command or an environment reference is not a key.
const entry = JSON.parse(await readFile(source, "utf8"))[providerId];
if (entry?.type !== "api_key" || typeof entry.key !== "string" || entry.key.startsWith("!") || /\$(?![$!])/.test(entry.key.replaceAll("$$", ""))) {
  console.error(`The authorized file has no literal API key for ${providerId}.`); process.exit(2);
}
const key = entry.key.replace(/^\$!/, "!").replaceAll("$$", "$");
const scrub = text => String(text).split(key).join("[KEY]").split(entry.key).join("[KEY]");
const fixtures = [], clients = [];
async function check(id, name, fn) {
  const started = Date.now();
  try { const details = await fn(); report.checks.push({ id, name, status: "passed", durationMs: Date.now() - started, ...(details ? { details } : {}) }); console.log(`PASS ${id} ${name}`); }
  catch (error) { report.checks.push({ id, name, status: "failed", durationMs: Date.now() - started, error: scrub(error.stack ?? error) }); throw error; }
}
let requestNo = 0;
async function hostQuery(client, action, args = {}) {
  const reqId = `q${++requestNo}`; client.send({ t: "host_query", reqId, action, args });
  const frame = await waitFor(() => client.frames.find(item => item.t === "host_result" && item.reqId === reqId), `host_result ${action}`);
  if (frame.error) throw Object.assign(new Error(frame.error.message), { code: frame.error.code });
  return frame.value;
}
async function hostCommand(client, command, args = {}) {
  const commandNo = client.nextCommandNo++; const id = `${client.clientId}:${commandNo}`;
  client.send({ t: "host_command", clientId: client.clientId, commandNo, id, hostRevision: client.frames.filter(item => item.t === "host_state").at(-1)?.revision ?? 0, command, args });
  const ack = await waitFor(() => client.frames.find(item => item.t === "ack" && item.id === id), `ack ${command}`);
  if (ack.status !== "dispatched") throw Object.assign(new Error(ack.error?.message ?? "rejected"), { code: ack.error?.code });
  const result = await waitFor(() => client.frames.find(item => item.t === "command_result" && item.id === id), `result ${command}`, 60_000);
  if (result.status !== "completed") throw Object.assign(new Error(result.error?.message ?? "failed"), { code: result.error?.code });
  return result.value;
}
const operationOf = client => client.frames.filter(item => item.t === "account_state").at(-1)?.operation ?? null;
const account = async client => (await hostQuery(client, "accounts")).providers.find(item => item.id === providerId);
const applied = client => waitFor(async () => !(await hostQuery(client, "accounts")).pendingApply, "credential applied", 30_000);

try {
  // Starts on the local deterministic model: the real provider is unavailable until the login below.
  const fixture = await startFixture({ extraExtensions: ["tests/fixtures/handoff-fixture.ts"], online: true }); fixtures.push(fixture);
  const client = await openClient(fixture.url); clients.push(client);
  await waitFor(() => client.snapshot, "snapshot");
  const authPath = join(fixture.agentDir, "auth.json");
  const nonce = randomBytes(5).toString("hex");
  await check("REAL-1", "before login the provider is not configured and offers no model", async () => {
    const provider = await account(client); assert.ok(provider, "pi knows this provider"); assert.equal(provider.stored, undefined); assert.equal(provider.models, 0);
    assert.ok(provider.methods.some(method => method.type === "api_key" && method.web));
    assert.ok(!(await workbenchQuery(client, "resources")).models.some(model => model.provider === providerId));
  });
  await check("REAL-2", "the key entered through the browser protocol is saved by pi and applied to the running session", async () => {
    const { operationId } = await hostCommand(client, "account_begin", { provider: providerId, method: "api_key" });
    const step = await waitFor(() => { const operation = operationOf(client); return operation?.id === operationId && operation.step; }, "key step");
    assert.equal(step.kind, "secret");
    client.send({ t: "account_answer", operationId, stepId: step.id, value: key });
    const done = await waitFor(() => { const operation = operationOf(client); return operation?.id === operationId && operation.status !== "running" && operation; }, "login result", 30_000);
    assert.equal(done.status, "saved", scrub(JSON.stringify(done.error)));
    await applied(client);
    const provider = await account(client); assert.equal(provider.stored, "api_key"); assert.ok(provider.models > 0);
    assert.ok((await workbenchQuery(client, "resources")).models.some(model => model.provider === providerId && model.id === modelId), "the chosen model is offered");
    assert.equal((await stat(authPath)).mode & 0o777, 0o600);
    return { modelsOffered: provider.models };
  });
  await check("REAL-3", "the provider accepts the credential: one short prompt gets a real reply", async () => {
    const selected = await client.command("set_model", { provider: providerId, id: modelId }); assert.equal(selected.ack.status, "dispatched", selected.ack.error?.message);
    assert.equal((await commandResult(client, selected.frame)).status, "completed");
    await waitFor(() => client.snapshot?.state.model?.provider === providerId && client.snapshot.state.model.id === modelId, "model selected");
    const prompt = `Do not use tools. Reply with only the concatenation of "M31_REAL_" and "${nonce}".`;
    const sent = await client.command("prompt", { text: prompt, mode: "followUp" }); assert.equal(sent.ack.status, "dispatched", sent.ack.error?.message);
    report.realModelCalls++;
    assert.equal((await commandResult(client, sent.frame)).status, "completed");
    const answer = await waitFor(() => client.snapshot?.state.idle && client.snapshot.session.messages.filter(message => message.role === "assistant").at(-1), "real reply", 180_000);
    const text = answer.content.filter(part => part.type === "text").map(part => part.text).join("");
    assert.ok(text.includes(`M31_REAL_${nonce}`), `unexpected reply: ${scrub(text).slice(0, 300)}`);
    return { replyCharacters: text.length };
  });
  await check("REAL-4", "signing out removes the stored entry and the session stops offering the provider's models", async () => {
    await hostCommand(client, "account_logout", { provider: providerId }); await applied(client);
    const provider = await account(client); assert.equal(provider.stored, undefined); assert.equal(provider.models, 0);
    assert.equal(JSON.parse(await readFile(authPath, "utf8"))[providerId], undefined);
  });
  await check("REAL-5", "the key is in nothing the browser received, the terminal, fixture events or session files; the authorized file is unchanged", async () => {
    const haystacks = { frames: JSON.stringify(client.frames), terminal: fixture.terminal, events: JSON.stringify(await fixture.events()), stderr: fixture.processError };
    const sessionDir = join(fixture.agentDir, "sessions");
    for (const name of await readdir(sessionDir, { recursive: true })) if (name.endsWith(".jsonl")) haystacks[`session:${name}`] = await readFile(join(sessionDir, name), "utf8");
    for (const [where, text] of Object.entries(haystacks)) assert.ok(!text.includes(key) && !text.includes(entry.key), `the key appears in ${where}`);
    assert.deepEqual({ digest: await digest(source), mtimeMs: (await stat(source)).mtimeMs }, sourceBefore);
    return { searched: Object.keys(haystacks).length };
  });
  report.status = "passed";
} catch (error) { report.status = "failed"; report.error = scrub(error.stack ?? error); process.exitCode = 1; console.error(report.error); }
finally {
  for (const client of clients) await client.close().catch(() => {});
  for (const fixture of fixtures) { await fixture.close().catch(() => {}); await fixture.remove().catch(() => {}); }
  report.cleanup = { temporaryAgentDirectoryRemoved: (await Promise.all(fixtures.map(fixture => stat(fixture.directory).then(() => false, () => true)))).every(Boolean), authorizedFileUnchanged: (await digest(source)) === sourceBefore.digest };
  report.finishedAt = new Date().toISOString();
  await writeFile(join(out, "report.json"), `${scrub(JSON.stringify(report, null, 2))}\n`);
  console.log(`${report.status.toUpperCase()} — ${report.checks.filter(item => item.status === "passed").length}/${report.checks.length} checks, ${report.realModelCalls} real model call(s); report: ${join(out, "report.json")}`);
}
