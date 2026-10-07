import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Bridge, type BridgeOptions } from "../src/extension/bridge.js";
import type { CommandResult, ProjectionEvent } from "../src/protocol/index.js";
import { M0_MAX_MESSAGES } from "../src/protocol/index.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture() {
  let current = true;
  const entries: unknown[] = [];
  let resolveModel: (value: boolean) => void = () => {};
  let compactCallbacks: { onComplete?: (result: never) => void; onError?: (error: Error) => void } | undefined;
  const sent: { text: unknown; options: unknown }[] = [];
  const events: ProjectionEvent[] = [];
  const model = { provider: "fixture", id: "fixture", name: "Fixture" };
  const ctx = {
    cwd: "/fixture", model, isIdle: () => true, hasPendingMessages: () => false,
    abort: () => {}, compact: (callbacks: typeof compactCallbacks) => { compactCallbacks = callbacks; },
    sessionManager: { getSessionId: () => "fixture", getBranch: () => entries, getLeafId: () => null, getSessionName: () => undefined },
    modelRegistry: { getAvailable: () => [model], find: () => model },
    ui: { theme: { appearance: "dark", colors: {} } },
  } as unknown as ExtensionContext;
  const pi: BridgeOptions["pi"] = {
    sendUserMessage: (text, options) => { sent.push({ text, options }); },
    getThinkingLevel: () => "off", setThinkingLevel: () => {},
    setModel: () => new Promise<boolean>((resolve) => { resolveModel = resolve; }),
  };
  const bridge = new Bridge({ pi, ctx, generation: 1, isCurrent: () => current, pollMs: 60_000 });
  bridge.setObserver({ publish: (event) => events.push(event), reset: () => {}, switching: () => {} });
  return { bridge, entries, sent, events,
    stale: () => { current = false; }, resolveModel: (value: boolean) => resolveModel(value),
    compactSuccess: () => compactCallbacks?.onComplete?.(undefined as never),
    compactFailure: () => compactCallbacks?.onError?.(new Error("late fixture error")),
  };
}

test("a void prompt only dispatches literal text with an explicit delivery mode", () => {
  const f = fixture();
  try {
    const results: unknown[] = [];
    f.bridge.dispatch("prompt", { text: "/fixture literal" }, (result) => results.push(result));
    assert.deepEqual(f.sent, [{ text: "/fixture literal", options: { deliverAs: "followUp", expandPromptTemplates: false } }]);
    assert.deepEqual(results, [], "the bridge must not invent a completion for the void API");
  } finally { f.bridge.dispose(); }
});

test("model completion after generation replacement cannot publish a new-session result", async () => {
  const f = fixture();
  try {
    const results: unknown[] = [];
    f.bridge.dispatch("set_model", { provider: "fixture", id: "fixture" }, (result) => results.push(result));
    f.stale(); f.resolveModel(true); await tick();
    assert.deepEqual(results, []);
    assert.equal(f.events.length, 0);
  } finally { f.bridge.dispose(); }
});

test("model completion from before a branch change is discarded even within one generation", async () => {
  const f = fixture();
  try {
    const results: unknown[] = [];
    f.bridge.dispatch("set_model", { provider: "fixture", id: "fixture" }, (result) => results.push(result));
    f.bridge.handleEvent({ type: "session_before_tree" });
    f.bridge.handleEvent({ type: "session_tree" });
    assert.equal(f.bridge.branchRevision, 1);
    f.resolveModel(true); await tick();
    assert.deepEqual(results, []);
  } finally { f.bridge.dispose(); }
});

test("compact callbacks after disposal have no observable side effects", async () => {
  for (const outcome of ["success", "failure"] as const) {
    const f = fixture();
    const results: Partial<CommandResult>[] = [];
    f.bridge.dispatch("compact", {}, (result) => results.push(result));
    f.bridge.dispose();
    outcome === "success" ? f.compactSuccess() : f.compactFailure();
    await tick();
    assert.deepEqual(results, []);
    assert.equal(f.events.length, 0);
  }
});

test("reconciliation keeps identical messages distinct and reads post-handler final content", () => {
  const f = fixture();
  try {
    for (let index = 0; index < 2; index++) {
      const message = { role: "assistant", timestamp: 1, content: [{ type: "text", text: "same text" }] };
      f.bridge.handleEvent({ type: "message_start", message });
      f.bridge.handleEvent({ type: "message_end", message });
      // Pi persists this same object after the event and may mutate it in another handler.
      message.content[0]!.text = "same final text";
      f.entries.push({ type: "message", id: `entry-${index}`, message });
      f.bridge.handleEvent({ type: "turn_end" });
    }
    const snapshot = f.bridge.snapshot();
    assert.equal(snapshot.session.messages.length, 2);
    assert.notEqual(snapshot.session.messages[0]!.id, snapshot.session.messages[1]!.id);
    assert.deepEqual(snapshot.session.messages.map((message) => message.entryId), ["entry-0", "entry-1"]);
    for (const message of snapshot.session.messages) assert.deepEqual(message.content, [{ type: "text", text: "same final text" }]);
  } finally { f.bridge.dispose(); }
});

test("internal empty system updates are omitted without hiding genuine system text", () => {
  const f = fixture();
  try {
    f.entries.push(
      { type: "message", id: "internal", message: { role: "system", content: "", sections: { tools: "internal prompt section" } } },
      { type: "message", id: "visible", message: { role: "system", content: "Visible system note" } },
    );
    const messages = f.bridge.snapshot().session.messages;
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.entryId, "visible");
    assert.deepEqual(messages[0]!.content, [{ type: "text", text: "Visible system note" }]);
  } finally { f.bridge.dispose(); }
});

test("successful compaction publishes the same bounded history as resync and retains an active partial", () => {
  const f = fixture();
  try {
    for (let index = 0; index < M0_MAX_MESSAGES + 2; index++) {
      f.entries.push({ type: "message", id: `history-${index}`, message: { role: "user", content: `history ${index}` } });
    }
    f.bridge.syncHistory();
    const partial = { role: "assistant", content: [{ type: "text", text: "still streaming" }] };
    f.bridge.handleEvent({ type: "message_start", message: partial });
    f.events.length = 0;
    f.entries.push({ type: "compaction", id: "compact-marker" });
    f.bridge.handleEvent({ type: "session_compact" });
    const snapshot = f.bridge.snapshot();
    const published = f.events.flatMap((event) => "message" in event ? [event.message] : []);
    assert.deepEqual(published, snapshot.session.messages);
    assert.equal(published.length, M0_MAX_MESSAGES);
    assert.equal(snapshot.session.historyTruncated, true);
    assert.equal(new Set(published.map((message) => message.id)).size, published.length);
    assert.ok(published.some((message) => message.entryId === "compact-marker"));
    assert.equal(published.at(-1)?.status, "streaming");
    assert.deepEqual(published.at(-1)?.content, [{ type: "text", text: "still streaming" }]);
  } finally { f.bridge.dispose(); }
});
