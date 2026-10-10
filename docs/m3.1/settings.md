# M3.1 调研：主题与 pi 原生设置

返回：[主计划](../m3.1-plan.md) · [调研索引](../m3.1-research.md)。本文保留事实、候选方案与限制；实施范围以主计划的明确取舍为准。
日期：2026-10-10。仅调研与计划建议；未修改产品代码、未读取日常 settings.json/auth.json、未执行模型调用。2026-10-10 已按主计划第 14 节的审阅修订同步。当前 pi-pane 固定为 `c2c39e6f7a84c7e8490bbca587528cb195524e22`（0.2.0 收尾）。pi 固定为本机已发布 `@earendil-works/pi-coding-agent@1.1.0`，官方 `v1.1.0` tag 经 `git ls-remote` 解析到 `abe508e1b89912adde45528136c3221eb69acdd7`。

## 1. 结论与证据分级

- **A = 已验证事实**：官方固定版本文档、公开类型/exports 与实现相互印证。
- **B = 本次隔离探针验证**：只使用公开 `SettingsManager.fromStorage` 和内存 synthetic storage，未触碰日常配置。
- **C = 设计建议**：需要后续实现和验收，不是已有能力。
- **D = 待验证或受限**：不可在排期文档中描述为已支持。

主要结论：

1. **主题与常用设置可做，不应统一归为“等上游”。** pi 公开导出 `SettingsManager`；部分运行时设置已有正式 RPC 命令。当前 pi-pane 只实现了当前模型/思考等级和手动压缩，`/settings` 仅路由到“资源”页，没有通用设置 UI。（A；P1、P2、L1）
2. **“可通过 SDK 做”不等于“通过 RPC 调用现成接口”。** RPC 的 `getAllThemes()` 返回空数组，`getTheme()` 返回 undefined，`setTheme()` 明确失败；需由宿主管理网页外观和持久化设置。（A；P3）
3. **主题必须分开显示三种概念**：当前网页查看器外观、pi 持久化默认主题、交接时的终端颜色快照。pi 的 `system` 是终端调色板；网页“跟随设备明暗”是浏览器 prefers-color-scheme，两者不能同名冒充。（A + C；P4）
4. **`setTheme()` 默认写 global，不写当前项目。** 项目 `theme` 仍可能覆盖 global；`getTheme()` 遇到 `light/dark` 自动配对会返回 undefined，应使用 `getThemeSetting()`保留真实配置。（A + B；P5）
5. **`flush()`完成不代表写盘成功。** 错误被保存到 `drainErrors()`，内存状态可以先变而文件未变。UI 必须区分预览、已应用、已保存以及保存失败。（A + B；P6）
6. **公开资源加载器能提供主题，但完整 reload 不仅“读主题”。** 它会进行 package resolution、加载扩展并可能执行资源发现钩子。主题菜单不能在宿主重复加载项目扩展；专用主题目录适配必须先通过无代码执行/无网络/与 pi 信任行为一致的探针。（A + D；P7）
7. **原生配置不适合一次性变成任意 JSON 编辑器。** 首批采用字段 allowlist，其他字段展示分类与明确原因；不启用任意 custom TUI 转译，不承诺所有设置即时热更新。（C）

## 2. 一手固定依据

以下 `#L` 是 npm 包 source map 中包含的原始 TypeScript 行号，与固定官方源码路径对应；文档行号来自发布包原文。已通过浏览器工具打开官方 v1.1.0 settings/themes/settings-manager 页面核对。不要把仓库 main 当成此次依据。

| ID | 固定依据 | 支持内容 |
|---|---|---|
| P1 | [pi settings 类型、公开方法](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/settings-manager.ts#L133)；[包根 exports](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/index.ts#L306) | 字段、scope 和公开 SettingsManager |
| P2 | [RPC 设置分发](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L519) | 队列、自动压缩与重试命令 |
| P3 | [RPC theme stubs](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L290) | theme 不能通过 RPC ctx.ui 热切换 |
| P4 | [主题文档](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/docs/themes.md#L5) | system、自动配对、JSON 规范、用户主题热加载、项目 trust |
| P5 | [getThemeSetting/getTheme/setTheme](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/settings-manager.ts#L872) | global 写入、project 覆盖、自动配对读取 |
| P6 | [write queue 与 merge](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/settings-manager.ts#L706)；[flush/drainErrors](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/settings-manager.ts#L800)；[文件锁](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/settings-manager.ts#L316) | 队列/错误/按字段合并；不能声称原子事务或自动回滚 |
| P7 | [ResourceLoader 公开接口](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/resource-loader.ts#L153)；[reload](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/resource-loader.ts#L509)；[主题解析](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/resource-loader.ts#L887) | 公开 getThemes；reload 有额外工作 |
| P8 | [配置与 trust](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/docs/configuration.md#L1)；[SettingsManager 默认 trust](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/settings-manager.ts#L464) | global/project 合并；创建 manager 必须显式传实际 projectTrusted，默认 true 不能作为已获授权 |
| P9 | [完整设置表](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/docs/settings.md#L5) | 本文字段盘点覆盖范围 |
| P10 | [当前模型切换](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/agent-session.ts#L2477)；[thinking](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/agent-session.ts#L2612) | 默认仅写当前 session；persist 必须单独请求，而 RPC 不传 persist |
| P11 | [Extension UI theme API](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/extensions/types.ts#L284)；[包根 theme exports](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/index.ts#L473) | 交接前可通过公开 UI API 取主题；内部 loadThemeFromPath/getThemeByName 并未从包根导出，不应 deep-import |
| P12 | [Theme 验证器可选](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/modes/interactive/theme/theme.ts#L46) | 单独 SDK 加载是否装好 validator 需要探针，不能因 getThemes 可用就声称已严格校验 |
| L1 | [pi-pane slash路由](https://github.com/lilibonk/pi-pane/blob/c2c39e6f7a84c7e8490bbca587528cb195524e22/src/web/commands.ts#L3)；[资源面板](https://github.com/lilibonk/pi-pane/blob/c2c39e6f7a84c7e8490bbca587528cb195524e22/src/web/workbench.tsx#L320) | 当前 `/settings` 实际不是原生设置页 |
| L2 | [交接主题捕获](https://github.com/lilibonk/pi-pane/blob/c2c39e6f7a84c7e8490bbca587528cb195524e22/src/extension/index.ts#L158)；[rebind继续用target.theme](https://github.com/lilibonk/pi-pane/blob/c2c39e6f7a84c7e8490bbca587528cb195524e22/src/extension/handoff.ts#L153) | 当前主题是交接快照，跨项目不能宣称已重新加载 |
| L3 | [ThemeMapper](https://github.com/lilibonk/pi-pane/blob/c2c39e6f7a84c7e8490bbca587528cb195524e22/src/extension/theme.ts#L33) | 已有 token→CSS、256KiB有界读取、export背景与颜色容错 |
| L4 | [现有主题应用](https://github.com/lilibonk/pi-pane/blob/c2c39e6f7a84c7e8490bbca587528cb195524e22/src/web/main.tsx#L266) | 可复用 CSS 变量通路，不需写 session 文件 |

## 3. 作用域与生效语义

| 作用域 | 存储/来源 | M3.1 的处理建议 |
|---|---|---|
| pi global | `<agent-dir>/settings.json`，注意不是固定硬编码 `~/.pi/agent` | 用户明确选择“保存为 pi 默认”；写前载入实际 agentDir、只改 allowlist 字段 |
| pi project | 当前项目 `.pi/settings.json`，项目需已信任 | 首批展示 override 的存在、有效值和来源；没有公开相应 project setter 的字段不提供伪“项目保存” |
| 进程启动覆盖 | argv / CLI flags，比如 `--use-theme`、`--model`、`--tools` | 与磁盘默认值分开显示；保存 defaults 不能假装覆盖启动参数。跨项目按项目切换计划重新解析；重建同一会话时不重放 `--model`/`--thinking`，由会话记录恢复 |
| 当前会话运行态 | RPC state/session entries | 模型与 thinking 继续通过 RPC；和“以后新会话的默认值”分开 |
| 当前网页查看器 | 本浏览器偏好，不是模型配置 | 外观模式、折叠 thinking 等可以 viewer-only；建议站点独立 local preference，任何变化不得自动写 pi settings。偏好按网页 origin 保存；本地模式未指定端口时端口可能变化，偏好不跨端口保留，须说明并建议固定端口 |
| 全局限制字段 | `defaultProjectTrust`、`httpProxy`、`cacheWarming` 仅 global | 不能在项目 UI 写入并假装有效；本期默认不开放这些高影响配置 |

页面至少显示：配置名称、当前有效值、来源、保存作用域、何时生效、被覆盖原因、保存状态。不得把原始 settings 全对象直接发浏览器（可能含扩展私有字段、代理 URL 凭据、shell 前缀等敏感信息）。

## 4. 首批 allowlist 建议（实施范围）

### 4.1 必交付

| 能力 | 操作路径 | 保存与生效 | 限制 |
|---|---|---|---|
| 当前模型、thinking | 现有 `set_model` / `set_thinking_level` | 当前 session立即；不偷偷写 defaults | 运行/排队/对话框/切项目时冻结变更 |
| 默认 provider/model、defaultThinkingLevel | 宿主 `SettingsManager`公开setter | 明确 global；用于随后创建的运行时/会话。项目覆盖和 CLI覆盖单独标识 | 只允许当前有效catalog中选择，不接受任意provider/model字符串；不修改已打开session |
| `steeringMode`、`followUpMode` | 正式 RPC `set_steering_mode` / `set_follow_up_mode` | 原生实现会写 global，并更新活动运行态；UI必须说明 | 原生RPC回执不证明磁盘成功，需读盘确认；项目覆盖时实际行为需探针 |
| `compaction.enabled`、`retry.enabled` | 正式 RPC `set_auto_compaction` / `set_auto_retry` | 原生setter写global；当前运行态读取有效配置 | 不把“磁盘已写global”误作“project覆写消失” |
| 网页主题 fixed + browser-auto + 跟随pi | 宿主安全主题目录→CSS tokens，viewer选择 | 当前浏览器立即；刷新恢复 | browser-auto 默认用内置 light/dark；不是终端system主题 |
| 保存 pi默认 `theme`（固定或light/dark配对） | 宿主 `setTheme()` + flush +错误与读盘核验 | global保存；以后TUI/进程按其自身appearance选择 | 项目来源主题不要无提示写成所有项目默认；global/project/CLI覆盖可见 |
| 恢复继承/清除viewer偏好 | 仅viewer存储 | 回到当前pi主题或交接快照 | “清除默认theme设置”没有公开delete setter；不要使用空串冒充删除 |
| `hideThinkingBlock`的网页显示偏好 | viewer设置；若提供保存pi默认另用public setter | 网页仅影响显示，原始session不改 | 不抹除消息内容，不改变请求的thinking强度 |

### 4.2 本期先显示能力与来源、暂不开放编辑

`images.autoResize`/`images.blockImages` 值应可解释，但 RPC prompt 的图像路径必须先验证 pi 是否与TUI同样执行预处理；不能先做一个仅修改磁盘的无效开关。资源安装/启停、MCP管理、任意provider endpoints、传输与shell配置属于单独完整流程；不以“JSON编辑器”绕过。

是否把 image 两项纳入必交付，应在基础探针关卡作明确决定；若不纳入，界面说明“当前网页图片上传使用自身限制，pi设置的等价行为尚未接入”，不能声称完整继承。`showCacheMissNotices`等同理，需对应事件已经在网页可见才开放实际开关。

## 5. 完整原生设置盘点

范围为 1.1.0 `docs/settings.md` 设置表的全部 **71 个字段**（已逐项核对完整名称）；同一表格行可覆盖同一语义类别的多个字段。状态：**已有**=0.2.0已有部分运行态操作；**本期**=上述allowlist；**只读/延期**=显示支持原因/来源；**仅TUI**=不做网页同名控制；**重启**=保存只能以后运行时生效，需独立流程。

| 类别/字段 | 原生scope | 状态与本期边界 |
|---|---|---|
| `defaultProvider`, `defaultModel`, `defaultThinkingLevel` | global/project读；公开setter写global | 当前模型已有；默认值本期补，和当前session分开 |
| `modelThinkingLevels` | global/project合并 | 只读/延期；逐模型偏好矩阵不是当前thinking下拉框 |
| `thinkingBudgets` | global/project | 只读/延期；高级token预算，需provider验证 |
| `enabledModels` | global/project | 只读/延期；需要模型scope编辑/模式校验，不能等同模型catalog |
| `hideThinkingBlock` | global/project +viewer可自有 | 本期网页显示与原生默认分离 |
| `showCacheMissNotices` | global/project | 只读/延期，需通知事件表现验证 |
| `cacheWarming` | **仅global** | 只读/延期；有费用影响，不默认新增后台请求 |
| `steeringMode`, `followUpMode` | global/project，原生setter写global | 本期正式RPC；提示排队语义与持久化范围 |
| `externalEditor` | global/project | 仅TUI，不在网页执行任意本机编辑器命令 |
| `doubleEscapeAction`, `treeFilterMode` | global/project | 仅TUI默认；网页自有焦点/Escape逻辑，不机械映射 |
| `defaultProjectTrust` | **仅global** | 只读/延期；打开项目的单项目信任另属P0项目流程，不能把全局always作为快捷方式 |
| `defaultTools` | global/project特殊merge +CLI覆盖 | 只读/延期；原约定仍等公开RPC工具列表/启停；启动选择与实时工具启停不混淆 |
| `codemode.mode`, `codemode.inlineBudget` | global/project | 只读/延期；扩展配置，不做custom TUI转换 |
| `sessionDir` | global/project，env/CLI更高 | 只读/重启；不要在运行时搬迁或改写session目录 |
| `compaction.enabled` | global/project | 本期RPC；保留现有手动压缩 |
| `compaction.reserveTokens`, `compaction.keepRecentTokens`, `compaction.modelOverrides` | global/project合并 | 只读/延期；高级设置数值需安全整数与模型边界测试 |
| `branchSummary.reserveTokens`, `branchSummary.skipPrompt` | global/project | 只读/延期，分支摘要/tree能力未完整映射 |
| `theme` | global/project +CLI覆盖 | 本期网页主题与global保存；项目setter缺失不擅自泛化 |
| `quietStartup`, `tuiMode`, `fullscreenExitOutput`, `fullscreenScrollbar`, `fullscreenCopyOnSelect`, `fullscreenWheelScrollLines` | global/project | 仅TUI；不作为网页设置，不禁止用户在TUI使用 |
| `editorPaddingX`, `outputPad`, `autocompleteMaxVisible`, `showHardwareCursor` | global/project | 仅TUI；网页布局/输入法/命令面板有独立实现 |
| `terminal.showImages`, `terminal.imageWidthCells`, `terminal.clearOnShrink`, `terminal.showTerminalProgress`, `terminal.hyperlinks`, `terminal.images`, `terminal.trueColor` | global/project | 仅TUI；终端OSC/Kitty/iTerm2控制不适用于浏览器 |
| `images.autoResize`, `images.blockImages` | global/project | 探针后决策；当前不承诺RPC与TUI图片入口等价 |
| `markdown.codeBlockIndent` | global/project | 仅TUI代码缩进；网页代码组件不直接映射 |
| `markdown.mermaid` | global/project | 只读/延期；网页mermaid是否启用、最终/流式行为需单独渲染工作 |
| `transport` | global/project | 只读/重启流程；不是pi-pane WebSocket传输设置 |
| `httpProxy` | **仅global** | 只读/延期且脱敏，不把代理credentials发浏览器；不是M2反代配置 |
| `httpIdleTimeoutMs`, `websocketConnectTimeoutMs` | global/project | 只读/重启流程；与网页连接超时分开 |
| `retry.enabled` | global/project | 本期RPC开关 |
| `retry.maxRetries`, `retry.baseDelayMs`, `retry.maxAgentDelayMs`, `retry.provider.timeoutMs`, `retry.provider.maxRetries`, `retry.provider.maxRetryDelayMs` | global/project | 只读/延期；provider重试和agent重试分开，不能制造双层等待 |
| `shellPath`, `shellCommandPrefix`, `npmCommand` | global/project | 只读/重启流程；涉及命令执行，不提供任意字符串快速编辑 |
| `packages`, `extensions`, `skills`, `prompts`, `themes` | global/project资源列表组合 | 本期读来源/发现诊断；安装、任意路径编辑、资源列表修改延期；主题选取不等于主题安装 |
| `enableSkillCommands` | global/project | 只读/重启或reload流程；不能只更新host catalog而child没更新 |
| `collapseChangelog` | global/project | 仅TUI启动显示 |
| `enableInstallTelemetry`, `enableAnalytics` | global/project（具体读法以API为准） | 只读/延期，不代用户开关，不产生额外遥测 |
| `warnings.anthropicExtraUsage` | global/project | 只读/延期，不静默关闭费用提醒 |

不属于普通用户编辑字段的 `lastChangelogVersion`, `trackingId`, `deviceId` 不出现在编辑器中，也不发原始值。登录凭据、models.json、mcp.json、keybindings.json、AGENTS/SYSTEM 文档不是 settings.json 字段，应由相应功能分别管理，不能归入“任意其他设置”。

## 6. Theme实施边界与探索关卡

### 6.1 可以复用什么

- `ThemeMapper`已经把pi Theme颜色转成纯颜色CSS变量，含代码/工具diff/状态语义token；保留它的有界读取和hex校验。
- 交接前 `ctx.ui.getAllThemes()`/`getTheme()`是公开 API，可以捕获当时已发现的主题目录及已解析Theme；诊断由ThemeCatalog或ResourceLoader另行提供；RPC接管后这些API不再可用。
- `DefaultResourceLoader`是包根公开导出，`getThemes()`返回Theme对象和诊断；可研究“只加载主题”的安全配置，但完整reload仍会resolve包，不可未经测试直接上线。
- `loadThemeFromPath`, `getThemeByName`, `setRegisteredThemes`, `setThemeJsonValidator`在内部模块定义，不属于根exports；不要为了方便deep-import。独立SDK进程的schema验证是否启用必须验证。

### 6.2 推荐产品行为（C）

1. “网页外观”提供：跟随pi、浅色、深色、跟随当前设备，以及已发现自定义主题；预览只改viewer。
2. “pi默认主题”单独提供保存，显示保存的是global、有效值是否被project/CLI覆盖。固定主题与light/dark配对都可表达，不用`getTheme()`判断自动模式。
3. pi `system` 在浏览器显示为“终端主题（交接时快照）”；不持续查询关闭的TUI，也不把手机明暗变化保存到全局pi设置。
4. 自定义主题只从已认可的本机目录/包目录发现；网页不接收任意CSS/URL、不直接载入远程字体/脚本。主题JSON里的颜色语法遵守官方格式。
5. 换项目后重新获取合法主题目录与来源；项目A的主题不能无提示继续伪装成B主题。缺失/损坏/重名主题保留最后合法viewer外观并显示诊断。
6. 新增/改动主题使用明确“刷新主题”动作；本期不承诺所有来源热watch。用户目录原生hot-reload也不能推断网页已实现watch。

### 6.3 不能预先承诺

任意扩展动态注册主题在项目切换后都能完全无副作用地被宿主重新发现；独立ThemeLoader完全一致地运行resources_discover钩子；终端system实时跟随；任意CSS主题编辑器；自动主题跟随不同viewer时共享单一host主题；未信任项目主题加载。

探索关卡结束必须明确：支持的主题来源矩阵、无私有导入的加载方式、完整校验方式、失败fallback。该关卡未过时，不能削成仅深浅色而仍称“完整原生主题支持”。

## 7. 设置写入、并发与恢复设计建议

1. 设置写入由宿主串行化，按 `agentDir + scope + cwd + fields revision` 校验请求；浏览器不能传任意文件路径、JSON patch或未知字段。
2. 保留 `workbench_query` 作为读取协议；新增结构化settings view仅返回allowlist有效值、来源、版本及能力。 mutation沿用正常命令回执，不复活nonce/内部命令网关。
3. 有正式RPC的活动设置优先RPC；只有宿主呈现/持久化defaults才直接用公开SettingsManager。不能两边同时写同一字段又声称“single writer”。这里的配置文件协调与session唯一写入者是两件事，后者不能被破坏。
4. 为宿主设置manager显式传`agentDir`、`cwd`和实际`projectTrusted`。`SettingsManager.create`默认projectTrusted=true并不能替代项目授权。
5. 保存前reload并取allowlist旧值/版本，`drainErrors()`检查已有读取错误；setter后`await flush()`，再`drainErrors()`并重新读盘确认。配置损坏时不覆盖修复整个文件。
6. UI初次仅preview；持久化确认后才“已保存”。写失败恢复viewer预览前外观/重新加载有效配置；不得用过期内存值当真实磁盘值。可保留用户未保存选择供重试。
7. pi默认文件storage使用文件锁和按修改字段merge，保留无关字段；**不提供跨文件事务、same-field CAS、自动回滚承诺**，且写盘是writeFileSync而非原子rename。要达到严格原子提交，应另立公开`SettingsStorage`适配方案评审，不能宣称原生已支持。
8. 同一host两页面编辑同字段：旧revision拒绝，并给最新值；不同字段应合并。其他TUI/外部编辑器改同字段：重新核验冲突，避免用整文件snapshot覆盖。完全严格的跨进程CAS是待验证项，不靠UI序列号假装解决。
9. RPC设置command回执返回时，pi内部保存队列未提供远程flush/read-errors协议。队列/compaction需独立读盘确认+get_state；retry没有对应state字段，需回执/有效配置及确定性行为验证；超时显示“运行态已应用，保存状态未确认”，不要停掉会话或假称完成。
10. 需要重建运行时才生效的设置与凭据应用共用同一应用方式：优先进程内原生会话替换，回退才是child重启。两者都要求空闲/无队列/无待答对话框；不满足时显示“已保存、待应用”，不自动终止回复。设置的global保存不能无意扩大M3.1成资源安装与重载系统。

## 8. 本次隔离探针结果（B）

机器可读结果：[settings-probe-results.json](settings-probe-results.json)。

执行方式：node直接import已发布pi1.1.0的包根公开SDK，创建自定义内存storage；没有HOME读取、没有文件写入和网络/模型调用。

| 探针 | 输入 | 观测 |
|---|---|---|
| scope | global.theme=dark、project.theme=light；setTheme(fixture-theme)、flush | effective=light；global=fixture-theme；project=light；无关字段保留；errors=0 |
| flush failure | storage在setter后抛 synthetic write failure | flushRejected=false；inMemoryTheme=light；persistedTheme=dark；drainErrors=1 |
| merge | manager创建后外部改images.autoResize=false及新增external字段；setBlockImages(true) | blockImages=true、autoResize=false、新增字段和无关字段都保留；errors=0 |

探针只能证明上述有限行为，不能替代真实多进程锁、磁盘空间不足、只读文件、损坏JSON及UI保存失败回归。

## 9. 具体新增验收ID（建议）

| ID | 场景 | 通过标准 |
|---|---|---|
| SET-01 | 空配置、global、trusted project、CLI覆盖 | 页面分别展示默认/配置值/有效值与来源；设置控制器不加载未信任项目的受门控字段；pi启动前读取sessionDir和普通上下文的例外另行验证 |
| SET-02 | 两浏览器修改不同字段与同字段 | 不同字段保留；旧revision同字段拒绝，用户可以重新选择；无整文件覆盖 |
| SET-03 | 外部TUI改无关字段、BOM JSON、损坏JSON | 无关字段保留；BOM支持；损坏JSON拒绝写入且原文件不变 |
| SET-04 | 存储锁冲突/权限失败/模拟磁盘写失败 | 不出现“已保存”；内存与磁盘状态区别可见；会话仍可继续；重试可恢复 |
| SET-05 | 已有project override的global保存 | 显示global保存成功且当前project继续覆盖；不伪装已改变effective值 |
| SET-06 | 原生RPC队列/compaction/retry开关 | 队列/compaction用get_state与磁盘分别确认；retry无state字段，用回执、配置回读及确定性临时失败验证效果；RPC failure不报成功 |
| SET-07 | 修改默认模型与当前模型 | 当前模型操作不偷偷改defaults；默认值保存不重写现有session；下次启动/新建按文档语义加载；以`--model`启动时重建同一会话不回退到启动参数的模型 |
| SET-08 | busy/queued/pending dialog时更改运行设置或应用需重建运行时的设置 | 合适门槛禁用/拒绝，或保持“已保存、待应用”；不打断消息、丢队列或失去dialog |
| SET-09 | 非allowlist、原始settings、秘密字段 | 协议拒绝未知写；响应不带credentials/httpProxy password/扩展私有配置/设备标识 |
| SET-10 | mobile settings和键盘操作 | 390px无横向溢出、标签和错误可读、焦点陷阱/Escape正确、无隐式保存 |
| THM-01 | 内置light/dark与browser-auto | 消息/工具/diff/代码/弹窗都更新；手机与桌面独立明暗，不互相强制覆盖 |
| THM-02 | pi system | 标签明确为终端快照；浏览器matchMedia变化不伪称pi终端system变化，不写native设置 |
| THM-03 | 固定主题与light/dark默认配对 | setTheme持久化+errors+readback；刷新、新TUI启动选择符合scope/appearance；automatic值未丢失 |
| THM-04 | global/user、trusted project、package主题 | 各支持来源可发现，记录来源/碰撞/失效诊断；未支持来源说明原因 |
| THM-05 | 未信任项目与跨项目 | 未信任项目不加载主题/扩展；切换后来源准确，无A→B过期主题假象 |
| THM-06 | 缺失/循环变量/无效颜色/重名/超大JSON | 显示诊断，保留最后合法主题；无CSS/URL注入、无阻塞、大文件有界拒绝 |
| THM-07 | 自定义主题刷新 | 无无关包下载或重复执行扩展；刷新结果与规定来源矩阵一致；failure不清空当前主题 |
| THM-08 | 预览取消/保存失败/清除viewer偏好 | 取消恢复；失败不写成功状态；清除仅viewer且正确回到继承值 |
| THM-09 | global默认选项目私有主题 | 明确不可跨项目使用或拒绝作为global默认，不留下不可解释的失效配置 |
| THM-10 | focus、select、工具状态和diff可读性 | 所有主题完成桌面与移动人工视觉验收；主题中的文字/焦点/状态没有不可辨认回归 |

所有会写settings的验证使用临时HOME/agentDir及确定性provider。最终candidate上重新跑M0–M3完整回归和19项CUA；上述验收新增，不替代旧交接/单写入者/锁/刷新要求。

## 10. 探针可复现要点

以下精简例子通过发布包的公开包根导入，可复现最容易误判的 `flush` 行为；storage只有内存变量，不访问真实settings文件。完整执行结果见第8节。

```js
import { SettingsManager } from '@earendil-works/pi-coding-agent';
let fail = false;
let saved = JSON.stringify({ theme: 'dark' });
const manager = SettingsManager.fromStorage({
  withLock(scope, fn) {
    if (fail) throw new Error('synthetic write failure');
    const next = fn(scope === 'global' ? saved : undefined);
    if (next !== undefined && scope === 'global') saved = next;
  },
}, { projectTrusted: false });
fail = true;
manager.setTheme('light');
await manager.flush(); // resolves despite the synthetic storage failure
console.log({ memory: manager.getThemeSetting(), disk: JSON.parse(saved).theme,
  errors: manager.drainErrors().length });
// { memory: 'light', disk: 'dark', errors: 1 }
```

后续实现测试需要在临时agentDir用真实公开文件storage重跑，不把这个内存探针替代磁盘验收。当前研究没有创建或修改产品配置。
