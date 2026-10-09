import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { open } from "node:fs/promises";
import { dirname } from "node:path";
import { ProtocolError, isRecord, isCommandInvocationName, workbenchArgs, type WorkbenchAction, type WorkbenchValues, type WorkbenchCommand, type SessionCatalogItem } from "../protocol/index.js";
import { Bridge } from "./bridge.js";
import type { Hub, HostHandler } from "./hub.js";
import { childArgs } from "./child-args.js";
import { RpcChild, type RpcConnection, type RpcRecord } from "./rpc-child.js";
import { RpcSessionMirror } from "./rpc-session.js";
import { SessionFileLock } from "./session-lock.js";
import { WorkspaceService } from "./workspace.js";
export { childArgs } from "./child-args.js";
export { SessionFileLock } from "./session-lock.js";

export interface HandoffTarget {
  sessionFile: string; sessionDir?: string; cwd: string; argv: string[];
  theme: ExtensionContext["ui"]["theme"]; themes: ReturnType<ExtensionContext["ui"]["getAllThemes"]>;
  /** Transferred in-process only after the foreground TUI has shut down. */
  lock?: SessionFileLock;
}
export interface HostUiState {
  revision: number; statuses: Record<string, string>; widgets: Record<string, { content: string[]; placement?: string }>;
  title?: string; editorText?: string; editorRevision?: number;
}
interface Expected { sessionId: string; branchRevision: number; generation: number }
interface Dialog { t: "ui_request"; id: string; method: "select" | "confirm" | "input" | "editor"; title?: string; message?: string; options?: string[]; placeholder?: string; prefill?: string; expiresAt?: number }
interface HandoffDependencies {
  createChild?: (args: string[], cwd: string) => RpcConnection;
  listAll?: typeof SessionManager.listAll;
  list?: typeof SessionManager.list;
}
const BUILTINS: WorkbenchCommand[] = [
  ["new", "新建会话", "new"], ["resume", "查找并恢复会话", "sessions"], ["fork", "从用户消息之前分叉", "tree"],
  ["model", "选择模型", "model"], ["thinking", "调整思考强度", "thinking"], ["compact", "压缩会话", "compact"],
  ["settings", "查看资源", "resources"], ["session", "会话信息", "status"], ["name", "重命名会话", "rename"], ["clone", "克隆当前分支", "clone"],
].map(([name, description, action]) => ({ name: name!, description: description!, source: "builtin", available: true, browserAction: action as WorkbenchCommand["browserAction"] }));
BUILTINS.push({ name: "tree", description: "切换历史分支", source: "builtin", available: false, reason: "需要 pi 上游提供 RPC tree 导航；当前只能从用户消息分叉。", browserAction: "tree" });
for (const name of ["web", "scoped-models", "export", "import", "share", "bug", "copy", "changelog", "hotkeys", "trust", "login", "logout", "reload", "quit", "debug", "arminsayshi", "dementedelves"])
  BUILTINS.push({ name, description: "pi 内置终端命令", source: "builtin", available: false, terminalOnly: true, reason: "交接模式不支持此终端命令；Ctrl+C 后在终端执行。" });
const BUILTIN_NAMES = new Set(BUILTINS.map(command => command.name));
const SESSION_WRITES = new Set(["session_new", "session_switch", "session_fork", "session_clone"]);
const clip = (value: string, bytes: number): string => Buffer.byteLength(value) <= bytes ? value : new TextDecoder().decode(Buffer.from(value).subarray(0, bytes), { stream: true });
const visibleText = (value: unknown): string => typeof value === "string" ? value : Array.isArray(value)
  ? value.filter(isRecord).map(block => typeof block.text === "string" ? block.text : typeof block.thinking === "string" ? block.thinking : "").join("\n") : "";
/** RPC get_state has no cwd: read the public transcript header without migrating/writing it. */
async function sessionCwd(path: string | undefined, fallback: string): Promise<string> {
  if (!path) return fallback;
  let file;
  try {
    file = await open(path, "r"); const bytes = Buffer.alloc(64 * 1024); const result = await file.read(bytes, 0, bytes.length, 0);
    const header: unknown = JSON.parse(bytes.subarray(0, result.bytesRead).toString("utf8").split("\n", 1)[0]!);
    return isRecord(header) && header.type === "session" && typeof header.cwd === "string" ? header.cwd : fallback;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
  finally { await file?.close(); }
}

/** Foreground host. One RPC child owns writes; failure never triggers an automatic restart. */
export class HandoffHost implements HostHandler {
  private child?: RpcConnection;
  private mirror?: RpcSessionMirror;
  private bridge?: Bridge;
  private workspace?: WorkspaceService;
  private generation = 0;
  private paths = new Map<string, string>();
  private directories: string[] = [];
  private dialogs = new Map<string, Dialog>();
  private dialogTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private dialogOwners = new Map<string, number>();
  private dialogOptionValues = new Map<string, Map<string, string>>();
  private ui: HostUiState = { revision: 0, statuses: {}, widgets: {} };
  private writes: Promise<unknown> = Promise.resolve();
  private queuedWrites = 0;
  private control?: Promise<unknown>;
  private operation = 0;
  private activeOperation?: number;
  private sessionChangePending = false;
  private stopping = false;
  private stopPromise?: Promise<void>;
  private lock?: SessionFileLock;
  private ownedWrite = false;
  private unsubscribe?: () => void;
  private activeCwd: string;
  private lastSessionFile: string;
  constructor(private readonly hub: Hub, private readonly target: HandoffTarget, private readonly log: (line: string) => void,
    private readonly dependencies: HandoffDependencies = {}) {
    this.activeCwd = target.cwd; this.lastSessionFile = target.sessionFile;
    this.rememberDirectory(target.sessionDir ?? dirname(target.sessionFile));
  }
  get sessionFile(): string { return this.lastSessionFile; }
  get cwd(): string { return this.activeCwd; }
  get childExited(): Promise<number | null> | undefined { return this.child?.exited; }
  get childPid(): number | undefined { return this.child?.pid; }
  get diagnostics(): string { return this.child?.diagnostics ?? ""; }
  async start(): Promise<void> {
    if (this.stopping) throw new Error("The handoff host is stopping.");
    const args = childArgs(this.target.argv, this.target.sessionFile);
    this.lock = this.target.lock ?? await SessionFileLock.acquire(this.target.sessionFile);
    try {
      if (this.stopping) { await this.lock.release(); throw new Error("The handoff host stopped before child startup."); }
      await this.lock.assertUnchanged();
      if (this.stopping) throw new Error("The handoff host stopped before child startup.");
      this.child = this.dependencies.createChild?.(args, this.target.cwd) ?? new RpcChild(args, this.target.cwd);
      this.unsubscribe = this.child.onRecord(record => {
        if (record.type === "extension_ui_request") this.dialog(record);
        if (["message_end", "compaction_end", "session_info_changed", "model_select", "thinking_level_changed"].includes(record.type)) this.ownedWrite = true;
        // pi RPC does not emit a separate dialog-cancel event for AbortSignal. Once the
        // agent has settled, orphaned model/tool dialogs cannot still be awaiting a result.
        if (record.type === "agent_settled") for (const id of this.dialogs.keys()) if (!this.dialogOwners.has(id)) this.resolveDialog(id, "cancelled", true);
      });
      this.child.start();
      if (this.child.pid) await this.lock.setWriterPid(this.child.pid);
      if (this.stopping) throw new Error("The handoff host stopped before activating its child.");
      this.child.activate?.();
      this.hub.setHostHandler(this);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([this.rebind("handoff"), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("RPC handoff startup timed out.")), 10_000); timer.unref?.(); })]); }
      finally { if (timer) clearTimeout(timer); }
    }
    catch (error) { await this.stop(); throw error; }
  }
  private rememberDirectory(path: string): void { this.directories = [...this.directories.filter(value => value !== path), path].slice(-32); }
  private async acceptOwnedChanges(): Promise<void> {
    if (!this.ownedWrite || this.stopping) return;
    this.ownedWrite = false;
    try { await this.lock?.acceptChanges(); }
    catch (error) { this.log("Session ownership disappeared; stopping the sole RPC writer."); await this.stop(); throw error; }
  }
  private async rebind(reason: string): Promise<void> {
    this.mirror?.dispose(); this.bridge?.dispose();
    const generation = ++this.generation;
    const state = await this.child!.request<{ sessionFile?: string }>("get_state", {}, 10_000);
    this.lastSessionFile = state.sessionFile ?? this.lastSessionFile;
    this.activeCwd = await sessionCwd(state.sessionFile, this.activeCwd);
    if (state.sessionFile) this.rememberDirectory(dirname(state.sessionFile));
    const mirror = new RpcSessionMirror(this.child!, this.activeCwd, this.target.theme, () => this.target.themes, () => {}, () => this.acceptOwnedChanges());
    try { await mirror.load(); } catch (error) { mirror.dispose(); throw error; }
    if (this.stopping) { mirror.dispose(); throw new Error("The handoff host stopped during startup."); }
    const bridge = new Bridge({ pi: mirror.api(), ctx: mirror.context(), generation, isCurrent: () => this.generation === generation && !this.stopping });
    mirror.attach(bridge); this.mirror = mirror; this.bridge = bridge; this.workspace = new WorkspaceService(this.activeCwd);
    // The launched runtime legitimately persists initial model/system/session updates.
    // Establish its acknowledged startup baseline before exposing the first snapshot.
    if (reason === "handoff") await this.lock!.acceptChanges();
    this.hub.bindBridge(bridge, reason);
    if (reason !== "handoff") this.log(`Current workspace: ${this.activeCwd}\nSession: ${this.lastSessionFile}`);
  }
  private assertLive(expected?: Expected): void {
    if (this.stopping || !this.child?.running || !this.mirror || !this.bridge) throw new ProtocolError("host_stopped", "The RPC child has stopped. Resume the last session from the terminal.");
    if (expected && (expected.generation !== this.generation || expected.sessionId !== this.mirror.sessionId || expected.branchRevision !== this.bridge.branchRevision))
      throw new ProtocolError("stale_session", "The session changed while this command was waiting; refresh before submitting again.");
  }
  async read<A extends WorkbenchAction>(action: A, input: Record<string, unknown> = {}, revision?: number): Promise<WorkbenchValues[A]> {
    this.assertLive(); const generation = this.generation;
    if (this.sessionChangePending) throw new ProtocolError("busy", "A native session change is in progress; retry after its result.");
    if (revision !== undefined && revision !== this.bridge!.branchRevision) throw new ProtocolError("stale_session", "Refresh before reading the workbench.");
    const args = workbenchArgs(action, input); let value: WorkbenchValues[WorkbenchAction];
    if (action === "sessions") {
      const signal = AbortSignal.timeout(8000);
      const listAll = this.dependencies.listAll ?? SessionManager.listAll;
      const list = this.dependencies.list ?? SessionManager.list;
      const catalogs = args.scope === "all" ? await Promise.all([listAll(undefined, signal), ...this.directories.map(directory => listAll(directory, undefined, signal))])
        : [await list(this.cwd, dirname(this.sessionFile), undefined, signal)];
      const unique = new Map<string, (typeof catalogs)[number][number]>();
      for (const session of catalogs.flat()) { const old = unique.get(session.id); if (!old || old.modified.getTime() < session.modified.getTime()) unique.set(session.id, session); }
      const query = typeof args.query === "string" ? args.query.trim().toLocaleLowerCase() : "";
      const filtered = [...unique.values()].filter(session => !query || [session.name, session.cwd, session.firstMessage, session.allMessagesText].some(text => text?.toLocaleLowerCase().includes(query)))
        .sort((a, b) => b.modified.getTime() - a.modified.getTime());
      const retained = filtered.slice(0, 200); for (const session of retained) this.paths.set(session.id, session.path);
      while (this.paths.size > 1000) this.paths.delete(this.paths.keys().next().value!);
      const sessions: SessionCatalogItem[] = retained.map(session => ({ id: session.id, cwd: session.cwd, ...(session.name ? { name: clip(session.name, 256) } : {}),
        created: session.created.toISOString(), modified: session.modified.toISOString(), messageCount: session.messageCount, firstMessage: clip(session.firstMessage, 256), current: session.id === this.mirror!.sessionId }));
      let truncated = filtered.length > retained.length;
      if (!query && !sessions.some(session => session.current)) {
        if (sessions.length >= 200) { sessions.pop(); truncated = true; }
        sessions.unshift({ id: this.mirror!.sessionId, cwd: this.cwd, name: this.mirror!.sessionName,
          created: "", modified: "", messageCount: this.mirror!.getEntries().filter(entry => entry.type === "message").length, firstMessage: "", current: true });
      }
      this.paths.set(this.mirror!.sessionId, this.sessionFile); value = { sessions, truncated };
    } else if (action === "commands") value = { commands: await this.commands() };
    else if (action === "resources") {
      const [commands, models, thinking] = await Promise.all([this.commands(), this.child!.request<{ models: Array<{ provider: string; id: string; name?: string }> }>("get_available_models"), this.child!.request<{ levels: string[] }>("get_available_thinking_levels")]);
      value = { tools: [], commands, models: models.models.slice(0, 256).map(model => ({ provider: model.provider, id: model.id, name: model.name ?? model.id })), thinkingLevels: thinking.levels,
        capabilities: [{ name: "session", available: true, detail: "RPC 新建、恢复、用户消息分叉、克隆与重命名。" }, { name: "workspace", available: true, detail: "文件和 Git 查询跟随当前会话 cwd。" },
          { name: "dialogs", available: true, detail: "RPC 扩展对话框在网页处理。" }, { name: "tools", available: false, detail: "需要 pi 上游提供 RPC 工具列表与启停。" },
          { name: "tree-navigation", available: false, detail: "需要 pi 上游提供 RPC tree 导航；可读取历史并从用户消息分叉。" },
          { name: "authentication", available: false, detail: "Ctrl+C 后在终端使用 /login。" }, { name: "resource-management", available: false, detail: "安装和配置扩展仍在终端完成。" }] };
    } else if (action === "tree") {
      await this.mirror!.synchronize(); const entries = this.mirror!.getEntries().filter(entry => !isRecord(entry.message) || entry.message.role !== "system" || visibleText(entry.message.content).trim()); const retained = entries.slice(-2000);
      value = { entries: retained.map(entry => { const message = isRecord(entry.message) ? entry.message : undefined;
        return { id: entry.id, parentId: entry.parentId, type: entry.type, ...(message && typeof message.role === "string" ? { role: message.role } : {}),
          preview: clip(visibleText(message?.content ?? entry.summary ?? entry.content ?? entry.type), 256), ...(typeof entry.timestamp === "string" ? { timestamp: entry.timestamp } : {}), current: entry.id === this.mirror!.getLeafId() };
      }), leafId: this.mirror!.getLeafId(), truncated: retained.length !== entries.length };
    } else if (action === "files") value = await this.workspace!.files(args.query as string | undefined);
    else if (action === "file") value = await this.workspace!.file(args.path as string);
    else if (action === "git_status") value = await this.workspace!.gitStatus();
    else value = await this.workspace!.gitDiff(args.path as string);
    if (this.sessionChangePending || generation !== this.generation || revision !== undefined && revision !== this.bridge!.branchRevision) throw new ProtocolError("stale_session", "The session changed during this read.");
    return value as WorkbenchValues[A];
  }
  private async commands(): Promise<WorkbenchCommand[]> {
    const result = await this.child!.request<{ commands: Array<{ name: string; description?: string; source: "extension" | "skill" | "prompt" }> }>("get_commands");
    const seen = new Set(BUILTIN_NAMES); const priority = { extension: 0, skill: 1, prompt: 2 };
    return [...BUILTINS, ...result.commands.filter(command => typeof command.name === "string" && ["extension", "skill", "prompt"].includes(command.source)).slice(0, 512)
      .sort((a, b) => priority[a.source] - priority[b.source]).map(command => { const collision = seen.has(command.name); seen.add(command.name); const valid = isCommandInvocationName(command.name);
        return { name: valid ? command.name : clip(command.name, 512), description: clip(command.description ?? "", 2048), source: command.source, available: valid && !collision,
          ...(!valid ? { reason: "此命令名称超出 RPC 工作台的安全输入范围。" } : collision ? { reason: "此名称被优先级更高的内置命令或资源占用。" } : {}) };
      })];
  }
  command(name: string, input: unknown, expected?: Expected): Promise<unknown> {
    // Abort is the one RPC control command that may interrupt a pending mutation (compact
    // or an extension command awaiting a dialog). It preserves wire order and never starts
    // a second session writer; ordinary mutations stay serialized behind the control.
    if (name === "abort") {
      this.assertLive(expected);
      if (this.control) return Promise.reject(new ProtocolError("busy", "An abort request is already in progress."));
      this.control = this.abort().finally(() => { this.control = undefined; });
      return this.control;
    }
    // A waiting RPC extension dialog is an active write, even when get_state reports
    // no model stream. Reject other viewers' writes now rather than silently applying
    // configuration/session changes after an unrelated answer unblocks the queue.
    if (this.dialogs.size) return Promise.reject(new ProtocolError("busy", "Answer or cancel the current extension dialog before submitting another command."));
    if (name !== "prompt" && name !== "run_command" && this.mirror && !this.mirror.idle)
      return Promise.reject(new ProtocolError("busy", "Wait until replies, compaction and queued messages have settled before changing configuration or sessions."));
    if (this.queuedWrites >= 32) return Promise.reject(new ProtocolError("busy", "Too many host commands are waiting; let them settle before retrying."));
    this.queuedWrites++;
    const result = this.writes.then(async () => {
      if (this.control) await this.control;
      this.assertLive(expected); const args = isRecord(input) ? input : {}; const operation = ++this.operation; this.activeOperation = operation;
      try { return await this.execute(name, args); }
      finally { this.activeOperation = undefined; for (const [id, owner] of this.dialogOwners) if (owner === operation) this.resolveDialog(id, "cancelled", true); }
    }).finally(() => { this.queuedWrites--; });
    this.writes = result.catch(() => undefined); return result;
  }
  private async abort(): Promise<unknown> {
    const result = this.child!.request("abort"); // send before dialog cancellation unblocks a queued command
    this.clearDialogs("cancelled", true);
    const value = await result;
    this.ownedWrite = true; await this.refreshAfterWrite();
    return value;
  }
  private async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    const child = this.child!; await this.mirror!.synchronize();
    if (name !== "prompt" && name !== "abort" && name !== "run_command" && !this.mirror!.idle) throw new ProtocolError("busy", "Wait until replies and queued messages have settled.");
    if (this.mirror!.idle) {
      await this.acceptOwnedChanges();
      try { await this.lock!.assertUnchanged(); }
      catch (error) { this.log("Session ownership conflict detected; stopping the RPC child without restarting it."); await this.stop(); throw error; }
    }
    if (name === "session_tree") throw new ProtocolError("upstream_required", "pi RPC does not support tree navigation.");
    if (SESSION_WRITES.has(name)) {
      let nextLock: SessionFileLock | undefined;
      if (name === "session_switch") {
        const path = typeof args.sessionId === "string" ? this.paths.get(args.sessionId) : undefined;
        if (!path) throw new ProtocolError("unknown_session", "Refresh the catalog and choose an exposed session ID.");
        if (args.sessionId === this.mirror!.sessionId) return { cancelled: false, unchanged: true, sessionId: this.mirror!.sessionId };
        nextLock = await SessionFileLock.acquire(path);
        if (child.pid) await nextLock.setWriterPid(child.pid);
      }
      if (name === "session_fork") {
        const entry = this.mirror!.getEntries().find(entry => entry.id === args.entryId);
        if (args.position !== undefined || !entry || !isRecord(entry.message) || entry.message.role !== "user") throw new ProtocolError("invalid_fork", "RPC fork accepts a user message and forks before it; use clone for the current complete branch.");
      }
      this.clearDialogs("session_changed", true); const previousUi = this.ui;
      this.ui = { revision: previousUi.revision + 1, statuses: {}, widgets: {} }; this.publishUi();
      this.sessionChangePending = true;
      try {
        const type = name === "session_new" ? "new_session" : name === "session_switch" ? "switch_session" : name === "session_clone" ? "clone" : "fork";
        const result = await child.request<{ cancelled?: boolean; text?: string }>(type, name === "session_switch" ? { sessionPath: this.paths.get(args.sessionId as string)! } : name === "session_fork" ? { entryId: args.entryId } : {});
        if (result.cancelled) { this.ui = { ...previousUi, revision: this.ui.revision + 1 }; this.publishUi();
          await this.mirror!.synchronize(); await this.lock!.acceptChanges(); return { cancelled: true, sessionId: this.mirror!.sessionId }; }
        const state = await child.request<{ sessionFile?: string }>("get_state");
        if (!state.sessionFile) throw new Error("The new RPC session has no persisted session path.");
        nextLock ??= await SessionFileLock.acquire(state.sessionFile);
        if (child.pid) await nextLock.setWriterPid(child.pid);
        const previousLock = this.lock; this.lock = nextLock; nextLock = undefined;
        await this.lock.acceptChanges(); await previousLock?.release(); await this.rebind(name === "session_new" ? "new" : "resume");
        return { cancelled: false, sessionId: this.mirror!.sessionId, branchRevision: this.bridge!.branchRevision, ...(typeof result.text === "string" ? { draftText: clip(result.text, 64 * 1024) } : {}) };
      } catch (error) {
        const state = await child.request<{ sessionFile?: string; sessionId?: string }>("get_state").catch(() => undefined);
        const unchanged = !!state?.sessionFile && state.sessionId === this.mirror!.sessionId
          && await this.lock?.matchesPath(state.sessionFile).catch(() => false);
        if (!unchanged) await this.stop();
        else {
          // A rejected native operation (e.g. clone on an empty fork) leaves the original
          // session active. Its lexical path must not be compared to a realpath lock string.
          this.lastSessionFile = state!.sessionFile!;
          this.ui = { ...previousUi, revision: this.ui.revision + 1 }; this.publishUi();
        }
        throw error;
      } finally { this.sessionChangePending = false; await nextLock?.release(); }
    }
    if (name === "prompt" || name === "run_command") {
      const message = name === "prompt" ? String(args.text ?? "") : `/${String(args.name)}${typeof args.args === "string" && args.args ? ` ${args.args}` : ""}`;
      const invocation = /^\s*\/([^\s]+)(?:\s|$)/u.exec(message)?.[1];
      if (invocation && BUILTIN_NAMES.has(invocation)) throw new ProtocolError("picker_required", "Use the workbench entry for this builtin; RPC would send it to the model as ordinary text.");
      if (name === "run_command" && !(await this.commands()).some(command => command.name === args.name && command.available)) throw new ProtocolError("unknown_command", "This command is unavailable in the current session.");
      const result = await child.request<{ disposition: string }>("prompt", { message,
        ...(Array.isArray(args.images) && args.images.length ? { images: args.images.filter(isRecord).map(image => ({ type: "image", ...image })) } : {}),
        streamingBehavior: args.mode === "steer" ? "steer" : "followUp" });
      if (!["started", "queued", "handled"].includes(result?.disposition)) { await this.stop(); throw new Error("pi RPC did not report an authoritative prompt disposition; the child was stopped."); }
      this.ownedWrite = true; await this.refreshAfterWrite(); return { disposition: result.disposition };
    }
    let value: unknown;
    if (name === "abort") value = await child.request("abort");
    else if (name === "set_model") value = await child.request("set_model", { provider: args.provider, modelId: args.id });
    else if (name === "set_thinking") { const available = await child.request<{ levels: string[] }>("get_available_thinking_levels");
      if (!available.levels.includes(String(args.level))) throw new ProtocolError("unsupported_thinking", "This model does not support that thinking level."); value = await child.request("set_thinking_level", { level: args.level });
    } else if (name === "compact") value = await child.request("compact", {}, 600_000);
    else if (name === "session_rename") value = await child.request("set_session_name", { name: args.name });
    else throw new ProtocolError("unknown_command", "Unknown handoff command.");
    this.ownedWrite = true; await this.refreshAfterWrite();
    return name === "session_rename" ? { name: this.mirror!.sessionName, sessionId: this.mirror!.sessionId } : value;
  }
  /** Registered RPC extension commands can replace sessions through their public command context. */
  private async refreshAfterWrite(): Promise<void> {
    const state = await this.child!.request<{ sessionFile?: string; sessionId?: string }>("get_state");
    const sameSession = state.sessionId === this.mirror!.sessionId && !!state.sessionFile
      && await this.lock?.matchesPath(state.sessionFile).catch(() => false);
    if (state.sessionFile && !sameSession) {
      this.lastSessionFile = state.sessionFile;
      this.activeCwd = await sessionCwd(state.sessionFile, this.activeCwd);
      let nextLock: SessionFileLock | undefined;
      try {
        nextLock = await SessionFileLock.acquire(state.sessionFile);
        if (this.child!.pid) await nextLock.setWriterPid(this.child!.pid!);
        const previousLock = this.lock; this.lock = nextLock; nextLock = undefined;
        await this.lock.acceptChanges(); await previousLock?.release();
        this.clearDialogs("session_changed", true);
        await this.rebind("resume");
      } catch (error) { await this.stop(); throw error; }
      finally { await nextLock?.release(); }
    } else { if (state.sessionFile) this.lastSessionFile = state.sessionFile; await this.mirror!.synchronize(); }
    await this.acceptOwnedChanges();
  }
  uiState(): HostUiState { return structuredClone(this.ui); }
  pendingDialogs(): Dialog[] { return [...this.dialogs.values()].map(dialog => structuredClone(dialog)); }
  answer(id: string, response: Record<string, unknown>): void {
    const dialog = this.dialogs.get(id);
    if (!dialog) throw new ProtocolError("dialog_closed", "This dialog was already answered or closed.");
    if (dialog.expiresAt !== undefined && Date.now() >= dialog.expiresAt) { this.resolveDialog(id, "timeout", true); throw new ProtocolError("dialog_closed", "This dialog timed out."); }
    let result: Record<string, unknown>;
    if (response.cancelled === true) result = { cancelled: true };
    else if (dialog.method === "confirm" && typeof response.confirmed === "boolean") result = { confirmed: response.confirmed };
    else if (dialog.method !== "confirm" && typeof response.value === "string" && Buffer.byteLength(response.value) <= 64 * 1024 && (dialog.method !== "select" || dialog.options?.includes(response.value)))
      result = { value: dialog.method === "select" ? this.dialogOptionValues.get(id)?.get(response.value) ?? response.value : response.value };
    else throw new ProtocolError("invalid_dialog_response", "Choose one of this dialog's supported responses.");
    this.child!.respondUi(id, result); this.resolveDialog(id, response.cancelled === true ? "cancelled" : "answered", false);
  }
  private resolveDialog(id: string, reason: string, cancel: boolean): void {
    if (!this.dialogs.delete(id)) return;
    this.dialogOwners.delete(id); this.dialogOptionValues.delete(id); const timer = this.dialogTimers.get(id); if (timer) clearTimeout(timer); this.dialogTimers.delete(id);
    if (cancel && this.child?.running) { try { this.child.respondUi(id, { cancelled: true }); } catch { /* child stopping */ } }
    this.hub.notifyAll({ t: "ui_resolved", id, reason });
  }
  private clearDialogs(reason: string, cancel: boolean): void { for (const id of [...this.dialogs.keys()]) this.resolveDialog(id, reason, cancel); }
  private publishUi(): void { this.hub.notifyAll({ t: "ui_state", ...this.uiState() }); }
  private dialog(record: RpcRecord): void {
    if (typeof record.id !== "string" || this.stopping) return;
    const id = record.id;
    if (["select", "confirm", "input", "editor"].includes(String(record.method))) {
      if (this.dialogs.has(id)) return;
      if (this.dialogs.size >= 16) { this.child?.respondUi(id, { cancelled: true }); return; }
      let options: string[] | undefined;
      if (Array.isArray(record.options)) {
        const values = new Map<string, string>();
        options = [];
        for (const [index, value] of record.options.slice(0, 64).entries()) {
          const original = String(value);
          if (Buffer.byteLength(original) > 64 * 1024) { this.child?.respondUi(id, { cancelled: true }); this.hub.notifyAll({ t: "notice", message: "扩展对话框选项超过 64 KiB，已取消。" }); return; }
          let label = Buffer.byteLength(original) <= 500 ? original : `${index + 1}. ${clip(original, 480)}…`;
          for (let suffix = 1; values.has(label); suffix++) label = `${clip(original, 460)} [${index + 1}.${suffix}]`;
          values.set(label, original); options.push(label);
        }
        this.dialogOptionValues.set(id, values);
        if (record.options.length > 64) this.hub.notifyAll({ t: "notice", message: "扩展对话框只显示前 64 个选项。" });
      }
      const timeout = typeof record.timeout === "number" && Number.isFinite(record.timeout) && record.timeout > 0 ? record.timeout : undefined;
      const dialog: Dialog = { t: "ui_request", id, method: record.method as Dialog["method"], ...(typeof record.title === "string" ? { title: clip(record.title, 500) } : {}),
        ...(typeof record.message === "string" ? { message: clip(record.message, 4000) } : {}), ...(options ? { options } : {}),
        ...(typeof record.placeholder === "string" ? { placeholder: clip(record.placeholder, 500) } : {}), ...(typeof record.prefill === "string" ? { prefill: clip(record.prefill, 64 * 1024) } : {}), ...(timeout !== undefined ? { expiresAt: Date.now() + timeout } : {}) };
      this.dialogs.set(id, dialog); if (this.activeOperation !== undefined) this.dialogOwners.set(id, this.activeOperation); this.hub.notifyAll(dialog);
      if (typeof record.prefill === "string" && Buffer.byteLength(record.prefill) > 64 * 1024) this.hub.notifyAll({ t: "notice", message: "扩展编辑器预填文本已截断为 64 KiB。" });
      if (timeout !== undefined) { const timer = setTimeout(() => this.resolveDialog(id, "timeout", true), Math.min(timeout, 2_147_483_647)); timer.unref?.(); this.dialogTimers.set(id, timer); }
      return;
    }
    if (record.method === "notify" && typeof record.message === "string") { this.hub.notifyAll({ t: "notice", message: clip(record.message, 2000) }); return; }
    if (record.method === "setStatus" && typeof record.statusKey === "string") {
      const key = clip(record.statusKey, 256); if (record.statusText === undefined) delete this.ui.statuses[key];
      else if (typeof record.statusText === "string" && (key in this.ui.statuses || Object.keys(this.ui.statuses).length < 64)) this.ui.statuses[key] = clip(record.statusText, 2000);
    } else if (record.method === "setWidget" && typeof record.widgetKey === "string") {
      const key = clip(record.widgetKey, 256); if (record.widgetLines === undefined) delete this.ui.widgets[key];
      else if (Array.isArray(record.widgetLines) && (key in this.ui.widgets || Object.keys(this.ui.widgets).length < 32)) {
        let remaining = 8192; const content: string[] = [];
        for (const line of record.widgetLines.slice(0, 64)) { if (remaining <= 0) break; const text = clip(String(line), Math.min(2000, remaining)); content.push(text); remaining -= Buffer.byteLength(text); }
        this.ui.widgets[key] = { content, ...(typeof record.widgetPlacement === "string" ? { placement: clip(record.widgetPlacement, 64) } : {}) };
      }
    } else if (record.method === "setTitle" && typeof record.title === "string") this.ui.title = clip(record.title, 500);
    else if (record.method === "set_editor_text" && typeof record.text === "string") { this.ui.editorText = clip(record.text, 64 * 1024); this.ui.editorRevision = (this.ui.editorRevision ?? 0) + 1; }
    else return;
    this.ui.revision++; this.publishUi();
  }
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true; this.clearDialogs("stopped", true); this.mirror?.dispose(); this.bridge?.dispose(); this.unsubscribe?.();
    this.stopPromise = (async () => { try { await this.child?.stop(); } finally { await this.lock?.release(); this.hub.setHostHandler(undefined); } })();
    return this.stopPromise;
  }
}
