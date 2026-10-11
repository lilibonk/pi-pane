import assert from "node:assert/strict";
import test from "node:test";
import { applyDelta, applyProjectionEvent, commandArgs, hostCommandArgs, hostQueryArgs, diffMessage, mergeOlderPage, parseClientMessage, ProtocolError, type MessageView, type ProjectionState } from "../src/protocol/index.ts";

test("wire validation rejects ambiguous identities and unsafe command counters", () => {
  const valid = { t: "command", clientId: "client", commandNo: 1, id: "client:1", epoch: "epoch", sessionId: "session", branchRevision: 0, command: "abort", args: {} };
  assert.deepEqual(parseClientMessage(valid), valid);
  for (const patch of [{ id: "different" }, { commandNo: 1.5 }, { commandNo: Number.MAX_SAFE_INTEGER + 1 }, { branchRevision: -1 }, { privileged: true }]) {
    assert.throws(() => parseClientMessage({ ...valid, ...patch }), ProtocolError);
  }
});

test("prompt limit counts UTF-8 bytes and refuses unsupported uploads", () => {
  assert.equal(commandArgs("prompt", { text: "汉".repeat(21_845), mode: "steer" }).mode, "steer");
  assert.throws(() => commandArgs("prompt", { text: "汉".repeat(21_846) }), ProtocolError);
  assert.equal(commandArgs("prompt", { text: "test", images: [] }).text, "test");
  assert.throws(() => commandArgs("prompt", { text: "", images: [] }), ProtocolError);
  assert.throws(() => commandArgs("prompt", { text: "   " }), ProtocolError);
  assert.throws(() => commandArgs("prompt", { text: "test", mode: "immediate" }), ProtocolError);
});

test("unknown commands and malformed control messages fail closed", () => {
  for (const value of [null, [], { t: "hello", clientId: "" }, { t: "resync", command: "abort" }, { t: "receipt_query", clientId: "c" }]) {
    assert.throws(() => parseClientMessage(value), ProtocolError);
  }
  assert.throws(() => commandArgs("shutdown", {}), /Unknown command/);
  assert.throws(() => commandArgs("abort", { other: true }), ProtocolError);
});

test("read requests validate their cursors and offsets", () => {
  const page = { t: "history_page", reqId: "h1", epoch: "e", sessionId: "s", branchRevision: 0, before: "entry" };
  assert.deepEqual(parseClientMessage(page), page);
  const content = { t: "content_page", reqId: "c1", epoch: "e", messageId: "m", index: 2, offset: 0 };
  assert.deepEqual(parseClientMessage(content), content);
  for (const value of [{ ...page, before: "" }, { ...page, path: "/etc/passwd" }, { ...content, offset: -1 }, { ...content, index: 1.5 }, { ...content, index: 5000 }])
    assert.throws(() => parseClientMessage(value), ProtocolError);
});

test("diffs are append-only for growing text and fall back to replacement otherwise", () => {
  const base: MessageView = { id: "m", role: "assistant", status: "streaming", content: [{ type: "thinking", text: "plan" }, { type: "text", text: "Hel" }] };
  const grown: MessageView = { ...base, content: [{ type: "thinking", text: "plan" }, { type: "text", text: "Hello" }, { type: "toolCall", id: "t", name: "bash", arguments: { command: "ls" } }] };
  const ops = diffMessage(base, grown);
  assert.deepEqual(ops, [{ i: 1, append: "lo" }, { i: 2, set: grown.content[2] }]);
  assert.deepEqual(applyDelta(base, ops!), grown);
  assert.equal(diffMessage(base, { ...grown, status: "complete" }), null, "status changes need the full message");
  const rewritten: MessageView = { ...base, content: [{ type: "thinking", text: "plan" }, { type: "text", text: "Bye" }] };
  assert.deepEqual(applyDelta(base, diffMessage(base, rewritten)!), rewritten);
  const clipped: MessageView = { ...base, content: [{ type: "thinking", text: "plan" }, { type: "text", text: "Hello", total: 900 }] };
  assert.deepEqual(applyDelta(base, diffMessage(base, clipped)!), clipped);
  assert.throws(() => applyDelta(base, [{ i: 7, append: "x" }]));
});

test("the shared reducer keeps tools across agent_state and pages merge without duplicates", () => {
  const state: ProjectionState = {
    session: { id: "s", cwd: "/", leafId: null, branchRevision: 0, olderCursor: "e2", messages: [{ id: "entry:e2", entryId: "e2", role: "user", status: "complete", content: [] }] },
    state: { idle: true, running: false, compacting: false, hasPendingMessages: false, thinking: "off", models: [], uiPrompts: [], tools: [{ id: "t", name: "bash", args: null, status: "running" }] },
    theme: {},
  };
  const next = applyProjectionEvent(state, { type: "agent_state", state: { ...state.state, idle: false, running: true, tools: [] } });
  assert.equal(next.state.tools.length, 1);
  assert.throws(() => applyProjectionEvent(state, { type: "msg_delta", id: "missing", ops: [] }));
  const merged = mergeOlderPage(state.session.messages, [{ id: "entry:e1", entryId: "e1", role: "user", status: "complete", content: [] }, { id: "entry:e2", entryId: "e2", role: "user", status: "complete", content: [] }]);
  assert.deepEqual(merged.map((message) => message.entryId), ["e1", "e2"]);
});

test("thinking timing changes and removals survive the shared delta reducer", () => {
  let before: MessageView = { id: "m", role: "assistant", status: "streaming", content: [{ type: "thinking", text: "plan", timingStatus: "running" }] };
  for (const content of [
    [{ type: "thinking" as const, text: "plan", durationMs: 0, timingStatus: "complete" as const }],
    [{ type: "thinking" as const, text: "plan more", durationMs: 1200, timingStatus: "interrupted" as const }],
    [{ type: "thinking" as const, text: "plan more" }],
  ]) {
    const after = { ...before, content };
    const ops = diffMessage(before, after)!;
    assert.equal(ops.length, 1);
    assert.ok("set" in ops[0]!, "append deltas cannot convey timing metadata changes");
    assert.deepEqual(applyDelta(before, ops), after);
    before = after;
  }
});

test("a setting change names one known setting, a new value and the value the page was showing", () => {
  for (const args of [{ key: "theme", value: "light/dark", expected: null }, { key: "images.blockImages", value: true, expected: false }, { key: "defaultModel", value: "acme/fast", expected: "acme/slow" }])
    assert.equal(hostCommandArgs("setting_set", args), args);
  for (const args of [{ key: "theme", value: "dark" }, { key: "theme", value: null, expected: null }, { key: "httpProxy", value: "x", expected: null }, { key: "theme", value: "dark", expected: null, scope: "project" },
    { key: "theme", value: { name: "dark" }, expected: null }, { key: "theme", value: "", expected: null }, { key: "theme", value: "a\nb", expected: null }, { key: "theme", value: "x".repeat(257), expected: null }, { key: "theme", value: 1, expected: null }])
    assert.throws(() => hostCommandArgs("setting_set", args), { code: "invalid_args" }, JSON.stringify(args));
  assert.deepEqual(hostQueryArgs("theme", { name: "mine" }), { name: "mine" }); assert.deepEqual(hostQueryArgs("themes", {}), {}); assert.deepEqual(hostQueryArgs("settings", {}), {});
  for (const args of [{}, { name: "" }, { name: "x".repeat(65) }, { name: "mine", path: "/etc" }]) assert.throws(() => hostQueryArgs("theme", args), { code: "invalid_args" });
  assert.throws(() => hostQueryArgs("settings", { raw: true }), { code: "invalid_args" });
});
