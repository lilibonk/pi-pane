import { createStore } from "zustand/vanilla";
import type { CommandName, MessageView, ProjectionEvent, Snapshot, ToolView } from "../protocol/index.js";
import { M0_MAX_MESSAGES, M0_MESSAGE_BYTES, M0_MAX_TOOLS, M0_RETAIN_COMPLETED_TOOLS } from "../protocol/index.js";
export type { MessageView, Snapshot, ToolView } from "../protocol/index.js";

export type Connection = "connecting" | "online" | "resyncing" | "switching" | "disconnected" | "fatal";
type ReceiptStatus = "sent" | "dispatched" | "rejected" | "unknown" | "completed" | "failed";
export interface Submission {
  id: string;
  epoch: string;
  command: string;
  text?: string;
  mode?: "followUp" | "steer";
  status: ReceiptStatus;
  at: number;
  explanation?: string;
}

export interface WebState {
  connection: Connection;
  notice: string;
  snapshot: Snapshot | null;
  clientId: string | null;
  nextCommandNo: number;
  lastAppliedSeq: number;
  draft: string;
  submissions: Submission[];
}

export const webStore = createStore<WebState>(() => ({
  connection: "connecting",
  notice: "正在连接当前 pi 会话…",
  snapshot: null,
  clientId: null,
  nextCommandNo: 1,
  lastAppliedSeq: 0,
  draft: "",
  submissions: [],
}));

const TOKEN_KEY = "pi-pane.token";
const CLIENT_KEY = "pi-pane.clientId";
let socket: WebSocket | null = null;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let attempt = 0;
let stopped = false;
let authToken = "";

function readSession(key: string): string | null {
  try { return sessionStorage.getItem(key); } catch { return null; }
}
function saveSession(key: string, value: string) {
  try { sessionStorage.setItem(key, value); } catch { /* Memory-only also works. */ }
}
function clearSession(key: string) {
  try { sessionStorage.removeItem(key); } catch { /* Storage may be disabled. */ }
}

function receiveToken() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const supplied = fragment.get("t") ?? fragment.get("token");
  if (supplied) {
    if (supplied !== readSession(TOKEN_KEY)) clearSession(CLIENT_KEY);
    authToken = supplied;
    saveSession(TOKEN_KEY, supplied);
    // The address bar, browser history and subsequent copied links no longer expose the token.
    fragment.delete("t");
    fragment.delete("token");
    const remainder = fragment.toString();
    history.replaceState(null, "", location.pathname + location.search + (remainder ? `#${remainder}` : ""));
  } else {
    authToken = readSession(TOKEN_KEY) ?? "";
  }
}

function updateSubmission(id: string, update: Partial<Submission>) {
  webStore.setState(state => ({
    submissions: state.submissions.map(item => item.id === id ? { ...item, ...update } : item),
  }));
}

function uncertainSubmissions(epoch?: string) {
  webStore.setState(state => ({
    submissions: state.submissions.map(item =>
      (item.status === "sent" || (epoch && item.epoch !== epoch && item.status === "dispatched"))
        ? { ...item, status: "unknown", explanation: "连接或会话已改变；结果未知。请检查终端，勿直接重复发送。" }
        : item,
    ),
  }));
}

function send(frame: unknown): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(frame));
  return true;
}

function resync(message: string) {
  if (webStore.getState().connection === "resyncing") return;
  webStore.setState({ connection: "resyncing", notice: message });
  send({ t: "resync" });
}

function upsert<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex(existing => existing.id === item.id ||
    ("entryId" in item && item.entryId && "entryId" in existing && existing.entryId === item.entryId));
  if (index < 0) return [...items, item];
  return items.map((existing, i) => i === index ? item : existing);
}

// M0 matches the Bridge's bounded spike window; full history paging is a later milestone.
const encodedSizes = new WeakMap<MessageView, number>();
const encoder = new TextEncoder();
function boundedMessages(messages: MessageView[]): { messages: MessageView[]; truncated: boolean } {
  const window = messages.slice(-M0_MAX_MESSAGES);
  let bytes = 0;
  let first = window.length;
  for (let index = window.length - 1; index >= 0; index--) {
    const message = window[index]!;
    let size = encodedSizes.get(message);
    if (size === undefined) { size = encoder.encode(JSON.stringify(message)).byteLength; encodedSizes.set(message, size); }
    bytes += size;
    if (bytes > M0_MESSAGE_BYTES) break;
    first = index;
  }
  return { messages: window.slice(first), truncated: first > 0 || window.length < messages.length };
}
function boundedTools(tools: ToolView[], latestId?: string): ToolView[] {
  const result = [...tools];
  while (result.length > M0_RETAIN_COMPLETED_TOOLS) {
    const index = result.findIndex(tool => tool.status !== "running" && tool.id !== latestId);
    if (index < 0) break;
    result.splice(index, 1);
  }
  return result.slice(-M0_MAX_TOOLS);
}

function applyEvent(ev: ProjectionEvent, snapshot: Snapshot): Snapshot {
  const next = { ...snapshot, session: { ...snapshot.session }, state: { ...snapshot.state } };
  switch (ev.type) {
    case "msg_start": case "msg_delta": case "msg_end": {
      const message = ev.message as MessageView | undefined;
      if (!message || typeof message.id !== "string" || !Array.isArray(message.content)) throw new Error("message shape");
      const window = boundedMessages(upsert(snapshot.session.messages, message));
      next.session.messages = window.messages;
      next.session.historyTruncated = snapshot.session.historyTruncated || window.truncated;
      break;
    }
    case "tool_start": case "tool_update": case "tool_end": {
      const tool = ev.tool as ToolView | undefined;
      if (!tool || typeof tool.id !== "string") throw new Error("tool shape");
      next.state.tools = boundedTools(upsert(snapshot.state.tools, tool), tool.id);
      break;
    }
    case "agent_state":
      next.state = { ...ev.state, tools: boundedTools(ev.state.tools) };
      break;
    case "session_meta":
      next.session.name = typeof ev.name === "string" ? ev.name : undefined;
      break;
    case "theme":
      if (ev.theme) next.theme = ev.theme as Record<string, string>;
      break;
  }
  return next;
}

function handleFrame(raw: unknown) {
  if (!raw || typeof raw !== "object" || !("t" in raw)) throw new Error("frame shape");
  const frame = raw as Record<string, any>;
  const current = webStore.getState();
  switch (frame.t) {
    case "welcome":
      if (typeof frame.clientId !== "string" || !Number.isSafeInteger(frame.nextCommandNo)) throw new Error("welcome shape");
      saveSession(CLIENT_KEY, frame.clientId);
      webStore.setState({ clientId: frame.clientId, nextCommandNo: frame.nextCommandNo });
      break;
    case "snapshot": {
      if (typeof frame.epoch !== "string" || !Number.isSafeInteger(frame.seq) ||
        !frame.session || !Array.isArray(frame.session.messages) || !frame.state) throw new Error("snapshot shape");
      uncertainSubmissions(frame.epoch);
      const window = boundedMessages(frame.session.messages);
      const bounded = { ...frame, session: { ...frame.session, messages: window.messages,
        historyTruncated: frame.session.historyTruncated || window.truncated },
        state: { ...frame.state, tools: boundedTools(frame.state.tools) } } as Snapshot;
      webStore.setState({ snapshot: bounded, lastAppliedSeq: frame.seq, connection: "online", notice: "" });
      attempt = 0;
      break;
    }
    case "event": {
      const snapshot = current.snapshot;
      if (!snapshot || current.connection !== "online") return;
      if (frame.epoch !== snapshot.epoch) { resync("会话版本已变化，正在重新同步…"); return; }
      if (!Number.isSafeInteger(frame.seq)) throw new Error("event seq");
      if (frame.seq <= current.lastAppliedSeq) return;
      if (frame.seq !== current.lastAppliedSeq + 1) { resync("检测到增量缺口，正在读取完整快照…"); return; }
      const next = applyEvent(frame.ev, snapshot);
      webStore.setState({ snapshot: next, lastAppliedSeq: frame.seq });
      break;
    }
    case "session_reset":
      uncertainSubmissions(frame.epoch);
      webStore.setState({ snapshot: null, lastAppliedSeq: 0, connection: "switching", notice: "终端已切换会话或分支，等待新快照…" });
      break;
    case "switching":
      webStore.setState({ connection: "switching", notice: "终端正在切换会话，写操作暂时暂停…" });
      break;
    case "ack": {
      if (typeof frame.id !== "string") throw new Error("ack id");
      if (Number.isSafeInteger(frame.nextCommandNo)) webStore.setState({ nextCommandNo: Math.max(current.nextCommandNo, frame.nextCommandNo) });
      updateSubmission(frame.id, {
        status: frame.status === "dispatched" ? "dispatched" : "rejected",
        explanation: frame.error?.message,
      });
      break;
    }
    case "command_result":
      updateSubmission(frame.id, { status: frame.status === "completed" ? "completed" : "failed", explanation: frame.error?.message });
      break;
    case "notice":
      webStore.setState({ notice: frame.message ?? frame.notice ?? "请检查终端提示。" });
      break;
    case "error": {
      const code = frame.error?.code;
      const message = frame.error?.message ?? "连接发生错误。";
      if (Number.isSafeInteger(frame.nextCommandNo)) webStore.setState({ nextCommandNo: frame.nextCommandNo });
      if (code === "client_expired" || code === "unauthorized" || code === "auth_failed") {
        stopped = true;
        uncertainSubmissions();
        webStore.setState({ connection: "fatal", notice: message });
        if (code === "client_expired") { clearSession(CLIENT_KEY); webStore.setState({ clientId: null }); }
        socket?.close();
      } else {
        webStore.setState({ notice: message });
      }
      break;
    }
    case "ping": send({ t: "pong" }); break;
  }
}

function connect() {
  if (stopped) return;
  if (!authToken || !/^[A-Za-z0-9_-]+$/.test(authToken)) {
    stopped = true;
    webStore.setState({ connection: "fatal", notice: "缺少有效访问凭据。请在当前终端运行 /web，并打开它给出的链接。" });
    return;
  }
  webStore.setState({ connection: "connecting", notice: "正在连接当前 pi 会话…" });
  const wsUrl = new URL("/ws", location.href);
  wsUrl.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(wsUrl, ["pi-pane.v1", `pi-pane.bearer.${authToken}`]);
  socket = ws;
  ws.onopen = () => {
    if (socket !== ws) return;
    send({ t: "hello", ...(readSession(CLIENT_KEY) ? { clientId: readSession(CLIENT_KEY) } : {}) });
  };
  ws.onmessage = event => {
    if (socket !== ws) return;
    try { handleFrame(JSON.parse(event.data)); }
    catch { resync("收到无法识别的状态数据，正在重新同步…"); }
  };
  ws.onclose = event => {
    if (socket !== ws) return;
    socket = null;
    uncertainSubmissions();
    if (stopped) return;
    if (event.reason === "connection_replaced" || event.reason === "client_expired") {
      stopped = true;
      clearSession(CLIENT_KEY);
      webStore.setState({ clientId: null, connection: "fatal", notice: event.reason === "connection_replaced"
        ? "当前连接已被另一标签页接管。点击重新连接可创建新的客户端身份；未确认操作不会重发。"
        : "客户端租约已过期。点击重新连接可创建新的身份；之前的提交结果仍需检查终端。" });
      return;
    }
    if (event.reason === "spike_snapshot_limit") {
      stopped = true;
      webStore.setState({ connection: "fatal", notice: "快照超过 M0 的资源上限，请在终端查看当前会话。" });
      return;
    }
    if (event.reason === "token_rotated") {
      stopped = true;
      clearSession(TOKEN_KEY);
      authToken = "";
      webStore.setState({ connection: "fatal", notice: "访问凭据已轮换。请在终端运行 /web，打开新的链接。" });
      return;
    }
    if (event.code === 4001 || event.code === 4003 || event.code === 4401 || event.code === 4403) {
      stopped = true;
      webStore.setState({ connection: "fatal", notice: "访问凭据已失效。请在终端重新运行 /web，打开新的链接。" });
      return;
    }
    webStore.setState({ connection: "disconnected", notice: "已断开，正在尝试重连。未确认操作不会自动重发；若终端已关闭，请重新运行 /web。" });
    retryTimer = setTimeout(connect, Math.min(10_000, 500 * 2 ** Math.min(attempt++, 5)));
  };
  ws.onerror = () => { /* onclose carries reconnection state without exposing bearer URLs. */ };
}

export function startConnection() {
  receiveToken();
  stopped = false;
  connect();
}

export function reconnect() {
  clearTimeout(retryTimer);
  socket?.close();
  socket = null;
  stopped = false;
  attempt = 0;
  connect();
}

export function setDraft(draft: string) { webStore.setState({ draft }); }

export function issueCommand(command: CommandName, args: Record<string, unknown> = {}, text?: string, mode?: "followUp" | "steer") {
  const state = webStore.getState();
  const snapshot = state.snapshot;
  if (state.connection !== "online" || !snapshot || !state.clientId || !snapshot.caps.commands.includes(command)) return;
  const commandNo = state.nextCommandNo;
  const id = `${state.clientId}:${commandNo}`;
  const submission: Submission = { id, epoch: snapshot.epoch, command, text, mode, status: "sent", at: Date.now() };
  if (!send({ t: "command", clientId: state.clientId, commandNo, id, epoch: snapshot.epoch,
    sessionId: snapshot.session.id, branchRevision: snapshot.session.branchRevision, command, args })) return;
  webStore.setState({
    nextCommandNo: commandNo + 1,
    submissions: [...state.submissions, submission].slice(-32),
    ...(command === "prompt" ? { draft: "" } : {}),
  });
  setTimeout(() => {
    const item = webStore.getState().submissions.find(entry => entry.id === id);
    if (item?.status === "sent") updateSubmission(id, { status: "unknown", explanation: "尚未收到回执，请检查终端。原文已保留；不会自动重发。" });
  }, 15_000);
}

export function submitPrompt(mode: "followUp" | "steer") {
  const text = webStore.getState().draft;
  if (!text.trim()) return;
  if (new TextEncoder().encode(text).byteLength > 64 * 1024) {
    webStore.setState({ notice: "文本超过 M0 的 64 KiB 上限，请缩短后提交。" });
    return;
  }
  issueCommand("prompt", { text, mode }, text, mode);
}

export function queryReceipt(id: string) {
  const clientId = webStore.getState().clientId;
  if (clientId) send({ t: "receipt_query", clientId, id });
}

export function forgetSubmission(id: string) {
  webStore.setState(state => ({ submissions: state.submissions.filter(item => item.id !== id) }));
}
