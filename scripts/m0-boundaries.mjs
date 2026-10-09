#!/usr/bin/env node
/** Real-host M0 boundary checks. Every model response/error is generated locally. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openClient, startFixture, textOf, waitFor, workbenchQuery } from "./m0-smoke.mjs";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hooks = join(project, "tests/fixtures/boundary-hooks.ts");
const pause = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const clean = (value) => value.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
  .replace(/#t=[A-Za-z0-9_-]+/g, "#t=[REDACTED]").replace(/pi-pane\.bearer\.[A-Za-z0-9_-]+/g, "pi-pane.bearer.[REDACTED]");
const assistantWith = (client, text) => client.snapshot?.session.messages.filter((message) => message.role === "assistant" && textOf(message).includes(text)) ?? [];
const compactState = (client) => client.snapshot?.state.compacting;

export async function runBoundaries() {
  const output = resolve(process.env.PI_M0_REPORT_DIR || join(project, "build-artifacts/m3/handoff/m0/boundaries"));
  await mkdir(output, { recursive: true });
  const report = { startedAt: new Date().toISOString(), nodeVersion: process.version, platform: process.platform, arch: process.arch,
    realTui: true, realModelCalls: 0, checks: [], limitations: [], status: "running" };
  const fixtures = [];
  const clients = [];
  let f; let c;
  const check = async (name, questions, fn) => {
    const started = Date.now();
    try { const details = await fn(); report.checks.push({ name, questions, status: "passed", durationMs: Date.now() - started, ...(details ? { details } : {}) }); console.log(`PASS ${name}`); }
    catch (error) { report.checks.push({ name, questions, status: "failed", durationMs: Date.now() - started, error: clean(error?.stack || String(error)) }); throw error; }
  };
  async function create(name, options = {}) {
    const fixture = await startFixture({ extraExtensions: [hooks], settings: { compaction: { enabled: false, reserveTokens: 512, keepRecentTokens: 1 }, retry: { enabled: false } }, ...options });
    fixtures.push({ name, fixture });
    await fixture.waitEvent("boundary_resources");
    const client = await openClient(fixture.url); clients.push(client);
    return [fixture, client];
  }
  async function reconnect() {
    const id = c.clientId; await c.close(); c = await openClient(f.url, id); clients.push(c); return c;
  }
  async function mode(value) {
    const count = await f.eventCount("provider_mode_set"); f.command(`/m0-provider-mode ${value}`);
    await f.waitEvent("provider_mode_set", count, () => true);
  }
  async function result(frame, client = c) {
    let lastQuery = 0;
    return waitFor(() => {
      const completed = client.frames.find((item) => item.t === "command_result" && item.id === frame.id);
      if (!completed && Date.now() - lastQuery >= 250) {
        lastQuery = Date.now();
        client.send({ t: "receipt_query", clientId: client.clientId, id: frame.id });
      }
      return completed;
    }, `command result ${frame.command}`);
  }
  try {
    await check("no selected model: dispatch receipt does not fabricate delivery or execution", ["Q2"], async () => {
      const [fixture, client] = await create("no-model", { provider: null, model: null, envOverrides: { PI_M0_NO_PROVIDER: "1" } });
      assert.ok(!client.snapshot.state.model || client.snapshot.state.model.provider === "unknown");
      const { ack, frame } = await client.command("prompt", { text: "M0_NO_MODEL_INPUT" }); assert.equal(ack.status, "dispatched");
      const failed = await result(frame, client); assert.equal(failed.status, "failed"); assert.match(failed.error.message, /No model|No API key/i); await pause(100);
      assert.equal(client.users("M0_NO_MODEL_INPUT").length, 0);
      assert.equal((await fixture.events()).filter((event) => event.event === "provider_call").length, 0);
      assert.equal((await result(frame, client)).status, "failed");
      await client.close(); await fixture.close();
      return { ack: ack.status, actualTranscriptDelivery: false, hostErrorObserved: true, placeholderModel: client.snapshot.state.model };
    });
    await check("missing test-provider authentication fails in the actual host preflight", ["Q2"], async () => {
      const [fixture, client] = await create("missing-auth", { provider: "pi-pane-m0-noauth", model: "deterministic" });
      assert.equal(client.snapshot.state.model.provider, "pi-pane-m0-noauth");
      const { ack, frame } = await client.command("prompt", { text: "M0_NO_AUTH_INPUT" }); assert.equal(ack.status, "dispatched");
      const failed = await result(frame, client); assert.equal(failed.status, "failed"); assert.match(failed.error.message, /No API key|Authentication failed/i); await pause(100);
      assert.equal(client.users("M0_NO_AUTH_INPUT").length, 0);
      assert.equal((await fixture.events()).filter((event) => event.event === "provider_call").length, 0);
      await client.close(); await fixture.close();
      return { ack: ack.status, preflightRejected: true, providerCalls: 0 };
    });
    [f, c] = await create("main");
    report.extension = f.extension; report.piCli = f.cli;
    report.piVersion = f.piVersion;
    await check("a real RPC input hook reports handled without creating a fake transcript message", ["Q2"], async () => {
      const calls = await f.eventCount("provider_call");
      const { ack, frame } = await c.command("prompt", { text: "M0_CONSUME" }); assert.equal(ack.status, "dispatched");
      await f.waitEvent("input_consumed"); await pause(200);
      assert.equal(c.users("M0_CONSUME").length, 0); assert.equal(await f.eventCount("provider_call"), calls);
      assert.equal((await result(frame)).value.disposition, "handled");
      assert.equal(c.snapshot.state.idle, true);
      return { ack: ack.status, actualDelivery: false };
    });
    await check("a real input hook transforms the actual transcript independently of the receipt", ["Q2"], async () => {
      const { ack } = await c.command("prompt", { text: "M0_TRANSFORM" }); assert.equal(ack.status, "dispatched");
      await c.settled("M0_TRANSFORMED_BY_EXTENSION"); assert.equal(c.users("M0_TRANSFORM").length, 0);
      const input = (await f.events()).find((event) => event.event === "boundary_input" && event.text === "M0_TRANSFORM");
      assert.equal(input.source, "rpc");
    });
    await check("real RPC prompt templates expand from browser submission", ["Q5"], async () => {
      await c.command("prompt", { text: "/m0-boundary-template web" });
      await f.waitEvent("provider_call", 0, event => event.input.includes("M0_TEMPLATE_EXPANDED web"));
      await waitFor(() => c.snapshot.state.idle && c.snapshot.session.messages.some(message => message.role === "assistant" && textOf(message).includes("M0_TEMPLATE_EXPANDED web")), "RPC template settled");
    });
    await check("real RPC skills expand from browser submission", ["Q5"], async () => {
      await c.command("prompt", { text: "/skill:m0-boundary-skill web" });
      await f.waitEvent("provider_call", 0, event => event.input.includes("M0_SKILL_EXPANDED") && event.input.includes("web"));
      await waitFor(() => c.snapshot.state.idle && c.snapshot.session.messages.some(message => message.role === "assistant" && textOf(message).includes("M0_SKILL_EXPANDED")), "RPC skill settled");
    });
    await check("controlled 401 enters the real provider error path and becomes a session error", ["Q2"], async () => {
      await mode("error-auth");
      const { ack, frame } = await c.command("prompt", { text: "M0_AUTH_PROVIDER" }); assert.equal(ack.status, "dispatched");
      await f.waitEvent("provider_failed", 0, (event) => event.control === "error-auth");
      await waitFor(() => c.snapshot.state.idle && assistantWith(c, "401 Unauthorized").some((message) => message.isError), "session provider error is visible");
      assert.equal((await result(frame)).value.disposition, "started");
      assert.equal(c.users("M0_AUTH_PROVIDER").length, 1);
    });
    await check("model authentication failure has an actual failed result and preserves the prior selection", ["Q2"], async () => {
      const before = c.snapshot.state.model;
      const { frame } = await c.command("set_model", { provider: "pi-pane-m0-noauth", id: "deterministic" });
      const completion = await result(frame); assert.equal(completion.status, "failed");
      assert.deepEqual(c.snapshot.state.model, before);
      return { result: completion.status, code: completion.error.code };
    });
    await check("thinking snapshot/reconnect preserves content index and the complete final thought", ["Q7"], async () => {
      const selected = await c.command("set_model", { provider: "pi-pane-m0", id: "deterministic-thinking" }); assert.equal((await result(selected.frame)).status, "completed");
      const thinking = await c.command("set_thinking", { level: "high" }); assert.equal((await result(thinking.frame)).status, "completed");
      await c.command("prompt", { text: "M0_THINKING_RECONNECT" });
      await waitFor(() => c.snapshot.session.messages.some((message) => message.status === "streaming" && message.content.some((part) => part.type === "thinking" && part.text.length > 24)), "partial thought");
      const before = c.snapshot.session.messages.find((message) => message.status === "streaming" && message.content.some((part) => part.type === "thinking"));
      await reconnect(); const restored = c.snapshot.session.messages.find((message) => message.id === before.id);
      assert.ok(restored?.content.some((part) => part.type === "thinking" && part.text.length > 24));
      assert.equal(restored.content.find((part) => part.type === "thinking").timingStatus, "running");
      await c.settled("M0_THINKING_RECONNECT");
      const finalThought = c.assistants("M0_THINKING_RECONNECT")[0].content.find((part) => part.type === "thinking");
      assert.equal(finalThought.text, "M0_THOUGHT:" + "thinking-block-".repeat(16));
      assert.equal(finalThought.timingStatus, "complete");
      assert.ok(finalThought.durationMs >= 100 && finalThought.durationMs < 30_000, "duration measures the observed fixture stream");
      await reconnect();
      assert.deepEqual(c.assistants("M0_THINKING_RECONNECT")[0].content.find((part) => part.type === "thinking"), finalThought, "completed timing survives canonical snapshots and reconnect");
      return { timingStatus: finalThought.timingStatus, durationMs: finalThought.durationMs };
    });
    await check("tool argument JSON can reconnect mid-stream and retain the final executed arguments", ["Q7"], async () => {
      await c.command("prompt", { text: "M0_TOOL_ARGUMENTS" });
      await waitFor(() => c.snapshot.session.messages.some((message) => message.status === "streaming" && message.content.some((part) => part.type === "toolCall" && typeof part.arguments?.text === "string" && part.arguments.text.length >= 4)), "partial tool JSON");
      const before = c.snapshot.session.messages.find((message) => message.status === "streaming" && message.content.some((part) => part.type === "toolCall"));
      await reconnect(); const restored = c.snapshot.session.messages.find((message) => message.id === before.id);
      assert.ok(restored?.content.some((part) => part.type === "toolCall" && typeof part.arguments?.text === "string"));
      await c.settled("M0_TOOL_ARGUMENTS");
      const tool = c.snapshot.state.tools.find((item) => item.name === "m0_echo" && item.args.text === "M0_TOOL_ARGUMENTS"); assert.equal(tool.status, "complete");
    });
    await check("a later real extension replaces finalized content without duplicate browser messages", ["Q7"], async () => {
      await c.command("prompt", { text: "M0_REPLACE_FINAL" }); await f.waitEvent("final_message_replaced");
      await waitFor(() => c.snapshot.state.idle && assistantWith(c, "M0_REPLACED_FINAL").length === 1, "canonical final replacement");
      assert.equal(assistantWith(c, "M0_REPLY:M0_REPLACE_FINAL:").length, 0);
      const transcriptCount = await f.eventCount("host_transcript"); f.command("/m0-host-transcript");
      const host = await f.waitEvent("host_transcript", transcriptCount);
      assert.equal(host.messages.filter((message) => message.text === "M0_REPLACED_FINAL").length, 1);
      await reconnect(); assert.equal(assistantWith(c, "M0_REPLACED_FINAL").length, 1);
    });
    await check("readonly tree reports native entries while unsupported navigation is disabled", ["Q8"], async () => {
      const tree = await workbenchQuery(c, "tree"); assert.ok(tree.entries.some(entry => entry.role === "user"));
      assert.equal(c.snapshot.caps.commands.includes("session_tree"), false);
      const commands = await workbenchQuery(c, "commands"); assert.ok(commands.commands.find(item => item.name === "tree")?.reason);
      await c.command("prompt", { text: "M0_AFTER_TREE_DISABLED" }); await c.settled("M0_AFTER_TREE_DISABLED");
    });
    await check("extension dialog survives reconnect, blocks configuration, and cancels from the browser", ["Q8"], async () => {
      const operation = await c.command("prompt", { text: "/m0-dialog" });
      const dialog = await waitFor(() => c.frames.find(frame => frame.t === "ui_request" && frame.title === "M0 boundary confirm"), "RPC dialog request");
      await reconnect();
      await waitFor(() => c.frames.some(frame => frame.t === "ui_request" && frame.id === dialog.id), "dialog restored on reconnect");
      for (const [command, args] of [["set_model", { provider: "pi-pane-m0", id: "deterministic" }], ["compact", {}]]) {
        const operation = await c.command(command, args);
        const refusal = operation.ack.status === "dispatched" ? await result(operation.frame) : operation.ack;
        assert.ok(refusal.status === "rejected" || refusal.status === "failed"); assert.equal(refusal.error.code, "busy");
      }
      c.send({ t: "ui_response", id: dialog.id, cancelled: true });
      await f.waitEvent("boundary_dialog_result");
      await waitFor(() => c.frames.some(frame => frame.t === "ui_resolved" && frame.id === dialog.id), "browser dialog cleared");
      assert.equal((await result(operation.frame)).value.disposition, "handled");
    });
    await check("manual compaction failure returns an actual failed result and releases busy state", ["Q2", "Q8"], async () => {
      await mode("error-summary"); const failures = await f.eventCount("boundary_compact_failure");
      const { ack, frame } = await c.command("compact"); assert.equal(ack.status, "dispatched");
      const completion = await result(frame); assert.equal(completion.status, "failed"); assert.match(completion.error.message, /controlled summarization failure/);
      await f.waitEvent("boundary_compact_failure", failures);
      await waitFor(() => c.snapshot.state.idle && !compactState(c), "compaction failure released busy state");
      await c.command("prompt", { text: "M0_AFTER_COMPACT_FAILURE" }); await c.settled("M0_AFTER_COMPACT_FAILURE");
    });
    await check("manual compaction succeeds through the real summarizer and rejects concurrent configuration", ["Q2", "Q8"], async () => {
      await mode("summary-ok"); const successes = await f.eventCount("boundary_compact_success");
      const epoch = c.snapshot.epoch;
      const { ack, frame } = await c.command("compact"); assert.equal(ack.status, "dispatched");
      await waitFor(() => compactState(c), "manual compaction active");
      const blocked = await c.command("set_thinking", { level: "low" });
      const refusal = blocked.ack.status === "dispatched" ? await result(blocked.frame) : blocked.ack;
      assert.ok(refusal.status === "rejected" || refusal.status === "failed"); assert.equal(refusal.error.code, "busy");
      assert.equal((await result(frame)).status, "completed");
      const complete = await f.waitEvent("boundary_compact_success", successes); assert.equal(complete.fromExtension, false);
      await waitFor(() => c.snapshot.state.idle && !compactState(c), "compaction finished");
      assert.ok(c.snapshot.session.messages.some((message) => textOf(message) === "[Context compacted]"));
      assert.equal(c.snapshot.epoch, epoch, "compaction keeps its command epoch");
      const live = structuredClone(c.snapshot.session.messages);
      const snapshotCount = c.frames.filter((item) => item.t === "snapshot").length;
      c.send({ t: "resync" });
      await waitFor(() => c.frames.filter((item) => item.t === "snapshot").length > snapshotCount, "post-compaction resync");
      assert.deepEqual(c.snapshot.session.messages, live, "online compaction history matches its canonical resync");
      await c.command("prompt", { text: "M0_AFTER_COMPACT_SUCCESS" }); await c.settled("M0_AFTER_COMPACT_SUCCESS");
    });
    await check("RPC steering/follow-up enter the host queue and synchronize the boolean", ["Q9"], async () => {
      await c.command("prompt", { text: "M0_SLOW_RPC_QUEUE" }); await waitFor(() => c.snapshot.state.running, "RPC slow response running");
      const queuedAt = Date.now();
      await c.command("prompt", { text: "M0_RPC_STEER", mode: "steer" });
      await c.command("prompt", { text: "M0_RPC_FOLLOW", mode: "followUp" });
      await waitFor(() => c.snapshot.state.hasPendingMessages, "RPC queue is nonempty", 1000);
      await c.settled("M0_RPC_FOLLOW");
      const inputs = (await f.events()).filter(event => event.event === "boundary_input");
      assert.equal(inputs.find(event => event.text === "M0_RPC_STEER").source, "rpc");
      assert.equal(inputs.find(event => event.text === "M0_RPC_STEER").mode, "steer");
      assert.equal(inputs.find(event => event.text === "M0_RPC_FOLLOW").mode, "followUp");
      assert.equal(c.snapshot.state.hasPendingMessages, false);
      return { queuedLatencyMs: Date.now() - queuedAt, consumedAndCleared: true };
    });
    await check("session replacement refuses queued messages without silently dropping them", ["Q9"], async () => {
      await c.command("prompt", { text: "M0_SLOW_PENDING_GUARD" }); await waitFor(() => c.snapshot.state.running, "response running");
      await c.command("prompt", { text: "M0_PENDING_RETAINED", mode: "followUp" });
      await waitFor(() => c.snapshot.state.hasPendingMessages, "pending queue");
      const moving = await c.command("session_new");
      const refusal = moving.ack.status === "dispatched" ? await result(moving.frame) : moving.ack;
      assert.ok(refusal.status === "rejected" || refusal.status === "failed"); assert.equal(refusal.error.code, "busy");
      await c.settled("M0_PENDING_RETAINED"); assert.equal(c.users("M0_PENDING_RETAINED").length, 1);
    });
    await check("a genuinely unread receipt is recovered after reconnect without a second host invocation", ["Q9"], async () => {
      const frame = c.makeCommand("prompt", { text: "M0_LOST_ACK" });
      // Pause TCP reads before the send so neither the receipt nor transcript can
      // reach this client, while the actual host still processes the command.
      c.socket._socket.pause(); c.send(frame);
      await f.waitEvent("provider_call", 0, (event) => event.input === "M0_LOST_ACK");
      assert.equal(c.frames.some((item) => item.t === "ack" && item.id === frame.id), false);
      const id = c.clientId; c.socket.terminate(); await waitFor(() => c.closed, "unread socket terminated");
      c = await openClient(f.url, id); clients.push(c);
      c.send({ t: "receipt_query", clientId: id, id: frame.id });
      const receipt = await waitFor(() => c.frames.find((item) => item.t === "ack" && item.id === frame.id), "recovered unread receipt");
      assert.equal(receipt.status, "dispatched");
      c.send(frame);
      await waitFor(() => c.frames.filter((item) => item.t === "ack" && item.id === frame.id).length === 2, "explicit duplicate receives original receipt");
      await c.settled("M0_LOST_ACK");
      assert.equal((await f.events()).filter((event) => event.event === "boundary_input" && event.text === "M0_LOST_ACK").length, 1);
      assert.equal((await f.events()).filter((event) => event.event === "provider_call" && event.input === "M0_LOST_ACK").length, 1);
      return { receiptWasUnread: true, actualHostInputCalls: 1, localProviderCalls: 1 };
    });
    await check("delayed input and a session command are serialized without contaminating a new epoch", ["Q8"], async () => {
      const before = structuredClone(c.snapshot);
      const submitted = await c.command("prompt", { text: "M0_DELAY_INPUT" });
      await f.waitEvent("input_delayed_start");
      const moving = await c.command("session_new");
      await f.waitEvent("input_delayed_end");
      await c.settled("M0_DELAYED_DELIVERED");
      if (moving.ack.status === "dispatched") assert.equal((await result(moving.frame)).status, "failed"); else assert.equal(moving.ack.error.code, "busy");
      assert.equal(c.snapshot.session.id, before.session.id);
      assert.equal((await result(submitted.frame)).value.disposition, "started");
      const actual = await c.command("session_new"); assert.equal((await result(actual.frame)).status, "completed");
      await waitFor(() => c.snapshot?.session.id !== before.session.id, "idle replacement");
      assert.equal(c.users("M0_DELAYED_DELIVERED").length, 0);
      for (const [command, args] of [["prompt", { text: "M0_STALE_BOUNDARY" }], ["abort", {}], ["set_model", { provider: "pi-pane-m0", id: "deterministic" }], ["compact", {}]]) assert.equal((await c.command(command, args, before)).ack.error.code, "stale_session");
      await c.command("prompt", { text: "M0_NEW_AFTER_DELAY" }); await c.settled("M0_NEW_AFTER_DELAY");
    });
    await check("active compaction rejects session replacement and keeps results in its original epoch", ["Q8"], async () => {
      await mode("summary-ok"); const before = structuredClone(c.snapshot);
      const compact = await c.command("compact"); await waitFor(() => compactState(c), "compaction active");
      const moving = await c.command("session_new");
      const refusal = moving.ack.status === "dispatched" ? await result(moving.frame) : moving.ack;
      assert.ok(refusal.status === "rejected" || refusal.status === "failed"); assert.equal(refusal.error.code, "busy");
      assert.equal((await result(compact.frame)).epoch, before.epoch);
      await waitFor(() => c.snapshot.state.idle && !compactState(c), "compaction settled");
      assert.equal(c.snapshot.session.id, before.session.id);
    });
    await check("delayed model selection and a queued session command retain original result attribution", ["Q8"], async () => {
      await f.webCommand("/m0-delay-model"); await f.waitEvent("boundary_model_delay_armed");
      const before = structuredClone(c.snapshot);
      const nextModel = before.state.model.id === "deterministic" ? "deterministic-thinking" : "deterministic";
      const selected = await c.command("set_model", { provider: "pi-pane-m0", id: nextModel });
      await f.waitEvent("boundary_model_delay_start");
      const moving = await c.command("session_new");
      await f.waitEvent("boundary_model_delay_end");
      assert.equal((await result(selected.frame)).epoch, before.epoch);
      if (moving.ack.status === "dispatched") {
        assert.equal((await result(moving.frame)).status, "completed");
        await waitFor(() => c.snapshot?.session.id !== before.session.id, "serialized new session");
      } else assert.equal(moving.ack.error.code, "busy");
      await c.command("prompt", { text: "M0_AFTER_MODEL_RACE" }); await c.settled("M0_AFTER_MODEL_RACE");
    });
    await check("all boundary reconnects preserve contiguous sequenced state", ["Q7", "Q8"], async () => {
      assert.deepEqual(clients.flatMap((client) => client.protocolErrors), []);
      return { clients: clients.length, observedEvents: clients.reduce((count, client) => count + client.frames.filter((frame) => frame.t === "event").length, 0) };
    });
    report.limitations.push("RPC prompt receipts report started/queued/handled or preflight failure; model completion is independently projected.",
      "TUI Alt+Up dequeue and private tree summarization are retired: RPC has no corresponding public command; pending-message preservation and disabled navigation are verified instead.",
      "Lease expiry equivalence uses existing short-TTL Hub tests; no 30-minute wall-clock wait is necessary to validate the same expiry logic.");
    report.status = "passed";
  } catch (error) { report.status = "failed"; report.error = clean(error?.stack || String(error)); console.error(report.error); }
  finally {
    for (const client of clients) await client.close().catch(() => client.socket.terminate());
    for (const { name, fixture } of fixtures) {
      await fixture.close();
      await writeFile(join(output, `${name}.terminal.redacted.log`), clean(fixture.terminal + fixture.processError));
      await writeFile(join(output, `${name}.events.jsonl`), await readFile(fixture.eventPath, "utf8"));
      await fixture.remove();
    }
    report.finishedAt = new Date().toISOString();
    await writeFile(join(output, "boundary-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = await runBoundaries(); process.exitCode = report.status === "passed" ? 0 : 1;
}
