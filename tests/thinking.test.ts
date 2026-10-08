import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Bridge, type BridgeOptions } from "../src/extension/bridge.js";
import { applyProjectionEvent, type ContentView, type ProjectionEvent } from "../src/protocol/index.js";

type Source = { role: string; content: Record<string, unknown>[]; stopReason?: string };
const thought = (thinking = "plan") => ({ type: "thinking", thinking });
function fixture() {
  let now = 0;
  const entries: { type: string; id: string; message: Source }[] = [];
  const events: ProjectionEvent[] = [];
  const ctx = {
    cwd: "/fixture", isIdle: () => true, hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => "thinking", getBranch: () => entries, getLeafId: () => entries.at(-1)?.id ?? null, getSessionName: () => undefined },
    modelRegistry: { getAvailable: () => [] }, ui: { theme: { appearance: "dark", colors: {} } },
  } as unknown as ExtensionContext;
  const bridge = new Bridge({ ctx, pi: { getThinkingLevel: () => "off" } as BridgeOptions["pi"], generation: 1, now: () => now, pollMs: 60_000 });
  bridge.setObserver({ publish: event => events.push(event), reset: () => {}, switching: () => {} });
  const update = (message: Source, type: string, contentIndex = 0) => bridge.handleEvent({ type: "message_update", message, assistantMessageEvent: { type, contentIndex } });
  return { bridge, entries, events, update, time: (value: number) => { now = value; },
    content: () => bridge.snapshot().session.messages.at(-1)!.content,
  };
}
const timed = (content: ContentView) => {
  assert.equal(content.type, "thinking");
  return content as Extract<ContentView, { type: "thinking" }>;
};

test("independent observed thinking intervals survive coalescing, persistence and stable reconnect snapshots", () => {
  const f = fixture();
  try {
    const before = f.bridge.snapshot();
    const message: Source = { role: "assistant", content: [thought()] };
    f.bridge.handleEvent({ type: "message_start", message });
    f.time(100); f.update(message, "thinking_start"); f.bridge.flush();
    assert.deepEqual(timed(f.content()[0]!), { type: "thinking", text: "plan", timingStatus: "running" });
    f.time(500); f.update(message, "thinking_start");
    f.time(1000); f.bridge.flush();
    const during = f.bridge.snapshot();
    f.time(1200);
    assert.deepEqual(f.bridge.snapshot(), during, "snapshot reads do not change timing or invent unsequenced progress");
    f.time(1234); f.update(message, "thinking_end"); f.bridge.flush();
    assert.equal(timed(f.content()[0]!).durationMs, 1134, "a duplicate start does not reset the clock");
    // Unknown source blocks are skipped in the view but must not shift host timing indices.
    message.content.push({ type: "opaque", private: "hidden" }, { type: "text", text: "answer" }, thought("second"));
    f.time(1500); f.update(message, "thinking_start", 3); f.bridge.flush();
    assert.equal(timed(f.content()[0]!).timingStatus, "complete", "text generation does not leave a finished thought running");
    assert.equal(timed(f.content()[2]!).timingStatus, "running");
    f.time(1777); f.update(message, "thinking_end", 3);
    f.bridge.handleEvent({ type: "message_end", message });
    f.entries.push({ type: "message", id: "persisted", message });
    f.bridge.handleEvent({ type: "turn_end" });
    const after = f.bridge.snapshot();
    assert.deepEqual(after.session.messages[0]!.content, [
      { type: "thinking", text: "plan", durationMs: 1134, timingStatus: "complete" },
      { type: "text", text: "answer" },
      { type: "thinking", text: "second", durationMs: 277, timingStatus: "complete" },
    ]);
    const replayed = f.events.reduce((state, event) => applyProjectionEvent(state, event), before);
    assert.deepEqual(replayed.session.messages, after.session.messages, "one shared reducer reproduces canonical snapshot timing");
    f.time(50_000);
    assert.deepEqual(f.bridge.snapshot(), after, "completed durations remain fixed on reconnect");
  } finally { f.bridge.dispose(); }
});

test("unpaired thinking starts stop honestly on aborted, failed, incomplete or settled messages", () => {
  for (const outcome of ["aborted", "error", "stop", "agent_end", "agent_settled"] as const) {
    const f = fixture();
    try {
      const message: Source = { role: "assistant", content: [thought()] };
      f.bridge.handleEvent({ type: "message_start", message });
      f.time(10); f.update(message, "thinking_start");
      f.time(1010);
      if (outcome === "agent_end" || outcome === "agent_settled") f.bridge.handleEvent({ type: outcome });
      else { message.stopReason = outcome; f.bridge.handleEvent({ type: "message_end", message }); }
      assert.deepEqual(timed(f.content()[0]!), { type: "thinking", text: "plan", durationMs: 1000, timingStatus: "interrupted" });
      assert.equal(f.bridge.snapshot().session.messages[0]!.status, "complete");
      f.time(9999); f.bridge.handleEvent({ type: "agent_end" });
      assert.equal(timed(f.content()[0]!).durationMs, 1000, "later lifecycle events do not extend the interval");
    } finally { f.bridge.dispose(); }
  }
});

test("historical thoughts and missed start events have unknown duration", () => {
  const f = fixture();
  try {
    const message: Source = { role: "assistant", content: [thought()] };
    f.entries.push({ type: "message", id: "history", message });
    assert.deepEqual(f.content(), [{ type: "thinking", text: "plan" }]);
    const live: Source = { role: "assistant", content: [thought("midstream")] };
    f.bridge.handleEvent({ type: "message_start", message: live });
    f.time(100); f.update(live, "thinking_delta");
    f.time(300); f.update(live, "thinking_end");
    f.bridge.handleEvent({ type: "message_end", message: live });
    assert.deepEqual(f.content(), [{ type: "thinking", text: "midstream" }]);
  } finally { f.bridge.dispose(); }
});

test("zero durations are retained across source clones and canonical rewrites do not inherit unrelated timing", () => {
  const f = fixture();
  try {
    let message: Source = { role: "assistant", content: [thought()] };
    f.bridge.handleEvent({ type: "message_start", message });
    f.update(message, "thinking_start");
    message = structuredClone(message);
    f.update(message, "thinking_end");
    f.bridge.handleEvent({ type: "message_end", message });
    f.entries.push({ type: "message", id: "same-entry", message });
    f.bridge.handleEvent({ type: "turn_end" });
    assert.equal(timed(f.content()[0]!).durationMs, 0);
    f.entries[0]!.message = structuredClone(message);
    f.bridge.handleEvent({ type: "session_compact_failed" });
    f.bridge.handleEvent({ type: "turn_end" });
    assert.equal(timed(f.content()[0]!).durationMs, 0, "stable entry identity transfers observed timing to a replacement source object");
    f.entries[0]!.message.content[0] = thought("rewritten thought");
    f.bridge.handleEvent({ type: "turn_end" });
    assert.deepEqual(f.content(), [{ type: "thinking", text: "rewritten thought" }]);
  } finally { f.bridge.dispose(); }
});

test("branch and session lifecycle clears timing while keeping historical content", () => {
  const f = fixture();
  const message: Source = { role: "assistant", content: [thought()] };
  try {
    f.bridge.handleEvent({ type: "message_start", message });
    f.update(message, "thinking_start");
    f.time(300); f.update(message, "thinking_end");
    f.bridge.handleEvent({ type: "message_end", message });
    f.entries.push({ type: "message", id: "retained", message });
    f.bridge.handleEvent({ type: "turn_end" });
    assert.equal(timed(f.content()[0]!).durationMs, 300);
    f.bridge.handleEvent({ type: "session_before_tree" });
    f.bridge.handleEvent({ type: "session_tree" });
    assert.deepEqual(f.content(), [{ type: "thinking", text: "plan" }]);
    f.bridge.dispose();
    f.bridge.handleEvent({ type: "message_update", message, assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } });
    assert.throws(() => f.bridge.snapshot(), /replaced/);
  } finally { f.bridge.dispose(); }
});

test("superseding an unfinished assistant message stops its observed interval", () => {
  const f = fixture();
  try {
    const message: Source = { role: "assistant", content: [thought()] };
    f.bridge.handleEvent({ type: "message_start", message });
    f.update(message, "thinking_start");
    f.time(500);
    f.bridge.handleEvent({ type: "message_start", message: { role: "assistant", content: [thought("next")] } });
    const messages = f.bridge.snapshot().session.messages;
    assert.equal(messages[0]!.status, "complete");
    assert.equal(timed(messages[0]!.content[0]!).durationMs, 500);
    assert.deepEqual(messages[1]!.content, [{ type: "thinking", text: "next" }]);
  } finally { f.bridge.dispose(); }
});
