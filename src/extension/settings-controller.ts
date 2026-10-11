import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ProtocolError, isRecord, type ReadonlySetting, type ReadonlySettingGroup, type SettingItem, type SettingKey, type SettingResult, type SettingValue, type SettingsView } from "../protocol/index.js";

/** Which project's settings apply, and whether pi itself would read that project's file. */
export interface SettingsScope { cwd: string; projectTrusted: boolean }
/** The running session, for the settings pi changes through its own RPC commands. */
export interface SettingsRuntime { request<T = unknown>(command: string, payload?: Record<string, unknown>): Promise<T> }
export interface SettingsControllerOptions {
  agentDir: string;
  /** Start arguments that override a setting for this run. They are shown, never saved. */
  cli?: { provider?: string; model?: string; thinking?: string; theme?: string };
  /** How long to wait for the global file to show a change pi's RPC command made. */
  confirmMs?: number;
}
/** What the page offers for the settings that are chosen from a list. */
export interface SettingChoices {
  /** `provider/id` of every model the running session can use. */
  models?: string[];
  /** Themes that may be saved as pi's default, by name. */
  themes?: string[];
  runtime?: { steeringMode?: string; followUpMode?: string; autoCompactionEnabled?: boolean };
}
type Raw = Record<string, unknown>;
const QUEUE_MODES = ["one-at-a-time", "all"];
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** The settings pi changes itself, through an RPC command that also saves the global default. */
const RPC: Partial<Record<SettingKey, { command: string; payload: (value: SettingValue) => Record<string, unknown>; state?: "steeringMode" | "followUpMode" | "autoCompactionEnabled" }>> = {
  steeringMode: { command: "set_steering_mode", payload: mode => ({ mode }), state: "steeringMode" },
  followUpMode: { command: "set_follow_up_mode", payload: mode => ({ mode }), state: "followUpMode" },
  "compaction.enabled": { command: "set_auto_compaction", payload: enabled => ({ enabled }), state: "autoCompactionEnabled" },
  "retry.enabled": { command: "set_auto_retry", payload: enabled => ({ enabled }) }, // pi's RPC state has no retry field
};
/** Settings a running session reads once: a saved change reaches it when it reloads. */
const NEEDS_RELOAD = new Set<SettingKey>(["images.blockImages"]);
/**
 * Everything else pi documents, grouped by why the browser does not edit it. Values are shown for
 * flags, numbers and the fixed choices listed in `PLAIN`; a path, command, proxy or list is only
 * reported as set.
 */
const GROUPS: { id: string; status: ReadonlySettingGroup["status"]; keys: string[] }[] = [
  { id: "models", status: "later", keys: ["enabledModels", "modelThinkingLevels", "thinkingBudgets"] },
  { id: "cache", status: "later", keys: ["showCacheMissNotices", "cacheWarming"] },
  { id: "trust", status: "later", keys: ["defaultProjectTrust"] },
  { id: "tools", status: "later", keys: ["defaultTools", "codemode.mode", "codemode.inlineBudget"] },
  { id: "compaction", status: "later", keys: ["compaction.reserveTokens", "compaction.keepRecentTokens", "compaction.modelOverrides", "branchSummary.reserveTokens", "branchSummary.skipPrompt"] },
  { id: "retry", status: "later", keys: ["retry.maxRetries", "retry.baseDelayMs", "retry.maxAgentDelayMs", "retry.provider.timeoutMs", "retry.provider.maxRetries", "retry.provider.maxRetryDelayMs"] },
  { id: "images", status: "later", keys: ["images.autoResize"] },
  { id: "resources", status: "later", keys: ["packages", "extensions", "skills", "prompts", "themes", "enableSkillCommands"] },
  { id: "markdown", status: "later", keys: ["markdown.mermaid"] },
  { id: "telemetry", status: "later", keys: ["enableInstallTelemetry", "enableAnalytics", "warnings.anthropicExtraUsage"] },
  { id: "session", status: "runtime", keys: ["sessionDir"] },
  { id: "network", status: "runtime", keys: ["transport", "httpProxy", "httpIdleTimeoutMs", "websocketConnectTimeoutMs"] },
  { id: "shell", status: "runtime", keys: ["shellPath", "shellCommandPrefix", "npmCommand"] },
  { id: "terminal", status: "terminal", keys: ["externalEditor", "doubleEscapeAction", "treeFilterMode", "quietStartup", "tuiMode", "fullscreenExitOutput", "fullscreenScrollbar",
    "fullscreenCopyOnSelect", "fullscreenWheelScrollLines", "editorPaddingX", "outputPad", "autocompleteMaxVisible", "showHardwareCursor", "collapseChangelog", "markdown.codeBlockIndent",
    "terminal.showImages", "terminal.imageWidthCells", "terminal.clearOnShrink", "terminal.showTerminalProgress", "terminal.hyperlinks", "terminal.images", "terminal.trueColor"] },
];
const PLAIN = new Set(["cacheWarming", "defaultProjectTrust", "codemode.mode", "transport", "doubleEscapeAction", "treeFilterMode", "quietStartup", "tuiMode", "fullscreenExitOutput", "fullscreenScrollbar", "sessionDir"]);
const clip = (text: string, length: number): string => text.length <= length ? text : `${text.slice(0, length)}…`;
const at = (raw: Raw, key: string): unknown => key.split(".").reduce<unknown>((value, part) => isRecord(value) ? value[part] : undefined, raw);
const model = (provider: unknown, id: unknown): string | null => typeof provider === "string" && provider && typeof id === "string" && id ? `${provider}/${id}` : null;
function display(key: string, value: unknown): string | undefined {
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string" && PLAIN.has(key)) return clip(value, 400);
  if (Array.isArray(value)) return `[${value.length}]`; // how many entries, not what they are
  return undefined;
}

/**
 * pi's settings as a browser may see and change them. Reads go through pi's public SettingsManager
 * with the project's real trust; nothing of the raw files leaves the host except the listed fields.
 * Writes are one field at a time through pi's own setters or RPC commands, into the global file only.
 * A save is reported only after pi's write queue has flushed without error and a fresh read shows it.
 */
export class SettingsController {
  private readonly defaults: SettingsManager;
  constructor(private readonly options: SettingsControllerOptions) { this.defaults = SettingsManager.inMemory({}, { projectTrusted: false }); }

  private open(scope: SettingsScope) {
    const manager = SettingsManager.create(scope.cwd, this.options.agentDir, { projectTrusted: scope.projectTrusted });
    const errors = manager.drainErrors().map(item => ({ scope: item.scope, message: clip(item.error.message, 300) }));
    return { manager, errors, global: manager.getGlobalSettings() as Raw, project: (scope.projectTrusted ? manager.getProjectSettings() : {}) as Raw };
  }
  private value(key: SettingKey, raw: Raw): SettingValue {
    if (key === "defaultModel") return model(raw.defaultProvider, raw.defaultModel);
    const value = at(raw, key);
    return typeof value === "string" || typeof value === "boolean" ? value : null;
  }
  private effective(key: SettingKey, manager: SettingsManager): SettingValue {
    switch (key) {
      case "theme": return manager.getThemeSetting() ?? null;
      case "defaultModel": return model(manager.getDefaultProvider(), manager.getDefaultModel());
      case "defaultThinkingLevel": return manager.getDefaultThinkingLevel() ?? null;
      case "steeringMode": return manager.getSteeringMode();
      case "followUpMode": return manager.getFollowUpMode();
      case "compaction.enabled": return manager.getCompactionEnabled();
      case "retry.enabled": return manager.getRetryEnabled();
      case "images.blockImages": return manager.getBlockImages();
      case "hideThinkingBlock": return manager.getHideThinkingBlock();
    }
  }
  private item(key: SettingKey, opened: ReturnType<SettingsController["open"]>, choices: SettingChoices, live: boolean): SettingItem {
    const cli = this.options.cli ?? {};
    const kind: SettingItem["kind"] = key === "theme" ? "theme" : key === "defaultModel" ? "model"
      : key === "defaultThinkingLevel" || key === "steeringMode" || key === "followUpMode" ? "choice" : "toggle";
    const options = key === "theme" ? choices.themes : key === "defaultModel" ? choices.models : key === "defaultThinkingLevel" ? THINKING_LEVELS : kind === "choice" ? QUEUE_MODES : undefined;
    const rpc = RPC[key];
    const project = Object.keys(opened.project).length ? this.value(key, opened.project) : null;
    const override = key === "theme" ? cli.theme : key === "defaultModel" ? [cli.provider, cli.model].filter(Boolean).join("/") : key === "defaultThinkingLevel" ? cli.thinking : undefined;
    const runtime = rpc?.state ? choices.runtime?.[rpc.state] : undefined;
    const reason: SettingItem["reason"] = opened.errors.some(error => error.scope === "global") ? "unreadable" : rpc && !live ? "no_runtime" : key === "defaultModel" && !choices.models?.length ? "no_models" : undefined;
    return {
      key, kind, ...(options ? { options: options.slice(0, 512) } : {}),
      effective: this.effective(key, opened.manager), global: this.value(key, opened.global), defaultValue: this.effective(key, this.defaults),
      ...(project !== null ? { project } : {}), ...(override ? { cli: clip(override, 200) } : {}), ...(runtime !== undefined ? { runtime } : {}),
      writes: rpc ? "runtime" : "global",
      applies: rpc ? "now" : NEEDS_RELOAD.has(key) ? "reload" : key === "theme" || key === "hideThinkingBlock" ? "terminal" : "new_runtimes",
      editable: !reason, ...(reason ? { reason } : {}),
    };
  }
  view(scope: SettingsScope, choices: SettingChoices = {}, live = false): Omit<SettingsView, "pendingApply" | "applyError"> {
    const opened = this.open(scope);
    const keys: SettingKey[] = ["theme", "defaultModel", "defaultThinkingLevel", "steeringMode", "followUpMode", "compaction.enabled", "retry.enabled", "images.blockImages", "hideThinkingBlock"];
    const groups = GROUPS.map(group => ({ id: group.id, status: group.status, settings: group.keys.map((key): ReadonlySetting => {
      const inGlobal = at(opened.global, key) !== undefined, inProject = at(opened.project, key) !== undefined;
      const shown = display(key, inProject ? at(opened.project, key) : at(opened.global, key));
      return { key, where: [...(inGlobal ? ["global" as const] : []), ...(inProject ? ["project" as const] : [])], ...(shown !== undefined ? { value: shown } : {}) };
    }) }));
    const hasProjectFile = existsSync(join(scope.cwd, ".pi", "settings.json"));
    return { items: keys.map(key => this.item(key, opened, choices, live)), groups, agentDir: this.options.agentDir,
      project: { path: scope.cwd, settings: hasProjectFile ? scope.projectTrusted ? "loaded" : "untrusted" : "none" }, errors: opened.errors };
  }
  /** The theme setting pi would read in this project, and the layer it comes from. */
  themeSetting(scope: SettingsScope): { setting?: string; source: "cli" | "project" | "global" | "default" } {
    if (this.options.cli?.theme) return { setting: this.options.cli.theme, source: "cli" };
    const opened = this.open(scope);
    const setting = opened.manager.getThemeSetting();
    return setting ? { setting, source: typeof opened.project.theme === "string" ? "project" : "global" } : { source: "default" };
  }
  private validate(key: SettingKey, value: SettingValue, choices: SettingChoices): void {
    const invalid = (message: string): never => { throw new ProtocolError("invalid_setting", message); };
    if (key === "theme") {
      const names = typeof value === "string" ? value.split("/") : [];
      if (!names.length || names.length > 2 || names.some(name => name !== "system" && !choices.themes?.includes(name)))
        throw new ProtocolError("theme_not_global", "Only a theme pi can find from every project can be its default: a built-in one, one in pi's theme directory, or one from a package installed for the user.");
    } else if (key === "defaultModel") {
      if (typeof value !== "string" || !choices.models?.includes(value)) invalid("Choose one of the models the running session offers.");
    } else if (key === "defaultThinkingLevel") {
      if (typeof value !== "string" || !THINKING_LEVELS.includes(value)) invalid("Unknown thinking level.");
    } else if (key === "steeringMode" || key === "followUpMode") {
      if (typeof value !== "string" || !QUEUE_MODES.includes(value)) invalid("Unknown queue mode.");
    } else if (typeof value !== "boolean") invalid("This setting is on or off.");
  }
  /**
   * Changes one setting. `expected` is the global value the page was showing: if the file says
   * otherwise, another page or another pi changed it first and nothing is written.
   */
  async set(scope: SettingsScope, key: SettingKey, value: SettingValue, expected: SettingValue, choices: SettingChoices, runtime?: SettingsRuntime): Promise<SettingResult> {
    this.validate(key, value, choices);
    const before = this.open(scope);
    // A file that cannot be parsed is the user's to repair. pi's setters would not write over it either.
    if (before.errors.some(error => error.scope === "global")) throw new ProtocolError("settings_unreadable", "pi's global settings file cannot be read. It was left untouched; fix it in an editor first.");
    const current = this.value(key, before.global);
    if (current !== expected) throw new ProtocolError("stale_setting", "This setting was changed elsewhere. The page now shows the saved value; choose again if it still needs changing.");
    const rpc = RPC[key];
    const saved = (): boolean => this.value(key, this.open(scope).global) === value;
    const result = (confirmed: boolean, applied: SettingResult["applied"], live: boolean): SettingResult =>
      ({ key, saved: confirmed ? "confirmed" : "unconfirmed", applied, item: this.item(key, this.open(scope), choices, live) });
    if (rpc) {
      if (!runtime) throw new ProtocolError("no_runtime", "No session is running to apply this to.");
      await runtime.request(rpc.command, rpc.payload(value));
      const state = rpc.state ? await runtime.request<Record<string, unknown>>("get_state").catch(() => undefined) : undefined;
      if (state) choices = { ...choices, runtime: { ...choices.runtime, [rpc.state!]: state[rpc.state!] } };
      // pi saves the default on its own write queue and offers no way to wait for it: read the file until it shows.
      const deadline = Date.now() + (this.options.confirmMs ?? 2500);
      let confirmed = saved();
      while (!confirmed && Date.now() < deadline) { await new Promise(done => setTimeout(done, 100)); confirmed = saved(); }
      // A trusted project that sets the same field still decides what the session uses.
      const projectValue = this.value(key, before.project);
      const overridden = rpc.state && state ? state[rpc.state] !== value : projectValue !== null && projectValue !== value;
      return result(confirmed, overridden ? "overridden" : "now", true);
    }
    const manager = before.manager;
    if (key === "theme") manager.setTheme(value as string);
    else if (key === "defaultModel") { const text = value as string, split = text.indexOf("/"); manager.setDefaultModelAndProvider(text.slice(0, split), text.slice(split + 1)); }
    else if (key === "defaultThinkingLevel") manager.setDefaultThinkingLevel(value as Parameters<SettingsManager["setDefaultThinkingLevel"]>[0]);
    else if (key === "images.blockImages") manager.setBlockImages(value as boolean);
    else manager.setHideThinkingBlock(value as boolean);
    // flush() resolves even when the write failed; the failure is only in drainErrors().
    await manager.flush();
    const failures = manager.drainErrors();
    if (failures.length) throw new ProtocolError("save_failed", `pi could not write its settings file: ${clip(failures[0]!.error.message, 300)}`);
    if (!saved()) throw new ProtocolError("save_unconfirmed", "The settings file does not show the new value. Another program may have changed it at the same moment.");
    const shadowed = this.value(key, before.project) !== null && this.value(key, before.project) !== value;
    return result(true, shadowed ? "overridden" : NEEDS_RELOAD.has(key) ? "pending" : "later", !!runtime);
  }
  /** Whether pi changes this setting itself, in the running session, through an RPC command. */
  viaRuntime(key: SettingKey): boolean { return !!RPC[key]; }
}
