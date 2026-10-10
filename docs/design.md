# pi `/web`：交接工作台设计

状态：M3 交接修订 v0.8，2026-10-10。源码版本 `0.2.0` 尚未发布，开发分支为 `main`；正式 npm 仍为 `@lilibonk/pi-pane@0.1.0`（MIT）。当前能力与测试基线为 pi / pi-ai 1.1.0，Node ≥22.19，macOS/Linux。本地候选安装与验收结果见 [M3 状态](m3-status.md)。

维护者的 [调整说明](m3-codex-adjustment.md) 取代 v0.6 的镜像、命令网关及后台 attach 方向。`spike/m3-handoff` 仅证明交接可行，依据与 8 项原型证据见 [交接 spike](m3-handoff-spike.md)；不能直接作为可发布实现。原工作台在 commit `6196c7b` 保存，旧证据与已发布 0.1.0 的 M0–M2 验收均为历史记录，不作为本修订的通过结论。

## 1. 产品目标与基线

`/web` 把当前会话交给浏览器：先正常关闭 TUI，再在同一个 pi 进程里运行前台网页服务。RPC 子进程持有会话，浏览器继续任务；Ctrl+C 停止服务并打印最新会话的恢复命令，关闭终端结束宿主与子进程。

对齐基线固定为 `@moonshot-ai/kimi-code@2.1.1`，官方 commit `242ac230006447f8601e1678c49182bfbae89fe9`。参考是实际 `/web`，不是 VS Code webview。界面、构建资源及 kap-server 核对证据在 `build-artifacts/kimi-alignment/current/`；Kimi 2.1.1 的前台退出接管、信号和横幅行为已在交接 spike 再核对。

| 范围 | 当前目标 |
|---|---|
| 工作台 | 工作区/会话侧栏，中央对话与输入，右侧文件、Git diff、资源 |
| 会话 | 搜索、新建、恢复、重命名、克隆、从用户消息之前分叉 |
| 输入 | 扩展命令、skill、模板按 RPC 展开；pi 内置交互命令由网页拦截 |
| 回复 | streaming、thinking、工具 partial/result、steer/followUp、中止、压缩、图片 |
| 交互 | select/confirm/input/editor 的回答、取消、超时、重连；扩展 status/widget/title/editor text |
| 生命周期 | TUI 正常退出、唯一 RPC 写入者、前台服务、Ctrl+C 恢复提示、终端关闭退出 |
| 外部访问 | 沿用 M2 的 HTTPS/同机代理 + 密码 + 二维码，无云中继 |

Kimi 的持久文件树、交互终端、独立 MCP 配置 GUI 未在当前 `/web` 确认；不据共享类型或服务器 API 推定界面已有功能。权限审批、Plan/Goal/Agent 等动态过程原来只确认源码入口；pi 对应的执行语义仍待定义，不能用无后端按钮声称对齐。

明确边界：没有镜像路径、`/web --mirror`、实时 attach、关闭终端后存活或后台常驻承诺；不做云端托管、多用户角色及云中继。任意 TUI `custom()` 组件不自动转换成网页组件。

## 2. 用户流程与配置

```text
pi TUI：正常对话 → 等回复结束、待发队列为空 → /web
  → TUI 停止与 session_shutdown
  → 同进程前台服务 + 一个 pi --mode rpc 子进程
  → 横幅：链接、当前 cwd、Stop: Ctrl+C；外部访问附密码提示/二维码
浏览器：继续对话，浏览/打开/新建会话
终端 Ctrl+C：停止子进程和服务 → 打印 cd <最新 cwd> && pi --session <最新会话>
关闭终端：SIGHUP → 同样结束服务和子进程
```

交接前必须是保存的交互 TUI 会话、空闲且没有待发消息；正在回复时拒绝交接，保留 TUI。原型通过停止正在进行的回合模拟 Kimi 的路线未采用。`--no-session`、Windows 和无法安全区分值的扩展 CLI 选项在退出 TUI 前报错。

`/web` 参数：`--host`、`--port`、`--no-open`、`--public-origin`、`--tls-cert`、`--tls-key`、`--proxy`。默认绑定 `127.0.0.1`，从 7878 起最多试 20 个端口；显式端口占用即失败。TUI 阶段校验配置与 TLS，退出接管后才创建监听。

移除启动 flag `--web` 及 `/web handoff`、`stop`、`status`、`qr`、`--rotate` 子命令。配置 flags `--web-host`、`--web-port`、`--web-no-open`、`--web-public-origin`、`--web-tls-cert`、`--web-tls-key`、`--web-proxy` 保留；优先级为 `/web` 参数 > flags > pi 合并设置的 `piPane` 字段 > 默认值。配置不触发自启动，扩展不写 settings。

## 3. 进程与所有权

```text
同一个 pi 进程
  TUI 阶段：pi-pane 只注册命令/配置，不加锁，不运行 Bridge、Hub 或监听
  /web → 正常 TUI shutdown → 拦截一次正常 process.exit
  前台宿主：Hub（HTTP/HTTPS、WS、鉴权、租约、去重）
            HandoffHost（目录、RPC 命令、对话框、锁、当前 cwd）
            RpcSessionMirror → Bridge（消息/工具投影、分页、内容/图片）
            WorkspaceService（当前会话 cwd 内的只读文件/Git）
               ↕ JSONL stdin/stdout
            pi --mode rpc 子进程（唯一会话写入者）
               ↕ pi 的正常运行时、扩展与模型
浏览器 SPA ↔ Hub：版本化命令、workbench_query、消息增量与扩展 UI
```

宿主使用**当前运行的 pi 安装**的公开 RPC entry，沿用 CLI 运行时工厂及公开 JSONL 命令；不在子进程增设私有工具/树导航通道。CLI 参数按已知选项重建，过滤会话选择及 `--web-*`；已用于 TUI 的初始位置提示词、@文件与 -- 后的位置内容不重放到 RPC。无法区分值的未知扩展选项拒绝交接，并要求改用 --flag=value，不能把位置内容变成子进程的新提示。

pi 没有公开的“退出后前台接管”钩子，正式实现仍拦截一次 `process.exit`，正常 TUI shutdown 完成后才接管；异常退出码不接管。这是依赖 pi 实现细节的兼容边界，需要上游公开 API。

### 会话文件锁

宿主锁记录位于 `<session>.pi-pane.lock`，0600，以排他创建和随机所有者 token 协调 `/web` 宿主。**只有 `/web` 加锁**：在命令处理中（TUI 仍在）获取，加不上就拒绝本次交接、TUI 保持打开；交接到 RPC 期间连续持锁。普通 TUI 不加锁，打开被 `/web` 宿主持有的会话时只提示、不关闭（审阅修正：最初实现让每个 TUI 加锁并在冲突时自行关闭，改变了 pi 允许多终端打开同一会话的行为）。切会话先检查目标锁，成功后释放旧锁，失败保留原会话所有权；停止时等子进程实际退出再释放。锁记录同时保留宿主与 RPC 写入者 PID；任一仍存活时不能抢占，确认两者退出且文件身份未变的旧锁才可回收。加锁用的 guard 文件在持有进程已退出或超过 30 秒时自动回收。

这是**协作锁**。上游裸 pi 和外部程序不会遵守它，不能宣称阻止任何写入。宿主在每次网页写入前和每轮写入后核对会话文件：以固定大小的块计算已接受完整前缀的 SHA-256，确认历史未变；新增的每个完整行须与 RPC 子进程 `get_entries` 报告的条目内容完全一致，才接受为子进程自身写入。原子替换文件也必须保留已接受前缀；未完成的末行留到下次核对。出现子进程不认识的条目、空行、截断或改写时停止服务并给出检查/恢复提示。核对所需的只读 RPC 超时会使本次依赖操作失败，保持原基线与子进程，下一次操作可以重试；未完成核对前不提交写入。审阅修正：最初只在特定事件后认可文件变化，扩展在回复结束后异步写入（如 `pi.appendEntry`）会被误判为外部冲突；只检查文件末尾又会遗漏早段改写。协作锁阻止两个 pi-pane 宿主同时持有同一会话，外部写入检测是额外的失败保护。

RPC 请求只对只读查询（get_state、get_entries、get_commands 等）设超时，超时只让该次查询失败、不停子进程。prompt、新建/切换/分叉/克隆、压缩等可能执行扩展代码（对话框、长时间命令、会话切换钩子）的请求不设超时，由中止、回答/取消对话框或 Ctrl+C 结束。审阅修正：最初所有请求 120 秒超时即停子进程，对话框搁置两分钟会结束整个服务。

### 崩溃策略

子进程异常退出采用**停止服务，不自动重启**：当前可能存在已写入但未发回结果的命令，重启可能重新执行或制造第二个写入者。宿主关闭 Hub、停止/确认子进程退出、释放锁、打印当前 cwd 与会话文件的恢复命令。恢复是用户执行 `pi --session`，不是 attach。

SIGINT/SIGTERM/SIGHUP 幂等停止：关闭子进程 stdin，超时依次 SIGTERM、SIGKILL；父进程被 SIGKILL 时 stdin EOF 使子进程自行退出。不得在子进程死亡尚未确认时启动第二个写入者。终端恢复命令跟随浏览器最后打开的会话和 cwd。Windows 退出/信号行为未验证，当前直接拒绝交接；Linux 支持实现但运行证据须与 macOS 分开记录。

## 4. RPC 与工作台能力映射

| 工作台能力 | 宿主调用与边界 |
|---|---|
| 会话目录/搜索 | 宿主 `SessionManager.list/listAll`；合并当前和最近访问目录 LRU，最多 32 个根；只接受已列出的 ID，不接受浏览器路径 |
| 新建/恢复 | RPC `new_session`、`switch_session {sessionPath}`；使用 cancelled 等真实结果，成功后重建 RPC 会话视图/Bridge/cwd，推新 epoch |
| 重命名/克隆 | RPC `set_session_name`、`clone`；当前标记和列表自动刷新 |
| 分叉 | RPC `fork {entryId}`，只允许当前会话用户消息；分叉位于用户消息之前，返回 text 恢复输入，不恢复图片 |
| 树 | RPC `get_entries` 重建只读树；tree 导航禁用并说明上游缺口，不使用内部命令 |
| 命令目录 | RPC `get_commands`；来源分类、名称冲突提示与保留内置名称 |
| 模型/thinking | RPC `get_available_models`、`set_model`、`get_available_thinking_levels`、`set_thinking_level` |
| 工具列表/启停 | RPC 暂无接口，禁用并显示“需要 pi 支持” |
| 文件/Git | 当前会话 cwd 的宿主只读服务，跨工作区切换立即换根 |
| 扩展对话框 | 官方 RPC UI 子协议 select/confirm/input/editor；所有客户端第一份有效答案胜出 |
| 扩展展示 | notify、setStatus、setWidget、setTitle、set_editor_text 的受控网页适配 |

RPC `prompt` 总会尝试扩展命令、skill、模板展开，无法按原文关闭。网页中的普通 slash 因而遵循 RPC 语义；**pi 内置交互命令不能直接传给 RPC prompt**，否则会作为普通模型文本。网页保留内置名称，即使目录尚未返回也拦截：new/resume/fork/model/thinking/compact/settings/session/name/clone 打开对应动作，tree/login/reload 等没有 RPC 映射的命令提示交接模式不支持。扩展与内置名称冲突不能绕过拦截。

## 5. 通信协议与一致性

WebSocket subprotocol 为 `pi-pane.v1`、`pi-pane.bearer.<token>`，握手先鉴权；服务器只回显 `pi-pane.v1`。`hello`/`welcome` 建立客户端租约，`snapshot {epoch,seq,session,state,theme,caps,ui?}` 建立投影水位。

### 写操作

```ts
{ t: "command", clientId, commandNo, id, epoch, sessionId, branchRevision, command, args }
{ t: "ack", id, epoch, nextCommandNo, status: "dispatched" | "rejected", error? }
{ t: "command_result", id, epoch, status: "completed" | "failed", value?, error? }
```

所有写命令在宿主串行分派；进入队列和出队调用前核对版本，避免旧操作落入替换会话。正常回执关联原命令和 epoch，同一 Hub/有效租约可查询保留结果；不再有 sessionMutation 特殊豁免、nonce 网关、跨 Bridge 写屏障或 `StateView.mutating`。

`prompt`/`run_command` 的 RPC 结果显示 `started`、`queued`、`handled`；失败返回真实错误。`dispatched` 仅表示分派开始，不能当作完成。消息与工具气泡由实际事件/快照显示，不根据命令文本猜对应关系。

客户端 ID/编号去重：预留合法新编号后，拒绝与错误同样消耗编号；相同 ID/内容只返回保存结果，不重复调用宿主；不同内容冲突、编号跳号、过期租约明确失败。每租约最多 128 条回执、最多 8 个租约；已淘汰结果不能再次执行。断线或重启不自动重发，超时保留原文供人工检查/恢复；不承诺跨进程重启的 exactly-once。

新建/恢复/分叉成功后先 `session_reset` 再完整快照。fork 草稿仅由本次现场操作恢复一次，校验目的 session/branch 与输入框修订；已有/编辑中的草稿保留，旧回执查询只供人工恢复。草稿恢复覆盖 fork 回执与同页面断线重连；普通未提交草稿不持久化，刷新页面后不会保留。

### 唯一工作台读通道

`workbench_query {reqId,epoch,sessionId,branchRevision,action,args}` 提供 sessions/commands/resources/tree/files/file/git_status/git_diff，定向 `workbench_result` 不消耗写编号或事件 seq。删除 spike 的 `host_read`。调用前后版本校验、每连接最多 8 个、全局最多 16 个在途查询；网页 15 秒超时可重读，断线不重放查询。

目录最多 200 条历史元数据，搜索包含后续消息；树最多 2,000 条，命令最多 512 条，模型最多 256 条。只传展示元数据，不传认证、完整 settings 或扩展内部 data。

### 扩展 UI

`ui_request {id,method,title?,message?,options?,placeholder?,prefill?,expiresAt?}` → `ui_response {id,value?,confirmed?,cancelled?}` → `ui_resolved {id,reason?}`。答案独立于命令队列，否则等待扩展对话框的 prompt 会阻塞回答。第一份有效答案胜出；超时、会话替换和停止关闭所有 viewer 的请求。重连新快照后重发宿主仍待处理的请求，不把本地乐观关闭当作宿主已确认。

`snapshot.ui` 和 `ui_state` 携带全量有界 statuses/widgets/title，以及带独立 `editorRevision` 的 editorText；status/widget 更新不能重复覆盖用户已编辑的草稿。网页限制对话框文本 64 KiB UTF-8，离线时禁用回答并保留输入，焦点和 Escape 约束在活动对话框内。

### 消息投影、分页与背压

RpcSessionMirror 从公开 RPC 状态、条目及流式事件重建消息，为 Bridge 提供同步投影。持久化条目须与已观测消息对应，最终消息 upsert，不能以文本相同合并两个回合；原型的角色/时间戳匹配局限需在生产实现与测试继续校准。

广播增量在同一 epoch 内连续 `seq`；定向回执、读取、UI 控制和 reset 不消耗 seq。快照先捕获当前水位，后续只应用 `seq>N`。v1 重连始终拉新快照，不重放事件；缺口或未知 epoch 暂停写入并 resync。慢流文本、thinking、工具 partial/arguments 和持久化衔接纳入回归。

沿用已验证的资源边界：最近 200 条/768 KiB 历史窗口加活动消息；历史页按 entry ID 合并，浏览器历史缓存 16 MiB；块内联预算 32,768 字符，`content_page` 按 128K 字符读取；逻辑帧 8 MiB、传输帧 1 MiB，超限通用 frame_begin/chunk/end；每连接发送缓冲 8 MiB，慢端回收后可重连，不能阻塞 RPC 事件或无界缓存。

图片最多 4 张、单张 5 MiB、合计 10 MiB、2,000 万像素，前后端校验数量/格式/结构/字节/像素，浏览器额外解码。历史图片只携带元数据，image_page 按需加载、最多两个并发、缓存 48 MiB。thinking 耗时仅对真实观测 start/end 计时，旧历史不补算。

## 6. 文件、Git、展示与主题

文件查询根目录总是当前会话 cwd，跨工作区成功切换后重建 WorkspaceService。列表最多 500 条、扫描最多 10,000 项，预览/diff 最多 256 KiB、Git 状态最多 2 MiB、执行超时 10 秒。路径拒绝绝对路径、穿越、逃逸符号链接，打开后校验文件身份；排除 .git、node_modules、构建目录及常见凭据。

Git 使用参数数组，无 shell；禁用 external diff/textconv/fsmonitor 和 clean/process/smudge filters，清除外部 GIT_* 影响，不改配置或 index。暂存/未暂存/删除/重命名/未跟踪均读取真实仓库状态。当前只展示 cwd 自身是仓库根的 Git；引用到消息最多 24 KiB，明确截断，并转义 fence。

前端沿用 Preact、Zustand、marked、Shiki 和清洗器，三栏桌面布局与移动端抽屉；消息默认窗口 200 条，滚动上翻/分页扩大，回到最新缩回。中文 IME 不误提交；触屏 Enter 换行。未知扩展工具通用卡片，custom entry 内部数据不泄漏。

网页使用交接时已解析的 pi 主题，保持 Markdown/代码/diff 与 `export.pageBg`、OKLCH 派生面板色。RPC 没有 TUI 主题切换，旧镜像的运行时热主题同步验收退役；交接前选择主题、包内主题资源和 CSS 覆盖仍验证。安装包自带 pi-pane-dark/light 与 public/pi-pane.css 构建副本。

## 7. 外部访问与安全

沿用 M2，不集成 Kimi `/remote-control` 的云中继。公共 HTTPS origin、`PI_PANE_PASSWORD`（至少 12 字符）、直接 TLS 或显式同机 TLS 代理缺一项则拒绝交接。代理只监听回环，保留 Origin/subprotocol；不信任 X-Forwarded-* 自动扩充白名单。Host/Origin 精确校验、防跨站 WS/DNS rebinding；0.0.0.0 不作为访问白名单。

链接 fragment 携带 bootstrap token；外部访问必须同源 POST /auth/session 校验链接与密码后取得 sessionToken，bootstrap 不能直接 WS 升级。登录默认 8 小时、最多 16 个；错误登录限流，退出/停止/轮换撤销连接。token 当前随服务启动变化，持久化为可选未实现项。

交接横幅直接显示 URL、当前 cwd、Stop: Ctrl+C；外部访问附密码提示和终端二维码。网页 access_rotate 返回新链接再撤销旧连接/登录，发起页面更新凭据（外部需重登录），其他 viewer 使用终端的新链接；所有终端输出跟随当前会话，不保留 TUI widget 路径。

Markdown 原始 HTML 不执行，链接仅 http/https/mailto，远程图片仅显示链接；CSP 禁内联脚本/eval、frame ancestor、object/base。静态资源不带会话内容、固定 webRoot、防路径穿越。密码不存储、token 仅本页 sessionStorage/内存，读取后清理地址栏；报告与终端日志脱敏。

## 8. 里程碑与 M3-D 重写

M0/M1/M2 是已发布 0.1.0 的历史镜像验收，记录保持不改写。M3 首批工作台也在 `6196c7b` 保存旧结论。本修订保留布局、移动端、草稿恢复、只读文件/Git 与 workbench_query，迁移其执行语义后重新验收。

- **M3-A**：工作台结构及逐项能力映射，保留已有视觉成果。
- **M3-B**：RPC 会话/命令/模型与文件/Git闭环，工具与 tree 缺口明确禁用。
- **M3-C**：完整标准扩展 UI 与 RPC 提交结果；认证/资源安装和 Plan/Goal/Agent 的未定义语义继续后置。
- **M3-D（新定义）**：Kimi 式前台交接、唯一 RPC 写入者、协作会话锁、当前 cwd、Ctrl+C 恢复提示、SIGHUP 退出、宿主/子进程崩溃无残留写入者。禁止按旧设计扩展成后台存活、attach 或自动重启。

M3-D 验收门槛：正常 TUI shutdown 在子进程打开文件前完成；交接前忙/队列拒绝；目标锁冲突失败保留原会话；停止时确认子进程退出后释放锁；关闭终端/杀宿主均不遗留活子进程；子进程异常 fail closed，恢复提示与浏览器最后 cwd/会话一致。macOS 真实 PTY 证据与 Linux/Windows 的状态分别记录。

## 9. 回归矩阵与发布

| 范围 | 交接后的验收要求 |
|---|---|
| M0 生命周期 | TUI → /web → 宿主；配置/空闲/保存会话/端口冲突，Ctrl+C/SIGHUP/SIGKILL/child crash/锁 |
| M0 消息与边界 | prompt/steer/followUp/abort，input 消费转换、模型/认证失败、compact、去重/回执、旧 scope 拒绝 |
| M1 协议与性能 | 慢流刷新/重连，thinking/tool arguments/partial，分页/超长内容/背压；1,000 条消息 A6 分开测量 |
| M1 浏览器 | Markdown/Shiki/diff/耗时/内容安全，中文 IME，桌面/390px 抽屉/焦点 |
| M2 图片/外部访问 | 上传与历史懒加载，TLS/代理密码登录与撤销，横幅二维码，手机重连 |
| M2 安装 | npm pack 内容、干净 HOME 安装无构建依赖、安装后 /web 交接；不使用 --web |
| M3 工作台 | 会话当前标记/新建/恢复/改名/clone/fork草稿；跨 cwd 文件/Git；命令/skill/template；工具/tree缺口 |
| M3 扩展 UI | 四类对话框、回答/取消/超时/重连/竞争答案，status/widget/title/editor，不覆盖编辑后的草稿 |
| 真实 provider | 显式 opt-in 的独立隔离 agent 目录；真实回复、工具、刷新重连；确定性测试不替代 |

旧镜像的 TUI/网页同时输入、扩展运行时 rebind、/web stop/status/qr/rotate、--web 自启动、终端主题热变和 tree 导航按新定义退役；它们的底层安全、状态一致性、失败清理与重复执行防护在上述宿主矩阵补足。具体命令、结果和未覆盖范围见 [tests/README.md](../tests/README.md) 与 [M3 状态](m3-status.md)。旧慢流重连超时保留原证据，在交接模式重新跟踪，不能将后续通过自动当作旧问题根因已定位。

打包仍是 pi package（keywords pi-package，coding-agent peer ≥1.1.0 <2，pi-ai peer *），dist 扩展与 web-dist/主题预构建后随包发布。版本 `0.2.0` 为未发布的次版本升级，README 必须写明 --web 去掉及 TUI 不再并行；npm 发布只由维护者执行。干净安装验收与真实 provider 验收各自记录；不因本地 pack、原型或部分回归通过声称已发布或整体 Kimi 对齐完成。
