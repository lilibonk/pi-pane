# pi-pane

在 pi 终端里输入 `/web`，把当前会话交给浏览器：TUI 正常退出，同一进程继续在前台提供网页服务，`pi --mode rpc` 子进程负责会话写入。浏览器提供会话导航、流式对话、工具输出、图片、文件与 Git 差异面板。终端按 **Ctrl+C** 停止服务，再按恢复提示回到终端会话；关闭终端也会结束服务。

**本文描述尚未发布的 0.2.0 源码。** npm 当前正式版本仍是 `@lilibonk/pi-pane@0.1.0`，其行为是终端与网页并行的会话镜像。0.2.0 是不兼容变化，发布由维护者执行。开发与验证基线为 pi 1.1.0、Node ≥ 22.19、macOS/Linux；Windows 暂不支持交接。实现与验收进度见 [M3 状态](docs/m3-status.md)，设计见 [设计方案](docs/design.md)。

## 从 0.1.0 迁移

- `/web` 只有交接一种行为；必须先等回复结束且待发队列为空。没有 `/web --mirror`。
- TUI 在交接后退出；网页操作期间，终端只显示服务横幅、链接、外部访问二维码与停止提示。
- 移除 `pi --web` 启动参数。先启动交互式 `pi`，再输入 `/web`。`--web-host`、`--web-port`、`--web-no-open`、`--web-public-origin`、`--web-tls-cert`、`--web-tls-key`、`--web-proxy` 仍是 `/web` 的配置。
- 移除 `/web status`、`/web stop`、`/web qr`、`/web --rotate`。停止服务使用终端 Ctrl+C；二维码直接出现在外部访问横幅；网页“资源 → 能力”提供轮换凭据入口。
- 网页输入采用 pi RPC 的展开语义：扩展命令、skill 和模板会执行或展开。pi 内置交互命令由网页拦截，打开对应面板；不支持的入口显示原因。
- 回执新增实际 RPC `started`、`queued`、`handled` 结果；回复和工具结果仍以会话输出为准。断线后不自动重发操作。

## 安装与源码试用

目前 npm 安装得到的是已发布的 **0.1.0 镜像版**：

```sh
pi install npm:@lilibonk/pi-pane@0.1.0
```

试用当前交接源码时，在包含 M3 改动的 checkout 构建后加载：

```sh
npm ci
npm run build
pi -e .
```

启动后输入 `/web`。本地包也可通过 `pi install .` 安装；该操作会改变日常包来源，隔离验收使用临时 HOME/agent 目录。包内自带预构建网页，发布后安装不需要构建。本项目采用 MIT 许可证，公开仓库为 [lilibonk/pi-pane](https://github.com/lilibonk/pi-pane)。

## 使用

| 入口 | 行为 |
|---|---|
| `/web` | 空闲会话交接，默认从 `127.0.0.1:7878` 找空闲端口，打开浏览器 |
| `/web --no-open` | 交接但不自动打开浏览器 |
| `/web --port 7900` | 指定端口，占用即报错 |
| 终端 Ctrl+C | 停止宿主和 RPC 子进程，打印最新 cwd 与会话文件的恢复命令 |
| 关闭终端 | 服务和子进程随之退出 |

网页里：

- 左侧会话按工作区分组，可搜索、新建、恢复、重命名、克隆。从分支树里的**用户消息之前**创建分叉，原文回到输入框；已有或编辑中的草稿保留。普通未提交草稿不跨页面刷新保留。tree 导航暂不可用，入口显示 pi RPC 缺口。
- **Enter** 发送，**Shift+Enter** 换行；运行中 Enter 请求 followUp，**⌘/Ctrl+Enter** 请求 steer。触屏 Enter 换行，用按钮发送。运行时可中止；会话切换要求空闲、队列为空。
- `/` 菜单显示命令、技能和模板。`/new`、`/resume`、`/fork`、`/model`、`/thinking`、`/compact`、`/settings`、`/session`、`/name`、`/clone` 转到工作台操作；`/tree`、认证、reload 等缺少对应 RPC 的入口禁用，不把它们当普通模型消息。
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

配置优先级：`/web` 参数 > 启动 flags > pi 合并后的 `settings.json` > 默认值。配置本身不启动服务，扩展只读设置：

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

网页沿用交接时的 pi 主题，包含 Markdown、代码、diff 和 `export.pageBg`。RPC 不提供 TUI 主题切换接口，交接后没有终端主题热切换承诺。包内 `pi-pane-dark` / `pi-pane-light` 可在交接前的 pi `/settings` 选择；`pi -e .` 只加载扩展，安装本地包后可同时加载主题。

网页覆盖样式可编辑源码 `public/pi-pane.css` 后构建，或编辑安装包 `web-dist/pi-pane.css` 后刷新。覆盖动态主题变量需 `!important`；更新可能覆盖文件，请保留副本。

## 运行边界

会话 sidecar 锁协调加载 pi-pane 的 TUI/宿主；交接时锁连续保留。上游裸 pi 不遵守该锁，宿主在空闲时检测外部会话文件变化并停止服务，但这不是能阻止任意外部程序写入的操作系统锁。RPC 子进程崩溃时停止服务并给出恢复命令，**不自动重启**；宿主退出时关闭 stdin、必要时 SIGTERM/SIGKILL 停子进程，避免残留写入者。

当前只在 macOS/Linux 提供交接；Windows 被明确拒绝。`/web` 要求保存的 TUI 会话，`--no-session` 不可交接。启动参数重建会移除已用于 TUI 的初始位置提示词和 @文件，避免在 RPC 中重复执行；不能确定是否带值的扩展选项在退出 TUI 前报错，请改用 --flag=value。实时 attach、关闭终端后存活、后台常驻均不在本次范围。

文件/Git 读取限制在当前会话 cwd，排除常见凭据与构建目录；文本预览与 diff 最多 256 KiB。Git 面板要求 cwd 是仓库根目录。模型认证、资源安装、任意 custom TUI、Plan/Goal/Agent 语义仍需后续设计。外部代理用本地 TLS 反向代理验证，未验证真实 Tailscale Serve。

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
