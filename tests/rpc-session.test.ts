import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RpcSessionMirror } from "../src/extension/rpc-session.js";
import { Bridge } from "../src/extension/bridge.js";
import { RpcReadTimeoutError, type RpcConnection, type RpcRecord } from "../src/extension/rpc-child.js";

class Wire implements RpcConnection {
  running = true; diagnostics = ""; exited = Promise.resolve(0); records: Record<string, unknown>[] = []; listeners = new Set<(record: RpcRecord) => void>();
  start() {} async stop() { this.running = false; } respondUi() {}
  onRecord(listener: (record: RpcRecord) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(record: RpcRecord) { for (const listener of this.listeners) listener(record); }
  async request<T>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
    if (type === "get_state") return { sessionId: "fixture", sessionFile: "/fixture/session.jsonl", thinkingLevel: "high", isStreaming: false, pendingMessageCount: 0, model: { provider: "local", id: "fixture" } } as T;
    if (type === "get_available_models") return { models: [{ provider: "local", id: "fixture", name: "Fixture" }] } as T;
    if (type === "get_entries") {
      const index = this.records.findIndex(record => record.id === payload.since);
      return { entries: structuredClone(payload.since ? this.records.slice(index + 1) : this.records), leafId: this.records.at(-1)?.id ?? null } as T;
    }
    throw new Error(`Unexpected RPC ${type}`);
  }
}
async function fixture(run: (wire: Wire, mirror: RpcSessionMirror, bridge: Bridge, setNow: (now: number) => void) => Promise<void>) {
  const wire = new Wire(); const theme = { appearance: "dark", colors: {} } as unknown as ExtensionContext["ui"]["theme"];
  const mirror = new RpcSessionMirror(wire, "/fixture", () => theme, () => [], () => {}); await mirror.load(); let now = 0;
  const bridge = new Bridge({ pi: mirror.api(), ctx: mirror.context(), generation: 1, pollMs: 60_000, now: () => now }); mirror.attach(bridge);
  try { await run(wire, mirror, bridge, value => { now = value; }); } finally { mirror.dispose(); bridge.dispose(); }
}
const entry = (id: string, parentId: string | null, role: string, text: string, timestamp = 10) => ({ type: "message", id, parentId, message: { role, timestamp, content: role === "user" ? text : [{ type: "text", text }] } });
const text = (bridge: Bridge) => bridge.snapshot().session.messages.map(message => message.content.map(block => "text" in block ? block.text : "").join(""));

test("same-millisecond same-role messages remain distinct and durable post-handler text is authoritative", async () => fixture(async (wire, mirror, bridge) => {
  const one = { role: "user", timestamp: 10, content: "same" }; const two = { role: "user", timestamp: 10, content: "same" };
  for (const message of [one, two]) { wire.emit({ type: "message_start", message }); wire.emit({ type: "message_end", message: structuredClone(message) }); }
  wire.records = [entry("one", null, "user", "first transformed"), entry("two", "one", "user", "second transformed")];
  await mirror.synchronize(); assert.equal((mirror.context().sessionManager.getEntry("one") as unknown as { message: unknown })?.message, one); assert.equal((mirror.context().sessionManager.getEntry("two") as unknown as { message: unknown })?.message, two);
  assert.notEqual(one, two); assert.deepEqual(text(bridge), ["first transformed", "second transformed"]);
}));
test("persisted-before-end retains one bubble and replaces terminal-event text with final durable content", async () => fixture(async (wire, mirror, bridge) => {
  const message = { role: "assistant", timestamp: 10, content: [{ type: "text", text: "live" }] };
  wire.emit({ type: "message_start", message }); wire.records = [entry("answer", null, "assistant", "post-handler durable")];
  await mirror.synchronize(); wire.emit({ type: "message_end", message: { role: "assistant", timestamp: 10, content: [{ type: "text", text: "terminal event" }] } });
  await mirror.synchronize(); assert.deepEqual(text(bridge), ["post-handler durable"]); assert.equal((mirror.context().sessionManager.getEntry("answer") as unknown as { message: unknown })?.message, message);
}));
test("a timed-out full refresh preserves the request and later replaces already cached durable content", async () => fixture(async (wire, mirror, bridge) => {
  const message = { role: "assistant", timestamp: 10, content: [{ type: "text", text: "live" }] };
  wire.emit({ type: "message_start", message });
  wire.records = [entry("answer", null, "assistant", "previously persisted")]; await mirror.synchronize();
  wire.records = [entry("answer", null, "assistant", "final post-handler content")];
  const original = wire.request.bind(wire); const queries: Record<string, unknown>[] = [];
  wire.request = async <T>(type: string, payload: Record<string, unknown> = {}): Promise<T> => {
    if (type === "get_entries") {
      queries.push(payload);
      if (queries.length === 1) throw new RpcReadTimeoutError(type, 30_000);
    }
    return original<T>(type, payload);
  };
  wire.emit({ type: "message_end", message: { role: "assistant", timestamp: 10, content: [{ type: "text", text: "terminal event" }] } });
  await new Promise(resolve => setImmediate(resolve)); // let the failed event refresh settle
  assert.deepEqual(queries, [{}], "the timeout does not cause an implicit retry");
  wire.emit({ type: "agent_settled" });
  await mirror.synchronize();
  assert.deepEqual(queries.slice(0, 2), [{}, {}], "the later event still reloads existing entries instead of fetching only new IDs");
  assert.deepEqual(text(bridge), ["final post-handler content"]); assert.equal(wire.running, true);
}));
test("persisted-before-start pairs new public entries without pairing events to historical entries", async () => fixture(async (wire, mirror, bridge) => {
  wire.records = [entry("new", null, "user", "durable")]; await mirror.synchronize();
  const live = { role: "user", timestamp: 10, content: "wire" }; wire.emit({ type: "message_start", message: live }); wire.emit({ type: "message_end", message: { ...live, content: "wire ending" } });
  await mirror.synchronize(); assert.deepEqual(text(bridge), ["durable"]); assert.equal((mirror.context().sessionManager.getEntry("new") as unknown as { message: unknown })?.message, live);
}));
test("RPC delta forwarding preserves observed thinking interval timing and cumulative text", async () => fixture(async (wire, mirror, bridge, setNow) => {
  const message = { role: "assistant", timestamp: 10, content: [] as unknown[] };
  wire.emit({ type: "message_start", message }); setNow(100);
  wire.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } });
  wire.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "plan" } }); setNow(850);
  wire.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "plan" } });
  bridge.flush();
  const block = bridge.snapshot().session.messages[0]!.content[0]!; assert.equal(block.type, "thinking"); assert.equal("durationMs" in block ? block.durationMs : undefined, 750);
  wire.records = [{ type: "message", id: "thought", parentId: null, message: structuredClone(message) }]; wire.emit({ type: "message_end", message: structuredClone(message) });
  await mirror.synchronize(); assert.equal(bridge.snapshot().session.messages.length, 1); assert.equal("durationMs" in bridge.snapshot().session.messages[0]!.content[0]! ? (bridge.snapshot().session.messages[0]!.content[0] as { durationMs: number }).durationMs : undefined, 750);
}));
test("native RPC tool identity and incomplete JSON arguments are visible before the final toolcall event", async () => fixture(async (wire, _mirror, bridge) => {
  wire.emit({ type: "message_start", message: { role: "assistant", timestamp: 10, content: [] } });
  // pi's public toJsonEvent adds id/toolName and removes provider-specific partial snapshots.
  wire.emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "tool-1", toolName: "echo" } });
  wire.emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '{"text":"partial' } }); bridge.flush();
  const pending = bridge.snapshot().session.messages[0]!.content[0];
  assert.deepEqual(pending, { type: "toolCall", id: "tool-1", name: "echo", arguments: { text: "partial" } });
  wire.emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: ' text"}' } });
  wire.emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: { type: "toolCall", id: "tool-1", name: "echo", arguments: { text: "authoritative end" } } } }); bridge.flush();
  assert.deepEqual(bridge.snapshot().session.messages[0]!.content[0], { type: "toolCall", id: "tool-1", name: "echo", arguments: { text: "authoritative end" } });
}));
