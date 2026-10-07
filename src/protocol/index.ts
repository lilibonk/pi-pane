/** M0 wire contract. Only broadcast events consume sequence numbers. */
export const PROTOCOL = "pi-pane.v1";
export const WS_PATH = "/ws";
export const M0_MAX_MESSAGES = 200;
export const M0_MESSAGE_BYTES = 512 * 1024;
export const M0_MAX_TOOLS = 64;
export const M0_RETAIN_COMPLETED_TOOLS = 32;
export const COMMANDS = ["prompt", "abort", "set_model", "set_thinking", "compact"] as const;
export type CommandName = (typeof COMMANDS)[number];

export type ContentView =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "toolCall"; id: string; name: string; arguments: unknown };
export interface MessageView {
  id: string;
  entryId?: string;
  role: string;
  content: ContentView[];
  status: "streaming" | "complete";
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  truncated?: boolean;
}
export interface ToolView {
  id: string;
  name: string;
  args: unknown;
  parentToolCallId?: string;
  partial?: unknown;
  result?: unknown;
  status: "running" | "complete" | "error";
}
export interface ModelView { provider: string; id: string; name: string }
export interface PromptView { kind: string; title?: string }
export interface StateView {
  idle: boolean;
  running: boolean;
  compacting: boolean;
  hasPendingMessages: boolean;
  model?: ModelView;
  thinking: string;
  models: ModelView[];
  tools: ToolView[];
  uiPrompts: PromptView[];
}
export interface SessionView {
  id: string;
  name?: string;
  cwd: string;
  leafId: string | null;
  branchRevision: number;
  messages: MessageView[];
  historyTruncated: boolean;
}
export interface Caps {
  commands: readonly CommandName[];
  images: false;
  promptReceipt: "dispatch_only";
  queueView: "boolean";
  terminalDialogs: true;
  history: "bounded_spike";
}
export interface Snapshot {
  t: "snapshot";
  epoch: string;
  seq: number;
  session: SessionView;
  state: StateView;
  theme: Record<string, string>;
  caps: Caps;
}
export type ProjectionEvent =
  | { type: "msg_start" | "msg_delta" | "msg_end"; message: MessageView }
  | { type: "tool_start" | "tool_update" | "tool_end"; tool: ToolView }
  | { type: "agent_state"; state: StateView }
  | { type: "session_meta"; name?: string }
  | { type: "theme"; theme: Record<string, string> };
export interface WireError { code: string; message: string }
export interface CommandEnvelope {
  t: "command";
  clientId: string;
  commandNo: number;
  id: string;
  epoch: string;
  sessionId: string;
  branchRevision: number;
  command: string;
  args: unknown;
}
export interface Ack {
  t: "ack";
  id: string;
  epoch: string;
  nextCommandNo: number;
  status: "dispatched" | "rejected";
  error?: WireError;
}
export interface CommandResult {
  t: "command_result";
  id: string;
  epoch: string;
  status: "completed" | "failed";
  value?: unknown;
  error?: WireError;
}
export type ClientMessage =
  | { t: "hello"; clientId?: string }
  | { t: "resync" }
  | { t: "receipt_query"; clientId: string; id: string }
  | CommandEnvelope;
export type ServerMessage =
  | { t: "welcome"; clientId: string; leaseExpiresAt: number; nextCommandNo: number }
  | Snapshot
  | { t: "event"; epoch: string; seq: number; ev: ProjectionEvent }
  | { t: "session_reset"; epoch: string; sessionId: string; branchRevision: number; reason: string }
  | { t: "switching"; reason: string }
  | { t: "notice"; message: string }
  | { t: "error"; error: WireError; nextCommandNo?: number }
  | Ack
  | CommandResult;

export class ProtocolError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "ProtocolError"; }
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function shortString(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}
export function parseClientMessage(value: unknown): ClientMessage {
  if (!isRecord(value)) throw new ProtocolError("invalid_envelope", "Expected a JSON object.");
  if (value.t === "hello" && exactKeys(value, ["t", "clientId"]) &&
      (value.clientId === undefined || shortString(value.clientId))) return value as ClientMessage;
  if (value.t === "resync" && exactKeys(value, ["t"])) return { t: "resync" };
  if (value.t === "receipt_query" && exactKeys(value, ["t", "clientId", "id"]) &&
      shortString(value.clientId) && shortString(value.id)) return value as ClientMessage;
  if (value.t === "command" && exactKeys(value, ["t", "clientId", "commandNo", "id", "epoch", "sessionId", "branchRevision", "command", "args"]) &&
      shortString(value.clientId) && shortString(value.id) && shortString(value.epoch) && shortString(value.sessionId) &&
      shortString(value.command, 64) && Number.isSafeInteger(value.commandNo) && (value.commandNo as number) >= 1 &&
      Number.isSafeInteger(value.branchRevision) && (value.branchRevision as number) >= 0 && "args" in value &&
      value.id === `${value.clientId}:${value.commandNo}`) return value as unknown as CommandEnvelope;
  throw new ProtocolError("invalid_envelope", "Invalid message envelope or command ID.");
}
export function commandArgs(command: string, value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new ProtocolError("invalid_args", "Command args must be an object.");
  if (command === "prompt") {
    if (!exactKeys(value, ["text", "mode"]) || !shortString(value.text, 65_536) ||
      !value.text.trim() || new TextEncoder().encode(value.text).length > 65_536 ||
      (value.mode !== undefined && value.mode !== "steer" && value.mode !== "followUp"))
      throw new ProtocolError("invalid_args", "Provide nonempty text up to 64 KiB; images are unavailable in M0.");
  } else if (command === "set_model") {
    if (!exactKeys(value, ["provider", "id"]) || !shortString(value.provider) || !shortString(value.id))
      throw new ProtocolError("invalid_args", "Provide a model provider and ID.");
  } else if (command === "set_thinking") {
    if (!exactKeys(value, ["level"]) || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(value.level)))
      throw new ProtocolError("invalid_args", "Invalid thinking level.");
  } else if (command === "abort" || command === "compact") {
    if (Object.keys(value).length) throw new ProtocolError("invalid_args", "This command takes no arguments.");
  } else throw new ProtocolError("unknown_command", "Unknown command.");
  return value;
}
export function toWireError(error: unknown): WireError {
  return error instanceof ProtocolError
    ? { code: error.code, message: error.message }
    : { code: "operation_failed", message: error instanceof Error ? error.message : "Operation failed." };
}
