import { render } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { IMAGE_TYPES } from "../protocol/index.js";
import {
  addImages, answerDialog, forgetSubmission, issueCommand, loadSessions, loadOlder, login, logout, queryReceipt, reconnect, removeAttachment, setDraft,
  startConnection, submitPrompt, webStore, type Attachment, type Dialog, type MessageView, type Submission, type ToolView, type WebState,
} from "./store.js";
import { Message, ToolCard, type ToolContext } from "./messages.js";
import "./style.css";

/** Session host: sessions from every project, newest first. Opening one replaces the current session. */
function SessionsPanel({ state, onClose }: { state: WebState; onClose: () => void }) {
  const idle = !!state.snapshot?.state.idle;
  return (
    <section class="sessions-panel" aria-label="会话">
      <div class="sessions-header">
        <strong>会话</strong>
        <button type="button" onClick={() => issueCommand("host_new")} disabled={!idle}>新建会话</button>
        <button type="button" class="quiet" onClick={loadSessions}>刷新</button>
        <button type="button" class="quiet" onClick={onClose}>关闭</button>
      </div>
      {!idle && <p class="subtle">pi 运行中，空闲后才能切换会话。</p>}
      {state.sessionsLoading && <p class="subtle">正在读取会话…</p>}
      <ul>
        {(state.sessions ?? []).map(session => (
          <li key={session.id} class={session.current ? "current" : ""} data-session-id={session.id}>
            <div><strong>{session.name || session.preview || "（空会话）"}</strong><span class="mono">{session.cwd} · {new Date(session.modified).toLocaleString("zh-CN", { hour12: false })} · {session.messages} 条</span></div>
            {session.current ? <span class="subtle">当前</span> : <button type="button" disabled={!idle} onClick={() => issueCommand("host_switch", { sessionId: session.id })}>打开</button>}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** An extension dialog forwarded by the session host. The first answer from any viewer wins. */
function DialogView({ dialog }: { dialog: Dialog }) {
  const [text, setText] = useState(dialog.prefill ?? "");
  const cancel = () => answerDialog(dialog.id, { cancelled: true });
  return (
    <div class="dialog-backdrop" role="dialog" aria-modal="true" aria-label={dialog.title ?? "pi 请求确认"}>
      <div class="dialog">
        <h2>{dialog.title ?? "pi 请求输入"}</h2>
        {dialog.message && <p>{dialog.message}</p>}
        {dialog.method === "select" && <div class="dialog-options">{(dialog.options ?? []).map(option => <button type="button" key={option} onClick={() => answerDialog(dialog.id, { value: option })}>{option}</button>)}</div>}
        {(dialog.method === "input" || dialog.method === "editor") && <textarea aria-label="对话框输入" rows={dialog.method === "editor" ? 10 : 2} placeholder={dialog.placeholder} value={text} onInput={event => setText(event.currentTarget.value)} />}
        <div class="dialog-actions">
          <button type="button" class="quiet" onClick={cancel}>取消</button>
          {dialog.method === "confirm" && <button type="button" class="send-button" onClick={() => answerDialog(dialog.id, { confirmed: true })}>确认</button>}
          {(dialog.method === "input" || dialog.method === "editor") && <button type="button" class="send-button" onClick={() => answerDialog(dialog.id, { value: text })}>提交</button>}
        </div>
      </div>
    </div>
  );
}

function useWebState(): WebState {
  const [state, setState] = useState(webStore.getState());
  useEffect(() => {
    let pending = 0;
    const unsubscribe = webStore.subscribe(() => {
      if (pending) return;
      pending = requestAnimationFrame(() => { pending = 0; setState(webStore.getState()); });
    });
    return () => { unsubscribe(); cancelAnimationFrame(pending); };
  }, []);
  return state;
}

function receiptLabel(item: Submission): string {
  if (item.command === "prompt" && item.status === "dispatched") return "已交给 pi；提交结果未确认";
  return ({ sent: "等待桥接回执", dispatched: "已调用；等待状态变化", rejected: "桥接拒绝", unknown: "结果未知，请检查终端", completed: "操作已完成", failed: "操作失败" })[item.status];
}

function Receipts({ items, online, onRecover }: { items: Submission[]; online: boolean; onRecover: (text: string) => void }) {
  if (!items.length) return null;
  const latest = items[items.length - 1]!;
  return (
    <details class="receipts">
      <summary><span>提交记录 · {items.length}</span><span class={`receipt-latest receipt-${latest.status}`}>{receiptLabel(latest)}</span></summary>
      <p class="receipt-note">会话消息由 pi 的实际事件显示。回执不能确认消息已入队或执行成功；原文保存在当前页面供恢复。</p>
      <div class="receipt-list">
        {[...items].reverse().map(item => (
          <div class={`receipt-item receipt-${item.status}`} key={item.id} data-receipt-id={item.id}>
            <div class="receipt-header"><strong>{item.command === "prompt" ? item.mode === "steer" ? "steer" : "followUp" : item.command}</strong><span>{receiptLabel(item)}</span><time>{new Date(item.at).toLocaleTimeString("zh-CN", { hour12: false })}</time></div>
            {item.explanation && <p>{item.explanation}</p>}
            {item.text !== undefined && <pre>{item.text}</pre>}
            {!!item.images?.length && <p class="subtle">附带图片：{item.images.join("、")}（图片不保留，恢复时需重新添加）</p>}
            <div class="receipt-actions">
              {item.text !== undefined && <button type="button" onClick={() => onRecover(item.text!)}>恢复到输入框</button>}
              {(item.status === "unknown" || item.status === "sent") && <button type="button" disabled={!online} onClick={() => queryReceipt(item.id)}>查询回执</button>}
              <button type="button" class="quiet" onClick={() => forgetSubmission(item.id)}>移除记录</button>
            </div>
            {item.status === "unknown" && <p class="retry-warning">此前操作可能已经执行。恢复原文后，请先检查终端再决定是否发送。</p>}
          </div>
        ))}
      </div>
    </details>
  );
}

const labels = { connecting: "连接中", login: "需要登录", online: "已连接", resyncing: "同步中", switching: "切换中", disconnected: "已断开", fatal: "需重新连接" };
/** Messages kept in the DOM while following the latest output; older ones are mounted on demand. */
const WINDOW = 200;
const WINDOW_STEP = 100;
/** Touch keyboards have no reliable Shift+Enter; Enter inserts a newline and the buttons submit. */
const coarsePointer = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

function Login({ state }: { state: WebState }) {
  const [password, setPassword] = useState("");
  return (
    <form class="login" onSubmit={event => { event.preventDefault(); if (password) void login(password); }}>
      <span class="empty-pi">π</span>
      <h2>登录 pi-pane</h2>
      <p>此链接用于外部访问。请输入启动 pi 时设置的 PI_PANE_PASSWORD。密码不会保存在浏览器中。</p>
      <input type="password" autocomplete="current-password" aria-label="访问密码" placeholder="访问密码" value={password}
        onInput={event => setPassword(event.currentTarget.value)} disabled={state.loginBusy} />
      <button type="submit" class="send-button" disabled={!password || state.loginBusy}>{state.loginBusy ? "正在登录…" : "登录"}</button>
      {state.loginError && <p class="error-text" role="alert">{state.loginError}</p>}
    </form>
  );
}

function Attachments({ items, error }: { items: Attachment[]; error: string }) {
  if (!items.length && !error) return null;
  return (
    <div class="attachments">
      {items.map(item => (
        <figure class="attachment" key={item.id} data-attachment-id={item.id}>
          <img src={item.url} alt={item.name} />
          <figcaption title={item.name}>{item.width}×{item.height}</figcaption>
          <button type="button" aria-label={`移除 ${item.name}`} onClick={() => removeAttachment(item.id)}>×</button>
        </figure>
      ))}
      {error && <p class="error-text attachment-error" role="alert">{error}</p>}
    </div>
  );
}
function hexLuminance(value: string): number | undefined {
  if (!/^#[0-9a-f]{6}$/i.test(value)) return undefined;
  const channels = [1, 3, 5].map(offset => {
    const srgb = Number.parseInt(value.slice(offset, offset + 2), 16) / 255;
    return srgb <= .04045 ? srgb / 12.92 : ((srgb + .055) / 1.055) ** 2.4;
  });
  return channels[0]! * .2126 + channels[1]! * .7152 + channels[2]! * .0722;
}

function App() {
  const state = useWebState();
  const { snapshot, connection } = state;
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const feed = useRef<HTMLDivElement>(null);
  const feedInner = useRef<HTMLDivElement>(null);
  const [windowSize, setWindowSize] = useState(WINDOW);
  const [showSessions, setShowSessions] = useState(false);
  const [dragging, setDragging] = useState(false);
  const previousCount = useRef(0);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const pinned = useRef(true);
  const composing = useRef(false);
  const compositionEndedAt = useRef(0);
  const [showLatest, setShowLatest] = useState(false);
  const themeKeys = useRef<string[]>([]);
  const online = connection === "online" && !!snapshot && !!state.clientId;
  const host = snapshot?.state;
  const canPrompt = online && !!snapshot?.caps.commands.includes("prompt") && !host?.compacting && !host?.uiPrompts.length;
  const canConfigure = online && !!host?.idle && !host.compacting && !host.uiPrompts.length;
  const messages = snapshot?.session.messages;
  // Pair each tool call with its result and live progress; paired results render inside the call.
  const view = useMemo(() => {
    const results = new Map<string, MessageView>();
    const called = new Set<string>();
    for (const message of messages ?? []) {
      if (message.role === "toolResult" && message.toolCallId) results.set(message.toolCallId, message);
      for (const block of message.content) if (block.type === "toolCall") called.add(block.id);
    }
    const live = new Map<string, ToolView>((host?.tools ?? []).map(tool => [tool.id, tool]));
    const visible = (messages ?? []).filter(message => !(message.role === "toolResult" && message.toolCallId && called.has(message.toolCallId)));
    const orphans = (host?.tools ?? []).filter(tool => !called.has(tool.id) && !results.has(tool.id));
    return { tools: { results, live } as ToolContext, visible, orphans };
  }, [messages, host?.tools]);
  // Windowed list: while following the latest output only the newest WINDOW messages stay mounted.
  // When the reader scrolls up, or older history is loaded, the window grows so nothing moves underfoot.
  useEffect(() => {
    const grown = view.visible.length - previousCount.current;
    previousCount.current = view.visible.length;
    if (grown > 0 && !pinned.current) setWindowSize(size => size + grown);
  }, [view.visible.length]);
  useEffect(() => { setWindowSize(WINDOW); previousCount.current = 0; }, [snapshot?.epoch]);
  const start = Math.max(0, view.visible.length - windowSize);
  const shown = start ? view.visible.slice(start) : view.visible;
  function showEarlier() {
    if (feed.current) anchor.current = { height: feed.current.scrollHeight, top: feed.current.scrollTop };
    setWindowSize(size => size + WINDOW_STEP);
  }
  useLayoutEffect(() => {
    // Keep the reader's position when earlier messages are mounted above it.
    if (!anchor.current || !feed.current) return;
    feed.current.scrollTop = anchor.current.top + feed.current.scrollHeight - anchor.current.height;
    anchor.current = null;
  }, [windowSize]);
  const attachImages = (files: readonly File[]) => {
    const images = files.filter(file => IMAGE_TYPES.includes(file.type as never) || file.type.startsWith("image/"));
    if (images.length) void addImages(images);
    return images.length > 0;
  };
  const canAttach = canPrompt && !!snapshot?.caps.images;

  useEffect(() => { startConnection(); }, []);
  useEffect(() => {
    if (!state.snapshotCount) return;
    // After the commit, the next frame includes layout of the new snapshot.
    const frame = requestAnimationFrame(() => { try { performance.mark("pi-pane:snapshot-rendered"); } catch { /* optional */ } });
    return () => cancelAnimationFrame(frame);
  }, [state.snapshotCount]);
  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    // Preact's event-name inference can keep CompositionStart capitalized in browsers
    // that do not expose an oncompositionstart property. Bind the native IME events.
    const onStart = () => { composing.current = true; };
    const onEnd = () => { composing.current = false; compositionEndedAt.current = Date.now(); };
    element.addEventListener("compositionstart", onStart);
    element.addEventListener("compositionend", onEnd);
    return () => {
      element.removeEventListener("compositionstart", onStart);
      element.removeEventListener("compositionend", onEnd);
    };
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    for (const key of themeKeys.current) root.style.removeProperty(key);
    const keys: string[] = [];
    for (const [key, value] of Object.entries(snapshot?.theme ?? {})) {
      if (/^--[a-z][a-z0-9-]*$/.test(key) && typeof value === "string" && CSS.supports("color", value)) {
        root.style.setProperty(key, value); keys.push(key);
      }
    }
    themeKeys.current = keys;
    const accentLuminance = hexLuminance(snapshot?.theme["--accent"] ?? "#a5c9a8");
    if (accentLuminance !== undefined) root.style.setProperty("--button-fg", accentLuminance > .179 ? "#000000" : "#ffffff");
    const backgroundLuminance = hexLuminance(snapshot?.theme["--bg"] ?? "#171a1e");
    if (backgroundLuminance !== undefined) root.style.colorScheme = backgroundLuminance > .179 ? "light" : "dark";
  }, [snapshot?.theme]);
  useEffect(() => {
    if (!feed.current || !pinned.current) return;
    feed.current.scrollTop = feed.current.scrollHeight;
  }, [state.lastAppliedSeq, snapshot?.epoch]);
  useEffect(() => {
    // Off-screen messages start at an estimated size (content-visibility) and images settle later;
    // a reader following the latest output stays at the bottom as the real sizes arrive.
    const inner = feedInner.current;
    if (!inner || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { if (pinned.current && feed.current) feed.current.scrollTop = feed.current.scrollHeight; });
    observer.observe(inner);
    return () => observer.disconnect();
  }, [connection === "login"]);

  function handleScroll() {
    const element = feed.current;
    if (!element) return;
    pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
    setShowLatest(!pinned.current);
    if (pinned.current && windowSize > WINDOW) setWindowSize(WINDOW);
    if (start > 0 && element.scrollTop < 200 && !anchor.current) showEarlier();
  }
  function goLatest() {
    pinned.current = true; setShowLatest(false); setWindowSize(WINDOW);
    if (feed.current) feed.current.scrollTop = feed.current.scrollHeight;
  }
  function olderPage() {
    // Mount the loaded page as well: the reader asked for it.
    setWindowSize(size => Math.max(size, view.visible.length) + 1000);
    pinned.current = false;
    loadOlder();
  }
  function submit(mode: "followUp" | "steer") {
    if (!canPrompt || composing.current) return;
    submitPrompt(mode); goLatest(); textarea.current?.focus();
  }
  function onKeyDown(event: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>) {
    if (coarsePointer && !event.metaKey && !event.ctrlKey) return;
    if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229 || composing.current || Date.now() - compositionEndedAt.current < 80) return;
    event.preventDefault();
    submit(event.metaKey || event.ctrlKey ? "steer" : "followUp");
  }

  return (
    <div class="app-shell">
      <header class="topbar">
        <div class="brand"><span class="brand-icon">π</span><span>pi-pane</span><span class="milestone">M2</span></div>
        <div class="connection">
          <span class={`status-dot status-${connection}`} /><span>{labels[connection]}</span>
          {state.authMode === "password" && connection !== "login" && <button type="button" class="quiet logout-button" onClick={() => void logout()}>退出登录</button>}
        </div>
      </header>
      <div class="session-bar">
        <div class="session-identity"><h1>{snapshot?.session.name || "当前 pi 会话"}</h1><p title={snapshot?.session.cwd}>{snapshot?.session.cwd || "在浏览器中继续当前终端会话"}</p></div>
        <div class="session-details">
          {snapshot?.caps.host && <button type="button" class="sessions-button" onClick={() => { setShowSessions(value => !value); loadSessions(); }}>会话</button>}
          <span>{host?.compacting ? "压缩上下文中" : host?.running ? "正在运行" : host?.idle ? "空闲" : "状态未知"}</span>
          {host?.hasPendingMessages && <span class="queue-badge">存在待发消息</span>}
          {snapshot && <span class="mono">分支 {snapshot.session.branchRevision} · seq {state.lastAppliedSeq}</span>}
        </div>
      </div>
      {showSessions && snapshot?.caps.host && <SessionsPanel state={state} onClose={() => setShowSessions(false)} />}
      {state.dialogs[0] && <DialogView key={state.dialogs[0].id} dialog={state.dialogs[0]} />}
      {connection === "login" ? <div class="timeline"><div class="timeline-inner"><Login state={state} />{state.notice && <p class="login-notice" role="status">{state.notice}</p>}</div></div> : <>
      {state.notice && <div class={`notice notice-${connection}`} role="status"><span>{state.notice}</span>{(connection === "disconnected" || connection === "fatal") && <button type="button" onClick={reconnect}>重新连接</button>}</div>}
      {!!host?.uiPrompts.length && <div class="terminal-notice" role="status"><strong>请在终端处理对话框</strong>{host.uiPrompts.map((prompt, i) => <span key={i}>{prompt.title || prompt.kind}</span>)}</div>}
      <div class="timeline" ref={feed} onScroll={handleScroll} aria-live="off" aria-label="当前分支会话历史">
        <div class="timeline-inner" ref={feedInner}>
          {start > 0 && <div class="history-limit"><button type="button" onClick={showEarlier}>显示更早的 {Math.min(start, WINDOW_STEP)} 条（已在浏览器中）</button></div>}
          {!start && snapshot?.session.olderCursor && <div class="history-limit"><button type="button" disabled={state.historyLoading || !online} onClick={olderPage}>{state.historyLoading ? "正在加载更早的消息…" : "加载更早的消息"}</button>{state.historyError && <span>{state.historyError}</span>}</div>}
          {!snapshot ? <div class="empty-state"><span class="empty-pi">π</span><h2>{connection === "switching" ? "等待新会话" : "连接当前会话"}</h2><p>在终端输入 /web 后，当前分支和正在生成的内容会显示在这里。</p></div> : !snapshot.session.messages.length && !host?.tools.length ? <div class="empty-state"><span class="empty-pi">π</span><h2>可以开始了</h2><p>终端与浏览器共享同一个会话。发送消息后，pi 的实际输出会出现在这里。</p></div> : null}
          {shown.map(message => <Message key={message.id} message={message} tools={view.tools} expansions={state.expansions} />)}
          {!!view.orphans.length && <div class="tools"><div class="section-label">工具执行</div>{view.orphans.map(tool => <ToolCard key={tool.id} live={tool} expansions={state.expansions} />)}</div>}
          {host?.running && <div class="running-line"><span class="running-indicator" />pi 正在运行</div>}
        </div>
      </div>
      {showLatest && <button type="button" class="go-latest" onClick={goLatest}>↓ 回到最新</button>}
      <footer class="composer-region">
        <div class="composer-inner">
          <div class="host-controls">
            <label><span>模型</span><select aria-label="模型" value={host?.model ? JSON.stringify({ provider: host.model.provider, id: host.model.id }) : ""} disabled={!canConfigure || !snapshot?.caps.commands.includes("set_model")} onChange={event => { const model = event.currentTarget.value; if (model) issueCommand("set_model", JSON.parse(model)); }}><option value="">{host?.model?.name || "未设置"}</option>{host?.models.map(model => <option key={`${model.provider}:${model.id}`} value={JSON.stringify({ provider: model.provider, id: model.id })}>{model.name || model.id}</option>)}</select></label>
            <label><span>thinking</span><select aria-label="thinking 等级" value={host?.thinking ?? "off"} disabled={!canConfigure || !snapshot?.caps.commands.includes("set_thinking")} onChange={event => issueCommand("set_thinking", { level: event.currentTarget.value })}>{["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(level => <option value={level} key={level}>{level}</option>)}</select></label>
            <button type="button" class="compact-button" disabled={!canConfigure || !!host?.hasPendingMessages || !snapshot?.caps.commands.includes("compact")} onClick={() => issueCommand("compact")}>压缩上下文</button>
          </div>
          <div class={`composer ${!canPrompt ? "composer-disabled" : ""} ${dragging ? "composer-dragging" : ""}`}
            onDragOver={event => { if (canAttach && event.dataTransfer?.types.includes("Files")) { event.preventDefault(); setDragging(true); } }}
            onDragLeave={() => setDragging(false)}
            onDrop={event => { setDragging(false); if (!canAttach || !event.dataTransfer?.files.length) return; event.preventDefault(); attachImages([...event.dataTransfer.files]); }}>
            <Attachments items={state.attachments} error={state.attachmentError} />
            {!!state.attachments.length && host?.model?.images === false && <p class="warn-text">当前模型未声明支持图片输入，pi 可能会忽略这些图片。</p>}
            <textarea ref={textarea} aria-label="消息" rows={3} placeholder={host?.running ? coarsePointer ? "补充下一步…" : "补充下一步… Enter 请求 followUp；⌘ / Ctrl + Enter 请求 steer" : "给 pi 发送消息…"} value={state.draft} onInput={event => setDraft(event.currentTarget.value)} onKeyDown={onKeyDown}
              onPaste={event => { if (canAttach && event.clipboardData?.files.length && attachImages([...event.clipboardData.files])) event.preventDefault(); }} />
            <input ref={fileInput} type="file" accept={IMAGE_TYPES.join(",")} multiple hidden onChange={event => { attachImages([...(event.currentTarget.files ?? [])]); event.currentTarget.value = ""; }} />
            <div class="composer-actions"><span class="input-hint">{coarsePointer ? "Enter 换行 · 按钮发送" : "Enter 发送 · Shift + Enter 换行 · 可粘贴或拖入图片"}</span><div class="action-buttons"><button type="button" class="attach-button" disabled={!canAttach || state.attachments.length >= 4} onClick={() => fileInput.current?.click()} aria-label="添加图片">图片</button>{host && !host.idle && <button type="button" class="abort-button" disabled={!online || !snapshot?.caps.commands.includes("abort")} onClick={() => issueCommand("abort")}>■ 中止</button>}<button type="button" class="steer-button" disabled={!canPrompt || (!state.draft.trim() && !state.attachments.length)} onClick={() => submit("steer")} title="⌘ / Ctrl + Enter">steer</button><button type="button" class="send-button" disabled={!canPrompt || (!state.draft.trim() && !state.attachments.length)} onClick={() => submit("followUp")}>{host?.running ? "请求 followUp ↗" : "发送 ↗"}</button></div></div>
          </div>
          <p class="scope-note">{snapshot?.caps.host ? "会话已交给浏览器：输入与终端相同，slash 命令、模板和 skill 会被执行或展开。在终端按 Ctrl+C 交还会话。" : "网页按原文提交，不执行 slash 命令，也不展开模板 / skill。回执只确认已交给 pi。"}</p>
          <Receipts items={state.submissions} online={online} onRecover={text => { setDraft(text); textarea.current?.focus(); }} />
        </div>
      </footer>
      </>}
    </div>
  );
}

render(<App />, document.getElementById("app")!);
