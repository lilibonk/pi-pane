import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import {
  forgetSubmission, issueCommand, loadOlder, queryReceipt, reconnect, setDraft, startConnection, submitPrompt,
  webStore, type MessageView, type Submission, type ToolView, type WebState,
} from "./store.js";
import "./style.css";

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

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  if (typeof value === "object" && "content" in value && Array.isArray(value.content)) {
    return value.content.map((part: unknown) => {
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
      if (part && typeof part === "object" && "type" in part && part.type === "image") return "[图片：M0 暂不展示]";
      return "";
    }).filter(Boolean).join("\n");
  }
  try { return JSON.stringify(value, null, 2); } catch { return "[无法展示的结果]"; }
}

function Message({ message }: { message: MessageView }) {
  const role = message.role === "user" ? "你" : message.role === "assistant" ? "pi" :
    message.role === "toolResult" ? message.toolName ?? "工具结果" : message.role;
  return (
    <article class={`message message-${message.role} ${message.isError ? "message-error" : ""}`} data-message-id={message.id}>
      <div class="message-meta"><span class="role">{role}</span>{message.status === "streaming" && <span class="streaming">正在生成</span>}</div>
      <div class="message-body">
        {message.content.map((content, index) => content.type === "thinking" ? (
          <details class="thinking" key={index}>
            <summary>思考过程{message.status === "streaming" ? " · 生成中" : ""}</summary>
            <pre>{content.text}</pre>
          </details>
        ) : content.type === "toolCall" ? (
          <details class="tool-call" key={index}>
            <summary><span class="mono">{content.name}</span><span>工具调用</span></summary>
            <pre>{outputText(content.arguments)}</pre>
          </details>
        ) : <pre class="message-text" key={index}>{content.text}</pre>)}
        {!message.content.length && <span class="empty-content">等待内容…</span>}
        {message.truncated && <p class="truncation">内容已截断。M0 保留有界预览，完整内容请查看终端。</p>}
      </div>
    </article>
  );
}

function Tool({ tool }: { tool: ToolView }) {
  const result = tool.output;
  return (
    <details class={`tool-card tool-${tool.status} ${tool.parentToolCallId ? "tool-nested" : ""}`} open={tool.status === "running"} data-tool-id={tool.id}>
      <summary>
        <span class="tool-title"><span class="tool-symbol">⌘</span><span class="mono">{tool.name}</span></span>
        <span class="tool-status">{tool.status === "running" ? "执行中" : tool.status === "error" ? "执行失败" : "已结束"}</span>
      </summary>
      <div class="tool-body">
        {tool.parentToolCallId && <p class="subtle">嵌套调用 · {tool.parentToolCallId}</p>}
        <div class="tool-label">参数</div><pre>{outputText(tool.args)}</pre>
        {result !== undefined && <><div class="tool-label">{tool.status === "running" ? "当前输出" : "结果"}{tool.outputTotal ? ` · 仅显示末尾，共 ${tool.outputTotal} 字符` : ""}</div><pre>{result}</pre></>}
      </div>
    </details>
  );
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

const labels = { connecting: "连接中", online: "已连接", resyncing: "同步中", switching: "切换中", disconnected: "已断开", fatal: "需重新连接" };
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
  const feed = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const composing = useRef(false);
  const compositionEndedAt = useRef(0);
  const [showLatest, setShowLatest] = useState(false);
  const themeKeys = useRef<string[]>([]);
  const online = connection === "online" && !!snapshot && !!state.clientId;
  const host = snapshot?.state;
  const canPrompt = online && !!snapshot?.caps.commands.includes("prompt") && !host?.compacting && !host?.uiPrompts.length;
  const canConfigure = online && !!host?.idle && !host.compacting && !host.uiPrompts.length;

  useEffect(() => { startConnection(); }, []);
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

  function handleScroll() {
    const element = feed.current;
    if (!element) return;
    pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
    setShowLatest(!pinned.current);
  }
  function goLatest() {
    pinned.current = true; setShowLatest(false);
    if (feed.current) feed.current.scrollTop = feed.current.scrollHeight;
  }
  function submit(mode: "followUp" | "steer") {
    if (!canPrompt || composing.current) return;
    submitPrompt(mode); goLatest(); textarea.current?.focus();
  }
  function onKeyDown(event: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229 || composing.current || Date.now() - compositionEndedAt.current < 80) return;
    event.preventDefault();
    submit(event.metaKey || event.ctrlKey ? "steer" : "followUp");
  }

  return (
    <div class="app-shell">
      <header class="topbar">
        <div class="brand"><span class="brand-icon">π</span><span>pi-pane</span><span class="milestone">M0</span></div>
        <div class="connection"><span class={`status-dot status-${connection}`} /><span>{labels[connection]}</span></div>
      </header>
      <div class="session-bar">
        <div class="session-identity"><h1>{snapshot?.session.name || "当前 pi 会话"}</h1><p title={snapshot?.session.cwd}>{snapshot?.session.cwd || "在浏览器中继续当前终端会话"}</p></div>
        <div class="session-details">
          <span>{host?.compacting ? "压缩上下文中" : host?.running ? "正在运行" : host?.idle ? "空闲" : "状态未知"}</span>
          {host?.hasPendingMessages && <span class="queue-badge">存在待发消息</span>}
          {snapshot && <span class="mono">分支 {snapshot.session.branchRevision} · seq {state.lastAppliedSeq}</span>}
        </div>
      </div>
      {state.notice && <div class={`notice notice-${connection}`} role="status"><span>{state.notice}</span>{(connection === "disconnected" || connection === "fatal") && <button type="button" onClick={reconnect}>重新连接</button>}</div>}
      {!!host?.uiPrompts.length && <div class="terminal-notice" role="status"><strong>请在终端处理对话框</strong>{host.uiPrompts.map((prompt, i) => <span key={i}>{prompt.title || prompt.kind}</span>)}</div>}
      <div class="timeline" ref={feed} onScroll={handleScroll} aria-live="off" aria-label="当前分支会话历史">
        <div class="timeline-inner">
          {snapshot?.session.olderCursor && <div class="history-limit"><button type="button" disabled={state.historyLoading || !online} onClick={loadOlder}>{state.historyLoading ? "正在加载更早的消息…" : "加载更早的消息"}</button>{state.historyError && <span>{state.historyError}</span>}</div>}
          {!snapshot ? <div class="empty-state"><span class="empty-pi">π</span><h2>{connection === "switching" ? "等待新会话" : "连接当前会话"}</h2><p>在终端输入 /web 后，当前分支和正在生成的内容会显示在这里。</p></div> : !snapshot.session.messages.length && !host?.tools.length ? <div class="empty-state"><span class="empty-pi">π</span><h2>可以开始了</h2><p>终端与浏览器共享同一个会话。发送消息后，pi 的实际输出会出现在这里。</p></div> : null}
          {snapshot?.session.messages.map(message => <Message key={message.id} message={message} />)}
          {!!host?.tools.length && <div class="tools"><div class="section-label">工具执行</div>{host.tools.map(tool => <Tool key={tool.id} tool={tool} />)}</div>}
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
          <div class={`composer ${!canPrompt ? "composer-disabled" : ""}`}>
            <textarea ref={textarea} aria-label="消息" rows={3} placeholder={host?.running ? "补充下一步… Enter 请求 followUp；⌘ / Ctrl + Enter 请求 steer" : "给 pi 发送消息…"} value={state.draft} onInput={event => setDraft(event.currentTarget.value)} onKeyDown={onKeyDown} />
            <div class="composer-actions"><span class="input-hint">Enter 发送 · Shift + Enter 换行</span><div class="action-buttons">{host && !host.idle && <button type="button" class="abort-button" disabled={!online || !snapshot?.caps.commands.includes("abort")} onClick={() => issueCommand("abort")}>■ 中止</button>}<button type="button" class="steer-button" disabled={!canPrompt || !state.draft.trim()} onClick={() => submit("steer")} title="⌘ / Ctrl + Enter">steer</button><button type="button" class="send-button" disabled={!canPrompt || !state.draft.trim()} onClick={() => submit("followUp")}>{host?.running ? "请求 followUp ↗" : "发送 ↗"}</button></div></div>
          </div>
          <p class="scope-note">M0 以纯文本提交；不会执行网页中的 slash 命令或自动展开模板 / skill。消息提交仅确认已调用 pi。</p>
          <Receipts items={state.submissions} online={online} onRecover={text => { setDraft(text); textarea.current?.focus(); }} />
        </div>
      </footer>
    </div>
  );
}

render(<App />, document.getElementById("app")!);
