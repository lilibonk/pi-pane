/** Wire contract. Only broadcast events consume sequence numbers. */
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
} as const;

export const COMMANDS = ["prompt", "abort", "set_model", "set_thinking", "compact"] as const;
export type CommandName = (typeof COMMANDS)[number];

/** `total` is present when `text` is a prefix of a longer block readable through content_page. */
export type ContentView =
  | { type: "text"; text: string; total?: number }
  | { type: "thinking"; text: string; total?: number }
  | { type: "diff"; text: string; total?: number }
  | { type: "toolCall"; id: string; name: string; arguments: unknown; argsTruncated?: boolean };
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
  /** Entry ID to pass as history_page `before`; null when the window starts at the branch root. */
  olderCursor: string | null;
}
export interface Caps {
  commands: readonly CommandName[];
  images: false;
  promptReceipt: "dispatch_only";
  queueView: "boolean";
  terminalDialogs: true;
  history: "paged";
  content: "paged";
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
  | { t: "receipt_query"; clientId: string; id: string }
  | HistoryPageRequest
  | ContentPageRequest
  | CommandEnvelope;
export type ServerMessage =
  | { t: "welcome"; clientId: string; leaseExpiresAt: number; nextCommandNo: number }
  | Snapshot
  | { t: "event"; epoch: string; seq: number; ev: ProjectionEvent }
  | { t: "session_reset"; epoch: string; sessionId: string; branchRevision: number; reason: string }
  | { t: "switching"; reason: string }
  | { t: "notice"; message: string }
  | { t: "error"; error: WireError; nextCommandNo?: number; reqId?: string }
  | Ack
  | CommandResult
  | HistoryPage
  | ContentPage;
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
export function parseClientMessage(value: unknown): ClientMessage {
  if (!isRecord(value)) throw new ProtocolError("invalid_envelope", "Expected a JSON object.");
  if (value.t === "hello" && exactKeys(value, ["t", "clientId"]) &&
      (value.clientId === undefined || shortString(value.clientId))) return value as ClientMessage;
  if (value.t === "resync" && exactKeys(value, ["t"])) return { t: "resync" };
  if (value.t === "receipt_query" && exactKeys(value, ["t", "clientId", "id"]) &&
      shortString(value.clientId) && shortString(value.id)) return value as ClientMessage;
  if (value.t === "history_page" && exactKeys(value, ["t", "reqId", "epoch", "sessionId", "branchRevision", "before"]) &&
      shortString(value.reqId, 64) && shortString(value.epoch) && shortString(value.sessionId) &&
      nonNegativeInt(value.branchRevision) && shortString(value.before)) return value as unknown as HistoryPageRequest;
  if (value.t === "content_page" && exactKeys(value, ["t", "reqId", "epoch", "messageId", "index", "offset"]) &&
      shortString(value.reqId, 64) && shortString(value.epoch) && shortString(value.messageId) &&
      nonNegativeInt(value.index) && (value.index as number) < 1024 && nonNegativeInt(value.offset)) return value as unknown as ContentPageRequest;
  if (value.t === "command" && exactKeys(value, ["t", "clientId", "commandNo", "id", "epoch", "sessionId", "branchRevision", "command", "args"]) &&
      shortString(value.clientId) && shortString(value.id) && shortString(value.epoch) && shortString(value.sessionId) &&
      shortString(value.command, 64) && Number.isSafeInteger(value.commandNo) && (value.commandNo as number) >= 1 &&
      nonNegativeInt(value.branchRevision) && "args" in value &&
      value.id === `${value.clientId}:${value.commandNo}`) return value as unknown as CommandEnvelope;
  throw new ProtocolError("invalid_envelope", "Invalid message envelope or command ID.");
}
export function commandArgs(command: string, value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new ProtocolError("invalid_args", "Command args must be an object.");
  if (command === "prompt") {
    if (!exactKeys(value, ["text", "mode"]) || !shortString(value.text, 65_536) ||
      !value.text.trim() || new TextEncoder().encode(value.text).length > 65_536 ||
      (value.mode !== undefined && value.mode !== "steer" && value.mode !== "followUp"))
      throw new ProtocolError("invalid_args", "Provide nonempty text up to 64 KiB; image upload is not available yet.");
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
    if (isTextContent(before) && isTextContent(after) && before.type === after.type && after.text.startsWith(before.text)) {
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
