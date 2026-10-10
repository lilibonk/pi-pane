/** Wire contract. Only broadcast events consume sequence numbers. */
import { WORKBENCH_ACTIONS, type WorkbenchQuery, type WorkbenchResult } from "./workbench.js";
import { HOST_QUERIES, type AccountAnswer, type AccountAnswerError, type AccountState, type HostQuery, type HostQueryAction, type HostResult } from "./host.js";
export * from "./workbench.js";
export * from "./host.js";
export const PROTOCOL = "pi-pane.v1";
export const WS_PATH = "/ws";

/** Resource limits shared by the extension, the browser and the harnesses. */
export const LIMITS = {
  /** Recent history carried by a snapshot; older history is paged. */
  snapshotWindowMessages: 200,
  snapshotWindowBytes: 768 * 1024,
  /** One history_page response. */
  pageBytes: 768 * 1024,
  /** Inline text budget shared by all blocks of one message; the rest is read through content_page. */
  messageChars: 32_768,
  /** Inline preview of tool-call arguments. */
  toolArgsChars: 8_192,
  /** Tail of live/final tool output kept in ToolView. */
  toolOutputChars: 8_192,
  /** One content_page response. */
  contentPageChars: 128 * 1024,
  /** Frames above this are split into frame_chunk parts. */
  frameBytes: 1024 * 1024,
  /** Characters of the serialized frame per frame_chunk (escaping can roughly double the bytes). */
  chunkChars: 128 * 1024,
  /** Logical frame limit, including chunked frames. */
  logicalFrameBytes: 8 * 1024 * 1024,
  /** Per-connection send buffer high-water mark. */
  sendBufferBytes: 8 * 1024 * 1024,
  /** Browser-side cap for retained history. */
  clientCacheBytes: 16 * 1024 * 1024,
  maxTools: 64,
  retainCompletedTools: 32,
  /** Server-side coalescing windows. */
  messageFlushMs: 16,
  toolFlushMs: 50,
  /** Prompt input: UTF-8 text, attached images and the command frame carrying them. */
  promptBytes: 64 * 1024,
  maxImages: 4,
  imageBytes: 5 * 1024 * 1024,
  imagesTotalBytes: 10 * 1024 * 1024,
  imagePixels: 20_000_000,
  commandFrameBytes: 16 * 1024 * 1024,
  /** One answer to a login step: a key, a pasted code or a pasted redirect address. */
  accountAnswerChars: 8192,
  /** One image_page response (decoded bytes); larger history images are not sent. */
  imageReadBytes: 5 * 1024 * 1024,
  /** Browser-side cap for decoded history images held as object URLs. */
  clientImageCacheBytes: 48 * 1024 * 1024,
} as const;

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

export const COMMANDS = ["prompt", "abort", "set_model", "set_thinking", "compact", "session_new", "session_switch", "session_fork", "session_clone", "session_rename", "run_command", "access_rotate"] as const;
export type CommandName = (typeof COMMANDS)[number];
/** Commands about the host itself. They need no live session: a failed runtime replacement is recovered through them. */
export const HOST_COMMANDS = ["recover_retry", "recover_restore", "host_stop", "project_open", "project_create", "project_remove", "project_relocate",
  "account_begin", "account_cancel", "account_logout", "account_apply"] as const;
export type HostCommandName = (typeof HOST_COMMANDS)[number];

/** `total` is present when `text` is a prefix of a longer block readable through content_page. */
export type ContentView =
  | { type: "text"; text: string; total?: number }
  /** Host-observed intervals only. Running blocks have no elapsed duration until they stop. */
  | { type: "thinking"; text: string; total?: number; durationMs?: number; timingStatus?: "running" | "complete" | "interrupted" }
  | { type: "diff"; text: string; total?: number }
  | { type: "toolCall"; id: string; name: string; arguments: unknown; argsTruncated?: boolean }
  /** Image metadata only; the bytes are read on demand through image_page. */
  | { type: "image"; mimeType: string; bytes: number; width?: number; height?: number };
export type TextContentView = Extract<ContentView, { text: string }>;
export interface MessageView {
  id: string;
  entryId?: string;
  role: string;
  content: ContentView[];
  status: "streaming" | "complete";
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  /** Blocks beyond the per-message block limit were omitted entirely. */
  truncated?: boolean;
}
export interface ToolView {
  id: string;
  name: string;
  args: unknown;
  parentToolCallId?: string;
  /** Tail of the textual output (partial while running, final once complete). */
  output?: string;
  /** Full output length when `output` is only a tail. */
  outputTotal?: number;
  status: "running" | "complete" | "error";
}
export interface ModelView { provider: string; id: string; name: string; images?: boolean }
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
  /** Entry ID to pass as history_page `before`; null when the window starts at the branch root. */
  olderCursor: string | null;
}
export interface Caps {
  commands: readonly CommandName[];
  /** Prompt image upload and on-demand history images. */
  images: boolean;
  promptReceipt: "rpc";
  queueView: "boolean";
  extensionDialogs: true;
  history: "paged";
  content: "paged";
  workbench: true;
  /** All session writes are owned by the foreground RPC host. */
  host: true;
}
export interface ExtensionUiState {
  revision: number;
  statuses: Record<string, string>;
  widgets: Record<string, { content: string[]; placement?: string }>;
  title?: string;
  editorText?: string;
  /** Changes only when an extension requests editor text, independent of status updates. */
  editorRevision?: number;
}
export interface UiRequest {
  t: "ui_request";
  id: string;
  method: "select" | "confirm" | "input" | "editor";
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  expiresAt?: number;
}
export interface Snapshot {
  t: "snapshot";
  epoch: string;
  seq: number;
  session: SessionView;
  state: StateView;
  theme: Record<string, string>;
  caps: Caps;
  ui?: ExtensionUiState;
}
/** Append to a text block, or replace a block. */
export type DeltaOp =
  | { i: number; append: string; total?: number }
  | { i: number; set: ContentView };
export type ProjectionEvent =
  | { type: "msg_start" | "msg_end"; message: MessageView }
  | { type: "msg_delta"; id: string; ops: DeltaOp[] }
  | { type: "msg_delta"; id: string; message: MessageView }
  | { type: "history_window"; messages: MessageView[]; olderCursor: string | null }
  | { type: "tool_start" | "tool_update" | "tool_end"; tool: ToolView }
  | { type: "agent_state"; state: StateView }  // `tools` is always empty; see applyProjectionEvent
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
/** Same lease, numbering and receipts as `command`; checked against the host revision instead of a session epoch. */
export interface HostCommandEnvelope {
  t: "host_command";
  clientId: string;
  commandNo: number;
  id: string;
  hostRevision: number;
  command: HostCommandName;
  args: Record<string, unknown>;
}
/**
 * The host's own state, independent of any session. `replacing`: the session runtime is being
 * swapped. `recovery_required`: a swap failed; conversation writes are refused until the user
 * retries, restores the previous session or stops the service.
 */
export interface HostState {
  t: "host_state";
  revision: number;
  phase: "ready" | "replacing" | "recovery_required";
  cwd: string;
  recovery?: { reason: string; message: string; targetCwd: string; previousCwd: string; canRestore: boolean };
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
export interface HistoryPageRequest {
  t: "history_page";
  reqId: string;
  epoch: string;
  sessionId: string;
  branchRevision: number;
  before: string;
}
export interface ContentPageRequest {
  t: "content_page";
  reqId: string;
  epoch: string;
  messageId: string;
  index: number;
  offset: number;
}
export interface ImagePageRequest {
  t: "image_page";
  reqId: string;
  epoch: string;
  messageId: string;
  index: number;
}
export interface ImagePage {
  t: "image_page";
  reqId: string;
  epoch: string;
  messageId: string;
  index: number;
  mimeType: string;
  /** Base64 image bytes. */
  data: string;
}
export interface HistoryPage {
  t: "history_page";
  reqId: string;
  epoch: string;
  messages: MessageView[];
  olderCursor: string | null;
}
export interface ContentPage {
  t: "content_page";
  reqId: string;
  epoch: string;
  messageId: string;
  index: number;
  offset: number;
  text: string;
  total: number;
  /** False while the source message is still streaming. */
  final: boolean;
}
export type ClientMessage =
  | { t: "hello"; clientId?: string }
  | { t: "resync" }
  | { t: "ui_response"; id: string; value?: string; confirmed?: boolean; cancelled?: true }
  | { t: "receipt_query"; clientId: string; id: string }
  | HistoryPageRequest
  | ContentPageRequest
  | ImagePageRequest
  | WorkbenchQuery
  | CommandEnvelope
  | HostCommandEnvelope
  | HostQuery
  | AccountAnswer;
export type ServerMessage =
  | { t: "welcome"; clientId: string; leaseExpiresAt: number; nextCommandNo: number }
  | Snapshot
  | { t: "event"; epoch: string; seq: number; ev: ProjectionEvent }
  | { t: "session_reset"; epoch: string; sessionId: string; branchRevision: number; reason: string }
  | { t: "switching"; reason: string }
  | HostState
  | HostResult
  | AccountState
  | AccountAnswerError
  | { t: "notice"; message: string }
  | UiRequest
  | ({ t: "ui_state" } & ExtensionUiState)
  | { t: "ui_resolved"; id: string; reason?: string }
  | { t: "error"; error: WireError; nextCommandNo?: number; reqId?: string }
  | Ack
  | CommandResult
  | HistoryPage
  | ContentPage
  | ImagePage
  | WorkbenchResult;
/** Transport framing for logical frames above LIMITS.frameBytes. Never interleaved with other frames. */
export type ChunkFrame =
  | { t: "frame_begin"; id: string; parts: number }
  | { t: "frame_chunk"; id: string; index: number; data: string }
  | { t: "frame_end"; id: string };

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
function nonNegativeInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
/** Slash invocation names may be Unicode, but cannot contain separators or control characters. */
export function isCommandInvocationName(value: unknown): value is string {
  return shortString(value, 128) && !/[\s/\u0000-\u001f\u007f]/u.test(value);
}
export function parseClientMessage(value: unknown): ClientMessage {
  if (!isRecord(value)) throw new ProtocolError("invalid_envelope", "Expected a JSON object.");
  if (value.t === "hello" && exactKeys(value, ["t", "clientId"]) &&
      (value.clientId === undefined || shortString(value.clientId))) return value as ClientMessage;
  if (value.t === "resync" && exactKeys(value, ["t"])) return { t: "resync" };
  if (value.t === "ui_response" && exactKeys(value, ["t", "id", "value", "confirmed", "cancelled"]) && shortString(value.id) &&
      (value.value === undefined || (typeof value.value === "string" && new TextEncoder().encode(value.value).length <= LIMITS.promptBytes)) &&
      (value.confirmed === undefined || typeof value.confirmed === "boolean") && (value.cancelled === undefined || value.cancelled === true))
    return value as unknown as ClientMessage;
  if (value.t === "receipt_query" && exactKeys(value, ["t", "clientId", "id"]) &&
      shortString(value.clientId) && shortString(value.id)) return value as ClientMessage;
  if (value.t === "history_page" && exactKeys(value, ["t", "reqId", "epoch", "sessionId", "branchRevision", "before"]) &&
      shortString(value.reqId, 64) && shortString(value.epoch) && shortString(value.sessionId) &&
      nonNegativeInt(value.branchRevision) && shortString(value.before)) return value as unknown as HistoryPageRequest;
  if (value.t === "content_page" && exactKeys(value, ["t", "reqId", "epoch", "messageId", "index", "offset"]) &&
      shortString(value.reqId, 64) && shortString(value.epoch) && shortString(value.messageId) &&
      nonNegativeInt(value.index) && (value.index as number) < 1024 && nonNegativeInt(value.offset)) return value as unknown as ContentPageRequest;
  if (value.t === "image_page" && exactKeys(value, ["t", "reqId", "epoch", "messageId", "index"]) &&
      shortString(value.reqId, 64) && shortString(value.epoch) && shortString(value.messageId) &&
      nonNegativeInt(value.index) && (value.index as number) < 1024) return value as unknown as ImagePageRequest;
  if (value.t === "workbench_query" && exactKeys(value, ["t", "reqId", "epoch", "sessionId", "branchRevision", "action", "args"]) &&
      shortString(value.reqId, 64) && shortString(value.epoch) && shortString(value.sessionId) && nonNegativeInt(value.branchRevision) &&
      WORKBENCH_ACTIONS.includes(value.action as WorkbenchQuery["action"])) {
    workbenchArgs(value.action as WorkbenchQuery["action"], value.args);
    return value as unknown as WorkbenchQuery;
  }
  if (value.t === "command" && exactKeys(value, ["t", "clientId", "commandNo", "id", "epoch", "sessionId", "branchRevision", "command", "args"]) &&
      shortString(value.clientId) && shortString(value.id) && shortString(value.epoch) && shortString(value.sessionId) &&
      shortString(value.command, 64) && Number.isSafeInteger(value.commandNo) && (value.commandNo as number) >= 1 &&
      nonNegativeInt(value.branchRevision) && "args" in value &&
      value.id === `${value.clientId}:${value.commandNo}`) return value as unknown as CommandEnvelope;
  if (value.t === "host_command" && exactKeys(value, ["t", "clientId", "commandNo", "id", "hostRevision", "command", "args"]) &&
      shortString(value.clientId) && shortString(value.id) && Number.isSafeInteger(value.commandNo) && (value.commandNo as number) >= 1 &&
      nonNegativeInt(value.hostRevision) && value.id === `${value.clientId}:${value.commandNo}`) {
    if (!HOST_COMMANDS.includes(value.command as HostCommandName)) throw new ProtocolError("unknown_command", "Unknown host command.");
    hostCommandArgs(value.command as HostCommandName, value.args);
    return value as unknown as HostCommandEnvelope;
  }
  // A login answer may be a secret. It has no command number, so no receipt or digest of it is ever kept.
  if (value.t === "account_answer" && exactKeys(value, ["t", "operationId", "stepId", "value"]) && shortString(value.operationId, 64) && shortString(value.stepId, 64) &&
      typeof value.value === "string" && value.value.length <= LIMITS.accountAnswerChars) return value as unknown as AccountAnswer;
  if (value.t === "host_query" && exactKeys(value, ["t", "reqId", "action", "args"]) && shortString(value.reqId, 64) &&
      HOST_QUERIES.includes(value.action as HostQueryAction)) {
    hostQueryArgs(value.action as HostQueryAction, value.args);
    return value as unknown as HostQuery;
  }
  throw new ProtocolError("invalid_envelope", "Invalid message envelope or command ID.");
}
/** A host path as typed or picked: absolute, bounded, and free of NUL. It is only ever passed to file APIs. */
function hostPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && value.startsWith("/") && !value.includes("\0");
}
export function hostCommandArgs(command: HostCommandName, value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new ProtocolError("invalid_args", "Command args must be an object.");
  if (command === "project_open") {
    if (!exactKeys(value, ["path", "trust"]) || !hostPath(value.path) || (value.trust !== undefined && value.trust !== "remember" && value.trust !== "withhold"))
      throw new ProtocolError("invalid_args", "Provide an absolute directory path and, when asked, a trust choice.");
  } else if (command === "project_create") {
    if (!exactKeys(value, ["parent", "name"]) || !hostPath(value.parent) || typeof value.name !== "string" || value.name.length > 255)
      throw new ProtocolError("invalid_args", "Provide an existing parent directory and one folder name.");
  } else if (command === "project_remove") {
    if (!exactKeys(value, ["path"]) || !hostPath(value.path)) throw new ProtocolError("invalid_args", "Provide the project path to remove from the list.");
  } else if (command === "account_begin") {
    if (!exactKeys(value, ["provider", "method"]) || !shortString(value.provider, 128) || (value.method !== "api_key" && value.method !== "oauth"))
      throw new ProtocolError("invalid_args", "Provide a provider and a login method.");
  } else if (command === "account_cancel") {
    if (!exactKeys(value, ["operationId"]) || !shortString(value.operationId, 64)) throw new ProtocolError("invalid_args", "Provide the operation to cancel.");
  } else if (command === "account_logout") {
    if (!exactKeys(value, ["provider"]) || !shortString(value.provider, 128)) throw new ProtocolError("invalid_args", "Provide the provider to sign out of.");
  } else if (command === "project_relocate") {
    if (!exactKeys(value, ["from", "to"]) || !hostPath(value.from) || !hostPath(value.to)) throw new ProtocolError("invalid_args", "Provide the listed project path and its new directory.");
  } else if (Object.keys(value).length) throw new ProtocolError("invalid_args", "This host command takes no arguments.");
  return value;
}
export function hostQueryArgs(action: HostQueryAction, value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new ProtocolError("invalid_args", "Query args must be an object.");
  if (action === "directories") {
    if (!exactKeys(value, ["path"]) || (value.path !== undefined && !hostPath(value.path))) throw new ProtocolError("invalid_args", "Provide an absolute directory path.");
  } else if (action === "project_inspect") {
    if (!exactKeys(value, ["path"]) || !hostPath(value.path)) throw new ProtocolError("invalid_args", "Provide an absolute directory path.");
  } else if (Object.keys(value).length) throw new ProtocolError("invalid_args", "This query takes no arguments.");
  return value;
}
export function workbenchArgs(action: WorkbenchQuery["action"], value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new ProtocolError("invalid_args", "Query args must be an object.");
  if (action === "sessions") {
    if (!exactKeys(value, ["query", "scope"]) || (value.query !== undefined && (typeof value.query !== "string" || value.query.length > 256)) ||
        (value.scope !== undefined && value.scope !== "workspace" && value.scope !== "all"))
      throw new ProtocolError("invalid_args", "Provide a search query and workspace or all scope.");
  } else if (action === "files") {
    if (!exactKeys(value, ["query"]) || (value.query !== undefined && (typeof value.query !== "string" || value.query.length > 256)))
      throw new ProtocolError("invalid_args", "File search is limited to 256 characters.");
  } else if (action === "file" || action === "git_diff") {
    if (!exactKeys(value, ["path"]) || !shortString(value.path, 4096))
      throw new ProtocolError("invalid_args", "Provide one workspace-relative file path.");
  } else if (Object.keys(value).length) throw new ProtocolError("invalid_args", "This query takes no arguments.");
  return value;
}
export function commandArgs(command: string, value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new ProtocolError("invalid_args", "Command args must be an object.");
  if (command === "prompt") {
    const images = value.images === undefined ? [] : validateImages(value.images);
    if (!exactKeys(value, ["text", "mode", "images"]) || typeof value.text !== "string" || value.text.length > LIMITS.promptBytes ||
      (!value.text.trim() && !images.length) || new TextEncoder().encode(value.text).length > LIMITS.promptBytes ||
      (value.mode !== undefined && value.mode !== "steer" && value.mode !== "followUp"))
      throw new ProtocolError("invalid_args", "Provide text up to 64 KiB, or at least one image.");
  } else if (command === "set_model") {
    if (!exactKeys(value, ["provider", "id"]) || !shortString(value.provider) || !shortString(value.id))
      throw new ProtocolError("invalid_args", "Provide a model provider and ID.");
  } else if (command === "set_thinking") {
    if (!exactKeys(value, ["level"]) || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(value.level)))
      throw new ProtocolError("invalid_args", "Invalid thinking level.");
  } else if (command === "session_switch") {
    if (!exactKeys(value, ["sessionId"]) || !shortString(value.sessionId)) throw new ProtocolError("invalid_args", "Provide a session ID from the catalog.");
  } else if (command === "session_fork") {
    if (!exactKeys(value, ["entryId"]) || !shortString(value.entryId))
      throw new ProtocolError("invalid_args", "Provide a user message entry ID to fork before it.");
  } else if (command === "session_rename") {
    if (!exactKeys(value, ["name"]) || !shortString(value.name, 256) || !value.name.trim() || /[\u0000-\u001f\u007f]/u.test(value.name))
      throw new ProtocolError("invalid_args", "Provide a session name up to 256 characters.");
  } else if (command === "run_command") {
    if (!exactKeys(value, ["name", "args"]) || !isCommandInvocationName(value.name) ||
        (value.args !== undefined && (typeof value.args !== "string" || new TextEncoder().encode(value.args).length > 8192)))
      throw new ProtocolError("invalid_args", "Provide a registered command name and up to 8 KiB of arguments.");
  } else if (["abort", "compact", "session_new", "session_clone", "access_rotate"].includes(command)) {
    if (Object.keys(value).length) throw new ProtocolError("invalid_args", "This command takes no arguments.");
  } else throw new ProtocolError("unknown_command", "Unknown command.");
  return value;
}
// ---------------------------------------------------------------------------
// Images. Shared by the browser (before upload) and the extension (before dispatch).
// ---------------------------------------------------------------------------

export interface PromptImage { mimeType: ImageType; data: string }
export interface ImageInfo { mimeType: ImageType; width: number; height: number }

// A single character class scans linearly; grouped quantifiers overflow the stack on megabyte inputs.
const NOT_BASE64 = /[^A-Za-z0-9+/]/;
/** Decoded length of padded base64, or -1 when the text is not padded base64. */
export function base64Length(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  if (data.length % 4 !== 0 || NOT_BASE64.test(data.slice(0, data.length - padding))) return -1;
  return data.length / 4 * 3 - padding;
}
export function decodeBase64(data: string, maxBytes = Infinity): Uint8Array {
  const length = Math.min(base64Length(data), maxBytes);
  const prefix = maxBytes === Infinity ? data : data.slice(0, Math.ceil(maxBytes / 3) * 4);
  const globals = globalThis as { Buffer?: { from(text: string, encoding: string): Uint8Array } };
  if (globals.Buffer) return globals.Buffer.from(prefix, "base64").subarray(0, length);
  const binary = atob(prefix);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.subarray(0, length);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
const u32le = (b: Uint8Array, i: number) => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

/**
 * Identifies PNG, JPEG or WebP from the file structure (not the declared type) and reads its dimensions.
 * `complete` also checks the end of the file, so truncated uploads fail; header-only reads skip it.
 */
export function inspectImage(bytes: Uint8Array, complete = true): ImageInfo | null {
  if (bytes.length >= 33 && u32be(bytes, 0) === 0x89504e47 && u32be(bytes, 4) === 0x0d0a1a0a) {
    if (u32be(bytes, 8) !== 13 || ascii(bytes, 12, 4) !== "IHDR" || crc32(bytes, 12, 29) !== u32be(bytes, 29)) return null;
    if (complete && (bytes.length < 45 || ascii(bytes, bytes.length - 8, 4) !== "IEND" || u32be(bytes, bytes.length - 12) !== 0)) return null;
    return { mimeType: "image/png", width: u32be(bytes, 16), height: u32be(bytes, 20) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    let i = 2;
    while (i + 4 <= bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1]!;
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      if (marker === 0xd9 || marker === 0xda) return null; // Image data before any frame header.
      const length = u16be(bytes, i + 2);
      if (length < 2 || i + 2 + length > bytes.length) return null;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        if (length < 7) return null;
        if (complete && !(bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) && !hasEoi(bytes)) return null;
        return { mimeType: "image/jpeg", width: u16be(bytes, i + 7), height: u16be(bytes, i + 5) };
      }
      i += 2 + length;
    }
    return null;
  }
  if (bytes.length >= 30 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    if (complete && u32le(bytes, 4) + 8 !== bytes.length) return null;
    const chunk = ascii(bytes, 12, 4);
    if (chunk === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a)
      return { mimeType: "image/webp", width: (bytes[26]! | (bytes[27]! << 8)) & 0x3fff, height: (bytes[28]! | (bytes[29]! << 8)) & 0x3fff };
    if (chunk === "VP8L" && bytes[20] === 0x2f) {
      const bits = u32le(bytes, 21);
      return { mimeType: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X")
      return { mimeType: "image/webp", width: (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)) + 1, height: (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) + 1 };
    return null;
  }
  return null;
}
/** Some encoders append padding after the end-of-image marker. */
function hasEoi(bytes: Uint8Array): boolean {
  for (let i = bytes.length - 2; i >= Math.max(2, bytes.length - 4096); i--) if (bytes[i] === 0xff && bytes[i + 1] === 0xd9) return true;
  return false;
}

/** Validates prompt images: count, type, canonical base64, size, structure and decoded pixel count. */
export function validateImages(value: unknown): PromptImage[] {
  if (!Array.isArray(value) || value.length > LIMITS.maxImages)
    throw new ProtocolError("invalid_image", `Attach at most ${LIMITS.maxImages} images.`);
  let total = 0;
  return value.map((image, index) => {
    const label = `Image ${index + 1}`;
    if (!isRecord(image) || !exactKeys(image, ["mimeType", "data"]) || !IMAGE_TYPES.includes(image.mimeType as ImageType) || typeof image.data !== "string")
      throw new ProtocolError("invalid_image", `${label}: only PNG, JPEG and WebP images are accepted.`);
    const size = base64Length(image.data);
    if (size <= 0) throw new ProtocolError("invalid_image", `${label}: the data is not valid base64.`);
    if (size > LIMITS.imageBytes) throw new ProtocolError("image_too_large", `${label} exceeds 5 MiB.`);
    total += size;
    if (total > LIMITS.imagesTotalBytes) throw new ProtocolError("image_too_large", "Images exceed 10 MiB in total.");
    const info = inspectImage(decodeBase64(image.data));
    if (!info) throw new ProtocolError("invalid_image", `${label} is damaged or not a PNG, JPEG or WebP file.`);
    if (info.mimeType !== image.mimeType) throw new ProtocolError("invalid_image", `${label} is ${info.mimeType}, not ${image.mimeType}.`);
    if (!info.width || !info.height || info.width * info.height > LIMITS.imagePixels)
      throw new ProtocolError("image_too_large", `${label} exceeds 20 million pixels.`);
    return { mimeType: info.mimeType, data: image.data };
  });
}

export function toWireError(error: unknown): WireError {
  return error instanceof ProtocolError
    ? { code: error.code, message: error.message }
    : { code: "operation_failed", message: error instanceof Error ? error.message : "Operation failed." };
}

// ---------------------------------------------------------------------------
// Projection reducer shared by the browser and the integration harnesses.
// ---------------------------------------------------------------------------

export function isTextContent(content: ContentView): content is TextContentView {
  return content.type === "text" || content.type === "thinking" || content.type === "diff";
}

/** Server side: the ops that turn `prev` into `next`, or null when a full replacement is required. */
export function diffMessage(prev: MessageView, next: MessageView): DeltaOp[] | null {
  if (prev.id !== next.id || prev.role !== next.role || prev.status !== next.status || prev.entryId !== next.entryId ||
      prev.toolCallId !== next.toolCallId || prev.toolName !== next.toolName || prev.isError !== next.isError ||
      prev.truncated !== next.truncated || next.content.length < prev.content.length) return null;
  const ops: DeltaOp[] = [];
  for (let i = 0; i < next.content.length; i++) {
    const before = prev.content[i];
    const after = next.content[i]!;
    if (!before) { ops.push({ i, set: after }); continue; }
    const timingChanged = before.type === "thinking" && after.type === "thinking" &&
      (before.durationMs !== after.durationMs || before.timingStatus !== after.timingStatus);
    if (isTextContent(before) && isTextContent(after) && before.type === after.type && !timingChanged && after.text.startsWith(before.text)) {
      if (after.text.length !== before.text.length || after.total !== before.total)
        ops.push({ i, append: after.text.slice(before.text.length), ...(after.total !== undefined ? { total: after.total } : {}) });
      continue;
    }
    if (JSON.stringify(before) !== JSON.stringify(after)) ops.push({ i, set: after });
  }
  return ops;
}

export function applyDelta(message: MessageView, ops: readonly DeltaOp[]): MessageView {
  const content = [...message.content];
  for (const op of ops) {
    if (!Number.isSafeInteger(op.i) || op.i < 0 || op.i > content.length) throw new Error("delta index");
    if ("set" in op) { content[op.i] = op.set; continue; }
    const block = content[op.i];
    if (!block || !isTextContent(block) || typeof op.append !== "string") throw new Error("delta target");
    const text = block.text + op.append;
    const next = { ...block, text } as TextContentView;
    if (op.total !== undefined) next.total = op.total; else delete next.total;
    content[op.i] = next;
  }
  return { ...message, content };
}

function upsertById<T extends { id: string; entryId?: string }>(items: readonly T[], item: T): T[] {
  const index = items.findIndex((existing) => existing.id === item.id || (!!item.entryId && existing.entryId === item.entryId));
  if (index < 0) return [...items, item];
  const next = [...items];
  next[index] = item;
  return next;
}

export function boundedTools(tools: readonly ToolView[], latestId?: string): ToolView[] {
  const result = [...tools];
  while (result.length > LIMITS.retainCompletedTools) {
    const index = result.findIndex((tool) => tool.status !== "running" && tool.id !== latestId);
    if (index < 0) break;
    result.splice(index, 1);
  }
  return result.slice(-LIMITS.maxTools);
}

export interface ProjectionState {
  session: SessionView;
  state: StateView;
  theme: Record<string, string>;
}
/** Applies one sequenced event. Throws on malformed input so callers can resync. */
export function applyProjectionEvent<T extends ProjectionState>(current: T, ev: ProjectionEvent): T {
  const next = { ...current, session: { ...current.session }, state: { ...current.state } };
  switch (ev.type) {
    case "msg_start": case "msg_end": {
      if (!ev.message || typeof ev.message.id !== "string" || !Array.isArray(ev.message.content)) throw new Error("message shape");
      next.session.messages = upsertById(current.session.messages, ev.message);
      break;
    }
    case "msg_delta": {
      if ("message" in ev) {
        if (!ev.message || !Array.isArray(ev.message.content)) throw new Error("message shape");
        next.session.messages = upsertById(current.session.messages, ev.message);
        break;
      }
      const index = current.session.messages.findIndex((message) => message.id === ev.id);
      if (index < 0 || !Array.isArray(ev.ops)) throw new Error("delta for unknown message");
      const messages = [...current.session.messages];
      messages[index] = applyDelta(messages[index]!, ev.ops);
      next.session.messages = messages;
      break;
    }
    case "history_window":
      if (!Array.isArray(ev.messages)) throw new Error("history shape");
      next.session.messages = ev.messages;
      next.session.olderCursor = ev.olderCursor;
      break;
    case "tool_start": case "tool_update": case "tool_end":
      if (!ev.tool || typeof ev.tool.id !== "string") throw new Error("tool shape");
      next.state.tools = boundedTools(upsertById(current.state.tools, ev.tool), ev.tool.id);
      break;
    case "agent_state":
      // Tool progress travels as tool_* events; agent_state never replaces the tool list.
      next.state = { ...ev.state, tools: current.state.tools };
      break;
    case "session_meta":
      next.session.name = typeof ev.name === "string" ? ev.name : undefined;
      break;
    case "theme":
      if (ev.theme) next.theme = ev.theme;
      break;
    default:
      throw new Error("unknown event");
  }
  return next;
}

/** Prepends an older history page, keeping identity unique. */
export function mergeOlderPage(messages: readonly MessageView[], page: readonly MessageView[]): MessageView[] {
  const known = new Set(messages.map((message) => message.entryId ?? message.id));
  return [...page.filter((message) => !known.has(message.entryId ?? message.id)), ...messages];
}

const encoder = new TextEncoder();
const sizes = new WeakMap<object, number>();
export function encodedSize(value: object): number {
  let size = sizes.get(value);
  if (size === undefined) { size = encoder.encode(JSON.stringify(value)).byteLength; sizes.set(value, size); }
  return size;
}
