/** Read-only workbench queries use directed replies and never consume event sequence numbers. */
export const WORKBENCH_ACTIONS = ["sessions", "commands", "resources", "tree", "files", "file", "git_status", "git_diff", "session_stats", "assistant_text"] as const;
export type WorkbenchAction = (typeof WORKBENCH_ACTIONS)[number];
export interface WorkbenchQuery {
  t: "workbench_query";
  reqId: string;
  epoch: string;
  sessionId: string;
  branchRevision: number;
  action: WorkbenchAction;
  args: Record<string, unknown>;
}
export interface WorkbenchResult {
  t: "workbench_result";
  reqId: string;
  epoch: string;
  action: WorkbenchAction;
  value?: WorkbenchValues[WorkbenchAction];
  error?: { code: string; message: string };
}
export interface SessionCatalogItem {
  id: string; cwd: string; name?: string; created: string; modified: string;
  messageCount: number; firstMessage: string; current: boolean;
}
export interface SessionsView { sessions: SessionCatalogItem[]; truncated: boolean }
export interface WorkbenchCommand {
  name: string; description: string; source: "builtin" | "extension" | "skill" | "prompt";
  available: boolean; terminalOnly?: boolean; reason?: string;
  /** A workbench picker can present these builtins without sending a plain slash to the model. */
  browserAction?: "new" | "sessions" | "tree" | "model" | "thinking" | "compact" | "resources" | "status" | "rename" | "clone" | "accounts" | "settings" | "export" | "copy";
}
export interface CommandsView { commands: WorkbenchCommand[] }
export interface ResourceTool { name: string; description: string; active: boolean; source?: string; exposure?: string }
export interface ResourcesView {
  tools: ResourceTool[]; commands: WorkbenchCommand[];
  models: { provider: string; id: string; name: string }[];
  thinkingLevels?: string[];
  capabilities: { name: string; available: boolean; detail: string }[];
}
export interface SessionTreeItem { id: string; parentId: string | null; type: string; role?: string; preview: string; timestamp?: string; label?: string; current: boolean }
export interface TreeView { entries: SessionTreeItem[]; leafId: string | null; truncated: boolean }
export interface WorkspaceFilesView { cwd?: string; files: { path: string; name?: string; type?: "file" | "directory"; size?: number }[]; truncated: boolean }
export interface WorkspaceFileView { path: string; text: string; language?: string; bytes: number; truncated: boolean; binary?: boolean }
export interface GitStatusView { isRepository: boolean; branch?: string; files: { path: string; status: string; staged: boolean; unstaged: boolean; originalPath?: string }[]; truncated: boolean }
export interface GitDiffView { path: string; text: string; truncated: boolean }
/** pi's own numbers for the current session, from its `get_session_stats`. */
export interface SessionStatsView {
  sessionId: string; sessionFile?: string; name?: string; cwd: string;
  userMessages: number; assistantMessages: number; toolCalls: number; toolResults: number; totalMessages: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
  /** Absent when pi cannot tell (no model, or nothing sent yet). */
  context?: { tokens: number | null; window: number; percent: number | null };
}
/** The text of one assistant reply as pi's `/copy` gives it: its text blocks, without thinking or tool calls. */
export interface AssistantTextView { text: string; truncated: boolean }
export interface WorkbenchValues {
  session_stats: SessionStatsView; assistant_text: AssistantTextView;
  sessions: SessionsView; commands: CommandsView; resources: ResourcesView; tree: TreeView;
  files: WorkspaceFilesView; file: WorkspaceFileView; git_status: GitStatusView; git_diff: GitDiffView;
}
/** Mutations retain the normal command envelope and its exactly-once dispatch receipt. */
export interface WorkbenchMutationArgs {
  session_new: Record<string, never>;
  session_switch: { sessionId: string };
  session_fork: { entryId: string };
  session_clone: Record<string, never>;
  session_rename: { name: string };
  run_command: { name: string; args?: string };
}
/** The initiating receipt can outlive an epoch reset; draft restoration must match this scope. */
export interface SessionMutationResult {
  cancelled: boolean; sessionId?: string; branchRevision?: number; draftText?: string; unchanged?: boolean;
}
