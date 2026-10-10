/** Host-level reads: about the machine's projects, not about the session that happens to be running. */
export const HOST_QUERIES = ["projects", "directories", "project_inspect"] as const;
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
export interface HostQueryValues { projects: ProjectsView; directories: DirectoriesView; project_inspect: ProjectInspectView }
