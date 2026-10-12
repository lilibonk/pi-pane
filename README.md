# pi-pane

在 pi 终端里输入 `/web`，把当前会话交给浏览器：TUI 正常退出，同一进程继续在前台提供网页服务，`pi --mode rpc` 子进程负责会话写入。浏览器提供会话导航、流式对话、工具输出、图片、文件与 Git 差异面板。终端按 **Ctrl+C** 停止服务，再按恢复提示回到终端会话；关闭终端也会结束服务。

**当前源码对应 M3.1 候选 `0.3.0-rc.3`，尚未发布。** 已发布版本保持 `0.2.0`，本轮不更新日常 pi 插件。下文新增的项目、账户、供应商及设置能力属于本地候选；最终验收结果待冻结候选后记录，不能沿用旧版本的通过结论。开发基线为 pi 1.1.0、Node ≥ 22.19、macOS/Linux；Windows 暂不支持交接。

M3 / `0.2.0` 的发布和验收历史保留在 [M3 状态](docs/m3-status.md) 与 [M3 最终验收](docs/m3-final-acceptance.md)。M3.1 的使用变化见 [迁移说明](docs/m3.1-migration.md)，实现边界见 [设计方案](docs/design.md)，独立审核发现与当前验证结果见 [M3.1 状态](docs/m3.1-status.md)。

M3.1 已实现项目管理、API key 登录、自定义供应商、分层设置、主题与会话补齐，正在整合候选；[详细计划](docs/m3.1-plan.md) 与 [调研依据](docs/m3.1-research.md)保留决策背景。OAuth 网页入口仍关闭，M4 保留在其后。

## 从 0.1.0 迁移

- `/web` 只有交接一种行为；必须先等回复结束且待发队列为空。没有 `/web --mirror`。
- TUI 在交接后退出；网页操作期间，终端只显示服务横幅、链接、外部访问二维码与停止提示。
- 移除 `pi --web` 启动参数。先启动交互式 `pi`，再输入 `/web`。`--web-host`、`--web-port`、`--web-no-open`、`--web-public-origin`、`--web-tls-cert`、`--web-tls-key`、`--web-proxy` 仍是 `/web` 的配置。
- 移除 `/web status`、`/web stop`、`/web qr`、`/web --rotate`。停止服务使用终端 Ctrl+C；二维码直接出现在外部访问横幅；网页“资源 → 能力”提供轮换凭据入口。
- 网页输入采用 pi RPC 的展开语义：扩展命令、skill 和模板会执行或展开。pi 内置交互命令由网页拦截，打开对应面板；不支持的入口显示原因。
- 回执新增实际 RPC `started`、`queued`、`handled` 结果；回复和工具结果仍以会话输出为准。断线后不自动重发操作。

## 安装与源码试用

安装或升级到已发布的 0.2.0：

```sh
pi install npm:@lilibonk/pi-pane@0.2.0
```

试用当前 M3.1 源码时，在 checkout 构建后加载；这不会把候选发布到 npm：

```sh
npm ci
npm run build
pi -e .
```

升级后重启已打开的 pi，再输入 `/web`。本地包也可通过 `pi install .` 安装；切换本地与 npm 来源时，用 `pi remove <旧来源>` 移除旧配置并以 `pi list` 确认只加载一份。隔离验收使用临时 HOME/agent 目录。包内自带预构建网页，npm 安装不需要构建。本项目采用 MIT 许可证，公开仓库为 [lilibonk/pi-pane](https://github.com/lilibonk/pi-pane)。

## 使用

| 入口 | 行为 |
|---|---|
| `/web` | 空闲会话交接，默认从 `127.0.0.1:7878` 找空闲端口，打开浏览器 |
| `/web --no-open` | 交接但不自动打开浏览器 |
| `/web --port 7900` | 指定端口，占用即报错 |
| 终端 Ctrl+C | 停止宿主和 RPC 子进程，打印最新 cwd 与会话文件的恢复命令 |
| 关闭终端 | 服务和子进程随之退出 |

网页里：

- 左侧“项目”可打开主机上的已有目录或创建空目录；项目登记与目录分开，从列表移除不删除目录或会话。打开项目会恢复最后已保存会话，或由 pi 创建空会话。跨项目切换会顺序替换 RPC 子进程，未持久化的扩展内存随之丢失。草稿和待发图片按项目保存在当前页面内存里，刷新后不保留。
- 会话可搜索、新建、恢复、重命名、克隆；从分支树里的**用户消息之前**创建分叉，原文回到输入框，已有或编辑中的草稿保留。非当前且未被其他 `/web` 持有的已保存会话可删除，优先移入废纸篓，失败或不可用时永久删除，结果会说明。tree 导航暂不可用。
- **Enter** 发送，**Shift+Enter** 换行；运行中 Enter 请求 followUp，**⌘/Ctrl+Enter** 请求 steer。触屏 Enter 换行，用按钮发送。运行时可中止；会话切换要求空闲、队列为空。
- `/` 菜单显示命令、技能和模板。`/new`、`/resume`、`/fork`、`/model`、`/thinking`、`/compact`、`/settings`、`/session`、`/name`、`/clone`、`/export`、`/copy`、`/login`、`/logout` 转到对应网页操作；`/tree`、`/reload` 等未支持入口显示原因，不把它们当普通模型消息。
- “设置”集中提供外观、模型默认、会话行为、账户、自定义供应商和其他设置。账户支持 pi 提供的 API key 登录，凭据保存在有效 agent 目录的 `auth.json`，对使用该目录的所有项目生效。网页登录 OAuth 暂不开放：设备码流程尚待真实账户验证，本机回调流程尚未实现；已有 OAuth 凭据仍可由 pi 使用，请在终端 `/login` 登录。
- 自定义供应商可编辑协议、Base URL 和模型列表，再通过“设置密钥”调用 pi 登录；密钥不写入 `models.json`，表单外配置保留且只读。删除当前供应商前会提示影响，应用后由 pi 决定模型并显示前后变化；没有其他可用模型时提示需要先登录账户或添加供应商。不额外阻止发送。注销只清除 pi 保存的凭据，不撤销远端授权，也不能清除环境变量或启动参数。
- `/session` 查看会话与用量，`/copy` 复制最后回复，助手消息也有复制入口。`/export` 导出 HTML 到 `<agentDir>/pi-pane/exports`，保留最近 20 份，≤32 MiB 可在浏览器下载；导出可能含会话中的文件内容与密钥，分享前请检查。
- 点击 `@ 文件` 或输入 `@` 搜索当前会话 cwd 的文件，预览后“引用到消息”插入真实文本。单次最多 24 KiB，整条消息最多 64 KiB，截断会明确提示。
- 右侧“改动”读取实际 Git 状态及暂存/未暂存/未跟踪 diff；“文件”预览 UTF-8 文本；“资源”提供可用模型、thinking、命令和能力说明。工具列表与启停等待 pi RPC 上游支持。
- 扩展的 select、confirm、input、editor 在网页回答，支持取消、超时与重连；notify、status、widget、title、editor text 使用网页适配。自定义 TUI 组件不自动转换。
- **图片**支持粘贴、拖入和选择 PNG/JPEG/WebP，最多 4 张；单张 ≤5 MiB、合计 ≤10 MiB、≤2,000 万像素。前后端各校验一次。历史图片懒加载，浏览器缓存最多 48 MiB。
- 默认显示最近 200 条历史，更早点“加载更早的消息”，超长内容可“加载全部”。工具 edit diff 强调变更词；thinking 默认折叠，只显示实际观测到的耗时。

移动端用抽屉打开会话、文件和资源面板，支持焦点约束、Escape 和返回输入框。多个网页拥有相同用户权限，命令在宿主串行执行。

## 从其他设备访问

外部访问沿用 M2：**公共 HTTPS origin + 密码 + 加密传输**，不做云中继。三项缺一项不会启动：

1. `--public-origin https://host[:port]`；
2. 环境变量 `PI_PANE_PASSWORD`，至少 12 个字符；不接受命令行密码或 settings 密码；
3. 同机 TLS 代理或直接 TLS：

```sh
PI_PANE_PASSWORD='一个足够长的密码' pi
/web --proxy --port 7878 --public-origin https://my-mac.tailnet-name.ts.net
```

代理把公共 HTTPS 地址转发到 `http://127.0.0.1:7878`，保留 `Origin` 和 `Sec-WebSocket-Protocol`。也可用 `/web --host 0.0.0.0 --port 8443 --public-origin https://pane.example.com:8443 --tls-cert cert.pem --tls-key key.pem`；证书必须被访问设备正常验证。

交接横幅直接显示外部链接和二维码。扫码后还需输入密码，登录有效期 8 小时；网页可退出登录或轮换凭据，轮换会撤销已有链接、登录和连接，新链接打印到交接终端。发起轮换的页面更新凭据，外部访问需重新登录。连续输错密码会被限流。

## 配置与主题

`piPane` 服务配置优先级：`/web` 参数 > 启动 flags > pi 合并后的 `settings.json` > 默认值。这组配置本身不启动服务，扩展只读取它：

```json
{
  "piPane": {
    "port": 7878,
    "noOpen": true,
    "publicOrigin": "https://my-mac.tailnet-name.ts.net",
    "proxy": true
  }
}
```

字段：`host`、`port`、`noOpen`、`publicOrigin`、`tlsCert`、`tlsKey`、`proxy`，对应上述 `--web-*` flags。密码不写进配置。

M3.1 默认跟随 pi 在当前项目的主题，包含 Markdown、代码、diff 和 `export.pageBg`；在网页“设置 → 外观”可为此浏览器选择浅色、深色、跟随设备或已安装的 pi 主题，先预览再保存，关闭设置会取消未保存的预览。偏好按浏览器 origin 保存，换协议、主机或端口需要重新选择。包内重做了 `pi-pane-light` / `pi-pane-dark`，并新增浅色青花瓷主题 `pi-pane-porcelain`。它的原创纹样只出现在独立留白处，可关闭，高对比度时自动隐藏。

浏览器的外观不改变终端主题；pi 的全局默认主题有单独入口。青花瓷在 TUI 中只使用配色。RPC 不提供已打开 TUI 的主题热切换。`pi -e .` 只加载扩展，安装本地包后可同时加载主题。[M31-D 规范与截图走查](docs/m3.1-ui-design.md)记录了本轮界面改版。

网页只修改支持清单里的 pi 全局默认；项目设置只读，启动参数和受信任项目配置可能覆盖全局值。默认模型用于之后创建的会话，不替换当前会话模型。凭据、自定义供应商及需要重载的设置保存后，当前宿主空闲时尝试应用，忙碌时保留“待应用”，之后可点“立即应用”；不打断回复，也不强制更新其他终端或宿主。扩展否决应用时原运行时继续使用，已保存的更改仍保留。

网页覆盖样式可编辑源码 `public/pi-pane.css` 后构建，或编辑安装包 `web-dist/pi-pane.css` 后刷新。覆盖动态主题变量需 `!important`；更新可能覆盖文件，请保留副本。

## 运行边界

只有 `/web` 会为会话加 sidecar 锁（`<会话文件>.pi-pane.lock`），从交接一直持有到服务停止；普通 TUI 不加锁，多个终端可以像原本的 pi 一样打开同一会话。另一个 TUI 打开正在网页中运行的会话时只会收到提示，不会被关闭；它再执行 `/web` 会被拒绝。锁的持有进程已退出时，残留的锁和加锁用的 guard 文件会被自动回收。

上游裸 pi 不遵守该锁，因此宿主在每次网页写入前和每轮写入后核对会话文件：只接受由 RPC 子进程自身写入的追加条目（包括扩展在回复结束后才持久化的条目），出现子进程不认识的条目、内容被改写或截断时停止服务并给出恢复命令。这不是能阻止任意外部程序写入的操作系统锁。等待扩展对话框或长时间运行的扩展命令没有统一超时，可在网页中止或回答；只读状态查询超时不会停掉子进程。RPC 子进程崩溃时停止服务并给出恢复命令，**不自动重启**；宿主退出时关闭 stdin、必要时 SIGTERM/SIGKILL 停子进程，子进程全生命周期保留父进程 IPC 断开退出保护。

打开带 pi 配置的项目可选择“信任并记住”“不加载项目配置，继续”或取消。不提供“仅本次信任”：pi 的 `--approve` 是进程级覆盖，宿主不会替用户生成它；即便记住信任，全局扩展仍可能否决。工具环境来自启动 `/web` 的终端，切目录不会重新加载 shell、direnv 或虚拟环境。跨项目重启不具备原生会话切换的 veto 钩子；关闭阶段需要交互或不能正常结束的扩展会阻止启动目标项目，页面给出恢复选择。关闭窗口的合法非消息追加只按有界规则接受，不能证明写入归属，详见[迁移说明](docs/m3.1-migration.md)。

当前只在 macOS/Linux 提供交接；Windows 被明确拒绝。`/web` 要求保存的 TUI 会话，`--no-session` 不可交接。启动参数重建会移除已用于 TUI 的初始位置提示词和 @文件，避免在 RPC 中重复执行；不能确定是否带值的扩展选项会在退出 TUI 前报错：例如以 `pi --plan` 启动时 `/web` 会拒绝，请改用 `pi --plan=true` 这类 `--flag=value` 写法启动。实时 attach、关闭终端后存活、后台常驻均不在本次范围。

文件/Git 读取限制在当前会话 cwd，排除常见凭据、构建目录，以及有效 agent 和已知会话目录；即使项目是 HOME，自定义数据目录仍受过滤。凭据类目录及 pi 数据目录不能经网页打开为项目。文本预览与 diff 最多 256 KiB，Git 面板要求 cwd 是仓库根目录。常用模型范围、资源安装/启停、MCP 管理仍在终端完成；工具启停、tree 导航、任意 custom TUI、Plan/Goal/Agent 语义尚未补齐。外部代理用本地 TLS 反向代理验证，未验证真实 Tailscale Serve。

M3.1 使用 `pi-pane.v2` 浏览器协议。旧 `0.2.0` 页面在认证成功后只收到“请刷新”提示并停止重试，不接收新宿主状态或会话数据；刷新加载新版页面即可继续。会话 JSONL 和凭据保持 pi 原生格式。

## 安全与验证

网页权限与终端用户相同，能发消息就能让 agent 执行命令。链接和密码只给可信设备。随机 token 通过 fragment 传入，打开后从地址栏清除；Host/Origin 精确校验。Markdown 原始 HTML 不执行，链接协议受限，模型远程图片只显示链接，页面有 CSP。

```sh
npm ci
npm run typecheck
npm test
npm run build
PI_M0_EXTENSION=./dist/extension/index.js npm run m0:smoke
PI_M0_EXTENSION=./dist/extension/index.js npm run m3:workbench
```

确定性 M0–M2 回归脚本迁移为“真实 TUI → `/web` → RPC 宿主 → 网页/WS 操作”，使用临时 HOME、agent/session 目录和本地确定性 provider，不读取日常凭据、不调用远程模型。M3 生命周期与桌面/移动端 CUA 分别验证；完整命令、退役项和证据见 [tests/README.md](tests/README.md)。真实模型试用是显式 opt-in 的独立流程，不把确定性测试当作真实 provider 验收。npm 发布由维护者执行。
