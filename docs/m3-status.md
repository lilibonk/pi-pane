# M3 首批工作台状态

更新：2026-10-09，Asia/Shanghai。实现分支：`codex/m3-workbench`。

本批 M3-A 与核心 M3-B 第一增量已完成验收：把当前会话镜像扩展为工作区/会话导航、中央对话及文件/Git/资源面板，并为每个入口接真实 pi 或工作区能力。源码尚未发布，日常仍使用 `npm:@lilibonk/pi-pane@0.1.0`；本文件不改变 0.1.0 的发布、正式安装或真实模型验收结论。一轮慢流重连验收超时仍待定位，本批通过不等于长期稳定或整体 M3 完成。

参考基准仍为维护者指定的官方当前 Kimi Code：`@moonshot-ai/kimi-code@2.1.1`，官方 commit `242ac230006447f8601e1678c49182bfbae89fe9`。实测截图、构建资源和服务端源码的核对记录位于 `build-artifacts/kimi-alignment/current/`。本批覆盖工作台结构与部分操作闭环，整体 Kimi 对齐仍未完成。

## 功能映射

| 范围 | 当前源码接入 | 真实后端与边界 | 本批状态 |
|---|---|---|---|
| M3-A 工作台结构 | 左侧工作区/会话，中间当前对话/输入，右侧改动/文件/资源；移动端抽屉 | 保留已有历史、工具、图片、主题、followUp/steer、中止；面板有读取、空态、错误与重读状态 | 第一增量已验收，含桌面/移动端 |
| M3-B 会话目录与搜索 | 按 cwd 分组、搜索、新建、恢复；搜索包括后续消息文本 | `SessionManager.list/listAll`；恢复只使用已发现 ID，最多 200 条历史元数据，必要可补当前会话；跨工作区须由宿主重建 cwd/运行时 | 第一增量已验收 |
| M3-B 分支与分叉 | 分支树、从消息分叉、返回历史节点 | fresh `ExtensionCommandContext` 调用 native fork/tree；用户节点导航到其父节点并恢复文本，已有草稿保留；不恢复图片 | 第一增量已验收 |
| M3-B slash/skill/template | 宿主目录发现、菜单、明确选择与分派、内建选择器 | `pi.getCommands`；普通 `prompt` 仍为字面输入，匹配已发现的命令才明确展开；注册项只确认分派，未适配内建命令提示去终端 | 第一增量已验收 |
| M3-B 文件上下文 | `@` 搜索、文本预览、引用到输入框 | 从当前工作区读取真实 UTF-8 内容；预览最多 256 KiB，单次引用最多 24 KiB，整条消息最多 64 KiB；显示截断并可发送前检查 | 第一增量已验收 |
| M3-B Git 成果 | 实际状态、暂存/未暂存/未跟踪差异、文件与 diff 切换 | 有界只读 Git 查询；要求 cwd 为仓库根目录；不拿对话工具 patch 充当当前仓库状态 | 第一增量已验收 |
| M3-C 部分资源概览 | 已配置模型、工具启用状态、命令分类、可用/待接入能力；模型选择与 thinking | 宿主 registry、getAllTools/getActiveTools；模型选择调用 setModel，thinking 使用现有宿主 API；仅展示必要元数据 | 概览与模型选择已验收；资源配置仍待做 |
| M3-C 交互决策与任务 | 标明标准对话框、认证和资源管理的能力边界 | select/confirm/input/editor 与审批仍需终端；Plan/Goal/Agent 尚未定义 pi 执行语义 | 未完成 |
| M3-D 交接与恢复 | 保留现有 TUI + 网页镜像 | 关闭终端后服务终止；未新增后台 host、attach、所有权移交或崩溃恢复 | 未开始 |

会话的重命名、置顶、完成/归档、导出，以及工具/扩展/MCP 的安装、启停与持久配置尚未接入网页。当前资源面板提供概览，不能当作完整设置页。持久文件树、交互终端与独立 MCP 配置 GUI 没有在基准 Kimi `/web` 中确认，不能用未经确认的参考功能推定本批验收范围。

跨工作区目录只来自公开宿主 context：默认会话根目录加本进程最近访问的最多 32 个目录（LRU），网页不能指定任意目录。当前 pi 进程内 stop/重新启动 `/web` 保留这些已访问目录；重启 pi 后只重新发现默认与当前目录。自定义目录下从未访问过的会话仍需先在终端恢复。

## 操作一致性

新增会话命令共用现有版本信封与去重机制，校验 epoch、sessionId、branchRevision。扩展通过限时、一次性 nonce 获取本次 fresh command context；不缓存旧 context。运行、待发消息、切换或终端对话框期间不执行会话切换，生命周期替换取消尚未进入宿主的请求。

浏览器验收发现 new 到新会话 prompt 之间存在跨 Bridge 空窗：旧 Bridge 已替换而宿主切换尚未完成时，另一客户端仍可能提交消息。已补跨 Bridge 的进程级写屏障与 `StateView.mutating`，操作结束前所有客户端禁用输入提交并保留未发送草稿；宿主层独立拒绝竞争 prompt。真实 TUI 延迟切换检查和浏览器实际提交均已验证：pending new 时 Enter 不提交，草稿保留；完成后只有一条用户消息及一条回复，无孤立回复。

`dispatched` 仍只确认已交给 pi。会话 new/resume/fork/tree 另返回实际观测的完成、失败或取消；结果归属原命令，取消在网页显示为取消。树导航文本仅为本次现场操作恢复一次，并核对目的 session/branch；旧回执查询只能供人工恢复，不自动覆写草稿。普通消息与注册命令/skill/template 不伪造已入队或成功的结果。

pi 当前公开注册 API 没有隐藏命令标志，因此随机内部网关可能出现在终端 autocomplete；网页目录过滤它，没有效 nonce 的调用不执行操作。认证、扩展管理及交互确认仍需终端完成。

工作台读取使用独立 reqId，不消耗写命令编号或投影 seq。读操作前后均校验会话版本，替换后丢弃迟到结果；每连接最多 8 个、全局最多 16 个在途读操作。网页超时可重读，断线后不自动重放用户写操作。

## 验证与证据

当前开发依赖固定为 pi / pi-ai 1.1.0；运行环境为 Node 24.20.0、macOS arm64。所有本批集成使用真实 pi TUI（PTY）和真实 WebSocket，provider 为无网络请求的本地确定性夹具，远程模型调用为 **0**。M2 的 Qwen3.7 Max 真实模型通过记录属于已发布 0.1.0，不能替代新增 M3 流程验证。

| 检查 | 当前结果 | 证据 |
|---|---|---|
| 类型检查与构建 | 最终源码通过 | `npm run typecheck`、`npm run build` |
| 完整单元测试 | 92/92 通过 | `npm test`，协议、Hub、命令网关、会话目录、工作区边界、写屏障与草稿恢复等 |
| 已有真实 TUI smoke | 21/21 通过，本地确定性 provider | `build-artifacts/m3/smoke/smoke-report.json` |
| M3 工作台真实 TUI/WS | 最终独立复跑 15/15 通过，竞争 prompt 无额外 provider 调用，新会话历史为空 | `build-artifacts/m3/workbench/report.json` |
| 桌面与移动端浏览器 | CUA 22 项通过，consoleErrors 为 0 | `build-artifacts/m3/workbench/browser-report.json` |
| 验证汇总与清理 | 验收包装进程退出、端口关闭、临时工作区/访问文件移除、浏览器页关闭、视口覆盖重置均确认 | `build-artifacts/m3/workbench/validation.json`、`cleanup.json` |

M3 集成检查覆盖目录/能力、文件边界、实际 Git diff、命令一次分派、普通 slash 字面输入、模板/skill 展开、双客户端新建/恢复、取消、跨工作区、fork/tree、跨 epoch 去重/回执查询，以及运行中拒绝切换和重连。首轮树节点断言按 pi 的用户消息父节点导航语义修正，原失败报告保留为 `report-first.json`。随后跨工作区复跑发现默认 listAll 不扫描自定义会话目录；现已合并从公开 context 获取的有界已访问目录，并增加目录回归，集成已证明可恢复原工作区，原证据保留为 `report-custom-session-first.json`。

原 14 项通过没有覆盖 new 的跨 Bridge 切换空窗，报告保留为 `report-before-write-barrier.json`。新增第 15 项以真实宿主延迟切换 500 ms，证明另一 viewer 的竞争 prompt 返回 busy、provider 调用不增加，随后新会话可正常操作；最终 15/15 通过。浏览器同时检查提交禁用与草稿保留，原缺陷记录为 `browser-first.json`、`browser-session-race-first.png`。写屏障新增的即时 mutating 事件也纳入原 stale-model 回归：分派前状态事件有效，generation 替换后旧回调不新增事件。

CUA 验收覆盖 1280px 桌面、843px 面板抽屉和 390px 移动端；实际操作 Git diff、文件内容引用、slash/skill、资源与模型切换、跨 cwd 会话、tree/fork/取消、pending new 写屏障，以及运行中刷新后最终完整输出各一条、无重复。已修正空正文 system 节点的无效展示与字符串正文投影，节点使用中文名称；成功选择器/分派清除旧提示。最终源码截图为 `browser-desktop.png`、`browser-resources.png`、`browser-mobile.png`、`browser-mobile-files.png`。

**待定位：慢流重连的一次验收超时。** 一轮并行复跑在最后 slow reconnect 的 settled 等待超时，记录为 `report-reconnect-first.json`；当时未保留足够 provider/client 原始证据，不能归因为并行负载。同一代码的独立复跑 15/15 通过，实际浏览器 midstream 刷新也完成且无重复；这些结果没有定位此前超时的根因。脚本已增加失败时 `failure-terminal`、`failure-events`、`failure-clients` 诊断落盘，后续继续追踪并再现，不据本批通过声称完全稳定。

文件测试覆盖路径穿越、工作区外符号链接、二进制/无效 UTF-8、超限截断；Git 测试覆盖空仓库、暂存/未暂存/删除/重命名/未跟踪、带空格及 pathspec 字符的文件名，并验证仓库过滤器不会被执行。测试目录、HOME、agent/session 配置和 Git 仓库均为任务临时资源，不读取日常凭据，不替换日常 npm 安装。

复现命令：

```sh
npm ci
npm run typecheck
npm test
npm run build
PI_M0_EXTENSION=./dist/extension/index.js npm run m3:workbench
```

`PI_M3_REPORT_DIR` 可改变证据目录。`node scripts/m3-workbench.mjs --serve` 在通过集成检查后保留临时 TUI 供实际浏览器验收，私有 `access.json` 权限为 0600；结束时清理进程、连接、临时目录与访问文件。浏览器步骤另验收，不以 WS 检查通过推定 UI 通过。

## 下一批

1. 用新增 M3 源码走真实 provider 试用，并追踪慢流重连超时；保留失败与复跑证据，收敛后再考虑源码版本升级与新 npm 发布。
2. 推进 M3-C：真实设置/认证与资源配置写入、扩展/工具/MCP 状态与 reload，标准对话框/审批的请求响应及取消/超时/重连；定义 Plan/Goal/Agent 在 pi 上的对应语义。
3. 推进 M3-D：按能力缺口选择 host，验证唯一写入者、真实关闭终端后存活、接入/交还、崩溃恢复和失败回滚。
4. 日常 0.1.0 的一周反馈与 gallery 收录继续并行记录；短试用和本地回归通过均不等于长期稳定。
