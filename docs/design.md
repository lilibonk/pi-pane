# pi `/web`：设计方案

> 状态：实现对照 v0.4 · 2026-10-09（v0.4：补齐主题背景与派生、按词 diff、thinking 观测耗时；v0.3 修补快照一致性、命令语义、生命周期、安全与验收边界）
> 工作名：`pi-pane`（暂定，发布前核验 npm 名称；备选 `pi-webview` / `pi-mirror` / `pi-web-handoff`）
> 基线：pi `@earendil-works/pi-coding-agent` 1.0.4
> 验证状态：M0、M1 已于 2026-10-08 完成验收（[M0](m0-status.md)、[M1](m1-status.md)）；M2 的本地验收（A9–A11，除 npm 发布与 gallery 收录）见 [M2 验收记录](m2-status.md)。§4 的源码事实与 §13 的运行验证分开管理；当前结果见 [M0 执行计划与跟进](https://chatgpt.com/space/page_6ac66a64d11c8191bbcc2dc63d862e09) 和 [本地验收记录](m0-status.md)。

---

## 1. 背景与目标

pi 的 TUI 很好用，但有些开发者更习惯图形界面：长 diff、长工具输出、图片、手机上看进度。Kimi Code 的做法是在终端里输入 `/web`，**把当前会话交给浏览器继续**。

pi 生态里现在已经有完整的桌面端（pi-gui）和 Web 端（PI WEB、pithagoras、pi-pocket、pi-web-codex），但它们都是**独立应用**：会话要在它们自己的界面里新建或打开。pi-web-codex 虽然有 `/pi-web-codex` 命令，源码里也只是在另一个进程起一个 Web 服务，不会接管当前会话。

**定位**：一个 pi package。终端里输入 `/web`，浏览器就接上**这个正在运行的会话**，终端照常可用。不跟独立 Web 应用比功能多少，只把"从终端到浏览器的接力"这件事做到最好。

### 目标

- G1：`/web` 一条命令打开当前会话，展示完整的当前分支历史及正在生成的内容，后续实时流式同步。参考数据集上，从浏览器 WS 连接建立到首个快照应用完成目标为 1 秒内；浏览器进程启动时间单独记录，超大历史和图片按 §6.5 分块加载。
- G2：浏览器里可以提交消息（运行中可以 steer 或排队）、中止、切模型、调 thinking 等级、贴图片。提交回执与实际执行结果分开显示，纯扩展模式的确认边界见 §6.3。
- G3：终端和浏览器**同时**连在同一个会话上，终端切换会话或分支时网页同步重置。待发队列只同步是否非空，不承诺完整队列内容。
- G4：网页外观沿用用户当前的 pi 主题。
- G5：默认安全：只监听本机，用 token 鉴权，局域网访问需要显式开启。
- G6：`pi install npm:@lilibonk/pi-pane` 一步装好，本机模式零配置；按 pi package 规范发布并核验 gallery 收录。

### 参考实现：Kimi Code（MoonshotAI/kimi-code，MIT，TypeScript）

Kimi 和浏览器相关的能力其实是**两个互不相关的功能**，容易混在一起：

| | `/web`（Web UI） | Kimi WebBridge / Browser Extension |
|---|---|---|
| 浏览器扮演什么 | **界面**：人在浏览器里操作 agent | **工具**：agent 去操作用户的浏览器 |
| 实现 | `apps/kimi-code/src/tui/commands/web.ts` 加上 `packages/kap-server`（基于 Fastify 的 REST + WS 服务） | 本地 daemon（`127.0.0.1:10086`）+ Chrome/Edge 扩展（通过 `chrome.debugger` 走 CDP）+ 一份 skill 文档，教 agent 用 `curl POST /command` 调用 |
| 和 agent 的耦合 | 跟 Kimi 内核深度绑定 | 只是 HTTP 接口加 skill，Claude Code、Cursor、Codex 都能用 |
| 许可 | MIT | 插件和 skill 是 **Proprietary**，daemon 二进制从 Kimi 的 CDN 下载 |

本方案只对标 `/web`。浏览器自动化在 pi 生态里已有其他方案（MCP 形式的 Chrome DevTools / Playwright，pi-pocket 内置的 Chromium），不在本项目范围内。

**Kimi `/web` 的实际行为**（从源码确认）：

- **交接，不是镜像**：`/web` 会先**停掉 TUI**，然后在退出流程里把**同一个进程**变成前台运行的 Web 服务（`setExitForegroundTask` → `startServerForeground`），按 Ctrl+C 结束。浏览器打开的是深链接 `/sessions/<id>#token=…`。
- **token 持久化**：保存在数据目录的 `server.token` 文件里，可以用 `rotate-token` 命令更换；通过 URL 的 `#token=` fragment 传给前端，不会发到服务器，所以不会被记进日志。
- **WebSocket 鉴权**：浏览器的 WebSocket API 不能自定义请求头，所以 token 放在 `Sec-WebSocket-Protocol: kimi-code.bearer.<token>` 里，**握手阶段就鉴权**，没通过的连接根本建立不起来。
- **防护**：Host 白名单（环境变量 `KIMI_CODE_ALLOWED_HOSTS`）、Origin 和 CORS 校验、限流、安全响应头；`--dangerous-bypass-auth` 可以显式关闭鉴权。
- **断线重连**：每个会话有一份事件日志（`sessionEventJournal`），事件带 `seq` 和 `epoch`，写在磁盘上。重连时按 `seq` 补发缺失的事件；`epoch` 用来识别服务是否重启过。
- **多实例**：同时开多个时，通过实例注册表自动占用下一个空闲端口。
- **远程访问**：`/remote-control` 通过 Kimi 云端中继，用设备 ID 加二维码连接，需要云端基础设施。
- 题外话：Kimi Code 的 TUI 用的就是 pi-tui 的 fork（`packages/pi-tui`，`@moonshot-ai/pi-tui` 0.84.5）。

**对本方案的影响**：

1. 我们做"镜像"，比 Kimi 的"交接"多一个卖点：**终端不用退出**。
2. 照搬：token 放 `#fragment`、WebSocket 用 subprotocol 传 bearer、Host/Origin 白名单、限流、深链接、多实例端口自增。
3. 借鉴：事件加上 `epoch`（见 §6.1）；Kimi 那种"同进程交接"作为 M3 的候选实现（见 §12）。
4. 不做：云端中继。

### 非目标（v1 不做）

- 不做独立的 Web 应用：多项目管理、会话列表、文件树、终端面板。这些交给 PI WEB 那类应用。
- 关掉终端后会话继续跑（"交接"模式），放到 M3。
- 云端托管、多用户协作。
- 修改或 fork pi 核心。

---

## 2. 用户体验

### 命令

| 命令 | 行为 |
|---|---|
| `/web` | 服务没起就先启动，然后打开浏览器；已经在跑就直接打开浏览器，并在终端显示 URL |
| `/web stop` | 关闭服务，断开所有浏览器连接 |
| `/web status` | 显示 URL、连接数、监听地址 |
| `/web qr` | 外部访问时以终端 widget 显示公共链接二维码（两分钟后隐藏），链接含 bootstrap token，密码仍单独输入；本机模式拒绝 |
| `/web --rotate` | 换新 token，撤销浏览器认证并断开现有连接；由终端显示新地址 |
| `pi --web` | 启动 pi 时同时启动服务（对标 `kimi web`），通过 `registerFlag` 实现 |

`/web` 参数：`--host <addr>`（默认 `127.0.0.1`）、`--port <n>`、`--no-open`。M2 的非本机访问还需配置 §9 的安全访问地址。启动参数使用命名空间 `--web-host`、`--web-port`、`--web-no-open`，与其他扩展避免冲突。M0 通过公开 `pi.getSettings()` 读取 `settings.json` 的 `piPane { host, port, noOpen }`；优先级为命令参数、启动 flags、宿主合并后的设置、默认值。全局与可信项目的合并由 pi 控制。pi 1.0.4 未提供任意自定义字段的公开写入 API，因此扩展只读，不自动保存；宿主已知字段的保存使用锁与重新读取后合并，不能称为崩溃原子替换。错误配置不得阻止 stop/status/token 更换，配置自身不触发自启动。

默认端口从 7878 起，在最多 20 个端口内查找；显式指定端口时占用即报错，不静默换端口。URL 必须使用实际绑定成功的端口。`--web` 只在进程首次启动时应用一次；`/web stop` 后切会话或 `/reload` 不会再次自动启动服务。M1 只开放回环监听，拒绝非回环配置。

### 典型流程

```
$ pi
> 帮我重构 auth 模块              ← 在终端里正常工作
  …agent 开始改文件…
> /web
  ✓ pi-pane: http://127.0.0.1:7878/#t=Xk3…  （已在浏览器打开）
                                   ← 浏览器显示完整历史，后续输出实时同步
[浏览器] 输入"先别改测试" → steer   ← 终端里也能看到这条消息
[终端]   按 Esc 中止              ← 浏览器状态同步变成空闲
```

终端状态栏通过 `ctx.ui.setStatus` 常驻显示 `🌐 web: 1 viewer`，提醒用户服务还开着。

---

## 3. 总体架构

### 3.1 两种模式

| | **A. 镜像**（v1） | **B. 交接**（M3） |
|---|---|---|
| 进程 | 就是原来那个 pi 进程 | 候选：同进程前台服务，或独立 SDK host；尚未选型 |
| 终端 | 继续可用 | 退出 TUI；重新接入与恢复历史是两种不同操作，见 §12 |
| 关掉终端 | Web 断开 | 只有完成进程分离的后台方案才承诺继续运行 |
| 其他扩展的对话框 | 只能在终端里操作 | SDK host 可适配标准对话框；任意 TUI 自定义组件仍不能直接搬到网页 |
| 实现成本 | 需先验证双端一致性 | 需另做进程所有权与 UI 适配设计 |

v1 只做 A。B 可以复用消息与状态协议，但接入、所有权和对话框能力需要扩展协议及 `caps`，不能只替换后端就认为交接完成。

### 3.2 模式 A 结构图

```
┌──────────────────────── pi 进程（用户原来那个 TUI）─────────────────────────┐
│                                                                             │
│  pi 核心 ── TUI（照常渲染）                                                    │
│     │                                                                       │
│     │ ExtensionAPI（pi）/ ExtensionContext（ctx）                             │
│     ▼                                                                       │
│  ┌─ pi-pane 扩展 ──────────────────────────────────────────────────────┐    │
│  │  Bridge（每次 session_start 重新创建）                                 │    │
│  │   ├─ 订阅事件 → 更新状态投影 → Hub 发布有序增量                         │    │
│  │   └─ 执行命令：sendUserMessage / abort / setModel / …                  │    │
│  │                                                                     │    │
│  │  Hub（进程级单例，挂在 globalThis 上，跨会话切换和 /reload 存活）          │    │
│  │   ├─ node:http：静态资源 + /healthz                                   │    │
│  │   ├─ ws：鉴权、广播、心跳                                               │    │
│  │   └─ 快照发布、命令去重、重绑超时与慢客户端回收                         │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │ WebSocket（默认 127.0.0.1）
                        ┌──────────▼──────────┐
                        │ 浏览器 SPA（预构建）   │  可以同时连多个
                        └─────────────────────┘
```

**拆成两层的原因**：pi 在 `/new`、`/resume`、`/fork`、`/reload` 时会**销毁并重建扩展运行时**，见 §4。网络服务要比单个会话活得久，所以 Hub 放在进程级；会话相关的状态放在 Bridge 里。Bridge 从 `session_start` 起采集实时状态，即使用户还没有运行 `/web`。`/tree` 在原运行时里改变分支，需单独重建状态投影。

---

## 4. 已验证的关键事实（来自 pi 1.0.4 源码和类型定义）

本节以 1.0.4 发布包的 `dist/` 与随包文档为准。可复核的固定版本源码：[扩展类型](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/src/core/extensions/types.ts)、[会话实现](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/src/core/agent-session.ts)、[运行时](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/src/core/agent-session-runtime.ts)、[加载器](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/src/core/extensions/loader.ts)。它们证明 API 语义，不替代双端运行验证。

| # | 问题 | 结论 | 依据 |
|---|---|---|---|
| F1 | 切换会话时扩展会被重建吗？ | **会**。`/new`、`/resume`、`/fork` 都会走 `teardownCurrent()`：先 abort，再发 `session_shutdown`（reason 是 `new`/`resume`/`fork`），然后 dispose，再 `createRuntime()` 重建 | `core/agent-session-runtime.js` |
| F2 | 扩展模块会被重新 import 吗？ | `/reload` 时会。jiti 是用 `moduleCache: false` 加载的，只在 cwd 和 generation 都不变时复用 factory，**所以模块级变量不可靠** | `core/extensions/loader.js` |
| F3 | 官方对长生命周期资源的建议 | 不要在 factory 里起 socket、进程、watcher 或 timer；在 `session_start` 或命令里启动，会话级资源在 `session_shutdown` 幂等关闭。跨会话 Hub 的回收由本方案补充 | `docs/extensions.md` |
| F4 | 流式输出是增量吗？ | 是。`message_update.assistantMessageEvent` 有 `text_delta`、`thinking_delta`、`toolcall_delta`，都带 `contentIndex` 和 `delta` | `pi-ai/dist/types.d.ts` |
| F5 | 工具执行能看到过程吗？ | `tool_execution_start/update/end`，带 `toolCallId`、`args`、`partialResult`，以及嵌套调用的 `parentToolCallId` | `extensions/types.d.ts` |
| F6 | 网页发的消息在终端里怎么显示？ | `pi.sendUserMessage()` 经用户输入流程提交消息，来源为 `extension`，其他扩展仍可转换或消费输入。运行中须指定 `deliverAs: "steer" \| "followUp"`；该 API 返回 `void`，异步失败由宿主报告 | `extensions/types.d.ts`、`core/agent-session.js` 的 `sendUserMessage` 与 `bindCore` |
| F7 | 能拿到主题的具体色值吗？ | **能**。`ctx.ui.theme.colors` 返回具体颜色；终端未报告默认色时会按 `appearance` 估算，并非始终精确等于终端实际色值 | `theme.d.ts`（`get colors()`） |
| F8 | 能知道其他扩展弹了对话框吗？ | 只能知道"有一个"：`ui_prompt_start/end`，带 `kind` 和 `title`。**拿不到选项，也没法替它作答** | `extensions/types.d.ts` |
| F9 | 能区分输入来源吗？ | `input` 事件的 `source` 是 `interactive`、`rpc` 或 `extension` | 同上 |
| F10 | 能读到完整历史吗？ | `ctx.sessionManager`（只读）提供 `getBranch()`、`getEntries()`、`getTree()`、`getLeafId()`、`getSessionName()`；正在生成的消息不在持久化历史中，须由实时投影补充 | `session-manager.d.ts`；`core/agent-session.js` 在 `message_end` 通知扩展后才持久化 |
| F11 | `/tree` 会重建运行时吗？ | 不会；改变 leaf 后发 `session_tree`，没有新的 `session_start` | `core/agent-session.js` 的 `navigateTree()` |
| F12 | 模板展开开关只控制模板吗？ | 不只。`expandPromptTemplates: true` 会先尝试执行扩展命令，运行中也可立即执行，再处理 skill 和模板展开 | `core/agent-session.js` 的 `prompt()` |
| F13 | 能订阅完整队列变化吗？ | `queue_update` 属于 SDK session 事件，不向 `ExtensionAPI.on` 开放；纯扩展只有 `ctx.hasPendingMessages()` 布尔值 | `extensions/types.d.ts`、`core/agent-session.js` 的 `_emitQueueUpdate()` |
| F14 | 其他命令如何确认结果？ | `setModel()` 返回 `Promise<boolean>`；`setThinkingLevel()` 返回 `void` 且会按模型能力钳制；`ctx.compact()` 返回 `void`，提供 `onComplete/onError` | `extensions/types.d.ts` |

---

## 5. 生命周期设计

进程级保存无资源的控制记录，而不只保存 `new Hub()`：

```ts
// 示意字段；具体类型与兼容检查由实现定义。factory 不启动资源。
const STATE_KEY = Symbol.for("pi-pane.process.v1");
// globalThis[STATE_KEY]: {
//   autoStartApplied, desiredRunning, generation,
//   hub?, bridge?, rebindLease?, implementationVersion
// }
```

`autoStartApplied` 记录本进程是否处理过 `--web`，`desiredRunning` 记录用户当前启停意图，`generation` 用于作废旧 Bridge 和异步回调。HTTP、WebSocket、广播队列及回收定时器属于 Hub；实时状态投影和宿主引用属于 Bridge。

| pi 事件 | 处理 |
|---|---|
| factory 执行 | 只注册命令、flag 和事件处理函数，**不起任何资源**（F3） |
| 首次 `session_start`（`startup`） | 创建 Bridge，读取持久化历史并开始持续采集事件；只应用一次 `--web`，且只允许 `ctx.mode === "tui"` |
| `session_start`（`new`/`resume`/`fork`/`reload`） | 创建新 Bridge；重绑期限内且 `desiredRunning` 为真时接管 Hub，生成新 epoch，先推 `session_reset` 再推快照 |
| `session_shutdown`（`new`/`resume`/`fork`/`reload`） | 增加 generation，解除旧 Bridge 并清理其定时器、缓冲与订阅；Hub 进入 `switching`、拒绝命令，并启动重绑超时 |
| `session_before_tree` / `session_tree` | 导航期间禁用写命令；成功后重建当前分支投影，增加 `branchRevision` 并换新 epoch，推 reset 和快照。若没有成功事件，则在 pending 期间每 250ms 检查 `ctx.isIdle()`；恢复 idle 后校准分支快照并解除屏障。1.0.4 在导航 finally 中清理 busy 状态；取消、失败及随后立即有新输入的路径纳入 M0 |
| `session_shutdown`（`quit`） | 幂等关闭 Hub，断开连接并作废 token；关闭剩余 Bridge 资源 |
| `/web stop` | 设置 `desiredRunning=false`，关闭 Hub、作废 token、清空客户端租约及去重记录；Bridge 继续采集当前会话，供再次 `/web` 接入 |
| 进程被异常 kill | socket 随进程一起释放；浏览器显示"已断开"，并提示"在终端重新运行 `/web`" |

**重绑失败回收**：Hub 自持有带 generation 的重绑期限，初始取 10 秒，M0 根据慢启动验证调整。扩展被禁用、移除、加载失败或重建超时而无人接管时，Hub 必须关闭 socket/server，清空认证及缓存并置 `desiredRunning=false`。保留无资源控制记录和 `autoStartApplied`，避免迟到的 `session_start` 再按 `--web` 自动启动；需用户在终端显式 `/web` 恢复。超时只关闭网页服务，不中断 pi 的会话重建。

**旧上下文与回调**：命令捕获接收时的 Bridge/generation，调用宿主前再次核对。异步回调、压缩回调和节流任务在提交结果前也必须核对；不允许把旧请求转交给新 Bridge。已经进入宿主的异步操作不承诺可撤回，其结果只能归属于原 epoch。

**reload 代码升级**：控制记录保存协议和实现版本。同版本可重绑；不兼容的 Hub 必须先关闭再替换，不能用 `??=` 永久保留旧实现。新实现无法安全接管时降级为停止服务，并提示重新 `/web`。已被用户停止的服务不因升级重启。

---

## 6. 通信协议

WebSocket 使用 JSON 文本帧，协议版本为 `pi-pane.v1`。只有广播的状态增量消耗 `seq`，同一 epoch 内从 1 连续递增；快照携带对应水位，定向 `ack`、认证、心跳和 reset 控制消息不消耗序号。这样一个客户端的回执不会让其他客户端误判丢事件。

### 6.1 握手与快照

```
C → S  WebSocket 握手，Sec-WebSocket-Protocol: pi-pane.v1, pi-pane.bearer.<token>
       （本机为启动 token；外部访问为 §9 登录后签发的 sessionToken）
S → C  升级响应只选择 pi-pane.v1，不回显 bearer；鉴权失败不升级
C → S  { t: "hello", clientId? }
S → C  { t: "welcome", clientId, leaseExpiresAt, nextCommandNo }
S → C  { t: "snapshot", epoch, seq, session: {...}, state: {...}, theme: {...}, caps: {...} }
S → C  { t: "event", epoch, seq, ev: {...} } …（之后一直推增量）
```

`epoch` 在 Hub 启动、Bridge 重建、成功的 `/tree` 导航后重新生成；与认证凭据版本分开。`branchRevision` 只在切换分支时增加，普通消息追加不会使现有命令过期。reset 时清除旧投影和增量缓冲，并暂停输入直到新快照完整应用。

- `snapshot.session`：`id`、名称、cwd、`leafId`、`branchRevision`、当前分支的有界历史窗口与更早历史游标（见 §6.5）；只传展示需要的字段，不序列化整个 ctx 或 modelRegistry。
- **实时投影**：Bridge 从 `session_start` 起，以 `getBranch()` 初始化历史，再持续归并消息/工具事件。快照必须包含未持久化的活动消息、生成到当前的完整 content、运行中工具及最新 partial、嵌套关系、待处理 UI prompt 元信息。不能在 `/web` 启动时才开始采集，也不能只读 `getBranch()`。
- **消息身份**：历史使用 session entry ID，活动消息由 Bridge 分配独立 `messageId`，所有 delta 和 end 引用它；持久化后记录二者映射，不另增一条消息。禁止仅凭文本或 timestamp 去重。`msg_end` 必须表达完整最终消息并 upsert，超大内容可用带版本的内容引用承载（§6.5）；在可确认持久化完成的边界与分支历史校准，避免 `message_end` 先于持久化的时序问题。其他扩展替换最终消息的情况列入 M0。
- `snapshot.state`：宿主是否空闲、可观测的运行/压缩状态、当前模型及 thinking 等级、上下文用量（允许 unknown）、精简后的可选模型列表、`hasPendingMessages`、待处理 UI prompt。能力未知时明确显示 unknown，不能猜成 idle 或空队列。
- `snapshot.caps`：包括可用命令、图片支持、`promptReceipt: "dispatch_only"`、`queueView: "boolean"`、`terminalDialogs: true`；前端据此展示限制。

**快照与增量的切点**：状态投影更新与分配协议序号必须在同一提交步骤完成。发送快照前先提交尚未发布的合并更新，再同步捕获不可变投影和水位 N；该连接必须先收到快照，再收到 `seq > N` 的事件。序列化、分块传输期间将新事件放进有界队列，不能先读取历史、异步等待后再随意附上最新 seq。

**断线重连**：v1 不重放事件。客户端认证并 hello 后始终接收新快照，不发送没有作用的 `lastSeq`。应用快照时将 `lastAppliedSeq` 设为 N；同 epoch 下 `seq <= lastAppliedSeq` 的事件丢弃，只有 `seq === lastAppliedSeq + 1` 才应用并推进水位。出现序号缺口或未知 epoch 时暂停应用及写操作，发送 `resync` 请求新快照。连接恢复不自动重发用户命令，未确认提交按 §6.4 处理。

### 6.2 服务端事件（`ev.type`）

| 类型 | 来源 | 说明 |
|---|---|---|
| `agent_state` | `agent_start` / `agent_settled`，结合 `ctx.isIdle()` | `agent_settled` 用于终止自动续跑后的收敛；压缩期间不能仅因没有文本输出就判定 idle。M1：`state.tools` 恒为空数组，工具进度只走 `tool_*` 事件，reducer 保留已有工具列表 |
| `msg_start` / `msg_delta` / `msg_end` | `message_*` | start/end 携带完整的有界 `MessageView`。M1 实现：`message_update` 在服务端按 16ms 合并，`msg_delta { id, ops }` 中每个 op 为 `{ i, append, total? }`（文本块追加）或 `{ i, set }`（替换块）；元数据变化时退回 `msg_delta { id, message }` 整条替换。差量以所有客户端共享的“最后已发送”视图为基线，快照与其一致 |
| `tool_start` / `tool_update` / `tool_end` | `tool_execution_*` | 带 `toolCallId`、可选 `parentToolCallId`；partial 按工具在 50ms 内合并，end 刷新最终结果并清除待发 partial |
| `model` / `thinking` | `model_select` / `thinking_level_select` | 推送实际生效值，包括模型能力导致的 thinking 钳制 |
| `ui_prompt` | `ui_prompt_start/end` | 按可用标识维护待处理集合；网页提示终端待处理的 kind/title，不提供代答 |
| `history_window` | `session_compact` | M1 实现：压缩成功后发布一个带 seq 的 `history_window { messages, olderCursor }`，客户端整体替换当前窗口；保持 epoch，以便 compact 命令仍能送达结果。`session_before_compact` / `session_compact_failed` 反映在 `agent_state.compacting` |
| `queue_state` | Bridge 读取 `ctx.hasPendingMessages()` | 有网页连接时每 250ms 采样，值变化才推送；相关输入/消息事件后也刷新，不伪造不存在的扩展 `queue_update` 事件 |
| `session_meta` | `session_info_changed` | 更新名称等元信息 |
| `theme` | Bridge 比较颜色与 appearance 指纹 | 值变化才推送，见 §8 |

控制消息 `session_reset { epoch, sessionId, branchRevision, reason }` 来源于新 Bridge 或成功的 `session_tree`，后面必须跟新快照；`switching` 和 `notice` 描述连接生命周期。它们不占用状态增量的 seq。

### 6.3 客户端命令

| 命令 | 对应实现 | 备注 |
|---|---|---|
| `prompt { text, images?, mode? }` | `pi.sendUserMessage(content, { deliverAs: mode ?? "followUp", expandPromptTemplates: false })` | 始终传 delivery mode，避免检查 idle 后宿主转为 running 的竞态；空闲时宿主按普通输入处理。`images` 为 `{ mimeType, data(base64) }[]`，有图片时 text 可为空，content 为 `[text?, ...ImageContent]`；缩放与格式规整交给 pi 自己的 `processImage` |
| `abort` | 当前 Bridge 的 `ctx.abort()` | 回执仅确认已调用；实际空闲由状态事件确认 |
| `set_model { provider, id }` | 从当前 registry 解析模型后调用 `pi.setModel(model)` | v1 只在 idle 且无终端对话框时接受；根据返回 boolean 报结果 |
| `set_thinking { level }` | `pi.setThinkingLevel()`，再读取实际值 | v1 只在 idle 且无终端对话框时接受；返回钳制后的实际等级 |
| `compact` | `ctx.compact({ onComplete, onError })` | v1 只在 idle、无待发消息及终端对话框时接受；完成/失败由回调报告 |

所有写命令共用信封：

```ts
{ t: "command", clientId, commandNo, id, epoch, sessionId, branchRevision, command, args }
// id 由 clientId + commandNo 派生；commandNo 为递增安全整数。
{ t: "ack", id, epoch, nextCommandNo, status: "dispatched" | "rejected", error?: { code, message } }
// 仅对宿主 API 能可靠确认结果的命令发送：
{ t: "command_result", id, epoch, status: "completed" | "failed", value?, error? }
```

接收端先校验认证、信封 schema、客户端租约和去重记录；合法的新编号先预留，再检查命令参数及当前 `epoch/sessionId/branchRevision`。`switching` 或旧版本请求返回 `stale_session`；仅通过全部校验的命令才能调用捕获的 Bridge。每个 Bridge 串行处理命令的校验与提交步骤，但不等待一整轮生成结束，避免阻塞 abort。TUI 仍独立操作，服务端在调用前重查当前状态，异步结果也必须核对 generation；不能声称这把队列锁同时锁住了 TUI。

**prompt 的回执边界**：`dispatched` 只表示桥接层已校验并调用 `void` API，不表示宿主已接收、入队或执行成功。纯扩展没有完整的逐命令异步失败接口，也没有可靠的浏览器命令 ID 到 `input/message_*` 的关联；`source: "extension"` 由所有扩展共用，其他扩展还可转换或消费输入。不能靠文本或事件顺序猜测对应关系。

网页提交记录显示“已交给 pi；提交结果未确认”，保留原文供恢复；会话气泡始终由实际消息事件和快照驱动。等待超时显示“请检查终端”，不自动判失败或再次提交。可观察到的模型运行错误作为会话错误展示，不能伪造其对应的命令结果。若后续产品要求准确的逐条“已入队/失败原因”，需升级宿主能力或 SDK host，不能沿用当前 API 承诺实现。

**slash 与模板范围**：v1 将输入作为字面文本提交，不执行网页输入中的终端命令，也不自动展开模板/skill；界面提示这一点。模板支持后续通过独立的、只读取明确模板的接口设计和验证，不打开 F12 的混合分派开关。扩展 `input` 处理器仍会按宿主规则运行，这是 pi 的已有行为。

### 6.4 多客户端与命令去重

同一用户的多个浏览器均可操作，按服务器接收顺序提交，不提供协作角色或多用户隔离。每个标签页在首次 hello 后获取 Hub 签发的 `clientId` 租约（初始 30 分钟，可续期）；重连携带原 ID，服务端返回下一命令号。未知或已过期 ID 明确返回 `client_expired`，不得静默换身份重试旧操作。

Hub 在调用宿主前预留命令记录，按 `clientId + commandNo` 去重，并保存 epoch 和请求摘要。新命令必须使用服务器期望的下一命令号，禁止跳号；相同 ID、相同内容只返回已有回执，相同 ID、不同内容返回 `command_conflict`。预留后产生的 `stale_session`、busy 或参数错误同样消耗编号并缓存 rejected；非法信封、无效租约、跳号及 ID 冲突不推进编号，能识别有效租约时响应附 `nextCommandNo`。每个租约保存已接收的最高命令号和最多 128 条最近回执；不高于高水位但记录已回收的请求返回 `result_unavailable`，**绝不再次执行**。初始最多 8 个客户端租约；容量不足返回明确错误，不淘汰活跃租约来接受新连接。

客户端不自动重发任何用户操作。丢失 ack 后可通过 `receipt_query { clientId, id }` 查询旧记录，查询本身不调用宿主；未收到过的 ID 返回 `not_seen`，但也不自动提交。超出保留范围、租约过期、epoch 改变或 Hub 重启后，未确认提交显示“结果未知”。用户重新提交是一个新操作，须提醒此前操作可能已执行。去重保证仅限当前 Hub 和有效租约内不重复调用宿主，不承诺跨重启或业务执行层面的 exactly-once。

### 6.5 校验、资源边界与慢客户端

- 前后端共享运行时 schema；拒绝未知命令、非法枚举、过期版本和非预期字段。模型/图片只传白名单字段，不把配置、凭据或任意扩展内部状态原样发给浏览器。
- 初始限制：单条 prompt 文本 64 KiB UTF-8；最多 4 张 PNG/JPEG/WebP 图片、每张 base64 解码后的文件不超过 5 MiB、总计不超过 10 MiB，单图解码像素不超过 2,000 万。校验 base64、文件签名及实际可解码格式。客户端命令帧上限 16 MiB；认证和 hello 请求体各不超过 8 KiB。M2 实现：共享的 `validateImages()` 检查数量、白名单类型、规范 base64、解码字节、文件结构（PNG 签名 + IHDR CRC + IEND，JPEG SOF + EOI，WebP RIFF 长度 + VP8/VP8L/VP8X 头）、声明类型与实际类型一致及像素上限；浏览器在上传前额外用 `createImageBitmap` 确认可解码，扩展端在调用宿主前再校验一次，不通过的图片返回 `invalid_image` / `image_too_large` 且不调用宿主。
- 逻辑帧上限 8 MiB（快照、历史页等定向响应同样适用）。M1 实现为通用传输分块：序列化后超过 1 MiB 的逻辑帧拆成 `frame_begin { id, parts }`、连续的 `frame_chunk { id, index, data }`（每块 128K 字符的 JSON 文本）和 `frame_end { id }`，在同一事件循环回合内依次入队，不会与其他帧交错；客户端校验 id、连续 index 与块数后再解析并处理逻辑帧，任何交错或缺块都丢弃并 `resync`。与原设计的 `snapshot_begin/chunk/end` 等价，但不限于快照。
- 完整历史通过只读 `history_page { reqId, epoch, sessionId, branchRevision, before }` 按页加载（`before` 为窗口中最早持久化消息的 entry ID，即快照的 `olderCursor`）；服务端验证 epoch、会话和分支版本，从该 entry 向前按 768 KiB 预算取页，返回 `{ messages, olderCursor }`，`olderCursor` 为 null 表示已到分支起点。响应定向发送、不消耗 seq；前端按 entry ID 合并，切 epoch 时丢弃未完成请求。前端保留历史上限 16 MiB：实时增长超限时淘汰最旧的持久化消息并前移游标（可再次加载）；向上加载会超限时拒绝并提示。快照窗口为最近 200 条 / 768 KiB 的持久化消息加上全部活动消息。
- 单条消息所有块共享 32,768 字符的内联预算；超出预算的文本块保留原索引，只发送前缀并附 `total`（完整长度）。只读 `content_page { reqId, epoch, messageId, index, offset }` 按 128K 字符读取该块的完整原文，响应带 `total` 与 `final`（来源消息是否已结束），只接受消息 ID 与块序号，不接受文件路径。M1 的“版本衔接”以 `total` 与 offset 连续性实现：客户端每页校验 offset 等于已读长度，`total` 变化或 epoch 切换即判定过期需重读；仍在流式生成的超大块可以读取当前内容，但网页的“加载全部”主要面向已结束的消息。宿主不再保留来源消息时返回 `content_unavailable`，不以摘要冒充。工具实时输出在 `ToolView.output` 中只保留末尾 8,192 字符并附 `outputTotal`；完整结果通过对应 toolResult 消息的 `content_page` 读取。
- 图片（M2）：快照与增量只携带 `{ type: "image", mimeType, bytes, width?, height? }` 元数据，块序号与原消息一致；字节通过只读 `image_page { reqId, epoch, messageId, index }` 定向读取（≤5 MiB，超出返回 `image_too_large`，经通用分块传输）。前端在图片接近视口（以 timeline 为根、600px 边距）时请求，最多 2 个并发，解码为 object URL，按最近显示淘汰，总量 ≤48 MiB；epoch 切换丢弃未完成请求，已加载的图片保留。
- 思考耗时（M1/M2 收尾）：thinking 块可带 `timingStatus: "running" | "complete" | "interrupted"` 和 `durationMs`。Bridge 只对实际观测到的 `assistantMessageEvent.thinking_start/end` 按原始 `contentIndex` 用单调时钟计时，结束时定值；缺少 end 而消息/轮次结束时标为 interrupted。running 不带递增时长，快照读取不推进时间；元数据变化用块级 `set` 增量发布，与共享 reducer 保持一致。旧历史、错过 start 的段不补算；同条消息的持久化和重连保留观测值，canonical 思考文本被改写则撤掉不再可证明的耗时。计时状态跟随来源对象生命周期，分支重置、扩展重载及会话替换清空，不写入宿主会话文件。
- 快照分块及附件帧不超过 1 MiB；每连接发送缓冲与待发送增量合计初始上限 8 MiB，达到高水位即停止喂入历史分块，持续无法排空则断开该客户端并允许重连拉新快照。不得等待慢客户端而阻塞宿主事件处理，也不得无界缓存或静默丢 delta。
- 大工具结果显示限长摘要和明确截断标记，可按需读取宿主仍保留的完整结果；实时投影只保存每个工具的最新 partial。持久化历史采用索引/分页，避免复制完整会话多份。资源上限由 M0 压测调优，并保留在发布配置与验收记录中。
- 所有解析/归一化/网络错误都在扩展边界捕获；限流按连接和 Hub 总量执行。首次 hello 限时 5 秒；心跳超时、异常关闭和重绑失败统一走幂等清理。

M0 Spike 的有界预览（200 条/512 KiB、无分页）已由 M1 替换为上述窗口 + 分页 + 内容页实现；当前常量见 `src/protocol/index.ts` 的 `LIMITS`，验收证据见 [M1 验收记录](m1-status.md)。

---

## 7. 前端渲染

| 内容 | 渲染方式 |
|---|---|
| 用户消息 | 气泡，图片按需懒加载（§6.5） |
| assistant 文本 | Markdown（`marked` + `shiki`，shiki 懒加载），流式追加 |
| thinking | 默认折叠。观测到的思考段结束后显示耗时；未观测的历史不显示耗时，中断段标明“已观测 / 已停止”，见 §6.5 |
| 内置工具 `read` / `write` / `edit` / `bash` / `grep` / `find` / `ls` | 专门的卡片：edit 显示 diff（按词高亮，超出 128 KiB 文本、每侧 2,048 token 或累计 250,000 个匹配格时回退行级着色），bash 显示命令、输出和退出码 |
| 未知工具或扩展工具 | 通用卡片：工具名、参数 JSON、结果文本，可折叠（它们在终端里的自定义渲染是 TUI 组件，网页没法复用） |
| 嵌套调用（codemode） | 根据 `parentToolCallId` 缩进显示 |
| 自定义消息 / 自定义条目 | 自定义消息尊重 `display`；普通 custom entry 是扩展内部状态，默认不发送其 data，只有显式适配的可展示字段进入网页 |
| 压缩点 | 一条分隔线，标注"上下文已压缩" |

输入框：Enter 提交，Shift+Enter 换行；运行中 Enter 请求 followUp，⌘Enter（Windows/Linux 为 Ctrl+Enter）请求 steer，并提供可点击的同名按钮。中文等输入法组合期间不触发提交。M2 支持粘贴和拖入图片。提交状态遵守 §6.3，不能在收到 `dispatched` 后标注“已入队”。

**性能**：`content-visibility: auto` 跳过屏幕外消息的布局与绘制，配合前端 16 MiB 历史上限和服务端分页；store 更新经 `requestAnimationFrame` 合并后渲染，消息组件按不可变投影 memo，流式更新只重渲染变化的消息。M2 增加窗口化列表：跟随最新输出时只挂载最新 200 条；读者上滚或加载更早历史时窗口扩大，回到底部后收回。贴底状态下用 `ResizeObserver` 跟随估算尺寸与图片加载造成的高度变化。前端节流不能代替 §6.5 的服务端背压、分块和内存上限。

**移动端**：触屏（`pointer: coarse`）上 Enter 换行、按钮提交，按钮最小 40px，输入框 16px 字号避免缩放，适配安全区；页面重新可见时立即重连。

---

## 8. 主题

1. 服务端读 `ctx.ui.theme.colors`（F7），转换成 hex。`IndexedColor` 按 xterm 256 色表转换，OKLCH 做 gamut-map。
2. 映射成 CSS 变量，例如：

| pi token | CSS 变量 | 用在哪里 |
|---|---|---|
| `text` / `muted` / `dim` | `--fg` / `--fg-muted` / `--fg-dim` | 正文、次要文字 |
| `accent` | `--accent` | 链接、焦点、主按钮 |
| `border*` | `--border*` | 分隔线、卡片边框 |
| `userMessageBg` | `--user-bg` | 用户消息气泡 |
| `toolPendingBg` / `toolSuccessBg` / `toolErrorBg` | `--tool-*` | 工具卡片状态 |
| `toolDiff*` | `--diff-*` | diff |
| `md*` / `syntax*` | `--md-*` / `--syntax-*` | Markdown 和代码高亮 |
| `success` / `warning` / `error` | `--ok` / `--warn` / `--err` | 状态 |

3. **pi 主题里没有的网页元素**（页面背景、侧栏、hover、阴影）：页面背景优先用主题的 `export.pageBg`，其余在 OKLCH 空间里由 `appearance` 和上面这些颜色推导出来。pi 1.0.4 的 Theme 不公开 export，使用公开 `sourcePath` 或 `ctx.ui.getAllThemes()` 给出的路径，有界读取当前主题 JSON（≤256 KiB），解析 `vars` 与颜色；缺失或无效时按 appearance 回退。缓存文件指纹，读取保持同步以维持快照切点。字体、圆角、间距是 pi-pane 自己的设计 token，跟 pi 主题无关。
4. **自定义主题**：包的 `themes/` 自带 `pi-pane-dark` / `pi-pane-light`，通过 `pi.themes` 声明，安装包后 TUI 和网页均可使用。网页专属覆盖写在源码的 `public/pi-pane.css`，随构建复制到 `web-dist/pi-pane.css` 并在应用样式之后加载；安装后可编辑该文件并刷新，无需重新构建，不自动扫描工作目录。动态主题变量为内联 CSS 属性，有意覆盖需 `!important`；现有 CSP 仍生效。
5. **主题切换后网页跟着变**：比较最终 CSS 变量指纹，包含解析后的 `colors`、`appearance` 与 `export.pageBg`，不只比较 `theme.name`。快照前以及 Bridge 活跃轮询（当前 250ms）时检查；值变化才推 `theme`。同名文件热更新、仅 export 变化、system 主题及终端默认色变化均纳入验收。纯扩展不深导入内部 `onThemeChange` 覆盖 TUI 自己的回调。

---

## 9. 安全

| 风险 | 对策 |
|---|---|
| 本机其他用户或网页访问到服务 | 默认只绑 `127.0.0.1`；使用 32 字节随机 token，以 URL-safe 编码放在 `#t=`。fragment 不会自动进入 HTTP 请求和 Referer，但后续 bearer 头仍包含凭据，不能据此声称所有日志都无 token |
| token 泄露后长期有效 | 每次 Hub 启动生成新 token；stop、退出、重绑超时均作废。rotate 同时撤销全部登录和现有连接；不得仅改 token 却保留已认证连接 |
| DNS rebinding 和跨站 WebSocket | HTTP 校验精确 Host；认证端点与 WS 升级额外校验精确 Origin（scheme、host、有效端口），拒绝缺失、null 和未允许值。绑定地址 `0.0.0.0`/`::` 不作为访问白名单，禁止通配符 |
| HTTP 静态资源 | 公开页面不包含会话数据；会话内容和操作只走鉴权 WS，HTTP 另有受保护的认证端点。静态文件根目录固定，拒绝路径穿越，不因 cwd 改变而开放项目文件；healthz 只返回存活状态 |
| 局域网/外部访问 | M1 拒绝；M2 必须显式配置外部 HTTPS origin、密码和传输保护，按 §9.1–9.2 执行。密码不能补偿明文 HTTP/WS |
| 远程访问 | 支持显式配置的同机加密代理，例如 Tailscale Serve；不集成公网隧道。代理白名单及鉴权仍生效 |
| XSS | Markdown 禁止原始 HTML，并对生成结果做 HTML 清洗、链接协议白名单和图片来源限制；`marked` 自身不提供净化。Shiki 输出同样经过受控渲染。使用 CSP 禁止内联脚本和 eval，不能只靠 CSP 代替清洗 |
| 日志与浏览器存储 | 不记录认证 body、Authorization、bearer subprotocol 或完整连接链接；日志只记请求 ID 和错误码。token 只存当前标签页 sessionStorage/内存，密码不存储；读取 fragment 后清除地址栏中的 token |
| 网页能做的事 | 跟终端用户的权限完全一样：能发消息就能让 agent 执行命令。文档里写明这一点 |

### 9.1 外部访问部署（M2，已实现）

外部访问要求 `PI_PANE_PASSWORD` 与 `--public-origin https://host[:port]` 同时存在。密码仅从进程环境读取，不接受命令行密码值，不写入 settings。支持两种明确部署：

- **直接 TLS**：`--host` 配合 `--tls-cert`、`--tls-key`，由 `node:https` 提供 HTTPS/WSS；证书必须被访问设备正常验证。非回环 HTTP 监听拒绝启动。
- **同机 TLS 代理**：显式启用 `--proxy-mode`，后端只绑定回环，由受信任的同机代理提供公共 HTTPS/WSS。代理须保留 Origin 和 subprotocol，按显式公共 origin 校验；不从 `X-Forwarded-*` 自动推断信任或扩充白名单。代理请求不能通过其他网络路径绕过 TLS。

直接 TLS 的 Host 对应 public origin；代理模式仅额外允许实际回环上游地址。额外别名需明确配置成完整 origin，`--allowed-host` 本身不能绕过 Origin 校验。生成链接与二维码使用 public origin，不使用通配监听地址。无法满足证书或代理配置时不启用外部访问。

### 9.2 外部访问认证流程

1. Hub 生成随机 `bootstrapToken`，通过 `#t=` 传给前端；仅持有链接不等于完成 LAN 登录。
2. 前端通过同源 HTTPS `POST /auth/session` 提交 `{ bootstrapToken, password }`，校验 Host、Origin、`Content-Type: application/json`，请求体不超过 8 KiB。按来源和全局限制失败登录次数，统一错误文案，不暴露是哪项凭据错误。
3. 两项凭据通过后签发随机 32 字节 `sessionToken`；服务端保存摘要、认证版本和绝对到期时间（初始 8 小时），返回 `Cache-Control: no-store`。密码不保留在浏览器存储。
4. WS 升级只接受 `sessionToken`，外部访问模式下拒绝 bootstrap token 直接升级。握手通过后仅回显 `pi-pane.v1`，不回显 bearer。客户端租约续期不得超过认证到期时间。
5. 凭据到期关闭对应 WS 并要求登录；rotate、stop、Hub 回收清空登录会话和客户端租约。会话/分支切换只更换数据 epoch，不要求再次登录。

实现要点：密码至少 12 字符，以 SHA-256 摘要做定长比较；会话 token 只保存摘要，到期由定时器立即关闭对应连接（close code 4401）；同时最多 16 个登录，失败登录按来源每 5 分钟 10 次、全局每分钟 20 次限流（代理模式下所有请求来自回环，只按全局计）；`GET /auth/info` 只返回模式，`GET/DELETE /auth/session` 用于校验与退出。前端在升级失败时向 `/auth/session` 询问登录是否仍有效，再决定重连或回到登录页。

登录请求、HTTP/WS 连接数、失败升级和单位时间命令量都设置有界限制；代理模式的限流不能信任未经配置的客户端 IP 转发头，全局限流始终生效。静态资源和认证响应设置 `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`；CSP 至少包含 `default-src 'self'`、`script-src 'self'`、`object-src 'none'`、`base-uri 'none'`、`frame-ancestors 'none'`，`connect-src` 显式允许当前 WS/WSS origin，图片只开放实际需要的 self/blob/data 类型。Shiki/CSS 变量所需样式策略单独验证，不通过放宽 script-src 解决。

---

## 10. 打包与发布

```jsonc
{
  "name": "@lilibonk/pi-pane",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./dist/extension/index.js"],
    "themes": ["./themes/*.json"],
    "image": "https://…/preview.png"
  },
  "peerDependencies": { "@earendil-works/pi-coding-agent": "*" },
  "dependencies": { "ws": "8.22.0", "qrcode-generator": "2.0.4" },
  "files": ["dist", "web-dist", "README.md", "docs/design.md"]
}
```

- 宿主提供的包（`pi-coding-agent`、`pi-ai`、`pi-tui`、`typebox`）只放 `peerDependencies`，**不打包**（参见 `docs/packages.md`）。
- 前端在发布前用 Vite 预构建到 `web-dist/`，用户安装时不需要构建。目标体积：gzip 后首屏 < 200 KB，shiki 的语言包按需加载。
- `pi-package` 关键词使包具备 gallery 发现资格；发布后实际核验收录和预览图，不把外部索引完成时间作为本地功能保证。
- 以 1.0.4 为测试基线，按官方建议保留宿主 peer 的 `*`；启动时检测必需 API，缺失时明确拒绝启用或降级 caps，不能把任意宿主版本都视为已兼容。

---

## 11. 工程结构与技术栈

```
pi-pane/
├── src/
│   ├── extension/          # 跑在 pi 进程里
│   │   ├── index.ts        # factory：命令 / flag / 事件注册、进程级状态
│   │   ├── hub.ts          # 进程级：http + ws、鉴权、租约/去重、分块发送、分页路由
│   │   ├── bridge.ts       # 会话级：投影、窗口/分页、内容页、合并发布、主题、命令
│   │   ├── config.ts       # piPane 设置读取与宿主能力检测
│   │   ├── theme.ts        # 有界主题读取、颜色映射与网页颜色推导
│   │   ├── thinking.ts     # 宿主事件观测计时，随会话投影回收
│   │   └── qr.ts           # /web qr 的终端二维码
│   ├── protocol/           # 前后端共享类型、LIMITS、运行时校验与共享 reducer
│   └── web/                # 前端 SPA：store、Markdown/高亮、消息与工具卡片
├── themes/                 # 自带的 pi-pane-dark / pi-pane-light
├── public/pi-pane.css      # 可选的包内网页样式覆盖
└── docs/
```

- **扩展**：TypeScript + `ws`，HTTP/HTTPS 用 Node 内置模块，不引服务端框架。共享 schema 的验证器须能在 Node 与浏览器运行；不把宿主完整模块树打进前端。
- **前端**：Vite + Preact + Zustand（使用 vanilla store 或显式配置 compat，构建时避免重复引入 React）+ CSS 变量；Markdown 使用 `marked`、Shiki 与 HTML 清洗器。所有资源随包发布，不从公共 CDN 拉脚本。
- **测试**：协议、状态投影及生命周期写必要的单元/集成测试；用确定性假 provider 加 PTY 驱动真实 TUI、Playwright 驱动网页做双端端到端测试。仅浏览器假后端不足以验证 TUI 切换、扩展重载和真实输入事件时序。

---

## 12. 里程碑

| 里程碑 | 内容 | 完成标准 |
|---|---|---|
| **M0 Spike**（以验证结果决定工期） | 最小扩展及真实 TUI/浏览器验证：连接、流式、重连、提交、中止、会话/分支切换、失败边界 | §13 Q1–Q10 逐项记录证据、结论与能力降级；核心一致性问题未解决不得进入 M1 |
| **M1 MVP** | 本机模式完整协议；followUp/steer；工具卡片；主题映射；快照分块、背压及长历史基本展示；安全基线；stop/status/rotate/--web | §13.1 所有 M1 用例通过；补充日常使用一周的反馈记录 |
| **M2 打磨与发布** | 图片、移动端及虚拟列表优化、完成 §9 外部访问认证与 TLS/代理路径、二维码、README 和预览图 | §13.1 所有 M2 用例通过；npm 安装验证及实际 gallery 收录；外部访问安全条件缺一则不开放该模式 |
| **M3 交接模式** | 独立设计 SDK host 的所有权、分离运行、接入/释放和标准对话框适配，先验证同进程前台与独立后台两条候选路径 | 见下方 M3 门槛；不把前台 Web 服务视为已完成后台交接 |
| **M4 官方协议** | 跟进 `pi experimental server/client`，等它稳定后作为后端 | 一个会话可以同时挂多个前端，原生支持后台常驻 |

**2026-10-09 调整后的执行顺序**：验证 pi 1.1.0 兼容性并在日常终端加载 pi-pane → 用真实模型验证 `/web`、双端对话、工具执行、刷新重连 → 修复试用问题，完成 npm 发布与正式安装验证 → 稳定后推进 M3。M1 的一周反馈和 M2 的发布验收继续记录，当前进展见 [真实环境试用与发布计划](m2-trial-status.md)。

**M3 门槛**：同进程前台候选先验证扩展是否能接管 TUI 退出流程，它本身不承诺关闭终端后存活。后台候选必须在真实关闭终端后继续运行，并定义唯一会话写入者、所有权获取/释放、崩溃恢复及子进程失败回滚。`pi --resume` 是恢复历史的入口，不能默认等于附着后台进程；只有后台 host 停止且交还写入权后才允许按恢复历史继续，实时附着需另设 attach 协议。标准 select/confirm/input/editor 可设计 Web 适配，任意 TUI custom 组件只能声明不支持或提供专门适配。相关能力未验证前，不在 README 承诺 M3 会解决所有对话框限制。

---

## 13. 待验证问题（M0 解决）

下表保留 M0 的验证问题和通过标准。当前结果见 [本地验收记录](m0-status.md) 与 [Space 执行计划](https://chatgpt.com/space/page_6ac66a64d11c8191bbcc2dc63d862e09)，不能把预期结果写成已通过。记录使用的 pi/Node/OS 版本、执行步骤、可重复的测试结果及必要的录屏或日志；日志不含 token。

| # | 问题 | 验证及通过标准 |
|---|---|---|
| Q1 | Hub 能否跨运行时重绑，失败时能否回收？ | 依次运行 `/web`、`/reload`、`/new`、`/resume`、`/fork`；再禁用扩展、模拟导入失败和超时。检查连接/epoch、监听端口、旧回调失效，且 stop/超时后不会因 `--web` 再启动 |
| Q2 | 提交能否正确进入 TUI，回执是否诚实？ | 保留未发送草稿；测试普通输入、followUp/steer、同文本多端提交、其他扩展转换/消费输入、无模型/认证失败。实际消息驱动双端展示，draft 不受破坏，dispatched 从不显示成成功/入队 |
| Q3 | 主题能否持续同步？ | 切主题、同名文件热更新、system/default 色变化；验证颜色/appearance 指纹，变化 1 秒内可见，不覆盖宿主回调 |
| Q4 | 广播是否拖慢宿主或造成无界缓存？ | 固定长输出比较开启/关闭扩展的吞吐、事件循环延迟及内存；停止一个浏览器读取、增加多端连接、大工具 partial。验证分块和断开策略；必要时服务端按 16ms 合并后编号 |
| Q5 | slash 行为是否符合范围？ | 注册有可观察副作用的测试命令，从网页输入 `/命令`、模板名和 skill 名；`expandPromptTemplates:false` 不进入 slash 分派。另验证宿主 input 扩展仍按规则处理 |
| Q6 | 非 TUI 模式是否正确拒绝？ | rpc/print/json 不启动监听、不创建定时器；错误可见且进程正常退出 |
| Q7 | 运行中快照是否完整并与增量衔接？ | `/web` 首次打开及刷新发生在文本、thinking、工具参数和工具 partial 的中途；检查无缺失/重复，含相同文本的不同消息仍独立。验证持久化映射和其他扩展替换最终消息 |
| Q8 | 会话/分支边界是否拦住旧操作？ | `/tree` 成功、取消、摘要失败；延迟投递旧 prompt/abort/model/compact。尚未进入宿主的旧命令必须拒绝；已提交异步操作按 §5 边界处理，旧结果不得更新新 epoch；切换屏障可恢复 |
| Q9 | 去重与队列状态能否实现？ | 丢失 ack、重复 ID、冲突内容、回执淘汰、租约过期及 Hub 重启；宿主调用次数正确且无自动重发。终端入队/消费/清空后，网页布尔队列状态 1 秒内收敛 |
| Q10 | 配置和包运行是否符合宿主约束？ | 验证 settings 自定义字段读写与并发保存、启动 flags、重复 `/web`、端口冲突、stop/start、同机多 pi 实例；使用预构建包安装并验证静态资源路径与必需 API 检测 |

### 13.1 M1/M2 发布验收矩阵

| 编号 | 阶段 | 场景 | 必须满足 |
|---|---|---|---|
| A1 | M1 | 生成/工具执行中首次接入、刷新、断线重连 | 活动消息与 partial 可恢复；最终历史与 TUI 一致；无丢字或重复气泡 |
| A2 | M1 | new/resume/fork/reload/tree，含失败和取消 | 旧版本命令被拒绝；快照切换正确；无人重绑在期限内关闭服务；无重复监听/计时器 |
| A3 | M1 | 两个浏览器与 TUI 同时输入、中止、切模型 | 浏览器命令按 Hub 接收顺序提交并有版本归属；与 TUI 并发时状态最终收敛；无凭文本误合并 |
| A4 | M1 | 无模型、认证失败、输入被消费、压缩期间提交、丢 ack | 不虚报发送/入队成功；可恢复提交文本；重试/查询不会重复调用宿主 |
| A5 | M1 | 超长历史、巨大工具输出、慢客户端 | 快照分块、缓冲上限和截断提示生效；慢端被回收，TUI 继续响应，无持续内存增长 |
| A6 | M1 | 参考性能数据集 | 1,000 条消息、归一化文本总量 ≤1 MiB、无图片；记录机器与环境，20 次测量的 WS 连接建立至浏览器快照应用完成 P95 ≤1 秒。`/web` 至浏览器启动的耗时另记；慢端与大历史不套用此阈值 |
| A7 | M1 | 主题、队列与输入法 | 同名主题更新和队列布尔状态 1 秒内同步；中文组合输入不误提交 |
| A8 | M1 | 错 token/Origin/Host、恶意 Markdown、非法帧、路径穿越 | 拒绝未授权升级和非法操作；无脚本执行/任意文件读取；日志无凭据；rotate 断开已有连接 |
| A9 | M2 | 图片及大历史图片加载 | 校验大小、格式与解码像素，损坏/超限图片明确失败；重连和懒加载完整，内存受控 |
| A10 | M2 | 直接 TLS 与同机代理认证 | 明文非回环拒绝启动；缺密码、错密码、bootstrap 直接升级、过期会话均失败；正确登录可用；轮换/退出撤销全部连接 |
| A11 | M2 | 移动端、安装与发布 | 移动端输入/steer按钮及重连可用；干净环境安装无需构建；npm tarball 包含静态资源；核验 gallery 收录 |

---

## 14. 已知限制（写进 README）

1. 其他扩展弹的对话框（select/confirm/input/editor/custom）**只能在终端里操作**，网页只提示待处理信息（F8）。M3 可研究标准对话框适配，任意 TUI 组件不保证支持。
2. 扩展自定义的 TUI 渲染（工具渲染器、widget、footer）在网页上会退回到通用展示。
3. 网页不执行 slash 命令或自动展开模板/skill；终端的 `/tree`、`/resume`、`/fork` 等操作仍须在网页同步结果。
4. 关掉终端，网页就断开；后台运行需满足 M3 的进程分离及唯一写入者门槛。
5. prompt 回执只确认桥接层提交，不能逐条确认入队或覆盖全部失败原因；超时需检查终端，保留原文供人工恢复。完整待发队列内容也不在扩展 API 能力内。
6. 多个浏览器属于同一用户权限，均可提交或中止；没有只读访客、多用户角色与协作隔离。未确认操作不会自动重发，跨重启不提供 exactly-once。
7. 外部访问须同时配置公共 HTTPS origin、`PI_PANE_PASSWORD` 与直接 TLS 或同机加密代理；缺一项不启动。
