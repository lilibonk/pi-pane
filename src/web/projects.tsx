import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { HostQueryAction, HostQueryValues, ProjectItem, ProjectTrustView } from "../protocol/index.js";
import { HostError, queryHost, runHostCommand, setProjectDialog, type WebState } from "./store.js";

/** What went wrong, in the page's own words. Host messages are the fallback for cases not listed here. */
const PROJECT_ERRORS: Record<string, string> = {
  not_found: "这个路径在运行 pi 的电脑上不存在。",
  not_directory: "这个路径不是文件夹。",
  permission_denied: "pi 没有权限使用这个文件夹。",
  invalid_path: "请填写运行 pi 的电脑上的绝对路径（以 / 开头）。",
  invalid_args: "请填写运行 pi 的电脑上的绝对路径（以 / 开头）。",
  invalid_name: "文件夹名不能为空，不能是 . 或 ..，不能包含 /，且不超过 255 字节。",
  project_root_refused: "这个文件夹存放凭据或 pi 自身的数据，不能从网页打开为项目。确实需要时请在终端进入该目录运行 pi。",
  project_exists: "同名文件夹已存在，没有做任何改动。可以改为打开它。",
  path_exists: "同名文件已存在，没有做任何改动。",
  parent_changed: "上级文件夹在创建过程中发生了变化，请重新选择。",
  busy: "pi 正在回复、有待发消息或有待回答的对话框，结束后再切换项目。",
  stale_host: "页面状态已过期，请按当前内容重新操作。",
  session_locked: "这个项目的上一个会话正在另一个 /web 服务中运行。",
  trust_required: "打开前需要先选择是否信任这个项目。",
  project_current: "这是当前项目。先切到其他项目，再从列表移除。",
  unknown_project: "这个项目已不在列表中。",
  recovery_required: "项目没有启动成功，请按页面上的提示选择下一步。",
};
export function explain(error: unknown): string {
  if (error instanceof HostError) return PROJECT_ERRORS[error.code] ?? error.message;
  return error instanceof Error ? error.message : "操作失败，请重试。";
}

export interface HostQueryState<T> { value?: T; loading: boolean; error: string; reload: () => void }
/** A host read that follows the host's own revision, not the session: it works while no session is running. */
export function useHostQuery<A extends HostQueryAction>(state: WebState, action: A, args: Record<string, unknown> = {}, enabled = true): HostQueryState<HostQueryValues[A]> {
  const [value, setValue] = useState<HostQueryValues[A] | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [revision, refresh] = useState(0);
  const argKey = JSON.stringify(args);
  const ready = enabled && !!state.clientId && state.connection !== "disconnected" && state.connection !== "fatal" && state.connection !== "login" && state.connection !== "connecting";
  useEffect(() => {
    setError("");
    if (!ready) { setLoading(false); return; }
    const abort = new AbortController();
    setLoading(true);
    void queryHost(action, JSON.parse(argKey), abort.signal).then(result => {
      if (!abort.signal.aborted) { setValue(result); setLoading(false); }
    }, failure => {
      if (!abort.signal.aborted) { setValue(undefined); setError(explain(failure)); setLoading(false); }
    });
    return () => abort.abort();
  }, [ready, action, argKey, state.clientId, state.host?.revision, revision]);
  return { value, loading, error, reload: () => refresh(count => count + 1) };
}

/**
 * Opens a directory as the current project. Asks about trust first when pi itself would have to ask;
 * the question is put to the user here because an RPC child has no way to put it.
 */
export async function openProjectPath(path: string): Promise<void> {
  const project = await queryHost("project_inspect", { path });
  if (project.trust.ask) { setProjectDialog({ mode: "trust", project }); return; }
  await runHostCommand("project_open", { path: project.path });
  setProjectDialog(null);
}

function trustLines(trust: ProjectTrustView): { choice: string; loaded?: string; action?: string } | undefined {
  if (!trust.required) return undefined;
  const loaded = trust.loaded === undefined ? "实际加载：未知。" : trust.loaded > 0 ? `实际加载：观察到 ${trust.loaded} 项来自项目的命令。` : "实际加载：没有观察到来自项目的命令（项目可能没有命令，也可能被全局策略拒绝）。";
  if (trust.override === "approve") return { choice: "启动参数 --approve：本次信任这个项目（只对起始项目有效）。", loaded };
  if (trust.override === "no-approve") return { choice: "启动参数 --no-approve：不加载这个项目的配置。" };
  if (trust.withheld) return { choice: "你的选择：本次不加载项目配置。", action: "改为信任…" };
  if (trust.choice === "trusted") return { choice: "你的选择：已信任这个项目。", loaded };
  if (trust.choice === "untrusted") return { choice: "你的选择：不信任，项目配置未加载。" };
  if (trust.policy === "always") return { choice: "按 pi 的全局默认：总是信任。", loaded };
  if (trust.policy === "never") return { choice: "按 pi 的全局默认：从不信任，项目配置未加载。" };
  return { choice: "尚未选择是否信任，项目配置未加载。", action: "选择…" };
}

export function ProjectSection({ state, canSwitch, onSwitched }: { state: WebState; canSwitch: boolean; onSwitched: () => void }) {
  const projects = useHostQuery(state, "projects");
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState("");
  const busy = !!state.hostAction;
  useEffect(() => { setError(""); setConfirming(""); }, [state.host?.revision]);
  const open = (project: ProjectItem) => {
    if (project.current) return;
    setError("");
    openProjectPath(project.path).then(onSwitched, failure => setError(explain(failure)));
  };
  const remove = (project: ProjectItem) => { setError(""); setConfirming(""); runHostCommand("project_remove", { path: project.path }).catch(failure => setError(explain(failure))); };
  const view = projects.value;
  const trust = view && trustLines(view.current.trust);
  return <section class="project-section" aria-label="项目">
    <div class="sidebar-heading"><span>项目</span>
      <button type="button" class="project-action" disabled={!canSwitch || busy} onClick={() => setProjectDialog({ mode: "open" })}>打开</button>
      <button type="button" class="project-action" disabled={!canSwitch || busy} onClick={() => setProjectDialog({ mode: "create" })}>新建</button>
    </div>
    {projects.error && !view && <div class="panel-message panel-error" role="alert"><p>{projects.error}</p><button type="button" onClick={projects.reload}>重新加载</button></div>}
    {!view && projects.loading && <p class="panel-message" role="status">正在加载项目…</p>}
    {view && <ul class="project-list">{view.projects.map(project => <li key={project.path} class={`project-row ${project.current ? "is-current" : ""} ${project.available ? "" : "is-missing"}`}>
      <button type="button" class="project-item" aria-current={project.current ? "true" : undefined} title={project.path} disabled={project.current ? false : !canSwitch || busy || !project.available} onClick={() => open(project)}>
        <span class="project-name">{project.name}</span>
        <span class="project-meta">{!project.available ? "文件夹不可用" : project.current ? "当前项目" : project.sessions ? `${project.sessions} 个会话` : "尚无会话"}</span>
      </button>
      {!project.current && (confirming === project.path
        ? <span class="project-confirm" role="group" aria-label={`确认从列表移除 ${project.name}`}><button type="button" disabled={busy} onClick={() => remove(project)}>移除</button><button type="button" class="quiet" onClick={() => setConfirming("")}>取消</button></span>
        : <span class="project-tools">
          {!project.available && project.source !== "history" && <button type="button" class="quiet" disabled={busy} onClick={() => setProjectDialog({ mode: "relocate", from: project.path })}>重新定位</button>}
          <button type="button" class="quiet" disabled={busy} aria-label={`从列表移除 ${project.name}`} title="只从列表移除，不删除文件夹和会话" onClick={() => setConfirming(project.path)}>移除</button>
        </span>)}
    </li>)}</ul>}
    {confirming && <p class="project-note">只从列表移除，文件夹和会话都会保留。</p>}
    {view?.truncated && <p class="project-note">只显示最近的 200 个项目。</p>}
    {view?.historyIncomplete && <p class="project-note">历史会话没有在限定时间内读完，列表可能不完整。</p>}
    {view?.registryError && <p class="project-note project-warning" role="alert">项目列表文件无法使用，已保持原样未作修改；打开和移除的记录暂时不会保存。<span>{view.registryError}</span></p>}
    {error && <p class="project-note project-warning" role="alert">{error}</p>}
    {trust && <div class="project-trust"><p>{trust.choice}</p>{trust.loaded && <p>{trust.loaded}</p>}
      {trust.action && <button type="button" class="quiet" disabled={!canSwitch || busy} onClick={() => { setError(""); queryHost("project_inspect", { path: view!.current.path }).then(project => setProjectDialog({ mode: "trust", project }), failure => setError(explain(failure))); }}>{trust.action}</button>}</div>}
    {view && <p class="project-note">工具和命令使用启动 /web 的那个终端的环境变量。</p>}
  </section>;
}

/** A modal that owns focus while open and gives it back afterwards. Rendered as a child of the app shell. */
function Modal({ titleId, onClose, wide, children }: { titleId: string; onClose: () => void; wide?: boolean; children: ComponentChildren }) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    const previous = document.activeElement as HTMLElement | null;
    const shell = element.closest(".app-shell");
    const background = [...(shell?.children ?? [])].filter(child => child !== element.parentElement) as HTMLElement[];
    const inertStates = background.map(child => child.inert);
    for (const child of background) child.inert = true;
    const controls = () => [...element.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')].filter(control => control.getClientRects().length);
    (element.querySelector<HTMLElement>("[data-autofocus]") || controls()[0] || element).focus();
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close.current(); return; }
      if (event.key !== "Tab") return;
      const items = controls(), first = items[0], last = items.at(-1);
      if (!first || !last) { event.preventDefault(); element.focus(); return; }
      if (!element.contains(document.activeElement) || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
    };
    document.addEventListener("keydown", keys);
    return () => {
      document.removeEventListener("keydown", keys);
      background.forEach((child, index) => { child.inert = inertStates[index]!; });
      if (previous?.isConnected && !previous.closest("[inert]")) previous.focus();
    };
  }, []);
  return <div class="dialog-backdrop"><div class={`dialog ${wide ? "project-dialog" : ""}`} ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabindex={-1}>{children}</div></div>;
}

function DirectoryPicker({ state, dialog }: { state: WebState; dialog: { mode: "open" | "create" } | { mode: "relocate"; from: string } }) {
  const [path, setPath] = useState<string | undefined>();
  const [input, setInput] = useState("");
  const [name, setName] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [error, setError] = useState("");
  const [existing, setExisting] = useState("");
  const [working, setWorking] = useState(false);
  const listing = useHostQuery(state, "directories", path ? { path } : {});
  const current = listing.value;
  useEffect(() => { if (current) setInput(current.path); }, [current?.path]);
  const go = (target: string) => { setError(""); setExisting(""); setPath(target.trim()); if (target.trim() === path) listing.reload(); };
  const fail = (failure: unknown) => {
    setWorking(false);
    // The recovery page takes over; a dialog on top of it would hide the choices.
    if (failure instanceof HostError && failure.code === "recovery_required") { setProjectDialog(null); return; }
    setError(explain(failure));
  };
  const target = current && !current.refused ? current.path : "";
  const final = target && name ? `${target === "/" ? "" : target}/${name}` : "";
  const busy = working || !!state.hostAction;
  const title = dialog.mode === "open" ? "打开项目" : dialog.mode === "create" ? "新建项目" : "重新定位项目";
  const confirm = () => {
    if (!target || busy) return;
    setError(""); setExisting(""); setWorking(true);
    if (dialog.mode === "open") openProjectPath(target).then(() => setWorking(false), fail);
    else if (dialog.mode === "relocate") runHostCommand("project_relocate", { from: dialog.from, to: target }).then(() => setProjectDialog(null), fail);
    else runHostCommand("project_create", { parent: target, name }).then(() => setProjectDialog(null), failure => { if (failure instanceof HostError && failure.code === "project_exists") setExisting(final); fail(failure); });
  };
  const entries = (current?.entries ?? []).filter(entry => showHidden || !entry.hidden);
  return <Modal titleId="project-dialog-title" wide onClose={() => setProjectDialog(null)}>
    <h2 id="project-dialog-title">{title}</h2>
    <p>{dialog.mode === "relocate" ? `为 ${dialog.from} 选择它现在所在的文件夹。` : dialog.mode === "create" ? "选择上级文件夹，再填写新文件夹的名字。" : "选择一个已有的文件夹。"}这里列出的是运行 pi 的那台电脑上的文件夹，不是这台设备上的文件。</p>
    <form class="path-row" onSubmit={event => { event.preventDefault(); go(input); }}>
      <input type="text" aria-label="文件夹的绝对路径" autocapitalize="off" autocorrect="off" spellcheck={false} maxLength={4096} value={input} onInput={event => setInput(event.currentTarget.value)} placeholder="/path/to/folder" />
      <button type="submit" disabled={!input.trim()}>前往</button>
    </form>
    <div class="path-shortcuts">
      <button type="button" class="quiet" disabled={!current?.parent} onClick={() => current?.parent && go(current.parent)}>上一级</button>
      <button type="button" class="quiet" disabled={!current} onClick={() => current && go(current.home)}>主目录</button>
      <button type="button" class="quiet" disabled={!state.host} onClick={() => state.host && go(state.host.cwd)}>当前项目</button>
      <label><input type="checkbox" checked={showHidden} onChange={event => setShowHidden(event.currentTarget.checked)} />显示隐藏文件夹</label>
    </div>
    <div class="directory-list" aria-label="子文件夹" aria-busy={listing.loading}>
      {listing.error ? <p class="panel-message panel-error" role="alert">{listing.error}</p>
        : !current ? <p class="panel-message" role="status">正在读取文件夹…</p>
        : current.refused ? <p class="panel-message panel-error" role="alert">{PROJECT_ERRORS.project_root_refused}</p>
        : !entries.length ? <p class="panel-message">{current.entries.length ? "只有隐藏的子文件夹。" : "没有子文件夹。"}</p>
        : entries.map(entry => <button type="button" class={`directory-item ${entry.hidden ? "is-hidden" : ""}`} key={entry.name} onClick={() => go(`${current.path === "/" ? "" : current.path}/${entry.name}`)}><span aria-hidden="true">▸</span>{entry.name}</button>)}
      {current?.truncated && <p class="panel-message">子文件夹太多，只显示前 500 个；可以直接填写路径。</p>}
    </div>
    {dialog.mode === "create" && <div class="create-row">
      <label for="project-new-name">新文件夹名</label>
      <input id="project-new-name" type="text" autocapitalize="off" autocorrect="off" spellcheck={false} maxLength={255} value={name} onInput={event => { setName(event.currentTarget.value); setError(""); setExisting(""); }} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); confirm(); } }} />
      <p class="create-preview">{final ? <>将创建：<code>{final}</code></> : current && !current.writable && !current.refused ? "pi 没有权限在这个文件夹里创建内容。" : "填写名字后会显示完整路径。只创建这一个空文件夹。"}</p>
    </div>}
    {error && <p class="error-text" role="alert">{error}</p>}
    {existing && <button type="button" disabled={busy} onClick={() => { setError(""); setWorking(true); openProjectPath(existing).then(() => setWorking(false), fail); }}>打开已有的 {existing}</button>}
    <div class="dialog-actions">
      <button type="button" class="quiet" onClick={() => setProjectDialog(null)}>取消</button>
      <button type="button" class="send-button" disabled={busy || !target || (dialog.mode === "create" && (!name || !current?.writable))} onClick={confirm}>{busy ? "正在处理…" : dialog.mode === "open" ? "打开此文件夹" : dialog.mode === "create" ? "创建并打开" : "使用此文件夹"}</button>
    </div>
  </Modal>;
}

function TrustQuestion({ state, project }: { state: WebState; project: Extract<NonNullable<WebState["projectDialog"]>, { mode: "trust" }>["project"] }) {
  const [error, setError] = useState("");
  const busy = !!state.hostAction;
  const choose = (trust: "remember" | "withhold") => {
    setError("");
    runHostCommand("project_open", { path: project.path, trust }).then(() => setProjectDialog(null), failure => {
      if (failure instanceof HostError && failure.code === "recovery_required") setProjectDialog(null); else setError(explain(failure));
    });
  };
  return <Modal titleId="project-trust-title" onClose={() => setProjectDialog(null)}>
    <h2 id="project-trust-title">是否信任这个项目？</h2>
    <p class="trust-path">{project.path}</p>
    <p>这个文件夹带有 pi 的项目配置。信任后，pi 会加载其中的设置和资源、安装它声明的包，并执行其中的扩展代码。</p>
    <p>这不是沙箱：无论是否信任，pi 的工具都能读写这个文件夹，文件夹里的 AGENTS 说明也仍按 pi 的规则读取。</p>
    <div class="dialog-options">
      <button type="button" disabled={busy} onClick={() => choose("remember")}>信任并记住这个文件夹</button>
      <button type="button" disabled={busy} onClick={() => choose("withhold")}>不加载项目配置，继续<span>只对这一次打开有效，下次打开会再问</span></button>
    </div>
    {error && <p class="error-text" role="alert">{error}</p>}
    <div class="dialog-actions"><button type="button" class="quiet" data-autofocus onClick={() => setProjectDialog(null)}>取消{project.current ? "" : "，留在当前项目"}</button></div>
  </Modal>;
}

/** Rendered beside the workbench, as a child of the app shell, so the whole page behind it is inert. */
export function ProjectDialogs({ state }: { state: WebState }) {
  const dialog = state.projectDialog;
  if (!dialog) return null;
  return dialog.mode === "trust" ? <TrustQuestion key={dialog.project.path} state={state} project={dialog.project} /> : <DirectoryPicker key={dialog.mode} state={state} dialog={dialog} />;
}
