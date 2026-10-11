import { useEffect, useRef, useState } from "preact/hooks";
import type { ExportPage, SessionDeleteResult, SessionExportResult, SessionInspectView, SessionStatsView } from "../protocol/index.js";
import { Modal } from "./projects.js";
import { HostError, copyReply, copyText, queryHost, queryWorkbench, runHostCommand, sessionDeleted, setSessionDialog, type WebState } from "./store.js";

const ERRORS: Record<string, string> = {
  unknown_session: "这个会话不在最近的列表里，请刷新会话列表后再试。",
  session_missing: "这个会话文件已经不存在。",
  session_refused: "这个文件不是会话目录里的会话，或者已经被换成了别的内容，没有删除。",
  session_current: "正在打开的会话不能删除，请先切换到其他会话。",
  session_locked: "另一个网页服务正在使用这个会话，不能删除。",
  delete_failed: "会话文件没能删除。",
  session_unsaved: "这个会话还没有保存任何内容，发送一条消息后才能导出。",
  export_failed: "导出失败：pi 没有把文件写到指定位置。",
  export_missing: "这份导出已经不能下载，请重新导出。",
  export_too_large: "这份导出太大，不能在这里下载；文件在运行 pi 的电脑上。",
  busy: "有其他操作正在进行，请稍后再试。",
  host_stopped: "服务已停止。",
  disconnected: "连接已断开，请重新连接后再试。",
  unknown_result: "连接已断开，结果未知。请刷新会话列表查看，不要直接重复操作。",
};
const explain = (error: unknown): string => error instanceof HostError ? ERRORS[error.code] ?? error.message : error instanceof Error ? error.message : "操作失败，请重试。";
const count = (value: number): string => value.toLocaleString("zh-CN");
const size = (bytes: number): string => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

/** pi's numbers for the current session. Kept while a newer read is on its way, read again when a turn ends. */
export function useSessionStats(state: WebState, enabled = true): { stats?: SessionStatsView; error: string; reload: () => void } {
  const [stats, setStats] = useState<SessionStatsView | undefined>();
  const [error, setError] = useState("");
  const [revision, refresh] = useState(0);
  const snapshot = state.snapshot;
  const ready = enabled && state.connection === "online" && !!snapshot?.caps.workbench;
  const settled = snapshot?.state.idle && !snapshot.state.running;
  useEffect(() => { setStats(undefined); }, [snapshot?.epoch]);
  useEffect(() => {
    if (!ready || !settled) return;
    const abort = new AbortController();
    void queryWorkbench("session_stats", {}, abort.signal).then(value => { if (!abort.signal.aborted) { setStats(value); setError(""); } },
      failure => { if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : "读取失败。"); });
    return () => abort.abort();
  }, [ready, settled, snapshot?.epoch, snapshot?.session.branchRevision, snapshot?.state.model?.provider, snapshot?.state.model?.id, revision]);
  return { ...(stats ? { stats } : {}), error, reload: () => refresh(value => value + 1) };
}
/** How full the model's context is, next to the composer. Says nothing when pi cannot tell. */
export function ContextMeter({ state }: { state: WebState }) {
  const { stats } = useSessionStats(state);
  const context = stats?.context;
  if (!context) return null;
  const percent = context.percent === null ? null : Math.max(0, Math.min(100, context.percent));
  const label = percent === null ? `上下文占用未知，上限 ${count(context.window)}` : `上下文已用 ${percent.toFixed(percent < 10 ? 1 : 0)}%（${count(context.tokens ?? 0)} / ${count(context.window)}）`;
  return <button type="button" class={`context-meter ${percent !== null && percent >= 80 ? "is-high" : ""}`} title={`${label}。点击查看会话信息。`} aria-label={label} onClick={() => setSessionDialog({ mode: "info" })}>
    <span class="context-bar" aria-hidden="true"><span style={{ width: `${percent ?? 0}%` }} /></span>
    <span>{percent === null ? "上下文 —" : `上下文 ${percent.toFixed(percent < 10 ? 1 : 0)}%`}</span>
  </button>;
}

function DeleteDialog({ state, sessionId }: { state: WebState; sessionId: string }) {
  const [view, setView] = useState<SessionInspectView | undefined>();
  const [failure, setFailure] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState<SessionDeleteResult | undefined>();
  useEffect(() => {
    const abort = new AbortController();
    void queryHost("session_inspect", { sessionId }, abort.signal).then(value => { if (!abort.signal.aborted) setView(value); }, problem => { if (!abort.signal.aborted) setFailure(explain(problem)); });
    return () => abort.abort();
  }, [sessionId]);
  const close = () => setSessionDialog(null);
  const blocked = !view || view.current || view.locked || !!state.hostAction;
  const remove = () => {
    setError("");
    runHostCommand<SessionDeleteResult>("session_delete", { sessionId }).then(result => { setDone(result); sessionDeleted(); }, failure => setError(explain(failure)));
  };
  if (done) return <Modal titleId="session-dialog-title" onClose={close}>
    <h2 id="session-dialog-title">{done.method === "trash" ? "会话已移入废纸篓" : "会话已永久删除"}</h2>
    <p>{done.method === "trash" ? "可以在这台电脑的废纸篓里找回它。" : "这台电脑没有可用的废纸篓命令，文件已被直接删除，无法恢复。"}</p>
    <div class="dialog-actions"><button type="button" class="send-button" data-autofocus onClick={close}>关闭</button></div>
  </Modal>;
  return <Modal titleId="session-dialog-title" onClose={close}>
    <h2 id="session-dialog-title">删除这个会话？</h2>
    {!view && !failure && <p role="status">正在读取会话…</p>}
    {!view && failure && <p class="error-text" role="alert">{failure}</p>}
    {view && <>
      <dl class="session-facts">
        <div><dt>名称</dt><dd>{view.name || "未命名会话"}</dd></div>
        <div><dt>项目</dt><dd>{view.cwd || "未知"}</dd></div>
        <div><dt>文件</dt><dd>{view.path}</dd></div>
        <div><dt>内容</dt><dd>{view.messageCount} 条消息{view.modified ? ` · 最后修改 ${new Date(view.modified).toLocaleString("zh-CN")}` : ""}</dd></div>
      </dl>
      {view.current ? <p class="error-text">这是正在打开的会话，不能删除。请先切换到其他会话。</p>
        : view.locked ? <p class="error-text">另一个网页服务正在使用这个会话，不能删除。</p>
        : <><p>{view.trash ? "文件会被移入这台电脑的废纸篓，可以从那里找回。" : "这台电脑没有可用的废纸篓命令，文件会被永久删除，无法恢复。"}</p>
          <p>如果有终端里的 pi 正打开着这个会话，这里无法得知；删除后它会失去这个文件。</p></>}
    </>}
    {error && <p class="error-text" role="alert">{error}</p>}
    <div class="dialog-actions"><button type="button" class="quiet" data-autofocus onClick={close}>取消</button><button type="button" disabled={blocked} onClick={remove}>{view && !view.trash ? "永久删除" : "移入废纸篓"}</button></div>
  </Modal>;
}

/** Reads an export from the host in parts and hands it to the browser as a file. Nothing is kept after the save starts. */
async function download(result: SessionExportResult, progress: (fraction: number) => void, signal: AbortSignal): Promise<void> {
  const parts: Uint8Array[] = [];
  for (let offset: number | undefined = 0; offset !== undefined;) {
    const page: ExportPage = await queryHost("export_page", { exportId: result.exportId, offset }, signal);
    const binary = atob(page.data), bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    parts.push(bytes); progress(page.total ? Math.min(1, ((page.next ?? page.total)) / page.total) : 1);
    offset = page.next;
  }
  const url = URL.createObjectURL(new Blob(parts as BlobPart[], { type: "text/html" }));
  const link = document.createElement("a");
  link.href = url; link.download = result.name; link.rel = "noopener";
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
function ExportDialog({ state }: { state: WebState }) {
  const [result, setResult] = useState<SessionExportResult | undefined>();
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<number | undefined>();
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const abort = useRef<AbortController>();
  useEffect(() => () => abort.current?.abort(), []);
  const close = () => setSessionDialog(null);
  const run = () => { setError(""); runHostCommand<SessionExportResult>("session_export").then(setResult, failure => setError(explain(failure))); };
  const save = () => {
    if (!result) return;
    setError(""); setSaved(false); setProgress(0);
    abort.current = new AbortController();
    download(result, setProgress, abort.current.signal).then(() => { setSaved(true); setProgress(undefined); }, failure => { setProgress(undefined); setError(explain(failure)); });
  };
  return <Modal titleId="session-dialog-title" onClose={close}>
    <h2 id="session-dialog-title">导出会话</h2>
    {!result ? <>
      <p>把当前会话导出为一个 HTML 文件，由 pi 写到运行它的电脑上，位置在 pi-pane 的导出目录里，不会写进项目目录。</p>
      <p>导出的文件包含整段对话，其中可能有文件内容、命令输出和密钥。分享前请先检查。</p>
      <p class="account-hint">只保留最近 20 份导出；本期只支持 HTML。</p>
    </> : <>
      <p>已导出（{size(result.bytes)}）。文件在运行 pi 的电脑上：</p>
      <p class="trust-path">{result.path}</p>
      <div class="dialog-actions dialog-actions-start">
        {result.downloadable ? <button type="button" disabled={progress !== undefined} onClick={save}>{progress !== undefined ? `正在下载 ${Math.round(progress * 100)}%` : "下载到此设备"}</button>
          : <span class="account-hint">文件超过 32 MiB，不能在这里下载，请在那台电脑上打开。</span>}
        <button type="button" class="quiet" onClick={() => { void copyText(result.path).then(setCopied); }}>{copied ? "已复制路径" : "复制路径"}</button>
      </div>
      {saved && <p class="account-hint" role="status">已交给浏览器保存。</p>}
    </>}
    {error && <p class="error-text" role="alert">{error}</p>}
    <div class="dialog-actions">
      {!result ? <><button type="button" class="quiet" onClick={close}>取消</button><button type="button" class="send-button" data-autofocus disabled={!!state.hostAction || state.connection !== "online"} onClick={run}>{state.hostAction ? "正在导出…" : "导出"}</button></>
        : <button type="button" class="send-button" data-autofocus onClick={close}>关闭</button>}
    </div>
  </Modal>;
}

function InfoDialog({ state }: { state: WebState }) {
  const { stats, error, reload } = useSessionStats(state);
  const close = () => setSessionDialog(null);
  const context = stats?.context;
  return <Modal titleId="session-dialog-title" onClose={close}>
    <h2 id="session-dialog-title">会话信息</h2>
    {!stats && !error && <p role="status">{state.snapshot?.state.idle ? "正在读取…" : "pi 正在工作，结束后显示最新数字。"}</p>}
    {error && !stats && <p class="error-text" role="alert">{error}</p>}
    {stats && <dl class="session-facts">
      <div><dt>名称</dt><dd>{stats.name || "未命名会话"}</dd></div>
      <div><dt>项目</dt><dd>{stats.cwd}</dd></div>
      <div><dt>文件</dt><dd>{stats.sessionFile || "尚未保存"}</dd></div>
      <div><dt>会话 ID</dt><dd>{stats.sessionId}</dd></div>
      <div><dt>消息</dt><dd>共 {count(stats.totalMessages)} 条：你 {count(stats.userMessages)}，pi {count(stats.assistantMessages)}，工具调用 {count(stats.toolCalls)}，工具结果 {count(stats.toolResults)}</dd></div>
      <div><dt>Token</dt><dd>共 {count(stats.tokens.total)}：输入 {count(stats.tokens.input)}，输出 {count(stats.tokens.output)}，缓存读取 {count(stats.tokens.cacheRead)}，缓存写入 {count(stats.tokens.cacheWrite)}</dd></div>
      <div><dt>费用</dt><dd>{stats.cost ? `$${stats.cost.toFixed(4)}（按 pi 的模型价格表估算）` : "0（模型没有价格信息时也显示为 0）"}</dd></div>
      <div><dt>上下文</dt><dd>{!context ? "pi 目前无法给出" : context.percent === null ? `占用未知，上限 ${count(context.window)}` : `${context.percent.toFixed(1)}%（${count(context.tokens ?? 0)} / ${count(context.window)}）`}</dd></div>
    </dl>}
    <p class="account-hint">数字来自 pi 自己的统计，在每轮回复结束后更新。</p>
    <div class="dialog-actions">
      <button type="button" class="quiet" onClick={reload}>刷新</button>
      <button type="button" class="quiet" disabled={state.connection !== "online"} onClick={() => { void copyReply(); }}>复制最后一条回复</button>
      <button type="button" class="quiet" disabled={state.connection !== "online"} onClick={() => setSessionDialog({ mode: "export" })}>导出…</button>
      <button type="button" class="send-button" data-autofocus onClick={close}>关闭</button>
    </div>
  </Modal>;
}

/** The clipboard refused: the text is here to be selected and copied by hand. */
function TextDialog({ text }: { text: string }) {
  const area = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState(false);
  const close = () => setSessionDialog(null);
  useEffect(() => { area.current?.select(); }, []);
  return <Modal titleId="session-dialog-title" onClose={close} wide>
    <h2 id="session-dialog-title">手动复制</h2>
    <p>浏览器没有允许写入剪贴板，内容没有被复制。请在下面选中后自行复制。</p>
    <textarea ref={area} class="copy-text" readOnly rows={12} value={text} aria-label="回复内容" />
    <div class="dialog-actions">
      <button type="button" class="quiet" onClick={() => { void copyText(text).then(setCopied); }}>{copied ? "已复制" : "再试一次"}</button>
      <button type="button" class="send-button" data-autofocus onClick={close}>关闭</button>
    </div>
  </Modal>;
}
export function SessionDialogs({ state }: { state: WebState }) {
  const dialog = state.sessionDialog;
  if (!dialog) return null;
  if (dialog.mode === "delete") return <DeleteDialog key={dialog.sessionId} state={state} sessionId={dialog.sessionId} />;
  if (dialog.mode === "export") return <ExportDialog state={state} />;
  if (dialog.mode === "text") return <TextDialog text={dialog.text} />;
  return <InfoDialog state={state} />;
}
