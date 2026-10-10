import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, appendFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HandoffHost } from "../src/extension/handoff.js";
import { SessionFileLock } from "../src/extension/session-lock.js";
import type { Hub } from "../src/extension/hub.js";
import type { Bridge } from "../src/extension/bridge.js";
import { RpcReadTimeoutError, type RpcConnection, type RpcRecord } from "../src/extension/rpc-child.js";

class FakeChild implements RpcConnection {
  running = false; diagnostics = ""; pid = undefined;
  private exit!: (code: number | null) => void;
  exited = new Promise<number | null>(resolve => { this.exit = resolve; });
  listeners = new Set<(record: RpcRecord) => void>(); calls: { type: string; payload: Record<string, unknown> }[] = [];
  responses: { id: string; response: Record<string, unknown> }[] = [];
  onUiResponse?: (id: string, response: Record<string, unknown>) => void;
  manager: SessionManager; entries: Record<string, unknown>[];
  model = { provider: "local", id: "fixture", name: "Fixture" }; level = "off";
  streaming = false; pending = 0; compacting = false;
  reportedPath?: string; emptyFork = false;
  disposition = "started"; cancelNext = false;
  catalogOverride?: Awaited<ReturnType<typeof SessionManager.listAll>>;
  commands = [{ name: "mark", description: "record", source: "extension" }, { name: "shared", source: "prompt" }, { name: "shared", source: "extension" }, { name: "model", source: "extension" }];
  intercept?: (type: string, payload: Record<string, unknown>) => Promise<{ intercepted: boolean; value?: unknown }>;
  constructor(manager: SessionManager, private readonly root: string) { this.manager = manager; this.entries = manager.getEntries() as unknown as Record<string, unknown>[]; }
  start() { this.running = true; }
  emit(record: RpcRecord) { for (const listener of this.listeners) listener(record); }
  onRecord(listener: (record: RpcRecord) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  respondUi(id: string, response: Record<string, unknown>) { this.responses.push({ id, response }); this.onUiResponse?.(id, response); }
  async stop() { this.running = false; this.exit(0); }
  async request<T>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ type, payload }); const custom = await this.intercept?.(type, payload); if (custom?.intercepted) return custom.value as T;
    let value: unknown;
    if (type === "get_state") value = { model: this.model, thinkingLevel: this.level, isStreaming: this.streaming, isCompacting: this.compacting, pendingMessageCount: this.pending,
      sessionFile: this.reportedPath ?? this.manager.getSessionFile(), sessionId: this.manager.getSessionId(), sessionName: this.manager.getSessionName() };
    else if (type === "get_entries") {
      // Like pi, report the session's current entries, including ones appended after startup.
      const entries = this.manager.getEntries() as unknown as Record<string, unknown>[];
      const since = entries.findIndex(entry => entry.id === payload.since);
      if (payload.since && since < 0) throw new Error(`Entry ${String(payload.since)} not found`);
      value = { entries: structuredClone(payload.since ? entries.slice(since + 1) : entries), leafId: entries.at(-1)?.id ?? null };
    } else if (type === "get_available_models") value = { models: [this.model] };
    else if (type === "get_available_thinking_levels") value = { levels: ["off", "low", "high"] };
    else if (type === "get_commands") value = { commands: this.commands };
    else if (["new_session", "switch_session", "fork", "clone"].includes(type)) {
      if (this.cancelNext) { this.cancelNext = false; return { cancelled: true } as T; }
      if (type === "switch_session") this.manager = SessionManager.open(String(payload.sessionPath));
      else {
        const next = SessionManager.create(this.manager.getCwd(), join(this.root, "custom"));
        if (!(type === "fork" && this.emptyFork)) await writeFile(next.getSessionFile()!, `${JSON.stringify(next.getHeader())}\n`);
        this.manager = next;
      }
      this.entries = this.manager.getEntries() as unknown as Record<string, unknown>[];
      value = { cancelled: false, ...(type === "fork" ? { text: "restored user draft" } : {}) };
    } else if (type === "prompt") value = { disposition: this.disposition };
    else if (type === "abort") { this.streaming = false; this.pending = 0; value = undefined; }
    else if (type === "set_model") value = this.model;
    else if (type === "set_thinking_level") { this.level = String(payload.level); value = undefined; }
    else if (type === "set_session_name") { this.manager.appendSessionInfo(String(payload.name)); value = undefined; }
    else if (type === "compact") value = { tokensBefore: 5 };
    else throw new Error(`Unexpected fake RPC command ${type}`);
    return value as T;
  }
}
async function withHost(run: (host: HandoffHost, child: FakeChild, fixture: { root: string; foreign: SessionManager; bridges: Bridge[]; notices: unknown[] }) => Promise<void>, beforeStart?: (child: FakeChild) => void) {
  const root = await mkdtemp(join(tmpdir(), "pi-pane-host-")); const cwd = join(root, "project"); const other = join(root, "other"); const custom = join(root, "custom");
  await Promise.all([mkdir(cwd), mkdir(other), mkdir(custom)]); await writeFile(join(cwd, "local.txt"), "local"); await writeFile(join(other, "foreign.txt"), "foreign");
  const manager = SessionManager.create(cwd, custom); manager.appendMessage({ role: "user", content: "first user", timestamp: 1 });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "first answer" }], api: "fixture", provider: "local", model: "fixture", timestamp: 2, stopReason: "stop", usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as never);
  manager.appendMessage({ role: "user", content: "later searchable marker", timestamp: 3 });
  const foreign = SessionManager.create(other, custom); foreign.appendMessage({ role: "user", content: "foreign", timestamp: 4 });
  foreign.appendMessage({ role: "assistant", content: [{ type: "text", text: "foreign answer" }], api: "fixture", provider: "local", model: "fixture", timestamp: 5, stopReason: "stop", usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as never);
  const child = new FakeChild(manager, root); const bridges: Bridge[] = []; const notices: unknown[] = [];
  beforeStart?.(child);
  const hub = { setHostHandler() {}, bindBridge(bridge: Bridge) { bridges.push(bridge); }, notifyAll(record: unknown) { notices.push(record); } } as unknown as Hub;
  const theme = { appearance: "dark", colors: {} } as unknown as ExtensionContext["ui"]["theme"];
  const host = new HandoffHost(hub, { sessionFile: manager.getSessionFile()!, sessionDir: custom, cwd, argv: [], theme, themes: [] }, () => {}, { createChild: () => child,
    listAll: ((directory?: string) => child.catalogOverride ? Promise.resolve(child.catalogOverride) : directory ? SessionManager.listAll(directory) : Promise.resolve([])) as typeof SessionManager.listAll });
  try { await host.start(); await run(host, child, { root, foreign, bridges, notices }); }
  finally { await host.stop(); await rm(root, { recursive: true, force: true }); }
}
test("host catalog searches all message text/custom roots and follows current cwd across RPC session switches", async () => withHost(async (host, child, { foreign }) => {
  const search = await host.read("sessions", { scope: "all", query: "later searchable" }); assert.equal(search.sessions.length, 1); assert.equal(search.sessions[0]!.current, true);
  const all = await host.read("sessions", { scope: "all" }); assert(all.sessions.some(session => session.id === foreign.getSessionId()));
  await assert.rejects(host.command("session_switch", { sessionId: "not-listed" }), { code: "unknown_session" });
  await host.command("session_switch", { sessionId: foreign.getSessionId() }); assert.equal(host.cwd, foreign.getCwd());
  assert.deepEqual((await host.read("files")).files.map(file => file.path), ["foreign.txt"]);
  const current = (await host.read("sessions", { scope: "all" })).sessions.find(session => session.current); assert.equal(current?.id, foreign.getSessionId());
  assert.equal(child.calls.filter(call => call.type === "switch_session").at(-1)?.payload.sessionPath, foreign.getSessionFile());
}));
test("RPC catalog preserves precedence, reserves builtins and reports upstream gaps", async () => withHost(async host => {
  const commands = (await host.read("commands")).commands; const shared = commands.filter(command => command.name === "shared");
  assert.equal(shared[0]!.source, "extension"); assert.equal(shared[0]!.available, true); assert.equal(shared[1]!.available, false);
  assert.equal(commands.find(command => command.name === "model" && command.source === "extension")?.available, false);
  assert.equal(commands.find(command => command.name === "tree")?.available, false);
  const resources = await host.read("resources"); assert.deepEqual(resources.tools, []); assert.deepEqual(resources.thinkingLevels, ["off", "low", "high"]);
  assert.equal(resources.capabilities.find(capability => capability.name === "tools")?.available, false);
}));
test("session metadata stays bounded to 200 including the synthetic current row", async () => withHost(async (host, child) => {
  const base = (await SessionManager.list(child.manager.getCwd(), dirname(child.manager.getSessionFile()!)))[0];
  const currentId = child.manager.getSessionId();
  child.catalogOverride = Array.from({ length: 205 }, (_, index) => ({ ...base, id: `fixture-${index}`, path: host.sessionFile, cwd: host.cwd,
    created: new Date("2030-01-01"), modified: new Date("2030-01-01"), name: "命".repeat(300), firstMessage: "文".repeat(300), allMessagesText: "search", messageCount: 2 })) as Awaited<ReturnType<typeof SessionManager.listAll>>;
  const result = await host.read("sessions", { scope: "all" }); assert.equal(result.sessions.length, 200); assert.equal(result.truncated, true);
  assert.equal(result.sessions[0]!.id, currentId); assert(result.sessions.slice(1).every(session => Buffer.byteLength(session.name ?? "") <= 256 && Buffer.byteLength(session.firstMessage) <= 256));
}));
test("valid Unicode invocation names retain their exact bytes; malformed command names stay disabled", async () => withHost(async (host, child) => {
  const name = "命".repeat(128); child.commands.push({ name, source: "extension" }, { name: "bad name", source: "extension" });
  const commands = (await host.read("commands")).commands; assert.equal(commands.find(command => command.name === name)?.available, true);
  assert.equal(commands.find(command => command.name === "bad name")?.available, false);
  await host.command("run_command", { name }); assert.equal(child.calls.filter(call => call.type === "prompt").at(-1)?.payload.message, `/${name}`);
}));
test("all prompt dispositions are authoritative, slash extension expansion uses RPC and builtins never reach a model", async () => withHost(async (host, child) => {
  for (const disposition of ["started", "queued", "handled"]) { child.disposition = disposition; assert.deepEqual(await host.command("prompt", { text: "/mark", mode: "steer" }), { disposition }); }
  assert.equal(child.calls.filter(call => call.type === "prompt").at(-1)?.payload.streamingBehavior, "steer");
  const before = child.calls.filter(call => call.type === "prompt").length;
  for (const text of ["/new", "/model fixture", " /tree", "/login", "/web", "/debug", "/arminsayshi", "/dementedelves"])
    await assert.rejects(host.command("prompt", { text }), { code: "picker_required" });
  assert.equal(child.calls.filter(call => call.type === "prompt").length, before);
}));
test("browser image args become native RPC ImageContent with explicit type", async () => withHost(async (host, child) => {
  const image = { mimeType: "image/png", data: "fixture-base64" };
  await host.command("prompt", { text: "describe", images: [image] }); assert.deepEqual(child.calls.filter(call => call.type === "prompt").at(-1)?.payload.images, [{ type: "image", ...image }]);
}));
test("fork is native before-user semantics, cancelled mutations do not replace the Bridge, clone and rename use RPC", async () => withHost(async (host, child, { bridges }) => {
  const assistant = child.entries.find(entry => (entry.message as { role?: string })?.role === "assistant")!;
  await assert.rejects(host.command("session_fork", { entryId: assistant.id }), { code: "invalid_fork" });
  child.cancelNext = true; assert.equal((await host.command("session_new", {}) as { cancelled: boolean }).cancelled, true); assert.equal(bridges.length, 1);
  const user = child.entries.find(entry => (entry.message as { role?: string })?.role === "user")!;
  const fork = await host.command("session_fork", { entryId: user.id }) as { draftText: string; sessionId: string }; assert.equal(fork.draftText, "restored user draft"); assert.equal(fork.sessionId, child.manager.getSessionId());
  assert.deepEqual(child.calls.find(call => call.type === "fork")?.payload, { entryId: user.id });
  await host.command("session_clone", {}); assert(child.calls.some(call => call.type === "clone"));
  assert.equal((await host.command("session_rename", { name: "Renamed" }) as { name: string }).name, "Renamed");
}));
test("serial queue checks stale scope inside the queue and recovers from an RPC rejection", async () => withHost(async (host, child, { bridges }) => {
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  child.intercept = async type => { if (type === "new_session") await wait; return { intercepted: false }; };
  const initial = bridges[0]!; const expected = { sessionId: initial.sessionId, generation: initial.generation, branchRevision: initial.branchRevision };
  const first = host.command("session_new", {}, expected); const stale = host.command("prompt", { text: "wrong session" }, expected);
  release(); await first; await assert.rejects(stale, { code: "stale_session" }); assert(!child.calls.some(call => call.type === "prompt"));
  let rejectModel = true; child.intercept = async type => { if (type === "set_model" && rejectModel) { rejectModel = false; throw new Error("model failed"); } return { intercepted: false }; };
  await assert.rejects(host.command("set_model", { provider: "local", id: "fixture" }), /model failed/); await host.command("set_model", { provider: "local", id: "fixture" });
}));
test("abort reaches a pending compaction and releases the serialized queue; queue is bounded", async () => withHost(async (host, child) => {
  let finish!: () => void; let compactSeen!: () => void; const seen = new Promise<void>(resolve => { compactSeen = resolve; }); const wait = new Promise<void>(resolve => { finish = resolve; });
  child.intercept = async type => {
    if (type === "compact") { child.compacting = true; compactSeen(); await wait; child.compacting = false; throw new Error("compaction aborted"); }
    if (type === "abort") { finish(); return { intercepted: false }; } return { intercepted: false };
  };
  const compact = host.command("compact", {}); const caught = assert.rejects(compact, /compaction aborted/); await seen;
  const queued = Array.from({ length: 31 }, () => host.command("set_thinking", { level: "off" }));
  await assert.rejects(host.command("set_thinking", { level: "high" }), { code: "busy" });
  await host.command("abort", {}); await caught; await Promise.all(queued); assert(child.calls.some(call => call.type === "abort"));
}));
test("manual compaction rejects new configuration/session operations on admission instead of applying them later", async () => withHost(async (host, child) => {
  let finish!: () => void; const wait = new Promise<void>(resolve => { finish = resolve; });
  let seen!: () => void; const compactSeen = new Promise<void>(resolve => { seen = resolve; });
  child.intercept = async type => {
    if (type === "compact") {
      child.compacting = true; child.emit({ type: "compaction_start" }); seen(); await wait;
      child.compacting = false; child.emit({ type: "compaction_end", result: { tokensBefore: 5 } }); return { intercepted: true, value: { tokensBefore: 5 } };
    }
    return { intercepted: false };
  };
  const compact = host.command("compact", {}); await compactSeen;
  const names = ["set_model", "set_thinking", "session_new", "session_rename", "session_clone", "session_switch", "compact"];
  for (const name of names) await assert.rejects(host.command(name, name === "set_model" ? { provider: "local", id: "fixture" } : name === "set_thinking" ? { level: "high" } : name === "session_rename" ? { name: "must not apply" } : {}), { code: "busy" });
  finish(); await compact;
  assert.equal(child.calls.filter(call => call.type === "compact").length, 1);
  assert(!child.calls.some(call => ["set_model", "set_thinking_level", "new_session", "set_session_name", "clone", "switch_session"].includes(call.type)));
  await host.command("set_thinking", { level: "high" }); assert(child.calls.some(call => call.type === "set_thinking_level"));
}));
test("dialog state survives reconnect, only one valid answer wins and timeout cancels the RPC request", async () => withHost(async (host, child, { notices }) => {
  child.emit({ type: "extension_ui_request", id: "select", method: "select", options: ["one", "two"] });
  assert.equal(host.pendingDialogs().length, 1); await assert.rejects(async () => host.answer("select", { value: "invalid" }), { code: "invalid_dialog_response" });
  host.answer("select", { value: "two" }); assert.throws(() => host.answer("select", { value: "one" }), { code: "dialog_closed" }); assert.equal(child.responses.length, 1);
  child.emit({ type: "extension_ui_request", id: "expire", method: "confirm", timeout: 15 }); assert(host.pendingDialogs()[0]!.expiresAt);
  await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(host.pendingDialogs().length, 0); assert.deepEqual(child.responses.at(-1), { id: "expire", response: { cancelled: true } });
  assert(notices.some(record => (record as { id?: string; reason?: string }).id === "expire" && (record as { reason?: string }).reason === "timeout"));
  child.emit({ type: "extension_ui_request", id: "tool-cancelled", method: "input" }); child.emit({ type: "agent_settled" }); assert.equal(host.pendingDialogs().length, 0);
}));
test("a waiting idle extension dialog rejects other viewers' writes immediately while answer and abort stay available", async () => withHost(async (host, child) => {
  let seen!: () => void; const dialogSeen = new Promise<void>(resolve => { seen = resolve; });
  let answered!: () => void; const answer = new Promise<void>(resolve => { answered = resolve; });
  child.onUiResponse = () => answered();
  child.intercept = async type => {
    if (type === "prompt") { child.emit({ type: "extension_ui_request", id: "holding", method: "confirm" }); seen(); await answer; return { intercepted: true, value: { disposition: "handled" } }; }
    return { intercepted: false };
  };
  const first = host.command("prompt", { text: "/mark" }); await dialogSeen; assert.equal(child.streaming, false);
  for (const [name, args] of [["set_model", { provider: "local", id: "fixture" }], ["session_new", {}], ["compact", {}], ["prompt", { text: "other viewer" }], ["run_command", { name: "mark" }]] as const)
    await assert.rejects(host.command(name, args), { code: "busy" });
  assert(!child.calls.some(call => ["set_model", "new_session", "compact"].includes(call.type)));
  host.answer("holding", { confirmed: true }); await first;
  child.emit({ type: "extension_ui_request", id: "abortable", method: "input" }); await host.command("abort", {});
  assert.equal(host.pendingDialogs().length, 0); assert(child.calls.some(call => call.type === "abort"));
  await host.command("set_model", { provider: "local", id: "fixture" });
}));
test("persistent UI state supports status/widget removal and distinct editor revisions", async () => withHost(async (host, child) => {
  const ui = (method: string, props: Record<string, unknown>) => child.emit({ type: "extension_ui_request", id: method, method, ...props });
  ui("setStatus", { statusKey: "task", statusText: "Running" }); ui("setWidget", { widgetKey: "plan", widgetLines: ["Step one"], widgetPlacement: "aboveEditor" });
  ui("setTitle", { title: "Host title" }); ui("set_editor_text", { text: "draft" }); const first = host.uiState();
  assert.equal(first.editorRevision, 1); assert.equal(first.editorText, "draft"); assert.deepEqual(first.widgets.plan, { content: ["Step one"], placement: "aboveEditor" });
  ui("setStatus", { statusKey: "task" }); ui("setWidget", { widgetKey: "plan" }); const second = host.uiState();
  assert.deepEqual(second.statuses, {}); assert.deepEqual(second.widgets, {}); assert.equal(second.editorRevision, first.editorRevision); assert(second.revision > first.revision);
}));
test("long select labels remain distinct and map to exact original RPC option strings", async () => withHost(async (host, child) => {
  const prefix = "long".repeat(150); const options = [`${prefix} one`, `${prefix} two`];
  child.emit({ type: "extension_ui_request", id: "long-select", method: "select", options });
  const labels = host.pendingDialogs()[0]!.options!; assert.notEqual(labels[0], labels[1]); assert(Buffer.byteLength(labels[0]!) <= 500);
  host.answer("long-select", { value: labels[1] }); assert.deepEqual(child.responses.at(-1), { id: "long-select", response: { value: options[1] } });
}));
test("registered extension session replacement rebuilds scope/cwd; queued old-scope write is rejected", async () => withHost(async (host, child, { foreign, bridges }) => {
  child.disposition = "handled"; child.intercept = async type => {
    if (type === "prompt") { child.manager = foreign; child.entries = foreign.getEntries() as unknown as Record<string, unknown>[]; }
    return { intercepted: false };
  };
  const bridge = bridges[0]!; const expected = { sessionId: bridge.sessionId, generation: bridge.generation, branchRevision: bridge.branchRevision };
  const extension = host.command("prompt", { text: "/mark" }, expected); const stale = host.command("prompt", { text: "old scope" }, expected);
  await extension; await assert.rejects(stale, { code: "stale_session" }); assert.equal(host.cwd, foreign.getCwd()); assert.equal(bridges.at(-1)?.sessionId, foreign.getSessionId());
  assert.deepEqual((await host.read("files")).files.map(file => file.path), ["foreign.txt"]);
}));
test("idle external transcript modification stops the sole child without restarting", async () => withHost(async (host, child) => {
  await appendFile(host.sessionFile, "unexpected external write\n");
  await assert.rejects(host.command("prompt", { text: "do not write" }), { code: "session_conflict" }); assert.equal(child.running, false);
  assert(!child.calls.some(call => call.type === "prompt"));
}));
test("entries an extension in the child persists later (after agent_end) are its own, not a conflict", async () => withHost(async (host, child) => {
  await host.command("prompt", { text: "first" });
  // e.g. an asynchronous agent_end handler calling pi.appendEntry well after the turn settled
  child.manager.appendCustomEntry("review-probe", { run: 1 });
  await host.command("prompt", { text: "second" });
  assert.equal(child.running, true); assert.equal(child.calls.filter(call => call.type === "prompt").length, 2);
  await appendFile(host.sessionFile, `${JSON.stringify({ type: "custom", id: "not-the-childs", parentId: null })}\n`);
  await assert.rejects(host.command("prompt", { text: "third" }), { code: "session_conflict" }); assert.equal(child.running, false);
}));
test("a read timeout during ownership verification rejects only the pending write and later retries it safely", async () => withHost(async (host, child) => {
  child.manager.appendCustomEntry("delayed-extension", { run: 1 });
  let entryReads = 0;
  child.intercept = async type => {
    // The first read synchronizes the mirror; the second verifies the file append.
    if (type === "get_entries" && ++entryReads === 2) throw new RpcReadTimeoutError(type, 30_000);
    return { intercepted: false };
  };
  await assert.rejects(host.command("prompt", { text: "retry later" }), { code: "rpc_read_timeout" });
  assert.equal(child.running, true); assert.equal(entryReads, 2, "the timed-out ownership read is not retried implicitly");
  assert(!child.calls.some(call => call.type === "prompt"), "a write is not submitted until ownership is verified");
  await host.command("prompt", { text: "retry later" });
  assert.equal(child.calls.filter(call => call.type === "prompt").length, 1); assert.equal(child.running, true);
  await appendFile(host.sessionFile, `${JSON.stringify({ type: "custom", id: "foreign", parentId: null })}\n`);
  await assert.rejects(host.command("prompt", { text: "must refuse" }), { code: "session_conflict" });
  assert.equal(child.running, false, "a real ownership conflict still stops the writer");
}));
test("a read timeout while synchronizing before a write is not retried and the writer stays available", async () => withHost(async (host, child) => {
  let entryReads = 0;
  child.intercept = async type => {
    if (type === "get_entries" && ++entryReads === 1) throw new RpcReadTimeoutError(type, 30_000);
    return { intercepted: false };
  };
  await assert.rejects(host.command("prompt", { text: "retry later" }), { code: "rpc_read_timeout" });
  assert.equal(child.running, true); assert.equal(entryReads, 1);
  assert(!child.calls.some(call => call.type === "prompt"));
  await host.command("prompt", { text: "retry later" });
  assert.equal(child.calls.filter(call => call.type === "prompt").length, 1);
}));
test("a timed-out workbench read fails once and a later read succeeds without replacing the child", async () => withHost(async (host, child) => {
  let commandReads = 0;
  child.intercept = async type => {
    if (type === "get_commands" && ++commandReads === 1) throw new RpcReadTimeoutError(type, 30_000);
    return { intercepted: false };
  };
  await assert.rejects(host.read("commands"), { code: "rpc_read_timeout" });
  assert.equal(child.running, true); assert.equal(commandReads, 1);
  assert((await host.read("commands")).commands.some(command => command.name === "mark"));
  assert.equal(commandReads, 2); assert.equal(child.running, true);
}));
test("trusted child startup persistence is acknowledged before first browser command", async () => withHost(async (host, child) => {
  await host.command("prompt", { text: "first" }); assert(child.calls.some(call => call.type === "prompt"));
}, child => {
  let initial = true; child.intercept = async type => {
    if (type === "get_state" && initial) { initial = false; child.manager.appendSessionInfo("child startup state"); }
    return { intercepted: false };
  };
}));
test("switch refuses a cooperatively locked destination before RPC can open it", async () => withHost(async (host, child, { foreign }) => {
  await host.read("sessions", { scope: "all" }); const lock = await SessionFileLock.acquire(foreign.getSessionFile()!);
  try { await assert.rejects(host.command("session_switch", { sessionId: foreign.getSessionId() }), { code: "session_locked" });
    assert(!child.calls.some(call => call.type === "switch_session")); assert.equal(child.running, true);
  } finally { await lock.release(); }
}));
test("native clone rejection on an empty fork retains the same session through lexical directory aliases", async () => withHost(async (host, child, { root, bridges }) => {
  child.emptyFork = true;
  const user = child.entries.find(entry => (entry.message as { role?: string })?.role === "user")!;
  await host.command("session_fork", { entryId: user.id });
  const activeId = child.manager.getSessionId(); const bridgeCount = bridges.length;
  const alias = join(root, "custom-alias"); await symlink(join(root, "custom"), alias);
  child.reportedPath = join(alias, basename(child.manager.getSessionFile()!));
  child.intercept = async type => { if (type === "clone") throw new Error("Cannot clone session: no current entry selected"); return { intercepted: false }; };
  await assert.rejects(host.command("session_clone", {}), /Cannot clone session/);
  assert.equal(child.running, true); assert.equal(bridges.length, bridgeCount); assert.equal((await host.read("sessions", { scope: "all" })).sessions.find(session => session.current)?.id, activeId);
  await host.command("prompt", { text: "continue this empty session" }); assert.equal(child.running, true); assert.equal(bridges.length, bridgeCount);
}));
