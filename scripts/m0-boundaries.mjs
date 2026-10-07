#!/usr/bin/env node
/** Real-host M0 boundary checks. Every model response/error is generated locally. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openClient, startFixture, textOf, waitFor } from "./m0-smoke.mjs";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hooks = join(project, "tests/fixtures/boundary-hooks.ts");
const pause = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const clean = (value) => value.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
  .replace(/#t=[A-Za-z0-9_-]+/g, "#t=[REDACTED]").replace(/pi-pane\.bearer\.[A-Za-z0-9_-]+/g, "pi-pane.bearer.[REDACTED]");
const assistantWith = (client, text) => client.snapshot?.session.messages.filter((message) => message.role === "assistant" && textOf(message).includes(text)) ?? [];
const compactState = (client) => client.snapshot?.state.compacting;

export async function runBoundaries() {
  const output = resolve(process.env.PI_M0_REPORT_DIR || join(project, "build-artifacts/m0/boundaries"));
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
    return waitFor(() => client.frames.find((item) => item.t === "command_result" && item.id === frame.id), `command result ${frame.command}`);
  }
  try {
    await check("no selected model: dispatch receipt does not fabricate delivery or execution", ["Q2"], async () => {
      const [fixture, client] = await create("no-model", { provider: null, model: null, envOverrides: { PI_M0_NO_PROVIDER: "1" } });
      assert.ok(!client.snapshot.state.model || client.snapshot.state.model.provider === "unknown");
      const terminalOffset = fixture.terminal.length;
      const { ack, frame } = await client.command("prompt", { text: "M0_NO_MODEL_INPUT" }); assert.equal(ack.status, "dispatched");
      await waitFor(() => /No model|No API key/i.test(clean(fixture.terminal.slice(terminalOffset))), "host reports no selected model"); await pause(150);
      assert.equal(client.users("M0_NO_MODEL_INPUT").length, 0);
      assert.equal((await fixture.events()).filter((event) => event.event === "provider_call").length, 0);
      assert.equal(client.frames.some((item) => item.t === "command_result" && item.id === frame.id), false);
      await client.close(); await fixture.close();
      return { ack: ack.status, actualTranscriptDelivery: false, hostErrorObserved: true, placeholderModel: client.snapshot.state.model };
    });
    await check("missing test-provider authentication fails in the actual host preflight", ["Q2"], async () => {
      const [fixture, client] = await create("missing-auth", { provider: "pi-pane-m0-noauth", model: "deterministic" });
      assert.equal(client.snapshot.state.model.provider, "pi-pane-m0-noauth");
      const { ack } = await client.command("prompt", { text: "M0_NO_AUTH_INPUT" }); assert.equal(ack.status, "dispatched");
      await waitFor(() => /No API key|Authentication failed/i.test(clean(fixture.terminal)), "host authentication error"); await pause(150);
      assert.equal(client.users("M0_NO_AUTH_INPUT").length, 0);
      assert.equal((await fixture.events()).filter((event) => event.event === "provider_call").length, 0);
      await client.close(); await fixture.close();
      return { ack: ack.status, preflightRejected: true, providerCalls: 0 };
    });
    [f, c] = await create("main");
    report.extension = f.extension; report.piCli = f.cli;
    report.piVersion = JSON.parse(await readFile(join(dirname(f.cli), "../package.json"), "utf8")).version;
    await check("a real input hook consumes web input without a fake message or success result", ["Q2"], async () => {
      const calls = await f.eventCount("provider_call");
      const { ack, frame } = await c.command("prompt", { text: "M0_CONSUME" }); assert.equal(ack.status, "dispatched");
      await f.waitEvent("input_consumed"); await pause(200);
      assert.equal(c.users("M0_CONSUME").length, 0); assert.equal(await f.eventCount("provider_call"), calls);
      assert.equal(c.frames.some((item) => item.t === "command_result" && item.id === frame.id), false);
      assert.equal(c.snapshot.state.idle, true);
      return { ack: ack.status, actualDelivery: false };
    });
    await check("a real input hook transforms the actual transcript independently of the receipt", ["Q2"], async () => {
      const { ack } = await c.command("prompt", { text: "M0_TRANSFORM" }); assert.equal(ack.status, "dispatched");
      await c.settled("M0_TRANSFORMED_BY_EXTENSION"); assert.equal(c.users("M0_TRANSFORM").length, 0);
      const input = (await f.events()).find((event) => event.event === "boundary_input" && event.text === "M0_TRANSFORM");
      assert.equal(input.source, "extension");
    });
    await check("real templates expand from TUI but remain literal through web submission", ["Q5"], async () => {
      const literal = "/m0-boundary-template web";
      await c.command("prompt", { text: literal }); await c.settled(literal);
      f.command("/m0-boundary-template terminal");
      await f.waitEvent("provider_call", 0, (event) => event.input.includes("M0_TEMPLATE_EXPANDED terminal"));
      await waitFor(() => c.snapshot.state.idle && c.snapshot.session.messages.some((message) => message.role === "user" && textOf(message).includes("M0_TEMPLATE_EXPANDED terminal")), "terminal template expansion");
    });
    await check("real skills expand from TUI but remain literal through web submission", ["Q5"], async () => {
      const literal = "/skill:m0-boundary-skill web";
      await c.command("prompt", { text: literal }); await c.settled(literal);
      f.command("/skill:m0-boundary-skill terminal");
      await f.waitEvent("provider_call", 0, (event) => event.input.includes("M0_SKILL_EXPANDED") && event.input.includes("terminal"));
      await waitFor(() => c.snapshot.state.idle && c.snapshot.session.messages.some((message) => message.role === "user" && textOf(message).includes("M0_SKILL_EXPANDED")), "terminal skill expansion");
    });
    await check("controlled 401 enters the real provider error path and becomes a session error", ["Q2"], async () => {
      await mode("error-auth");
      const { ack, frame } = await c.command("prompt", { text: "M0_AUTH_PROVIDER" }); assert.equal(ack.status, "dispatched");
      await f.waitEvent("provider_failed", 0, (event) => event.control === "error-auth");
      await waitFor(() => c.snapshot.state.idle && assistantWith(c, "401 Unauthorized").some((message) => message.isError), "session provider error is visible");
      assert.equal(c.frames.some((item) => item.t === "command_result" && item.id === frame.id), false);
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
      await c.settled("M0_THINKING_RECONNECT");
      assert.equal(c.assistants("M0_THINKING_RECONNECT")[0].content.find((part) => part.type === "thinking").text, "M0_THOUGHT:" + "thinking-block-".repeat(16));
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
    await check("real branch summarization failure restores its barrier and leaves the branch intact", ["Q8"], async () => {
      const before = structuredClone(c.snapshot); f.command("/m0-tree-summary-failure");
      const tree = await f.waitEvent("boundary_tree_failure_result"); assert.equal(tree.failed, true); assert.match(tree.error ?? "", /controlled summarization failure/);
      await waitFor(() => c.snapshot && c.snapshot.state.idle, "idle after failed tree"); await pause(350);
      assert.equal(c.snapshot.session.branchRevision, before.session.branchRevision);
      assert.deepEqual(c.snapshot.session.messages.map((message) => [message.role, textOf(message)]), before.session.messages.map((message) => [message.role, textOf(message)]));
      await c.command("prompt", { text: "M0_AFTER_TREE_FAILURE" }); await c.settled("M0_AFTER_TREE_FAILURE");
    });
    await check("terminal dialog is observable after reconnect and blocks configuration mutations", ["Q8"], async () => {
      f.command("/m0-dialog"); await f.waitEvent("boundary_dialog_start");
      await waitFor(() => c.snapshot.state.uiPrompts.length > 0, "terminal dialog state");
      await reconnect(); assert.ok(c.snapshot.state.uiPrompts.some((prompt) => prompt.title === "M0 boundary confirm"));
      for (const [command, args] of [["set_model", { provider: "pi-pane-m0", id: "deterministic" }], ["compact", {}]]) {
        const { ack } = await c.command(command, args); assert.equal(ack.status, "rejected"); assert.equal(ack.error.code, "busy");
      }
      f.write("\u001b"); await f.waitEvent("boundary_dialog_result");
      await waitFor(() => c.snapshot.state.uiPrompts.length === 0, "dialog cleared");
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
      const blocked = await c.command("set_thinking", { level: "low" }); assert.equal(blocked.ack.status, "rejected"); assert.equal(blocked.ack.error.code, "busy");
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
    await check("TUI Enter/Alt+Enter queue real steering/follow-up and synchronize the boolean", ["Q9"], async () => {
      f.command("M0_SLOW_TUI_QUEUE"); await waitFor(() => c.snapshot.state.running, "TUI slow response running");
      const queuedAt = Date.now();
      f.command("M0_TUI_STEER"); f.write("M0_TUI_FOLLOW\u001b[13;3u");
      await waitFor(() => c.snapshot.state.hasPendingMessages, "TUI queue is nonempty", 1000);
      const queuedLatencyMs = Date.now() - queuedAt;
      await c.settled("M0_TUI_FOLLOW");
      const inputs = (await f.events()).filter((event) => event.event === "boundary_input");
      assert.equal(inputs.find((event) => event.text === "M0_TUI_STEER").source, "interactive");
      assert.equal(inputs.find((event) => event.text === "M0_TUI_STEER").mode, "steer");
      assert.equal(inputs.find((event) => event.text === "M0_TUI_FOLLOW").mode, "followUp");
      assert.equal(c.snapshot.state.hasPendingMessages, false);
      return { queuedLatencyMs, consumedAndCleared: true };
    });
    await check("TUI dequeue clears pending state and restores text without automatic delivery", ["Q9"], async () => {
      f.command("M0_SLOW_DEQUEUE"); await waitFor(() => c.snapshot.state.running, "response running before dequeue");
      f.write("M0_TUI_DEQUEUED\u001b[13;3u"); await waitFor(() => c.snapshot.state.hasPendingMessages, "queued before dequeue", 1000);
      const dequeuedAt = Date.now();
      f.write("\u001b[1;3A"); await waitFor(() => !c.snapshot.state.hasPendingMessages, "queue cleared by Alt+Up", 1000);
      const dequeuedLatencyMs = Date.now() - dequeuedAt;
      await c.settled("M0_SLOW_DEQUEUE"); assert.equal(c.users("M0_TUI_DEQUEUED").length, 0);
      f.write("\r"); await c.settled("M0_TUI_DEQUEUED");
      return { dequeuedLatencyMs, restoredDraftWasNotAutomaticallyDelivered: true };
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
    await check("a host-entered delayed input never leaks old-session messages into the new epoch", ["Q8"], async () => {
      const before = structuredClone(c.snapshot); const { ack } = await c.command("prompt", { text: "M0_DELAY_INPUT" }); assert.equal(ack.status, "dispatched");
      await f.waitEvent("input_delayed_start"); f.command("/new");
      await waitFor(() => c.snapshot && c.snapshot.session.id !== before.session.id, "new session during delayed host input");
      await f.waitEvent("input_delayed_end"); await pause(400);
      assert.equal(c.users("M0_DELAYED_DELIVERED").length, 0);
      for (const [command, args] of [["prompt", { text: "M0_STALE_BOUNDARY" }], ["abort", {}], ["set_model", { provider: "pi-pane-m0", id: "deterministic" }], ["compact", {}]]) {
        const rejected = await c.command(command, args, before); assert.equal(rejected.ack.status, "rejected"); assert.equal(rejected.ack.error.code, "stale_session");
      }
      await c.command("prompt", { text: "M0_NEW_AFTER_DELAY" }); await c.settled("M0_NEW_AFTER_DELAY");
      return { alreadyEnteredHostOperationMayContinueInOldSession: true, newEpochContaminated: false };
    });
    await check("old compaction result stays in its original epoch during actual TUI session replacement", ["Q8"], async () => {
      await c.command("prompt", { text: "M0_COMPACT_RACE_SEED" }); await c.settled("M0_COMPACT_RACE_SEED");
      await mode("summary-ok"); const before = structuredClone(c.snapshot);
      const { frame } = await c.command("compact"); await waitFor(() => compactState(c), "old compaction active");
      f.command("/new"); await waitFor(() => c.snapshot && c.snapshot.session.id !== before.session.id, "replace session during compaction"); await pause(1000);
      const results = c.frames.filter((item) => item.t === "command_result" && item.id === frame.id);
      assert.ok(results.every((item) => item.epoch === before.epoch));
      assert.equal(c.snapshot.session.messages.length, 0);
      await c.command("prompt", { text: "M0_AFTER_COMPACT_RACE" }); await c.settled("M0_AFTER_COMPACT_RACE");
      return { oldResultsObserved: results.length, allBoundToOldEpoch: true, hostTeardownMayAwaitAbort: true };
    });
    await check("a delayed actual model-select completion cannot report into the replacement epoch", ["Q8"], async () => {
      f.command("/m0-delay-model"); await f.waitEvent("boundary_model_delay_armed");
      const before = structuredClone(c.snapshot);
      const nextModel = before.state.model.id === "deterministic" ? "deterministic-thinking" : "deterministic";
      const { ack, frame } = await c.command("set_model", { provider: "pi-pane-m0", id: nextModel }); assert.equal(ack.status, "dispatched");
      await f.waitEvent("boundary_model_delay_start"); f.command("/new");
      await waitFor(() => c.snapshot && c.snapshot.session.id !== before.session.id, "new session during delayed model hook");
      await f.waitEvent("boundary_model_delay_end"); await pause(200);
      const results = c.frames.filter((item) => item.t === "command_result" && item.id === frame.id);
      assert.ok(results.every((item) => item.epoch === before.epoch));
      assert.equal(c.snapshot.session.messages.length, 0);
      await c.command("prompt", { text: "M0_AFTER_MODEL_RACE" }); await c.settled("M0_AFTER_MODEL_RACE");
      return { oldResultsObserved: results.length, allBoundToOldEpoch: true, alreadyAppliedHostModelMayPersist: true };
    });
    await check("all boundary reconnects preserve contiguous sequenced state", ["Q7", "Q8"], async () => {
      assert.deepEqual(clients.flatMap((client) => client.protocolErrors), []);
      return { clients: clients.length, observedEvents: clients.reduce((count, client) => count + client.frames.filter((frame) => frame.t === "event").length, 0) };
    });
    report.limitations.push("Prompt acknowledgements remain dispatch-only: real consumption/transformation and host preflight failures are intentionally not falsely correlated to per-command completion.",
      "Already-dispatched host operations cannot be transactionally cancelled; the race assertions verify epoch attribution and absence of new-session contamination, not rollback of old-session side effects.",
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
