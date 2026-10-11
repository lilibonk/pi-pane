import { useEffect, useRef, useState } from "preact/hooks";
import type { AccountMethod, AccountNotice, AccountOperation, AccountProvider } from "../protocol/index.js";
import { HostError, answerAccount, dismissAccount, runHostCommand, type WebState } from "./store.js";
import { Modal, useHostQuery } from "./projects.js";

const ACCOUNT_ERRORS: Record<string, string> = {
  account_busy: "另一个账户操作还在进行，请先完成或取消它。",
  unknown_provider: "这不是 pi 内置的服务商。扩展提供的服务商需要在终端登录。",
  unsupported_method: "这种登录方式不能在网页完成，请在终端运行 /login。",
  not_owner: "只有发起登录的那个页面可以回答。",
  stale_step: "这一步已经回答过，或已被新的步骤取代。",
  operation_closed: "这次登录已经结束。",
  invalid_answer: "输入无效：不能为空；除密钥外的字段不能以 ! 开头或包含 $。",
  unsafe_key: "这个服务商的密钥无法按字面值保存，已撤销本次保存。请在终端运行 /login。",
  not_stored: "pi 没有为这个服务商保存凭据。由环境变量或启动参数提供的凭据不能在这里移除。",
  timeout: "登录没有在限定时间内完成，已取消。",
  cancelled: "登录已取消，没有保存任何内容。",
  owner_gone: "发起登录的页面已退出登录，登录已取消。",
  busy: "pi 正在回复、有待发消息或有待回答的对话框，结束后再应用。",
  apply_cancelled: "有扩展拒绝了重新加载。凭据已保存，可以稍后再应用。",
  disconnected: "连接已断开，请重新连接后再试。",
  unknown_result: "连接已断开，结果未知。请查看当前状态，不要直接重复操作。",
};
const explain = (error: unknown): string => error instanceof HostError ? ACCOUNT_ERRORS[error.code] ?? error.message : error instanceof Error ? error.message : "操作失败，请重试。";
const safeUrl = (value: string): string | undefined => { try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined; } catch { return undefined; } };
function ExternalLink({ url, label }: { url: string; label?: string }) {
  const href = safeUrl(url);
  return href ? <a href={href} target="_blank" rel="noopener noreferrer">{label || url}</a> : <span>{label ? `${label}：${url}` : url}</span>;
}

function status(provider: AccountProvider, pendingApply: boolean): string {
  const kind = provider.stored === "oauth" ? "订阅登录" : "API key";
  if (provider.stored && pendingApply) return `已保存${kind}，等待应用到当前会话`;
  if (provider.stored && provider.models) return `已保存${kind} · 当前会话可用 ${provider.models} 个模型`;
  if (provider.stored) return `已保存${kind}，但当前会话没有它的可用模型`;
  if (provider.models) return `未保存凭据 · 当前会话可用 ${provider.models} 个模型（来自环境变量、启动参数或扩展）`;
  return "未配置";
}
const methodReason: Record<NonNullable<AccountMethod["reason"]>, string> = {
  ambient: "由本机环境配置（如命令行工具的登录状态），在终端设置。",
  callback: "需要本机回调，尚未在网页开放，请在终端运行 /login。",
  unverified: "网页登录尚未用真实账户验证，暂不开放，请在终端运行 /login。",
  extension: "由扩展或 models.json 提供，在终端配置。",
};

/** pi's built-in providers and what is stored for each. Accounts belong to pi on this machine, not to a project. */
export function AccountsPanel({ state, canConfigure }: { state: WebState; canConfigure: boolean }) {
  const accounts = useHostQuery(state, "accounts");
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState("");
  const [showAll, setShowAll] = useState(false);
  const view = accounts.value;
  const operation = state.account;
  const running = operation?.status === "running";
  const busy = !!state.hostAction;
  const run = (command: "account_begin" | "account_logout" | "account_apply" | "account_cancel", args: Record<string, unknown>) => {
    setError(""); setConfirming("");
    runHostCommand(command, args).then(() => accounts.reload(), failure => { setError(explain(failure)); accounts.reload(); });
  };
  const needle = filter.trim().toLowerCase();
  const matches = (provider: AccountProvider) => !needle || provider.name.toLowerCase().includes(needle) || provider.id.toLowerCase().includes(needle);
  const configured = (view?.providers ?? []).filter(provider => (provider.stored || provider.models) && matches(provider));
  const others = (view?.providers ?? []).filter(provider => !provider.stored && !provider.models && matches(provider));
  const row = (provider: AccountProvider) => <div class="resource-item account-item" key={provider.id}>
    <strong>{provider.name}<span class={`resource-status ${provider.stored || provider.models ? "active" : ""}`}>{provider.stored ? "已保存" : provider.models ? "可用" : "未配置"}</span></strong>
    <p>{status(provider, !!view?.pendingApply)}</p>
    <div class="account-actions">
      {provider.methods.map(method => method.web
        ? <button type="button" key={method.type} disabled={!canConfigure || busy || running} title={method.label} onClick={() => run("account_begin", { provider: provider.id, method: method.type })}>{method.type === "api_key" ? provider.stored === "api_key" ? "替换 API key" : "用 API key 登录" : `登录：${method.label}`}</button>
        : <span class="account-reason" key={method.type}>{method.label ? `${method.label}：` : ""}{methodReason[method.reason ?? "extension"]}</span>)}
      {provider.stored && (confirming === provider.id
        ? <span class="rotate-confirm" role="group" aria-label={`确认退出 ${provider.name}`}><button type="button" disabled={busy || running} onClick={() => run("account_logout", { provider: provider.id })}>确认退出</button><button type="button" class="quiet" onClick={() => setConfirming("")}>取消</button></span>
        : <button type="button" class="quiet" disabled={!canConfigure || busy || running} onClick={() => setConfirming(provider.id)}>退出</button>)}
    </div>
    {confirming === provider.id && <p class="account-reason">只删除 pi 保存的这份凭据。不会撤销服务商一侧的授权，也不影响环境变量或启动参数里的密钥。</p>}
  </div>;
  return <>
    <p class="resource-note">账户属于这台电脑上的 pi，对所有项目生效。这里显示的是 pi 保存了什么、当前会话能用什么；保存成功不代表服务商已经验证过这份凭据。</p>
    {operation && !operation.owner && running && <div class="account-banner" role="status"><span>另一个页面正在登录 {operation.providerName}。</span><button type="button" disabled={busy} onClick={() => run("account_cancel", { operationId: operation.id })}>取消该登录</button></div>}
    {operation?.owner && operation.id === state.accountDismissed && running && <div class="account-banner" role="status"><span>{operation.providerName} 的登录还在进行。</span><button type="button" onClick={() => dismissAccount("")}>查看</button></div>}
    {view?.pendingApply && <div class="account-banner" role="status"><span>凭据已变更，当前会话还没有重新加载。{view.applyError ? ` ${ACCOUNT_ERRORS.busy}` : ""}</span><button type="button" disabled={!canConfigure || busy} onClick={() => run("account_apply", {})}>立即应用</button></div>}
    {view?.storeError && <p class="panel-message panel-error" role="alert">pi 的凭据文件无法读取，未做任何修改。{view.storeError}</p>}
    {error && <p class="panel-message panel-error" role="alert">{error}</p>}
    {accounts.error && !view && <div class="panel-message panel-error" role="alert"><p>{accounts.error}</p><button type="button" onClick={accounts.reload}>重新加载</button></div>}
    {!view && accounts.loading && <p class="panel-message" role="status">正在读取账户…</p>}
    {view && <>
      <label class="panel-search inspector-search"><input type="search" placeholder="查找服务商" aria-label="查找服务商" value={filter} onInput={event => setFilter(event.currentTarget.value)} /></label>
      {configured.map(row)}
      {!configured.length && !needle && <p class="panel-message">还没有可用的模型服务商。在下面选择一个登录。</p>}
      {!!others.length && (needle || showAll ? others.map(row) : <button type="button" class="account-more" onClick={() => setShowAll(true)}>显示其余 {others.length} 个未配置的服务商</button>)}
      {needle && !configured.length && !others.length && <p class="panel-message">没有匹配的服务商。</p>}
      <p class="resource-note">这里的变更只应用到这个网页服务正在运行的会话；同一台电脑上其他已打开的 pi 需要各自重新加载。</p>
    </>}
  </>;
}

function Notice({ notice }: { notice: AccountNotice }) {
  const [copied, setCopied] = useState(false);
  if (notice.type === "device_code") return <div class="account-device">
    <p>在任意设备上打开下面的地址，输入这个代码完成授权：</p>
    <p class="account-code" aria-label="授权代码">{notice.userCode}<button type="button" class="quiet" onClick={() => { void navigator.clipboard?.writeText(notice.userCode).then(() => setCopied(true), () => undefined); }}>{copied ? "已复制" : "复制"}</button></p>
    <p><ExternalLink url={notice.verificationUri} /></p>
    <p class="account-hint">可以离开或关闭这个页面去授权，登录会在电脑上继续等待{notice.expiresAt ? `，到 ${new Date(notice.expiresAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 为止` : ""}。</p>
  </div>;
  if (notice.type === "auth_url") return <div class="account-device"><p>{notice.instructions || "打开下面的地址完成授权："}</p><p><ExternalLink url={notice.url} label="打开授权页面" /></p></div>;
  if (notice.type === "info") return <div class="account-device"><p>{notice.message}</p>{notice.links?.map(link => <p key={link.url}><ExternalLink url={link.url} label={link.label} /></p>)}</div>;
  return <p class="account-hint" role="status">{notice.message}</p>;
}

/** The login steps, shown only on the page that started the login. Nothing typed here is kept after it is sent. */
function LoginDialog({ state, operation }: { state: WebState; operation: AccountOperation }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const step = operation.step;
  const online = state.connection !== "disconnected" && state.connection !== "fatal" && state.connection !== "login";
  useEffect(() => { setValue(""); setError(""); input.current?.focus(); }, [step?.id]);
  const submit = (answer: string) => {
    if (!step || !online) return;
    if (!answerAccount(operation.id, step.id, answer)) { setError(ACCOUNT_ERRORS.disconnected!); return; }
    setValue(""); // the field does not hold a submitted secret
  };
  const cancel = () => { runHostCommand("account_cancel", { operationId: operation.id }).catch(failure => { if (!(failure instanceof HostError && failure.code === "operation_closed")) setError(explain(failure)); }); };
  const close = () => dismissAccount(operation.id);
  const running = operation.status === "running";
  const answerError = state.accountError ? ACCOUNT_ERRORS[state.accountError] ?? "这一步没有被接受，请重试。" : "";
  return <Modal titleId="account-dialog-title" onClose={close}>
    <h2 id="account-dialog-title">{running ? `登录 ${operation.providerName}` : operation.status === "saved" ? `${operation.providerName} 的凭据已保存` : `${operation.providerName} 登录未完成`}</h2>
    {running && operation.notices?.map(notice => <Notice key={notice.type} notice={notice} />)}
    {running && step && (step.kind === "select"
      ? <><p>{step.message}</p><div class="dialog-options">{step.options?.map(option => <button type="button" key={option.id} disabled={!online} onClick={() => submit(option.id)}>{option.label}{option.description && <span>{option.description}</span>}</button>)}</div></>
      : <form class="account-step" onSubmit={event => { event.preventDefault(); if (value) submit(value); }}>
        <label for="account-step-input">{step.message}</label>
        <input id="account-step-input" ref={input} data-autofocus type={step.kind === "secret" ? "password" : "text"} autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck={false} maxLength={8192} placeholder={step.placeholder} value={value} onInput={event => setValue(event.currentTarget.value)} />
        {step.kind === "secret" && <p class="account-hint">按字面值保存到 pi 的凭据文件，只发送一次，不会出现在聊天、草稿或记录里。</p>}
        <button type="submit" class="send-button" disabled={!value || !online}>提交</button>
      </form>)}
    {running && !step && !operation.notices?.length && <p class="account-hint" role="status">正在等待 pi 的下一步…</p>}
    {operation.status === "saved" && <><p>凭据已写入 pi 的凭据文件。这只说明保存成功；服务商是否接受它，要到实际发送消息时才知道。</p><p>pi 空闲时会立即应用到当前会话，否则请在“账户”里点“立即应用”。</p></>}
    {!running && operation.error && <p>{ACCOUNT_ERRORS[operation.error.code] ?? "登录失败。"}</p>}
    {!running && operation.error?.code === "login_failed" && <p class="recovery-detail">{operation.error.message}</p>}
    {(error || answerError) && <p class="error-text" role="alert">{error || answerError}</p>}
    {!online && <p class="account-hint" role="status">连接已断开。登录仍在电脑上进行，重新连接后可以继续。</p>}
    <div class="dialog-actions">
      {running ? <><button type="button" class="quiet" onClick={close}>先收起</button><button type="button" disabled={!online || !!state.hostAction} onClick={cancel}>取消登录</button></>
        : <button type="button" class="send-button" data-autofocus onClick={close}>关闭</button>}
    </div>
  </Modal>;
}
export function AccountDialogs({ state }: { state: WebState }) {
  const operation = state.account;
  if (!operation?.owner || operation.id === state.accountDismissed) return null;
  return <LoginDialog key={operation.id} state={state} operation={operation} />;
}
