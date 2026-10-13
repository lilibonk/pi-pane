import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { CUSTOM_PROVIDER_APIS, ProtocolError, insecureAddress, validateProvider, type CustomProvider, type CustomProviderResult, type CustomProvidersView } from "../protocol/index.js";
import { useHostQuery } from "./projects.js";
import { HostError, runHostCommand, type WebState } from "./store.js";
import { explainApplyError } from "./apply-error.js";

const API: Record<string, string> = {
  "openai-completions": "OpenAI 兼容（Chat Completions）", "openai-responses": "OpenAI 兼容（Responses）",
  "anthropic-messages": "Anthropic 兼容（Messages）", "google-generative-ai": "Google 兼容（Generative AI）",
};
const ERRORS: Record<string, string> = {
  stale_providers: "models.json 刚被其他页面、另一个 pi 或编辑器改过。列表已重新读取，请核对后再改。",
  providers_unreadable: "pi 的 models.json 无法解析，文件没有被改动。请先在编辑器里修复它。",
  provider_name_taken: "这个名称属于 pi 内置的服务商，或是扩展提供的服务商。用它会改写那个服务商而不是新增，请换一个名称。",
  provider_exists: "已经有一个同名的供应商。",
  provider_overlay: "这一条改写的是 pi 内置的服务商，只能在 models.json 里直接编辑。",
  provider_missing: "这个供应商已经不在 models.json 里了。",
  provider_limit: "models.json 里的供应商数量已到上限。",
  save_failed: "models.json 没能写入，没有保存。",
  save_unconfirmed: "models.json 里没有看到这次修改，可能同时被其他程序改动，请查看后重试。",
  account_busy: "有一个登录正在进行，请先完成或取消它。",
  account_dialog: "请先完成或关闭当前的登录对话框。",
  busy: "pi 正在回复、有待发消息或有待回答的对话框，结束后再应用。",
  apply_cancelled: "有扩展拒绝了重新加载。更改已保存，可以稍后再应用。",
  host_stopped: "服务正在停止。", disconnected: "连接已断开，请重新连接后再试。",
  unknown_result: "连接已断开，结果未知。请查看当前列表，不要直接重复操作。",
};
/** What is wrong with a field, in the form's own words. The host's English message is the fallback. */
function fieldText(field: string): string {
  const row = /^models\.(\d+)\.(id|name|contextWindow)$/.exec(field);
  if (row) return `第 ${Number(row[1]) + 1} 个模型：${row[2] === "id" ? "需要一个不重复的模型 ID（最多 200 个字符）。" : row[2] === "name" ? "显示名最多 200 个字符。" : "上下文长度必须是大于 0 的整数。"}`;
  if (field === "id") return "名称需以字母或数字开头，只能包含字母、数字、点、连字符和下划线，最多 64 个字符。";
  if (field === "api") return "请选择一种列出的 API 协议。";
  if (field === "baseUrl") return "请填写完整的地址，以 http:// 或 https:// 开头，不要在地址里写用户名或密码。";
  if (field === "models") return "至少需要一个模型，最多 64 个。";
  return "";
}
function explain(error: unknown): { message: string; field?: string } {
  if (error instanceof HostError || error instanceof ProtocolError) {
    const field = error.field;
    return { message: ERRORS[error.code] || (error.code === "invalid_provider" && field ? fieldText(field) : "") || error.message, ...(field ? { field } : {}) };
  }
  return { message: error instanceof Error ? error.message : "操作失败，请重试。" };
}
const KEY: Record<CustomProvider["key"], string> = {
  none: "未设置密钥，模型暂时不可用", stored: "密钥已保存在 pi 的凭据文件里",
  file_literal: "密钥写在 models.json 里（明文）", file_env: "密钥来自环境变量（models.json 里的引用）", file_command: "密钥由 models.json 里的命令提供",
};
interface Row { id: string; name: string; contextWindow: string }
interface Draft { create: boolean; id: string; api: string; baseUrl: string; rows: Row[] }
const blank = (): Draft => ({ create: true, id: "", api: CUSTOM_PROVIDER_APIS[0], baseUrl: "", rows: [{ id: "", name: "", contextWindow: "" }] });
const edit = (provider: CustomProvider): Draft => ({ create: false, id: provider.id, api: provider.api, baseUrl: provider.baseUrl,
  rows: provider.models.map(model => ({ id: model.id, name: model.name ?? "", contextWindow: model.contextWindow === undefined ? "" : String(model.contextWindow) })) });

function ProviderForm({ draft, revision, existing, busy, onDone, onCancel }: { draft: Draft; revision: string; existing?: CustomProvider; busy: boolean; onDone: (result: CustomProviderResult) => void; onCancel: () => void }) {
  const [form, setForm] = useState(draft);
  const [problem, setProblem] = useState<{ message: string; field?: string }>();
  const element = useRef<HTMLFormElement>(null);
  const set = (patch: Partial<Draft>) => { setForm(current => ({ ...current, ...patch })); setProblem(undefined); };
  const row = (index: number, patch: Partial<Row>) => set({ rows: form.rows.map((item, position) => position === index ? { ...item, ...patch } : item) });
  const invalid = (field: string): boolean => problem?.field === field;
  const errorId = (field: string): string => `provider-${field.replace(/\./g, "-")}-error`;
  const describedBy = (field: string, note?: string): string | undefined => [note, invalid(field) ? errorId(field) : undefined].filter(Boolean).join(" ") || undefined;
  const fieldError = (field: string) => invalid(field) && <p id={errorId(field)} class="setting-note setting-warn" role="alert" tabindex={-1} data-provider-error>{problem!.message}</p>;
  const modelField = problem?.field && /^models\.(\d+)\.(id|name|contextWindow)$/.exec(problem.field);
  const fieldProblem = !!problem?.field && (["id", "api", "baseUrl", "models"].includes(problem.field) || !!modelField && Number(modelField[1]) < form.rows.length);
  useLayoutEffect(() => {
    if (!problem || !element.current) return;
    const error = element.current.querySelector<HTMLElement>("[data-provider-error]");
    const control = [...element.current.querySelectorAll<HTMLElement>("[data-provider-field]")].find(item => item.dataset.providerField === problem.field);
    const target = control && !control.matches(":disabled") ? control : error;
    target?.focus({ preventScroll: true });
    // Scroll to the message as well as its control, including a model-list error with no row to focus.
    error?.scrollIntoView({ block: "center" });
  }, [problem]);
  const submit = (event: Event) => {
    event.preventDefault();
    const models = form.rows.map(item => ({ id: item.id, ...(item.name.trim() ? { name: item.name } : {}), ...(item.contextWindow.trim() ? { contextWindow: Number(item.contextWindow) } : {}) }));
    let valid;
    // Checked here first so the field can be pointed at; the host checks again and decides.
    try { valid = validateProvider({ id: form.id, api: form.api, baseUrl: form.baseUrl, models }, existing); } catch (error) { setProblem(explain(error)); return; }
    runHostCommand<CustomProviderResult>("provider_save", { id: valid.id, api: valid.api, baseUrl: valid.baseUrl, models: valid.models, revision, create: form.create }).then(onDone, failure => setProblem(explain(failure)));
  };
  const apis = (CUSTOM_PROVIDER_APIS as readonly string[]).includes(form.api) ? [...CUSTOM_PROVIDER_APIS] : [form.api, ...CUSTOM_PROVIDER_APIS];
  return <form class="provider-form" ref={element} onSubmit={submit} noValidate>
    <div class="provider-form-head"><h3>{form.create ? "添加供应商" : `编辑 ${form.id}`}</h3><button type="button" class="quiet" onClick={onCancel}>返回列表</button></div>
    <fieldset class="provider-form-section">
      <legend>连接信息</legend>
      <div class="provider-field"><label for="provider-id">名称</label>
        <input id="provider-id" data-provider-field="id" data-autofocus type="text" value={form.id} disabled={!form.create} maxLength={64} autocomplete="off" autocapitalize="off" spellcheck={false} aria-invalid={invalid("id")} aria-describedby={describedBy("id", "provider-id-note")} placeholder="例如 my-gateway" onInput={event => set({ id: event.currentTarget.value })} />
        {fieldError("id")}
        <p id="provider-id-note" class="setting-note">会成为模型名的前缀（名称/模型 ID），保存后不能修改。</p>
      </div>
      <div class="provider-field"><label for="provider-api">API 协议</label>
        <select id="provider-api" data-provider-field="api" value={form.api} aria-invalid={invalid("api")} aria-describedby={describedBy("api")} onChange={event => set({ api: event.currentTarget.value })}>{apis.map(api => <option value={api} key={api}>{API[api] ?? `${api}（表单不提供的协议，保持不变）`}</option>)}</select>
        {fieldError("api")}
      </div>
      <div class="provider-field"><label for="provider-url">Base URL</label>
        <input id="provider-url" data-provider-field="baseUrl" type="url" inputMode="url" value={form.baseUrl} maxLength={2048} autocomplete="off" autocapitalize="off" spellcheck={false} aria-invalid={invalid("baseUrl")} aria-describedby={describedBy("baseUrl", "provider-url-note")} placeholder="https://example.com/v1" onInput={event => set({ baseUrl: event.currentTarget.value })} />
        {fieldError("baseUrl")}
        {insecureAddress(form.baseUrl) && <p class="setting-note setting-warn">这是发往其他机器的明文 http 地址：请求内容和密钥在网络上不加密。可以保存，请确认这是你想要的。</p>}
        <p id="provider-url-note" class="setting-note">保存时不会连接这个地址去验证；是否可用要到实际发送消息时才知道。</p>
      </div>
    </fieldset>
    <fieldset class="provider-models" aria-invalid={invalid("models")} aria-describedby={describedBy("models")}>
      <legend>模型列表</legend>
      {fieldError("models")}
      {form.rows.map((item, index) => <div class="provider-model-entry" key={index}>
        <div class="provider-model-heading"><strong>模型 {index + 1}</strong><button type="button" class="quiet" aria-label={`移除第 ${index + 1} 个模型`} disabled={form.rows.length <= 1} onClick={() => set({ rows: form.rows.filter((_, position) => position !== index) })}>移除</button></div>
        <div class="provider-model">
          <label class="provider-field"><span>模型 ID</span><input type="text" data-provider-field={`models.${index}.id`} aria-label={`第 ${index + 1} 个模型的 ID`} placeholder="模型 ID（必填）" value={item.id} maxLength={200} autocomplete="off" autocapitalize="off" spellcheck={false} aria-invalid={invalid(`models.${index}.id`)} aria-describedby={describedBy(`models.${index}.id`)} onInput={event => row(index, { id: event.currentTarget.value })} />{fieldError(`models.${index}.id`)}</label>
          <label class="provider-field"><span>显示名<span class="field-optional">可选</span></span><input type="text" data-provider-field={`models.${index}.name`} aria-label={`第 ${index + 1} 个模型的显示名`} placeholder="显示名（可选）" value={item.name} maxLength={200} aria-invalid={invalid(`models.${index}.name`)} aria-describedby={describedBy(`models.${index}.name`)} onInput={event => row(index, { name: event.currentTarget.value })} />{fieldError(`models.${index}.name`)}</label>
          <label class="provider-field"><span>上下文长度<span class="field-optional">可选</span></span><input type="text" data-provider-field={`models.${index}.contextWindow`} inputMode="numeric" aria-label={`第 ${index + 1} 个模型的上下文长度`} placeholder="上下文长度（可选）" value={item.contextWindow} maxLength={12} aria-invalid={invalid(`models.${index}.contextWindow`)} aria-describedby={describedBy(`models.${index}.contextWindow`)} onInput={event => row(index, { contextWindow: event.currentTarget.value })} />{fieldError(`models.${index}.contextWindow`)}</label>
        </div>
      </div>)}
      <button type="button" class="quiet" disabled={form.rows.length >= 64} onClick={() => set({ rows: [...form.rows, { id: "", name: "", contextWindow: "" }] })}>添加模型</button>
    </fieldset>
    {!!existing?.extra.length && <p class="setting-note">这一条在 models.json 里还有表单之外的配置（{existing.extra.join("、")}），保存时原样保留。</p>}
    {!!existing?.modelExtras && <p class="setting-note">{existing.modelExtras} 个模型带有表单之外的配置，保留在各自的模型上；从列表移除的模型会连同它的配置一起删除。</p>}
    <div class="provider-key-note"><strong>下一步：设置密钥</strong><p class="setting-note">保存后用“设置密钥”，它经 pi 自己的登录保存到凭据文件，不写进 models.json。</p></div>
    {problem && !fieldProblem && <p class="setting-note setting-warn" role="alert" tabindex={-1} data-provider-error>{problem.message}</p>}
    <div class="setting-actions"><button type="submit" class="send-button" disabled={busy}>保存</button><button type="button" class="quiet" onClick={onCancel}>取消</button></div>
  </form>;
}

/** pi's `models.json` as a form: endpoints that speak an API pi already supports. Not a JSON editor. */
export function ProvidersSection({ state, canConfigure }: { state: WebState; canConfigure: boolean }) {
  const providers = useHostQuery(state, "providers");
  const [draft, setDraft] = useState<Draft>();
  const [removing, setRemoving] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const view: CustomProvidersView | undefined = providers.value;
  const busy = !!state.hostAction;
  const run = (command: "provider_remove" | "account_begin" | "account_apply", args: Record<string, unknown>, done?: (result: CustomProviderResult) => void) => {
    setError(""); setMessage(""); setRemoving("");
    runHostCommand<CustomProviderResult>(command, args).then(result => { done?.(result); providers.reload(); }, failure => { setError(explain(failure).message); providers.reload(); });
  };
  const saved = (result: CustomProviderResult) => {
    setDraft(undefined);
    setMessage(`已保存到 models.json。${result.insecure ? "注意：这个地址使用明文 http。" : ""}pi 空闲时会立即应用到当前会话。`);
    providers.reload();
  };
  if (draft && view) return <ProviderForm key={draft.create ? "new" : draft.id} draft={draft} revision={view.revision} existing={view.providers.find(provider => provider.id === draft.id && !draft.create)} busy={busy} onDone={saved} onCancel={() => setDraft(undefined)} />;
  return <>
    <p class="setting-intro">连接本地模型服务、公司网关，或使用 OpenAI、Anthropic、Google 兼容接口的服务。pi 已经内置的服务商请在“账户”里登录。</p>
    {view?.error && <p class="setting-note setting-warn" role="alert">models.json 无法使用，这里暂时不能修改，文件没有被改动。{view.error}</p>}
    {view?.pendingApply && <div class="setting-banner" role="status"><span>有已保存的更改在等待当前会话重新加载。{view.applyError ? explainApplyError(view.applyError) : ""}</span><button type="button" disabled={!canConfigure || busy} onClick={() => run("account_apply", {})}>立即应用</button></div>}
    {message && <p class="setting-note setting-ok" role="status">{message}</p>}
    {error && <p class="setting-note setting-warn" role="alert">{error}</p>}
    {providers.error && !view && <div class="setting-note setting-warn" role="alert"><p>{providers.error}</p><button type="button" onClick={providers.reload}>重新加载</button></div>}
    {!view && providers.loading && <p class="setting-note" role="status">正在读取…</p>}
    {view && !view.error && <div class="setting-subhead providers-toolbar"><h3>已添加<span class="setting-count">{view.providers.length}</span></h3><button type="button" class="send-button" disabled={busy} onClick={() => { setMessage(""); setError(""); setDraft(blank()); }}>添加供应商</button></div>}
    {view?.providers.map(provider => <div class="setting-row provider-row" key={provider.id}>
      <div class="setting-head"><strong>{provider.id}{provider.inUse && <span class="source-chip">当前模型</span>}</strong><span class={`resource-status ${provider.available ? "active" : ""}`}>{provider.available ? `当前会话可用 ${provider.available} 个模型` : view.pendingApply ? "等待应用" : "已配置，未验证"}</span></div>
      <dl class="setting-layers">
        <div><dt>API 协议</dt><dd>{API[provider.api] ?? (provider.api || "未填写")}</dd></div>
        <div><dt>Base URL</dt><dd>{provider.baseUrl || "未填写"}</dd></div>
        <div><dt>模型</dt><dd>{provider.models.length ? provider.models.map(model => model.name ? `${model.id}（${model.name}）` : model.id).join("、") : "没有可识别的模型"}</dd></div>
        <div><dt>密钥</dt><dd>{KEY[provider.key]}</dd></div>
      </dl>
      {provider.insecure && <p class="setting-note setting-warn">明文 http 地址：请求内容和密钥在网络上不加密。</p>}
      {provider.key === "none" && <p class="setting-note">没有密钥时 pi 不会列出它的模型。本地服务不校验密钥的，随便填几个字符即可。</p>}
      {(provider.key === "file_command" || provider.key === "file_env" || provider.key === "file_literal") && <p class="setting-note">这是 models.json 里已有的写法，这里不显示、不执行也不修改它。在这里设置的密钥会另存到凭据文件，pi 优先使用凭据文件里的。</p>}
      {!!provider.extra.length && <p class="setting-note">另有表单之外的配置：{provider.extra.join("、")}。只读，保存时原样保留。</p>}
      {provider.overlay ? <p class="setting-note setting-warn">这个名称是 pi 内置的服务商：这一条实际上改写了它的地址并追加了模型，不是新增供应商。只能在 models.json 里直接编辑。</p>
        : <div class="setting-actions">
          <button type="button" disabled={busy || !!view.error} onClick={() => { setMessage(""); setError(""); setDraft(edit(provider)); }}>编辑</button>
          <button type="button" disabled={busy || !canConfigure || state.account?.status === "running"} onClick={() => run("account_begin", { provider: provider.id, method: "api_key" })}>{provider.key === "stored" ? "替换密钥" : "设置密钥"}</button>
          {removing === provider.id
            ? <span class="rotate-confirm" role="group" aria-label={`确认删除 ${provider.id}`}><button type="button" disabled={busy} onClick={() => run("provider_remove", { id: provider.id, revision: view.revision }, result => setMessage(`已从 models.json 删除 ${provider.id}。${result.credentialRemoved ? "为它保存的密钥也已删除。" : ""}`))}>确认删除</button><button type="button" class="quiet" onClick={() => setRemoving("")}>取消</button></span>
            : <button type="button" class="quiet" disabled={busy || !!view.error} onClick={() => setRemoving(provider.id)}>删除</button>}
        </div>}
      {removing === provider.id && <p class="setting-note setting-warn">会删除这个供应商的 {provider.models.length} 个模型{provider.key === "stored" ? "和为它保存的密钥" : ""}。{provider.inUse ? "当前会话正在使用它的模型：删除并应用后，pi 会换用其他可用的模型，页面会提示更换前后的模型；没有其他可用模型时也会提示，需要先登录账户或添加供应商才能继续对话。" : ""}</p>}
    </div>)}
    {view && !view.providers.length && !view.error && <div class="settings-empty"><p>还没有自定义供应商。</p><span>添加一个兼容服务，再设置密钥，就能在会话里选择它的模型。</span></div>}
    <details class="setting-details"><summary>配置保存位置与编辑范围</summary><p class="setting-note">配置保存在 pi 的 models.json 里，对这台电脑上的所有项目生效。这里只编辑名称、协议、地址和模型列表。请求头、模型的输入类型与采样参数等其他配置仍在 models.json 里编辑，这里不会改动它们。</p></details>
  </>;
}
