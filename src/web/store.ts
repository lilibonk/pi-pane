import { createStore } from "zustand/vanilla";
import type { CommandName, ImageType, MessageView, PromptImage, Snapshot } from "../protocol/index.js";
import { IMAGE_TYPES, LIMITS, applyProjectionEvent, boundedTools, decodeBase64, encodedSize, inspectImage, isTextContent, mergeOlderPage } from "../protocol/index.js";
export type { ContentView, MessageView, Snapshot, ToolView } from "../protocol/index.js";

export type Connection = "connecting" | "login" | "online" | "resyncing" | "switching" | "disconnected" | "fatal";
type ReceiptStatus = "sent" | "dispatched" | "rejected" | "unknown" | "completed" | "failed";
export interface Submission {
  id: string;
  epoch: string;
  command: string;
  text?: string;
  /** Names of attached images; their bytes are not retained after sending. */
  images?: string[];
  mode?: "followUp" | "steer";
  status: ReceiptStatus;
  at: number;
  explanation?: string;
}
/** Full text of a block read through content_page, keyed by `${messageId}#${index}`. */
export interface Expansion { text: string; total: number; loading: boolean; error?: string; capped?: boolean }
/** An image validated in the browser and waiting to be sent with the next prompt. */
export interface Attachment { id: string; name: string; mimeType: ImageType; bytes: number; width: number; height: number; data: string; url: string }
/** A history image read through image_page, keyed by `${messageId}#${index}`. */
export interface LoadedImage { status: "loading" | "ready" | "error"; url?: string; error?: string }

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
  /** Increments on every applied snapshot; drives the snapshot-rendered performance mark. */
  snapshotCount: number;
  authMode: "local" | "password" | null;
  loginError: string;
  loginBusy: boolean;
  attachments: Attachment[];
  attachmentError: string;
  images: Record<string, LoadedImage>;
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
  snapshotCount: 0,
  authMode: null,
  loginError: "",
  loginBusy: false,
  attachments: [],
  attachmentError: "",
  images: {},
}));

const TOKEN_KEY = "pi-pane.token";
const CLIENT_KEY = "pi-pane.clientId";
/** External access: the login session token. The password itself is never stored. */
const SESSION_KEY = "pi-pane.session";
/** Upper bound for one block expanded in the browser. */
const EXPANSION_CHARS = 4 * 1024 * 1024;
let socket: WebSocket | null = null;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let attempt = 0;
let stopped = false;
let authToken = "";
let sessionToken = "";
let opened = false;
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
    if (supplied !== readSession(TOKEN_KEY)) { clearSession(CLIENT_KEY); clearSession(SESSION_KEY); }
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
  sessionToken = readSession(SESSION_KEY) ?? "";
}

// ---------------------------------------------------------------------------
// External access login (§9.2). Same-origin HTTPS only; the WS bearer is the session token.
// ---------------------------------------------------------------------------

async function detectAuthMode(): Promise<"local" | "password"> {
  const response = await fetch("/auth/info", { cache: "no-store", credentials: "omit" });
  if (!response.ok) throw new Error("auth info");
  const body = await response.json() as { mode?: string };
  return body.mode === "password" ? "password" : "local";
}
function requireLogin(notice: string) {
  stopped = true;
  sessionToken = "";
  clearSession(SESSION_KEY);
  clearSession(CLIENT_KEY);
  webStore.setState({ connection: authToken ? "login" : "fatal", clientId: null, loginBusy: false,
    notice: authToken ? notice : "缺少访问链接。请使用终端 /web 给出的链接或 /web qr 的二维码打开。" });
}
export async function login(password: string) {
  if (!authToken || webStore.getState().loginBusy) return;
  webStore.setState({ loginBusy: true, loginError: "" });
  try {
    const response = await fetch("/auth/session", {
      method: "POST", cache: "no-store", credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bootstrapToken: authToken, password }),
    });
    const body = await response.json().catch(() => ({})) as { sessionToken?: string; message?: string };
    if (!response.ok || typeof body.sessionToken !== "string") {
      webStore.setState({ loginBusy: false, loginError: body.message ?? (response.status === 429 ? "登录尝试过多，请稍后再试。" : "登录失败。") });
      return;
    }
    sessionToken = body.sessionToken;
    saveSession(SESSION_KEY, sessionToken);
    clearSession(CLIENT_KEY);
    webStore.setState({ loginBusy: false, loginError: "", clientId: null });
    stopped = false;
    attempt = 0;
    connect();
  } catch {
    webStore.setState({ loginBusy: false, loginError: "无法连接到 pi-pane，请检查网络。" });
  }
}
export async function logout() {
  const token = sessionToken;
  requireLogin("已退出登录。");
  socket?.close();
  if (token) await fetch("/auth/session", { method: "DELETE", cache: "no-store", credentials: "omit", headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined);
}
/** After a failed or closed connection: is the login still valid? Network errors count as valid. */
async function loginValid(): Promise<boolean> {
  try {
    const response = await fetch("/auth/session", { cache: "no-store", credentials: "omit", headers: { Authorization: `Bearer ${sessionToken}` } });
    return response.status !== 401;
  } catch { return true; }
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
  // Loaded images stay cached (their bytes do not change); unfinished reads are retried when visible.
  for (const key of imageRequests.values()) dropImage(key);
  imageRequests.clear();
  imageQueue.length = 0;
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
      webStore.setState(state => ({ snapshot, lastAppliedSeq: frame.seq, connection: "online", notice: "", snapshotCount: state.snapshotCount + 1 }));
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
    case "image_page": {
      const key = imageRequests.get(frame.reqId);
      if (!key) return;
      imageRequests.delete(frame.reqId);
      if (frame.epoch !== current.snapshot?.epoch || typeof frame.data !== "string" || !IMAGE_TYPES.includes(frame.mimeType)) dropImage(key);
      else storeImage(key, frame.mimeType, frame.data);
      pumpImages();
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
        const imageKey = imageRequests.get(frame.reqId);
        if (imageKey) {
          imageRequests.delete(frame.reqId);
          if (code === "stale_session") dropImage(imageKey);
          else setImage(imageKey, { status: "error", error: code === "image_too_large" ? "图片超过浏览器传输上限，请在终端查看。" : message });
          pumpImages();
        }
        return;
      }
      if (Number.isSafeInteger(frame.nextCommandNo)) webStore.setState({ nextCommandNo: frame.nextCommandNo });
      if (code === "client_expired" || code === "unauthorized") {
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
  const mode = webStore.getState().authMode;
  if (mode === null) {
    webStore.setState({ connection: "connecting", notice: "正在连接 pi-pane…" });
    detectAuthMode().then(found => { webStore.setState({ authMode: found }); connect(); }, () => scheduleRetry());
    return;
  }
  if (mode === "password" && !sessionToken) { requireLogin("请输入 pi-pane 访问密码。"); return; }
  const bearer = mode === "password" ? sessionToken : authToken;
  if (!bearer || !/^[A-Za-z0-9_-]+$/.test(bearer)) {
    stopped = true;
    webStore.setState({ connection: "fatal", notice: "缺少有效访问凭据。请在当前终端运行 /web，并打开它给出的链接。" });
    return;
  }
  webStore.setState({ connection: "connecting", notice: "正在连接当前 pi 会话…" });
  const wsUrl = new URL("/ws", location.href);
  wsUrl.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(wsUrl, ["pi-pane.v1", `pi-pane.bearer.${bearer}`]);
  socket = ws;
  opened = false;
  assembling = undefined;
  ws.onopen = () => {
    if (socket !== ws) return;
    opened = true;
    // Measured by the A6 benchmark: WS open → snapshot applied and rendered.
    try { performance.clearMarks("pi-pane:snapshot-rendered"); performance.mark("pi-pane:ws-open"); } catch { /* optional */ }
    send({ t: "hello", ...(readSession(CLIENT_KEY) ? { clientId: readSession(CLIENT_KEY) } : {}) });
  };
  ws.onmessage = event => {
    if (socket !== ws) return;
    try { receive(JSON.parse(event.data)); }
    catch { assembling = undefined; resync("收到无法识别的状态数据，正在重新同步…"); }
  };
  ws.onclose = event => {
    if (socket !== ws) return;
    const wasOpen = opened;
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
      clearSession(SESSION_KEY);
      authToken = "";
      sessionToken = "";
      webStore.setState({ connection: "fatal", notice: "访问凭据已轮换。请在终端运行 /web（或 /web qr），打开新的链接。" });
      return;
    }
    if (event.code === 4401) {
      requireLogin(event.reason === "logged_out" ? "已退出登录。" : "登录已过期或已被撤销，请重新输入密码。");
      return;
    }
    if (mode === "password" && !wasOpen) {
      // A rejected upgrade is indistinguishable from a network failure; ask the server.
      void loginValid().then(valid => {
        if (socket !== null || stopped) return;
        if (!valid) requireLogin("登录已过期或已被撤销，请重新输入密码。");
        else { webStore.setState({ connection: "disconnected", notice: "已断开，正在尝试重连。未确认操作不会自动重发。" }); scheduleRetry(); }
      });
      return;
    }
    if (event.code === 4001 || event.code === 4003 || event.code === 4401 || event.code === 4403) {
      stopped = true;
      webStore.setState({ connection: "fatal", notice: "访问凭据已失效。请在终端重新运行 /web，打开新的链接。" });
      return;
    }
    webStore.setState({ connection: "disconnected", notice: "已断开，正在尝试重连。未确认操作不会自动重发；若终端已关闭，请重新运行 /web。" });
    scheduleRetry();
  };
  ws.onerror = () => { /* onclose carries reconnection state without exposing bearer URLs. */ };
}
function scheduleRetry() {
  if (stopped) return;
  clearTimeout(retryTimer);
  if (webStore.getState().connection !== "disconnected") webStore.setState({ connection: "disconnected", notice: "已断开，正在尝试重连…" });
  retryTimer = setTimeout(connect, Math.min(10_000, 500 * 2 ** Math.min(attempt++, 5)));
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
// Phones suspend background tabs; reconnect promptly when the page becomes visible again.
if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !stopped && webStore.getState().connection === "disconnected") reconnect();
});

export function setDraft(draft: string) { webStore.setState({ draft }); }

export function issueCommand(command: CommandName, args: Record<string, unknown> = {}, text?: string, mode?: "followUp" | "steer") {
  const state = webStore.getState();
  const snapshot = state.snapshot;
  if (state.connection !== "online" || !snapshot || !state.clientId || !snapshot.caps.commands.includes(command)) return;
  const commandNo = state.nextCommandNo;
  const id = `${state.clientId}:${commandNo}`;
  const attached = command === "prompt" ? state.attachments : [];
  const submission: Submission = { id, epoch: snapshot.epoch, command, text, mode, status: "sent", at: Date.now(),
    ...(attached.length ? { images: attached.map(item => item.name) } : {}) };
  if (!send({ t: "command", clientId: state.clientId, commandNo, id, epoch: snapshot.epoch,
    sessionId: snapshot.session.id, branchRevision: snapshot.session.branchRevision, command, args })) return;
  webStore.setState({
    nextCommandNo: commandNo + 1,
    submissions: [...state.submissions, submission].slice(-32),
    ...(command === "prompt" ? { draft: "", attachments: [], attachmentError: "" } : {}),
  });
  if (command === "prompt") for (const item of attached) URL.revokeObjectURL(item.url);
  setTimeout(() => {
    const item = webStore.getState().submissions.find(entry => entry.id === id);
    if (item?.status === "sent") updateSubmission(id, { status: "unknown", explanation: "尚未收到回执，请检查终端。原文已保留；不会自动重发。" });
  }, 15_000);
}

export function submitPrompt(mode: "followUp" | "steer") {
  const { draft: text, attachments } = webStore.getState();
  if (!text.trim() && !attachments.length) return;
  if (new TextEncoder().encode(text).byteLength > LIMITS.promptBytes) {
    webStore.setState({ notice: "文本超过 64 KiB 上限，请缩短后提交。" });
    return;
  }
  const images: PromptImage[] = attachments.map(item => ({ mimeType: item.mimeType, data: item.data }));
  issueCommand("prompt", { text, mode, ...(images.length ? { images } : {}) }, text, mode);
}

// ---------------------------------------------------------------------------
// Prompt images: validated here first (type, size, structure, pixels, decodability), again by the extension.
// ---------------------------------------------------------------------------

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
async function decodable(blob: Blob): Promise<boolean> {
  try { const bitmap = await createImageBitmap(blob); bitmap.close(); return true; } catch { return false; }
}
let attachmentNo = 0;
let attaching: Promise<void> = Promise.resolve();
/** Paste, drop and the picker may fire together; attachments are validated one batch at a time. */
export function addImages(files: readonly File[]): Promise<void> {
  attaching = attaching.then(() => attach(files), () => attach(files));
  return attaching;
}
async function attach(files: readonly File[]) {
  const errors: string[] = [];
  for (const file of files) {
    const name = file.name || "粘贴的图片";
    const { attachments } = webStore.getState();
    if (attachments.length >= LIMITS.maxImages) { errors.push(`最多附加 ${LIMITS.maxImages} 张图片。`); break; }
    if (!IMAGE_TYPES.includes(file.type as ImageType)) { errors.push(`${name}：仅支持 PNG、JPEG、WebP。`); continue; }
    if (file.size > LIMITS.imageBytes) { errors.push(`${name}：超过 5 MiB。`); continue; }
    if (attachments.reduce((sum, item) => sum + item.bytes, 0) + file.size > LIMITS.imagesTotalBytes) { errors.push(`${name}：图片合计超过 10 MiB。`); continue; }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const info = inspectImage(bytes);
    if (!info || info.mimeType !== file.type) { errors.push(`${name}：文件已损坏或格式与扩展名不符。`); continue; }
    if (!info.width || !info.height || info.width * info.height > LIMITS.imagePixels) { errors.push(`${name}：超过 2,000 万像素。`); continue; }
    const blob = new Blob([bytes], { type: info.mimeType });
    if (!await decodable(blob)) { errors.push(`${name}：浏览器无法解码这张图片。`); continue; }
    const attachment: Attachment = { id: `a${++attachmentNo}`, name, mimeType: info.mimeType, bytes: bytes.byteLength,
      width: info.width, height: info.height, data: toBase64(bytes), url: URL.createObjectURL(blob) };
    webStore.setState(state => ({ attachments: [...state.attachments, attachment] }));
  }
  webStore.setState({ attachmentError: errors.join(" ") });
}
export function removeAttachment(id: string) {
  const item = webStore.getState().attachments.find(entry => entry.id === id);
  if (item) URL.revokeObjectURL(item.url);
  webStore.setState(state => ({ attachments: state.attachments.filter(entry => entry.id !== id), attachmentError: "" }));
}

// ---------------------------------------------------------------------------
// History images: read on demand through image_page, at most two at a time, kept as object URLs
// within LIMITS.clientImageCacheBytes (least recently shown evicted first).
// ---------------------------------------------------------------------------

const imageRequests = new Map<string, string>();
const imageQueue: string[] = [];
const imageBytes = new Map<string, number>();
/** Diagnostic only: the decoded bytes currently held, for acceptance checks of the cache bound. */
function reportImageCache() {
  let total = 0;
  for (const size of imageBytes.values()) total += size;
  if (typeof document !== "undefined") document.documentElement.dataset.imageCacheBytes = String(total);
}
function setImage(key: string, image: LoadedImage) {
  webStore.setState(state => ({ images: { ...state.images, [key]: image } }));
}
function dropImage(key: string) {
  const image = webStore.getState().images[key];
  if (image?.url) URL.revokeObjectURL(image.url);
  imageBytes.delete(key);
  reportImageCache();
  webStore.setState(state => {
    const images = { ...state.images };
    delete images[key];
    return { images };
  });
}
function storeImage(key: string, mimeType: string, data: string) {
  try {
    // Decoded locally: the CSP does not allow fetching data: URLs.
    const blob = new Blob([decodeBase64(data) as Uint8Array<ArrayBuffer>], { type: mimeType });
    imageBytes.delete(key);
    imageBytes.set(key, blob.size);
    setImage(key, { status: "ready", url: URL.createObjectURL(blob) });
    let total = 0;
    for (const size of imageBytes.values()) total += size;
    for (const [oldest, size] of imageBytes) {
      if (total <= LIMITS.clientImageCacheBytes || oldest === key) break;
      total -= size;
      dropImage(oldest);
    }
    reportImageCache();
  } catch { setImage(key, { status: "error", error: "图片数据无法读取。" }); }
}
function pumpImages() {
  const snapshot = webStore.getState().snapshot;
  while (imageRequests.size < 2 && imageQueue.length && snapshot) {
    const key = imageQueue.shift()!;
    const split = key.lastIndexOf("#");
    const reqId = `i${++requestNo}`;
    if (!send({ t: "image_page", reqId, epoch: snapshot.epoch, messageId: key.slice(0, split), index: Number(key.slice(split + 1)) })) { dropImage(key); return; }
    imageRequests.set(reqId, key);
  }
}
/** Called when an image block becomes visible. Ready images are marked recently used. */
export function requestImage(messageId: string, index: number) {
  const key = `${messageId}#${index}`;
  const existing = webStore.getState().images[key];
  if (existing?.status === "ready") {
    const size = imageBytes.get(key);
    if (size !== undefined) { imageBytes.delete(key); imageBytes.set(key, size); }
    return;
  }
  if (existing || webStore.getState().connection !== "online") return;
  setImage(key, { status: "loading" });
  imageQueue.push(key);
  pumpImages();
}
export function retryImage(messageId: string, index: number) {
  dropImage(`${messageId}#${index}`);
  requestImage(messageId, index);
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
