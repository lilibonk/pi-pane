# M3.1 项目管理研究记录（供详细计划引用）

返回：[主计划](../m3.1-plan.md) · [调研索引](../m3.1-research.md)。本文保留事实、候选方案与限制；实施范围以主计划的明确取舍为准。
日期：2026-10-10。基线：pi-pane `c2c39e6f7a84c7e8490bbca587528cb195524e22`、npm `@earendil-works/pi-coding-agent@1.1.0`。本次仅静态读源码、发布包文档/类型/JS及其附带 source map，并打开官方固定版本网页确认来源；未执行模型，未读取日常 auth/settings/trust 文件，未修改 tracked 源码。本文为计划依据，不是运行验收通过记录。2026-10-10 已按主计划第 14 节的审阅修订同步；新增的 P-E19–23 当时是对发布 JS 与本仓库源码的静态阅读；其后 G1、G2 原型已运行，结果与据此作出的决定见[门槛验证记录](../m3.1-gates.md)：空会话选定候选 A；关闭阶段弹对话框时子进程以 0 退出而不是挂起。下文与该记录不一致之处以该记录和主计划为准。

## 1. 结论及必须修正的表述

**已证事实：pi 有以 cwd 创建运行时/会话、跨 cwd 恢复已有会话的公开基础；pi-pane 缺独立项目记录、主机目录选择与跨项目运行时切换流程。不是 pi 本身禁止新建项目。**

但“宿主换 cwd 重启 RPC”不是一个已验证的现成补丁，至少包含启动监督、信任、参数作用域、空会话、锁、取消/失败恢复六项变化。计划不能把这些写成已做完或必然无损。

特别需要区分：

- **项目**是主机目录及 pi-pane 保存的用户入口；不以至少有一个已保存会话为前提。
- **当前空会话**有运行时 sessionId、预分配 sessionFile；文件通常尚不存在。
- **已保存会话**已出现 user/assistant 条目并落盘，可由标准 pi 恢复。
- **项目信任**决定项目 `.pi` 资源等是否加载；不是工具的文件系统沙箱，也不是“目录是否允许被用户打开”。

## 2. 证据索引

本地 `node_modules/@earendil-works/pi-coding-agent/package.json:3` 为 `1.1.0`。下列官方链接都固定在 `v1.1.0`，不是易变 main；JS 行与 TS 行不同，TS 锚点由官方发布包 source map 内 `sourcesContent` 对应得到。

| ID | 证据及已证内容 |
|---|---|
| P-E01 | [SDK 文档](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/docs/sdk.md#L54)：cwd 决定项目资源发现、上下文、会话分组和内置工具路径。本地 docs/sdk.md:54。 |
| P-E02 | [RPC new_session](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/docs/rpc-commands.md#L130)、[switch_session](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/docs/rpc-commands.md#L592)：new_session 只有 parentSession，无 cwd；switch_session 接 sessionPath。类型进一步确认 dist/modes/rpc/rpc-types.d.ts:38、104。 |
| P-E03 | [运行时切换实现](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/agent-session-runtime.ts#L196)：switchSession 从目标 header 得 cwd，校验目录，先 emitBeforeSwitch，可被扩展取消，再销毁旧运行时、创建新的 cwd-bound services。newSession 在同文件 L226 继续使用 this.cwd 和当前 sessionDir。对应发布 JS:128–172。 |
| P-E04 | [会话创建与落盘](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/session-manager.ts#L1057)、[延后持久化](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/session-manager.ts#L1161)：newSession 先生成路径；仅首次 user/assistant 消息后写 JSONL，model/thinking/system/session metadata 本身不足以落盘。JS:691–715、785–812；类型 d.ts:247–255。 |
| P-E05 | [公开 CLI](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/cli/args.ts#L310)：--session path/id、--session-id exact-id、--session-dir、--mode rpc；没有用于 pi 主会话的 --cwd 参数，需 spawn cwd。args JS:299–307。 |
| P-E06 | [CLI 路径识别](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/main.ts#L252)：包含分隔符或 .jsonl 的 --session 值直接按路径处理。SessionManager.open 对尚不存在路径创建新内存会话并保留显式文件路径（session-manager JS:665–689）。这是无需宿主伪造 JSONL 的候选方案基础。 |
| P-E07 | [启动 cwd/参数解析](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/main.ts#L683)：先得会话 cwd 再创建资源；显式 extension/skill/template/theme 路径在启动 cwd 下解析（L726）。JS:543–551、583–586。 |
| P-E08 | [配置规则](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/docs/configuration.md)：项目 `.pi` 配置需信任，sessionDir 例外用于发现；agentDir 可由环境指定；AGENTS 等上下文文件不需项目信任。本地 docs/configuration.md:3、9、26–47。 |
| P-E09 | [项目信任解析](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/project-trust.ts#L46)：显式 override → 无需信任资源 → 全局/CLI 扩展 project_trust → trustStore → 默认策略；ask 且没有 UI 则不信任。RPC 启动的 projectTrustContext hasUI=false：[main.ts L764](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/main.ts#L764)。发布 JS project-trust:17–57 / main:614–620。 |
| P-E10 | [公开导出](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/index.ts#L392)：ProjectTrustStore、hasTrustRequiringProjectResources 已由包根导出；无需 deep import。dist/index.d.ts:27。[store](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/trust-manager.ts#L210) 按真实路径保存，继承最近祖先决定，有文件锁；set/setMany 为公开接口。 |
| P-E11 | [本次信任参数](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/cli/args.ts#L341)：--approve / --no-approve 仅当前调用。不应把起始项目的临时信任无条件传给新项目。 |
| P-E12 | [pi-pane 当前目录分组](https://github.com/lilibonk/pi-pane/blob/c2c39e6f7a84c7e8490bbca587528cb195524e22/src/web/workbench.tsx#L166)：对已有会话按 cwd 分组；无独立零会话项目。 |
| P-E13 | [pi-pane 当前切换](https://github.com/lilibonk/pi-pane/blob/c2c39e6f7a84c7e8490bbca587528cb195524e22/src/extension/handoff.ts#L272)：当前 session_new 仅 RPC new_session；session_switch 先锁目标，成功后 rebind workspace；非取消失败若无法证明仍原会话则停服务。 |
| P-E14 | [pi-pane 锁](https://github.com/lilibonk/pi-pane/blob/c2c39e6f7a84c7e8490bbca587528cb195524e22/src/extension/session-lock.ts#L27)：路径尚未存在时用父目录 realpath+basename；父目录必须存在。acquire 先独占 sidecar（L103），普通 TUI 不受排他锁阻止。 |
| P-E15 | [pi-pane 启动门](https://github.com/lilibonk/pi-pane/blob/c2c39e6f7a84c7e8490bbca587528cb195524e22/src/extension/rpc-child.ts#L86)：子进程暂停于启动门，宿主取得锁并持久化 writer PID 后才 activate。新项目也必须保留此顺序。 |
| P-E16 | [宿主退出监督](https://github.com/lilibonk/pi-pane/blob/c2c39e6f7a84c7e8490bbca587528cb195524e22/src/extension/index.ts#L230)：当前 runHandoff 只 race 最初 childExited；主动替换 child 会被识别为宿主故障退出。不能只给 HandoffHost 新增 spawn。 |
| P-E17 | [只读文件服务](https://github.com/lilibonk/pi-pane/blob/c2c39e6f7a84c7e8490bbca587528cb195524e22/src/extension/workspace.ts#L66)：WorkspaceService 限制在当前 cwd，排除凭据/隐藏敏感目录、检查 symlink，不能放宽其 root 来兼做全主机目录浏览。 |
| P-E18 | [当前参数保留器](https://github.com/lilibonk/pi-pane/blob/c2c39e6f7a84c7e8490bbca587528cb195524e22/src/extension/child-args.ts)：保留 --approve、--session-dir、显式资源路径/模型参数；原本只服务同一会话交接。跨项目需分类处理，不可全盘重放。 |
| P-E19 | 发布 JS `dist/main.js:593–597`、`dist/core/project-trust.js:18–20`、`dist/core/agent-session-runtime.js:128–146`：`--approve`/`--no-approve` 形成的信任覆盖对该进程内任何 cwd 的运行时都生效，设置后不再发 `project_trust` 事件；原生 switchSession 在同一进程内按目标 header cwd 重建运行时。RPC 状态不含信任结果。 |
| P-E20 | 发布 JS `dist/modes/rpc/rpc-mode.js:579–596、639–642` 与 `dist/modes/rpc/rpc-types.d.ts`：RPC 命令集中没有 shutdown；stdin 结束触发 shutdown → `runtimeHost.dispose()`（发 session_shutdown）→ 退出；关闭中再收到 SIGTERM 则立即退出。stdin 关闭后无法送达 extension_ui_response。 |
| P-E21 | 发布 JS `dist/main.js:366–372、662`：`--model`/`--thinking` 在每次创建运行时都参与会话选项，不以会话已有历史为条件。 |
| P-E22 | 本仓库 `src/extension/workspace.ts:46–52、99`：排除规则作用于相对项目根的路径；根目录自身位于被排除目录内时规则不再命中。 |
| P-E23 | 本仓库 `src/extension/rpc-child.ts:77、91`、`src/extension/handoff.ts:145–152、293–296`：子进程继承宿主 `process.env`；追加归属校验依赖存活子进程的 get_entries；`session_new` 的现有顺序是先取得 get_state 的预分配路径再加锁。 |

## 3. 推荐产品范围（建议，尚未实现）

主代理本轮另行进行了隔离 Kimi Code 2.1.1 实机检查：未登录也能通过“选择文件夹→绝对路径→添加”加入启动 cwd 外的**已有目录**，空工作区无对话且刷新仍保留；本次界面未见 mkdir 入口。因此“已有主机目录注册、零会话项目”是已实测的 Kimi 基线；“网页新建磁盘目录”是为满足本产品需求提出的新增范围，不能表述为已证 Kimi 2.1.1 相同行为。具体截图/操作证据由主代理记录。

### 3.1 项目入口与数据模型

P0：独立项目列表、最近项目、创建项目（现存父目录 + 单个新文件夹名）、打开已有主机目录、切换项目、从列表移除项目。移除仅删除 pi-pane 记录，不删除文件/会话。空项目必须持续存在，用户创建后不发消息也不会从列表消失。打开已有项目时默认恢复其最后已保存会话，引用失效则进入新的空会话。

建议持久化 `<agent-dir>/pi-pane/projects.json`，版本化 schema；记录 opaque projectId、canonicalPath、用户显示名、createdAt、lastOpenedAt、可选最后已保存会话引用；不保存模型 key、聊天、认证 token。列表合并已保存会话 cwd，旧版用户无损得到已使用项目；显式注册项目与会话发现来源分开标记。真实路径去重；symlink 输入回显真实位置；目录改名/丢失显示不可用和重新定位入口，不默默指向同名新目录。并发宿主读改写采用锁+原子替换，不覆盖别人刚添加的项目。

暂不做 git clone、模板脚手架、自动 git init、目录重命名/删除、文件管理器、跨主机连接。项目创建是 mkdir 和创建工作台入口，不意味着替用户生成项目文件。

### 3.2 目录选择

目录是**运行 pi 的主机路径**，不是浏览器所在手机/电脑的文件；不能用文件上传或 `showDirectoryPicker` 冒充服务器目录选择。浏览器只显示目录名、当前路径、父目录、目录是否可进入/创建；不返回文件内容。直接输入绝对路径供高级用户使用；中文、空格、引号、shell 元字符必须按路径处理，禁止拼 shell 命令。

新增独立的受同一认证保护的目录查询服务，分页/上限/取消；保持 WorkspaceService 的工作区边界不变。可浏览根与初始位置应作为产品配置决策：建议从当前项目、最近项目、用户主目录入口开始，用户明确选择其他绝对目录；不做后台全盘递归扫描，也不把敏感文件浏览并入本功能。远程访问继续沿用 M2 HTTPS/代理+密码；未认证请求不得枚举主机路径。

项目根可选之后，WorkspaceService 按相对路径判断的敏感过滤不再自动成立（P-E22）。项目根 realpath 的任一路径段属于凭据类目录（`.ssh`、`.gnupg`、`.aws`、`.azure`、`.pi`、`.codex`），或位于有效 agentDir、会话目录、pi-pane 数据目录之内时，拒绝经网页打开、创建或重新定位为项目，并提示在终端进入；`build`、`dist` 等仅为降噪而排除的目录名不在此列。

创建目录：验证现存父目录、可写性、单段名字；若同名目录已存在，提示“打开已有目录”而非把重试记为创建成功；路径确认到实际 mkdir 之间须重新核对父目录 realpath/对象标识，以应对 symlink 替换。新目录即使后续 child 启动失败也保留并说明，不自动递归删除。

### 3.3 项目信任

识别目标目录是否含需信任资源，显示“信任并记住此目录”“不加载项目配置继续”“取消”。持久决定使用公开 ProjectTrustStore，由子进程按原生顺序（全局扩展事件 → store → 默认策略）解析。首版不提供“仅本次信任”：`--approve` 是进程级覆盖并跳过全局扩展的 project_trust 事件（P-E19），无法做到 target-scoped，因此宿主从不生成它。“不加载继续”使用 `--no-approve`，同为进程级但方向是少加载，只在本次打开该项目期间有效。不提供“信任父目录”，避免误扩展用户选择作用域。

全局扩展可以否决已写入的信任记录，且 RPC 不回报实际信任结果。界面把“用户的选择”和“实际加载情况”分开显示，后者以新快照中的命令和资源来源为依据，无法确认时显示未知；spike 仍须验证 global defaultProjectTrust 与全局扩展的实际优先级。

信任说明应直说允许加载项目配置、安装项目声明的包、执行扩展；“不信任”仍可打开普通文件和运行模型/工具，AGENTS 上下文也仍按 pi 规则加载。不得宣称是沙箱。已有显式不信任、继承父目录信任、项目后来新增 `.pi` 资源都必须测。

## 4. 推荐实现路线与备选

### 路线 A（推荐进入 spike）：前台宿主管项目，标准 RPC 子进程管理当前会话

保留 Hub/现有网络认证/一个活跃写入者；项目管理和配置是宿主控制操作；会话 prompt/new/switch/fork 等继续标准 RPC。网页仍只走现有公开 workbench 协议的扩展类型，禁止浏览器提交 shell/任意 RPC 包。

新项目需要全新 cwd 时，宿主准备信任及启动配置，然后顺序关闭旧 child 并启动目标 child。空会话有两个候选，由 S1 对比后二选一。**候选 A（优先）**：不传 `--session`，标准 CLI 在目标 cwd 自行创建会话并按原生规则决定 sessionDir；宿主在 get_state 返回预分配路径后再加锁，与现有 `session_new` 的顺序相同（P-E23），须证明加锁前子进程不会落盘。**候选 B**：宿主预先分配**明确的、不存在的 JSONL 路径**并加锁，再传入标准 `--session`；SessionManager.open 会在目标 spawn cwd 创建空会话。两者都不手写 header/user message，不为了“保存空会话”发假提示。

候选 B 需要 spike 确定如何精确选择 sessionDir，且新项目的默认会话目录尚不存在时现有锁实现会失败（P-E14），须由宿主先建目录：遵守 CLI --session-dir > PI_CODING_AGENT_SESSION_DIR > 目标项目 sessionDir > 默认目录的 pi 规则；绝不能把起始项目 sessionDir 误当新项目默认。可通过公开 SettingsManager/SessionManager 仅获得目录/预分配路径（不 append，不创建第二 AgentSession 写入者）；观察新 child `get_state` 的 authoritative sessionId，而非把预分配文件名 UUID 当真实 ID。

**关键：没有文件时目标 cwd 必须来自已验证的启动目标，不能继续用 `sessionCwd(..., oldCwd)` 的旧回退。**以已验证启动descriptor和权威RPC快照确认空项目切换成功；文件/Git/模型/资源须匹配目标。第一次真实消息落盘后另行核对header.cwd，不能要求先发送消息才允许打开空项目。

同项目已有会话继续 native switch_session，保留其 `session_before_switch` 取消语义。跨项目已有会话曾有两种选择：继续 native switch_session（已经重建 cwd-bound runtime，保留原生 hook，但信任解析的 RPC 无 UI 是限制）；或使用相同 child replacement 路线（OS process.cwd 也正确，配置刷新更统一，但旧进程扩展 veto 无标准 RPC preflight）。主计划已取舍为后者：宿主发起的跨 cwd 切换一律走 child replacement。

扩展命令仍可让子进程自行切到另一个 cwd 的会话（P-E19）。宿主在写操作后的状态核对中发现会话 cwd 与当前项目不一致时不得静默接受：默认失败关闭（停止服务并打印恢复命令）；S2 可评估改为受控重建，但带信任覆盖启动的子进程只能失败关闭。

**不能承诺跨 child 替换完整等价于原生 session_before_switch。**标准 RPC 无“询问是否允许离开但先不切换”命令。正常EOF退出会尝试shutdown，但现有RpcChild.stop的2秒SIGTERM/5秒SIGKILL可能截断慢或交互shutdown，不能保证完整执行；旧扩展也没有自动veto机会。G2须明确正常与强制终止，不能强杀后假称无损迁移。应在 spike 中明确语义和兼容限制；不能为了触发 hook 先在旧项目 new_session，制造额外会话，或增加私有扩展网关。

计划停止只能关闭 stdin（P-E20），因此关闭阶段的交互不受支持：此后收到对话框请求，即判定该扩展的 shutdown 需要交互，等到上限后强制结束并进入 recovery_required。关闭窗口内的追加无法证明归属（P-E23）；默认按主计划第 8 节的有界接受规则处理，出现 user/assistant 消息条目、结构不合法或 child 退出后仍有写入时不激活目标。

### 路线 B：宿主直接改用公开 SDK AgentSessionRuntime

SDK 能传 cwd、信任 UI/服务，项目和配置控制更直接。代价是放弃“pi --mode rpc 子进程唯一写入者”的既定结构，并需重做 crash隔离、CLI内置扩展/MCP/默认资源/运行时生命周期；超出当前默认方案。除非路线 A 的实测缺口不可接受并由维护者明确调整架构，否则不采用。

### 排除方案

- 宿主自己生成 JSONL header/用户条目，或为持久化空会话发送隐藏 prompt：污染真实会话、破坏 writer责任。
- 每个项目常驻一个 child：扩大资源/后台语义，超出前台单运行时约定。
- 仅 `process.chdir()` 或改 UI 路径：不保证资源、设置、工具闭包与子进程 cwd 更新。
- 在正在活跃的 child 外并行用 SDK AgentSession 写同一 session：违反唯一写入者。
- 给现有 WorkspaceService 放开任意绝对路径：破坏只读工作区查询边界。

## 5. 切换状态机与失败/取消语义（设计建议）

`ready → validating → awaiting_trust → preparing → stopping_old → starting_target → verifying_target → ready`

- validating/preparing 不修改当前 session/资源；检查 idle（无响应、无排队消息、无运行扩展控制操作/待答对话框）、用户路径、权限、会话选择、目标锁可获得性。新请求带 operationId、expected generation，第二浏览器的竞争请求返回 busy/stale，不并行执行。
- 启动前取消：释放候选锁/预留，仅保留用户刚明确创建的目录与项目入口；旧运行时不变。
- 停旧 child 之前保存旧 runtime descriptor（cwd、实际 sessionFile、有无落盘、已解析的启动参数、临时信任作用域），UI 草稿保留；声明进入不可即时取消阶段。停止前趁旧 child 存活完成最后一次追加归属校验和空闲复核，记录基线。
- 锁顺序：目标锁先预留；旧 child停止并确认退出后才释放旧锁/激活目标；禁止两个可写 child重叠。启动门要写入目标 writer PID 后才能激活。空会话候选 A 没有可预留的目标路径，改为 get_state 后加锁。
- 退出监督必须按 child generation区分“计划替换结束”和“非预期崩溃”。全局 Ctrl+C/SIGHUP任何阶段都停止服务并清理两个候选锁/进程。
- 启动成功必须收到权威 state和完整snapshot，资源/模型/文件/Git重新查询；只收到 OS spawn成功不算成功。
- 目标启动失败：提供明确错误与“恢复上一个项目”操作。可做一次**用户刚发起事务的有界恢复**，但要明确这与“故障子进程不得自动无限重启”的区别；若恢复也失败，则停止服务并提供可用的终端恢复命令，不能循环重启。是否默认自动做该次恢复需维护者选择，推荐显式按钮，避免无声执行扩展两次。
- 原空会话未persist时，无法保证其 extension内存状态在换child后完全复原；只能恢复项目/配置和网页草稿，并开始新的空会话。UI必须事先定义此行为，不能叫“无损恢复”。
- 对非预期 child崩溃仍沿用M3停止服务/不自动重启。新项目切换不应借机引入后台运行。

## 6. 启动参数作用域必须单列工作

原交接参数保存适合同一会话；跨项目需要类型化 LaunchProfile，而非把所有旧 argv加到新 cwd：

1. 进程级明确用户参数：provider/model/tools/no-* 可作为当前网页启动配置继续，但 UI显示被 CLI覆盖；后续网页设置不要谎称已生效。重建同一会话（凭据/设置应用、失败恢复）时不重放 provider/model/thinking（P-E21），由会话记录恢复并在重建后核对。
2. 显式资源路径：在原启动 cwd解析为绝对路径再继承；项目自动发现资源由新 cwd重新加载。--append-system-prompt既可能文本又可能文件，不能盲目把字符串当路径。
3. --approve/--no-approve：用户原始参数只在子进程启动于起始项目时重放；宿主只为“不加载继续”生成 --no-approve，从不生成 --approve（P-E19）。
4. --session、--continue、--resume、--fork、初始 prompt/@file：不得重放；切换目标独立生成。
5. --session-dir、环境 sessionDir：区分显式全进程override与项目设置来源，避免错误复用。
6. 扩展自定义 flag：保留明确形式，但目标项目可能没有注册该 flag；需检查并在启动失败时给出具体错误，不能默默吞参。
7. 环境变量：子进程始终继承宿主起始 shell 的环境（P-E23），不模拟 direnv、虚拟环境或 shell hook；项目面板与迁移文档说明它与 `cd <项目> && pi` 不等价，本期不提供环境编辑。

## 7. 实施工作包与进入条件

| ID | 优先级 | 工作包 | 依赖/产物 |
|---|---|---|---|
| M31-P-S1 | P0 | 公共CLI新cwd+未落盘session spike；对比候选A（事后加锁）与候选B（预锁），不伪造header、get_state、首消息、重开原生pi | 暂时HOME/agent目录、确定性provider；记录真实stdout与磁盘状态，不提交产品实现 |
| M31-P-S2 | P0 | 信任/资源/相对CLI路径/自定义sessionDir/oldshutdown/rollback spike；另含进程级信任覆盖与子进程自行跨cwd、关闭阶段对话框、关闭窗口追加、模型参数重放 | P-S1；对比目标配置与实际工具cwd；决定跨项目原生switch或替换 |
| M31-P1 | P0 | 项目registry、版本迁移、从旧会话目录导入、路径去重及失效项目 | P-S1结论；数据schema和原子写测试 |
| M31-P2 | P0 | 主机目录选择/创建、信任选择UI及宿主校验 | P1、P-S2；不能弱化M2认证和WorkspaceService |
| M31-P3 | P0 | generation-aware宿主状态机、锁、启动参数LaunchProfile、取消/失败恢复 | 两spike通过；保持M3单写入者和进程寿命 |
| M31-P4 | P0 | 桌面/移动项目导航，零会话空态，新项目首会话，跨项目草稿与资源刷新 | P1–3；明确远程选的是主机目录 |
| M31-P5 | P0 | 下表确定性+CUA+包安装回归；文档、迁移与恢复指引 | 不以“界面有入口”替代行为验收 |

S1/S2若失败，停在设计决策，不能先交付有按钮但用错cwd的版本。未做这些运行spike前，本文对路线A的可行性是有代码依据的推断，不是验收证明。

## 8. 可直接纳入主计划的验收 ID

所有测试使用临时HOME/agent、临时项目A/B/C、确定性provider；不读取真实凭据。每项记录版本、步骤、预期、实际、证据、结论。

| ID | 验收条件 |
|---|---|
| M31-P-01 | 从无任何pi历史的现存空目录打开项目，列表显示0会话；服务重开仍存在；不产生虚假用户消息。 |
| M31-P-02 | 创建中文/空格/引号名称目录，既存同名目录不覆盖；不存在父目录/无权限/路径中NUL均清楚报错，旧会话可继续。 |
| M31-P-03 | symlink别名去重；目录被移动/删除标记不可用；重定位需用户选择，不静默回退cwd。 |
| M31-P-04 | 新项目收到第一条真实prompt之前无JSONL是正常状态；锁在子进程可能落盘之前已覆盖预分配路径（加锁时机随S1选定的候选而定）；首次消息落盘header cwd正确，原生pi --session可恢复。 |
| M31-P-05 | A→B→A时bash pwd、read/write相对路径、AGENTS、project settings、skills/templates/extensions、模型/文件/Git全匹配目标，无原项目资源泄漏（显式全局/CLI资源除外且来源可见）。 |
| M31-P-06 | 未知含.pi资源项目会问信任，取消不离开旧项目；不信任不执行project extension；“信任并记住”写入trustStore，“不加载继续”只在本次打开期间有效，不提供仅本次信任；界面把用户选择与实际加载情况分开显示；父目录信任/显式拒绝正确继承。 |
| M31-P-07 | 起始--approve不自动信任后续新项目，宿主从不生成--approve；global project_trust extension否决已记住的信任时界面不显示已加载，其余策略按spike决策执行并有测试。 |
| M31-P-08 | 原启动相对-e/skill/template/theme解析不漂移；初始prompt/@file不重放；项目sessionDir与显式--session-dir各按约定处理；同一会话重建不重放--model/--thinking；项目面板标明环境来自起始终端。 |
| M31-P-09 | 回复/队列/待答对话框期间禁止项目切换；第二浏览器竞争切换只有一个成功，旧generation请求拒绝。 |
| M31-P-10 | 目标会话已有live锁时，旧项目保持可用；预留目标后取消只清自身锁；普通TUI行为保持M3约定。 |
| M31-P-11 | 计划重启旧child不会关闭Hub；任何时刻最多一个已激活writer；启动门前后注入宿主崩溃无孤儿写进程。 |
| M31-P-12 | 目标启动失败、扩展throw、目标cwd消失、只读query超时、锁争用、关闭阶段弹对话框、关闭窗口追加消息条目分别验证；可恢复则恢复，不能则停止且恢复命令正确，无无限重启。 |
| M31-P-13 | Ctrl+C/SIGHUP在每个切换阶段都停止服务/子进程并释放自持锁；终端恢复命令匹配最终实际项目和会话。 |
| M31-P-14 | 桌面与390px移动端创建/打开/切换/取消/失败均可操作；焦点恢复、键盘、无横向溢出；仅填路径不会误向模型发文本。 |
| M31-P-15 | 同一项目被两个web宿主同时添加/修改，不丢registry条目；从列表移除不删主机目录或session文件。 |
| M31-P-16 | 未认证/过期凭据不能列主机目录或创建项目；认证后目录查询不会暴露文件内容；现有workspace预览仍拒绝越界和敏感路径；凭据类目录、agentDir及会话目录（含symlink别名）不能作为项目根。 |
| M31-P-17 | 原生session_before_switch扩展取消在同项目switch保持有效；跨child项目切换的取消语义按最终文档实测，不冒称原生hook等价；扩展命令让子进程自行跨cwd切换时不被静默接受（默认停止服务并给出恢复命令）。 |
| M31-P-18 | 切换前后文本草稿和附件引用按项目/session隔离；旧目录文件引用不会被当新目录同名文件发送。 |

## 9. 尚需主计划明确的产品决策

建议主计划给出默认决定，只有会改变已定架构/使用范围者留评审门，而非把全部问题丢回用户：

- 项目目录浏览入口与允许路径范围；主机拥有者单用户模型是否足够，继续不做多租户权限。
- 首次信任是否支持“仅本次”以及是否提供父目录信任：主计划决定首版两者都不提供；“仅本次”因 --approve 是进程级而无法兑现（P-E19）。
- 跨项目已有会话优先native switch还是child replacement：主计划决定宿主发起的一律走child replacement，扩展veto限制如实公开；OS process.cwd一致性仍由spike验证。
- 目标启动失败后恢复为显式按钮还是一次自动事务恢复（推荐显式）；不能保证空会话extension内存无损。
- 新目录创建成功但启动失败时保留目录/入口（推荐），不要自动删除用户可能已放入文件的目录。
- 临时信任与CLI override在网页会话里何时清除：主计划决定“不加载继续”离开项目即失效，用户原始CLI覆盖只绑定起始项目并随宿主服务结束；它们都不写入pi默认配置。
- 打开已有项目时激活哪个会话：主计划决定默认恢复最后已保存会话，引用失效则进入空会话。
