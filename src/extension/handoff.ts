import { SessionManager, getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { access, lstat, mkdir, open, readdir, realpath, stat, unlink } from "node:fs/promises";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ProtocolError, isRecord, isCommandInvocationName, workbenchArgs, type AccountState, type AccountsView, type HostCommandName, type PiThemeView, type CustomModel, type CustomProviderResult, type CustomProvidersView, type ExportPage, type SessionDeleteResult, type SessionExportResult, type SessionInspectView, type SettingKey, type SettingResult, type SettingValue, type SettingsView, type ThemeView, type ThemesView, type HostQueryAction, type HostQueryValues, type HostState, type ProjectItem, type ProjectInspectView, type ProjectsView, type ProjectTrustView, type WorkbenchAction, type WorkbenchValues, type WorkbenchCommand, type SessionCatalogItem, type SessionStatsView } from "../protocol/index.js";
import { Bridge } from "./bridge.js";
import type { Hub, HostHandler } from "./hub.js";
import { LaunchProfile, type LaunchTarget } from "./launch-profile.js";
import { RpcChild, RpcReadTimeoutError, type RpcConnection, type RpcRecord } from "./rpc-child.js";
import { RpcSessionMirror } from "./rpc-session.js";
import { SessionFileLock, type KnownEntry } from "./session-lock.js";
import { WorkspaceService } from "./workspace.js";
import { ProjectRegistry, ProjectRegistryError, type ProjectView } from "./project-registry.js";
import { ProjectService } from "./projects.js";
import { AuthController, type AuthRuntime } from "./auth-controller.js";
import { ThemeCatalog, type Catalog } from "./theme-catalog.js";
import { SettingsController, type SettingChoices, type SettingsScope } from "./settings-controller.js";
import type { PaneTheme } from "./theme.js";
import { ProviderConfig } from "./provider-config.js";
export { childArgs } from "./child-args.js";
export { LaunchProfile } from "./launch-profile.js";
export { SessionFileLock } from "./session-lock.js";

export interface HandoffTarget {
  sessionFile: string; sessionDir?: string; cwd: string; argv: string[];
  theme: ExtensionContext["ui"]["theme"]; themes: ReturnType<ExtensionContext["ui"]["getAllThemes"]>;
  /** Transferred in-process only after the foreground TUI has shut down. */
  lock?: SessionFileLock;
  /** Built while the TUI's start directory is still the process cwd; derived from `argv` and `cwd` when absent. */
  profile?: LaunchProfile;
  /** The model the TUI was using. A saved session restores its own; a difference is reported, never hidden. */
  model?: ModelRef;
}
interface ModelRef { provider: string; id: string }
/** Where an RPC child runs: a project directory and, unless a new session is wanted, a saved transcript. */
export interface RuntimeTarget { cwd: string; sessionFile?: string; withholdTrust?: boolean }
/**
 * - `replacing`: the old child is stopping or its replacement is starting; no session is bound.
 * - `recovery_required`: a replacement failed. The Hub stays up, conversation writes are refused,
 *   and only an explicit retry, restore or stop leaves this state.
 */
export type HostPhase = "starting" | "ready" | "replacing" | "recovery_required" | "stopped";
export type RecoveryReason = "stop_incomplete" | "shutdown_conflict" | "start_failed";
export interface HostStatus {
  revision: number; phase: HostPhase; cwd: string; sessionFile?: string;
  recovery?: { reason: RecoveryReason; message: string; target: RuntimeTarget; previous: RuntimeTarget; canRestore: boolean };
}
/** Why the host is over. `planned` is the user's own stop from the recovery page. */
export interface HostEnd { exit: number | null; planned: boolean }
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
  /** How long a planned stop waits for the old child's shutdown handlers before signalling it. */
  plannedStopMs?: number;
  /** pi's agent directory: the project list, the trust store and global settings live under it. */
  agentDir?: string;
  /** pi's public auth runtime for the host-side login; tests script it. */
  createAuthRuntime?: (custom?: boolean) => Promise<AuthRuntime>;
  accountLimitMs?: number;
  webOAuth?: ReadonlySet<string>;
  /** The `themes` directory shipped with this package. */
  bundledThemes?: string;
  /** How long a setting changed through pi's RPC may take to show in the global file. */
  settingConfirmMs?: number;
  /** Moves a file to the system trash and says whether it did. Absent: the `trash` command, as pi's own session picker uses it. */
  trash?: (path: string) => Promise<boolean>;
}
/** Largest export sent to a browser; a larger one stays on the host and only its path is reported. */
const EXPORT_DOWNLOAD_BYTES = 32 * 1024 * 1024;
const EXPORT_PAGE_BYTES = 384 * 1024;
const EXPORTS_KEPT = 20;
/** Whether a command of this name is on PATH. Nothing is run to find out. */
async function onPath(name: string): Promise<boolean> {
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean))
    if (await access(join(directory, name), constants.X_OK).then(() => true, () => false)) return true;
  return false;
}
/** pi's own way of deleting a session: the `trash` command with the path as an argument, never through a shell. */
function systemTrash(path: string): Promise<boolean> {
  return new Promise(done => {
    execFile("trash", path.startsWith("-") ? ["--", path] : [path], { timeout: 10_000 }, error => done(!error || !existsSync(path)));
  });
}
const within = (path: string, directory: string): boolean => path.startsWith(directory.endsWith(sep) ? directory : directory + sep);
/** A planned replacement waits for slow shutdown handlers; an emergency stop (Ctrl+C) does not. */
const PLANNED_STOP_MS = 20_000;
const DIALOG_METHODS = ["select", "confirm", "input", "editor"];
const canonical = (path: string): Promise<string> => realpath(path).catch(() => resolve(path));
async function samePath(a: string, b: string): Promise<boolean> { return await canonical(a) === await canonical(b); }
const BUILTINS: WorkbenchCommand[] = [
  ["new", "新建会话", "new"], ["resume", "查找并恢复会话", "sessions"], ["fork", "从用户消息之前分叉", "tree"],
  ["model", "选择模型", "model"], ["thinking", "调整思考强度", "thinking"], ["compact", "压缩会话", "compact"],
  ["settings", "打开设置", "settings"], ["session", "会话信息与用量", "status"], ["export", "导出会话为 HTML", "export"], ["copy", "复制最后一条回复", "copy"], ["name", "重命名会话", "rename"], ["clone", "克隆当前分支", "clone"],
].map(([name, description, action]) => ({ name: name!, description: description!, source: "builtin", available: true, browserAction: action as WorkbenchCommand["browserAction"] }));
BUILTINS.push({ name: "tree", description: "切换历史分支", source: "builtin", available: false, reason: "需要 pi 上游提供 RPC tree 导航；当前只能从用户消息分叉。", browserAction: "tree" });
for (const [name, description] of [["login", "登录模型服务商"], ["logout", "退出模型服务商"]])
  BUILTINS.push({ name: name!, description: description!, source: "builtin", available: true, browserAction: "accounts" });
for (const name of ["web", "scoped-models", "import", "share", "bug", "changelog", "hotkeys", "trust", "reload", "quit", "debug", "arminsayshi", "dementedelves"])
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
  /** What the last listings said about each saved session, for the question asked before one is deleted. */
  private listed = new Map<string, { cwd: string; name?: string; messageCount: number; modified: string }>();
  private exports = new Map<string, { path: string; bytes: number; name: string }>();
  private readonly providerConfig: ProviderConfig;
  private builtinProviders?: Promise<Set<string>>;
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
  /** Lock of the active runtime, or of the last one while a replacement is pending or failed. */
  private lock?: SessionFileLock;
  /** Every lock this host holds, so a stop at any point of a replacement releases all of them. */
  private locks = new Set<SessionFileLock>();
  private verifying: Promise<void> = Promise.resolve();
  private unsubscribe?: () => void;
  private activeCwd: string;
  /** The directory the active child was started in. Its sessions must all belong to it. */
  private runtimeCwd: string;
  private withholdTrust = false;
  private lastSessionFile: string;
  private readonly profile: LaunchProfile;
  private phase: HostPhase = "starting";
  private hostRevision = 0;
  /** The child that passed readiness. Only its unplanned exit ends the service. */
  private readyChild?: RpcConnection;
  private retiring?: RpcConnection;
  private shutdownDialog = false;
  private recovery?: NonNullable<HostStatus["recovery"]>;
  /** The model of the runtime that was stopped, to compare when its session is restored. */
  private previousModel?: ModelRef;
  private end!: (value: HostEnd) => void;
  /** Settles once: the ready child exited on its own, the host failed closed, or the user stopped a failed replacement. */
  readonly finished = new Promise<HostEnd>(resolve => { this.end = resolve; });
  private readonly agentDir: string;
  private readonly registry: ProjectRegistry;
  private readonly projects: ProjectService;
  private readonly accounts: AuthController;
  private readonly themes: ThemeCatalog;
  private readonly settings: SettingsController;
  /** What "follow pi" shows in the current project. The handoff theme until a project's own is resolved. */
  private piTheme: PaneTheme;
  private piThemeView?: PiThemeView;
  /** pi's auth file or a setting the session reads once changed, and the running session has not reloaded. */
  private pendingApply = false;
  private applyError?: string;
  constructor(private readonly hub: Hub, private readonly target: HandoffTarget, private readonly log: (line: string) => void,
    private readonly dependencies: HandoffDependencies = {}) {
    this.activeCwd = this.runtimeCwd = target.cwd; this.lastSessionFile = target.sessionFile;
    this.profile = target.profile ?? new LaunchProfile(target.argv, target.cwd);
    const agentDir = dependencies.agentDir ?? getAgentDir();
    this.registry = new ProjectRegistry(agentDir);
    this.projects = new ProjectService({ agentDir, protectedDirectories: () => [agentDir, ...this.directories] });
    this.agentDir = agentDir; this.providerConfig = new ProviderConfig(agentDir);
    this.accounts = new AuthController({ agentDir, publish: () => this.hub.publishAccountState(), changed: () => this.credentialsChanged(), customProviders: () => this.customProviderIds(),
      ...(dependencies.createAuthRuntime ? { createRuntime: dependencies.createAuthRuntime } : {}), ...(dependencies.accountLimitMs ? { limitMs: dependencies.accountLimitMs } : {}),
      ...(dependencies.webOAuth ? { webOAuth: dependencies.webOAuth } : {}) });
    this.piTheme = target.theme;
    this.themes = new ThemeCatalog({ agentDir, handoff: target.themes, handoffTheme: target.theme, startCwd: this.profile.startCwd, discover: !this.profile.noThemes,
      bundledDir: dependencies.bundledThemes ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../themes") });
    const start = this.profile.startModel, startTheme = this.profile.startTheme;
    this.settings = new SettingsController({ agentDir, cli: { ...start, ...(startTheme ? { theme: startTheme } : {}) }, ...(dependencies.settingConfirmMs ? { confirmMs: dependencies.settingConfirmMs } : {}) });
    this.rememberDirectory(target.sessionDir ?? dirname(target.sessionFile));
  }
  get sessionFile(): string { return this.lastSessionFile; }
  get cwd(): string { return this.activeCwd; }
  get childPid(): number | undefined { return this.child?.pid; }
  get diagnostics(): string { return this.child?.diagnostics ?? ""; }
  status(): HostStatus {
    return structuredClone({ revision: this.hostRevision, phase: this.phase, cwd: this.activeCwd, sessionFile: this.lastSessionFile, ...(this.recovery ? { recovery: this.recovery } : {}) });
  }
  /** The wire view: no session paths, which a viewer never needs to choose a recovery. */
  hostState(): HostState {
    const recovery = this.recovery;
    return { t: "host_state", revision: this.hostRevision, phase: this.phase === "recovery_required" ? "recovery_required" : this.phase === "ready" ? "ready" : "replacing", cwd: this.activeCwd,
      ...(recovery ? { recovery: { reason: recovery.reason, message: clip(recovery.message, 2000), targetCwd: recovery.target.cwd, previousCwd: recovery.previous.cwd, canRestore: recovery.canRestore } } : {}) };
  }
  hostCommand(name: HostCommandName, args: Record<string, unknown> = {}, revision = this.hostRevision, leaseId = ""): Promise<unknown> {
    // Account commands act on the operation or provider they name, not on a page's picture of the host.
    if (name === "account_begin") return this.accounts.begin(leaseId, String(args.provider), args.method === "oauth" ? "oauth" : "api_key");
    if (name === "account_cancel") return Promise.resolve().then(() => { this.accounts.cancel(String(args.operationId)); return {}; });
    if (name === "account_logout") return this.accounts.logout(String(args.provider)).then(() => ({ pendingApply: this.pendingApply }));
    if (name === "account_apply") return this.applyCredentials(true).then(() => ({ pendingApply: this.pendingApply }));
    if (name === "provider_save" || name === "provider_remove") return this.changeProvider(name, args);
    if (name === "session_delete") return this.deleteSession(String(args.sessionId));
    if (name === "session_export") return this.exportSession();
    // A setting is checked against the value the page was showing, not against the host revision.
    if (name === "setting_set") return this.setSetting(args.key as SettingKey, args.value as SettingValue, args.expected as SettingValue);
    if (revision !== this.hostRevision) return Promise.reject(new ProtocolError("stale_host", "The host state changed; check the page before trying again."));
    if (name === "recover_retry" || name === "recover_restore" || name === "host_stop")
      return this.recover(name === "recover_retry" ? "retry" : name === "recover_restore" ? "restore" : "stop").then(() => ({ phase: this.hostState().phase }));
    return this.projectCommand(name, args, revision);
  }
  accountState(leaseId: string): AccountState { return { t: "account_state", operation: this.accounts.view(leaseId) }; }
  accountAnswer(leaseId: string, operationId: string, stepId: string, value: string): void { this.accounts.answer(leaseId, operationId, stepId, value); }
  leaseEnded(leaseId: string): void { this.accounts.leaseEnded(leaseId); }
  /**
   * Providers as pi's auth file and the running session see them. The stored kind comes from pi's
   * credential list; availability is what the session's model list offers. Neither resolves a key.
   */
  private async accountsView(): Promise<AccountsView> {
    let providers: AccountsView["providers"] = [], storeError: string | undefined;
    try { providers = await this.accounts.providers(); } catch (error) { storeError = clip(error instanceof Error ? error.message : String(error), 400); }
    const available = this.phase === "ready" && this.child?.running
      ? await this.child.request<{ models: Array<{ provider: string }> }>("get_available_models").then(result => result.models, () => []) : [];
    const counts = new Map<string, number>();
    for (const model of available) counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
    for (const provider of providers) { provider.models = counts.get(provider.id) ?? 0; counts.delete(provider.id); }
    // Providers pi's built-in list does not have: those of models.json, whose key is set like any other, and those an extension registers.
    const [file, stored] = await Promise.all([this.providerConfig.read(), this.accounts.stored().catch(() => new Map<string, "api_key" | "oauth">())]);
    const known = new Set(providers.map(provider => provider.id));
    for (const custom of file.providers) {
      if (known.has(custom.id)) continue;
      const kind = stored.get(custom.id);
      providers.push({ id: custom.id, name: custom.id, methods: [{ type: "api_key", label: "API key", web: true }], ...(kind ? { stored: kind } : {}), models: counts.get(custom.id) ?? 0, knownModels: custom.models.length, custom: true });
      counts.delete(custom.id);
    }
    for (const [id, models] of counts) providers.push({ id: clip(id, 128), name: clip(id, 128), methods: [{ type: "api_key", label: "", web: false, reason: "extension" }], models, knownModels: models });
    const rank = (provider: AccountsView["providers"][number]) => provider.stored ? 0 : provider.models ? 1 : 2;
    providers.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    return { providers, pendingApply: this.pendingApply, ...(this.applyError ? { applyError: this.applyError } : {}), ...(storeError ? { storeError } : {}) };
  }
  /** Names of pi's own providers. They do not change while pi runs. */
  private builtinIds(): Promise<Set<string>> {
    this.builtinProviders ??= this.accounts.providers().then(providers => new Set(providers.map(provider => provider.id)));
    this.builtinProviders.catch(() => { this.builtinProviders = undefined; });
    return this.builtinProviders;
  }
  /** Providers that exist only because models.json defines them. */
  private async customProviderIds(): Promise<Set<string>> {
    const [ids, builtin] = await Promise.all([this.providerConfig.ids(), this.builtinIds()]);
    return new Set([...ids].filter(id => !builtin.has(id)));
  }
  private async sessionModels(): Promise<{ counts: Map<string, number>; current?: string }> {
    const live = this.phase === "ready" && !!this.child?.running && !this.stopping;
    const [models, state] = live ? await Promise.all([
      this.child!.request<{ models: Array<{ provider: string }> }>("get_available_models").then(result => result.models, () => []),
      this.child!.request<{ model?: { provider?: string } }>("get_state").catch(() => undefined)]) : [[], undefined];
    const counts = new Map<string, number>();
    for (const model of models) counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
    return { counts, ...(state?.model?.provider ? { current: state.model.provider } : {}) };
  }
  private async providersView(): Promise<CustomProvidersView> {
    const [file, stored, builtin, session] = await Promise.all([this.providerConfig.read(), this.accounts.stored().catch(() => new Map<string, "api_key" | "oauth">()), this.builtinIds(), this.sessionModels()]);
    return {
      providers: file.providers.map(provider => ({ ...provider, key: stored.has(provider.id) ? "stored" as const : file.fileKeys.get(provider.id) ?? "none" as const,
        overlay: builtin.has(provider.id), inUse: session.current === provider.id, available: session.counts.get(provider.id) ?? 0 })),
      revision: file.revision, ...(file.error ? { error: file.error } : {}), pendingApply: this.pendingApply, ...(this.applyError ? { applyError: this.applyError } : {}),
    };
  }
  /**
   * Adds, changes or removes one provider of models.json. A new name must not be one pi already
   * gives a meaning to: its own providers, and those the running session has from an extension.
   * The running session reloads when it is idle, like after a credential change.
   */
  private changeProvider(name: "provider_save" | "provider_remove", args: Record<string, unknown>): Promise<CustomProviderResult> {
    if (this.queuedWrites >= 32) return Promise.reject(new ProtocolError("busy", "Too many host commands are waiting; let them settle before retrying."));
    this.queuedWrites++;
    const result = this.writes.then(async (): Promise<CustomProviderResult> => {
      if (this.control) await this.control;
      if (this.stopping) throw new ProtocolError("host_stopped", "The service is stopping.");
      const id = String(args.id).trim(), revision = String(args.revision);
      const [builtin, fileIds, session] = await Promise.all([this.builtinIds(), this.providerConfig.ids(), this.sessionModels()]);
      let outcome: CustomProviderResult;
      if (name === "provider_save") {
        const reserved = new Set(builtin);
        if (args.create === true) for (const provider of session.counts.keys()) if (!fileIds.has(provider)) reserved.add(provider);
        const saved = await this.providerConfig.save({ id, api: String(args.api), baseUrl: String(args.baseUrl), models: args.models as CustomModel[] }, revision, args.create === true, reserved);
        outcome = { id: saved.id, revision: saved.revision, ...(saved.insecure ? { insecure: true } : {}) };
      } else {
        if (this.accounts.busy) throw new ProtocolError("account_busy", "An account operation is in progress. Finish or cancel it first.");
        const removed = await this.providerConfig.remove(id, revision, builtin);
        // The key pi stored for it would otherwise stay in the auth file with no provider to show it under.
        const credentialRemoved = await this.accounts.logout(id).then(() => true, () => false);
        outcome = { id, revision: removed.revision, ...(credentialRemoved ? { credentialRemoved } : {}) };
      }
      if (this.phase === "ready" && this.child?.running) { this.pendingApply = true; this.applyError = undefined; }
      return outcome;
    }).finally(() => { this.queuedWrites--; this.touch(); });
    this.writes = result.catch(() => undefined);
    void result.then(() => void this.applyCredentials(false).catch(() => undefined), () => undefined);
    return result;
  }
  /** Directories saved sessions may live in: pi's own session directory and every one this host has used. */
  private sessionRoots(): Promise<string[]> {
    return Promise.all([join(this.agentDir, "sessions"), ...(process.env.PI_CODING_AGENT_SESSION_DIR ? [process.env.PI_CODING_AGENT_SESSION_DIR] : []), ...this.directories].map(canonical));
  }
  /**
   * The file a listed session ID stands for, checked again at the moment of use: a regular `.jsonl`
   * inside a session directory, whose header still carries that ID.
   */
  private async listedSession(sessionId: string): Promise<{ path: string; cwd: string }> {
    const listedPath = this.paths.get(sessionId);
    if (!listedPath) throw new ProtocolError("unknown_session", "Session was not exposed by the catalog.");
    const info = await lstat(listedPath).catch(() => undefined);
    if (!info) throw new ProtocolError("session_missing", "This session file no longer exists.");
    const path = await canonical(listedPath), roots = await this.sessionRoots();
    if (!info.isFile() || !path.endsWith(".jsonl") || !roots.some(root => within(path, root))) throw new ProtocolError("session_refused", "This is not a session file inside a session directory.");
    let header: unknown;
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const bytes = Buffer.alloc(64 * 1024); const read = await file.read(bytes, 0, bytes.length, 0); header = JSON.parse(bytes.subarray(0, read.bytesRead).toString("utf8").split("\n", 1)[0]!); }
    catch { header = undefined; } finally { await file.close(); }
    if (!isRecord(header) || header.type !== "session" || header.id !== sessionId) throw new ProtocolError("session_refused", "The file no longer holds the session that was listed.");
    return { path, cwd: typeof header.cwd === "string" ? header.cwd : "" };
  }
  private async isCurrentSession(sessionId: string, path: string): Promise<boolean> {
    const held = [this.lastSessionFile, this.recovery?.target.sessionFile, this.recovery?.previous.sessionFile].filter((file): file is string => !!file);
    return sessionId === this.mirror?.sessionId || (await Promise.all(held.map(file => samePath(file, path)))).some(Boolean);
  }
  private async inspectSession(sessionId: string): Promise<SessionInspectView> {
    const { path, cwd } = await this.listedSession(sessionId);
    const listed = this.listed.get(sessionId);
    const [current, owner, trash] = await Promise.all([this.isCurrentSession(sessionId, path), SessionFileLock.inspect(path).catch(() => undefined), this.dependencies.trash ? true : onPath("trash")]);
    return { id: sessionId, ...(listed?.name ? { name: listed.name } : {}), cwd: clip(listed?.cwd ?? cwd, 4096), path, messageCount: listed?.messageCount ?? 0, modified: listed?.modified ?? "", current, locked: !!owner && !current, trash };
  }
  /**
   * Deletes one saved session the user picked from a listing. Never the current one, never one another
   * `/web` service holds. The host takes the session's lock for the deletion, so no service can open it
   * meanwhile; a terminal pi that has it open cannot be detected, which the page says before asking.
   * Like pi's own session picker: the system trash when there is one, otherwise permanent removal.
   */
  private deleteSession(sessionId: string): Promise<SessionDeleteResult> {
    if (this.queuedWrites >= 32) return Promise.reject(new ProtocolError("busy", "Too many host commands are waiting; let them settle before retrying."));
    this.queuedWrites++;
    const result = this.writes.then(async (): Promise<SessionDeleteResult> => {
      if (this.control) await this.control;
      if (this.stopping) throw new ProtocolError("host_stopped", "The service is stopping.");
      const { path } = await this.listedSession(sessionId);
      if (await this.isCurrentSession(sessionId, path)) throw new ProtocolError("session_current", "The session that is open cannot be deleted. Switch to another one first.");
      const lock = await this.hold(path); // refuses a session another /web service owns
      let method: SessionDeleteResult["method"];
      try {
        const trashed = await (this.dependencies.trash ?? systemTrash)(path).catch(() => false);
        if (trashed && !existsSync(path)) method = "trash";
        else {
          try { await unlink(path); } catch (error) { throw new ProtocolError("delete_failed", `The session file could not be deleted: ${clip(error instanceof Error ? error.message : String(error), 200)}`); }
          method = "deleted";
        }
      } finally { await this.drop(lock).catch(() => undefined); }
      this.paths.delete(sessionId); this.listed.delete(sessionId);
      // A project that remembered this file as its last session must not offer to resume it.
      await this.registry.forgetSession(path).catch(() => undefined);
      this.log(`Session ${sessionId} ${method === "trash" ? "moved to the trash" : "deleted"}: ${path}`);
      return { id: sessionId, method };
    }).finally(() => { this.queuedWrites--; });
    this.writes = result.catch(() => undefined);
    return result;
  }
  /**
   * Has pi write an HTML copy of the current session into pi-pane's export directory. The browser
   * never chooses the path: without one pi would write into the project directory.
   */
  private exportSession(): Promise<SessionExportResult> {
    if (this.queuedWrites >= 32) return Promise.reject(new ProtocolError("busy", "Too many host commands are waiting; let them settle before retrying."));
    this.queuedWrites++;
    const result = this.writes.then(async (): Promise<SessionExportResult> => {
      if (this.control) await this.control;
      this.assertLive();
      if (this.sessionChangePending) throw new ProtocolError("busy", "A session change is in progress; export after it.");
      if (!existsSync(this.lastSessionFile)) throw new ProtocolError("session_unsaved", "This session has nothing saved yet. Send a message first.");
      const directory = join(this.agentDir, "pi-pane", "exports");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
      const name = `session-${this.mirror!.sessionId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "export"}-${stamp}-${randomUUID().slice(0, 4)}.html`;
      const target = join(await canonical(directory), name);
      const reply = await this.child!.request<{ path?: string }>("export_html", { outputPath: target }, 60_000);
      if (!reply.path || !(await samePath(reply.path, target))) throw new ProtocolError("export_failed", "pi did not write the export where it was asked to.");
      const info = await stat(target);
      const exportId = randomUUID();
      this.exports.set(exportId, { path: target, bytes: info.size, name });
      while (this.exports.size > 8) this.exports.delete(this.exports.keys().next().value!);
      // Exports hold whole conversations: only the most recent ones are kept.
      const old = (await readdir(directory).catch(() => [])).filter(file => /^session-.*\.html$/.test(file)).sort().slice(0, -EXPORTS_KEPT);
      for (const file of old) await unlink(join(directory, file)).catch(() => undefined);
      return { exportId, path: target, name, bytes: info.size, downloadable: info.size <= EXPORT_DOWNLOAD_BYTES };
    }).finally(() => { this.queuedWrites--; });
    this.writes = result.catch(() => undefined);
    return result;
  }
  /** One part of an export this host made, for the browser to save. Only files this host wrote, by the ID it gave. */
  private async exportPage(exportId: string, offset: number): Promise<ExportPage> {
    const item = this.exports.get(exportId);
    if (!item) throw new ProtocolError("export_missing", "This export is no longer available for download; export again.");
    if (item.bytes > EXPORT_DOWNLOAD_BYTES) throw new ProtocolError("export_too_large", "This export is too large to download here; it is on the computer running pi.");
    const file = await open(item.path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
    if (!file) throw new ProtocolError("export_missing", "The exported file is gone; export again.");
    try {
      if ((await file.stat()).size !== item.bytes || offset > item.bytes) throw new ProtocolError("export_missing", "The exported file changed; export again.");
      const bytes = Buffer.alloc(Math.min(EXPORT_PAGE_BYTES, item.bytes - offset));
      const read = await file.read(bytes, 0, bytes.length, offset);
      const next = offset + read.bytesRead;
      return { exportId, offset, data: bytes.subarray(0, read.bytesRead).toString("base64"), total: item.bytes, ...(next < item.bytes ? { next } : {}) };
    } finally { await file.close(); }
  }
  /** Saving or removing a credential does not reach a running session by itself. Apply at once when nothing is in progress. */
  private credentialsChanged(): void {
    this.pendingApply = true; this.applyError = undefined; this.touch();
    void this.applyCredentials(false).catch(() => undefined);
  }
  /**
   * Makes the running session reload pi's credentials, in process: a saved session is reopened on its
   * own file and an unsaved one is replaced by a new one. Session ID, model and history stay; extensions
   * keep their veto. Only when the session is idle; otherwise it stays pending until the user asks.
   */
  private applyCredentials(explicit: boolean): Promise<void> {
    const waiting = (reason: string): Promise<void> => {
      if (!explicit) return Promise.resolve();
      this.applyError = reason; this.touch(); return Promise.reject(new ProtocolError("busy", reason));
    };
    if (!this.pendingApply) return Promise.resolve();
    if (this.phase !== "ready" || !this.mirror || this.stopping) return waiting("No session is running to apply this to.");
    if (this.dialogs.size || !this.mirror.idle || this.queuedWrites) return waiting("Wait until replies, queued messages and dialogs have settled, then apply.");
    this.queuedWrites++;
    const result = this.writes.then(async () => {
      if (this.control) await this.control;
      if (!this.pendingApply) return;
      this.assertLive();
      const outcome = await this.reloadRuntime();
      if (outcome.cancelled) { this.applyError = "An extension declined to reload the session. The change is saved; try again later."; throw new ProtocolError("apply_cancelled", this.applyError); }
      this.pendingApply = false; this.applyError = undefined;
    }).catch(error => {
      if ((error as { code?: string }).code !== "apply_cancelled") this.applyError = clip(error instanceof Error ? error.message : String(error), 400);
      throw error;
    }).finally(() => { this.queuedWrites--; this.touch(); });
    this.writes = result.catch(() => undefined); return result;
  }
  /** Reopens the current session in the same child so its model runtime is rebuilt. The lock and transcript stay as they are. */
  private async reloadRuntime(): Promise<{ cancelled: boolean }> {
    const child = this.child!; await this.mirror!.synchronize();
    if (!this.mirror!.idle) throw new ProtocolError("busy", "Wait until replies and queued messages have settled.");
    await this.verifyOwnedChanges();
    const saved = existsSync(this.lastSessionFile), before = await this.currentModel(), sessionId = this.mirror!.sessionId;
    this.clearDialogs("session_changed", true); const previousUi = this.ui;
    this.ui = { revision: previousUi.revision + 1, statuses: {}, widgets: {} }; this.publishUi();
    this.sessionChangePending = true;
    let nextLock: SessionFileLock | undefined;
    try {
      const result = await child.request<{ cancelled?: boolean }>(saved ? "switch_session" : "new_session", saved ? { sessionPath: this.lastSessionFile } : {});
      if (result.cancelled) {
        this.ui = { ...previousUi, revision: this.ui.revision + 1 }; this.publishUi();
        await this.mirror!.synchronize(); await this.lock!.acceptChanges(); return { cancelled: true };
      }
      const state = await child.request<{ sessionFile?: string }>("get_state");
      if (!state.sessionFile) throw new Error("The reloaded RPC session has no session path.");
      if (saved) {
        if (!(await this.lock!.matchesPath(state.sessionFile))) throw new Error("The RPC child reopened a different session.");
        await this.lock!.acceptChanges();
      } else {
        nextLock = await this.hold(state.sessionFile);
        if (child.pid) await nextLock.setWriterPid(child.pid);
        const previousLock = this.lock; this.lock = nextLock; nextLock = undefined;
        await this.lock.acceptChanges(); await this.drop(previousLock);
      }
      await this.rebind("reload");
      await this.reportModelChange(before, "before the reload", "重新加载前");
      return { cancelled: false };
    } catch (error) {
      const state = await child.request<{ sessionFile?: string; sessionId?: string }>("get_state").catch(() => undefined);
      const unchanged = !!state?.sessionFile && state.sessionId === sessionId && await this.lock?.matchesPath(state.sessionFile).catch(() => false);
      if (!unchanged) await this.stop();
      else { this.ui = { ...previousUi, revision: this.ui.revision + 1 }; this.publishUi(); }
      throw error;
    } finally { this.sessionChangePending = false; await this.drop(nextLock); }
  }
  /**
   * The project whose settings and themes apply, with the trust pi's child would use for it: nothing
   * project-scoped is read for a project the user has not trusted or chose to open without its configuration.
   */
  private async settingsScope(): Promise<SettingsScope> {
    const root = this.runtimeCwd, view = this.projects.trust(root);
    const override = this.profile.startTrust && await samePath(root, this.profile.startCwd) ? this.profile.startTrust : undefined;
    const trusted = !view.required || (!this.withholdTrust && (override ? override === "approve" : view.choice === "trusted" || (view.choice === "unknown" && view.policy === "always")));
    return { cwd: root, projectTrusted: trusted };
  }
  /** Resolves the theme pi would use here and makes it what the session snapshot carries. Never fails the caller. */
  private async refreshPiTheme(fresh = true): Promise<{ catalog: Catalog; pi: PiThemeView } | undefined> {
    try {
      const scope = await this.settingsScope();
      const catalog = await this.themes.load(scope.cwd, scope.projectTrusted, fresh);
      const { setting, source } = this.settings.themeSetting(scope);
      const resolved = this.themes.resolvePi(catalog, setting, source);
      this.piTheme = resolved.theme; this.piThemeView = resolved.view;
      return { catalog, pi: resolved.view };
    } catch (error) {
      this.log(`Themes could not be read: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }
  private async themesView(): Promise<ThemesView> {
    const loaded = await this.refreshPiTheme();
    if (!loaded) throw new ProtocolError("themes_unavailable", "The theme list could not be read.");
    return { themes: this.themes.items(loaded.catalog), problems: loaded.catalog.problems, truncated: loaded.catalog.truncated, pi: loaded.pi, projectThemes: loaded.catalog.projectThemes };
  }
  private async themeView(name: string): Promise<ThemeView> {
    const scope = await this.settingsScope();
    const entry = (await this.themes.load(scope.cwd, scope.projectTrusted, false)).entries.get(name);
    if (!entry) throw new ProtocolError("theme_missing", "This theme is not available in the current project.");
    return { name: entry.name, appearance: entry.theme.appearance, vars: entry.vars };
  }
  /** The lists a setting is chosen from, and what the running session reports. Read fresh for every view and save. */
  private async settingChoices(scope: SettingsScope): Promise<{ choices: SettingChoices; live: boolean }> {
    const live = this.phase === "ready" && !!this.child?.running && !this.stopping;
    const [models, state, catalog] = await Promise.all([
      live ? this.child!.request<{ models: Array<{ provider: string; id: string }> }>("get_available_models").then(result => result.models.map(model => `${model.provider}/${model.id}`), () => undefined) : undefined,
      live ? this.child!.request<SettingChoices["runtime"]>("get_state").catch(() => undefined) : undefined,
      this.themes.load(scope.cwd, scope.projectTrusted, false).catch(() => undefined),
    ]);
    const themes = catalog ? ["system", ...this.themes.items(catalog).filter(item => item.global).map(item => item.name)] : ["system"];
    return { live, choices: { themes, ...(models ? { models } : {}), ...(state ? { runtime: { steeringMode: state.steeringMode, followUpMode: state.followUpMode, autoCompactionEnabled: state.autoCompactionEnabled } } : {}) } };
  }
  private async settingsView(): Promise<SettingsView> {
    const scope = await this.settingsScope(), { choices, live } = await this.settingChoices(scope);
    return { ...this.settings.view(scope, choices, live), pendingApply: this.pendingApply, ...(this.applyError ? { applyError: this.applyError } : {}) };
  }
  /**
   * Saves one setting. Serialized with every other host write, so two pages changing the same
   * setting are decided one after the other: the second is told the value it saw is stale.
   * Settings pi changes through RPC also change the running session, so they wait for it to be idle.
   */
  private setSetting(key: SettingKey, value: SettingValue, expected: SettingValue): Promise<SettingResult> {
    if (this.queuedWrites >= 32) return Promise.reject(new ProtocolError("busy", "Too many host commands are waiting; let them settle before retrying."));
    this.queuedWrites++;
    const result = this.writes.then(async () => {
      if (this.control) await this.control;
      if (this.stopping) throw new ProtocolError("host_stopped", "The service is stopping.");
      const scope = await this.settingsScope(), { choices, live } = await this.settingChoices(scope);
      const viaRuntime = this.settings.viaRuntime(key);
      if (viaRuntime) {
        this.assertLive(); await this.mirror!.synchronize();
        if (this.dialogs.size || !this.mirror!.idle) throw new ProtocolError("busy", "Wait until replies, queued messages and dialogs have settled.");
      }
      const outcome = await this.settings.set(scope, key, value, expected, choices, live ? this.child : undefined);
      if (viaRuntime) { await this.mirror?.synchronize().catch(() => undefined); this.bridge?.refreshState(); }
      if (key === "theme") await this.refreshPiTheme();
      if (outcome.applied === "pending" && live) { this.pendingApply = true; this.applyError = undefined; }
      return outcome;
    }).finally(() => { this.queuedWrites--; this.touch(); });
    this.writes = result.catch(() => undefined);
    // Outside the queue: applying takes its own turn in it.
    void result.then(outcome => { if (outcome.applied === "pending") void this.applyCredentials(false).catch(() => undefined); }, () => undefined);
    return result;
  }
  async hostQuery<A extends HostQueryAction>(action: A, args: Record<string, unknown> = {}, _leaseId = ""): Promise<HostQueryValues[A]> {
    if (this.stopping) throw new ProtocolError("host_stopped", "The service is stopping.");
    let value: HostQueryValues[HostQueryAction];
    if (action === "accounts") value = await this.accountsView();
    else if (action === "themes") value = await this.themesView();
    else if (action === "theme") value = await this.themeView(String(args.name));
    else if (action === "settings") value = await this.settingsView();
    else if (action === "providers") value = await this.providersView();
    else if (action === "session_inspect") value = await this.inspectSession(String(args.sessionId));
    else if (action === "export_page") value = await this.exportPage(String(args.exportId), Number(args.offset));
    else if (action === "directories") value = await this.projects.directories(typeof args.path === "string" ? args.path : this.runtimeCwd);
    else if (action === "project_inspect") value = await this.inspectProject(await this.projects.root(String(args.path)));
    else value = await this.projectsView();
    return value as HostQueryValues[A];
  }
  /** Saved sessions of the default session directory and of every directory this host has used. */
  private async catalog(signal: AbortSignal) {
    const listAll = this.dependencies.listAll ?? SessionManager.listAll;
    const catalogs = await Promise.all([listAll(undefined, signal), ...this.directories.map(directory => listAll(directory, undefined, signal))]);
    const unique = new Map<string, (typeof catalogs)[number][number]>();
    for (const session of catalogs.flat()) { const old = unique.get(session.id); if (!old || old.modified.getTime() < session.modified.getTime()) unique.set(session.id, session); }
    return [...unique.values()];
  }
  /** Saved sessions per project, keyed by real path where the directory still exists. */
  private async sessionCounts(): Promise<Map<string, number> | undefined> {
    const sessions = await this.catalog(AbortSignal.timeout(8000)).catch(() => undefined);
    if (!sessions) return undefined;
    const real = new Map<string, string>(), counts = new Map<string, number>();
    for (const session of sessions) {
      if (!real.has(session.cwd)) real.set(session.cwd, await canonical(session.cwd));
      const path = real.get(session.cwd)!; counts.set(path, (counts.get(path) ?? 0) + 1);
    }
    return counts;
  }
  /**
   * The user's choice and what was actually loaded are separate facts: RPC reports no trust result, and
   * a global extension can veto a recorded choice. `loaded` counts project-scoped commands when it can.
   */
  private async trustView(root: string, current: boolean): Promise<ProjectTrustView> {
    const view = this.projects.trust(root);
    const override = this.profile.startTrust && await samePath(root, this.profile.startCwd) ? this.profile.startTrust : undefined;
    let loaded: number | undefined;
    if (current && this.phase === "ready" && this.child?.running) loaded = await this.child.request<{ commands: Array<{ sourceInfo?: { scope?: string } }> }>("get_commands")
      .then(result => result.commands.filter(command => command.sourceInfo?.scope === "project").length, () => undefined);
    return { ...view, ask: view.ask && !override, ...(override ? { override } : {}), ...(current && this.withholdTrust ? { withheld: true } : {}), ...(loaded !== undefined ? { loaded } : {}) };
  }
  private async inspectProject(root: string): Promise<ProjectInspectView> {
    const current = await samePath(root, this.runtimeCwd);
    const [counts, registered] = await Promise.all([this.sessionCounts(), this.registry.list().then(list => list.some(project => project.path === root), () => false)]);
    return { path: root, name: this.projects.name(root), current, registered, sessions: counts?.get(root) ?? 0, trust: await this.trustView(root, current) };
  }
  private async projectsView(): Promise<ProjectsView> {
    const counts = await this.sessionCounts();
    const history = [...(counts?.keys() ?? [])];
    let views: ProjectView[], registryError: string | undefined;
    try { views = await this.registry.view(history); }
    catch (error) {
      // An unreadable list is never replaced. Projects known from saved sessions are still shown.
      if (!(error instanceof ProjectRegistryError)) throw error;
      registryError = error.message;
      views = await Promise.all(history.map(async path => ({ path, name: this.projects.name(path), source: "history" as const, available: await stat(path).then(info => info.isDirectory(), () => false) })));
    }
    const current = await canonical(this.runtimeCwd);
    const items: ProjectItem[] = views.map(view => ({ path: view.path, name: view.name, source: view.source, available: view.available, current: view.path === current,
      sessions: counts?.get(view.path) ?? 0, ...(view.lastOpenedAt ? { lastOpenedAt: view.lastOpenedAt } : {}) }));
    // The running project is always listed, even when it was removed from the list or has no saved session.
    if (!items.some(item => item.current)) items.unshift({ path: current, name: this.projects.name(current), source: "current", available: true, current: true, sessions: counts?.get(current) ?? 0 });
    const retained = [...items.filter(item => item.current), ...items.filter(item => !item.current)].slice(0, 200);
    return { projects: retained.map(item => ({ ...item, name: clip(item.name, 256) })), truncated: retained.length < items.length,
      current: { path: current, name: this.projects.name(current), trust: await this.trustView(current, true) },
      ...(registryError ? { registryError: clip(registryError, 1000) } : {}), ...(counts ? {} : { historyIncomplete: true }) };
  }
  /** The project list is a convenience: a failure to update it is reported in the terminal and never blocks a session. */
  private async note(change: () => Promise<unknown>): Promise<void> {
    try { await change(); } catch (error) { this.log(`The project list was not updated: ${error instanceof Error ? error.message : String(error)}`); }
  }
  /** Remembers the saved session a project is being left on, so opening the project again returns to it. */
  private async rememberSession(register: boolean): Promise<void> {
    const file = this.lastSessionFile, id = this.mirror?.sessionId;
    if (!id || !existsSync(file)) return;
    await this.note(async () => {
      const path = await canonical(this.runtimeCwd);
      const entry = register ? await this.registry.open(path) : (await this.registry.list()).find(project => project.path === path);
      if (entry) await this.registry.setLastSession(entry.id, { id, file });
    });
  }
  /**
   * Opens `root` (a validated real path) as the current project. A different project always gets its
   * own child. Trust is never widened here: the only flag this host generates is --no-approve.
   */
  private async openProject(root: string, options: { trust?: "remember" | "withhold"; sessionFile?: string; asked?: boolean } = {}): Promise<{ path: string; unchanged?: true }> {
    const current = await samePath(root, this.runtimeCwd);
    // A session picked from the catalog was not a trust decision: unanswered, the child simply does not load project resources.
    if (options.asked !== false && !options.trust && (await this.trustView(root, false)).ask)
      throw new ProtocolError("trust_required", "Choose whether to trust this project before opening it.");
    if (options.trust === "remember") this.projects.remember(root);
    const withholdTrust = options.trust === "withhold";
    if (current) {
      await this.note(() => this.registry.open(root));
      if (!options.trust && !this.withholdTrust) return { path: root, unchanged: true };
      // The same project with a new trust answer: only a restart applies it.
      await this.replaceRuntime({ cwd: this.runtimeCwd, ...(existsSync(this.lastSessionFile) ? { sessionFile: this.lastSessionFile } : {}), ...(withholdTrust ? { withholdTrust } : {}) }, "resume");
      return { path: root };
    }
    let sessionFile = options.sessionFile;
    if (!sessionFile) {
      const last = (await this.registry.list().catch(() => [])).find(project => project.path === root)?.lastSession?.file;
      if (last && existsSync(last) && await samePath(await sessionCwd(last, ""), root)) sessionFile = last;
    }
    // Listed before the switch: an opened project stays in the list even when its runtime then fails to start.
    if (options.asked !== false) await this.note(() => this.registry.open(root));
    await this.rememberSession(options.asked !== false);
    await this.replaceRuntime({ cwd: root, ...(sessionFile ? { sessionFile } : {}), ...(withholdTrust ? { withholdTrust } : {}) }, sessionFile ? "resume" : "new");
    return { path: root };
  }
  private projectCommand(name: HostCommandName, args: Record<string, unknown>, revision: number): Promise<unknown> {
    const switches = name === "project_open" || name === "project_create";
    if (switches && this.dialogs.size) return Promise.reject(new ProtocolError("busy", "Answer or cancel the current extension dialog before switching projects."));
    if (switches && this.mirror && !this.mirror.idle) return Promise.reject(new ProtocolError("busy", "Wait until replies, compaction and queued messages have settled before switching projects."));
    if (this.queuedWrites >= 32) return Promise.reject(new ProtocolError("busy", "Too many host commands are waiting; let them settle before retrying."));
    this.queuedWrites++;
    const result = this.writes.then(async () => {
      if (this.control) await this.control;
      // Two viewers acting on the same page state: the first one changes it, the second is told to look again.
      if (revision !== this.hostRevision) throw new ProtocolError("stale_host", "The host state changed; check the page before trying again.");
      if (this.stopping) throw new ProtocolError("host_stopped", "The service is stopping.");
      if (name === "project_remove") {
        const path = await canonical(String(args.path));
        if (await samePath(path, this.runtimeCwd)) throw new ProtocolError("project_current", "Switch to another project before removing this one from the list.");
        await this.registry.remove(path); this.touch(); return { path };
      }
      if (name === "project_relocate") {
        const entry = await this.registry.relocate(String(args.from), await this.projects.root(String(args.to)));
        this.touch(); return { path: entry.path };
      }
      this.assertLive(); await this.mirror!.synchronize();
      if (!this.mirror!.idle) throw new ProtocolError("busy", "Wait until replies and queued messages have settled.");
      try {
        if (name === "project_create") {
          const root = await this.projects.create(String(args.parent), String(args.name));
          await this.note(() => this.registry.open(root, "created"));
          // From here the folder and its list entry stay, whatever happens to the runtime.
          await this.rememberSession(true); await this.replaceRuntime({ cwd: root }, "new");
          return { path: root };
        }
        return await this.openProject(await this.projects.root(String(args.path)), { ...(args.trust === "remember" || args.trust === "withhold" ? { trust: args.trust } : {}) });
      } finally { this.touch(); }
    }).finally(() => { this.queuedWrites--; });
    this.writes = result.catch(() => undefined); return result;
  }
  /** The project list changed without a phase change: viewers re-read it on the next host revision. */
  private touch(): void { if (!this.stopping) { this.hostRevision++; this.hub.publishHostState(); } }
  private setPhase(phase: HostPhase): void { this.phase = phase; this.hostRevision++; this.hub.publishHostState(); }
  private async hold(path: string): Promise<SessionFileLock> { const lock = await SessionFileLock.acquire(path); this.locks.add(lock); return lock; }
  private async drop(lock: SessionFileLock | undefined): Promise<void> { if (lock) { this.locks.delete(lock); await lock.release(); } }
  async start(): Promise<void> {
    if (this.stopping) throw new Error("The handoff host is stopping.");
    const file = this.target.sessionFile;
    const lock = this.target.lock ?? await SessionFileLock.acquire(file);
    this.locks.add(lock); this.lock = lock;
    try {
      // A TUI session that has not been written yet keeps its path and the start model, as before.
      await this.launch({ cwd: this.target.cwd, session: { file, saved: existsSync(file) } }, "handoff", lock);
      await this.reportModelChange(this.target.model, "before the handoff", "交接前");
      this.setPhase("ready");
    }
    catch (error) { await this.stop(); throw error; }
  }
  /**
   * Starts a child at `target` and makes it the active runtime once its state, snapshot and lock
   * are valid. Until then it is only a candidate: a failure stops it and leaves `this.lock` as it was.
   * Without `lock` the child creates a new session; its path is locked as soon as it is known,
   * before any message can be written.
   */
  private async launch(target: LaunchTarget, reason: string, lock: SessionFileLock | undefined): Promise<void> {
    const stopped = (): void => { if (this.stopping) throw new Error("The handoff host stopped before child startup."); };
    const args = this.profile.args(target);
    stopped(); await lock?.assertUnchanged(); stopped();
    const child = this.dependencies.createChild?.(args, target.cwd) ?? new RpcChild(args, target.cwd);
    const unsubscribe = child.onRecord(record => this.record(child, record));
    const previous = { lock: this.lock, cwd: this.runtimeCwd, active: this.activeCwd, withhold: this.withholdTrust };
    let created: SessionFileLock | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      child.start();
      this.child = child; this.unsubscribe = unsubscribe;
      void child.exited.then(code => this.childExit(child, code));
      // The writer PID is durable before the gate opens; nothing may have touched the file meanwhile.
      if (lock && child.pid) { await lock.setWriterPid(child.pid); await lock.assertUnchanged(); }
      stopped();
      child.activate?.();
      this.hub.setHostHandler(this);
      await Promise.race([(async () => {
        if (lock) { if (reason !== "handoff") {
          const state = await child.request<{ sessionFile?: string }>("get_state", {}, 10_000);
          if (!state.sessionFile || !(await lock.matchesPath(state.sessionFile))) throw new Error("The RPC child did not open the requested session.");
        } } else {
          const state = await child.request<{ sessionFile?: string }>("get_state", {}, 10_000);
          if (!state.sessionFile) throw new Error("The new RPC session has no session path.");
          created = await this.hold(state.sessionFile);
          if (child.pid) await created.setWriterPid(child.pid);
        }
        this.lock = lock ?? created; this.runtimeCwd = this.activeCwd = target.cwd; this.withholdTrust = !!target.withholdTrust;
        await this.rebind(reason);
      })(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("RPC handoff startup timed out.")), 10_000); timer.unref?.(); })]);
      stopped();
      this.readyChild = child;
      // A newly started child read pi's credentials itself.
      this.pendingApply = false; this.applyError = undefined;
      if (!child.running) this.childExit(child, null);
    } catch (error) {
      unsubscribe(); this.mirror?.dispose(); this.bridge?.dispose(); this.mirror = undefined; this.bridge = undefined; this.workspace = undefined;
      if (this.child === child) { this.child = undefined; this.unsubscribe = undefined; }
      this.lock = previous.lock; this.runtimeCwd = previous.cwd; this.withholdTrust = previous.withhold;
      if (reason !== "handoff") this.activeCwd = previous.active;
      await child.stop(); await this.drop(created);
      throw error;
    } finally { if (timer) clearTimeout(timer); }
  }
  private async currentModel(): Promise<ModelRef | undefined> {
    const state = await this.child?.request<{ model?: ModelRef }>("get_state").catch(() => undefined);
    return state?.model ? { provider: state.model.provider, id: state.model.id } : undefined;
  }
  /** A restarted runtime takes the model its transcript records. Say so when that differs from what was in use. */
  private async reportModelChange(expected: ModelRef | undefined, when: string, label: string): Promise<void> {
    const actual = expected && await this.currentModel();
    if (!expected || !actual || (actual.provider === expected.provider && actual.id === expected.id)) return;
    this.log(`Model is now ${actual.provider}/${actual.id}; ${when} it was ${expected.provider}/${expected.id}. The session's recorded model takes precedence.`);
    this.hub.notifyAll({ t: "notice", message: `当前模型是 ${actual.provider}/${actual.id}，${label}是 ${expected.provider}/${expected.id}。已按会话记录恢复，需要时请重新选择。` });
  }
  private record(child: RpcConnection, record: RpcRecord): void {
    if (child === this.retiring) {
      // stdin is closed: the child can never receive an answer, and pi then exits 0 without finishing its handlers.
      if (record.type === "extension_ui_request" && DIALOG_METHODS.includes(String(record.method))) this.shutdownDialog = true;
      return;
    }
    if (child !== this.child) return;
    if (record.type === "extension_ui_request") this.dialog(record);
    // pi RPC does not emit a separate dialog-cancel event for AbortSignal. Once the
    // agent has settled, orphaned model/tool dialogs cannot still be awaiting a result.
    if (record.type === "agent_settled") for (const id of this.dialogs.keys()) if (!this.dialogOwners.has(id)) this.resolveDialog(id, "cancelled", true);
  }
  private childExit(child: RpcConnection, code: number | null): void {
    if (child === this.readyChild && child !== this.retiring) this.end({ exit: code, planned: false });
  }
  private rememberDirectory(path: string): void { this.directories = [...this.directories.filter(value => value !== path), path].slice(-32); }
  /**
   * Accepts transcript growth that is the child's own (extensions may persist entries at any time,
   * e.g. after an asynchronous agent_end handler) and stops the child on anything else.
   * Serialized: refreshes and commands can ask at the same time.
   */
  private verifyOwnedChanges(): Promise<void> {
    const run = async () => {
      if (this.stopping || !this.lock) return;
      try { await this.lock.verifyAppends(since => this.childEntries(since)); }
      catch (error) {
        // No ownership decision or dependent write was made. Keep the baseline and child
        // intact so a later command can retry the read and check the same pending appends.
        if (error instanceof RpcReadTimeoutError) throw error;
        this.log((error as { code?: string }).code === "session_conflict"
          ? "Session ownership conflict detected; stopping the RPC child without restarting it."
          : "Session ownership disappeared; stopping the sole RPC writer.");
        await this.stop(); throw error;
      }
    };
    const result = this.verifying.then(run, run);
    this.verifying = result.catch(() => undefined);
    return result;
  }
  /** The child's entries after `since` (all of them when the ID is unknown to it). */
  private async childEntries(since?: string): Promise<KnownEntry[]> {
    const request = (payload: Record<string, unknown>) => this.child!.request<{ entries: KnownEntry[] }>("get_entries", payload);
    const result = since ? await request({ since }).catch(error => {
      if (error instanceof RpcReadTimeoutError) throw error;
      return request({});
    }) : await request({});
    return result.entries;
  }
  private async rebind(reason: string): Promise<void> {
    this.mirror?.dispose(); this.bridge?.dispose();
    const generation = ++this.generation;
    const state = await this.child!.request<{ sessionFile?: string }>("get_state", {}, 10_000);
    this.lastSessionFile = state.sessionFile ?? this.lastSessionFile;
    // RPC get_state has no cwd. A saved session states its own; an unsaved one is where its child was started.
    const cwd = await sessionCwd(state.sessionFile, this.runtimeCwd);
    if (reason === "handoff") this.runtimeCwd = cwd; // the TUI's session defines the start project
    this.activeCwd = cwd;
    if (!(await samePath(cwd, this.runtimeCwd))) throw new ProtocolError("project_mismatch",
      `The RPC child moved to a session of another project (${cwd}) while running in ${this.runtimeCwd}. Its tools, trust and project resources still belong to the old project.`);
    if (state.sessionFile) this.rememberDirectory(dirname(state.sessionFile));
    // The snapshot carries the theme pi would use in this project; the handoff theme stands in when that cannot be resolved.
    await this.refreshPiTheme();
    const mirror = new RpcSessionMirror(this.child!, this.activeCwd, () => this.piTheme as ExtensionContext["ui"]["theme"], () => this.target.themes, () => {}, () => this.verifyOwnedChanges());
    try { await mirror.load(); } catch (error) { mirror.dispose(); throw error; }
    if (this.stopping) { mirror.dispose(); throw new Error("The handoff host stopped during startup."); }
    const bridge = new Bridge({ pi: mirror.api(), ctx: mirror.context(), generation, isCurrent: () => this.generation === generation && !this.stopping });
    mirror.attach(bridge); this.mirror = mirror; this.bridge = bridge; this.workspace = new WorkspaceService(this.activeCwd);
    // The launched runtime legitimately persists initial model/system/session updates.
    // Establish its acknowledged startup baseline before exposing the first snapshot.
    // The same holds for every newly started child. Between the gate check and this point only it could write.
    if (this.child !== this.readyChild) await this.lock!.acceptChanges();
    this.hub.bindBridge(bridge, reason);
    if (reason !== "handoff") this.log(`Current workspace: ${this.activeCwd}\nSession: ${this.lastSessionFile}`);
  }
  private assertLive(expected?: Expected): void {
    if (this.phase === "recovery_required") throw new ProtocolError("recovery_required", "The last project switch failed. Retry it, restore the previous session, or stop the service.");
    if (this.phase === "replacing") throw new ProtocolError("busy", "The session runtime is being replaced; wait for the new session.");
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
      const list = this.dependencies.list ?? SessionManager.list;
      const found = args.scope === "all" ? await this.catalog(signal) : await list(this.cwd, dirname(this.sessionFile), undefined, signal);
      const query = typeof args.query === "string" ? args.query.trim().toLocaleLowerCase() : "";
      const filtered = found.filter(session => !query || [session.name, session.cwd, session.firstMessage, session.allMessagesText].some(text => text?.toLocaleLowerCase().includes(query)))
        .sort((a, b) => b.modified.getTime() - a.modified.getTime());
      const retained = filtered.slice(0, 200);
      for (const session of retained) {
        this.paths.set(session.id, session.path);
        this.listed.set(session.id, { cwd: session.cwd, ...(session.name ? { name: clip(session.name, 256) } : {}), messageCount: session.messageCount, modified: session.modified.toISOString() });
      }
      while (this.paths.size > 1000) { const oldest = this.paths.keys().next().value!; this.paths.delete(oldest); this.listed.delete(oldest); }
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
          { name: "authentication", available: true, detail: "在“设置”的“账户”里用 API key 登录或退出，在“自定义供应商”里接入兼容接口的服务；订阅登录仍在终端完成。" }, { name: "settings", available: true, detail: "在“设置”里选择网页外观、保存 pi 的默认主题与默认模型、调整会话行为；其余设置只读并说明原因。" },
          { name: "resource-management", available: false, detail: "安装和配置扩展仍在终端完成。" }] };
    } else if (action === "tree") {
      await this.mirror!.synchronize(); const entries = this.mirror!.getEntries().filter(entry => !isRecord(entry.message) || entry.message.role !== "system" || visibleText(entry.message.content).trim()); const retained = entries.slice(-2000);
      value = { entries: retained.map(entry => { const message = isRecord(entry.message) ? entry.message : undefined;
        return { id: entry.id, parentId: entry.parentId, type: entry.type, ...(message && typeof message.role === "string" ? { role: message.role } : {}),
          preview: clip(visibleText(message?.content ?? entry.summary ?? entry.content ?? entry.type), 256), ...(typeof entry.timestamp === "string" ? { timestamp: entry.timestamp } : {}), current: entry.id === this.mirror!.getLeafId() };
      }), leafId: this.mirror!.getLeafId(), truncated: retained.length !== entries.length };
    } else if (action === "files") value = await this.workspace!.files(args.query as string | undefined);
    else if (action === "file") value = await this.workspace!.file(args.path as string);
    else if (action === "git_status") value = await this.workspace!.gitStatus();
    else if (action === "session_stats") {
      const stats = await this.child!.request<{ sessionId: string; sessionFile?: string; userMessages: number; assistantMessages: number; toolCalls: number; toolResults: number; totalMessages: number;
        tokens: SessionStatsView["tokens"]; cost: number; contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null } }>("get_session_stats");
      const count = (number: unknown): number => typeof number === "number" && Number.isFinite(number) ? number : 0;
      value = { sessionId: this.mirror!.sessionId, ...(stats.sessionFile ? { sessionFile: clip(stats.sessionFile, 4096) } : {}), ...(this.mirror!.sessionName ? { name: clip(this.mirror!.sessionName, 256) } : {}), cwd: this.cwd,
        userMessages: count(stats.userMessages), assistantMessages: count(stats.assistantMessages), toolCalls: count(stats.toolCalls), toolResults: count(stats.toolResults), totalMessages: count(stats.totalMessages),
        tokens: { input: count(stats.tokens?.input), output: count(stats.tokens?.output), cacheRead: count(stats.tokens?.cacheRead), cacheWrite: count(stats.tokens?.cacheWrite), total: count(stats.tokens?.total) }, cost: count(stats.cost),
        ...(stats.contextUsage && count(stats.contextUsage.contextWindow) > 0 ? { context: { tokens: typeof stats.contextUsage.tokens === "number" ? stats.contextUsage.tokens : null, window: stats.contextUsage.contextWindow,
          percent: typeof stats.contextUsage.percent === "number" ? stats.contextUsage.percent : null } } : {}) };
    } else if (action === "assistant_text") {
      let text: string;
      if (typeof args.entryId !== "string") text = (await this.child!.request<{ text?: string }>("get_last_assistant_text")).text ?? "";
      else {
        await this.mirror!.synchronize();
        const message = this.mirror!.getEntries().find(entry => entry.id === args.entryId)?.message;
        if (!isRecord(message) || message.role !== "assistant") throw new ProtocolError("unknown_message", "This is not an assistant reply of the current session.");
        // The same text pi's /copy gives: the reply's text blocks, without thinking or tool calls.
        text = (Array.isArray(message.content) ? message.content.filter(isRecord).map(block => block.type === "text" && typeof block.text === "string" ? block.text : "").join("") : typeof message.content === "string" ? message.content : "").trim();
      }
      const limit = 4 * 1024 * 1024;
      value = { text: text.length > limit ? text.slice(0, limit) : text, truncated: text.length > limit };
    }
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
    await this.refreshAfterWrite();
    return value;
  }
  private async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    const child = this.child!; await this.mirror!.synchronize();
    if (name !== "prompt" && name !== "abort" && name !== "run_command" && !this.mirror!.idle) throw new ProtocolError("busy", "Wait until replies and queued messages have settled.");
    // Before every write: the transcript may only have grown by the child's own entries.
    await this.verifyOwnedChanges();
    if (name === "session_tree") throw new ProtocolError("upstream_required", "pi RPC does not support tree navigation.");
    if (SESSION_WRITES.has(name)) {
      let nextLock: SessionFileLock | undefined;
      if (name === "session_switch") {
        const path = typeof args.sessionId === "string" ? this.paths.get(args.sessionId) : undefined;
        if (!path) throw new ProtocolError("unknown_session", "Refresh the catalog and choose an exposed session ID.");
        if (args.sessionId === this.mirror!.sessionId) return { cancelled: false, unchanged: true, sessionId: this.mirror!.sessionId };
        // A session of another project needs a child started there: a native switch would keep this
        // child's process cwd, trust decision and project resources.
        const cwd = await sessionCwd(path, this.runtimeCwd);
        if (!(await samePath(cwd, this.runtimeCwd))) {
          await this.openProject(await this.projects.root(cwd), { sessionFile: path, asked: false });
          return { cancelled: false, sessionId: this.mirror!.sessionId, branchRevision: this.bridge!.branchRevision };
        }
        nextLock = await this.hold(path);
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
        nextLock ??= await this.hold(state.sessionFile);
        if (child.pid) await nextLock.setWriterPid(child.pid);
        const previousLock = this.lock; this.lock = nextLock; nextLock = undefined;
        await this.lock.acceptChanges(); await this.drop(previousLock); await this.rebind(name === "session_new" ? "new" : "resume");
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
      } finally { this.sessionChangePending = false; await this.drop(nextLock); }
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
      await this.refreshAfterWrite(); return { disposition: result.disposition };
    }
    let value: unknown;
    if (name === "abort") value = await child.request("abort");
    else if (name === "set_model") value = await child.request("set_model", { provider: args.provider, modelId: args.id });
    else if (name === "set_thinking") { const available = await child.request<{ levels: string[] }>("get_available_thinking_levels");
      if (!available.levels.includes(String(args.level))) throw new ProtocolError("unsupported_thinking", "This model does not support that thinking level."); value = await child.request("set_thinking_level", { level: args.level });
    } else if (name === "compact") value = await child.request("compact");
    else if (name === "session_rename") value = await child.request("set_session_name", { name: args.name });
    else throw new ProtocolError("unknown_command", "Unknown handoff command.");
    await this.refreshAfterWrite();
    return name === "session_rename" ? { name: this.mirror!.sessionName, sessionId: this.mirror!.sessionId } : value;
  }
  /** Registered RPC extension commands can replace sessions through their public command context. */
  private async refreshAfterWrite(): Promise<void> {
    const state = await this.child!.request<{ sessionFile?: string; sessionId?: string }>("get_state");
    const sameSession = state.sessionId === this.mirror!.sessionId && !!state.sessionFile
      && await this.lock?.matchesPath(state.sessionFile).catch(() => false);
    if (state.sessionFile && !sameSession) {
      this.lastSessionFile = state.sessionFile;
      let nextLock: SessionFileLock | undefined;
      try {
        nextLock = await this.hold(state.sessionFile);
        if (this.child!.pid) await nextLock.setWriterPid(this.child!.pid!);
        const previousLock = this.lock; this.lock = nextLock; nextLock = undefined;
        await this.lock.acceptChanges(); await this.drop(previousLock);
        this.clearDialogs("session_changed", true);
        // rebind refuses a session of another project: the child switched itself, so fail closed.
        await this.rebind("resume");
      } catch (error) {
        if ((error as { code?: string }).code === "project_mismatch") this.log(`${(error as Error).message}\nStopping the service; continue that session from its own directory.`);
        await this.stop(); throw error;
      }
      finally { await this.drop(nextLock); }
    } else { if (state.sessionFile) this.lastSessionFile = state.sessionFile; await this.mirror!.synchronize(); }
    await this.verifyOwnedChanges();
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
  /**
   * Planned replacement of the RPC child (docs/m3.1-plan.md §8). Runs inside the write queue.
   * Nothing is disturbed until the target is validated and lockable; after the old child has been
   * asked to stop, every failure ends in `recovery_required` or, where no safe state exists, a stop.
   */
  private async replaceRuntime(next: RuntimeTarget, reason: string): Promise<void> {
    const directory = await stat(next.cwd).catch(() => undefined);
    if (!directory?.isDirectory()) throw new ProtocolError("project_unavailable", `The project directory ${next.cwd} is missing or not a directory.`);
    const oldLock = this.lock!;
    const previous: RuntimeTarget = { cwd: this.runtimeCwd, ...(existsSync(this.lastSessionFile) ? { sessionFile: this.lastSessionFile } : {}), ...(this.withholdTrust ? { withholdTrust: true } : {}) };
    if (next.sessionFile && !existsSync(next.sessionFile)) throw new ProtocolError("unknown_session", "That session has no saved transcript; open the project and start a new session instead.");
    const sameFile = !!next.sessionFile && await oldLock.matchesPath(next.sessionFile);
    let targetLock = sameFile ? oldLock : next.sessionFile ? await this.hold(next.sessionFile) : undefined;
    try {
      // The last moment the old child can vouch for its own writes and for being idle.
      await this.mirror!.synchronize();
      if (!this.mirror!.idle) throw new ProtocolError("busy", "Wait until replies and queued messages have settled.");
      await this.verifyOwnedChanges();
      this.previousModel = await this.currentModel();
    } catch (error) { if (!sameFile) await this.drop(targetLock); throw error; }
    this.setPhase("replacing"); this.sessionChangePending = true;
    try {
      this.hub.suspendBridge("replacing");
      this.ui = { revision: this.ui.revision + 1, statuses: {}, widgets: {} }; this.publishUi();
      const stop = await this.retire();
      let conflict: Error | undefined;
      try { const accepted = await oldLock.acceptShutdownAppends(); if (accepted) this.log(`Accepted ${accepted} transcript entries written while the previous session runtime shut down (ownership cannot be verified).`); }
      catch (error) { conflict = error as Error; }
      if (this.stopping) throw new Error("The handoff host stopped during a runtime replacement.");
      if (stop || conflict) {
        const message = conflict?.message ?? stop!;
        if (!sameFile) await this.drop(targetLock);
        targetLock = undefined;
        // The same transcript would be reopened on top of an unverified ending: there is no safe state.
        if (sameFile) { this.log(`${message}\nStopping the service.`); void this.stop(); this.end({ exit: null, planned: false }); throw new ProtocolError("host_stopped", message); }
        this.fail(conflict ? "shutdown_conflict" : "stop_incomplete", message, next, previous, !conflict);
      }
      try { await this.launch({ cwd: next.cwd, ...(next.sessionFile ? { session: { file: next.sessionFile, saved: true } } : {}), ...(next.withholdTrust ? { withholdTrust: true } : {}) }, reason, targetLock); }
      catch (error) {
        if (this.stopping) throw error;
        if (!sameFile) await this.drop(targetLock);
        this.fail("start_failed", `The session runtime did not start in ${next.cwd}: ${error instanceof Error ? error.message : String(error)}`, next, previous, true);
      }
      if (this.lock !== oldLock) await this.drop(oldLock);
      if (sameFile) await this.reportModelChange(this.previousModel, "before the restart", "重启前");
      this.setPhase("ready");
    } finally { this.sessionChangePending = false; }
  }
  /**
   * Asks the active child to stop and waits for its exit. Returns why the stop cannot be trusted, if so.
   * pi RPC has no shutdown command: only closing stdin, after which the child cannot be answered.
   */
  private async retire(): Promise<string | undefined> {
    const child = this.child!;
    this.clearDialogs("session_changed", true); this.mirror?.dispose(); this.bridge?.dispose();
    this.mirror = undefined; this.bridge = undefined; this.workspace = undefined;
    this.retiring = child; this.shutdownDialog = false;
    const outcome = await child.stop({ graceMs: this.dependencies.plannedStopMs ?? PLANNED_STOP_MS }) ?? { code: 0, forced: false };
    this.unsubscribe?.(); this.unsubscribe = undefined; this.child = undefined; this.readyChild = undefined; this.retiring = undefined;
    if (this.shutdownDialog) return "An extension opened a dialog while the session runtime was shutting down. It cannot be answered there, so its shutdown work was cut short. Switch projects from the terminal while that extension is installed.";
    if (outcome.forced) return "The previous session runtime did not finish shutting down in time and had to be terminated.";
    if (outcome.code !== 0) return `The previous session runtime exited with code ${String(outcome.code)} while shutting down.`;
    return undefined;
  }
  private fail(reason: RecoveryReason, message: string, target: RuntimeTarget, previous: RuntimeTarget, canRestore: boolean): never {
    this.recovery = { reason, message, target, previous, canRestore };
    this.setPhase("recovery_required");
    this.log(`${message}\nThe browser offers: retry, restore the previous session, or stop. Nothing restarts on its own.`);
    throw new ProtocolError("recovery_required", message);
  }
  /**
   * The user's one explicit way out of `recovery_required`; each call is a single bounded attempt.
   * Restoring reuses the retained lock and its baseline: the old transcript must be exactly as verified.
   */
  recover(action: "retry" | "restore" | "stop"): Promise<HostStatus> {
    const result = this.writes.then(async () => {
      const recovery = this.recovery;
      if (this.stopping || this.phase !== "recovery_required" || !recovery) throw new ProtocolError("no_recovery", "There is no failed switch to recover from.");
      if (action === "stop") { this.end({ exit: 0, planned: true }); return this.status(); }
      if (action === "restore" && !recovery.canRestore) throw new ProtocolError("restore_unavailable", "The previous session cannot be restored safely here; stop the service and inspect it in a terminal.");
      const chosen = action === "retry" ? recovery.target : recovery.previous;
      const oldLock = this.lock;
      const keep = !!chosen.sessionFile && !!oldLock && await oldLock.matchesPath(chosen.sessionFile);
      const lock = keep ? oldLock : chosen.sessionFile ? await this.hold(chosen.sessionFile) : undefined;
      this.setPhase("replacing");
      try { await this.launch({ cwd: chosen.cwd, ...(chosen.sessionFile ? { session: { file: chosen.sessionFile, saved: true } } : {}), ...(chosen.withholdTrust ? { withholdTrust: true } : {}) }, action === "retry" ? "resume" : "restore", lock); }
      catch (error) {
        if (!keep) await this.drop(lock);
        if (this.stopping) throw error;
        recovery.message = `${action === "retry" ? "Retry" : "Restore"} failed: ${error instanceof Error ? error.message : String(error)}`;
        this.setPhase("recovery_required"); throw new ProtocolError("recovery_required", recovery.message);
      }
      if (oldLock && this.lock !== oldLock) await this.drop(oldLock);
      if (action === "restore" && chosen.sessionFile) await this.reportModelChange(this.previousModel, "before the switch", "切换前");
      this.recovery = undefined; this.setPhase("ready");
      return this.status();
    });
    this.writes = result.catch(() => undefined); return result;
  }
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const remembered = this.phase === "ready" ? this.rememberSession(false) : Promise.resolve();
    this.accounts.dispose();
    this.stopping = true; this.clearDialogs("stopped", true); this.mirror?.dispose(); this.bridge?.dispose(); this.unsubscribe?.();
    this.stopPromise = (async () => {
      try { await remembered; await this.child?.stop(); }
      finally { for (const lock of [...this.locks]) await this.drop(lock); this.hub.setHostHandler(undefined); this.phase = "stopped"; this.hostRevision++; }
    })();
    return this.stopPromise;
  }
}
