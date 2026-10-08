import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Bridge, type BridgeOptions } from "../src/extension/bridge.js";
import type { MessageView, ProjectionEvent } from "../src/protocol/index.js";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const textOf = (message: MessageView) => message.content.filter((part) => part.type !== "toolCall").map((part) => part.text).join("");
function fixture(pollMs = 20) {
  const entries: Record<string, unknown>[] = [];
  const events: ProjectionEvent[] = [];
  const ctx = {
    cwd: "/fixture", isIdle: () => true, hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => "extra", getBranch: () => entries, getLeafId: () => entries.at(-1)?.id ?? null, getSessionName: () => undefined },
    modelRegistry: { getAvailable: () => [] }, ui: { theme: { appearance: "dark", colors: {} } },
  } as unknown as ExtensionContext;
  const pi = { getThinkingLevel: () => "off" } as BridgeOptions["pi"];
  const bridge = new Bridge({ pi, ctx, generation: 1, pollMs });
  bridge.setObserver({ publish: (event) => events.push(event), reset: () => {}, switching: () => {} });
  return { bridge, entries, events, messages: () => events.filter((event) => "message" in event).map((event) => (event as { message: MessageView }).message) };
}

test("idle leaf polling publishes only visible custom messages and never extension private data", async () => {
  const f = fixture();
  try {
    f.entries.push(
      { type: "custom_message", id: "visible", display: true, content: "Visible idle update", details: { secret: "DO_NOT_SEND" } },
      { type: "custom_message", id: "hidden", display: false, content: "HIDDEN_CONTENT" },
      { type: "custom", id: "internal", data: { secret: "INTERNAL_DATA" } },
    );
    await pause(100);
    assert.deepEqual(f.messages().map(textOf), ["Visible idle update"]);
    assert.doesNotMatch(JSON.stringify(f.events), /DO_NOT_SEND|HIDDEN_CONTENT|INTERNAL_DATA/);
    await pause(50);
    assert.equal(f.messages().length, 1, "an unchanged leaf must not republish entries");
  } finally { f.bridge.dispose(); }
});

test("a snapshot does not consume a passive update needed by other connected viewers", async () => {
  const f = fixture();
  try {
    f.entries.push({ type: "custom_message", id: "custom", display: true, content: "For all viewers" });
    assert.equal(textOf(f.bridge.snapshot().session.messages[0]!), "For all viewers");
    assert.equal(f.messages().length, 0, "snapshot construction is not a broadcast");
    await pause(100);
    assert.deepEqual(f.messages().map(textOf), ["For all viewers"]);
  } finally { f.bridge.dispose(); }
});

test("reconciliation emits an earlier idle custom entry before a subsequent live user message", () => {
  const f = fixture(60_000);
  try {
    f.entries.push({ type: "custom_message", id: "custom", display: true, content: "Earlier" });
    f.bridge.handleEvent({ type: "message_start", message: { role: "user", content: "Later" } });
    assert.deepEqual(f.messages().map(textOf), ["Earlier", "Later"]);
  } finally { f.bridge.dispose(); }
});

test("bash execution and generic output use explicit text fields without leaking host metadata", () => {
  const f = fixture();
  try {
    f.entries.push(
      { type: "message", id: "bash", message: { role: "bashExecution", command: "printf fixture", output: "fixture", exitCode: 7,
        cancelled: false, truncated: false, fullOutputPath: "/DO_NOT_SEND", details: { secret: "INTERNAL_DATA" } } },
      { type: "message", id: "output", message: { role: "toolResult", content: "", output: "Fallback output" } },
    );
    const messages = f.bridge.snapshot().session.messages;
    assert.equal(textOf(messages[0]!), "$ printf fixture\n[Exit code: 7]\nfixture");
    assert.equal(textOf(messages[1]!), "Fallback output");
    assert.doesNotMatch(JSON.stringify(messages), /DO_NOT_SEND|INTERNAL_DATA|fullOutputPath/);
  } finally { f.bridge.dispose(); }
});

test("body, error and bash output share the single-message character budget and advertise clipping", () => {
  const f = fixture();
  try {
    f.entries.push(
      { type: "message", id: "error", message: { role: "assistant", content: [{ type: "text", text: "a".repeat(32_760) }], errorMessage: "e".repeat(32_768) } },
      { type: "message", id: "bash", message: { role: "bashExecution", command: "fixture", exitCode: 1, output: "b".repeat(32_768), errorMessage: "e".repeat(32_768) } },
      { type: "message", id: "host-truncated", message: { role: "bashExecution", command: "fixture", output: "small", truncated: true, cancelled: true } },
    );
    const [error, bash, hostTruncated] = f.bridge.snapshot().session.messages;
    for (const message of [error!, bash!]) {
      assert.equal(textOf(message).length, 32_768);
      assert.ok(message.content.some((part) => part.type !== "toolCall" && part.total !== undefined), "clipped blocks advertise their full length");
    }
    assert.equal(textOf(error!).slice(-8), "eeeeeeee");
    assert.match(textOf(hostTruncated!), /Cancelled/); assert.equal(hostTruncated!.truncated, true);
  } finally { f.bridge.dispose(); }
});
