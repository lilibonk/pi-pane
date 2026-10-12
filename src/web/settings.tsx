import { useLayoutEffect, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { PiThemeView, ReadonlySettingGroup, SettingItem, SettingKey, SettingResult, SettingValue, SettingsView, ThemeItem, ThemeProblem, ThemesView } from "../protocol/index.js";
import { DARK_THEME, LIGHT_THEME, type Appearance } from "./appearance.js";
import { AccountsPanel } from "./accounts.js";
import { ProvidersSection } from "./providers.js";
import { ThemeDecoration } from "./decorations.js";
import { explainApplyError } from "./apply-error.js";
import { Modal, useHostQuery } from "./projects.js";
import { HostError, clearAppearance, closeSettings, commitAppearance, openSettings, previewAppearance, runHostCommand, setHideThinking, type SettingsSection, type WebState } from "./store.js";

const SECTIONS: [SettingsSection, string][] = [["appearance", "外观"], ["defaults", "模型默认"], ["behavior", "会话行为"], ["accounts", "账户"], ["providers", "自定义供应商"], ["other", "其他设置"]];
const SECTION_NOTES: Record<SettingsSection, string> = {
  appearance: "让工作台适合你的阅读习惯。",
  defaults: "为之后的新会话选择模型与思考强度。",
  behavior: "调整消息发送、上下文与重试的方式。",
  accounts: "连接服务商，管理这台电脑上的登录。",
  providers: "接入自己的模型服务与兼容接口。",
  other: "查看 pi 的配置来源与网页支持范围。",
};
const ERRORS: Record<string, string> = {
  stale_setting: "这个设置刚被其他页面或另一个 pi 改过。现在显示的是已保存的值，需要的话请重新选择。",
  busy: "pi 正在回复、有待发消息或有待回答的对话框，结束后再改。",
  save_failed: "pi 没能写入设置文件，没有保存。",
  save_unconfirmed: "设置文件里没有看到新值，可能同时被其他程序改动，请查看后重试。",
  settings_unreadable: "pi 的全局设置文件无法解析，文件没有被改动。请先在编辑器里修复它。",
  invalid_setting: "这个值不在可选范围内。",
  theme_not_global: "只有 pi 在任何项目都能找到的主题才能设为默认：内置主题、pi 主题目录里的主题，或为用户安装的包里的主题。",
  no_runtime: "当前没有运行中的会话可以应用这项设置。",
  apply_cancelled: "有扩展拒绝了重新加载。更改已保存，可以稍后再应用。",
  host_stopped: "服务正在停止。",
  disconnected: "连接已断开，请重新连接后再试。",
  unknown_result: "连接已断开，结果未知。请查看当前值，不要直接重复操作。",
};
const explain = (error: unknown): string => error instanceof HostError ? ERRORS[error.code] ?? error.message : error instanceof Error ? error.message : "操作失败，请重试。";
const SOURCE: Record<ThemeItem["source"], string> = { "pi-pane": "pi-pane 自带", builtin: "pi 内置", user: "pi 主题目录", project: "当前项目", handoff: "运行 /web 时由 pi 加载" };
const PROBLEM: Record<ThemeProblem["code"], string> = { unreadable: "无法读取", too_large: "超过 256 KiB", invalid_json: "不是有效的 JSON", invalid_theme: "不是完整的主题", duplicate: "与另一个主题重名", reserved_name: "使用了保留名称 system" };
const TEXT: Record<SettingKey, { label: string; description: string }> = {
  theme: { label: "pi 默认主题", description: "终端里的 pi 使用的主题。" },
  defaultModel: { label: "默认模型", description: "新会话在没有其他指定时使用的模型。不改变当前会话，也不改变已保存会话记录的模型。" },
  defaultThinkingLevel: { label: "默认思考强度", description: "新会话在没有其他指定时使用的思考强度。不改变当前会话。" },
  steeringMode: { label: "引导消息的发送方式", description: "回复进行中插入的多条消息：逐条发送，或一次全部发送。" },
  followUpMode: { label: "后续消息的发送方式", description: "排在回复之后的多条消息：逐条发送，或一次全部发送。" },
  "compaction.enabled": { label: "自动压缩", description: "上下文接近上限时自动压缩会话。手动压缩不受影响。" },
  "retry.enabled": { label: "自动重试", description: "请求因临时错误失败时自动重试。pi 不报告当前会话的重试状态，这里显示的是保存的值。" },
  "images.blockImages": { label: "不向模型发送图片", description: "开启后，消息里的图片不会发给模型。" },
  hideThinkingBlock: { label: "终端里隐藏思考内容", description: "pi 在终端显示回复时是否隐藏思考内容。会话记录不受影响。" },
};
const VALUE: Record<string, string> = { "one-at-a-time": "逐条", all: "全部一起", system: "system（终端配色）" };
const show = (value: SettingValue | undefined): string => value === null || value === undefined ? "未设置" : value === true ? "开" : value === false ? "关" : VALUE[value] ?? value;
const SCOPE: Record<string, string> = {
  "runtime:now": "由 pi 自己的命令修改：立即作用于当前会话，同时保存为全局默认。需要 pi 空闲。",
  "global:new_runtimes": "保存为全局默认，对之后启动的会话生效。",
  "global:reload": "保存为全局默认。当前会话重新加载设置后生效：pi 空闲时自动进行，否则等待你点“立即应用”。",
  "global:terminal": "保存为全局默认，供之后启动的终端 pi 使用。不改变已经打开的终端。",
};
const REASON: Record<NonNullable<SettingItem["reason"]>, string> = { unreadable: "全局设置文件无法解析，暂时只读。", no_runtime: "没有运行中的会话，暂时不能修改。", no_models: "当前会话没有可用模型，无法选择。" };
function outcome(result: SettingResult): string {
  if (result.saved === "unconfirmed") return "pi 已接受并应用到当前会话，但全局设置文件里还没有看到这个值：保存状态未确认。";
  if (result.applied === "now") return "已应用到当前会话，并保存为全局默认。";
  if (result.applied === "overridden") return "已保存为全局默认。当前项目自己的设置仍然优先，在这个项目里不生效。";
  if (result.applied === "pending") return "已保存。pi 空闲时会立即应用到当前会话；pi 正在工作时，上方会出现“立即应用”。";
  return "已保存为全局默认。";
}

/** One editable pi setting: every layer that decides its value, a control for the global one, and an explicit save. */
function SettingRow({ item, state, canConfigure, children }: { item: SettingItem; state: WebState; canConfigure: boolean; children?: ComponentChildren }) {
  const saved = item.global ?? item.defaultValue;
  const [draft, setDraft] = useState<SettingValue>(saved);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useLayoutEffect(() => { setDraft(saved); }, [saved]);
  const text = TEXT[item.key];
  const blocked = !item.editable || !!state.hostAction || (item.writes === "runtime" && !canConfigure);
  const changed = draft !== saved && draft !== null;
  const save = () => {
    setMessage(""); setError("");
    runHostCommand<SettingResult>("setting_set", { key: item.key, value: draft, expected: item.global }).then(result => setMessage(outcome(result)), failure => { setError(explain(failure)); setDraft(saved); });
  };
  const id = `setting-${item.key.replace(/\W/g, "-")}`;
  const options = item.options ?? [];
  return <div class="setting-row">
    <div class="setting-head">
      <label for={id}>{text.label}</label>
      {children ?? (item.kind === "toggle"
        ? <input id={id} type="checkbox" role="switch" checked={draft === true} disabled={blocked} onChange={event => setDraft(event.currentTarget.checked)} />
        : <select id={id} value={typeof draft === "string" ? draft : ""} disabled={blocked || !options.length} onChange={event => setDraft(event.currentTarget.value)}>
          {(typeof draft !== "string" || !options.includes(draft)) && <option value={typeof draft === "string" ? draft : ""}>{typeof draft === "string" ? show(draft) : "未设置"}</option>}
          {options.map(option => <option value={option} key={option}>{show(option)}</option>)}
        </select>)}
    </div>
    <p class="setting-note">{text.description}</p>
    <details class="setting-details">
      <summary>全局默认：{show(item.global)}<span>查看值来源</span></summary>
      <dl class="setting-layers">
      <div><dt>全局默认</dt><dd>{item.global === null ? `未设置${item.defaultValue !== null ? `（pi 默认：${show(item.defaultValue)}）` : ""}` : show(item.global)}</dd></div>
      {item.project !== undefined && <div><dt>当前项目覆盖</dt><dd>{show(item.project)}</dd></div>}
      {item.cli && <div><dt>启动参数</dt><dd>{item.cli}（只对本次启动有效）</dd></div>}
      {item.runtime !== undefined && <div><dt>当前会话</dt><dd>{show(item.runtime)}</dd></div>}
      </dl>
      <p class="setting-note">{SCOPE[`${item.writes}:${item.applies}`]}</p>
    </details>
    {item.project !== undefined && <p class="setting-note">当前项目设置：{show(item.project)}</p>}
    {!item.editable && item.reason && <p class="setting-note setting-warn">{REASON[item.reason]}</p>}
    {item.editable && item.writes === "runtime" && !canConfigure && <p class="setting-note">pi 正在工作，空闲后可以修改。</p>}
    {changed && !children && <div class="setting-actions"><button type="button" class="send-button" disabled={blocked} onClick={save}>保存</button><button type="button" class="quiet" onClick={() => { setDraft(saved); setError(""); }}>撤销</button></div>}
    {message && <p class="setting-note setting-ok" role="status">{message}</p>}
    {error && <p class="setting-note setting-warn" role="alert">{error}</p>}
  </div>;
}

function piThemeText(pi: PiThemeView): string {
  const where = pi.source === "cli" ? "启动参数 --use-theme" : pi.source === "project" ? "当前项目的设置" : pi.source === "global" ? "pi 的全局设置" : "";
  if (pi.origin === "catalog") return `${where}指定了“${pi.setting}”，这里显示的是其中的“${pi.name}”。`;
  if (pi.reason === "system") return `${where ? `${where}指定了 system。` : "pi 没有设置主题，默认使用 system。"}system 取自终端配色，这里显示的是运行 /web 时终端的颜色快照。`;
  if (pi.reason === "missing") return `${where}指定的“${pi.setting}”在这里不可用，显示的是运行 /web 时终端的颜色快照。`;
  return `${where}的主题设置“${pi.setting}”无法识别，显示的是运行 /web 时终端的颜色快照。`;
}
const sameTheme = (a: Appearance, b: Appearance): boolean => a.mode === b.mode && (a.mode !== "theme" || a.theme === b.theme);
const sameLook = (a: Appearance, b: Appearance): boolean => sameTheme(a, b) && (a.showDecorations !== false) === (b.showDecorations !== false);
function Swatch({ item }: { item?: ThemeItem }) {
  return <span class="theme-swatch theme-preview" aria-hidden="true" style={item ? { background: item.preview.bg, color: item.preview.fg, "--preview-accent": item.preview.accent } : undefined}>
    <span class="theme-preview-sidebar"><i /><i /><i /></span>
    <span class="theme-preview-page"><span>Aa</span><i /><i /><b /></span>
  </span>;
}
/** The theme of pi itself: a fixed name, or a light/dark pair pi chooses between by the terminal's appearance. */
function PiDefaultTheme({ item, state, agentDir }: { item: SettingItem; state: WebState; agentDir: string }) {
  const current = typeof item.global === "string" ? item.global : "";
  const [paired, setPaired] = useState(current.includes("/"));
  const [first, setFirst] = useState(current.split("/")[0] || "system");
  const [second, setSecond] = useState(current.split("/")[1] || "dark");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useLayoutEffect(() => { setPaired(current.includes("/")); setFirst(current.split("/")[0] || "system"); setSecond(current.split("/")[1] || "dark"); }, [current]);
  const options = item.options ?? ["system"];
  const named = options.filter(option => option !== "system");
  const value = paired ? `${first}/${second}` : first;
  const valid = paired ? named.includes(first) && named.includes(second) : options.includes(first);
  const blocked = !item.editable || !!state.hostAction;
  const select = (id: string, label: string, selected: string, choose: (value: string) => void, list: string[]) => <label class="theme-default-select" for={id}><span>{label}</span>
    <select id={id} value={selected} disabled={blocked} onChange={event => choose(event.currentTarget.value)}>{!list.includes(selected) && <option value={selected}>{selected}（不可用）</option>}{list.map(option => <option value={option} key={option}>{show(option)}</option>)}</select></label>;
  const save = () => {
    setMessage(""); setError("");
    runHostCommand<SettingResult>("setting_set", { key: "theme", value, expected: item.global }).then(result => setMessage(outcome(result)), failure => setError(explain(failure)));
  };
  return <div class="setting-row">
    <div class="setting-head"><strong>{TEXT.theme.label}</strong></div>
    <p class="setting-note">保存到 pi 的全局设置，供之后启动的终端使用。此浏览器和已经打开的终端保持各自的外观。</p>
    <details class="setting-details"><summary>查看终端主题的配置来源</summary>
    <dl class="setting-layers">
      <div><dt>全局默认</dt><dd>{item.global === null ? "未设置（pi 默认：system）" : show(item.global)}</dd></div>
      {item.project !== undefined && <div><dt>当前项目覆盖</dt><dd>{show(item.project)}（全局默认在这个项目里不生效）</dd></div>}
      {item.cli && <div><dt>启动参数</dt><dd>--use-theme {item.cli}（只对那次启动的终端有效）</dd></div>}
    </dl>
    <p class="setting-note">全局设置目录：{agentDir}</p>
    </details>
    <label class="setting-check"><input type="checkbox" checked={paired} disabled={blocked || named.length < 1} onChange={event => { setPaired(event.currentTarget.checked); if (event.currentTarget.checked && first === "system") setFirst(named.includes("light") ? "light" : named[0] ?? "system"); }} />按终端的明暗自动切换（保存为“浅色主题/深色主题”）</label>
    <div class="theme-default-controls">
      {paired ? <>{select("theme-default-light", "终端为浅色时", first, setFirst, named)}{select("theme-default-dark", "终端为深色时", second, setSecond, named)}</> : select("theme-default-fixed", "主题", first, setFirst, options)}
    </div>
    <p class="setting-note">只能选 pi 在任何项目都能找到的主题；某个项目自己的主题不能设为全局默认。带纹样的主题保存后，终端只得到配色。</p>
    {!item.editable && item.reason && <p class="setting-note setting-warn">{REASON[item.reason]}</p>}
    <div class="setting-actions"><button type="button" class="send-button" disabled={blocked || !valid || value === current} onClick={save}>保存为 pi 默认主题</button></div>
    {message && <p class="setting-note setting-ok" role="status">{message}</p>}
    {error && <p class="setting-note setting-warn" role="alert">{error}</p>}
  </div>;
}

function AppearanceSection({ state, themes, settings, reload }: { state: WebState; themes: ThemesView | undefined; settings: SettingsView | undefined; reload: () => void }) {
  const active = state.appearancePreview ?? state.appearance;
  const previewing = !!state.appearancePreview && !sameLook(state.appearancePreview, state.appearance);
  const choose = (look: Appearance) => previewAppearance(sameLook(look, state.appearance) ? null : look);
  const item = (name: string) => themes?.themes.find(theme => theme.name === name);
  const option = (look: Appearance, title: string, note: string, swatch?: ThemeItem) => {
    const selected = sameTheme(active, look);
    return <button type="button" class={`theme-option ${selected ? "is-current" : ""}`} role="radio" aria-label={title} aria-checked={selected} key={`${look.mode}:${look.theme ?? ""}`} onClick={() => choose({ ...look, showDecorations: active.showDecorations !== false })}>
      <Swatch item={swatch} /><span class="theme-option-text"><strong>{title}{sameTheme(state.appearance, look) && <small>已选</small>}</strong><span>{note}</span></span>
    </button>;
  };
  const piDefault = settings?.items.find(entry => entry.key === "theme");
  const hide = settings?.items.find(entry => entry.key === "hideThinkingBlock");
  return <>
    <p class="setting-intro">外观保存在此浏览器，其他设备可以各自选择。</p>
    <div class="theme-options" role="radiogroup" aria-label="此浏览器的外观">
      {option({ mode: "pi" }, "跟随 pi", "使用 pi 在当前项目的主题。", item(themes?.pi.name ?? ""))}
      {option({ mode: "system" }, "跟随此设备的浅色或深色", "随设备自动切换 pi-pane 的浅色与深色。")}
      {option({ mode: "light" }, "浅色", "pi-pane 自带的浅色主题。", item(LIGHT_THEME))}
      {option({ mode: "dark" }, "深色", "pi-pane 自带的深色主题。", item(DARK_THEME))}
    </div>
    {active.mode === "pi" && themes && <p class="setting-note">{piThemeText(themes.pi)}</p>}
    {active.mode === "system" && <p class="setting-note">这里跟随设备的明暗偏好；pi 的 system 主题则取自终端配色。</p>}
    <div class="setting-subhead"><h3>已安装的 pi 主题</h3><button type="button" class="quiet" onClick={reload}>刷新主题</button></div>
    {!themes && <p class="setting-note" role="status">正在读取主题…</p>}
    {themes && <div class="theme-options" role="radiogroup" aria-label="已安装的 pi 主题">
      {themes.themes.filter(theme => theme.name !== LIGHT_THEME && theme.name !== DARK_THEME).map(theme => option({ mode: "theme", theme: theme.name }, theme.name, `${SOURCE[theme.source]} · ${theme.appearance === "light" ? "浅色" : "深色"}`, theme))}
    </div>}
    {themes && themes.themes.length <= 2 && <p class="setting-note">没有发现其他主题。把主题文件放进 pi 的主题目录后点“刷新主题”。</p>}
    {themes?.projectThemes === "untrusted" && <p class="setting-note">当前项目带有自己的主题。项目未被信任，没有读取它们。</p>}
    {themes?.truncated && <p class="setting-note">主题文件太多，只读取了前 128 个。</p>}
    {!!themes?.problems.length && <details class="setting-problems"><summary>{themes.problems.length} 个主题文件没有被使用</summary><ul>{themes.problems.map((problem, index) => <li key={index}><code>{problem.file}</code>（{SOURCE[problem.source]}）：{PROBLEM[problem.code]}</li>)}</ul></details>}
    <details class="setting-details"><summary>主题从哪里来</summary><p class="setting-note">这里只列出 pi 的内置主题、pi 主题目录、受信任项目的主题目录，以及运行 /web 时 pi 已经加载的主题。之后新装的主题包需要在终端重新运行 /web 才会出现。浏览器偏好按网址（包括端口）保存，端口变了需要重新选择。</p></details>
    {state.themeProblem === "missing" && <p class="setting-note setting-warn" role="alert">“{state.themeName}”在当前项目不可用。{state.themeVars ? "暂时保留上次的颜色。" : "暂时使用 pi 的主题。"}</p>}
    {!state.appearanceStored && <p class="setting-note setting-warn" role="alert">此浏览器无法保存偏好（例如处于隐私模式），刷新后会恢复为跟随 pi。</p>}
    {(state.appearance.mode !== "pi" || state.appearance.showDecorations === false) && !previewing && <div class="setting-actions"><button type="button" class="quiet" onClick={clearAppearance}>清除此浏览器的外观偏好</button></div>}
    <div class="setting-subhead"><h3>显示偏好</h3></div>
    <div class="setting-browser-options">
      <label class="setting-check"><input type="checkbox" aria-label="显示主题装饰" aria-describedby="theme-decoration-note" checked={active.showDecorations !== false} onChange={event => choose({ ...active, showDecorations: event.currentTarget.checked })} /><span>显示主题装饰<small id="theme-decoration-note">在品牌区、空状态和设置页眉显示主题提供的纹样。</small></span></label>
      <label class="setting-check"><input type="checkbox" checked={!!state.appearance.hideThinking} onChange={event => setHideThinking(event.currentTarget.checked)} /><span>在此浏览器隐藏思考内容<small>只影响显示，会话记录不变。</small></span></label>
    </div>
    {hide && <SettingRow item={hide} state={state} canConfigure={true} />}
    <div class="setting-subhead"><h3>pi 自己的主题</h3></div>
    {piDefault && settings ? <PiDefaultTheme item={piDefault} state={state} agentDir={settings.agentDir} /> : <p class="setting-note" role="status">正在读取设置…</p>}
    {previewing && <div class="setting-preview" role="status"><span>正在预览，尚未保存。关闭设置会恢复原来的外观。</span><button type="button" class="send-button" onClick={commitAppearance}>使用此外观</button><button type="button" class="quiet" onClick={() => previewAppearance(null)}>取消预览</button></div>}
  </>;
}

const GROUPS: Record<string, [string, string]> = {
  models: ["模型范围与逐模型思考", "常用模型范围（/scoped-models）和逐模型的思考设置需要专门的编辑界面，本期只读，列入之后的首批工作。"],
  cache: ["缓存提示与预热", "预热会产生额外费用，网页暂不提供开关。"],
  trust: ["默认项目信任", "这是影响所有项目的策略。网页只在打开项目时逐个询问，不在这里修改它。"],
  tools: ["默认工具", "工具列表与启停需要 pi 的 RPC 提供支持，目前只能在终端设置。"],
  compaction: ["压缩与分支摘要的数值", "数值需要按模型校验范围，本期只读。"],
  retry: ["重试的数值", "代理层与服务商层各有一套重试，本期只读。"],
  images: ["图片自动缩放", "尚未验证它对网页发送的图片是否生效。网页上传另有自己的大小限制。"],
  resources: ["扩展、技能、模板、主题与包", "安装和启停（pi install、pi config）在终端完成；本期只读，列入之后的首批工作。"],
  markdown: ["Mermaid 图", "网页的渲染方式与终端不同，尚未接入。"],
  telemetry: ["遥测与提醒", "网页不代你更改这些选择。"],
  session: ["会话目录", "pi 启动时读取，运行中不能更改。"],
  network: ["网络与传输", "pi 启动时读取。代理地址可能含凭据，这里不显示内容。"],
  shell: ["Shell 与 npm 命令", "这些设置决定 pi 在这台电脑上执行什么命令，只能在终端编辑，这里不显示内容。"],
  terminal: ["终端界面", "只对终端里的 pi 有意义，对网页无效。"],
};
function OtherSection({ groups }: { groups: ReadonlySettingGroup[] }) {
  return <>
    <p class="setting-intro">pi 的其余设置在这里只读：列出它们在哪里被设置，并说明为什么不能在网页修改。命令、路径和代理这类内容只显示“已设置”。</p>
    {groups.map(group => <section class="setting-group" key={group.id}>
      <h3>{GROUPS[group.id]?.[0] ?? group.id}<small>{group.status === "terminal" ? "仅终端" : group.status === "runtime" ? "启动时读取" : "暂不支持修改"}</small></h3>
      <p class="setting-note">{GROUPS[group.id]?.[1]}</p>
      <ul class="setting-readonly">{group.settings.map(setting => <li key={setting.key}><code>{setting.key}</code><span>{setting.where.length ? `${setting.where.map(where => where === "global" ? "全局" : "当前项目").join(" + ")}${setting.value !== undefined ? `：${setting.value}` : "：已设置"}` : "未设置"}</span></li>)}</ul>
    </section>)}
  </>;
}

/** Settings: this browser's look, pi's own defaults, and everything else read-only with its reason. */
export function SettingsDialog({ state, canConfigure }: { state: WebState; canConfigure: boolean }) {
  const section = state.settings ?? "appearance";
  const own = section === "accounts" || section === "providers"; // sections that read their own data
  const settings = useHostQuery(state, "settings", {}, !own);
  const themes = useHostQuery(state, "themes", {}, section === "appearance");
  const [error, setError] = useState("");
  const view = settings.value;
  const rows = (keys: SettingKey[]) => keys.map(key => view?.items.find(item => item.key === key)).filter((item): item is SettingItem => !!item).map(item => <SettingRow key={item.key} item={item} state={state} canConfigure={canConfigure} />);
  const apply = () => { setError(""); runHostCommand("account_apply").then(() => settings.reload(), failure => setError(explain(failure))); };
  return <Modal titleId="settings-title" onClose={closeSettings} wide>
    <div class="settings-dialog">
      <div class="settings-head"><h2 id="settings-title">设置</h2><div class="settings-decoration"><ThemeDecoration slot="settingsHeader" /></div><button type="button" class="quiet" data-autofocus onClick={closeSettings}>关闭</button></div>
      <div class="settings-nav" role="group" aria-label="设置分类">{SECTIONS.map(([name, label]) => <button type="button" key={name} aria-pressed={section === name} onClick={() => openSettings(name)}>{label}</button>)}</div>
      <div class="settings-body" key={section}>
        <header class="settings-section-head"><h3>{SECTIONS.find(([name]) => name === section)?.[1]}</h3><p>{SECTION_NOTES[section]}</p></header>
        {!own && view?.errors.map(item => <p class="setting-note setting-warn" role="alert" key={item.scope}>{item.scope === "global" ? "pi 的全局设置文件无法解析，所有设置暂时只读，文件没有被改动。" : "当前项目的设置文件无法解析，已忽略。"}{item.message}</p>)}
        {!own && view?.pendingApply && <div class="setting-banner" role="status"><span>有已保存的更改在等待当前会话重新加载。{view.applyError ? explainApplyError(view.applyError) : ""}</span><button type="button" disabled={!canConfigure || !!state.hostAction} onClick={apply}>立即应用</button></div>}
        {error && <p class="setting-note setting-warn" role="alert">{error}</p>}
        {!own && settings.error && !view && <div class="setting-note setting-warn" role="alert"><p>{settings.error}</p><button type="button" onClick={settings.reload}>重新加载</button></div>}
        {section === "appearance" && <AppearanceSection state={state} themes={themes.value} settings={view} reload={themes.reload} />}
        {section === "appearance" && themes.error && !themes.value && <p class="setting-note setting-warn" role="alert">{themes.error}</p>}
        {section === "defaults" && <><p class="setting-intro">这些是 pi 的全局默认值，保存在 {view?.agentDir ?? "pi 的数据目录"} 的 settings.json 里，对这台电脑上的所有项目生效。要换当前会话的模型，请用输入框旁的模型选择。</p>{rows(["defaultModel", "defaultThinkingLevel"])}</>}
        {section === "behavior" && <><p class="setting-intro">当前会话的行为。前四项由 pi 自己的命令修改，会同时保存为全局默认。{view?.project.settings === "loaded" ? "当前项目有自己的设置文件，它设置的项目会覆盖全局默认。" : view?.project.settings === "untrusted" ? "当前项目有自己的设置文件；项目未被信任，没有读取。" : ""}</p>{rows(["steeringMode", "followUpMode", "compaction.enabled", "retry.enabled", "images.blockImages"])}</>}
        {section === "accounts" && <AccountsPanel state={state} canConfigure={canConfigure} />}
        {section === "providers" && <ProvidersSection state={state} canConfigure={canConfigure} />}
        {section === "other" && view && <OtherSection groups={view.groups} />}
        {!own && section !== "appearance" && !view && settings.loading && <p class="setting-note" role="status">正在读取设置…</p>}
      </div>
    </div>
  </Modal>;
}
