# M3 Spike：Kimi 式 `/web` 交接

日期：2026-10-09（Kimi 参照已按 2.1.1 重新核对）。分支 `spike/m3-handoff`（worktree `../pi-desktop-spike`，基于 `main` 9bbc5fa，开发依赖 pi 1.1.0）。目的：验证 pi-pane 能否像 Kimi Code 的 `/web` 一样，把当前会话**交给浏览器**，并以此决定 M3 工作台建立在哪种后端上。

**结论：可行。** 只用 pi 的公开能力（外加一处进程退出拦截）即可实现与 Kimi 等价的交接，且现有 Hub、Bridge、网页无需重写即可复用。7 项真实 TUI + Chrome 检查全部通过。建议 M3 以交接模式为基础，见文末。

## Kimi 的参照行为（Kimi Code 2.1.1）

基线与 `docs/design.md` 一致：`@moonshot-ai/kimi-code@2.1.1`。来源：本机 `~/.kimi-code/bin/kimi`（`--version` 为 2.1.1）内嵌源码，与官方仓库标签 `@moonshot-ai/kimi-code@2.1.1` 及 commit `242ac23` 的 `apps/kimi-code/src/tui/commands/web.ts` 逐字一致。另核对了 `src/cli/sub/web/run.ts`、`shared.ts`、`packages/kap-server/src/start.ts`、`packages/remote-control/`、TUI 的 `stop()` / `onExit` 和斜杠命令注册。

**`/web`**（`availability: "always"`，回复进行中也可使用）：

1. 没有当前会话时报错。
2. `startNewServerAfterExit(host, sessionId)` 通过 `host.setExitForegroundTask(...)` 登记退出接管，然后 `host.stop()`。
3. `stop()` 关闭 TUI：关闭当前会话（进行中的回合随之结束），清空排队消息，关闭 harness，恢复终端。
4. `onExit` 打印 `Bye!` 和 `To resume this session: kimi -r <id>`，然后**不调用 `process.exit`**，改为等待登记的前台任务。
5. 前台任务在**同一进程**里启动多会话的 `kimi web` 服务，选项固定为 `parseServerOptions({})`：
   - 只绑定本机 `127.0.0.1`，默认端口 58627，端口被占用就逐个加一，最多 100 次，因此可以和其他 Kimi 实例共存。
   - token 取自持久化的 `<KIMI_CODE_HOME>/server.token`（0600），重启后 URL 不变。
6. 服务就绪后打印就绪横幅（本机地址、`Network: off`、token、`Stop: Ctrl+C`）和 `Session:` 深链接 `/sessions/<id>#token=…`，并打开浏览器。
7. 前台服务只处理 SIGINT/SIGTERM：关闭服务后 `process.exit(0)`，**不会再打印恢复提示**。关闭终端时由 SIGHUP 的默认行为终止进程。它不会在终端关闭后继续运行，也不是镜像。

**和 0.38.0 相比**，`/web` 本身只多了错误处理和横幅细节，主体没变。周边的变化有：

- **新增 `/remote-control`（别名 `/rc`）和 `kimi web --rc`**：
  - 交接方式和 `/web` 相同，额外通过 Kimi 云中继 `https://code-rc.kimi.com` 把本机服务转发出去，需要 Kimi OAuth 登录；
  - 只允许本机绑定，不能和 `--dangerous-bypass-auth` 同时使用；
  - 每个数据目录只能有一个隧道（锁文件）；
  - 网页可以通过 `GET/POST /api/v1/remote-control` 开关；
  - 终端打印二维码，同时生成 PNG。
- **`--allow-remote-terminals` 被移除**：PTY 终端路由只在本机绑定时可用。
- kap-server 新增问答（questions）、文件历史、配置变更推送和 v2 MCP 路由，会话与 Web 资源的托管方式不变。网页资源内嵌在二进制里，首次启动时解压到缓存目录。

## 原型做法

```
pi 进程（同一终端）
 1. /web handoff：要求空闲且无待发消息；记录会话文件、会话目录、cwd、启动参数、主题；
    确保 Hub 在运行；安装“退出接管”；ctx.shutdown()
 2. pi 正常关闭：停止 TUI → 所有扩展的 session_shutdown → 销毁会话 → 打印 pi 自己的恢复提示
    （pi-pane 在此不关闭 Hub，只挂起，URL 与 token 不变）
 3. pi 调用 process.exit(0) 时被拦截一次 → 前台宿主：
      子进程：node <正在运行的 pi 的 rpc-entry> <原参数去掉 --web*/会话选择> --session <文件>
              = pi --mode rpc，使用 CLI 自己的运行时工厂（设置、信任、认证、内置扩展），是唯一写入者
      RpcSessionMirror：把 RPC 的增量事件重建成完整消息，缓存条目/状态/模型，
              对现有 Bridge 提供同步的 ExtensionContext 子集 → 原有快照/增量/分页/图片协议不变
      HandoffHost：会话列表（SessionManager.listAll）、打开/新建会话（RPC switch_session/new_session，
              换会话时重建 mirror + Bridge，浏览器收到 session_reset）、扩展对话框转发到浏览器
 4. Ctrl+C / SIGTERM / SIGHUP：停子进程 → 关 Hub → 打印 `pi --session <浏览器最后所在会话>` → 退出
```

新增文件：`src/extension/rpc-child.ts`、`rpc-session.ts`、`handoff.ts`；`hub.ts` 增加 `HostHandler`（`host_read`、`host_*` 命令走原有去重回执、`ui_response`、`ui_request/ui_resolved` 广播、快照 `caps.host`）；网页增加会话面板与对话框；`pty-host.py` 增加可选的“受控终端”模式（真实 Ctrl+C / 关闭终端）。

## 验证（`scripts/m3-handoff-spike.mjs`，真实 pi TUI + PTY + 系统 Chrome，本地确定性 provider，真实模型调用 0）

| # | 检查 | 结果 |
|---|---|---|
| 1 | `/web handoff` 后 TUI 正常关闭（扩展收到 `session_shutdown: quit`），进程保持；RPC 子进程打开同一会话；浏览器同一 URL 继续显示原历史 | 通过 |
| 2 | 浏览器提交在子进程执行并流式返回；活动消息与持久化消息合一，无重复气泡 | 通过 |
| 3 | 浏览器输入 `/m3-confirm`，扩展的 `ctx.ui.confirm` 弹到网页，确认结果回到扩展（`mode: rpc`） | 通过 |
| 4 | 会话面板列出各项目会话（含自定义会话目录），打开较早的会话并在其中继续对话 | 通过 |
| 5 | 终端 Ctrl+C：子进程与服务退出，退出码 0，提示 `pi --session <最后所在会话>`；两个会话文件的父链完整、叶子分支包含全部提示；`pi --session` 能读到浏览器写入的回合 | 通过 |
| 6 | 关闭终端（PTY 关闭 → SIGHUP）：宿主与子进程都退出 | 通过 |
| 7 | 宿主被 SIGKILL：子进程因 stdin 关闭在数秒内退出，不会留下第二个写入者 | 通过 |
| 8 | 外部访问（本机 TLS 反向代理 + `PI_PANE_PASSWORD`）：登录后交接，浏览器无需再次登录、提交在子进程执行；交接横幅给出外部链接、密码提示和终端二维码；新访客即使持有链接仍需输入密码；Ctrl+C 后端口关闭 | 通过 |

回归（同一 worktree）：单元 64/64，smoke 21/21，真实 Chrome 10/10，M2 外部访问 6/6。截图：`build-artifacts/m3-spike/handoff-browser.png`。

## 与镜像 + 命令网关方案（`codex/m3-workbench`）对比

| 问题 | 镜像 + 网关 | 交接 + RPC 子进程 |
|---|---|---|
| 网页切换会话 | 内部 slash 命令 + 一次性 nonce 获取 fresh command context；终端会话被一起切换 | RPC `switch_session/new_session`，直接 |
| 跨 Bridge 写屏障 | 需要（new 期间另一客户端可提交） | 不需要：只有一个前端家族，命令在宿主串行 |
| 扩展对话框 | 只能去终端 | 官方 RPC UI 子协议 → 网页（select/confirm/input/editor） |
| 跨工作区 | 需宿主重建 cwd，未访问目录需先回终端 | RPC 运行时替换会话即重建该会话的服务 |
| 终端 | 与网页并行 | 交接期间无 TUI；Ctrl+C 交还 |
| 关闭终端 | 服务结束 | 服务结束（与 Kimi 一致） |
| 提交回执 | `dispatched` | RPC 返回 `started/queued/handled`，可更诚实 |

工作台中与后端无关的部分（文件/Git 只读查询、布局、移动端抽屉、命令目录展示、草稿恢复）在交接模式下照样可用；命令目录改用 RPC `get_commands`。

## 发现的缺口（需上游或后续设计）

1. **没有“退出时接管”钩子**：只能拦截 pi 的 `process.exit`。时序正确（一切关闭后才接管），但属于依赖实现细节。建议向 pi 提议等价于 Kimi `setExitForegroundTask` 的公开 API。pi 先打印自己的“To resume this session”再出现交接横幅，这个顺序和 Kimi 2.1.1 相同，不算缺陷。
2. **CLI 参数解析器未导出**：子进程参数由 `process.argv` 过滤得到；以初始提示启动的 TUI（位置参数）无法可靠区分。建议上游导出 `parseArgs` 或提供“以当前配置启动 RPC 宿主”的方法。
3. **RPC `prompt` 总是展开 slash/模板/skill**：交接模式下网页输入与终端输入语义相同（与 Kimi 一致），不再是 0.1.0 的“字面提交”。界面已提示；如需字面输入需上游选项。
4. **RPC 没有 `/tree` 导航**（有 `fork`、`clone`、`get_tree`）：交接模式下分支切换只能先做 fork；需上游命令或另行设计。
5. **`SessionManager.listAll()` 不扫描自定义会话目录**：已合并当前会话目录的列表。
6. **消息身份对应**：RPC 的事件与条目是不同对象，按角色 + 时间戳把持久化条目换回同一对象；同一毫秒同角色的两条消息理论上可能错配（未观察到）。
7. 扩展的 TUI `custom()` 组件在 RPC 模式不可用（pi 文档已声明）。
8. pi 没有会话文件锁：交接期间若另开一个 TUI 打开同一会话，会出现两个写入者——与今天开两个 TUI 的风险相同，可在宿主加文件锁检测。

## 与 Kimi 2.1.1 的剩余差异

| 项 | Kimi 2.1.1 | 原型 | 建议 |
|---|---|---|---|
| 命令 | `/web` | `/web handoff`（`/web` 仍是镜像） | 正式版 `/web` 即交接，镜像移除（已决定） |
| 回复进行中 | 可以用，进行中的回合随会话关闭而结束，排队消息丢弃 | 要求空闲且没有排队消息 | **已决定**：保留空闲要求，不像 Kimi 那样中止进行中的回合 |
| 交接后的服务 | 多会话的 `kimi web`，覆盖全部工作区 | Hub + 单个 RPC 子进程；会话列表覆盖各项目，一次只打开一个会话 | 多会话同时运行不在 M3 范围内 |
| 绑定与端口 | 固定 `127.0.0.1`，58627 被占用时逐个加一 | 沿用 Hub：默认 `127.0.0.1:7878`，被占用时逐个加一（已一致） | 已一致；外部访问参数在交接后继续生效（检查 8） |
| token | 持久化 `server.token`，重启后 URL 不变 | 沿用 Hub 当前 token（交接前后不变，重启 pi 后会变） | 可选：持久化 token |
| 横幅 | 就绪横幅 + `Session:` 深链接，打开浏览器 | 交接横幅 + 打开浏览器 | 可以补上 URL 与 `Stop: Ctrl+C` |
| Ctrl+C | 关闭服务，不打印恢复提示 | 关闭服务，打印 `pi --session <最后所在会话>` | 保留：浏览器里可能切换过会话，这条提示有用 |
| 关闭终端 | SIGHUP 默认终止 | 捕获 SIGHUP，有序关闭子进程 | 保留 |
| 外部访问 | `/remote-control` 走 Kimi 云中继 | 无云中继；M2 已有 HTTPS/代理 + 密码 + 二维码 | **已决定**：不做云中继，用 M2 的外部访问对应。交接后没有 TUI 可执行 `/web qr`，因此外部访问时横幅直接打印二维码（对应 Kimi `/remote-control` 的终端二维码）。交接后无法 `/web --rotate`，撤销访问只能 Ctrl+C 停止服务 |

## 原型未处理

会话面板切换后的“当前”标记刷新、重命名/删除/fork 入口、交接模式下的 abort/模型切换细节回归、子进程崩溃后的自动重启、Windows。

## 建议

1. M3 以**交接模式**为后端：`/web` 即交接（与 Kimi 一致）；镜像模式移除（维护者已决定）。工具列表与 tree 导航等上游支持。
2. 将 `codex/m3-workbench` 中与后端无关的部分迁移到交接宿主；会话命令网关与跨 Bridge 写屏障不再需要。
3. 向 pi 上游提出缺口 1–4。
4. 交接模式补齐：外部访问组合、会话列表刷新、fork/clone 入口、宿主侧会话文件锁、子进程崩溃策略，再纳入正式验收矩阵。
