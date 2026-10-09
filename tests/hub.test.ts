import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { Hub, type HubOptions, type HostHandler } from "../src/extension/hub.ts";
import type { Bridge, BridgeObserver } from "../src/extension/bridge.ts";
import { COMMANDS, type CommandEnvelope, type ServerMessage } from "../src/protocol/index.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(predicate: () => T | undefined | false, label: string, timeout = 2_000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = predicate(); if (value) return value; await delay(5); }
  throw new Error(`Timed out: ${label}`);
}
async function fixture(options: Partial<HubOptions> = {}, overrides: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-pane-hub-test-"));
  await writeFile(join(directory, "index.html"), "<!doctype html><title>test</title>");
  let calls = 0;
  let observer: BridgeObserver | undefined;
  const bridge = {
    sessionId: "fixture-session", generation: 1, branchRevision: 0, isCurrent: () => true,
    setObserver: (value: BridgeObserver | undefined) => { observer = value; },
    flush: () => {},
    snapshot: () => ({
      session: { id: "fixture-session", cwd: "/fixture", leafId: null, branchRevision: 0, messages: [], olderCursor: null },
      state: { idle: true, running: false, compacting: false, hasPendingMessages: false, thinking: "off", models: [], tools: [], uiPrompts: [] },
      theme: {}, caps: { commands: COMMANDS, images: false, promptReceipt: "rpc", queueView: "boolean", extensionDialogs: true, workbench: true, host: true, history: "paged", content: "paged" },
    }),
    ...overrides,
  } as unknown as Bridge;
  const hub = new Hub({ port: 0, webRoot: directory, ...options });
  hub.setHostHandler({
    command: overrides.command ?? (async () => { calls++; return { disposition: "started" }; }),
    read: overrides.read ?? (async () => ({ commands: [] })),
    answer: () => {}, pendingDialogs: () => [], uiState: () => ({ revision: 0, statuses: {}, widgets: {} }),
  } as unknown as HostHandler);
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

test("workbench queries are directed and discard results after an epoch change", async () => {
  let resolveRead: (value: unknown) => void = () => {};
  const requests: unknown[] = [];
  const f = await fixture({}, { read: (action: string, args: unknown, revision: number) => {
    requests.push([action, args, revision]); return new Promise((resolve) => { resolveRead = resolve; });
  } });
  try {
    const a = await client(f.hub); const b = await client(f.hub);
    await a.wait("snapshot"); await b.wait("snapshot");
    const originalEpoch = f.hub.epoch;
    a.send({ t: "workbench_query", reqId: "w1", epoch: originalEpoch, sessionId: "fixture-session", branchRevision: 0, action: "commands", args: {} });
    await until(() => requests.length === 1, "query invoked");
    f.observer()?.reset("branch_change");
    resolveRead({ commands: [] });
    const result = await a.wait("workbench_result");
    assert.ok(result.t === "workbench_result");
    assert.equal(result.reqId, "w1"); assert.equal(result.epoch, originalEpoch); assert.equal(result.error?.code, "stale_session");
    assert.equal(f.calls(), 0);
    assert.equal(f.hub.seq, 0);
    assert.equal(b.frames.some((frame) => frame.t === "workbench_result"), false);
    const from = a.frames.length;
    a.send({ t: "workbench_query", reqId: "w2", epoch: f.hub.epoch, sessionId: "fixture-session", branchRevision: 99, action: "commands", args: {} });
    const stale = await a.wait("workbench_result", from);
    assert.ok(stale.t === "workbench_result"); assert.equal(stale.error?.code, "stale_session");
    assert.equal(requests.length, 1);
  } finally { await f.close(); }
});

test("observed session lifecycle outcomes retain receipts after reset and reconnect", async () => {
  let completions = 0;
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture({}, { command: async () => {
    completions++; f.observer()?.reset("new"); return { cancelled: false };
  } });
  try {
    const c = await client(f.hub);
    const welcome = c.frames.find((frame) => frame.t === "welcome"); assert.ok(welcome?.t === "welcome");
    const command = { ...envelope(welcome.clientId, f.hub, 1), command: "session_new", args: {} };
    c.send(command);
    const result = await c.wait("command_result");
    assert.ok(result.t === "command_result"); assert.equal(result.epoch, command.epoch); assert.equal(result.status, "completed");
    await c.close();
    const connected = await client(f.hub, welcome.clientId);
    const from = connected.frames.length;
    connected.send({ t: "receipt_query", clientId: welcome.clientId, id: command.id });
    const queried = await connected.wait("command_result", from);
    assert.deepEqual(queried, result);
    connected.send(command);
    await connected.wait("ack", connected.frames.length - 1);
    assert.equal(completions, 1, "old envelope replay never repeats a session lifecycle action");
  } finally { await f.close(); }
});

test("all accepted RPC outcomes stay correlated across epoch replacement", async () => {
  let complete!: (result: unknown) => void;
  const f = await fixture({}, { command: () => new Promise((resolve) => { complete = resolve; }) });
  try {
    const c = await client(f.hub);
    const welcome = c.frames.find((frame) => frame.t === "welcome"); assert.ok(welcome?.t === "welcome");
    const command = { ...envelope(welcome.clientId, f.hub, 1), command: "set_model", args: { provider: "fixture", id: "model" } };
    c.send(command); await c.wait("ack");
    f.observer()?.reset("replaced");
    complete({ provider: "fixture", id: "model" });
    const result = await c.wait("command_result");
    assert.ok(result.t === "command_result"); assert.equal(result.epoch, command.epoch);
    const from = c.frames.length;
    c.send({ t: "receipt_query", clientId: welcome.clientId, id: command.id });
    assert.deepEqual(await c.wait("command_result", from), result);
  } finally { await f.close(); }
});

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

test("foreground service teardown releases its port and disconnects every viewer", async () => {
  const f = await fixture();
  try {
    const c = await client(f.hub);
    await f.hub.close();
    await until(() => c.closed(), "viewer closed");
    assert.equal(f.hub.running, false);
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

test("frames above the transport limit are chunked contiguously and reassemble to the logical frame", async () => {
  const big = "汉字🙂".repeat(160_000);
  const f = await fixture({}, {
    snapshot: () => ({
      session: { id: "fixture-session", cwd: "/fixture", leafId: null, branchRevision: 0, olderCursor: null,
        messages: [{ id: "m", role: "assistant", status: "complete", content: [{ type: "text", text: big }] }] },
      state: { idle: true, running: false, compacting: false, hasPendingMessages: false, thinking: "off", models: [], tools: [], uiPrompts: [] },
      theme: {}, caps: { commands: COMMANDS, images: false, promptReceipt: "rpc", queueView: "boolean", extensionDialogs: true, workbench: true, host: true, history: "paged", content: "paged" },
    }),
  });
  try {
    const raw: string[] = [];
    const socket = new WebSocket(`${f.hub.origin.replace("http:", "ws:")}/ws`, ["pi-pane.v1", `pi-pane.bearer.${f.hub.token}`], { origin: f.hub.origin });
    socket.on("message", (data) => raw.push(data.toString()));
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    socket.send(JSON.stringify({ t: "hello" }));
    await until(() => raw.some((frame) => frame.includes('"frame_end"')), "chunked snapshot");
    const frames = raw.map((frame) => JSON.parse(frame) as Record<string, unknown>);
    const begin = frames.findIndex((frame) => frame.t === "frame_begin");
    const end = frames.findIndex((frame) => frame.t === "frame_end");
    const chunks = frames.slice(begin + 1, end);
    assert.equal(chunks.length, frames[begin]!.parts);
    assert.ok(chunks.every((chunk, index) => chunk.t === "frame_chunk" && chunk.index === index && chunk.id === frames[begin]!.id));
    for (const frame of raw.slice(begin, end + 1)) assert.ok(Buffer.byteLength(frame) <= 1024 * 1024, "every transport frame stays within 1 MiB");
    const snapshot = JSON.parse(chunks.map((chunk) => chunk.data).join("")) as { t: string; session: { messages: { content: { text: string }[] }[] } };
    assert.equal(snapshot.t, "snapshot");
    assert.equal(snapshot.session.messages[0]!.content[0]!.text, big);
    socket.close();
  } finally { await f.close(); }
});

test("history and content reads are directed, version-checked and never dispatch", async () => {
  const requests: unknown[] = [];
  const f = await fixture({}, {
    historyPage: (before: string, revision: number) => { requests.push(["history", before, revision]); return { messages: [], olderCursor: null }; },
    contentPage: (messageId: string) => { requests.push(["content", messageId]); throw new Error("gone"); },
  });
  try {
    const c = await client(f.hub);
    await c.wait("snapshot");
    let from = c.frames.length;
    c.send({ t: "history_page", reqId: "h1", epoch: f.hub.epoch, sessionId: "fixture-session", branchRevision: 0, before: "e1" });
    const page = await c.wait("history_page", from);
    assert.ok(page.t === "history_page"); assert.equal(page.reqId, "h1");
    from = c.frames.length;
    c.send({ t: "history_page", reqId: "h2", epoch: "old-epoch", sessionId: "fixture-session", branchRevision: 0, before: "e1" });
    const stale = await c.wait("error", from);
    assert.ok(stale.t === "error"); assert.equal(stale.reqId, "h2"); assert.equal(stale.error.code, "stale_session");
    from = c.frames.length;
    c.send({ t: "content_page", reqId: "c1", epoch: f.hub.epoch, messageId: "m", index: 0, offset: 0 });
    const failed = await c.wait("error", from);
    assert.ok(failed.t === "error"); assert.equal(failed.reqId, "c1");
    assert.deepEqual(requests, [["history", "e1", 0], ["content", "m"]]);
    assert.equal(f.calls(), 0);
    assert.equal(f.hub.seq, 0, "directed reads do not consume broadcast sequence numbers");
  } finally { await f.close(); }
});

test("workbench reads enforce per-viewer and global bounds without consuming write numbers", async () => {
  const pending: ((value: unknown) => void)[] = [];
  const f = await fixture({}, { read: () => new Promise((resolve) => { pending.push(resolve); }) });
  try {
    const a = await client(f.hub), b = await client(f.hub), c = await client(f.hub);
    const query = (reqId: string) => ({ t: "workbench_query", reqId, epoch: f.hub.epoch, sessionId: "fixture-session", branchRevision: 0, action: "commands", args: {} });
    for (let i = 0; i < 8; i++) a.send(query(`a${i}`));
    await until(() => pending.length === 8, "eight peer reads");
    a.send(query("a-over"));
    const peerError = await a.wait("workbench_result");
    assert.ok(peerError.t === "workbench_result"); assert.equal(peerError.error?.code, "busy");
    for (let i = 0; i < 8; i++) b.send(query(`b${i}`));
    await until(() => pending.length === 16, "sixteen host reads");
    c.send(query("c-over"));
    const hostError = await c.wait("workbench_result");
    assert.ok(hostError.t === "workbench_result"); assert.equal(hostError.error?.code, "busy");
    for (const finish of pending) finish({ commands: [] });
    await until(() => b.frames.filter(frame => frame.t === "workbench_result").length === 8, "pending replies");
    const welcome = a.frames.find(frame => frame.t === "welcome"); assert.ok(welcome?.t === "welcome");
    const from = a.frames.length;
    a.send(envelope(welcome.clientId, f.hub, 1));
    const ack = await a.wait("ack", from); assert.ok(ack.t === "ack"); assert.equal(ack.nextCommandNo, 2);
    assert.equal(f.calls(), 1); assert.equal(f.hub.seq, 0);
  } finally { for (const finish of pending) finish({ commands: [] }); await f.close(); }
});

test("RPC failures produce retained correlated errors and preserve submission sequencing", async () => {
  let calls = 0;
  const scopes: unknown[] = [];
  const f = await fixture({}, { command: async (_name: string, _args: unknown, expected: unknown) => {
    calls++; scopes.push(expected); if (calls === 1) throw new Error("RPC preflight refused"); return { disposition: "handled" };
  } });
  try {
    const c = await client(f.hub);
    const welcome = c.frames.find(frame => frame.t === "welcome"); assert.ok(welcome?.t === "welcome");
    c.send(envelope(welcome.clientId, f.hub, 1));
    const failure = await c.wait("command_result"); assert.ok(failure.t === "command_result"); assert.equal(failure.status, "failed"); assert.match(failure.error?.message || "", /preflight/);
    const from = c.frames.length; c.send(envelope(welcome.clientId, f.hub, 2));
    const success = await c.wait("command_result", from); assert.ok(success.t === "command_result"); assert.equal(success.status, "completed");
    assert.deepEqual(scopes[0], { sessionId: "fixture-session", branchRevision: 0, generation: 1 });
  } finally { await f.close(); }
});
