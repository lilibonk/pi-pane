/** Host-level reads: about the machine's projects, not about the session that happens to be running. */
export const HOST_QUERIES = ["projects", "directories", "project_inspect", "accounts", "themes", "theme", "settings"] as const;
export type HostQueryAction = (typeof HOST_QUERIES)[number];
export interface HostQuery { t: "host_query"; reqId: string; action: HostQueryAction; args: Record<string, unknown> }
export interface HostResult {
  t: "host_result"; reqId: string; action: HostQueryAction;
  value?: HostQueryValues[HostQueryAction];
  error?: { code: string; message: string };
}
/**
 * - `choice`: what the trust store records for this directory (possibly inherited from a parent).
 * - `policy`: pi's global default for directories without a recorded choice.
 * - `ask`: the browser must ask before opening; nothing else decides for the user.
 * - `override`: the trust flag pi was started with. It applies to the start project only.
 * - `withheld`: this run was opened with "continue without loading".
 * - `loaded`: project-scoped commands observed in the running session. Absent when unknown; a
 *   project can be trusted and still show none, and a global extension can veto a recorded choice.
 */
export interface ProjectTrustView {
  required: boolean;
  choice: "trusted" | "untrusted" | "unknown";
  policy: "ask" | "always" | "never" | "unknown";
  ask: boolean;
  override?: "approve" | "no-approve";
  withheld?: boolean;
  loaded?: number;
}
export interface ProjectItem {
  path: string; name: string;
  /** `history`: known only from saved sessions. `current`: running, never opened through the list. */
  source: "opened" | "created" | "history" | "current";
  available: boolean; current: boolean; sessions: number; lastOpenedAt?: string;
}
export interface ProjectsView {
  projects: ProjectItem[]; truncated: boolean;
  current: { path: string; name: string; trust: ProjectTrustView };
  /** The project list file could not be used; it was left untouched. */
  registryError?: string;
  /** Saved sessions could not be scanned in time, so history-only projects may be missing. */
  historyIncomplete?: boolean;
}
export type ProjectRootRefusal = "credential_directory" | "agent_directory";
export interface DirectoriesView {
  /** Real path of the listed directory on the machine running pi. */
  path: string; parent?: string; home: string;
  entries: { name: string; hidden: boolean }[];
  truncated: boolean; writable: boolean;
  /** This directory cannot be a project opened from the browser; it is not listed either. */
  refused?: ProjectRootRefusal;
}
export interface ProjectInspectView { path: string; name: string; current: boolean; registered: boolean; sessions: number; trust: ProjectTrustView }
/**
 * One way to authenticate a provider. `web: false` carries the reason it must be done elsewhere;
 * `unverified` is a device-code login the browser could run but that has not been proven with a real account.
 */
export interface AccountMethod { type: "api_key" | "oauth"; label: string; web: boolean; reason?: "ambient" | "callback" | "unverified" | "extension" }
/**
 * A model provider as pi's account list knows it. Nothing here is a secret or is derived by resolving one:
 * `stored` is the kind of credential in pi's auth file, `models` counts what the running session can use.
 * A provider with models but nothing stored is configured by the environment, a start argument or an extension.
 */
export interface AccountProvider {
  id: string; name: string; methods: AccountMethod[];
  stored?: "api_key" | "oauth";
  models: number; knownModels: number;
}
export interface AccountsView {
  providers: AccountProvider[];
  /** A credential was saved or removed, and the running session has not reloaded it yet. */
  pendingApply: boolean;
  /** Why the last attempt to apply did not happen. */
  applyError?: string;
  /** pi's auth file could not be read; nothing was changed. */
  storeError?: string;
}
/** What the login flow is asking right now. Answered once, by the page that started the operation. */
export interface AccountStep {
  id: string; kind: "text" | "secret" | "select" | "manual_code";
  message: string; placeholder?: string;
  options?: { id: string; label: string; description?: string }[];
}
export type AccountNotice =
  | { type: "info"; message: string; links?: { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string; expiresAt?: number }
  | { type: "progress"; message: string };
/**
 * An account operation. Only its owner (the page that started it) receives `step`, `notices` and
 * `error`; other viewers learn that one is running and may cancel it. `saved` means the credential
 * is in pi's auth file: not that the provider accepted it, and not that the session uses it yet.
 */
export interface AccountOperation {
  id: string; providerId: string; providerName: string; method: "api_key" | "oauth";
  status: "running" | "saved" | "failed" | "cancelled";
  owner: boolean; startedAt: number; expiresAt: number;
  step?: AccountStep; notices?: AccountNotice[];
  error?: { code: string; message: string };
}
export interface AccountState { t: "account_state"; operation: AccountOperation | null }
/** Directed to the page whose answer was not accepted. The step stays open unless the code says otherwise. */
export interface AccountAnswerError { t: "account_error"; operationId: string; stepId: string; error: { code: string; message: string } }
/** The answer to a login step. It is not a numbered command: nothing about it is kept in a receipt. */
export interface AccountAnswer { t: "account_answer"; operationId: string; stepId: string; value: string }
/**
 * Where a theme was found.
 * - `builtin`: pi's own `dark` and `light`. `pi-pane`: shipped with this package.
 * - `user`: pi's theme directory on this machine. `project`: the current project's, loaded only when it is trusted.
 * - `handoff`: found by pi itself when `/web` was run (packages, configured paths, extensions); not rediscovered later.
 */
export type ThemeSource = "builtin" | "pi-pane" | "user" | "project" | "handoff";
export interface ThemeItem {
  name: string; source: ThemeSource; appearance: "light" | "dark";
  /** Three colors for a swatch; the full set is read with the `theme` query. */
  preview: { bg: string; fg: string; accent: string };
  /** Whether pi can find this theme from any project, so it may be saved as pi's default. */
  global: boolean;
}
/** A theme file that was found and not used. `file` is a file name, never a host path. */
export interface ThemeProblem {
  file: string; source: ThemeSource; name?: string;
  code: "unreadable" | "too_large" | "invalid_json" | "invalid_theme" | "duplicate" | "reserved_name";
  message: string;
}
/**
 * The theme "follow pi" shows: what pi would use in the current project.
 * - `setting`: pi's theme setting as stored (`name` or `light/dark`); absent means pi's default, `system`.
 * - `origin: "handoff"`: the colors are the terminal theme captured when `/web` was run, because the
 *   setting is `system` (generated from the terminal), names a theme that is not available, or is malformed.
 */
export interface PiThemeView {
  setting?: string; source: "cli" | "project" | "global" | "default";
  name: string; appearance: "light" | "dark";
  origin: "catalog" | "handoff"; reason?: "system" | "missing" | "invalid";
}
export interface ThemesView {
  themes: ThemeItem[]; problems: ThemeProblem[]; truncated: boolean;
  pi: PiThemeView;
  /** Whether the current project's own theme directory was read. */
  projectThemes: "loaded" | "untrusted" | "none";
}
export interface ThemeView { name: string; appearance: "light" | "dark"; vars: Record<string, string> }
export const SETTING_KEYS = ["theme", "defaultModel", "defaultThinkingLevel", "steeringMode", "followUpMode", "compaction.enabled", "retry.enabled", "images.blockImages", "hideThinkingBlock"] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];
/** `null` is "not set": pi's built-in default applies. */
export type SettingValue = string | boolean | null;
/**
 * One editable pi setting, with every layer that decides its value shown separately.
 * - `global`: what pi's settings file under `agentDir` stores. This is the only layer the browser writes.
 * - `project`: the current project's override, present only when the project is trusted and sets it.
 * - `cli`: the argument pi was started with that overrides it for this run.
 * - `effective`: what a runtime started in the current project reads from settings (project over global over default).
 * - `runtime`: what the running session reports, for the settings pi's RPC state exposes.
 * - `writes: "runtime"`: changed through pi's own RPC command, which applies it to the running session
 *   and also saves it as the global default. `"global"`: written by the host to the global file.
 * - `applies`: when a saved value reaches a session. `reload` needs the running session to reload its settings.
 */
export interface SettingItem {
  key: SettingKey; kind: "theme" | "model" | "choice" | "toggle";
  options?: string[];
  effective: SettingValue; global: SettingValue; defaultValue: SettingValue;
  project?: SettingValue; cli?: string; runtime?: SettingValue;
  writes: "global" | "runtime"; applies: "new_runtimes" | "reload" | "now" | "terminal";
  editable: boolean; reason?: "unreadable" | "no_runtime" | "no_models";
}
/** A pi setting the browser shows and does not edit. Values are sent only for plain flags, numbers and fixed choices. */
export interface ReadonlySetting { key: string; where: ("global" | "project")[]; value?: string }
export interface ReadonlySettingGroup {
  id: string;
  /** `terminal`: only meaningful in the TUI. `runtime`: read when pi starts. `later`: not editable from the browser yet. */
  status: "terminal" | "runtime" | "later";
  settings: ReadonlySetting[];
}
export interface SettingsView {
  items: SettingItem[]; groups: ReadonlySettingGroup[];
  /** pi's agent directory; its `settings.json` is what "global" means. */
  agentDir: string;
  project: { path: string; settings: "loaded" | "untrusted" | "none" };
  /** Settings files that could not be read. A broken global file makes every item read-only; it is never overwritten. */
  errors: { scope: "global" | "project"; message: string }[];
  /** A saved setting is waiting for the running session to reload. Shared with credential changes. */
  pendingApply: boolean; applyError?: string;
}
/**
 * The outcome of `setting_set`, in two parts that can differ.
 * - `saved: "unconfirmed"`: pi accepted the change for the running session, and the global file did
 *   not show it within the wait. Nothing was rolled back.
 * - `applied`: `now` the running session uses it; `overridden` it is saved and the project's own value
 *   still decides; `pending` it waits for a reload; `later` it only concerns runtimes started afterwards.
 */
export interface SettingResult { key: SettingKey; saved: "confirmed" | "unconfirmed"; applied: "now" | "overridden" | "pending" | "later"; item: SettingItem }
export interface HostQueryValues {
  projects: ProjectsView; directories: DirectoriesView; project_inspect: ProjectInspectView; accounts: AccountsView;
  themes: ThemesView; theme: ThemeView; settings: SettingsView;
}
