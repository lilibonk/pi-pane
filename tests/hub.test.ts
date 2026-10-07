import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { Hub, type HubOptions } from "../src/extension/hub.ts";
import type { Bridge, BridgeObserver } from "../src/extension/bridge.ts";
import { COMMANDS, type CommandEnvelope, type ServerMessage } from "../src/protocol/index.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(predicate: () => T | undefined | false, label: string, timeout = 2_000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = predicate(); if (value) return value; await delay(5); }
  throw new Error(`Timed out: ${label}`);
}
async function fixture(options: Partial<HubOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-pane-hub-test-"));
  await writeFile(join(directory, "index.html"), "<!doctype html><title>test</title>");
  let calls = 0;
  let observer: BridgeObserver | undefined;
  const bridge = {
    sessionId: "fixture-session", branchRevision: 0, isCurrent: () => true,
    setObserver: (value: BridgeObserver | undefined) => { observer = value; },
    dispatch: () => { calls++; },
    snapshot: () => ({
      session: { id: "fixture-session", cwd: "/fixture", leafId: null, branchRevision: 0, messages: [], historyTruncated: false },
      state: { idle: true, running: false, compacting: false, hasPendingMessages: false, thinking: "off", models: [], tools: [], uiPrompts: [] },
      theme: {}, caps: { commands: COMMANDS, images: false, promptReceipt: "dispatch_only", queueView: "boolean", terminalDialogs: true, history: "bounded_spike" },
    }),
  } as unknown as Bridge;
  const hub = new Hub({ port: 0, webRoot: directory, ...options });
  await hub.start(); hub.bindBridge(bridge);
  return { hub, calls: () => calls, observer: () => observer,
    async close() { await hub.close(); await rm(directory, { recursive: true, force: true }); } };
}
async function client(hub: Hub, clientId?: string) {
  const socket = new WebSocket(`${hub.origin.replace("http:", "ws:")}/ws`, ["pi-pane.v1", `pi-pane.bearer.${hub.token}`], { origin: hub.origin });
  const frames: ServerMessage[] = [];
  let closed = false;
  socket.on("error", () => {});
  socket.on("close", () => { closed = true; });
  socket.on("message", (raw) => frames.push(JSON.parse(raw.toString()) as ServerMessage));
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  const send = (value: unknown) => socket.send(JSON.stringify(value));
  send({ t: "hello", ...(clientId ? { clientId } : {}) });
  await until(() => frames[0], "hello response");
  return { socket, frames, send, closed: () => closed,
    async wait(type: string, from = 0) { return until(() => frames.slice(from).find((frame) => frame.t === type), type); },
    async close() { socket.close(); await until(() => closed, "close"); } };
}
function envelope(clientId: string, hub: Hub, commandNo: number): CommandEnvelope {
  return { t: "command", clientId, commandNo, id: `${clientId}:${commandNo}`, epoch: hub.epoch,
    sessionId: "fixture-session", branchRevision: 0, command: "prompt", args: { text: "test" } };
}

test("dedupe high-water mark survives receipt eviction and rejected commands consume their number", async () => {
  const f = await fixture({ receiptLimit: 2 });
  try {
    const c = await client(f.hub);
    const welcome = c.frames.find((frame) => frame.t === "welcome"); assert.ok(welcome?.t === "welcome");
    const first = envelope(welcome.clientId, f.hub, 1);
    c.send(first); let ack = await c.wait("ack"); assert.ok(ack.t === "ack"); assert.equal(ack.nextCommandNo, 2);
    let from = c.frames.length; c.send(first); await c.wait("ack", from); assert.equal(f.calls(), 1);
    from = c.frames.length; c.send({ ...first, args: { text: "changed" } });
    let conflict = await c.wait("ack", from); assert.ok(conflict.t === "ack"); assert.equal(conflict.error?.code, "command_conflict");
    from = c.frames.length; c.send({ ...envelope(welcome.clientId, f.hub, 2), epoch: "stale" });
    ack = await c.wait("ack", from); assert.ok(ack.t === "ack"); assert.equal(ack.status, "rejected"); assert.equal(ack.nextCommandNo, 3);
    from = c.frames.length; c.send(envelope(welcome.clientId, f.hub, 3)); await c.wait("ack", from); assert.equal(f.calls(), 2);
    from = c.frames.length; c.send(first); conflict = await c.wait("ack", from); assert.ok(conflict.t === "ack"); assert.equal(conflict.error?.code, "result_unavailable");
    assert.equal(f.calls(), 2, "an evicted receipt is not permission to dispatch again");
    from = c.frames.length; c.send({ t: "receipt_query", clientId: welcome.clientId, id: `${welcome.clientId}:99` });
    const error = await c.wait("error", from); assert.ok(error.t === "error"); assert.equal(error.error.code, "not_seen");
    assert.equal(f.calls(), 2, "receipt lookup has no host side effect");
  } finally { await f.close(); }
});

test("two browser leases receive contiguous shared events, while ack does not consume seq", async () => {
  const f = await fixture();
  try {
    const a = await client(f.hub); const b = await client(f.hub);
    const welcome = a.frames.find((frame) => frame.t === "welcome"); assert.ok(welcome?.t === "welcome");
    a.send(envelope(welcome.clientId, f.hub, 1)); await a.wait("ack"); assert.equal(f.hub.seq, 0);
    f.observer()?.publish({ type: "session_meta", name: "one" });
    f.observer()?.publish({ type: "session_meta", name: "two" });
    await until(() => b.frames.filter((frame) => frame.t === "event").length === 2, "two broadcast events");
    for (const c of [a, b]) assert.deepEqual(c.frames.filter((frame) => frame.t === "event").map((frame) => frame.seq), [1, 2]);
  } finally { await f.close(); }
});

test("expired client lease cannot be resurrected through reconnect", async () => {
  const f = await fixture({ leaseMs: 40 });
  try {
    const first = await client(f.hub); const welcome = first.frames.find((frame) => frame.t === "welcome"); assert.ok(welcome?.t === "welcome");
    await first.close(); await delay(60);
    const second = await client(f.hub, welcome.clientId);
    const error = second.frames.find((frame) => frame.t === "error"); assert.ok(error?.t === "error"); assert.equal(error.error.code, "client_expired");
    assert.equal(f.calls(), 0);
  } finally { await f.close(); }
});

test("missing Bridge rebind expires and releases the listening port", async () => {
  const f = await fixture();
  try {
    await client(f.hub);
    let expired = 0;
    f.hub.suspend("reload", () => { expired++; }, 25);
    await until(() => !f.hub.running, "Hub stops after rebind timeout");
    assert.equal(expired, 1);
    await assert.rejects(() => fetch(`${f.hub.origin}/healthz`));
  } finally { await f.close(); }
});

test("unauthenticated static file access remains confined to the built web root", async () => {
  const f = await fixture();
  try {
    const index = await fetch(f.hub.origin); assert.equal(index.status, 200);
    assert.match(index.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    // Encoded separators survive URL normalization and must be rejected by the server.
    const escape = await fetch(`${f.hub.origin}/..%2fsecret.txt`); assert.equal(escape.status, 403);
    const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${f.hub.origin}/healthz`, { headers: { Host: "evil.invalid" } }, (response) => { response.resume(); resolve(response.statusCode); });
      req.on("error", reject); req.end();
    });
    assert.equal(wrongHost, 403);
  } finally { await f.close(); }
});
