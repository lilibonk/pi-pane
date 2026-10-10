/** Host-level reads: about the machine's projects, not about the session that happens to be running. */
export const HOST_QUERIES = ["projects", "directories", "project_inspect", "accounts"] as const;
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
/** One way to authenticate a provider. `web: false` carries the reason it must be done elsewhere. */
export interface AccountMethod { type: "api_key" | "oauth"; label: string; web: boolean; reason?: "ambient" | "callback" | "extension" }
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
export interface HostQueryValues { projects: ProjectsView; directories: DirectoriesView; project_inspect: ProjectInspectView; accounts: AccountsView }
