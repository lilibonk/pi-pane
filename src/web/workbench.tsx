import type { ComponentChildren, RefObject } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { WorkbenchAction, WorkbenchCommand, WorkbenchValues, WorkspaceFileView } from "../protocol/workbench.js";
import { Diff } from "./messages.js";
import { highlight, languageForPath } from "./highlight.js";
import { copyReply, issueCommand, openSettings, queryWorkbench, setDraft, setSessionDialog, webStore, type WebState } from "./store.js";
import { LIMITS } from "../protocol/index.js";
import { ProjectSection } from "./projects.js";

export interface QueryState<T> { value?: T; loading: boolean; error: string; reload: () => void }
/** Cancelling the component read also removes its transport timeout and reply handler. */
export function useWorkbenchQuery<A extends WorkbenchAction>(state: WebState, action: A, args: Record<string, unknown> = {}, enabled = true): QueryState<WorkbenchValues[A]> {
  const [value, setValue] = useState<WorkbenchValues[A] | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [revision, refresh] = useState(0);
  const wasRunning = useRef(state.snapshot?.state.running);
  const argKey = JSON.stringify(args);
  const ready = enabled && state.connection === "online" && !!state.snapshot?.caps.workbench;
  useEffect(() => {
    const running = state.snapshot?.state.running;
    if (wasRunning.current && running === false) refresh(value => value + 1);
    wasRunning.current = running;
  }, [state.snapshot?.state.running]);
  useEffect(() => {
    setValue(undefined); setError("");
    if (!ready) { setLoading(false); return; }
    const abort = new AbortController();
    setLoading(true);
    void queryWorkbench(action, JSON.parse(argKey), abort.signal).then(result => {
      if (!abort.signal.aborted) { setValue(result); setLoading(false); }
    }, failure => {
      if (!abort.signal.aborted) { setError(failure instanceof Error ? failure.message : "读取失败，请重试。"); setLoading(false); }
    });
    return () => abort.abort();
  }, [ready, action, argKey, state.snapshot?.epoch, state.snapshot?.session.branchRevision, state.snapshot?.session.name, state.snapshot?.state.model?.provider, state.snapshot?.state.model?.id, state.snapshotCount, revision]);
  return { value, loading, error, reload: () => refresh(value => value + 1) };
}

function Icon({ name }: { name: "menu" | "panel" | "plus" | "search" | "settings" | "refresh" | "close" | "branch" | "file" | "arrow" | "trash" }) {
  const paths = {
    menu: <><path d="M4 5h16M4 12h16M4 19h16" /></>,
    panel: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></>,
    settings: <><path d="m9 3-1 3-3 1 1 3-2 2 2 2-1 3 3 1 1 3h6l1-3 3-1-1-3 2-2-2-2 1-3-3-1-1-3z" /><circle cx="12" cy="12" r="3" /></>,
    refresh: <><path d="M20 9a8 8 0 1 0-1 9M20 4v5h-5" /></>,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    branch: <><circle cx="6" cy="5" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="6" cy="19" r="2" /><path d="M6 7v10M18 8v2c0 4-12 1-12 5" /></>,
    file: <><path d="M14 3H5v18h14V8zM14 3v5h5" /></>,
    arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
    trash: <><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" /></>,
  };
  return <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function ReadState({ read, empty, children }: { read: QueryState<unknown>; empty?: string; children?: ComponentChildren }) {
  if (read.loading) return <p class="panel-message" role="status">正在加载…</p>;
  if (read.error) return <div class="panel-message panel-error" role="alert"><p>{read.error}</p><button type="button" onClick={read.reload}>重新加载</button></div>;
  if (!read.value) return <p class="panel-message">{empty || "连接后显示当前工作区。"}</p>;
  return <>{children}</>;
}

function workspaceName(path: string): string { return path.replace(/\/$/, "").split(/[\\/]/).pop() || path || "当前工作区"; }
function useDebounced(value: string): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => { const timer = setTimeout(() => setSettled(value.slice(0, 256)), 180); return () => clearTimeout(timer); }, [value]);
  return settled;
}
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const media = matchMedia(query);
    const change = () => setMatches(media.matches);
    change(); media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, [query]);
  return matches;
}
function utf8Prefix(text: string, bytes: number): string {
  if (bytes <= 0) return "";
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength <= bytes) return text;
  let end = bytes;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(encoded.subarray(0, end));
}
function timeLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}
const sourceLabels = { builtin: "内置", extension: "扩展", skill: "技能", prompt: "模板" };
const entryTypeLabels: Record<string, string> = { model_change: "模型切换", thinking_level_change: "思考强度", compaction: "上下文压缩", branch_summary: "分支摘要", session_info: "会话信息", custom: "扩展记录" };
const capabilityLabels: Record<string, [string, string]> = {
  session: ["会话导航", "浏览器通过 RPC 新建、恢复、重命名、克隆和分叉会话。"],
  workspace: ["工作区文件与 Git", "可查看当前工作区文件、未提交改动与文本差异。"],
  dialogs: ["网页提问与确认", "扩展的选择、确认、输入和编辑对话框在网页处理。"],
  authentication: ["模型登录", "在“设置 → 账户”里登录或退出。"],
  settings: ["设置", "在“设置”里选择外观并修改 pi 的默认值。"],
  "resource-management": ["资源管理", "可查看技能与模板；工具列表和启停需要 pi RPC 上游支持。"],
};

export interface WorkbenchController {
  execute: (command: WorkbenchCommand, args?: string) => boolean;
  files: (reference?: boolean, query?: string) => void;
}
export function CommandMenu({ commands, draft, onChoose }: { commands: WorkbenchCommand[]; draft: string; onChoose: (command: WorkbenchCommand) => void }) {
  if (!/^\/[^\s]*$/.test(draft)) return null;
  const needle = draft.slice(1).toLowerCase();
  const matching = commands.filter(command => command.name.toLowerCase().includes(needle)).slice(0, 12);
  return <div class="command-menu" aria-label="斜杠命令" role="region">
    <div class="picker-label">命令、技能与模板</div>
    {!matching.length && <p class="panel-message">没有匹配的命令。普通消息可直接发送。</p>}
    {matching.map((command, index) => <button type="button" class="command-option" key={`${command.source}:${command.name}:${index}`} disabled={!command.available} title={command.reason || command.description} onClick={() => onChoose(command)}>
      <span class="command-name">/{command.name}</span><span class="command-description">{command.available ? command.description : command.reason || "需在终端使用"}</span><span class="source-chip">{sourceLabels[command.source]}</span>
    </button>)}
  </div>;
}

function FileCode({ value }: { value: WorkspaceFileView }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    void highlight(value.text, value.language || languageForPath(value.path)).then(result => { if (!cancelled) setHtml(result); });
    return () => { cancelled = true; };
  }, [value.path, value.text, value.language]);
  return html ? <div class="file-code" dangerouslySetInnerHTML={{ __html: html }} /> : <pre class="file-code">{value.text}</pre>;
}

export function Workbench({ state, canConfigure, commands, controller, onFocusComposer, children }: {
  state: WebState; canConfigure: boolean; commands: WorkbenchCommand[]; controller: RefObject<WorkbenchController | undefined>; onFocusComposer: () => void; children: ComponentChildren;
}) {
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(() => !matchMedia("(max-width: 1100px)").matches);
  const [leftMode, setLeftMode] = useState<"sessions" | "tree">("sessions");
  const [sessionSearch, setSessionSearch] = useState("");
  const [tab, setTab] = useState<"changes" | "files" | "resources">("changes");
  const [resourceTab, setResourceTab] = useState<"models" | "tools" | "commands" | "capabilities">("models");
  const [fileSearch, setFileSearch] = useState("");
  const [selectedPath, setSelectedPath] = useState("");
  const [previewMode, setPreviewMode] = useState<"file" | "diff">("diff");
  const [referenceMode, setReferenceMode] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [sessionName, setSessionName] = useState("");
  const [rotateConfirm, setRotateConfirm] = useState(false);
  const leftRef = useRef<HTMLElement>(null);
  const rightRef = useRef<HTMLElement>(null);
  const toggleLeft = useRef<HTMLButtonElement>(null);
  const toggleRight = useRef<HTMLButtonElement>(null);
  const workbenchRef = useRef<HTMLDivElement>(null);
  const narrow = useMediaQuery("(max-width: 760px)");
  const overlayInspector = useMediaQuery("(max-width: 1100px)");
  const modal = narrow && leftOpen ? "left" : overlayInspector && rightOpen ? "right" : null;
  const online = state.connection === "online" && !!state.snapshot?.caps.workbench;
  const settledSessionSearch = useDebounced(sessionSearch);
  const settledFileSearch = useDebounced(fileSearch);
  // The sidebar lists the current project's sessions; a search looks through every project.
  const sessions = useWorkbenchQuery(state, "sessions", { scope: settledSessionSearch ? "all" : "workspace", query: settledSessionSearch });
  useEffect(() => { if (state.sessionsChanged) sessions.reload(); }, [state.sessionsChanged]);
  const tree = useWorkbenchQuery(state, "tree", {}, leftMode === "tree");
  const status = useWorkbenchQuery(state, "git_status", {}, rightOpen && tab === "changes");
  const files = useWorkbenchQuery(state, "files", { query: settledFileSearch }, rightOpen && tab === "files");
  const file = useWorkbenchQuery(state, "file", { path: selectedPath }, rightOpen && !!selectedPath && previewMode === "file" && tab !== "resources");
  const diff = useWorkbenchQuery(state, "git_diff", { path: selectedPath }, rightOpen && !!selectedPath && previewMode === "diff" && tab === "changes");
  const resources = useWorkbenchQuery(state, "resources", {}, rightOpen && tab === "resources");
  const pendingSession = state.submissions.some(item => item.epoch === state.snapshot?.epoch && item.command.startsWith("session_") && (item.status === "sent" || item.status === "dispatched"));
  const canNavigate = online && canConfigure && !state.snapshot?.state.hasPendingMessages && !pendingSession;
  const sessionsRead = { ...sessions, loading: sessions.loading || sessionSearch.slice(0, 256) !== settledSessionSearch };
  const filesRead = { ...files, loading: files.loading || fileSearch.slice(0, 256) !== settledFileSearch };
  const catalog = useMemo(() => {
    // The server searches every message, including text absent from catalog metadata.
    const visible = sessions.value?.sessions ?? [];
    const groups = new Map<string, typeof visible>();
    for (const item of visible) { const group = groups.get(item.cwd) ?? []; group.push(item); groups.set(item.cwd, group); }
    return [...groups.entries()];
  }, [sessions.value]);
  const treeDepths = useMemo(() => {
    const entries = new Map((tree.value?.entries ?? []).map(entry => [entry.id, entry]));
    const depths = new Map<string, number>();
    for (const entry of entries.values()) {
      let depth = 0, parent = entry.parentId;
      const seen = new Set<string>();
      while (parent && entries.has(parent) && !seen.has(parent) && depth < 8) { seen.add(parent); depth++; parent = entries.get(parent)!.parentId; }
      depths.set(entry.id, depth);
    }
    return depths;
  }, [tree.value]);
  useEffect(() => { setSelectedPath(""); setReferenceMode(false); setRenaming(false); setRotateConfirm(false); }, [state.snapshot?.epoch]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !modal || state.dialogs.length) return;
      event.preventDefault();
      if (modal === "left") { setLeftOpen(false); requestAnimationFrame(() => toggleLeft.current?.focus()); }
      else { setRightOpen(false); requestAnimationFrame(() => toggleRight.current?.focus()); }
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [modal, state.dialogs.length]);
  useLayoutEffect(() => {
    const panel = modal === "left" ? leftRef.current : modal === "right" ? rightRef.current : null;
    if (!panel || state.dialogs.length) return;
    const topbar = workbenchRef.current?.parentElement?.querySelector<HTMLElement>(":scope > .topbar");
    const previousInert = topbar?.inert;
    if (topbar) topbar.inert = true;
    const focusable = () => [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex="0"]')].filter(element => element.getClientRects().length && !element.closest("[inert]"));
    const firstInput = panel.querySelector<HTMLInputElement>("input:not(:disabled)");
    if (!panel.contains(document.activeElement)) (firstInput || focusable()[0])?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const elements = focusable();
      const first = elements[0], last = elements.at(-1);
      if (!first || !last) return;
      if (!panel.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", trap);
    return () => { document.removeEventListener("keydown", trap); if (topbar) topbar.inert = previousInert ?? false; };
  }, [modal, state.dialogs.length]);
  useEffect(() => {
    if (!leftOpen) return;
    const element = leftRef.current?.querySelector<HTMLInputElement>("input");
    element?.focus();
  }, [leftOpen]);
  function focusComposer() { requestAnimationFrame(onFocusComposer); }
  function focusInspector() { requestAnimationFrame(() => rightRef.current?.querySelector<HTMLElement>('input:not(:disabled), button:not(:disabled)')?.focus()); }
  function showFiles(reference = false, query = "") { setTab("files"); setLeftOpen(false); setRightOpen(true); setReferenceMode(reference); setFileSearch(query); setSelectedPath(""); }
  function run(command: WorkbenchCommand, args = ""): boolean {
    if (!command.available) return false;
    // Picker builtins do not silently discard arguments or send their syntax to the model.
    if (command.browserAction && args.trim() && command.browserAction !== "rename") return false;
    switch (command.browserAction) {
      case "sessions": setLeftMode("sessions"); setLeftOpen(true); if (overlayInspector) setRightOpen(false); break;
      case "tree": setLeftMode("tree"); setLeftOpen(true); if (overlayInspector) setRightOpen(false); break;
      case "model": setTab("resources"); setResourceTab("models"); setLeftOpen(false); setRightOpen(true); focusInspector(); break;
      case "thinking": {
        const picker = document.querySelector<HTMLSelectElement>('select[aria-label="thinking 等级"]');
        if (!picker || picker.disabled) return false;
        picker.focus(); break;
      }
      case "accounts": setLeftOpen(false); if (overlayInspector) setRightOpen(false); openSettings("accounts"); break;
      case "settings": setLeftOpen(false); if (overlayInspector) setRightOpen(false); openSettings(); break;
      case "resources": setTab("resources"); setResourceTab("commands"); setLeftOpen(false); setRightOpen(true); focusInspector(); break;
      case "status": setLeftOpen(false); if (overlayInspector) setRightOpen(false); setSessionDialog({ mode: "info" }); break;
      case "export": setLeftOpen(false); if (overlayInspector) setRightOpen(false); setSessionDialog({ mode: "export" }); break;
      case "copy": void copyReply(); break;
      case "new": if (!canNavigate) return false; issueCommand("session_new"); break;
      case "compact": if (!canNavigate) return false; issueCommand("compact"); break;
      case "clone": if (!canNavigate) return false; issueCommand("session_clone"); break;
      case "rename":
        if (!canNavigate) return false;
        if (args.trim()) issueCommand("session_rename", { name: args.trim() });
        else { setSessionName(state.snapshot?.session.name || ""); setRenaming(true); setLeftMode("sessions"); setLeftOpen(true); if (overlayInspector) setRightOpen(false); }
        break;
      default: if (!canConfigure) return false; issueCommand("run_command", { name: command.name, args }, `/${command.name}${args ? ` ${args}` : ""}`); break;
    }
    return true;
  }
  controller.current = { execute: run, files: showFiles };
  function referenceFile() {
    if (!file.value || file.value.binary) return;
    const value = file.value;
    const current = webStore.getState().draft;
    const cleaned = current.replace(/(?:^|\s)@[^\s]*$/, "");
    const gap = cleaned ? "\n\n" : "";
    let longestFence = 2;
    for (const match of utf8Prefix(value.text, 24 * 1024).matchAll(/`+/g)) longestFence = Math.max(longestFence, match[0].length);
    const fence = "`".repeat(longestFence + 1);
    const pathLabel = JSON.stringify(value.path);
    const note = "\n（以下为文件内容引用；超出引用上限时只包含前面的片段。）";
    const prefix = `${cleaned}${gap}文件：${pathLabel}${note}\n${fence}${value.language || ""}\n`;
    const suffix = `\n${fence}\n`;
    const remaining = LIMITS.promptBytes - new TextEncoder().encode(prefix + suffix).byteLength;
    if (remaining <= 0) { webStore.setState({ notice: "当前消息已接近文本上限，请缩短后再引用文件。" }); return; }
    const excerpt = utf8Prefix(value.text, Math.min(24 * 1024, remaining));
    const clipped = value.truncated || excerpt.length < value.text.length;
    const actualNote = clipped ? note : "";
    // A real excerpt is sent with the prompt; no unimplemented @path resolution is implied.
    setDraft(`${cleaned}${gap}文件：${pathLabel}${actualNote}\n${fence}${value.language || ""}\n${excerpt}${suffix}`);
    if (clipped) webStore.setState({ notice: "已引用文件前面的片段（最多 24 KiB）；发送前可在输入框检查内容。" });
    setReferenceMode(false);
    if (matchMedia("(max-width: 1100px)").matches) setRightOpen(false);
    focusComposer();
  }
  function choosePath(path: string, mode: "file" | "diff") { setSelectedPath(path); setPreviewMode(mode); }
  const currentCwd = state.snapshot?.session.cwd || "";
  // After a project was chosen on a phone, the conversation is what the user came for.
  const shownProject = useRef(currentCwd);
  useEffect(() => {
    if (!currentCwd || currentCwd === shownProject.current) return;
    const first = !shownProject.current; shownProject.current = currentCwd;
    if (!first && matchMedia("(max-width: 760px)").matches) { setLeftOpen(false); focusComposer(); }
  }, [currentCwd]);
  return <div class={`workbench ${leftOpen ? "left-open" : ""} ${rightOpen ? "right-open" : ""}`} ref={workbenchRef}>
    {modal && <button type="button" tabindex={-1} class={`drawer-backdrop ${modal === "left" ? "for-left" : "for-right"}`} aria-label="关闭侧栏" onClick={() => { setLeftOpen(false); setRightOpen(false); focusComposer(); }} />}
    <aside class="workspace-sidebar" aria-label="工作区与会话" ref={leftRef} role={modal === "left" ? "dialog" : undefined} aria-modal={modal === "left" ? true : undefined} inert={modal === "right" || (narrow && !leftOpen)} aria-hidden={modal === "right" || (narrow && !leftOpen) ? true : undefined}>
      <ProjectSection state={state} canSwitch={canNavigate} onSwitched={() => { setLeftOpen(false); focusComposer(); }} />
      <div class="sidebar-heading"><span>会话</span><button type="button" class="icon-button mobile-close" aria-label="关闭会话侧栏" onClick={() => { setLeftOpen(false); requestAnimationFrame(() => toggleLeft.current?.focus()); }}><Icon name="close" /></button><button type="button" class="icon-button" aria-label="刷新会话列表" disabled={!online || sessionsRead.loading} onClick={sessions.reload}><Icon name="refresh" /></button></div>
      <button type="button" class="new-session-button" disabled={!canNavigate} onClick={() => issueCommand("session_new")}><Icon name="plus" />新建会话</button>
      <div class="session-management"><button type="button" disabled={!canNavigate} onClick={() => { setSessionName(state.snapshot?.session.name || ""); setRenaming(value => !value); }}>重命名</button><button type="button" disabled={!canNavigate} onClick={() => issueCommand("session_clone")}>克隆会话</button></div>
      {renaming && <form class="rename-session" onSubmit={event => { event.preventDefault(); if (canNavigate && sessionName.trim()) { issueCommand("session_rename", { name: sessionName.trim() }); setRenaming(false); } }}><input aria-label="会话名称" maxLength={256} value={sessionName} onInput={event => setSessionName(event.currentTarget.value)} placeholder="会话名称" /><button type="submit" disabled={!canNavigate || !sessionName.trim()}>保存</button><button type="button" class="quiet" onClick={() => setRenaming(false)}>取消</button></form>}
      <label class="panel-search"><Icon name="search" /><input type="search" aria-label="搜索会话" placeholder="搜索会话" value={sessionSearch} onInput={event => { setSessionSearch(event.currentTarget.value); setLeftMode("sessions"); }} /></label>
      <div class="sidebar-tabs" role="group" aria-label="会话导航"><button type="button" aria-pressed={leftMode === "sessions"} onClick={() => setLeftMode("sessions")}>会话</button><button type="button" aria-pressed={leftMode === "tree"} onClick={() => setLeftMode("tree")}><Icon name="branch" />分支树</button></div>
      <div class="sidebar-scroll">
        {leftMode === "sessions" ? <ReadState read={sessionsRead}>
          {!catalog.length && <p class="panel-message">{sessionSearch ? "没有匹配的会话。" : "这个项目尚无会话。发送第一条消息后会出现在这里。"}</p>}
          {catalog.map(([cwd, items]) => <section class="workspace-group" key={cwd}><h2 title={cwd}><span class="folder-mark">▱</span>{workspaceName(cwd)}<span>{items.length}</span></h2>{items.map(item => <div class="session-row" key={item.id}><button type="button" class={`session-item ${item.current ? "is-current" : ""}`} aria-current={item.current ? "page" : undefined} title={item.name || item.firstMessage || "未命名会话"} disabled={!item.current && !canNavigate} onClick={() => { if (!item.current) issueCommand("session_switch", { sessionId: item.id }); setLeftOpen(false); focusComposer(); }}><span class="session-item-title">{item.name || item.firstMessage || "未命名会话"}</span><span class="session-item-meta">{item.current ? "当前会话" : `${item.messageCount} 条消息`}<time>{timeLabel(item.modified)}</time></span></button>{!item.current && <button type="button" class="icon-button session-delete" aria-label={`删除会话：${item.name || item.firstMessage || "未命名会话"}`} title="删除这个会话" disabled={!online} onClick={() => setSessionDialog({ mode: "delete", sessionId: item.id })}><Icon name="trash" /></button>}</div>)}</section>)}
          {sessions.value?.truncated && <p class="panel-message">仅显示最近的部分会话。</p>}
        </ReadState> : <ReadState read={tree}>
          <p class="reference-note">分支树为只读。pi RPC 暂不支持 tree 导航；可从用户消息之前创建新分叉。</p>
          {!tree.value?.entries.length && <p class="panel-message">发送消息后，这里会显示会话分支。</p>}
          {tree.value?.entries.map(entry => {
            const depth = treeDepths.get(entry.id) ?? 0;
            const title = entry.label || ({ user: "你", assistant: "pi", toolResult: "工具", system: "系统" } as Record<string, string>)[entry.role || ""] || entryTypeLabels[entry.type] || entry.type;
            const preview = entry.preview === entry.type && entryTypeLabels[entry.type] ? "" : entry.preview;
            return <div class={`tree-entry ${entry.current ? "is-current" : ""}`} key={entry.id} style={{ paddingLeft: `${10 + depth * 10}px` }}><button type="button" class="tree-target" disabled title="pi RPC 暂不支持 tree 导航"><span class="tree-dot" /><span><strong>{title}</strong>{preview && <span>{preview}</span>}</span></button>{entry.role === "user" && <button type="button" class="tree-fork" disabled={!canNavigate} aria-label={`从 ${entry.preview.slice(0, 40) || "这条消息"} 分叉`} title="从这条用户消息之前分叉，并恢复原文到输入框" onClick={() => issueCommand("session_fork", { entryId: entry.id })}><Icon name="branch" /></button>}</div>;
          })}
          {tree.value?.truncated && <p class="panel-message">分支树已截断，更多内容请在终端查看。</p>}
        </ReadState>}
      </div>
      <div class="sidebar-footer"><p>{pendingSession ? "正在处理会话或模型操作…" : !canNavigate && online ? "运行或待发消息处理完后可切换。" : "浏览器管理当前会话；终端 Ctrl+C 停止服务。"}</p><button type="button" class="settings-button" onClick={() => { setLeftOpen(false); openSettings(); }}><Icon name="settings" />设置<Icon name="arrow" /></button></div>
    </aside>
    <main class="conversation-panel" inert={!!modal} aria-hidden={modal ? true : undefined}>
      <div class="workbench-controls"><button type="button" class="icon-button sidebar-toggle" ref={toggleLeft} aria-label="打开工作区与会话" aria-expanded={leftOpen} onClick={() => { setLeftOpen(!leftOpen); if (!leftOpen && matchMedia("(max-width: 1100px)").matches) setRightOpen(false); }}><Icon name="menu" /></button><span title={currentCwd}>{workspaceName(currentCwd)}</span><button type="button" class="inspect-toggle" ref={toggleRight} aria-expanded={rightOpen} onClick={() => { setRightOpen(!rightOpen); setLeftOpen(false); }}><Icon name="panel" />{rightOpen ? "收起面板" : "文件与改动"}</button></div>
      {children}
    </main>
    <aside class="workspace-inspector" aria-label="文件、改动与资源" ref={rightRef} role={modal === "right" ? "dialog" : undefined} aria-modal={modal === "right" ? true : undefined} inert={modal === "left" || !rightOpen} aria-hidden={modal === "left" || !rightOpen ? true : undefined}>
      <div class="inspector-tabs" role="group" aria-label="工作区面板">{([['changes', '改动'], ['files', '文件'], ['resources', '资源']] as const).map(([name, label]) => <button type="button" aria-pressed={tab === name} key={name} onClick={() => { setTab(name); setSelectedPath(""); setReferenceMode(false); }}>{label}</button>)}<button type="button" class="icon-button" aria-label="关闭工作区面板" onClick={() => { setRightOpen(false); requestAnimationFrame(() => toggleRight.current?.focus()); }}><Icon name="close" /></button></div>
      <div class="inspector-scroll">
        {tab === "changes" && <><div class="panel-heading"><span>{status.value?.branch || "工作区改动"}</span><button type="button" class="icon-button" aria-label="刷新 Git 改动" disabled={!online || status.loading} onClick={() => { status.reload(); diff.reload(); }}><Icon name="refresh" /></button></div><ReadState read={status}>
          {status.value && !status.value.isRepository ? <p class="panel-message">当前工作区没有 Git 仓库。</p> : !status.value?.files.length ? <p class="panel-message">工作区没有未提交的改动。</p> : <div class="changed-files">{status.value.files.map(item => <button type="button" class={`file-item ${selectedPath === item.path ? "is-current" : ""}`} key={item.path} onClick={() => choosePath(item.path, "diff")} title={item.path}><span class={`git-status status-${item.status.trim().slice(-1)}`}>{item.status.trim() || "M"}</span><span>{item.path}</span><small>{item.staged ? "已暂存" : ""}{item.staged && item.unstaged ? " / " : ""}{item.unstaged ? "工作区" : ""}</small></button>)}</div>}
          {status.value?.truncated && <p class="panel-message">改动列表已截断。</p>}
        </ReadState></>}
        {tab === "files" && <><label class="panel-search inspector-search"><Icon name="search" /><input type="search" placeholder="查找工作区文件" aria-label="查找工作区文件" value={fileSearch} onInput={event => setFileSearch(event.currentTarget.value)} /></label>{referenceMode && <p class="reference-note">选择文件并将真实内容引用到消息。</p>}<ReadState read={filesRead}><div class="file-list">{files.value?.files.filter(item => item.type !== "directory").map(item => <button type="button" class={`file-item ${selectedPath === item.path ? "is-current" : ""}`} key={item.path} onClick={() => choosePath(item.path, "file")} title={item.path}><Icon name="file" /><span>{item.path}</span></button>)}</div>{!files.value?.files.some(item => item.type !== "directory") && <p class="panel-message">没有匹配的文件。</p>}{files.value?.truncated && <p class="panel-message">文件列表已截断；可在终端查看其他文件。</p>}</ReadState></>}
        {selectedPath && tab !== "resources" && <section class="file-preview" aria-label="文件预览"><div class="preview-heading"><span title={selectedPath}>{selectedPath}</span><button type="button" class="icon-button" aria-label="关闭文件预览" onClick={() => setSelectedPath("")}><Icon name="close" /></button></div><div class="preview-actions">{tab === "changes" && <button type="button" aria-pressed={previewMode === "diff"} onClick={() => setPreviewMode(previewMode === "diff" ? "file" : "diff")}>{previewMode === "diff" ? "查看文件" : "查看差异"}</button>}{previewMode === "file" && <button type="button" disabled={!file.value || !!file.value.binary} onClick={referenceFile}>引用到消息</button>}</div>{previewMode === "diff" ? <ReadState read={diff}>{diff.value?.text ? <Diff patch={diff.value.text} /> : <p class="panel-message">没有可显示的文本差异。新文件可点“查看文件”。</p>}{diff.value?.truncated && <p class="reference-note">差异过大，只显示前面的片段。</p>}</ReadState> : <ReadState read={file}>{file.value?.binary ? <p class="panel-message">此文件是二进制文件，无法预览文本。</p> : file.value && <FileCode value={file.value} />}{file.value?.truncated && <p class="reference-note">文件过大，只显示预览片段。引用时会标明截断。</p>}</ReadState>}</section>}
        {tab === "resources" && <><div class="panel-heading"><span>资源</span><button type="button" class="icon-button" aria-label="刷新资源" disabled={!online || resources.loading} onClick={resources.reload}><Icon name="refresh" /></button></div><div class="resource-tabs" role="group" aria-label="资源类型">{([['models', '模型'], ['tools', '工具'], ['commands', '命令'], ['capabilities', '能力']] as const).map(([name, label]) => <button type="button" key={name} aria-pressed={resourceTab === name} onClick={() => setResourceTab(name)}>{label}</button>)}</div><ReadState read={resources}>
          {resourceTab === "models" && <><p class="resource-note">当前 RPC 会话可用的模型。选择后用于后续回复。</p>{resources.value?.models.map(model => <button type="button" class={`resource-item model-resource ${state.snapshot?.state.model?.provider === model.provider && state.snapshot?.state.model?.id === model.id ? "is-current" : ""}`} key={`${model.provider}:${model.id}`} disabled={!canConfigure} onClick={() => issueCommand("set_model", { provider: model.provider, id: model.id })}><strong>{model.name || model.id}</strong><span>{model.provider} · {model.id}</span>{state.snapshot?.state.model?.provider === model.provider && state.snapshot?.state.model?.id === model.id && <small>当前模型</small>}</button>)}{!resources.value?.models.length && <div class="panel-message"><p>没有可用模型。先登录一个模型服务商。</p><button type="button" onClick={() => openSettings("accounts")}>打开账户</button></div>}</>}
          {resourceTab === "tools" && <>{resources.value?.tools.map(tool => <div class="resource-item" key={tool.name}><strong>{tool.name}<span class={`resource-status ${tool.active ? "active" : ""}`}>{tool.active ? "已启用" : "未启用"}</span></strong><p>{tool.description}</p>{tool.source && <span>{tool.source}</span>}</div>)}{!resources.value?.tools.length && <p class="panel-message">工具列表与启停需要 pi RPC 上游支持；交接模式暂不提供。</p>}</>}
          {resourceTab === "commands" && <>{(resources.value?.commands || commands).map((command, index) => <button type="button" class="resource-item command-resource" key={`${command.source}:${command.name}:${index}`} disabled={!command.available} title={command.reason} onClick={() => { setDraft(`/${command.name} `); if (overlayInspector) setRightOpen(false); focusComposer(); }}><strong>/{command.name}<span class="source-chip">{sourceLabels[command.source]}</span></strong><p>{command.description}</p>{!command.available && <span>{command.reason || "请在终端使用"}</span>}</button>)}</>}
          {resourceTab === "capabilities" && <>{state.snapshot?.caps.commands.includes("access_rotate") && <div class="resource-item"><strong>访问凭据</strong><p>轮换后，已有链接与其他访客登录会失效。新链接会显示在交接终端。</p>{rotateConfirm ? <div class="rotate-confirm" role="group" aria-label="确认轮换访问凭据"><button type="button" disabled={!online} onClick={() => { issueCommand("access_rotate"); setRotateConfirm(false); }}>确认轮换</button><button type="button" class="quiet" onClick={() => setRotateConfirm(false)}>取消</button></div> : <button type="button" disabled={!online} onClick={() => setRotateConfirm(true)}>轮换凭据</button>}</div>}{resources.value?.capabilities.map(capability => <div class="resource-item" key={capability.name}><strong>{capabilityLabels[capability.name]?.[0] || capability.name}<span class={`resource-status ${capability.available ? "active" : ""}`}>{capability.available ? "可用" : "待接入"}</span></strong><p>{capability.detail || capabilityLabels[capability.name]?.[1]}</p></div>)}</>}
        </ReadState></>}
        {!state.snapshot?.caps.workbench && <p class="panel-message">当前 pi-pane 主机尚未提供工作台能力，请更新扩展并重新加载 pi。</p>}
      </div>
    </aside>
  </div>;
}
