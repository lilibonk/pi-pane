import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Bridge, type BridgeOptions } from "../src/extension/bridge.js";
import type { ProjectionEvent } from "../src/protocol/index.js";
import { LIMITS, applyProjectionEvent, type MessageView, type Snapshot } from "../src/protocol/index.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture() {
  let current = true;
  const entries: unknown[] = [];
  const events: ProjectionEvent[] = [];
  const model = { provider: "fixture", id: "fixture", name: "Fixture" };
  const ctx = {
    cwd: "/fixture", model, isIdle: () => true, hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => "fixture", getBranch: () => entries, getLeafId: () => (entries.at(-1) as { id?: string } | undefined)?.id ?? null, getSessionName: () => undefined },
    modelRegistry: { getAvailable: () => [model], find: () => model },
    ui: { theme: { appearance: "dark", colors: {} } },
  } as unknown as ExtensionContext;
  const pi: BridgeOptions["pi"] = { getThinkingLevel: () => "off" };
  const bridge = new Bridge({ pi, ctx, generation: 1, isCurrent: () => current, pollMs: 60_000 });
  bridge.setObserver({ publish: (event) => events.push(event), reset: () => {}, switching: () => {} });
  return { bridge, entries, events, stale: () => { current = false; } };
}

test("a replaced RPC projection refuses reads and ignores delayed events", () => {
  const f = fixture();
  try {
    f.stale();
    assert.throws(() => f.bridge.snapshot(), /replaced/);
    f.bridge.handleEvent({ type: "agent_start" });
    assert.equal(f.events.length, 0);
  } finally { f.bridge.dispose(); }
});

test("a disposed projection cannot expose a stale session", () => {
  const f = fixture();
  f.bridge.dispose();
  assert.throws(() => f.bridge.snapshot(), /replaced/);
  f.bridge.handleEvent({ type: "message_start", message: { role: "user", content: "stale" } });
  assert.equal(f.events.length, 0);
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

test("successful compaction replaces the attached window in one event and retains an active partial", () => {
  const f = fixture();
  try {
    for (let index = 0; index < LIMITS.snapshotWindowMessages + 2; index++) {
      f.entries.push({ type: "message", id: `history-${index}`, message: { role: "user", content: `history ${index}` } });
    }
    f.bridge.snapshot();
    const partial = { role: "assistant", content: [{ type: "text", text: "still streaming" }] };
    f.bridge.handleEvent({ type: "message_start", message: partial });
    f.events.length = 0;
    f.entries.push({ type: "compaction", id: "compact-marker" });
    f.bridge.handleEvent({ type: "session_compact" });
    const snapshot = f.bridge.snapshot();
    const windows = f.events.filter((event) => event.type === "history_window");
    assert.equal(windows.length, 1);
    const window = windows[0] as Extract<ProjectionEvent, { type: "history_window" }>;
    assert.deepEqual(window.messages, snapshot.session.messages);
    assert.equal(window.olderCursor, snapshot.session.olderCursor);
    assert.ok(window.olderCursor, "older history stays reachable through paging");
    assert.equal(window.messages.length, LIMITS.snapshotWindowMessages + 1);
    assert.equal(new Set(window.messages.map((message) => message.id)).size, window.messages.length);
    assert.ok(window.messages.some((message) => message.entryId === "compact-marker"));
    assert.equal(window.messages.at(-1)?.status, "streaming");
    assert.deepEqual(window.messages.at(-1)?.content, [{ type: "text", text: "still streaming" }]);
  } finally { f.bridge.dispose(); }
});

test("history pages walk the whole branch in order without duplicates", () => {
  const f = fixture();
  try {
    const total = 600;
    for (let index = 0; index < total; index++)
      f.entries.push({ type: "message", id: `e${index}`, message: { role: index % 2 ? "assistant" : "user", content: [{ type: "text", text: `${index}:${"x".repeat(3000)}` }] } });
    const snapshot = f.bridge.snapshot();
    let bytes = 0;
    for (const message of snapshot.session.messages) bytes += Buffer.byteLength(JSON.stringify(message));
    assert.ok(bytes <= LIMITS.snapshotWindowBytes, "snapshot window respects its byte budget");
    assert.ok(snapshot.session.olderCursor);
    let messages = snapshot.session.messages;
    let cursor: string | null = snapshot.session.olderCursor;
    let pages = 0;
    while (cursor) {
      const page = f.bridge.historyPage(cursor, 0);
      assert.ok(page.messages.length > 0);
      messages = [...page.messages, ...messages];
      cursor = page.olderCursor;
      pages++;
    }
    assert.ok(pages >= 2);
    assert.deepEqual(messages.map((message) => message.entryId), f.entries.map((entry) => (entry as { id: string }).id));
    assert.throws(() => f.bridge.historyPage("missing", 0), /cursor/);
    assert.throws(() => f.bridge.historyPage("e10", 1), /Refresh/);
  } finally { f.bridge.dispose(); }
});

test("oversized blocks keep their index and are readable in full through content pages", () => {
  const f = fixture();
  try {
    const long = "a".repeat(LIMITS.messageChars + 200_000) + "END";
    f.entries.push({ type: "message", id: "big", message: { role: "toolResult", toolCallId: "t1", toolName: "edit", content: [{ type: "text", text: long }], details: { patch: "@@ -1 +1 @@\n-old\n+new\n" } } });
    const message = f.bridge.snapshot().session.messages[0]!;
    const block = message.content[0]!;
    assert.equal(block.type, "text");
    assert.equal(block.type === "text" && block.text.length, LIMITS.messageChars);
    assert.equal(block.type === "text" && block.total, long.length);
    const diff = message.content[1]!;
    assert.equal(diff.type, "diff", "the edit patch is a separate block even when the budget is exhausted");
    assert.equal(diff.type === "diff" && diff.text, "");
    let text = "";
    while (text.length < long.length) {
      const page = f.bridge.contentPage(message.id, 0, text.length);
      assert.equal(page.total, long.length);
      assert.ok(page.final);
      text += page.text;
    }
    assert.equal(text, long);
    assert.equal(f.bridge.contentPage(message.id, 1, 0).text, "@@ -1 +1 @@\n-old\n+new\n");
    assert.throws(() => f.bridge.contentPage("unknown", 0, 0), /no longer retained/);
  } finally { f.bridge.dispose(); }
});

test("streaming updates coalesce into append-only deltas that rebuild the snapshot state", () => {
  const f = fixture();
  try {
    const before = { t: "snapshot", epoch: "e", seq: 0, ...f.bridge.snapshot() } as Snapshot;
    const message = { role: "assistant", content: [{ type: "text", text: "" }] };
    f.bridge.handleEvent({ type: "message_start", message });
    for (const piece of ["Hel", "lo", ", ", "world"]) {
      message.content[0]!.text += piece;
      f.bridge.handleEvent({ type: "message_update", message });
    }
    const deltasBeforeFlush = f.events.filter((event) => event.type === "msg_delta").length;
    f.bridge.flush();
    const deltas = f.events.filter((event) => event.type === "msg_delta");
    assert.equal(deltasBeforeFlush, 0, "updates are coalesced until the flush window");
    assert.equal(deltas.length, 1);
    assert.deepEqual("ops" in deltas[0]! && deltas[0].ops, [{ i: 0, append: "Hello, world" }]);
    let state: Snapshot = before;
    for (const event of f.events) state = applyProjectionEvent(state, event);
    const after = f.bridge.snapshot();
    assert.deepEqual(state.session.messages, after.session.messages);
    assert.equal((state.session.messages[0] as MessageView).status, "streaming");
  } finally { f.bridge.dispose(); }
});

test("images project as metadata, are read by block index, without inlining bytes", async () => {
  const { png } = await import("./fixtures/images.ts");
  const f = fixture();
  try {
    const data = png(6, 4).toString("base64");
    f.entries.push(
      { type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "look" }, { type: "image", mimeType: "image/png", data }] } },
      { type: "message", id: "r1", message: { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "Read image file" }, { type: "image", mimeType: "image/png", data: "@@not-base64" }] } },
    );
    const [user, result] = f.bridge.snapshot().session.messages;
    assert.deepEqual(user!.content[1], { type: "image", mimeType: "image/png", bytes: Buffer.from(data, "base64").length, width: 6, height: 4 });
    assert.ok(!JSON.stringify(user).includes(data.slice(0, 32)), "snapshots never inline image bytes");
    assert.deepEqual(f.bridge.imagePage(user!.id, 1), { messageId: user!.id, index: 1, mimeType: "image/png", data });
    assert.throws(() => f.bridge.imagePage(user!.id, 0), /not an image/);
    assert.throws(() => f.bridge.imagePage(result!.id, 1), /not valid base64/);
    assert.throws(() => f.bridge.contentPage(user!.id, 1, 0), /no readable text/);

  } finally { f.bridge.dispose(); }
});
