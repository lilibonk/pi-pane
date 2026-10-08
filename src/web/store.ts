import { createStore } from "zustand/vanilla";
import type { CommandName, MessageView, Snapshot } from "../protocol/index.js";
import { LIMITS, applyProjectionEvent, boundedTools, encodedSize, isTextContent, mergeOlderPage } from "../protocol/index.js";
export type { ContentView, MessageView, Snapshot, ToolView } from "../protocol/index.js";

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
/** Full text of a block read through content_page, keyed by `${messageId}#${index}`. */
export interface Expansion { text: string; total: number; loading: boolean; error?: string; capped?: boolean }

export interface WebState {
  connection: Connection;
  notice: string;
  snapshot: Snapshot | null;
  clientId: string | null;
  nextCommandNo: number;
  lastAppliedSeq: number;
  draft: string;
  submissions: Submission[];
  /** Pending history_page request, if any. */
  historyLoading: boolean;
  historyError: string;
  expansions: Record<string, Expansion>;
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
  historyLoading: false,
  historyError: "",
  expansions: {},
}));

const TOKEN_KEY = "pi-pane.token";
const CLIENT_KEY = "pi-pane.clientId";
/** Upper bound for one block expanded in the browser. */
const EXPANSION_CHARS = 4 * 1024 * 1024;
let socket: WebSocket | null = null;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let attempt = 0;
let stopped = false;
let authToken = "";
let requestNo = 0;
let historyRequest: string | undefined;
const contentRequests = new Map<string, string>();
let assembling: { id: string; parts: number; chunks: string[] } | undefined;

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
  resetReads();
  webStore.setState({ connection: "resyncing", notice: message });
  send({ t: "resync" });
}

/** Read requests belong to one epoch; a new snapshot discards their pending state. */
function resetReads() {
  historyRequest = undefined;
  contentRequests.clear();
  webStore.setState({ historyLoading: false, historyError: "", expansions: {} });
}

/** Keeps the retained history within the browser cache by evicting the oldest persisted messages. */
function capHistory(snapshot: Snapshot): Snapshot {
  const messages = snapshot.session.messages;
  let bytes = 0;
  for (const message of messages) bytes += encodedSize(message);
  if (bytes <= LIMITS.clientCacheBytes) return snapshot;
  let first = 0;
  while (first < messages.length - 1 && bytes > LIMITS.clientCacheBytes && messages[first]!.entryId) {
    bytes -= encodedSize(messages[first]!);
    first++;
  }
  const kept = messages.slice(first);
  const cursor = kept.find(message => message.entryId)?.entryId ?? snapshot.session.olderCursor;
  return { ...snapshot, session: { ...snapshot.session, messages: kept, olderCursor: cursor } };
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
      resetReads();
      const snapshot = capHistory({ ...frame, state: { ...frame.state, tools: boundedTools(frame.state.tools) } } as Snapshot);
      webStore.setState({ snapshot, lastAppliedSeq: frame.seq, connection: "online", notice: "" });
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
      const next = capHistory(applyProjectionEvent(snapshot, frame.ev));
      webStore.setState({ snapshot: next, lastAppliedSeq: frame.seq });
      break;
    }
    case "history_page": {
      const snapshot = current.snapshot;
      if (frame.reqId !== historyRequest) return;
      historyRequest = undefined;
      if (!snapshot || frame.epoch !== snapshot.epoch || !Array.isArray(frame.messages)) { webStore.setState({ historyLoading: false }); return; }
      const messages = mergeOlderPage(snapshot.session.messages, frame.messages);
      let bytes = 0;
      for (const message of messages) bytes += encodedSize(message);
      if (bytes > LIMITS.clientCacheBytes) {
        webStore.setState({ historyLoading: false, historyError: "已达到浏览器保留历史的上限（16 MiB）。更早的内容请在终端查看。" });
        return;
      }
      webStore.setState({ historyLoading: false, historyError: "",
        snapshot: { ...snapshot, session: { ...snapshot.session, messages, olderCursor: frame.olderCursor ?? null } } });
      break;
    }
    case "content_page": {
      const key = contentRequests.get(frame.reqId);
      if (!key) return;
      contentRequests.delete(frame.reqId);
      const expansion = current.expansions[key];
      if (!expansion || frame.epoch !== current.snapshot?.epoch || typeof frame.text !== "string" ||
          frame.offset !== expansion.text.length || !Number.isSafeInteger(frame.total)) {
        setExpansion(key, { ...(expansion ?? { text: "", total: 0 }), loading: false, error: "内容已变化，请重试。" });
        return;
      }
      const text = expansion.text + frame.text;
      const capped = text.length >= EXPANSION_CHARS && text.length < frame.total;
      const done = text.length >= frame.total || capped || !frame.text.length;
      setExpansion(key, { text, total: frame.total, loading: !done, capped });
      if (!done) requestContent(key, text.length);
      break;
    }
    case "session_reset":
      uncertainSubmissions(frame.epoch);
      resetReads();
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
      if (typeof frame.reqId === "string") {
        if (frame.reqId === historyRequest) {
          historyRequest = undefined;
          webStore.setState({ historyLoading: false, historyError: code === "stale_session" ? "会话已变化，请稍候重试。" : message });
        }
        const key = contentRequests.get(frame.reqId);
        if (key) {
          contentRequests.delete(frame.reqId);
          const expansion = webStore.getState().expansions[key];
          setExpansion(key, { ...(expansion ?? { text: "", total: 0 }), loading: false, error: message });
        }
        return;
      }
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
  }
}

/** Reassembles frame_begin / frame_chunk / frame_end before handling the logical frame. */
function receive(raw: unknown) {
  const frame = raw as Record<string, any> | null;
  if (frame?.t === "frame_begin") {
    if (assembling || typeof frame.id !== "string" || !Number.isSafeInteger(frame.parts) || frame.parts < 1 ||
        frame.parts > Math.ceil(LIMITS.logicalFrameBytes / 1024)) throw new Error("frame_begin");
    assembling = { id: frame.id, parts: frame.parts, chunks: [] };
    return;
  }
  if (frame?.t === "frame_chunk") {
    if (!assembling || frame.id !== assembling.id || frame.index !== assembling.chunks.length || typeof frame.data !== "string") throw new Error("frame_chunk");
    assembling.chunks.push(frame.data);
    return;
  }
  if (frame?.t === "frame_end") {
    const done = assembling;
    assembling = undefined;
    if (!done || frame.id !== done.id || done.chunks.length !== done.parts) throw new Error("frame_end");
    handleFrame(JSON.parse(done.chunks.join("")));
    return;
  }
  if (assembling) { assembling = undefined; throw new Error("interleaved frame"); }
  handleFrame(raw);
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
  assembling = undefined;
  ws.onopen = () => {
    if (socket !== ws) return;
    send({ t: "hello", ...(readSession(CLIENT_KEY) ? { clientId: readSession(CLIENT_KEY) } : {}) });
  };
  ws.onmessage = event => {
    if (socket !== ws) return;
    try { receive(JSON.parse(event.data)); }
    catch { assembling = undefined; resync("收到无法识别的状态数据，正在重新同步…"); }
  };
  ws.onclose = event => {
    if (socket !== ws) return;
    socket = null;
    assembling = undefined;
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
    if (event.reason === "frame_limit") {
      stopped = true;
      webStore.setState({ connection: "fatal", notice: "当前状态超过单帧资源上限，请在终端查看当前会话。" });
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
    webStore.setState({ notice: "文本超过 64 KiB 上限，请缩短后提交。" });
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

/** Loads the page of history before the oldest retained message. Read-only; never calls the host. */
export function loadOlder() {
  const state = webStore.getState();
  const snapshot = state.snapshot;
  if (historyRequest || state.connection !== "online" || !snapshot?.session.olderCursor) return;
  const reqId = `h${++requestNo}`;
  if (!send({ t: "history_page", reqId, epoch: snapshot.epoch, sessionId: snapshot.session.id,
    branchRevision: snapshot.session.branchRevision, before: snapshot.session.olderCursor })) return;
  historyRequest = reqId;
  webStore.setState({ historyLoading: true, historyError: "" });
}

function setExpansion(key: string, expansion: Expansion) {
  webStore.setState(state => ({ expansions: { ...state.expansions, [key]: expansion } }));
}
function requestContent(key: string, offset: number) {
  const snapshot = webStore.getState().snapshot;
  const [messageId, index] = [key.slice(0, key.lastIndexOf("#")), Number(key.slice(key.lastIndexOf("#") + 1))];
  const reqId = `c${++requestNo}`;
  if (!snapshot || !send({ t: "content_page", reqId, epoch: snapshot.epoch, messageId, index, offset })) {
    const expansion = webStore.getState().expansions[key];
    setExpansion(key, { ...(expansion ?? { text: "", total: 0 }), loading: false, error: "连接不可用。" });
    return;
  }
  contentRequests.set(reqId, key);
}
/** Reads the full text of a truncated block page by page. */
export function expandContent(message: MessageView, index: number) {
  const block = message.content[index];
  if (!block || !isTextContent(block) || block.total === undefined) return;
  const key = `${message.id}#${index}`;
  const existing = webStore.getState().expansions[key];
  if (existing?.loading) return;
  setExpansion(key, { text: "", total: block.total, loading: true });
  requestContent(key, 0);
}
export function collapseContent(message: MessageView, index: number) {
  const key = `${message.id}#${index}`;
  webStore.setState(state => {
    const expansions = { ...state.expansions };
    delete expansions[key];
    return { expansions };
  });
}
