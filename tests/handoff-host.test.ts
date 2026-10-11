import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile, appendFile, symlink, realpath, readFile, rename, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { SessionManager, SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HandoffHost } from "../src/extension/handoff.js";
import { SessionFileLock } from "../src/extension/session-lock.js";
import { ProjectRegistry } from "../src/extension/project-registry.js";
import type { Hub } from "../src/extension/hub.js";
import type { Bridge } from "../src/extension/bridge.js";
import type { ExportPage, HostState } from "../src/protocol/index.js";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import type { AuthRuntime } from "../src/extension/auth-controller.js";
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
  /** Like pi: queue modes live in the session, and the RPC setters also save the global default. */
  modes = { steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", autoCompactionEnabled: true };
  saveSettings = true;
  context: { tokens: number | null; contextWindow: number; percent: number | null } | undefined = { tokens: 1200, contextWindow: 16000, percent: 7.5 };
  lastText: string | undefined = "first answer"; exportBody = "<html>exported</html>"; exportTo?: string;
  streaming = false; pending = 0; compacting = false;
  reportedPath?: string; emptyFork = false;
  disposition = "started"; cancelNext = false;
  catalogOverride?: Awaited<ReturnType<typeof SessionManager.listAll>>;
  commands = [{ name: "mark", description: "record", source: "extension" }, { name: "shared", source: "prompt" }, { name: "shared", source: "extension" }, { name: "model", source: "extension" }];
  intercept?: (type: string, payload: Record<string, unknown>) => Promise<{ intercepted: boolean; value?: unknown }>;
  constructor(manager: SessionManager, private readonly root: string) { this.manager = manager; this.entries = manager.getEntries() as unknown as Record<string, unknown>[]; }
  /** Like pi: the model runtime reads stored credentials when a session is opened, not while it runs. */
  credentials?: () => string[];
  loaded: string[] = [];
  start() { this.running = true; this.loaded = this.credentials?.() ?? []; }
  emit(record: RpcRecord) { for (const listener of this.listeners) listener(record); }
  onRecord(listener: (record: RpcRecord) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  respondUi(id: string, response: Record<string, unknown>) { this.responses.push({ id, response }); this.onUiResponse?.(id, response); }
  /** Runs after stdin is closed and before the exit, like a session_shutdown handler. */
  beforeExit?: () => Promise<void> | void;
  stopOutcome = { code: 0 as number | null, forced: false };
  stops = 0;
  private stopping?: Promise<void>;
  async stop() {
    this.stops++; if (!this.running) return this.stopOutcome;
    await (this.stopping ??= (async () => { await this.beforeExit?.(); this.running = false; this.exit(this.stopOutcome.code); })());
    return this.stopOutcome;
  }
  crash(code: number) { this.running = false; this.exit(code); }
  async request<T>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ type, payload }); const custom = await this.intercept?.(type, payload); if (custom?.intercepted) return custom.value as T;
    let value: unknown;
    if (type === "get_state") value = { model: this.model, thinkingLevel: this.level, isStreaming: this.streaming, isCompacting: this.compacting, pendingMessageCount: this.pending,
      sessionFile: this.reportedPath ?? this.manager.getSessionFile(), sessionId: this.manager.getSessionId(), sessionName: this.manager.getSessionName(), ...this.modes };
    else if (type === "get_entries") {
      // Like pi, report the session's current entries, including ones appended after startup.
      const entries = this.manager.getEntries() as unknown as Record<string, unknown>[];
      const since = entries.findIndex(entry => entry.id === payload.since);
      if (payload.since && since < 0) throw new Error(`Entry ${String(payload.since)} not found`);
      value = { entries: structuredClone(payload.since ? entries.slice(since + 1) : entries), leafId: entries.at(-1)?.id ?? null };
    } else if (type === "get_available_models") value = { models: [this.model, ...this.loaded.map(provider => ({ provider, id: `${provider}-model`, name: provider }))] };
    else if (type === "get_available_thinking_levels") value = { levels: ["off", "low", "high"] };
    else if (type === "get_commands") value = { commands: this.commands };
    else if (["new_session", "switch_session", "fork", "clone"].includes(type)) {
      if (this.cancelNext) { this.cancelNext = false; return { cancelled: true } as T; }
      this.loaded = this.credentials?.() ?? [];
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
    else if (type === "get_session_stats") value = { sessionFile: this.manager.getSessionFile(), sessionId: this.manager.getSessionId(), userMessages: 2, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 3,
      tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30 }, cost: 0.0125, ...(this.context ? { contextUsage: this.context } : {}) };
    else if (type === "get_last_assistant_text") value = { text: this.lastText };
    else if (type === "export_html") { const target = this.exportTo ?? String(payload.outputPath); await writeFile(target, this.exportBody); value = { path: target }; }
    else if (["set_steering_mode", "set_follow_up_mode", "set_auto_compaction", "set_auto_retry"].includes(type)) {
      const settings = SettingsManager.create(this.manager.getCwd(), join(this.root, "agent"), { projectTrusted: false });
      if (type === "set_steering_mode") { this.modes.steeringMode = String(payload.mode); if (this.saveSettings) settings.setSteeringMode(payload.mode as never); }
      else if (type === "set_follow_up_mode") { this.modes.followUpMode = String(payload.mode); if (this.saveSettings) settings.setFollowUpMode(payload.mode as never); }
      else if (type === "set_auto_compaction") { this.modes.autoCompactionEnabled = !!payload.enabled; if (this.saveSettings) settings.setCompactionEnabled(!!payload.enabled); }
      else if (this.saveSettings) settings.setRetryEnabled(!!payload.enabled);
      await settings.flush(); value = undefined;
    }
    else throw new Error(`Unexpected fake RPC command ${type}`);
    return value as T;
  }
}
/** pi's auth runtime as the controller uses it: a credential map and a login that is scripted per test. */
class FakeAuth implements AuthRuntime {
  stored = new Map<string, { type: "api_key" | "oauth"; key?: string }>();
  script: (provider: string, type: "api_key" | "oauth", interaction: AuthInteraction) => Promise<{ type: "api_key" | "oauth"; key?: string }> =
    async (_provider, type, interaction) => ({ type, key: await interaction.prompt({ type: "secret", message: "Enter API key" }) });
  logins = 0;
  /** Like pi's runtime with a models.json path: it also knows the providers of that file. */
  customFile?: string;
  withCustom(): AuthRuntime {
    const base = this, file = this.customFile;
    const custom = () => { try { return Object.keys(JSON.parse(readFileSync(file!, "utf8")).providers ?? {}); } catch { return []; } };
    return { getProviders: () => [...base.getProviders(), ...custom().filter(id => !base.getProviders().some(provider => provider.id === id)).map(id => ({ id, name: id, auth: { apiKey: { name: "API key" } } }))],
      getModels: id => base.getModels(id), listCredentials: () => base.listCredentials(), login: (provider, type, interaction) => base.login(provider, type, interaction), logout: provider => base.logout(provider) };
  }
  getProviders() { return [{ id: "acme", name: "Acme AI", auth: { apiKey: { name: "Acme API key", login: true }, oauth: { name: "Acme subscription" } } },
    { id: "kimi-coding", name: "Kimi For Coding", auth: { apiKey: { name: "Kimi API key", login: true }, oauth: { name: "Kimi Code (subscription)" } } },
    { id: "cloud", name: "Cloud Ambient", auth: { apiKey: { name: "Cloud credentials" } } }]; }
  getModels(id: string) { return id === "acme" ? [1, 2] : id === "kimi-coding" ? [1] : []; }
  async listCredentials() { return [...this.stored].map(([providerId, value]) => ({ providerId, type: value.type })); }
  async login(provider: string, type: "api_key" | "oauth", interaction: AuthInteraction) { this.logins++; const credential = await this.script(provider, type, interaction); this.stored.set(provider, credential); return credential; }
  async logout(provider: string) { this.stored.delete(provider); }
}
interface Fixture {
  root: string; foreign: SessionManager; bridges: Bridge[]; notices: unknown[];
  /** Every child the host started, with its arguments and directory. The first is the handoff child. */
  launches: { args: string[]; cwd: string; child: FakeChild }[];
  suspended: string[]; logs: string[]; hostStates: HostState[]; accountStates: number;
  /** Scripted stand-in for pi's auth runtime; its credentials are what the fake children report as available. */
  auth: FakeAuth;
  /** Adjusts a replacement child before the host starts it. */
  prepare?: (child: FakeChild, cwd: string) => void;
  /** Stand-in for the system trash: moves the file aside and records it, or declines. */
  trash: (path: string) => Promise<boolean>; trashed: string[]; trashWorks: boolean;
}
async function withHost(run: (host: HandoffHost, child: FakeChild, fixture: Fixture) => Promise<void>, beforeStart?: (child: FakeChild) => void, argv: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), "pi-pane-host-")); const cwd = join(root, "project"); const other = join(root, "other"); const custom = join(root, "custom");
  await Promise.all([mkdir(cwd), mkdir(other), mkdir(custom)]); await writeFile(join(cwd, "local.txt"), "local"); await writeFile(join(other, "foreign.txt"), "foreign");
  const manager = SessionManager.create(cwd, custom); manager.appendMessage({ role: "user", content: "first user", timestamp: 1 });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "first answer" }], api: "fixture", provider: "local", model: "fixture", timestamp: 2, stopReason: "stop", usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as never);
  manager.appendMessage({ role: "user", content: "later searchable marker", timestamp: 3 });
  const foreign = SessionManager.create(other, custom); foreign.appendMessage({ role: "user", content: "foreign", timestamp: 4 });
  foreign.appendMessage({ role: "assistant", content: [{ type: "text", text: "foreign answer" }], api: "fixture", provider: "local", model: "fixture", timestamp: 5, stopReason: "stop", usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as never);
  const child = new FakeChild(manager, root); const bridges: Bridge[] = []; const notices: unknown[] = [];
  child.credentials = () => [...fixture.auth.stored.keys()];
  beforeStart?.(child);
  const fixture: Fixture = { root, foreign, bridges, notices, launches: [], suspended: [], logs: [], hostStates: [], accountStates: 0, auth: new FakeAuth(), trashed: [], trashWorks: true,
    trash: async path => { if (!fixture.trashWorks) return false; await rename(path, `${path}.trashed`); fixture.trashed.push(path); return true; } };
  fixture.auth.customFile = join(root, "agent", "models.json");
  const hub = { setHostHandler() {}, bindBridge(bridge: Bridge) { bridges.push(bridge); }, notifyAll(record: unknown) { notices.push(record); }, suspendBridge(reason: string) { fixture.suspended.push(reason); }, publishHostState() { fixture.hostStates.push(host.hostState()); }, publishAccountState() { fixture.accountStates++; } } as unknown as Hub;
  const theme = { appearance: "dark", colors: {} } as unknown as ExtensionContext["ui"]["theme"];
  // Like pi: `--session` opens that transcript; without it the child creates a session in its directory.
  const createChild = (args: string[], directory: string): FakeChild => {
    let next = child;
    if (fixture.launches.length) {
      const session = args.includes("--session") ? args[args.indexOf("--session") + 1] : undefined;
      next = new FakeChild(session ? SessionManager.open(session) : SessionManager.create(directory, custom), root);
      next.credentials = () => [...fixture.auth.stored.keys()];
      fixture.prepare?.(next, directory);
    }
    fixture.launches.push({ args, cwd: directory, child: next }); return next;
  };
  const host = new HandoffHost(hub, { sessionFile: manager.getSessionFile()!, sessionDir: custom, cwd, argv, theme, themes: [] }, line => { fixture.logs.push(line); }, { createChild, plannedStopMs: 50, agentDir: join(root, "agent"), createAuthRuntime: async custom => custom ? fixture.auth.withCustom() : fixture.auth, accountLimitMs: 400, trash: path => fixture.trash(path), webOAuth: new Set(["kimi-coding"]),
    listAll: ((directory?: string) => child.catalogOverride ? Promise.resolve(child.catalogOverride) : directory ? SessionManager.listAll(directory) : Promise.resolve([])) as typeof SessionManager.listAll });
  try { await host.start(); await run(host, child, fixture); }
  finally { await host.stop(); await rm(root, { recursive: true, force: true }); }
}
test("host catalog searches all message text/custom roots and follows current cwd across RPC session switches", async () => withHost(async (host, child, { foreign }) => {
  const search = await host.read("sessions", { scope: "all", query: "later searchable" }); assert.equal(search.sessions.length, 1); assert.equal(search.sessions[0]!.current, true);
  const all = await host.read("sessions", { scope: "all" }); assert(all.sessions.some(session => session.id === foreign.getSessionId()));
  await assert.rejects(host.command("session_switch", { sessionId: "not-listed" }), { code: "unknown_session" });
  await host.command("session_switch", { sessionId: foreign.getSessionId() }); assert.equal(host.cwd, foreign.getCwd());
  assert.deepEqual((await host.read("files")).files.map(file => file.path), ["foreign.txt"]);
  const current = (await host.read("sessions", { scope: "all" })).sessions.find(session => session.current); assert.equal(current?.id, foreign.getSessionId());
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
test("registered extension session replacement in the same project rebuilds scope; queued old-scope write is rejected", async () => withHost(async (host, child, { root, bridges }) => {
  const sibling = SessionManager.create(child.manager.getCwd(), join(root, "custom")); sibling.appendMessage({ role: "user", content: "sibling", timestamp: 6 });
  await writeFile(sibling.getSessionFile()!, [sibling.getHeader(), ...sibling.getEntries()].map(line => JSON.stringify(line)).join("\n") + "\n");
  child.disposition = "handled"; child.intercept = async type => {
    if (type === "prompt") { child.manager = sibling; child.entries = sibling.getEntries() as unknown as Record<string, unknown>[]; }
    return { intercepted: false };
  };
  const bridge = bridges[0]!; const expected = { sessionId: bridge.sessionId, generation: bridge.generation, branchRevision: bridge.branchRevision };
  const cwd = host.cwd;
  const extension = host.command("prompt", { text: "/mark" }, expected); const stale = host.command("prompt", { text: "old scope" }, expected);
  await extension; await assert.rejects(stale, { code: "stale_session" }); assert.equal(host.cwd, cwd); assert.equal(bridges.at(-1)?.sessionId, sibling.getSessionId());
  assert.equal(child.running, true); assert.deepEqual((await host.read("files")).files.map(file => file.path), ["local.txt"]);
}));
test("a child that moves itself to another project's session is not accepted: the service fails closed", async () => withHost(async (host, child, { foreign, bridges, launches, logs }) => {
  child.disposition = "handled"; child.intercept = async type => {
    if (type === "prompt") { child.manager = foreign; child.entries = foreign.getEntries() as unknown as Record<string, unknown>[]; }
    return { intercepted: false };
  };
  await assert.rejects(host.command("prompt", { text: "/mark" }), { code: "project_mismatch" });
  assert.equal(child.running, false); assert.equal(launches.length, 1); assert.equal(bridges.length, 1);
  assert.deepEqual(await host.finished, { exit: 0, planned: false });
  // The resume command must name the session the child actually ended on, in its own directory.
  assert.equal(host.sessionFile, foreign.getSessionFile()); assert.equal(host.cwd, foreign.getCwd());
  assert(logs.some(line => line.includes("another project")));
  assert.equal(await SessionFileLock.inspect(foreign.getSessionFile()!), undefined);
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
const settled = (promise: Promise<unknown>) => Promise.race([promise.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 20))]);
test("a session of another project gets a new child started there; the old one is stopped first", async () => withHost(async (host, child, { foreign, launches, suspended, bridges }) => {
  const original = host.sessionFile; await host.read("sessions", { scope: "all" });
  const result = await host.command("session_switch", { sessionId: foreign.getSessionId() }) as { sessionId: string };
  assert.equal(result.sessionId, foreign.getSessionId()); assert.equal(launches.length, 2);
  assert.equal(child.running, false); assert(!child.calls.some(call => call.type === "switch_session"));
  assert.equal(launches[1]!.cwd, await realpath(foreign.getCwd())); assert.deepEqual(launches[1]!.args.slice(-2), ["--session", foreign.getSessionFile()]);
  assert.deepEqual(suspended, ["replacing"]); assert.equal(bridges.at(-1)?.sessionId, foreign.getSessionId());
  assert.equal(host.status().phase, "ready"); assert.equal(await settled(host.finished), false);
  // Ownership moved with the runtime: the old transcript is free, the new one is held.
  assert.equal(await SessionFileLock.inspect(original), undefined); assert.equal((await SessionFileLock.inspect(foreign.getSessionFile()!))?.pid, process.pid);
  await host.command("prompt", { text: "in the other project" }); assert(launches[1]!.child.calls.some(call => call.type === "prompt"));
}));
test("a saved session restores its own model; trust overrides do not travel to another project", async () => withHost(async (host, _child, { foreign, launches }) => {
  // The start model is not replayed over a transcript that records its own; --approve stays with the start project.
  assert.deepEqual(launches[0]!.args, ["--approve", "--no-skills", "--session", host.sessionFile]);
  await host.read("sessions", { scope: "all" }); await host.command("session_switch", { sessionId: foreign.getSessionId() });
  assert.deepEqual(launches[1]!.args, ["--no-skills", "--session", foreign.getSessionFile()]);
}, undefined, ["--model", "start/model", "--approve", "--no-skills"]));
test("a busy or unverifiable old runtime is left running when a project switch is requested", async () => withHost(async (host, child, { foreign, launches }) => {
  await host.read("sessions", { scope: "all" });
  const lock = await SessionFileLock.acquire(foreign.getSessionFile()!);
  try { await assert.rejects(host.command("session_switch", { sessionId: foreign.getSessionId() }), { code: "session_locked" }); } finally { await lock.release(); }
  assert.equal(child.running, true); assert.equal(launches.length, 1); assert.equal(host.status().phase, "ready");
  await rm(foreign.getCwd(), { recursive: true });
  await assert.rejects(host.command("session_switch", { sessionId: foreign.getSessionId() }), { code: "not_found" });
  assert.equal(child.running, true); assert.equal(await SessionFileLock.inspect(foreign.getSessionFile()!), undefined);
  await host.command("prompt", { text: "still here" });
}));
test("a dialog during planned shutdown makes the stop incomplete: recovery, then restore the previous session", async () => withHost(async (host, child, { foreign, launches, bridges, hostStates }) => {
  const original = host.sessionFile; const originalId = bridges[0]!.sessionId; await host.read("sessions", { scope: "all" });
  child.beforeExit = () => child.emit({ type: "extension_ui_request", id: "late", method: "confirm", title: "Save?" });
  await assert.rejects(host.command("session_switch", { sessionId: foreign.getSessionId() }), { code: "recovery_required" });
  const status = host.status(); assert.equal(status.phase, "recovery_required"); assert.equal(status.recovery?.reason, "stop_incomplete"); assert.equal(status.recovery?.canRestore, true);
  assert.equal(launches.length, 1); assert.equal(await settled(host.finished), false);
  // The target was never activated and is free; the previous transcript stays owned while the user decides.
  assert.equal(await SessionFileLock.inspect(foreign.getSessionFile()!), undefined); assert.equal((await SessionFileLock.inspect(original))?.pid, process.pid);
  await assert.rejects(host.command("prompt", { text: "write" }), { code: "recovery_required" });
  await assert.rejects(host.read("files"), { code: "recovery_required" });
  const wire = host.hostState(); assert.equal(wire.phase, "recovery_required"); assert.deepEqual(hostStates.map(state => state.phase).slice(-2), ["replacing", "recovery_required"]);
  assert.deepEqual({ ...wire.recovery, message: "" }, { reason: "stop_incomplete", message: "", targetCwd: await realpath(foreign.getCwd()), previousCwd: launches[0]!.cwd, canRestore: true });
  assert(!JSON.stringify(wire).includes(".jsonl")); // viewers choose by project, not by transcript path
  assert.deepEqual(await host.hostCommand("recover_restore"), { phase: "ready" }); const restored = host.status(); assert.equal(restored.recovery, undefined);
  assert.equal(hostStates.at(-1)?.phase, "ready"); assert(hostStates.every((state, index) => index === 0 || state.revision > hostStates[index - 1]!.revision));
  assert.equal(launches.length, 2); assert.deepEqual(launches[1]!.args, ["--session", original]); assert.equal(bridges.at(-1)?.sessionId, originalId);
  await host.command("prompt", { text: "back" }); await assert.rejects(host.recover("retry"), { code: "no_recovery" });
}));
test("entries written during planned shutdown are accepted only when they are not conversation messages", async () => {
  await withHost(async (host, child, { foreign, launches, logs }) => {
    await host.read("sessions", { scope: "all" });
    child.beforeExit = () => { child.manager.appendCustomEntry("shutdown-note", { saved: true }); };
    await host.command("session_switch", { sessionId: foreign.getSessionId() });
    assert.equal(launches.length, 2); assert.equal(host.status().phase, "ready"); assert(logs.some(line => line.includes("Accepted 1 transcript entries")));
  });
  await withHost(async (host, child, { foreign, launches }) => {
    await host.read("sessions", { scope: "all" });
    child.beforeExit = () => { child.manager.appendMessage({ role: "user", content: "a turn that started after the idle check", timestamp: 9 }); };
    await assert.rejects(host.command("session_switch", { sessionId: foreign.getSessionId() }), { code: "recovery_required" });
    const status = host.status(); assert.equal(status.recovery?.reason, "shutdown_conflict"); assert.equal(status.recovery?.canRestore, false);
    assert.equal(launches.length, 1); await assert.rejects(host.recover("restore"), { code: "restore_unavailable" });
    await host.recover("stop"); assert.deepEqual(await host.finished, { exit: 0, planned: true });
  });
});
test("a target that fails to start leaves recovery; one explicit retry starts it", async () => withHost(async (host, child, fixture) => {
  const { foreign, launches } = fixture; await host.read("sessions", { scope: "all" });
  fixture.prepare = next => { next.intercept = async type => { if (type === "get_state") throw new Error("extension crashed on startup"); return { intercepted: false }; }; };
  await assert.rejects(host.command("session_switch", { sessionId: foreign.getSessionId() }), { code: "recovery_required" });
  assert.equal(host.status().recovery?.reason, "start_failed"); assert.match(host.status().recovery!.message, /extension crashed on startup/);
  assert.equal(launches.length, 2); assert.equal(launches[1]!.child.running, false); assert.equal(child.running, false);
  assert.equal(await SessionFileLock.inspect(foreign.getSessionFile()!), undefined); assert.equal(await settled(host.finished), false);
  // A failing retry is one bounded attempt and stays in recovery.
  await assert.rejects(host.recover("retry"), { code: "recovery_required" }); assert.equal(launches.length, 3); assert.equal(host.status().phase, "recovery_required");
  fixture.prepare = undefined;
  assert.equal((await host.recover("retry")).phase, "ready"); assert.equal(launches.length, 4); assert.equal(host.cwd, foreign.getCwd());
  assert.equal(await SessionFileLock.inspect(launches[0]!.child.manager.getSessionFile()!), undefined);
}));
test("only the ready child's own exit ends the service; a replaced child's exit does not", async () => {
  await withHost(async (host, child, { foreign }) => {
    await host.read("sessions", { scope: "all" }); await host.command("session_switch", { sessionId: foreign.getSessionId() });
    child.crash(1); assert.equal(await settled(host.finished), false);
  });
  await withHost(async (host, child, { foreign, launches }) => {
    await host.read("sessions", { scope: "all" }); await host.command("session_switch", { sessionId: foreign.getSessionId() });
    launches[1]!.child.crash(7); assert.deepEqual(await host.finished, { exit: 7, planned: false });
  });
});
test("stopping the host during a slow planned shutdown releases every lock and starts nothing", async () => withHost(async (host, child, { foreign, launches }) => {
  const original = host.sessionFile; await host.read("sessions", { scope: "all" });
  let release!: () => void; child.beforeExit = () => new Promise<void>(resolve => { release = resolve; });
  const switching = host.command("session_switch", { sessionId: foreign.getSessionId() });
  while (!child.stops) await new Promise(resolve => setTimeout(resolve, 1));
  const stopping = host.stop(); release(); await stopping;
  await assert.rejects(switching); assert.equal(launches.length, 1);
  assert.equal(await SessionFileLock.inspect(original), undefined); assert.equal(await SessionFileLock.inspect(foreign.getSessionFile()!), undefined);
}));
const registryOf = async (root: string) => JSON.parse(await readFile(join(root, "agent", "pi-pane", "projects.json"), "utf8")) as { projects: { path: string; source: string; lastSession?: { id: string; file: string } }[]; hidden: string[] };
const gate = async (directory: string) => { await mkdir(join(directory, ".pi", "extensions"), { recursive: true }); await writeFile(join(directory, ".pi", "extensions", "x.ts"), "export default () => {};\n"); };
test("an empty directory opens as a project with a new unsaved session, stays listed, and the old project is returned to its session", async () => withHost(async (host, child, { root, launches, bridges }) => {
  const original = host.sessionFile; const originalId = bridges[0]!.sessionId; const first = await realpath(join(root, "project"));
  const empty = join(root, "空 项目"); await mkdir(empty); const real = await realpath(empty);
  assert.deepEqual(await host.hostCommand("project_open", { path: empty }), { path: real });
  assert.equal(launches.length, 2); assert.equal(launches[1]!.cwd, real); assert(!launches[1]!.args.includes("--session")); assert.equal(child.running, false);
  // No transcript exists until the first message; the path the child chose is already owned.
  const session = launches[1]!.child.manager.getSessionFile()!; assert.equal(host.sessionFile, session); assert.equal(host.cwd, real);
  await assert.rejects(readFile(session)); assert.equal((await SessionFileLock.inspect(session))?.pid, process.pid); assert.equal(await SessionFileLock.inspect(original), undefined);
  const view = await host.hostQuery("projects");
  assert.deepEqual(view.projects.map(project => [project.path, project.source, project.current, project.sessions]), [[real, "opened", true, 0], [first, "opened", false, 1], [await realpath(join(root, "other")), "history", false, 1]]);
  assert.equal(view.current.path, real); assert.deepEqual(view.current.trust, { required: false, choice: "unknown", policy: "ask", ask: false, loaded: 0 });
  const registry = await registryOf(root);
  assert.deepEqual(registry.projects.map(project => project.path).sort(), [first, real].sort());
  assert.deepEqual(registry.projects.find(project => project.path === first)?.lastSession, { id: originalId, file: original });
  assert(!JSON.stringify(registry).includes("first user")); // entries only: no conversation text
  // Leaving the unsaved session and coming back restores the saved one; the empty project remains, with a new session.
  assert.deepEqual(await host.hostCommand("project_open", { path: join(root, "project") }), { path: first });
  assert.deepEqual(launches[2]!.args, ["--session", original]); assert.equal(bridges.at(-1)?.sessionId, originalId); assert.equal(await SessionFileLock.inspect(session), undefined);
  assert.deepEqual(await host.hostCommand("project_open", { path: join(root, "project") }), { path: first, unchanged: true }); assert.equal(launches.length, 3);
  await host.hostCommand("project_open", { path: real }); assert(!launches[3]!.args.includes("--session"));
  assert.deepEqual((await host.hostQuery("project_inspect", { path: empty })), { path: real, name: "空 项目", current: true, registered: true, sessions: 0, trust: { required: false, choice: "unknown", policy: "ask", ask: false, loaded: 0 } });
}));
test("creating a project makes exactly one folder; an existing name or a failed start never removes anything", async () => withHost(async (host, child, fixture) => {
  const { root, launches } = fixture; const parent = join(root, "workspace"); await mkdir(parent); const real = await realpath(parent);
  assert.deepEqual(await host.hostCommand("project_create", { parent, name: "新 app" }), { path: join(real, "新 app") });
  assert.equal(launches[1]!.cwd, join(real, "新 app")); assert.equal((await registryOf(root)).projects.find(project => project.path === join(real, "新 app"))?.source, "created");
  await writeFile(join(real, "新 app", "notes.md"), "mine");
  await assert.rejects(host.hostCommand("project_create", { parent, name: "新 app" }), { code: "project_exists" }); assert.equal(launches.length, 2); assert.equal(launches[1]!.child.running, true);
  assert.equal(await readFile(join(real, "新 app", "notes.md"), "utf8"), "mine");
  await assert.rejects(host.hostCommand("project_create", { parent: join(root, "missing"), name: "x" }), { code: "not_found" }); assert.equal(launches[1]!.child.running, true);
  await assert.rejects(host.hostCommand("project_create", { parent, name: "../escape" }), { code: "invalid_name" });
  fixture.prepare = next => { next.intercept = async type => { if (type === "get_state") throw new Error("startup failed"); return { intercepted: false }; }; };
  await assert.rejects(host.hostCommand("project_create", { parent, name: "second" }), { code: "recovery_required" });
  assert((await realpath(join(parent, "second")))); assert((await registryOf(root)).projects.some(project => project.path === join(real, "second")));
  assert.equal(host.hostState().recovery?.targetCwd, join(real, "second")); assert.equal(host.hostState().recovery?.previousCwd, join(real, "新 app"));
}));
test("an unknown project with trust-gated resources is asked about; the host never generates --approve", async () => withHost(async (host, child, { root, launches }) => {
  const gated = join(root, "gated"); await gate(gated); const real = await realpath(gated);
  assert.equal((await host.hostQuery("project_inspect", { path: gated })).trust.ask, true);
  await assert.rejects(host.hostCommand("project_open", { path: gated }), { code: "trust_required" });
  assert.equal(child.running, true); assert.equal(launches.length, 1); assert.equal((await host.hostQuery("projects")).projects.some(project => project.path === real), false);
  // Continue without loading: process-wide, but in the direction of loading less, and only for this run.
  await host.hostCommand("project_open", { path: gated, trust: "withhold" });
  assert.deepEqual(launches[1]!.args, ["--no-skills", "--no-approve"]);
  let trust = (await host.hostQuery("projects")).current.trust; assert.equal(trust.withheld, true); assert.equal(trust.choice, "unknown"); assert.equal(trust.ask, true);
  // The same project again, now trusted and remembered: only a restart applies it, on the same (unsaved → new) session.
  await host.hostCommand("project_open", { path: gated, trust: "remember" });
  assert.deepEqual(launches[2]!.args, ["--no-skills"]); assert.equal(launches[2]!.cwd, real);
  trust = (await host.hostQuery("projects")).current.trust; assert.deepEqual(trust, { required: true, choice: "trusted", policy: "ask", ask: false, loaded: 0 });
  // The start project gets its own --approve back; it never travelled to the other project.
  await host.hostCommand("project_open", { path: join(root, "project") });
  assert.deepEqual(launches[3]!.args.slice(0, 2), ["--approve", "--no-skills"]); assert.equal((await host.hostQuery("projects")).current.trust.override, "approve");
  assert(launches.slice(1, 3).every(launch => !launch.args.includes("--approve") && !launch.args.includes("-a")));
  // A project opened by picking one of its sessions was not asked: it is opened without a trust flag and without recording anything.
  await writeFile(join(root, "agent", "trust.json"), "{}").catch(() => undefined);
}, undefined, ["--approve", "--no-skills"]));
test("credential directories are refused as project roots, for projects and for sessions that live there", async () => withHost(async (host, child, { root, launches }) => {
  const secret = join(root, ".ssh", "repo"); await mkdir(secret, { recursive: true });
  await assert.rejects(host.hostCommand("project_open", { path: secret }), { code: "project_root_refused" });
  // pi creates its agent directory as soon as the host reads the project's trust, so it always exists here.
  await mkdir(join(root, "agent"), { recursive: true }); await assert.rejects(host.hostCommand("project_open", { path: join(root, "agent") }), { code: "project_root_refused" });
  await assert.rejects(host.hostCommand("project_open", { path: join(root, "custom") }), { code: "project_root_refused" }); // the session directory
  const hidden = SessionManager.create(secret, join(root, "custom")); hidden.appendMessage({ role: "user", content: "in ssh", timestamp: 7 });
  hidden.appendMessage({ role: "assistant", content: [{ type: "text", text: "a" }], api: "fixture", provider: "local", model: "fixture", timestamp: 8, stopReason: "stop", usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as never);
  await host.read("sessions", { scope: "all" });
  await assert.rejects(host.command("session_switch", { sessionId: hidden.getSessionId() }), { code: "project_root_refused" });
  assert.equal(child.running, true); assert.equal(launches.length, 1);
  assert.equal((await host.hostQuery("directories", { path: secret })).refused, "credential_directory");
  assert.equal((await host.hostQuery("directories")).path, await realpath(join(root, "project")));
}));
test("project switches are refused while busy, and two viewers acting on the same state do not both switch", async () => withHost(async (host, child, { root, launches }) => {
  const a = join(root, "a"), b = join(root, "b"); await mkdir(a); await mkdir(b);
  child.streaming = true; await assert.rejects(host.hostCommand("project_open", { path: a }), { code: "busy" }); child.streaming = false; await host.read("tree");
  child.emit({ type: "extension_ui_request", id: "open", method: "confirm", title: "?" });
  await assert.rejects(host.hostCommand("project_open", { path: a }), { code: "busy" }); host.answer("open", { cancelled: true });
  assert.equal(launches.length, 1);
  const revision = host.hostState().revision;
  const [first, second] = await Promise.allSettled([host.hostCommand("project_open", { path: a }, revision), host.hostCommand("project_open", { path: b }, revision)]);
  assert.equal(first.status, "fulfilled", String((first as PromiseRejectedResult).reason)); assert.equal(second.status, "rejected"); assert.equal((second as PromiseRejectedResult).reason.code, "stale_host");
  assert.equal(launches.length, 2); assert.equal(host.cwd, await realpath(a));
}));
test("removing from the list keeps the directory and its sessions and survives history; the current project cannot be removed", async () => withHost(async (host, _child, { root, foreign }) => {
  const other = await realpath(foreign.getCwd());
  await assert.rejects(host.hostCommand("project_remove", { path: join(root, "project") }), { code: "project_current" });
  assert.deepEqual(await host.hostCommand("project_remove", { path: foreign.getCwd() }), { path: other });
  const view = await host.hostQuery("projects"); assert.equal(view.projects.some(project => project.path === other), false);
  assert.deepEqual((await registryOf(root)).hidden, [other]); assert.equal(await readFile(join(other, "foreign.txt"), "utf8"), "foreign"); assert(await readFile(foreign.getSessionFile()!, "utf8"));
  // Its sessions are still reachable, and opening it again lists it again.
  assert((await host.read("sessions", { scope: "all" })).sessions.some(session => session.id === foreign.getSessionId()));
  await host.hostCommand("project_open", { path: other }); assert.deepEqual((await registryOf(root)).hidden, []);
  assert.equal((await host.hostQuery("projects")).projects.find(project => project.path === other)?.current, true);
}));
test("a moved project is shown unavailable and only relocated to a directory the user chooses", async () => withHost(async (host, _child, { root }) => {
  const old = join(root, "moved-from"); await mkdir(old); const oldReal = await realpath(old);
  await host.hostCommand("project_open", { path: old }); await host.hostCommand("project_open", { path: join(root, "project") });
  await rm(old, { recursive: true }); await mkdir(join(root, "moved-to")); await mkdir(join(root, "moved-from-lookalike"));
  assert.equal((await host.hostQuery("projects")).projects.find(project => project.path === oldReal)?.available, false);
  await assert.rejects(host.hostCommand("project_open", { path: old }), { code: "not_found" });
  await assert.rejects(host.hostCommand("project_relocate", { from: oldReal, to: join(root, ".ssh") }), { code: "not_found" });
  const to = await realpath(join(root, "moved-to"));
  assert.deepEqual(await host.hostCommand("project_relocate", { from: oldReal, to: join(root, "moved-to") }), { path: to });
  const projects = (await host.hostQuery("projects")).projects; assert.equal(projects.find(project => project.path === to)?.available, true); assert.equal(projects.some(project => project.path === oldReal), false);
  await assert.rejects(host.hostCommand("project_relocate", { from: oldReal, to }), { code: "unknown_project" });
}));
test("an unreadable project list is left untouched, reported, and does not block opening a project", async () => withHost(async (host, _child, { root, logs }) => {
  await mkdir(join(root, "agent", "pi-pane"), { recursive: true }); const file = join(root, "agent", "pi-pane", "projects.json"); await writeFile(file, "{ not json");
  const view = await host.hostQuery("projects"); assert.match(view.registryError ?? "", /not valid JSON/);
  assert.deepEqual(view.projects.map(project => project.source), ["history", "history"]); assert.equal(view.projects[0]!.current, true);
  const empty = join(root, "empty"); await mkdir(empty);
  await host.hostCommand("project_open", { path: empty }); assert.equal(host.cwd, await realpath(empty));
  assert.equal(await readFile(file, "utf8"), "{ not json"); assert(logs.some(line => line.includes("project list was not updated")));
  await assert.rejects(host.hostCommand("project_remove", { path: join(root, "other") }), { code: "registry_corrupt" });
}));
const waitFor = async <T>(read: () => T | undefined | null | false | Promise<T | undefined | null | false>, label = "condition"): Promise<T> => {
  for (let index = 0; index < 400; index++) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(`Timed out: ${label}`);
};
async function signIn(host: HandoffHost, lease: string, provider: string, key: string) {
  const { operationId } = await host.hostCommand("account_begin", { provider, method: "api_key" }, 0, lease) as { operationId: string };
  const step = await waitFor(() => host.accountState(lease).operation?.step, "key step");
  host.accountAnswer(lease, operationId, step.id, key);
  await waitFor(() => host.accountState(lease).operation?.status === "saved", "saved");
}
const models = async (host: HandoffHost, provider: string) => (await host.hostQuery("accounts")).providers.find(item => item.id === provider);
test("a key saved from the browser reaches the running session in process: same child, same session, same lock", async () => withHost(async (host, child, { launches, bridges, auth, hostStates }) => {
  const session = host.sessionFile, sessionId = bridges[0]!.sessionId;
  let accounts = await host.hostQuery("accounts");
  assert.deepEqual(accounts.providers.map(provider => [provider.id, provider.stored, provider.models]), [["local", undefined, 1], ["acme", undefined, 0], ["cloud", undefined, 0], ["kimi-coding", undefined, 0]]);
  assert.deepEqual(accounts.providers[0]!.methods, [{ type: "api_key", label: "", web: false, reason: "extension" }]); assert.equal(accounts.pendingApply, false);
  // Stale page state does not block an account command; it has its own operation identity.
  await signIn(host, "lease-1", "acme", "sk-web-key");
  await waitFor(() => !child.calls.every(call => call.type !== "switch_session") && host.hostState().phase === "ready", "applied");
  await waitFor(async () => (await models(host, "acme"))?.models === 1, "model list refreshed");
  accounts = await host.hostQuery("accounts");
  assert.deepEqual(accounts.providers.map(provider => [provider.id, provider.stored, provider.models]).slice(0, 2), [["acme", "api_key", 1], ["local", undefined, 1]]); assert.equal(accounts.pendingApply, false);
  assert.deepEqual(child.calls.filter(call => call.type === "switch_session").map(call => call.payload.sessionPath), [session]);
  assert.equal(launches.length, 1); assert.equal(child.running, true); assert.equal(host.sessionFile, session); assert.equal(bridges.at(-1)?.sessionId, sessionId); assert.equal(bridges.length, 2);
  assert.equal((await SessionFileLock.inspect(session))?.pid, process.pid); assert.equal(auth.stored.get("acme")?.key, "sk-web-key");
  assert(!JSON.stringify([accounts, host.accountState("lease-1"), host.hostState(), hostStates]).includes("sk-web-key"));
  await host.command("prompt", { text: "still the same conversation" });
  // Signing out removes the stored credential and is applied the same way.
  assert.deepEqual(await host.hostCommand("account_logout", { provider: "acme" }, 0, "lease-2"), { pendingApply: true });
  await waitFor(() => child.calls.filter(call => call.type === "switch_session").length === 2, "logout applied");
  await waitFor(async () => (await host.hostQuery("accounts")).pendingApply === false, "apply settled");
  assert.deepEqual([(await models(host, "acme"))?.stored, (await models(host, "acme"))?.models], [undefined, 0]);
  await assert.rejects(host.hostCommand("account_logout", { provider: "acme" }, 0, "lease-2"), { code: "not_stored" });
}));
test("an unsaved session is replaced by a new one to apply a credential; its lock follows", async () => withHost(async (host, _child, { root, launches }) => {
  const empty = join(root, "empty"); await mkdir(empty); await host.hostCommand("project_open", { path: empty });
  const runtime = launches[1]!.child, before = host.sessionFile;
  await signIn(host, "lease-1", "acme", "sk-key");
  await waitFor(() => runtime.calls.some(call => call.type === "new_session"), "new session");
  await waitFor(async () => (await host.hostQuery("accounts")).pendingApply === false, "apply settled");
  assert(!runtime.calls.some(call => call.type === "switch_session")); assert.equal(launches.length, 2); assert.equal((await models(host, "acme"))?.models, 1);
  assert.notEqual(host.sessionFile, before); assert.equal(await SessionFileLock.inspect(before), undefined); assert.equal((await SessionFileLock.inspect(host.sessionFile))?.pid, process.pid);
  assert.equal(host.cwd, await realpath(empty));
}));
test("a credential saved while pi is busy waits for the user; it is never applied behind a running reply", async () => withHost(async (host, child) => {
  child.streaming = true; await host.read("tree");
  await signIn(host, "lease-1", "acme", "sk-key");
  await new Promise(resolve => setTimeout(resolve, 40));
  let accounts = await host.hostQuery("accounts"); assert.equal(accounts.pendingApply, true); assert.equal(accounts.providers.find(provider => provider.id === "acme")?.stored, "api_key"); assert.equal(accounts.providers.find(provider => provider.id === "acme")?.models, 0);
  assert(!child.calls.some(call => call.type === "switch_session"));
  await assert.rejects(host.hostCommand("account_apply", {}, 0, "lease-2"), { code: "busy" });
  assert.match((await host.hostQuery("accounts")).applyError ?? "", /settled/);
  child.streaming = false; await host.read("tree"); await new Promise(resolve => setTimeout(resolve, 40));
  assert(!child.calls.some(call => call.type === "switch_session"), "the end of a reply does not trigger the apply");
  assert.deepEqual(await host.hostCommand("account_apply", {}, 0, "lease-2"), { pendingApply: false }); // any signed-in page may apply
  accounts = await host.hostQuery("accounts"); assert.equal(accounts.pendingApply, false); assert.equal(accounts.applyError, undefined); assert.equal(accounts.providers.find(provider => provider.id === "acme")?.models, 1);
  assert.deepEqual(await host.hostCommand("account_apply", {}, 0, "lease-2"), { pendingApply: false }); assert.equal(child.calls.filter(call => call.type === "switch_session").length, 1);
}));
test("an extension may decline the reload: the credential stays saved, the session stays usable, and applying can be retried", async () => withHost(async (host, child, { auth }) => {
  child.cancelNext = true;
  await signIn(host, "lease-1", "acme", "sk-key");
  await waitFor(async () => (await host.hostQuery("accounts")).applyError, "declined");
  const accounts = await host.hostQuery("accounts"); assert.equal(accounts.pendingApply, true); assert.match(accounts.applyError!, /declined/); assert.equal(auth.stored.has("acme"), true);
  assert.equal(child.running, true); await host.command("prompt", { text: "old runtime still answers" });
  assert.deepEqual(await host.hostCommand("account_apply", {}, 0, "lease-1"), { pendingApply: false }); assert.equal((await models(host, "acme"))?.models, 1);
}));
test("login steps are private to the starting page, survive its absence, and end with the service", async () => withHost(async (host, _child, fixture) => {
  let approve!: () => void;
  fixture.auth.script = async (_provider, type, interaction) => {
    interaction.notify({ type: "device_code", userCode: "QRST-UVWX", verificationUri: "https://provider.example/device", expiresInSeconds: 600 });
    await new Promise<void>((resolve, reject) => { approve = resolve; interaction.signal!.addEventListener("abort", () => reject(new Error("aborted"))); });
    return { type };
  };
  const published = fixture.accountStates;
  const { operationId } = await host.hostCommand("account_begin", { provider: "kimi-coding", method: "oauth" }, 0, "phone") as { operationId: string };
  await waitFor(() => host.accountState("phone").operation?.notices, "device code");
  assert(fixture.accountStates > published); assert(JSON.stringify(host.accountState("phone")).includes("QRST-UVWX"));
  const other = host.accountState("desktop"); assert.equal(other.operation?.status, "running"); assert.equal(other.operation?.owner, false); assert(!JSON.stringify(other).includes("QRST")); assert(!JSON.stringify(other).includes("provider.example"));
  assert.throws(() => host.accountAnswer("desktop", operationId, "x", "y"), { code: "not_owner" });
  await assert.rejects(host.hostCommand("account_begin", { provider: "acme", method: "api_key" }, 0, "desktop"), { code: "account_busy" });
  // Conversation and project work go on while the user is away approving.
  await host.command("prompt", { text: "while waiting" }); assert.equal(host.accountState("phone").operation?.status, "running");
  // Another lease ending changes nothing; the owner's lease ending cancels.
  host.leaseEnded("desktop"); assert.equal(host.accountState("phone").operation?.status, "running");
  approve(); await waitFor(() => host.accountState("phone").operation?.status === "saved", "saved"); assert.equal(host.accountState("desktop").operation, null);
  await host.hostCommand("account_begin", { provider: "kimi-coding", method: "oauth" }, 0, "phone"); await waitFor(() => host.accountState("phone").operation?.notices, "second code");
  host.leaseEnded("phone"); await waitFor(() => host.accountState("phone").operation?.status === "cancelled", "owner gone");
  const third = await host.hostCommand("account_begin", { provider: "kimi-coding", method: "oauth" }, 0, "phone") as { operationId: string };
  await host.hostCommand("account_cancel", { operationId: third.operationId }, 0, "desktop"); await waitFor(() => host.accountState("phone").operation?.status === "cancelled", "cancelled by another page");
  await host.hostCommand("account_begin", { provider: "kimi-coding", method: "oauth" }, 0, "phone"); await waitFor(() => host.accountState("phone").operation?.notices, "fourth code");
  await host.stop(); await waitFor(() => host.accountState("phone").operation?.status === "cancelled", "service stop");
}));
test("the built-in login and logout commands open the account page instead of being sent to the model", async () => withHost(async (host, child) => {
  const commands = (await host.read("commands")).commands;
  for (const name of ["login", "logout"]) { const command = commands.find(item => item.name === name)!; assert.equal(command.available, true); assert.equal(command.browserAction, "accounts"); assert.equal(command.terminalOnly, undefined); }
  await assert.rejects(host.command("prompt", { text: "/login" }), { code: "picker_required" }); assert(!child.calls.some(call => call.type === "prompt"));
  assert.equal((await host.read("resources")).capabilities.find(capability => capability.name === "authentication")?.available, true);
}));
const themeFile = async (name: string, accent: string, appearance: "light" | "dark" = "dark") => {
  const base = JSON.parse(await readFile(new URL("../themes/pi-pane-dark.json", import.meta.url), "utf8"));
  return JSON.stringify({ ...base, name, appearance, colors: { ...base.colors, accent } });
};
const globalSettings = async (root: string) => JSON.parse(await readFile(join(root, "agent", "settings.json"), "utf8").catch(() => "{}"));
test("follow pi is the theme pi would use in the current project; saving pi's default changes it for every viewer", async () => withHost(async (host, _child, { root, bridges }) => {
  await mkdir(join(root, "agent", "themes"), { recursive: true }); await writeFile(join(root, "agent", "themes", "mine.json"), await themeFile("mine", "#123456"));
  let themes = await host.hostQuery("themes");
  // Nothing is configured: pi's default is its terminal theme, which only the handoff captured.
  assert.deepEqual(themes.pi, { source: "default", name: "system", appearance: "dark", origin: "handoff", reason: "system" });
  assert.deepEqual(themes.themes.map(item => [item.name, item.source, item.global]), [["pi-pane-dark", "pi-pane", false], ["pi-pane-light", "pi-pane", false], ["mine", "user", true]]);
  assert.equal(themes.projectThemes, "none"); assert.deepEqual(themes.problems, []);
  const mine = await host.hostQuery("theme", { name: "mine" }); assert.equal(mine.vars["--accent"], "#123456"); assert.equal(mine.appearance, "dark");
  await assert.rejects(host.hostQuery("theme", { name: "gone" }), { code: "theme_missing" });
  const before = bridges.at(-1)!.snapshot().theme["--accent"];
  // A theme of this package that pi itself does not know (run from source) cannot become pi's default.
  await assert.rejects(host.hostCommand("setting_set", { key: "theme", value: "pi-pane-dark", expected: null }), { code: "theme_not_global" });
  const revision = host.hostState().revision;
  const saved = await host.hostCommand("setting_set", { key: "theme", value: "mine", expected: null }) as { saved: string; applied: string; item: { global: unknown } };
  assert.deepEqual([saved.saved, saved.applied, saved.item.global], ["confirmed", "later", "mine"]); assert.equal((await globalSettings(root)).theme, "mine");
  assert(host.hostState().revision > revision, "every page re-reads settings and themes");
  themes = await host.hostQuery("themes"); assert.deepEqual(themes.pi, { setting: "mine", source: "global", name: "mine", appearance: "dark", origin: "catalog" });
  assert.equal(bridges.at(-1)!.snapshot().theme["--accent"], "#123456"); assert.notEqual(before, "#123456");
  // A second page that still shows the old value is told so; the theme it did not see is not overwritten.
  await assert.rejects(host.hostCommand("setting_set", { key: "theme", value: "system", expected: null }), { code: "stale_setting" });
  // The file disappears: the colors stay those of the handoff, with the reason.
  await rm(join(root, "agent", "themes", "mine.json"));
  assert.deepEqual((await host.hostQuery("themes")).pi, { setting: "mine", source: "global", name: "system", appearance: "dark", origin: "handoff", reason: "missing" });
}));
test("a project's own themes and settings are read only when that project is trusted", async () => withHost(async (host, _child, { root, bridges }) => {
  const gated = join(root, "gated"); await mkdir(join(gated, ".pi", "themes"), { recursive: true });
  await writeFile(join(gated, ".pi", "themes", "theirs.json"), await themeFile("theirs", "#abcdef", "light"));
  await writeFile(join(gated, ".pi", "settings.json"), JSON.stringify({ theme: "theirs", images: { blockImages: true } }));
  await host.hostCommand("project_open", { path: gated, trust: "withhold" });
  let themes = await host.hostQuery("themes"); assert.equal(themes.projectThemes, "untrusted"); assert.equal(themes.themes.some(item => item.name === "theirs"), false);
  assert.equal(themes.pi.source, "default"); assert.notEqual(bridges.at(-1)!.snapshot().theme["--accent"], "#abcdef");
  let settings = await host.hostQuery("settings"); assert.equal(settings.project.settings, "untrusted");
  assert.equal(settings.items.find(item => item.key === "theme")!.project, undefined); assert.equal(settings.items.find(item => item.key === "images.blockImages")!.effective, false);
  await assert.rejects(host.hostQuery("theme", { name: "theirs" }), { code: "theme_missing" });
  await host.hostCommand("project_open", { path: gated, trust: "remember" });
  themes = await host.hostQuery("themes"); assert.equal(themes.projectThemes, "loaded");
  assert.deepEqual(themes.themes.find(item => item.name === "theirs"), { name: "theirs", source: "project", appearance: "light", global: false, preview: themes.themes.find(item => item.name === "theirs")!.preview });
  assert.deepEqual(themes.pi, { setting: "theirs", source: "project", name: "theirs", appearance: "light", origin: "catalog" });
  assert.equal(bridges.at(-1)!.snapshot().theme["--accent"], "#abcdef", "the snapshot of the new project carries its theme");
  settings = await host.hostQuery("settings"); assert.equal(settings.project.settings, "loaded");
  const theme = settings.items.find(item => item.key === "theme")!; assert.deepEqual([theme.global, theme.project, theme.effective], [null, "theirs", "theirs"]);
  assert.equal(theme.options!.includes("theirs"), false, "a project's theme is not offered as pi's default");
  await assert.rejects(host.hostCommand("setting_set", { key: "theme", value: "theirs", expected: null }), { code: "theme_not_global" });
  // Back in the first project nothing of the other one remains.
  await host.hostCommand("project_open", { path: join(root, "project") });
  themes = await host.hostQuery("themes"); assert.equal(themes.themes.some(item => item.name === "theirs"), false); assert.equal(themes.pi.origin, "handoff");
}));
test("settings pi changes itself wait for an idle session; a setting the session reads once is applied by reloading it", async () => withHost(async (host, child, { root }) => {
  let settings = await host.hostQuery("settings");
  assert.deepEqual(settings.items.find(item => item.key === "steeringMode"), { key: "steeringMode", kind: "choice", options: ["one-at-a-time", "all"], effective: "one-at-a-time", global: null, defaultValue: "one-at-a-time", runtime: "one-at-a-time", writes: "runtime", applies: "now", editable: true });
  assert.deepEqual(settings.items.find(item => item.key === "defaultModel")!.options, ["local/fixture"]); assert.equal(settings.pendingApply, false);
  child.streaming = true; await assert.rejects(host.hostCommand("setting_set", { key: "steeringMode", value: "all", expected: null }), { code: "busy" });
  assert.equal(child.calls.some(call => call.type === "set_steering_mode"), false);
  // Saving a default is not a change to the running reply: it goes through while pi is busy, and waits to be applied.
  const blocked = await host.hostCommand("setting_set", { key: "images.blockImages", value: true, expected: null }) as { saved: string; applied: string };
  assert.deepEqual([blocked.saved, blocked.applied], ["confirmed", "pending"]); assert.equal((await globalSettings(root)).images.blockImages, true);
  await new Promise(resolve => setTimeout(resolve, 30));
  settings = await host.hostQuery("settings"); assert.equal(settings.pendingApply, true); assert.equal(child.calls.some(call => call.type === "switch_session"), false);
  assert.equal((await host.hostQuery("accounts")).pendingApply, true, "one pending reload, whatever caused it");
  child.streaming = false; await host.read("tree");
  assert.deepEqual(await host.hostCommand("account_apply", {}), { pendingApply: false }); assert.equal(child.calls.filter(call => call.type === "switch_session").length, 1);
  // Idle: pi's own command is used, the session state follows, and the default it saved is confirmed from disk.
  const steering = await host.hostCommand("setting_set", { key: "steeringMode", value: "all", expected: null }) as { saved: string; applied: string; item: { runtime: unknown; global: unknown } };
  assert.deepEqual([steering.saved, steering.applied, steering.item.runtime, steering.item.global], ["confirmed", "now", "all", "all"]);
  assert.deepEqual(child.calls.find(call => call.type === "set_steering_mode")?.payload, { mode: "all" });
  // pi accepted the command and did not save it: reported as it is.
  child.saveSettings = false;
  const retry = await host.hostCommand("setting_set", { key: "retry.enabled", value: false, expected: null }) as { saved: string; applied: string };
  assert.deepEqual([retry.saved, retry.applied], ["unconfirmed", "now"]); child.saveSettings = true;
  // A default saved while idle is applied at once, without a restart.
  const unblocked = await host.hostCommand("setting_set", { key: "images.blockImages", value: false, expected: true }) as { applied: string };
  assert.equal(unblocked.applied, "pending");
  await waitFor(async () => (await host.hostQuery("settings")).pendingApply === false, "applied");
  assert.equal(child.calls.filter(call => call.type === "switch_session").length, 2);
  // Two pages changing the same setting from the same view: one wins, the other is told to look again.
  const [first, second] = await Promise.allSettled([host.hostCommand("setting_set", { key: "defaultThinkingLevel", value: "high", expected: null }), host.hostCommand("setting_set", { key: "defaultThinkingLevel", value: "low", expected: null })]);
  assert.equal(first.status, "fulfilled"); assert.equal((second as PromiseRejectedResult).reason.code, "stale_setting"); assert.equal((await globalSettings(root)).defaultThinkingLevel, "high");
  assert.equal((await host.hostCommand("setting_set", { key: "defaultModel", value: "local/fixture", expected: null }) as { saved: string }).saved, "confirmed");
  assert.deepEqual([(await globalSettings(root)).defaultProvider, (await globalSettings(root)).defaultModel], ["local", "fixture"]);
  await assert.rejects(host.hostCommand("setting_set", { key: "defaultModel", value: "other/model", expected: "local/fixture" }), { code: "invalid_setting" });
}));
test("start arguments are shown as overrides of the defaults, and /settings opens the settings page", async () => withHost(async (host, child) => {
  const settings = await host.hostQuery("settings");
  assert.equal(settings.items.find(item => item.key === "defaultModel")!.cli, "acme/fast"); assert.equal(settings.items.find(item => item.key === "defaultThinkingLevel")!.cli, "high");
  assert.equal(settings.items.find(item => item.key === "theme")!.cli, "light");
  assert.deepEqual((await host.hostQuery("themes")).pi, { setting: "light", source: "cli", name: "system", appearance: "dark", origin: "handoff", reason: "missing" });
  const command = (await host.read("commands")).commands.find(item => item.name === "settings")!; assert.equal(command.browserAction, "settings"); assert.equal(command.available, true);
  await assert.rejects(host.command("prompt", { text: "/settings" }), { code: "picker_required" }); assert(!child.calls.some(call => call.type === "prompt"));
  assert.equal((await host.read("resources")).capabilities.find(capability => capability.name === "settings")?.available, true);
}, undefined, ["--provider", "acme", "--model", "fast", "--thinking", "high", "--use-theme", "light"]));
const modelsFile = (root: string) => join(root, "agent", "models.json");
const providerArgs = (extra: Record<string, unknown> = {}) => ({ id: "mine", api: "openai-completions", baseUrl: "https://mine.example/v1", models: [{ id: "m1", contextWindow: 32000 }], create: true, ...extra });
test("a custom provider is saved to models.json without a key, gets its key through pi's login, and reaches the session by a reload", async () => withHost(async (host, child, { root, auth }) => {
  let view = await host.hostQuery("providers"); assert.deepEqual([view.providers, view.revision, view.error, view.pendingApply], [[], "absent", undefined, false]);
  // Names pi already uses are refused: its own providers, and one the running session has from an extension.
  await assert.rejects(host.hostCommand("provider_save", providerArgs({ id: "acme", revision: view.revision })), { code: "provider_name_taken", field: "id" });
  await assert.rejects(host.hostCommand("provider_save", providerArgs({ id: "local", revision: view.revision })), { code: "provider_name_taken", field: "id" });
  await assert.rejects(host.hostCommand("provider_save", providerArgs({ baseUrl: "ftp://mine.example", revision: view.revision })), { code: "invalid_provider", field: "baseUrl" });
  assert.equal(existsSync(modelsFile(root)), false);
  const saved = await host.hostCommand("provider_save", providerArgs({ baseUrl: "http://10.0.0.5:8000/v1", revision: view.revision })) as { id: string; revision: string; insecure?: boolean };
  assert.deepEqual([saved.id, saved.insecure], ["mine", true]);
  assert.deepEqual(JSON.parse(await readFile(modelsFile(root), "utf8")), { providers: { mine: { baseUrl: "http://10.0.0.5:8000/v1", api: "openai-completions", models: [{ id: "m1", contextWindow: 32000 }] } } });
  await waitFor(async () => !(await host.hostQuery("providers")).pendingApply, "applied"); assert.equal(child.calls.filter(call => call.type === "switch_session").length, 1);
  view = await host.hostQuery("providers");
  assert.deepEqual(view.providers, [{ id: "mine", api: "openai-completions", baseUrl: "http://10.0.0.5:8000/v1", models: [{ id: "m1", contextWindow: 32000 }], extra: [], modelExtras: 0, insecure: true, key: "none", overlay: false, inUse: false, available: 0 }]);
  assert.equal(view.revision, saved.revision);
  // It is listed under accounts as a provider whose key can be set from the browser.
  const account = (await host.hostQuery("accounts")).providers.find(provider => provider.id === "mine");
  assert.deepEqual(account, { id: "mine", name: "mine", methods: [{ type: "api_key", label: "API key", web: true }], models: 0, knownModels: 1, custom: true });
  await signIn(host, "lease-1", "mine", "!not-a-command $HOME");
  assert.equal(auth.stored.get("mine")!.key, "$!not-a-command $$HOME", "escaped so that pi reads it back as typed");
  assert.equal((await readFile(modelsFile(root), "utf8")).includes("not-a-command"), false, "the key is not in models.json");
  await waitFor(async () => (await host.hostQuery("providers")).providers[0]!.available === 1, "model available");
  view = await host.hostQuery("providers"); assert.equal(view.providers[0]!.key, "stored"); assert.equal(JSON.stringify(view).includes("not-a-command"), false);
  // Editing from a stale view is refused; from the current one it keeps what the form does not show.
  await writeFile(modelsFile(root), JSON.stringify({ providers: { mine: { baseUrl: "http://10.0.0.5:8000/v1", api: "openai-completions", headers: { "x-org": "team" }, models: [{ id: "m1", contextWindow: 32000, input: ["text", "image"] }] } }, other: 1 }));
  await assert.rejects(host.hostCommand("provider_save", providerArgs({ create: false, revision: view.revision })), { code: "stale_providers" });
  view = await host.hostQuery("providers"); assert.deepEqual([view.providers[0]!.extra, view.providers[0]!.modelExtras], [["headers"], 1]);
  await host.hostCommand("provider_save", providerArgs({ create: false, baseUrl: "https://mine.example/v1", models: [{ id: "m1" }, { id: "m2", name: "Second" }], revision: view.revision }));
  assert.deepEqual(JSON.parse(await readFile(modelsFile(root), "utf8")), { providers: { mine: { baseUrl: "https://mine.example/v1", api: "openai-completions", headers: { "x-org": "team" }, models: [{ id: "m1", input: ["text", "image"] }, { id: "m2", name: "Second" }] } }, other: 1 });
}));
test("a provider saved while pi is replying waits to be applied; removing one also removes the key pi stored for it", async () => withHost(async (host, child, { root, auth }) => {
  let view = await host.hostQuery("providers");
  child.streaming = true;
  const saved = await host.hostCommand("provider_save", providerArgs({ revision: view.revision })) as { revision: string };
  await new Promise(resolve => setTimeout(resolve, 30));
  view = await host.hostQuery("providers"); assert.equal(view.pendingApply, true); assert.equal(child.calls.some(call => call.type === "switch_session"), false);
  assert.equal((await host.hostQuery("accounts")).pendingApply, true);
  child.streaming = false; await host.read("tree");
  // An extension declines the reload: the file stays changed, the session is as it was, and it can be applied later.
  child.cancelNext = true;
  await assert.rejects(host.hostCommand("account_apply", {}), { code: "apply_cancelled" });
  assert.equal((await host.hostQuery("providers")).pendingApply, true); assert.equal(child.running, true);
  assert.deepEqual(await host.hostCommand("account_apply", {}), { pendingApply: false });
  await signIn(host, "lease-1", "mine", "sk-mine"); await waitFor(async () => (await host.hostQuery("providers")).providers[0]?.available === 1, "available");
  // The session is using its model when it is removed.
  child.model = { provider: "mine", id: "mine-model", name: "mine" };
  view = await host.hostQuery("providers"); assert.deepEqual([view.providers[0]!.inUse, view.providers[0]!.key], [true, "stored"]); assert(view.providers[0]!.available >= 1);
  await assert.rejects(host.hostCommand("provider_remove", { id: "mine", revision: saved.revision.replace(/.$/, "0") }), { code: "stale_providers" });
  const removed = await host.hostCommand("provider_remove", { id: "mine", revision: view.revision }) as { credentialRemoved?: boolean };
  assert.equal(removed.credentialRemoved, true); assert.equal(auth.stored.has("mine"), false);
  assert.deepEqual(JSON.parse(await readFile(modelsFile(root), "utf8")), { providers: {} });
  await waitFor(async () => !(await host.hostQuery("providers")).pendingApply, "removal applied");
  child.model = { provider: "local", id: "fixture", name: "Fixture" }; // like pi: the reloaded session no longer has the removed provider's model
  assert.deepEqual((await host.hostQuery("providers")).providers, []); assert.equal((await host.hostQuery("accounts")).providers.some(provider => provider.id === "mine"), false);
  await assert.rejects(host.hostCommand("account_begin", { provider: "mine", method: "api_key" }, 0, "lease-1"), { code: "unknown_provider" });
}));
test("an entry named like one of pi's providers is shown as changing that provider and cannot be edited; a broken file blocks every change", async () => withHost(async (host, _child, { root }) => {
  await writeFile(modelsFile(root), JSON.stringify({ providers: { acme: { baseUrl: "https://gateway.example/v1", api: "openai-completions", apiKey: "!op read key", models: [{ id: "extra" }] } } }));
  let view = await host.hostQuery("providers");
  assert.deepEqual([view.providers[0]!.id, view.providers[0]!.overlay, view.providers[0]!.key], ["acme", true, "file_command"]); assert.equal(JSON.stringify(view).includes("op read"), false);
  await assert.rejects(host.hostCommand("provider_save", providerArgs({ id: "acme", create: false, revision: view.revision })), { code: "provider_overlay" });
  await assert.rejects(host.hostCommand("provider_remove", { id: "acme", revision: view.revision }), { code: "provider_overlay" });
  // It is still pi's own provider in the account list, not a custom one.
  assert.equal((await host.hostQuery("accounts")).providers.find(provider => provider.id === "acme")!.custom, undefined);
  await writeFile(modelsFile(root), "{ broken");
  view = await host.hostQuery("providers"); assert.deepEqual(view.providers, []); assert.match(view.error!, /not valid JSON/);
  await assert.rejects(host.hostCommand("provider_save", providerArgs({ revision: view.revision })), { code: "providers_unreadable" });
  assert.equal(await readFile(modelsFile(root), "utf8"), "{ broken");
  assert((await host.hostQuery("accounts")).providers.length >= 3, "accounts still list");
}));
test("deleting a saved session: only a listed one that is not open and not held by another service, to the trash when there is one", async () => withHost(async (host, child, fixture) => {
  const { root, foreign } = fixture, custom = join(root, "custom");
  const add = (text: string) => { const manager = SessionManager.create(join(root, "other"), custom); manager.appendMessage({ role: "user", content: text, timestamp: 9 });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "a" }], api: "fixture", provider: "local", model: "fixture", timestamp: 10, stopReason: "stop", usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as never); return manager; };
  const second = add("second"), third = add("third");
  await assert.rejects(host.hostCommand("session_delete", { sessionId: foreign.getSessionId() }), { code: "unknown_session" }); // not listed yet
  await assert.rejects(host.hostQuery("session_inspect", { sessionId: foreign.getSessionId() }), { code: "unknown_session" });
  await host.read("sessions", { scope: "all" });
  const inspected = await host.hostQuery("session_inspect", { sessionId: foreign.getSessionId() });
  assert.deepEqual(inspected, { id: foreign.getSessionId(), cwd: join(root, "other"), path: await realpath(foreign.getSessionFile()!), messageCount: 2, modified: inspected.modified, current: false, locked: false, trash: true });
  assert.equal((await host.hostQuery("session_inspect", { sessionId: child.manager.getSessionId() })).current, true);
  await assert.rejects(host.hostCommand("session_delete", { sessionId: child.manager.getSessionId() }), { code: "session_current" });
  await assert.rejects(host.hostCommand("session_delete", { sessionId: "../../etc/passwd" }), { code: "unknown_session" });
  // Held by another /web service on this machine.
  const other = await SessionFileLock.acquire(second.getSessionFile()!);
  assert.equal((await host.hostQuery("session_inspect", { sessionId: second.getSessionId() })).locked, true);
  await assert.rejects(host.hostCommand("session_delete", { sessionId: second.getSessionId() }), { code: "session_locked" });
  assert.equal(existsSync(second.getSessionFile()!), true); await other.release();
  // The file behind a listed ID was replaced by something else, or is reached through a link out of the session directory.
  const replaced = third.getSessionFile()!; const original = await readFile(replaced, "utf8");
  await writeFile(replaced, original.replace(third.getSessionId(), "another-session-id"));
  await assert.rejects(host.hostCommand("session_delete", { sessionId: third.getSessionId() }), { code: "session_refused" });
  await rm(replaced); const outside = join(root, "outside.jsonl"); await writeFile(outside, original); await symlink(outside, replaced);
  await assert.rejects(host.hostCommand("session_delete", { sessionId: third.getSessionId() }), { code: "session_refused" });
  assert.equal(existsSync(outside), true); assert.deepEqual(fixture.trashed, []);
  // Deleted: moved to the trash, forgotten by the listing and by the project that remembered it, and no lock file left next to it.
  const path = await realpath(foreign.getSessionFile()!);
  const registry = new ProjectRegistry(join(root, "agent")); const project = await registry.open(join(root, "other"));
  await registry.setLastSession(project.id, { id: foreign.getSessionId(), file: path }); assert.equal((await registry.list())[0]!.lastSession?.file, path);
  assert.deepEqual(await host.hostCommand("session_delete", { sessionId: foreign.getSessionId() }), { id: foreign.getSessionId(), method: "trash" });
  assert.deepEqual(fixture.trashed, [path]); assert.equal(existsSync(path), false);
  assert.equal((await registry.list())[0]!.lastSession, undefined, "the project no longer offers to resume the deleted session");
  assert.deepEqual((await readdir(custom)).filter(name => name.includes(".pi-pane.lock")).length, 1, "only the open session's own lock remains");
  assert.equal((await host.read("sessions", { scope: "all" })).sessions.some(session => session.id === foreign.getSessionId()), false);
  await assert.rejects(host.hostCommand("session_delete", { sessionId: foreign.getSessionId() }), { code: "unknown_session" });
  // No trash: removed permanently, and the result says so.
  fixture.trashWorks = false;
  assert.deepEqual(await host.hostCommand("session_delete", { sessionId: second.getSessionId() }), { id: second.getSessionId(), method: "deleted" });
  assert.equal(existsSync(second.getSessionFile()!), false);
  assert.equal(child.running, true); assert.equal((await host.read("tree")).entries.length > 0, true, "the open session is untouched");
}));
test("export is written by pi where the host says, can be read back in parts by its ID only, and old exports are pruned", async () => withHost(async (host, child, { root }) => {
  child.exportBody = "<html>" + "x".repeat(900 * 1024) + "</html>";
  const result = await host.hostCommand("session_export", {}) as { exportId: string; path: string; name: string; bytes: number; downloadable: boolean };
  const directory = join(await realpath(join(root, "agent")), "pi-pane", "exports");
  assert.equal(dirname(result.path), directory); assert.match(result.name, /^session-[A-Za-z0-9]+-\d{8}-\d{6}-[0-9a-f]{4}\.html$/); assert.equal(result.bytes, child.exportBody.length); assert.equal(result.downloadable, true);
  assert.deepEqual(child.calls.find(call => call.type === "export_html")?.payload, { outputPath: result.path });
  let offset: number | undefined = 0; const parts: Buffer[] = [];
  while (offset !== undefined) { const page: ExportPage = await host.hostQuery("export_page", { exportId: result.exportId, offset }); assert.equal(page.total, result.bytes); parts.push(Buffer.from(page.data, "base64")); offset = page.next; }
  assert.equal(parts.length, 3); assert.equal(Buffer.concat(parts).toString("utf8"), child.exportBody);
  await assert.rejects(host.hostQuery("export_page", { exportId: "not-an-export", offset: 0 }), { code: "export_missing" });
  await assert.rejects(host.hostQuery("export_page", { exportId: result.exportId, offset: result.bytes + 1 }), { code: "export_missing" });
  // pi writing somewhere else than asked is an error, not a path to hand to the browser.
  child.exportTo = join(root, "project", "leaked.html");
  await assert.rejects(host.hostCommand("session_export", {}), { code: "export_failed" }); child.exportTo = undefined;
  await writeFile(result.path, "changed"); await assert.rejects(host.hostQuery("export_page", { exportId: result.exportId, offset: 0 }), { code: "export_missing" });
  child.exportBody = "<html>small</html>";
  for (let index = 0; index < 22; index++) await host.hostCommand("session_export", {});
  assert.equal((await readdir(directory)).length, 20);
}));
test("session numbers and reply text come from pi; /session, /export and /copy open their pages instead of reaching the model", async () => withHost(async (host, child) => {
  const stats = await host.read("session_stats");
  assert.deepEqual(stats, { sessionId: child.manager.getSessionId(), sessionFile: child.manager.getSessionFile(), cwd: host.cwd, userMessages: 2, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 3,
    tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30 }, cost: 0.0125, context: { tokens: 1200, window: 16000, percent: 7.5 } });
  child.context = { tokens: null, contextWindow: 16000, percent: null }; assert.deepEqual((await host.read("session_stats")).context, { tokens: null, window: 16000, percent: null });
  child.context = undefined; assert.equal((await host.read("session_stats")).context, undefined);
  assert.deepEqual(await host.read("assistant_text"), { text: "first answer", truncated: false });
  child.lastText = undefined; assert.deepEqual(await host.read("assistant_text"), { text: "", truncated: false });
  const tree = await host.read("tree"); const assistant = tree.entries.find(entry => entry.role === "assistant")!, user = tree.entries.find(entry => entry.role === "user")!;
  assert.deepEqual(await host.read("assistant_text", { entryId: assistant.id }), { text: "first answer", truncated: false });
  await assert.rejects(host.read("assistant_text", { entryId: user.id }), { code: "unknown_message" });
  await assert.rejects(host.read("assistant_text", { entryId: "nope" }), { code: "unknown_message" });
  const commands = (await host.read("commands")).commands;
  assert.deepEqual(["session", "export", "copy"].map(name => { const command = commands.find(item => item.name === name)!; return [command.available, command.browserAction]; }), [[true, "status"], [true, "export"], [true, "copy"]]);
  for (const text of ["/session", "/export", "/export out.html", "/copy"]) await assert.rejects(host.command("prompt", { text }), { code: "picker_required" });
  assert(!child.calls.some(call => call.type === "prompt"));
}));
