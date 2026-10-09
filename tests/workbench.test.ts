import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Bridge, type BridgeOptions } from "../src/extension/bridge.js";
import { createSessionCommandGateway, rememberSessionDirectory, type ProcessState } from "../src/extension/index.js";
import { commandArgs, parseClientMessage, type CommandResult } from "../src/protocol/index.js";

test("workbench query and mutation schemas reject unknown fields, paths and commands", () => {
  const query = { t: "workbench_query", reqId: "read-1", epoch: "epoch", sessionId: "session", branchRevision: 0, action: "sessions", args: { scope: "workspace", query: "test" } };
  assert.deepEqual(parseClientMessage(query), query);
  assert.throws(() => parseClientMessage({ ...query, args: { directory: "/anywhere" } }), /search query/);
  assert.throws(() => parseClientMessage({ ...query, action: "file", args: { path: "x", extra: true } }), /file path/);
  assert.throws(() => parseClientMessage({ ...query, branchRevision: -1 }), /envelope/);
  assert.throws(() => commandArgs("session_switch", { sessionId: "ok", path: "/arbitrary.jsonl" }), /session ID/);
  assert.throws(() => commandArgs("run_command", { name: "foo bar" }), /registered command/);
  assert.deepEqual(commandArgs("run_command", { name: "说明" }), { name: "说明" });
  assert.throws(() => commandArgs("session_fork", { entryId: "entry", position: "after" }), /before or at/);
  assert.deepEqual(commandArgs("session_fork", { entryId: "entry", position: "at" }), { entryId: "entry", position: "at" });
});

function gatewayFixture() {
  let handler: ((text: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  const sent: string[] = [];
  const bridge = { isCurrent: () => true, generation: 1, sessionId: "first", branchRevision: 0 } as Bridge;
  let current: Bridge | undefined = bridge;
  const pi = {
    registerCommand: (_name: string, options: { handler: typeof handler }) => { handler = options.handler; },
    sendUserMessage: (text: string, options: unknown) => {
      assert.deepEqual(options, { expandPromptTemplates: true, deliverAs: "followUp" }); sent.push(text);
    },
  } as unknown as Pick<ExtensionAPI, "registerCommand" | "sendUserMessage">;
  const gateway = createSessionCommandGateway(pi, () => current);
  const outcomes: Pick<CommandResult, "status" | "value" | "error">[] = [];
  const expected = { sessionId: "first", generation: 1, branchRevision: 0 };
  const actions: string[] = [];
  const context = (id = "first"): ExtensionCommandContext => ({
    sessionManager: { getSessionId: () => id }, isIdle: () => true, hasPendingMessages: () => false,
    newSession: async () => { actions.push(`new:${id}`); return { cancelled: false }; },
    switchSession: async (path: string) => { actions.push(`switch:${path}`); return { cancelled: false }; },
    fork: async (entryId: string) => { actions.push(`fork:${entryId}`); return { cancelled: false }; },
    navigateTree: async (entryId: string) => { actions.push(`tree:${entryId}`); return { cancelled: false }; },
  }) as unknown as ExtensionCommandContext;
  const consume = (ctx = context(), text = sent.at(-1)!) => handler!(text.split(" ").at(-1)!, ctx);
  return { gateway, outcomes, sent, expected, actions, context, consume, setCurrent: (next?: Bridge) => { current = next; } };
}

test("gateway creates command context per invocation and consumes each nonce only once", async () => {
  const f = gatewayFixture();
  f.gateway.invoke("session_new", {}, f.expected, (result) => f.outcomes.push(result));
  const original = f.sent.at(-1)!;
  await f.consume();
  await f.consume(f.context(), original);
  assert.deepEqual(f.actions, ["new:first"]);
  assert.deepEqual(f.outcomes, [{ status: "completed", value: { cancelled: false, sessionId: "first", branchRevision: 0 } }]);
  f.gateway.invoke("session_tree", { entryId: "branch" }, f.expected, (result) => f.outcomes.push(result));
  await f.consume(f.context("wrong-session"));
  assert.deepEqual(f.actions, ["new:first"], "a new context must be verified, not a cached context reused");
  assert.equal(f.outcomes.at(-1)!.error?.code, "stale_session");
});

test("gateway discards pending nonces on lifecycle replacement without running them", async () => {
  const f = gatewayFixture();
  f.gateway.invoke("session_new", {}, f.expected, (result) => f.outcomes.push(result));
  f.gateway.cancelPending();
  f.setCurrent(undefined);
  await f.consume();
  assert.deepEqual(f.actions, []);
  assert.equal(f.outcomes[0]!.error?.code, "stale_session");
});

test("gateway reports observed cancellation and successful replacement without touching old context", async () => {
  const f = gatewayFixture();
  const replacement = f.context();
  replacement.newSession = async () => { f.setCurrent(undefined); return { cancelled: false }; };
  f.gateway.invoke("session_new", {}, f.expected, (result) => f.outcomes.push(result));
  await f.consume(replacement);
  assert.deepEqual(f.outcomes, [{ status: "completed", value: { cancelled: false } }]);
  const cancelled = gatewayFixture();
  const cancelContext = cancelled.context();
  cancelContext.newSession = async () => ({ cancelled: true });
  cancelled.gateway.invoke("session_new", {}, cancelled.expected, (result) => cancelled.outcomes.push(result));
  await cancelled.consume(cancelContext);
  assert.deepEqual(cancelled.outcomes, [{ status: "completed", value: { cancelled: true } }]);
});

test("tree navigation returns bounded editable user text and omits images", async () => {
  const f = gatewayFixture();
  const ctx = f.context();
  Object.assign(ctx.sessionManager, { getEntry: () => ({ type: "message", message: { role: "user", content: [{ type: "text", text: "你好".repeat(20_000) }, { type: "image", data: "private-image" }] } }) });
  f.gateway.invoke("session_tree", { entryId: "branch" }, f.expected, (result) => f.outcomes.push(result));
  await f.consume(ctx);
  const value = f.outcomes[0]!.value as { cancelled: boolean; draftText: string };
  assert.equal(value.cancelled, false);
  assert.ok(new TextEncoder().encode(value.draftText).length <= 64 * 1024);
  assert.equal(value.draftText.includes("\ufffd"), false);
  assert.equal(value.draftText.includes("private-image"), false);
});

async function bridgeFixture(extraCommands: { name: string; source: "extension" | "skill" | "prompt" }[] = []) {
  const dir = await mkdtemp(join(tmpdir(), "pi-pane-workbench-"));
  const manager = SessionManager.create(dir, join(dir, "sessions"));
  const entryId = manager.appendMessage({ role: "user", content: "A searchable task", timestamp: Date.now() });
  const ctx = {
    cwd: dir, sessionManager: manager, isIdle: () => true, hasPendingMessages: () => false,
    modelRegistry: { getAvailable: () => [] }, ui: { theme: { appearance: "dark", colors: {} } },
    abort: () => {}, compact: () => {},
  } as unknown as ExtensionContext;
  const sent: { text: unknown; options: unknown }[] = [];
  const pi: BridgeOptions["pi"] = {
    sendUserMessage: (text, options) => { sent.push({ text, options }); }, getThinkingLevel: () => "off", setThinkingLevel: () => {}, setModel: async () => true,
    getCommands: () => [
      { name: "fixture", description: "Run an extension", source: "extension", sourceInfo: {} },
      { name: "skill:fixture", description: "Use a skill", source: "skill", sourceInfo: {} },
      { name: "template", description: "Use a template", source: "prompt", sourceInfo: {} },
      { name: "private", source: "extension", sourceInfo: {} },
      ...extraCommands.map((command) => ({ ...command, sourceInfo: {} })),
    ] as ReturnType<ExtensionAPI["getCommands"]>,
    getAllTools: () => [{ name: "read", description: "Read a workspace file", parameters: {} }] as ReturnType<ExtensionAPI["getAllTools"]>,
    getActiveTools: () => ["read"],
  };
  let current = true;
  const gatewayCalls: unknown[] = [];
  const options: BridgeOptions = { pi, ctx, generation: 1, pollMs: 60_000, internalCommand: "private", isCurrent: () => current,
    sessionCommand: (...args) => { gatewayCalls.push(args.slice(0, 3)); args[3]({ status: "completed", value: { cancelled: false } }); } };
  const bridge = new Bridge(options);
  return { bridge, options, pi, ctx, dir, entryId, sent, gatewayCalls, stale: () => { current = false; }, close: async () => { bridge.dispose(); await rm(dir, { recursive: true, force: true }); } };
}

test("synchronous host failures release control locks so a valid action can follow", async () => {
  const f = await bridgeFixture();
  try {
    const sessionCommand = f.options.sessionCommand;
    f.options.sessionCommand = () => { throw new Error("gateway dispatch failed"); };
    assert.throws(() => f.bridge.dispatch("session_new", {}, () => {}), /gateway dispatch failed/);
    f.options.sessionCommand = sessionCommand;
    f.bridge.dispatch("session_new", {}, () => {});
    assert.equal(f.gatewayCalls.length, 1);

    Object.assign(f.ctx.modelRegistry, { find: () => ({ provider: "fixture", id: "model", name: "Fixture" }) });
    f.pi.setModel = () => { throw new Error("model dispatch failed"); };
    assert.throws(() => f.bridge.dispatch("set_model", { provider: "fixture", id: "model" }, () => {}), /model dispatch failed/);
    const outcomes: unknown[] = [];
    f.bridge.dispatch("set_thinking", { level: "off" }, (result) => outcomes.push(result));

    Object.assign(f.ctx, { compact: () => { throw new Error("compact dispatch failed"); } });
    assert.throws(() => f.bridge.dispatch("compact", {}, () => {}), /compact dispatch failed/);
    assert.equal(f.bridge.snapshot().state.compacting, false);
    f.bridge.dispatch("set_thinking", { level: "off" }, (result) => outcomes.push(result));
    assert.equal(outcomes.length, 2, "host rejection must not leave subsequent controls permanently busy");
  } finally { await f.close(); }
});

test("a pending session action blocks prompts and every other write until its outcome", async () => {
  const f = await bridgeFixture();
  try {
    let finish: Parameters<NonNullable<BridgeOptions["sessionCommand"]>>[3] | undefined;
    f.options.sessionCommand = (_command, _args, _expected, complete) => { finish = complete; };
    f.bridge.dispatch("session_new", {}, () => {});
    assert.equal(f.bridge.snapshot().state.mutating, true);
    for (const [command, args] of [
      ["prompt", { text: "must not enter the outgoing runtime" }],
      ["run_command", { name: "fixture" }], ["set_thinking", { level: "off" }], ["abort", {}],
    ] as const) assert.throws(() => f.bridge.dispatch(command, args, () => {}), { code: "busy" });
    assert.equal(f.sent.length, 0);
    finish!({ status: "completed", value: { cancelled: false } });
    assert.equal(f.bridge.snapshot().state.mutating, false);
    f.bridge.dispatch("prompt", { text: "safe after the session outcome" }, () => {});
    assert.equal(f.sent.length, 1);
  } finally { await f.close(); }
});

test("the process session fence survives Bridge replacement and immediately clears on the fresh Bridge", async () => {
  const gateway = gatewayFixture();
  const f = await bridgeFixture();
  const fresh = new Bridge({ ...f.options, generation: 2, isSessionMutationPending: gateway.gateway.isPending });
  try {
    let release: (() => void) | undefined;
    const context = gateway.context();
    context.newSession = async () => {
      gateway.setCurrent(fresh);
      await new Promise<void>((resolve) => { release = resolve; });
      return { cancelled: false };
    };
    gateway.gateway.invoke("session_new", {}, gateway.expected, (result) => gateway.outcomes.push(result));
    const replacing = gateway.consume(context);
    assert.equal(fresh.snapshot().state.mutating, true);
    assert.throws(() => fresh.dispatch("prompt", { text: "must wait for rebind" }, () => {}), { code: "busy" });
    const states: boolean[] = [];
    fresh.setObserver({ publish: (event) => { if (event.type === "agent_state") states.push(!!event.state.mutating); }, reset: () => {}, switching: () => {} });
    fresh.refreshState();
    assert.equal(states.at(-1), true);
    gateway.gateway.cancelPending();
    assert.equal(gateway.gateway.isPending(), true, "a consumed action stays fenced until its actual asynchronous completion");
    release!();
    await replacing;
    assert.equal(gateway.gateway.isPending(), false);
    assert.equal(states.at(-1), false, "completion must update the fresh Bridge without waiting for its poll timer");
    fresh.dispatch("prompt", { text: "safe in the replacement" }, () => {});
    assert.equal(f.sent.length, 1);
  } finally { fresh.dispose(); await f.close(); }
});

test("workbench catalog, tree and resources project bounded host metadata", async () => {
  const f = await bridgeFixture();
  try {
    assert.equal(f.bridge.snapshot().caps.workbench, true);
    const sessions = await f.bridge.workbenchQuery("sessions", { query: "searchable" }, 0);
    assert.equal(sessions.sessions.length, 1);
    assert.equal(sessions.sessions[0]!.current, true);
    assert.equal("path" in sessions.sessions[0]!, false);
    const commands = await f.bridge.workbenchQuery("commands", {}, 0);
    assert.ok(commands.commands.find((entry) => entry.name === "fixture" && entry.available));
    assert.equal(commands.commands.some((entry) => entry.name === "private"), false);
    assert.equal(commands.commands.find((entry) => entry.name === "login")!.terminalOnly, true);
    const tree = await f.bridge.workbenchQuery("tree", {}, 0);
    assert.deepEqual(tree.entries.map((entry) => entry.id), [f.entryId]);
    assert.equal(tree.entries[0]!.role, "user");
    const resources = await f.bridge.workbenchQuery("resources", {}, 0);
    assert.deepEqual(resources.tools.map((tool) => ({ name: tool.name, active: tool.active })), [{ name: "read", active: true }]);
    assert.equal(resources.capabilities.find((capability) => capability.name === "dialogs")!.available, false);
  } finally { await f.close(); }
});

test("tree previews show message bodies and omit empty internal system updates", async () => {
  const f = await bridgeFixture();
  try {
    const manager = f.ctx.sessionManager as SessionManager;
    const internal = manager.appendMessage({ role: "system", content: "", sections: { preamble: "PRIVATE_PREAMBLE_UPDATE", tools: "PRIVATE_TOOL_UPDATE" }, timestamp: Date.now() });
    const whitespace = manager.appendMessage({ role: "system", content: [{ type: "text", text: "  " }], sections: { tools: "PRIVATE_TOOL_UPDATE" }, timestamp: Date.now() });
    const visible = manager.appendMessage({ role: "system", content: "Visible system instruction", timestamp: Date.now() });
    const array = manager.appendMessage({ role: "system", content: [{ type: "text", text: "Visible array instruction" }], timestamp: Date.now() });
    const tree = await f.bridge.workbenchQuery("tree", {}, 0);
    assert.equal(tree.entries.some((entry) => entry.id === internal || entry.id === whitespace), false);
    assert.equal(tree.entries.find((entry) => entry.id === visible)?.preview, "Visible system instruction");
    assert.equal(tree.entries.find((entry) => entry.id === array)?.preview, "Visible array instruction");
    assert.equal(tree.entries.find((entry) => entry.id === f.entryId)?.preview, "A searchable task",
      "string-valued user content must not fall back to serializing its entire message record");
    assert.equal(JSON.stringify(tree).includes("PRIVATE_"), false);
  } finally { await f.close(); }
});

test("all-session catalog retains a custom root across workspace resume without duplicate entries", async () => {
  const f = await bridgeFixture();
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  let foreignBridge: Bridge | undefined;
  try {
    // Match --session-dir at the default sessions root: listAll() only scans its children.
    process.env.PI_CODING_AGENT_DIR = f.dir;
    const originalManager = f.ctx.sessionManager;
    const foreignCwd = join(f.dir, "foreign-workspace");
    await mkdir(foreignCwd);
    const foreign = SessionManager.create(foreignCwd, join(f.dir, "sessions", "foreign-workspace"));
    foreign.appendMessage({ role: "user", content: "Foreign workspace history", timestamp: Date.now() });
    assert.equal((await SessionManager.listAll()).some((session) => session.id === originalManager.getSessionId()), false,
      "the host default catalog intentionally does not inspect root-level custom transcripts");

    const remembered = [originalManager.getSessionDir()];
    const resumed = SessionManager.open(foreign.getSessionFile()!);
    assert.notEqual(resumed.getSessionDir(), originalManager.getSessionDir(), "resume derives its directory from the target transcript");
    foreignBridge = new Bridge({ ...f.options, ctx: { ...f.ctx, cwd: foreignCwd, sessionManager: resumed }, sessionDirectories: remembered });
    const catalog = await foreignBridge.workbenchQuery("sessions", { scope: "all" }, 0);
    assert.ok(catalog.sessions.some((session) => session.id === originalManager.getSessionId()));
    assert.ok(catalog.sessions.some((session) => session.id === foreign.getSessionId() && session.current));
    assert.equal(catalog.sessions.filter((session) => session.id === foreign.getSessionId()).length, 1,
      "the default and explicit current-directory catalogs must not duplicate a session");
    foreignBridge.dispatch("session_switch", { sessionId: originalManager.getSessionId() }, () => {});
    assert.equal((f.gatewayCalls[0] as [string, { sessionPath: string }])[1].sessionPath, originalManager.getSessionFile());
  } finally {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    foreignBridge?.dispose(); await f.close();
  }
});

test("remembered host session roots are bounded and revisit refreshes their recency", () => {
  const state: ProcessState = { implementationVersion: "test", autoStartApplied: false, desiredRunning: false, generation: 0 };
  for (let index = 0; index < 34; index++) rememberSessionDirectory(state, `/session-root-${index}`);
  assert.equal(state.sessionDirectories!.length, 32);
  assert.equal(state.sessionDirectories!.includes("/session-root-0"), false);
  rememberSessionDirectory(state, "/session-root-2");
  assert.equal(state.sessionDirectories!.length, 32);
  assert.equal(state.sessionDirectories!.at(-1), "/session-root-2");
  assert.equal(new Set(state.sessionDirectories).size, 32);
});

test("run_command expands registered resources while prompt stays literal and dispatch-only", async () => {
  const f = await bridgeFixture();
  try {
    const outcomes: unknown[] = [];
    f.bridge.dispatch("run_command", { name: "skill:fixture", args: "sample" }, (result) => outcomes.push(result));
    f.bridge.dispatch("prompt", { text: "/fixture literal" }, (result) => outcomes.push(result));
    assert.deepEqual(f.sent, [
      { text: "/skill:fixture sample", options: { deliverAs: "followUp", expandPromptTemplates: true } },
      { text: "/fixture literal", options: { deliverAs: "followUp", expandPromptTemplates: false } },
    ]);
    assert.deepEqual(outcomes, []);
    assert.throws(() => f.bridge.dispatch("run_command", { name: "unregistered" }, () => {}), /not registered/);
    assert.throws(() => f.bridge.dispatch("run_command", { name: "login" }, () => {}), { code: "terminal_required" });
    assert.throws(() => f.bridge.dispatch("session_switch", { sessionId: "arbitrary" }, () => {}), /catalog/);
  } finally { await f.close(); }
});

test("session mutations resolve only catalog IDs and existing tree entries", async () => {
  const f = await bridgeFixture();
  try {
    f.bridge.dispatch("session_fork", { entryId: f.entryId, position: "at" }, () => {});
    assert.equal(f.gatewayCalls.length, 1);
    assert.throws(() => f.bridge.dispatch("session_tree", { entryId: "unknown" }, () => {}), /current session/);
    await assert.rejects(f.bridge.workbenchQuery("tree", {}, 1), /snapshot/);
    f.stale();
    await assert.rejects(f.bridge.workbenchQuery("tree", {}, 0), /replaced/);
  } finally { await f.close(); }
});

test("builtin collisions remain reserved and registered invocation precedence is explicit", async () => {
  const f = await bridgeFixture([{ name: "new", source: "prompt" }, { name: "settings", source: "extension" }, { name: "fixture", source: "prompt" }, { name: "说明", source: "extension" }]);
  try {
    const { commands } = await f.bridge.workbenchQuery("commands", {}, 0);
    assert.ok(commands.find((command) => command.name === "new" && command.source === "builtin" && command.available));
    const hiddenTemplate = commands.find((command) => command.name === "new" && command.source === "prompt")!;
    assert.equal(hiddenTemplate.available, false); assert.ok(hiddenTemplate.reason);
    assert.equal(commands.find((command) => command.name === "fixture" && command.source === "prompt")!.available, false);
    f.bridge.dispatch("run_command", { name: "new" }, () => {});
    assert.equal(f.gatewayCalls.length, 1);
    assert.equal(f.sent.length, 0, "a colliding prompt must not replace the builtin session action");
    assert.throws(() => f.bridge.dispatch("run_command", { name: "settings" }, () => {}), /picker/);
    assert.equal(f.sent.length, 0, "a reserved builtin must not silently invoke an extension");
    f.bridge.dispatch("run_command", { name: "fixture" }, () => {});
    assert.equal(f.sent.length, 1);
    f.bridge.dispatch("run_command", { name: "说明" }, () => {});
    assert.equal(f.sent.at(-1)!.text, "/说明");
  } finally { await f.close(); }
});
