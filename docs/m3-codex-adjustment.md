# M3 调整说明（交给 Codex）

日期：2026-10-09。来源：维护者决定 + `spike/m3-handoff` 原型。本文改变 M3 的后端方向，取代 `codex/m3-workbench` 中 M3-D 的原定义，以及本仓库早先未跟踪的 `docs/handoff-codex.md`（已过时）。

## 1. 为什么调整

维护者确认：当前 pi-pane 的 `/web`（TUI 与网页并行的镜像）不符合预期。`/web` 应当与 **Kimi Code 2.1.1** 的 `/web` 一致：把当前会话**交给浏览器**。

- TUI 正常退出。
- 同一进程留在前台，作为网页服务继续运行；浏览器可以浏览、打开、新建会话。
- Ctrl+C 停止服务，会话交还终端。
- 关闭终端时服务随之结束。它**不是**“关闭终端后存活”的后台服务。

参照的 Kimi 源码与行为分析见 `docs/m3-handoff-spike.md` 的“Kimi 的参照行为（Kimi Code 2.1.1）”和“与 Kimi 2.1.1 的剩余差异”。

## 2. 已定事项（维护者已确认）

1. **后端改为交接模式**：
   - 交接后由一个 `pi --mode rpc` 子进程持有会话，它是唯一写入者。
   - 前台宿主沿用现有 Hub、Bridge 和网页。
   - 这取代 M3 中的“镜像 + 内部命令网关”路线。
2. **交接前要求空闲**：回复进行中或有排队消息时拒绝交接，不像 Kimi 那样中止进行中的回合。
3. **外部访问沿用 M2**：HTTPS 或代理 + 密码 + 二维码，不做类似 Kimi `/remote-control` 的云中继。
   - 交接后终端里没有 TUI，横幅会直接打印外部链接、密码提示和二维码。
   - 交接后无法执行 `/web --rotate`。撤销访问只能 Ctrl+C 停止服务。
4. **对齐基线不变**：`@moonshot-ai/kimi-code@2.1.1`，与 `docs/design.md` 一致。

## 3. 参考实现：`spike/m3-handoff`

- **分支与提交**：`spike/m3-handoff`，基于 `main` 9bbc5fa；提交 `b3c49a4`、`fa264b6`、`9dc7995`。本机 worktree 在 `../pi-desktop-spike`。
- **验收**：
  - 真实 TUI + PTY + Chrome 共 8 项，全部通过。脚本 `scripts/m3-handoff-spike.mjs`，报告在 `build-artifacts/m3-spike/report.json`。
  - 同一 worktree 回归：单元 64/64、smoke 21/21、浏览器 10/10、M2 外部访问 6/6。

| 文件 | 作用 |
|---|---|
| `src/extension/rpc-child.ts` | 用**当前运行的 pi** 的 `rpc-entry` 启动子进程。负责 JSONL 请求与响应关联、扩展 UI 应答，以及有序停止（关闭 stdin → SIGTERM → SIGKILL）。宿主崩溃时，子进程因 stdin 关闭而自行退出 |
| `src/extension/rpc-session.ts` | `RpcSessionMirror`：把 RPC 的增量事件重建成完整消息，缓存条目、状态和模型，并向现有 Bridge 提供同步的 `ExtensionContext` / `ExtensionAPI` 子集 |
| `src/extension/handoff.ts` | `HandoffHost`：会话列表、新建和切换（RPC），对话框转发，换会话时重建 mirror 和 Bridge。`childArgs()` 过滤启动参数 |
| `src/extension/index.ts` | `/web handoff`：空闲检查 → `installExitTakeover` 拦截第一次 `process.exit` → `runHandoff` 处理横幅、二维码和信号 |
| `src/extension/hub.ts` / `src/protocol/index.ts` | `HostHandler`：`host_read`、`host_*` 命令、`ui_request` / `ui_response` / `ui_resolved`，快照中加 `caps.host` |
| `src/web/main.tsx` / `store.ts` / `style.css` | 原型版会话面板和扩展对话框 |
| `scripts/pty-host.py`、`scripts/m0-smoke.mjs` | 可选的 `controllingTty` 模式（真实 Ctrl+C 和关闭终端），默认关闭，旧测试不受影响 |
| `tests/fixtures/handoff-fixture.ts` | 记录会话和 shutdown 证据；提供 `/m3-confirm` 对话框 |

原型代码只用于证明可行，**不是**可以直接发布的实现；下面第 4、5 节是需要补齐的内容。

## 4. `codex/m3-workbench` 的逐项处理

原则：工作台的界面和只读查询保留；会话写操作改由交接宿主串行执行；只为镜像存在的机制删除。

| 现有内容 | 处理 | 说明 |
|---|---|---|
| 工作台布局、移动端抽屉、`style.css`、`workbench.tsx` | **保留** | 原型的 `SessionsPanel` 用 Codex 的左侧会话导航替换 |
| `draft-recovery.ts` 与测试 | **保留** | |
| `src/extension/workspace.ts`（文件、Git 只读查询） | **保留并修改** | 根目录必须跟随**当前会话的 cwd**。原型固定使用交接时的 cwd，切换到其他项目的会话后会错 |
| `protocol/workbench.ts`、Hub 的 `workbench_query`（并发上限、前后版本校验） | **保留，作为唯一读取协议** | 原型的 `host_read: "sessions"` 并入 `workbench_query`，不要同时保留两套 |
| 会话目录（按 cwd 分组、搜索、最近访问目录 LRU、只接受已列出的 ID） | **保留，移到宿主进程** | 宿主直接调用 `SessionManager.list/listAll`，不需要 ctx。原型已合并当前会话目录，并在 `listAll()` 不扫描自定义目录时补上 |
| `session_new` / `session_switch` | **改用 RPC** | 改为 `new_session` / `switch_session {sessionPath}`，成功后重建 mirror 和 Bridge（见 `HandoffHost.command`）。回执直接用 RPC 结果（`cancelled`） |
| `session_fork` | **改用 RPC** | 改为 `fork {entryId}`，只能从用户消息分叉。返回的 `text` 放回输入框。`position: before/at` 按 pi 的 RPC 语义重新定义 |
| `session_tree`（在同一会话内回到历史节点） | **交接模式下禁用** | RPC 没有 tree 导航。入口保留，显示原因；作为上游缺口提出（见第 6 节） |
| 内部命令网关（`pi-pane-internal-<uuid>` + nonce）、跨 Bridge 写屏障、`StateView.mutating`、Hub 的 `sessionMutation` 回执例外 | **交接模式下删除** | 会话写操作只在宿主执行，按顺序进行，不需要网关和写屏障。如果维护者保留镜像模式，建议镜像冻结在 0.1.0 的功能范围，不再给镜像加会话写操作，避免维护两条路径 |
| 命令目录（`pi.getCommands`） | **改用 RPC `get_commands`** | 名称冲突提示和来源分类保留 |
| 普通 prompt 按原文提交、匹配到命令时再明确展开、`picker_required` | **改写** | RPC `prompt` **总会**展开扩展命令、skill 和模板，与终端一致（Kimi 也是如此）。但 `/new`、`/model`、`/tree`、`/resume` 等 **pi 内置交互命令不会被 RPC 处理，会当成普通文本发给模型**。网页必须拦截内置命令名，转到对应的工作台入口（沿用 Codex 已有的 `browserAction` 映射），无法映射的提示“交接模式不支持” |
| 资源面板：模型、thinking | **改用 RPC** | `get_available_models`、`set_model`、`set_thinking_level`、`get_available_thinking_levels` |
| 资源面板：工具列表和启用状态 | **交接模式下缺失** | RPC 没有工具查询（无 `getAllTools` / `getActiveTools`）。暂时显示“不可用”，见第 7 节的开放问题 |
| `caps.terminalDialogs: true`（对话框只能在终端处理） | **替换** | 改用 RPC 扩展 UI 子协议，在网页里弹出 select / confirm / input / editor（原型的 `DialogView`）。还要补上 `notify` 以外的请求：`setStatus`、`setWidget`、`setTitle`、`set_editor_text`，以及超时和取消 |
| `promptReceipt: "dispatch_only"` | **改进** | 原型丢弃了 RPC `prompt` 的结果。正式版把结果映射为 `started` / `queued` / `handled`，失败返回错误 |
| Codex 的 `m0-smoke.mjs` 改动（`HOME`、`loadSkills`、`loadPromptTemplates`） | **合并** | 与原型的 `controllingTty` 不冲突，需要手动合并 |
| `docs/design.md` 中的 M3-D（“真实关闭终端后存活”、attach、所有权移交） | **改写** | 新定义：Kimi 式交接、唯一写入者、Ctrl+C 交还、关闭终端时退出、宿主崩溃不留第二个写入者 |

## 5. 正式实现还要补齐的内容

1. **命令**：`/web` 默认交接；原型的 `/web handoff` 去掉。镜像是否保留为 `/web --mirror` 由维护者决定（见第 7 节）。`--web` 启动参数的语义随之确定。
2. **会话文件锁**：宿主为当前会话加锁并检测冲突（例如另一个 TUI 打开同一会话），防止出现两个写入者。pi 本身没有锁。
3. **子进程崩溃策略**：目前子进程一退出，宿主就停止服务并打印恢复命令。需要决定是否自动重启一次，并保证不出现两个写入者。
4. **会话面板状态**：切换会话后“当前”标记要自动刷新（原型需要手动刷新）；重命名（RPC `set_session_name`）和 clone 的入口。
5. **跨工作区**：工作区文件和 Git 查询、横幅、恢复提示都跟随当前会话的 cwd。
6. **回归**：交接模式下的 abort、steer、followUp、模型和 thinking 切换、压缩、图片、分页历史、慢流重连。Codex 记录的“慢流重连超时”在交接模式下重新跟踪。
7. **启动参数**：`childArgs()` 是根据 `process.argv` 过滤出来的；用初始提示词启动的 TUI 无法可靠区分位置参数（见第 6 节缺口 2）。至少要覆盖常见参数并补单元测试。
8. **可选项**：横幅补上 `Stop: Ctrl+C`；token 持久化，让重启后 URL 不变（Kimi 是这样做的）；网页上的“轮换凭据”按钮（外部访问时，交接后只能这样撤销）。
9. **Windows**：没有验证。退出拦截和信号的行为需要单独确认，否则文档注明不支持。

## 6. 上游缺口（建议向 pi 提出）

1. 没有“退出后接管”的公开钩子，类似 Kimi 的 `setExitForegroundTask`。目前只能拦截 `process.exit`。
2. CLI 参数解析器没有导出。需要导出 `parseArgs`，或者提供“用当前配置启动 RPC 宿主”的方法。
3. RPC `prompt` 无法按原文提交（没有 `expandPromptTemplates: false` 选项）。
4. RPC 没有 tree 导航命令。
5. RPC 没有工具列表和工具启停命令。
6. `SessionManager.listAll()` 不扫描自定义会话目录。

## 7. 待维护者确认

1. **镜像模式**：保留为 `/web --mirror`（冻结在 0.1.0 功能范围），还是移除？
2. **工具列表和 tree 导航**：等上游支持，还是在子进程中由 pi-pane 扩展开一条私有通道补上？这条通道未经原型验证，需要先做 spike。

## 8. 建议的执行顺序

1. 先在 `codex/m3-workbench` 提交当前工作，保留证据。然后从它新建分支，合并 `spike/m3-handoff`。
   - 预计在 `hub.ts`、`protocol/index.ts`、`index.ts`、`main.tsx`、`store.ts`、`m0-smoke.mjs` 有冲突。
   - 两边都已把开发依赖升到 pi 1.1.0。
2. 统一协议：`workbench_query` 作为唯一读取通道；会话写命令进入 `HandoffHost`；删除网关和写屏障（或仅限镜像模式）。
3. 迁移工作台：会话导航、命令目录、内置命令拦截、资源面板，以及跟随当前会话 cwd 的文件和 Git 面板。
4. 对话框完整化，再做第 5 节的锁、崩溃策略、面板状态和回归。
5. 验收：
   - spike 的 8 项转为正式脚本；
   - `m3-workbench` 的检查改在交接模式下运行；
   - 桌面和移动端浏览器 CUA；
   - 最后用新源码做一次真实模型试用，再考虑发布。发布由维护者执行。
6. 更新 `docs/design.md`（M3 定义和验收矩阵）、`docs/m3-status.md`、`README.md`、`tests/README.md`。

## 9. 约定（沿用）

- 提交身份 `lilibonk` 只写在仓库本地 `.git/config`，不改全局配置。
- npm 发布由维护者执行。
- 测试使用临时 HOME 和 agent 目录、本地确定性 provider，不读取日常凭据，不替换日常安装的 0.1.0。
