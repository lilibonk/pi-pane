import { createStore } from "zustand/vanilla";
import type { AccountOperation, CommandName, ExtensionUiState, HostCommandName, HostQueryAction, HostQueryValues, HostState, ProjectInspectView, ImageType, MessageView, PromptImage, Snapshot, ThemeDecorations } from "../protocol/index.js";
import { IMAGE_TYPES, LIMITS, PROTOCOL, applyProjectionEvent, boundedTools, decodeBase64, encodedSize, inspectImage, isTextContent, mergeOlderPage, safeDecorations } from "../protocol/index.js";
import type { WorkbenchAction, WorkbenchValues } from "../protocol/workbench.js";
import { loadAppearance, safeVars, saveAppearance, wantedTheme, type Appearance, type ThemeVars } from "./appearance.js";
import { ForkDraftRecovery } from "./draft-recovery.js";
import { ProjectDrafts } from "./project-drafts.js";
import { EditorChangeGuard, extensionText } from "./ui-state.js";
export type { ContentView, MessageView, Snapshot, ToolView } from "../protocol/index.js";

export type Connection = "connecting" | "login" | "online" | "resyncing" | "switching" | "disconnected" | "fatal";
type ReceiptStatus = "sent" | "dispatched" | "started" | "queued" | "handled" | "rejected" | "unknown" | "completed" | "cancelled" | "failed";
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

export interface Dialog { id: string; method: "select" | "confirm" | "input" | "editor"; title?: string; message?: string; options?: string[]; placeholder?: string; prefill?: string; expiresAt?: number }
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
  /** Extension requests pending in the foreground RPC host. */
  dialogs: Dialog[];
  ui: ExtensionUiState | null;
  /** The host's own state. Present with or without a session; drives the recovery page. */
  host: HostState | null;
  /** The recovery command this page sent and has no result for yet. */
  hostAction: { id: string; command: HostCommandName } | null;
  /** The open project dialog: a directory picker, or the trust question for one inspected directory. */
  projectDialog: { mode: "open" | "create" } | { mode: "relocate"; from: string } | { mode: "trust"; project: ProjectInspectView } | null;
  /** The account operation as this page may see it: with its steps when this page started it. */
  account: AccountOperation | null;
  /** Why the last answer to a login step was not accepted. */
  accountError: string;
  /** The finished or running operation whose dialog this page closed. */
  accountDismissed: string;
  /** How this browser has chosen to look. Stored in this browser; never a pi setting. */
  appearance: Appearance;
  /** A look being tried in the settings dialog. Not stored; dropped when the dialog closes. */
  appearancePreview: Appearance | null;
  /** The named theme the active look asks for, or "" when it follows pi. */
  themeName: string;
  /** That theme's colors. Null means the session snapshot's theme applies. */
  themeVars: ThemeVars | null;
  /** Only the host's current validated metadata; never restored from browser storage. */
  themeDecorations: ThemeDecorations | null;
  /** `missing`: the chosen theme is not available here; the last colors known for it stay. */
  themeProblem: "" | "missing";
  /** Whether this browser could store the last committed choice. */
  appearanceStored: boolean;
  /** The open settings dialog and its section. */
  settings: SettingsSection | null;
  /** A dialog about sessions: the question before a deletion, the session's numbers, an export, or text that could not be copied. */
  sessionDialog: { mode: "delete"; sessionId: string } | { mode: "info" } | { mode: "export" } | { mode: "text"; text: string } | null;
  /** Counts successful session deletions, so listings read again. */
  sessionsChanged: number;
}
export type SettingsSection = "appearance" | "defaults" | "behavior" | "accounts" | "providers" | "other";

function prefersDark(): boolean { try { return matchMedia("(prefers-color-scheme: dark)").matches; } catch { return false; } }
/** Only a finished login result's ID, scoped to this browser tab; never a key or login step. */
const ACCOUNT_DISMISSED_KEY = "pi-pane.accountDismissed";
const storedAppearance = loadAppearance();
let themeCache: Record<string, ThemeVars> = storedAppearance.cache;
let themeRequest = 0;
let themeKey = "";

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
  dialogs: [],
  ui: null,
  host: null,
  hostAction: null,
  projectDialog: null,
  account: null,
  accountError: "",
  accountDismissed: readSession(ACCOUNT_DISMISSED_KEY) ?? "",
  appearance: storedAppearance.appearance,
  appearancePreview: null,
  themeName: wantedTheme(storedAppearance.appearance, prefersDark()) ?? "",
  themeVars: storedAppearance.cache[wantedTheme(storedAppearance.appearance, prefersDark()) ?? ""] ?? null,
  themeDecorations: null,
  themeProblem: "",
  appearanceStored: true,
  settings: null,
  sessionDialog: null,
  sessionsChanged: 0,
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
let pendingCredentialRotation = false;
let requestNo = 0;
let historyRequest: string | undefined;
const contentRequests = new Map<string, string>();
const workbenchRequests = new Map<string, { epoch: string; action: WorkbenchAction; resolve: (value: any) => void; reject: (error: Error) => void; dispose: () => void }>();
const forkDraftRecovery = new ForkDraftRecovery();
let draftRevision = 0;
const projectDrafts = new ProjectDrafts<Attachment>(16, attachments => { for (const item of attachments) URL.revokeObjectURL(item.url); });
const editorChanges = new EditorChangeGuard();
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
  forkDraftRecovery.cancel();
  cancelWorkbenchReads();
  stopped = true;
  sessionToken = "";
  clearSession(SESSION_KEY);
  clearSession(CLIENT_KEY);
  webStore.setState({ connection: authToken ? "login" : "fatal", clientId: null, loginBusy: false, dialogs: [],
    notice: authToken ? notice : "缺少访问链接。请使用终端 /web 给出的链接或 交接横幅的二维码打开。" });
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
        ? { ...item, status: "unknown", explanation: "连接或会话已改变；结果未知。请检查会话和提交记录，勿直接重复发送。" }
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
  forkDraftRecovery.cancel();
  resetReads();
  webStore.setState({ connection: "resyncing", notice: message });
  send({ t: "resync" });
}

/** Read requests belong to one epoch; a new snapshot discards their pending state. */
function resetReads() {
  cancelWorkbenchReads();
  historyRequest = undefined;
  contentRequests.clear();
  // Loaded images stay cached (their bytes do not change); unfinished reads are retried when visible.
  for (const key of imageRequests.values()) dropImage(key);
  imageRequests.clear();
  imageQueue.length = 0;
  webStore.setState({ historyLoading: false, historyError: "", expansions: {} });
}

/** A directed workbench read is bounded and is never replayed after a reconnect. */
function cancelWorkbenchReads() {
  for (const request of workbenchRequests.values()) {
    request.dispose();
    request.reject(new Error("会话或连接已变化，请重新加载。"));
  }
  workbenchRequests.clear();
}
/** A failure reported by the host, with its code so the page can explain it in its own words. */
export class HostError extends Error {
  constructor(readonly code: string, message: string, readonly field?: string) { super(message); this.name = "HostError"; }
}
const hostRequests = new Map<string, { action: string; resolve: (value: any) => void; reject: (error: Error) => void; dispose: () => void }>();
const hostCommands = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
/** Host reads and commands outlive session changes but not the connection. */
function cancelHostRequests() {
  for (const request of hostRequests.values()) { request.dispose(); request.reject(new HostError("disconnected", "连接已断开，请重新加载。")); }
  hostRequests.clear();
  for (const command of hostCommands.values()) command.reject(new HostError("unknown_result", "连接已断开，结果未知。请查看页面当前状态，不要直接重复操作。"));
  hostCommands.clear();
}
/** A directed read about the host's projects and directories. It needs a connection, not a session. */
export function queryHost<A extends HostQueryAction>(action: A, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<HostQueryValues[A]> {
  if (!webStore.getState().clientId) return Promise.reject(new HostError("disconnected", "尚未连接，请稍后重试。"));
  if (signal?.aborted) return Promise.reject(new HostError("cancelled", "读取已取消。"));
  return new Promise((resolve, reject) => {
    const reqId = `host:${++requestNo}`;
    const fail = (code: string, message: string) => {
      const request = hostRequests.get(reqId);
      if (!request) return;
      hostRequests.delete(reqId); request.dispose(); reject(new HostError(code, message));
    };
    const onAbort = () => fail("cancelled", "读取已取消。");
    const timer = setTimeout(() => fail("timeout", "读取超时，请重试。"), 15_000);
    hostRequests.set(reqId, { action, resolve, reject, dispose: () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); } });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (!send({ t: "host_query", reqId, action, args })) fail("disconnected", "连接已断开，请重新加载。");
  });
}

export function queryWorkbench<A extends WorkbenchAction>(action: A, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<WorkbenchValues[A]> {
  const state = webStore.getState();
  const snapshot = state.snapshot;
  if (state.connection !== "online" || !snapshot?.caps.workbench) return Promise.reject(new Error("工作台未连接，请稍后重试。"));
  if (signal?.aborted) return Promise.reject(new Error("读取已取消。"));
  return new Promise((resolve, reject) => {
    const reqId = `workbench:${++requestNo}`;
    const finishError = (message: string) => {
      const request = workbenchRequests.get(reqId);
      if (!request) return;
      workbenchRequests.delete(reqId);
      request.dispose();
      reject(new Error(message));
    };
    const onAbort = () => finishError("读取已取消。");
    const timer = setTimeout(() => finishError("读取超时，请重新加载。"), 15_000);
    const dispose = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
    workbenchRequests.set(reqId, { epoch: snapshot.epoch, action, resolve, reject, dispose });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (!send({ t: "workbench_query", reqId, epoch: snapshot.epoch, sessionId: snapshot.session.id,
      branchRevision: snapshot.session.branchRevision, action, args })) finishError("连接已断开，请重新加载。");
  });
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

function restoreForkDraft() {
  const state = webStore.getState();
  if (state.connection !== "online" || !state.snapshot) return;
  const recovery = forkDraftRecovery.reconcile(state.snapshot.session, state.draft, draftRevision);
  if (!recovery) return;
  if (recovery.restore) setDraft(recovery.text);
  else webStore.setState({ notice: "已从所选用户消息之前创建分叉。原输入保存在提交记录中，可点“恢复到输入框”；当前草稿已保留。" });
}

function applyUiState(ui: ExtensionUiState | undefined, epoch: string) {
  if (!ui) { webStore.setState({ ui: null }); return; }
  if (!Number.isSafeInteger(ui.revision) || !ui.statuses || !ui.widgets) return;
  webStore.setState({ ui });
  if (typeof document !== "undefined") document.title = extensionText(ui.title || "pi-pane");
  const editorText = editorChanges.read(epoch, ui);
  if (editorText !== undefined) setDraft(editorText);
}

function handleFrame(raw: unknown) {
  if (!raw || typeof raw !== "object" || !("t" in raw)) throw new Error("frame shape");
  const frame = raw as Record<string, any>;
  const current = webStore.getState();
  switch (frame.t) {
    case "welcome":
      if (typeof frame.clientId !== "string" || !Number.isSafeInteger(frame.nextCommandNo)) throw new Error("welcome shape");
      saveSession(CLIENT_KEY, frame.clientId);
      // The host sends the account operation again after this when one exists.
      webStore.setState({ clientId: frame.clientId, nextCommandNo: frame.nextCommandNo, hostAction: null, account: null, accountError: "" });
      break;
    case "snapshot": {
      if (typeof frame.epoch !== "string" || !Number.isSafeInteger(frame.seq) ||
        !frame.session || !Array.isArray(frame.session.messages) || !frame.state) throw new Error("snapshot shape");
      uncertainSubmissions(frame.epoch);
      resetReads();
      const snapshot = capHistory({ ...frame, decorations: safeDecorations(frame.decorations), state: { ...frame.state, tools: boundedTools(frame.state.tools) } } as Snapshot);
      const moved = projectDrafts.enter(snapshot.session.cwd, { draft: current.draft, attachments: current.attachments });
      if (moved) { draftRevision++; webStore.setState({ draft: moved.draft, attachments: moved.attachments, attachmentError: "" }); }
      webStore.setState(state => ({ snapshot, lastAppliedSeq: frame.seq, connection: "online", notice: "", snapshotCount: state.snapshotCount + 1 }));
      webStore.setState({ dialogs: [] });
      applyUiState(snapshot.ui, snapshot.epoch);
      restoreForkDraft();
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
    case "workbench_result": {
      const request = workbenchRequests.get(frame.reqId);
      if (!request) return;
      workbenchRequests.delete(frame.reqId);
      request.dispose();
      if (frame.epoch !== request.epoch || frame.epoch !== current.snapshot?.epoch || frame.action !== request.action) request.reject(new Error("会话已变化，请重新加载。"));
      else if (frame.error) request.reject(new Error(typeof frame.error.message === "string" ? frame.error.message : "读取失败。"));
      else if (frame.value === undefined) request.reject(new Error("未收到工作台数据。"));
      else request.resolve(frame.value);
      break;
    }
    case "session_reset":
      uncertainSubmissions(frame.epoch);
      resetReads();
      webStore.setState({ snapshot: null, lastAppliedSeq: 0, connection: "switching", notice: "会话已切换，等待新快照…" });
      break;
    case "switching":
      cancelWorkbenchReads();
      webStore.setState({ connection: "switching", notice: current.host?.phase === "recovery_required" ? "" : "宿主正在切换会话，写操作暂时暂停…" });
      break;
    case "account_state":
      webStore.setState({ account: (frame.operation ?? null) as AccountOperation | null, ...(frame.operation?.step ? {} : { accountError: "" }) });
      break;
    case "account_error":
      if (current.account?.id === frame.operationId) webStore.setState({ accountError: String(frame.error?.code ?? "failed") });
      break;
    case "host_result": {
      const request = typeof frame.reqId === "string" ? hostRequests.get(frame.reqId) : undefined;
      if (!request) break;
      hostRequests.delete(frame.reqId); request.dispose();
      if (frame.action !== request.action) request.reject(new HostError("mismatch", "读取结果不匹配，请重试。"));
      else if (frame.error) request.reject(new HostError(String(frame.error.code ?? "failed"), typeof frame.error.message === "string" ? frame.error.message : "读取失败。"));
      else if (frame.value === undefined) request.reject(new HostError("empty", "未收到数据。"));
      else request.resolve(frame.value);
      break;
    }
    case "host_state":
      if (!Number.isSafeInteger(frame.revision) || typeof frame.phase !== "string") throw new Error("host_state shape");
      webStore.setState({ host: frame as unknown as HostState,
        // A failed switch has no session to show: drop the old snapshot so nothing looks writable.
        ...(frame.phase === "recovery_required" ? { snapshot: null, lastAppliedSeq: 0, connection: "switching" as const, notice: "" } : {}) });
      break;
    case "ack": {
      if (typeof frame.id !== "string") throw new Error("ack id");
      if (Number.isSafeInteger(frame.nextCommandNo)) webStore.setState({ nextCommandNo: Math.max(current.nextCommandNo, frame.nextCommandNo) });
      if (current.hostAction?.id === frame.id) {
        if (frame.status !== "dispatched") {
          webStore.setState({ hostAction: null });
          const waiter = hostCommands.get(frame.id); hostCommands.delete(frame.id);
          waiter?.reject(new HostError(String(frame.error?.code ?? "rejected"), frame.error?.message ?? "操作未被接受。", typeof frame.error?.field === "string" ? frame.error.field : undefined));
        }
        break;
      }
      updateSubmission(frame.id, {
        status: frame.status === "dispatched" ? "dispatched" : "rejected",
        explanation: frame.error?.message,
      });
      if (frame.status !== "dispatched") forkDraftRecovery.cancel(frame.id);
      break;
    }
    case "command_result": {
      if (current.hostAction?.id === frame.id) {
        webStore.setState({ hostAction: null });
        const waiter = hostCommands.get(frame.id); hostCommands.delete(frame.id);
        if (frame.status === "completed") waiter?.resolve(frame.value);
        else waiter?.reject(new HostError(String(frame.error?.code ?? "failed"), frame.error?.message ?? "操作失败。", typeof frame.error?.field === "string" ? frame.error.field : undefined));
        break;
      }
      const submission = current.submissions.find(item => item.id === frame.id);
      const restored = submission?.command === "session_fork" && frame.status === "completed" && typeof frame.value?.draftText === "string" ? frame.value.draftText as string : undefined;
      updateSubmission(frame.id, { status: frame.status === "completed" ? frame.value?.cancelled === true ? "cancelled" : ["started", "queued", "handled"].includes(frame.value?.disposition ?? frame.value?.status) ? (frame.value.disposition ?? frame.value.status) : "completed" : "failed", explanation: frame.error?.message });
      if (submission?.command === "access_rotate" && frame.status === "completed" && typeof frame.value?.url === "string") {
        try {
          const rotated = new URL(frame.value.url, location.href);
          const token = new URLSearchParams(rotated.hash.slice(1)).get("t");
          if (token && /^[A-Za-z0-9_-]+$/.test(token)) {
            authToken = token; saveSession(TOKEN_KEY, token); sessionToken = "";
            clearSession(SESSION_KEY); clearSession(CLIENT_KEY); pendingCredentialRotation = true;
            webStore.setState({ clientId: null, notice: "访问凭据已轮换，正在更新本页连接。其他访客需使用交接终端的新链接。" });
          }
        } catch { webStore.setState({ notice: "访问凭据已轮换，请使用交接终端的新链接重新打开。" }); }
      }
      if (restored !== undefined) {
        updateSubmission(frame.id, { text: restored });
        forkDraftRecovery.complete(frame.id, frame.value);
        restoreForkDraft();
      } else forkDraftRecovery.cancel(frame.id);
      break;
    }
    case "ui_state":
      if (current.snapshot) applyUiState(frame as ExtensionUiState, current.snapshot.epoch);
      break;
    case "ui_request":
      if (typeof frame.id === "string" && !current.dialogs.some(dialog => dialog.id === frame.id))
        webStore.setState({ dialogs: [...current.dialogs, frame as unknown as Dialog] });
      break;
    case "ui_resolved":
      webStore.setState({ dialogs: current.dialogs.filter(dialog => dialog.id !== frame.id),
        ...(frame.reason === "timeout" ? { notice: "扩展请求已超时。" } : frame.reason === "session_changed" ? { notice: "会话已变化，扩展请求已取消。" } : {}) });
      break;
    case "notice":
      webStore.setState({ notice: frame.message ?? frame.notice ?? "请检查终端提示。" });
      break;
    case "error": {
      const code = frame.error?.code;
      const message = frame.error?.message ?? "连接发生错误。";
      if (typeof frame.reqId === "string") {
        const workbench = workbenchRequests.get(frame.reqId);
        if (workbench) { workbenchRequests.delete(frame.reqId); workbench.dispose(); workbench.reject(new Error(message)); }
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
        forkDraftRecovery.cancel();
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
  const ws = new WebSocket(wsUrl, [PROTOCOL, `pi-pane.bearer.${bearer}`]);
  socket = ws;
  opened = false;
  assembling = undefined;
  ws.onopen = () => {
    if (socket !== ws) return;
    opened = true;
    pendingCredentialRotation = false;
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
    forkDraftRecovery.cancel();
    uncertainSubmissions();
    cancelWorkbenchReads();
    cancelHostRequests();
    webStore.setState({ hostAction: null });
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
    if (pendingCredentialRotation) {
      pendingCredentialRotation = false; stopped = false; attempt = 0;
      // The host may have to terminate a slow socket before its close reason arrives.
      // Wait past the rotation activation delay before using the replacement credential.
      retryTimer = setTimeout(() => {
        if (mode === "password") requireLogin("访问凭据已轮换。请重新输入访问密码；本页已更新为新凭据。");
        else connect();
      }, 150);
      return;
    }
    if (event.reason === "token_rotated") {
      stopped = true;
      clearSession(TOKEN_KEY);
      clearSession(SESSION_KEY);
      authToken = "";
      sessionToken = "";
      webStore.setState({ connection: "fatal", notice: "访问凭据已轮换。请在终端运行 /web，打开新的链接。" });
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
  forkDraftRecovery.cancel();
  cancelWorkbenchReads();
  clearTimeout(retryTimer);
  socket?.close();
  socket = null;
  stopped = false;
  attempt = 0;
  connect();
}
// Opening a new /web link in the same tab only changes the fragment; the page does not reload.
if (typeof window !== "undefined") window.addEventListener("hashchange", () => {
  const fragment = new URLSearchParams(location.hash.slice(1));
  if (!fragment.has("t") && !fragment.has("token")) return;
  receiveToken();
  reconnect();
});
// Phones suspend background tabs; reconnect promptly when the page becomes visible again.
if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !stopped && webStore.getState().connection === "disconnected") reconnect();
});

export function setDraft(draft: string) { draftRevision++; webStore.setState({ draft }); }

export function answerDialog(id: string, response: { value?: string; confirmed?: boolean; cancelled?: true }) {
  if (typeof response.value === "string" && new TextEncoder().encode(response.value).byteLength > 65536) {
    webStore.setState({ notice: "对话框输入超过 64 KiB，请缩短后再提交。" }); return;
  }
  if (webStore.getState().connection === "online" && send({ t: "ui_response", id, ...response })) webStore.setState(state => ({ dialogs: state.dialogs.filter(dialog => dialog.id !== id) }));
}
/**
 * A command about the host itself (projects, recovery). It needs no session, only the host state this
 * page shows, and is never resent: after a lost connection its result is reported as unknown.
 */
export function runHostCommand<T = unknown>(command: HostCommandName, args: Record<string, unknown> = {}): Promise<T> {
  const state = webStore.getState();
  if (!state.clientId || !state.host || state.connection === "disconnected" || state.connection === "fatal" || state.connection === "login")
    return Promise.reject(new HostError("disconnected", "尚未连接，请稍后重试。"));
  if (state.hostAction) return Promise.reject(new HostError("busy", "上一个操作还在进行。"));
  const commandNo = state.nextCommandNo;
  const id = `${state.clientId}:${commandNo}`;
  if (!send({ t: "host_command", clientId: state.clientId, commandNo, id, hostRevision: state.host.revision, command, args }))
    return Promise.reject(new HostError("disconnected", "连接已断开，请重新加载。"));
  webStore.setState({ notice: "", nextCommandNo: commandNo + 1, hostAction: { id, command } });
  return new Promise<T>((resolve, reject) => { hostCommands.set(id, { resolve, reject }); });
}
/** Retry, restore or stop after a failed runtime replacement. */
export function issueHostCommand(command: "recover_retry" | "recover_restore" | "host_stop") {
  // On failure the host has already published the updated recovery state with its reason.
  runHostCommand(command).catch((error: HostError) => {
    if (error.code !== "recovery_required") webStore.setState({ notice: error.code === "stale_host" ? "宿主状态已变化，请按页面当前内容重新选择。" : error.message });
  });
}
/**
 * Answers the current login step. The value may be a key: it goes out once on this connection and is
 * kept nowhere on the page — not in the store, a draft, a submission record or storage.
 */
export function answerAccount(operationId: string, stepId: string, value: string): boolean {
  webStore.setState({ accountError: "" });
  return send({ t: "account_answer", operationId, stepId, value });
}
/**
 * Brings the page's colors in line with the active look: the one being previewed, else the stored one.
 * A named theme is read from the host again whenever the host's state changes (another project,
 * a theme file edited and refreshed); until it answers, and when it no longer has the theme, the
 * colors last known for that name stay.
 */
export function syncTheme(force = false) {
  const state = webStore.getState();
  const wanted = wantedTheme(state.appearancePreview ?? state.appearance, prefersDark());
  if (!wanted) {
    themeRequest++; themeKey = "";
    if (state.themeName || state.themeVars || state.themeProblem || state.themeDecorations) webStore.setState({ themeName: "", themeVars: null, themeDecorations: null, themeProblem: "" });
    return;
  }
  if (state.themeName !== wanted) {
    themeRequest++; themeKey = "";
    webStore.setState({ themeName: wanted, themeVars: themeCache[wanted] ?? null, themeDecorations: null, themeProblem: "" });
  }
  const reachable = !!state.clientId && state.connection !== "disconnected" && state.connection !== "fatal" && state.connection !== "login" && state.connection !== "connecting";
  const key = `${wanted}\0${state.clientId}\0${state.host?.revision}`;
  if (!reachable || (key === themeKey && !force)) return;
  themeKey = key;
  const request = ++themeRequest;
  // Keep cached colors while rechecking a source, but artwork needs a fresh provenance check.
  webStore.setState({ themeDecorations: null });
  queryHost("theme", { name: wanted }).then(view => {
    if (request !== themeRequest) return;
    const vars = safeVars(view.vars);
    if (!vars) { webStore.setState({ themeProblem: "missing", themeDecorations: null }); return; }
    themeCache = { ...themeCache, [wanted]: vars };
    webStore.setState({ themeVars: vars, themeDecorations: safeDecorations(view.decorations) ?? null, themeProblem: "" });
    const current = webStore.getState();
    if (!current.appearancePreview) saveAppearance(current.appearance, themeCache);
  }, (error: HostError) => {
    if (request !== themeRequest) return;
    if (error.code === "theme_missing") webStore.setState({ themeProblem: "missing", themeDecorations: null });
    else themeKey = ""; // not an answer about the theme: ask again on the next change
  });
}
/** Tries a look without storing it. `null` returns to the stored one. */
export function previewAppearance(appearance: Appearance | null) {
  const current = webStore.getState();
  const { hideThinking } = current.appearance;
  // A checkbox supplies its new value; changing only the theme keeps the active preview's value.
  const showDecorations = appearance?.showDecorations ?? (current.appearancePreview ?? current.appearance).showDecorations;
  const { hideThinking: _thinking, showDecorations: _decorations, ...look } = appearance ?? current.appearance;
  webStore.setState({ appearancePreview: appearance && { ...look, ...(hideThinking ? { hideThinking } : {}), ...(showDecorations === false ? { showDecorations: false } : {}) } });
  syncTheme();
}
/** Makes the previewed look this browser's choice. */
export function commitAppearance() {
  const preview = webStore.getState().appearancePreview;
  if (!preview) return;
  webStore.setState({ appearance: preview, appearancePreview: null, appearanceStored: saveAppearance(preview, themeCache) });
  syncTheme();
}
/** Forgets this browser's look, including its decoration choice; the separate thinking preference stays. */
export function clearAppearance() {
  const { hideThinking } = webStore.getState().appearance;
  const appearance: Appearance = { mode: "pi", ...(hideThinking ? { hideThinking } : {}) };
  webStore.setState({ appearance, appearancePreview: null, appearanceStored: saveAppearance(appearance, themeCache) });
  syncTheme();
}
export function setHideThinking(hide: boolean) {
  const current = webStore.getState();
  const update = ({ hideThinking: _old, ...rest }: Appearance): Appearance => ({ ...rest, ...(hide ? { hideThinking: true } : {}) });
  const appearance = update(current.appearance);
  webStore.setState({ appearance, appearancePreview: current.appearancePreview && update(current.appearancePreview), appearanceStored: saveAppearance(appearance, themeCache) });
}
export function setSessionDialog(dialog: WebState["sessionDialog"]) { webStore.setState({ sessionDialog: dialog }); }
export function sessionDeleted() { webStore.setState(state => ({ sessionsChanged: state.sessionsChanged + 1 })); }
/** Writes to the clipboard and says whether it did. A browser may refuse: no permission, no secure context, no focus. */
export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}
/**
 * Copies one assistant reply, or the last one, as pi's `/copy` gives it. When the clipboard refuses,
 * the text is shown to be selected by hand; "copied" is only said when it was.
 */
export async function copyReply(entryId?: string): Promise<void> {
  let text: string;
  try {
    const reply = await queryWorkbench("assistant_text", entryId ? { entryId } : {});
    text = reply.text;
    if (reply.truncated) { webStore.setState({ sessionDialog: { mode: "text", text }, notice: "这条回复很长，只取到前 4 MiB。" }); return; }
  } catch (error) { webStore.setState({ notice: error instanceof Error ? error.message : "读取回复失败。" }); return; }
  if (!text) { webStore.setState({ notice: "没有可复制的回复文字。" }); return; }
  if (await copyText(text)) webStore.setState({ notice: "已复制回复。" });
  else webStore.setState({ sessionDialog: { mode: "text", text }, notice: "" });
}
export function openSettings(section: SettingsSection = "appearance") { webStore.setState({ settings: section }); }
export function closeSettings() { webStore.setState({ settings: null, appearancePreview: null }); syncTheme(); }
webStore.subscribe((state, previous) => {
  if (state.clientId !== previous.clientId || state.host?.revision !== previous.host?.revision || state.connection !== previous.connection) syncTheme();
});
try { matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => syncTheme()); } catch { /* no media queries: the system look stays as first read */ }
export function dismissAccount(operationId: string) {
  const operation = webStore.getState().account;
  // A completed result stays closed after refresh. A running login is only folded away in memory:
  // after a reload its current step must be visible again so the same tab can continue answering.
  if (operationId && operation?.id === operationId && operation.status !== "running") saveSession(ACCOUNT_DISMISSED_KEY, operationId);
  else clearSession(ACCOUNT_DISMISSED_KEY);
  webStore.setState({ accountDismissed: operationId, accountError: "" });
}
export function setProjectDialog(dialog: WebState["projectDialog"]) { webStore.setState({ projectDialog: dialog }); }
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
  if (command.startsWith("session_")) forkDraftRecovery.cancel();
  if (command === "session_fork") forkDraftRecovery.start(id, snapshot.session, draftRevision);
  webStore.setState({
    notice: "",
    nextCommandNo: commandNo + 1,
    submissions: [...state.submissions, submission].slice(-32),
    ...(command === "prompt" ? { draft: "", attachments: [], attachmentError: "" } : {}),
  });
  if (command === "prompt") for (const item of attached) URL.revokeObjectURL(item.url);
  setTimeout(() => {
    const item = webStore.getState().submissions.find(entry => entry.id === id);
    if (item?.status === "sent") {
      forkDraftRecovery.cancel(id);
      updateSubmission(id, { status: "unknown", explanation: "尚未收到回执，请检查会话和提交记录。原文已保留；不会自动重发。" });
    }
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
  forkDraftRecovery.cancel(id);
  const clientId = webStore.getState().clientId;
  if (clientId) send({ t: "receipt_query", clientId, id });
}

export function forgetSubmission(id: string) {
  forkDraftRecovery.cancel(id);
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
