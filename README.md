# pi-pane

在 pi 终端里输入 `/web`，浏览器就接上**正在运行的这个会话**：完整历史、实时输出、工具卡片和 diff 都会显示出来，也可以在网页里发消息（含图片）、steer、中止、切模型。终端照常可用，两边看到的是同一个会话。

![pi-pane 在浏览器中显示当前 pi 会话](https://raw.githubusercontent.com/lilibonk/pi-pane/main/docs/preview.png)

当前源码开发与验收宿主为 pi 1.1.0（Node ≥ 22.19）；历史 M0/M1 基线为 1.0.4。设计见 [docs/design.md](docs/design.md)，验收记录见 [M0](docs/m0-status.md)、[M1](docs/m1-status.md)、[M2](docs/m2-status.md)、[M1/M2 收尾](docs/m2-followup-status.md)。

已发布的 **npm 0.1.0** 提供当前会话镜像；pi 1.1.0 兼容回归、Qwen3.7 Max 真实模型试用和正式安装已通过，日常使用仍加载这一版。**当前分支的 M3 工作台源码尚未发布**，首批会话导航、命令发现、文件引用、Git 改动与资源面板已验收；一轮慢流重连超时仍待定位，新增源码的真实模型试用与发布尚待完成，详见 [M3 状态](docs/m3-status.md)。官方 Kimi Code 2.1.1 是对齐基准，整体对齐仍在推进；一周日常反馈继续记录在 [试用状态](docs/m2-trial-status.md)。

## 安装

通过 pi 安装：

```sh
pi install npm:@lilibonk/pi-pane
```

发布包内带预构建网页，安装时不需要构建。启动 `pi` 后输入 `/web` 即可使用；已经运行的 pi 可用 `/reload` 加载。

项目已在 [GitHub](https://github.com/lilibonk/pi-pane) 公开。也可以从源码试用；下方 clone 默认获取 main，M3 功能需使用包含本批改动的源码分支：

```sh
git clone https://github.com/lilibonk/pi-pane.git
cd pi-pane
npm ci
npm run build
pi -e .
```

从源码试用 M3 时，使用上述 `pi -e .`。本地包也可构建后通过 `pi install .` 安装，包含扩展和主题；已有 pi 可用 `/reload` 加载。它与已发布的 npm 0.1.0 是不同来源。

本项目采用 MIT 许可证。

## 使用

| 命令 | 作用 |
|---|---|
| `/web` | 启动服务（默认 `127.0.0.1:7878` 起找空闲端口）并打开浏览器 |
| `/web --no-open`、`/web --port 7900` | 不打开浏览器；指定端口（占用即报错，不换端口） |
| `/web status` | 地址、连接数（外部访问时还有登录数） |
| `/web stop` | 停止服务，断开所有浏览器 |
| `/web --rotate` | 更换链接，撤销所有登录和连接 |
| `/web qr` | 外部访问时在终端显示链接二维码，两分钟后隐藏 |
| `pi --web` | 启动 pi 时同时启动服务 |

网页里：

- **Enter** 发送，**Shift+Enter** 换行；运行中 Enter 请求 followUp，**⌘/Ctrl+Enter** 请求 steer。触屏设备上 Enter 换行，用按钮发送。
- **图片**：粘贴、拖入或点“图片”。PNG/JPEG/WebP，最多 4 张，单张 ≤ 5 MiB、合计 ≤ 10 MiB、≤ 2,000 万像素；浏览器和扩展各校验一次，损坏或超限的图片会直接报错。历史里的图片只在滚动到附近时加载，浏览器最多缓存 48 MiB。
- 历史默认显示最近 200 条，更早的点“加载更早的消息”；超长内容可“加载全部”。
- edit diff 会强调变更词；超大补丁保留行级着色。思考过程默认折叠，已观测的思考段显示耗时；旧历史和扩展重载前的内容不补算耗时。
- npm 0.1.0 的网页按原文提交，不执行 slash 命令或展开模板/skill。普通消息的回执只表示“已交给 pi”，不代表已入队或成功；断线后不会自动重发。

### M3 源码工作台（尚未发布）

- 左侧按工作区显示会话，可搜索历史、新建、恢复、从消息分叉和切换分支。切换会同步到终端和所有已连接网页；运行或仍有待发消息时禁用切换。
- 输入 `/` 查看宿主发现的命令、skill 和模板；选择条目或提交匹配的已发现命令后才走明确分派。普通消息和未发现的 slash 文本仍按字面提交。`/resume`、`/tree`、`/model`、`/settings` 等已接入对应面板；未接入的内建命令显示“请在终端使用”。
- 点击 `@ 文件` 或输入 `@` 搜索当前工作区文件，预览后点“引用到消息”插入真实文本。单次引用最多 24 KiB，超限显示提示，发送前可在输入框检查。
- 右侧“改动”读取实际 Git 状态，显示暂存、未暂存及未跟踪文件的差异；“文件”提供文本预览；“资源”显示可用模型、工具状态、命令与能力边界。模型选择会调用宿主；安装、认证与资源配置仍在终端完成。
- 会话操作显示已观测的完成、失败或取消。普通 prompt 和注册命令/skill/模板的分派回执仍只确认已交给 pi；不能据此推定执行成功。返回用户消息前会恢复其文本，已有未发送草稿会保留。

移动端以可关闭的抽屉打开会话与文件面板，中央对话继续保留图片、followUp、steer 和中止操作。标准对话框/审批、Plan/Goal/Agent 对应能力及终端退出后的交接属于后续 M3-C/D。

## 从其他设备访问（手机、平板）

默认只监听本机。外部访问需要**同时**满足三项，缺一项都不会启动：

1. 公共 HTTPS 地址：`--public-origin https://host[:port]`；
2. 访问密码：环境变量 `PI_PANE_PASSWORD`（至少 12 个字符；只从环境变量读取，不接受命令行或设置文件）；
3. 加密传输，二选一：
   - **同机 TLS 代理**（推荐），例如 Tailscale Serve：服务只监听回环，由代理提供 HTTPS/WSS。
     ```sh
     PI_PANE_PASSWORD='一个足够长的密码' pi
     /web --proxy --port 7878 --public-origin https://my-mac.tailnet-name.ts.net
     ```
     代理需把 `https://my-mac.tailnet-name.ts.net` 转发到 `http://127.0.0.1:7878`，并原样保留 `Origin` 和 `Sec-WebSocket-Protocol`（例如 `tailscale serve --bg 7878`）。
   - **直接 TLS**：`/web --host 0.0.0.0 --port 8443 --public-origin https://pane.example.com:8443 --tls-cert cert.pem --tls-key key.pem`。证书必须能被访问设备正常验证。

在任一设备打开终端给出的链接（或用 `/web qr` 扫码），再输入密码登录。链接本身不能直接连接会话；登录有效期 8 小时，可在网页“退出登录”，`/web --rotate` 或 `/web stop` 会撤销所有登录。连续输错会被限流。

## 配置

可在 pi 的 `settings.json` 中写默认值（命令参数 > 启动 flags > 设置 > 默认值）：

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

支持的字段：`host`、`port`、`noOpen`、`publicOrigin`、`tlsCert`、`tlsKey`、`proxy`。对应启动 flags：`--web-host`、`--web-port`、`--web-no-open`、`--web-public-origin`、`--web-tls-cert`、`--web-tls-key`、`--web-proxy`。密码不能写在设置里。配置本身不会自动启动服务；扩展只读设置，不改写。

## 主题

网页跟随 pi 当前主题，包括 Markdown、代码与 diff 配色。页面背景优先读取主题的 `export.pageBg`（支持 `vars` 引用），未提供时按深浅模式回退；面板、hover、代码背景和阴影由主题颜色在 OKLCH 空间推导。同名主题修改和仅修改 `export.pageBg` 都会自动同步。

包内提供 `pi-pane-dark` 和 `pi-pane-light`，在 pi 的 `/settings` → Theme 中选择。从源码以 `pi -e .` 加载时只加载扩展；要一起加载主题，可构建后用 `pi install .` 安装本地包。

网页专属样式可写入源码的 `public/pi-pane.css` 再构建，或直接编辑已安装包的 `web-dist/pi-pane.css` 并刷新网页，例如 `:root { font-family: "PingFang SC", system-ui, sans-serif; }`。它在应用样式之后加载；覆盖动态主题变量需使用 `!important`。文件随包更新可能被替换，请自行保留副本。

## 安全

- 网页的权限与终端相同：能发消息就能让 agent 执行命令。只把链接和密码给你自己的设备。
- 本机模式使用随机 token，放在链接的 `#` 后面，打开后即从地址栏清除。Host、Origin 精确校验，防 DNS rebinding 和跨站 WebSocket。
- Markdown 中的原始 HTML 不执行，链接只允许 http/https/mailto，模型输出里的远程图片只显示为链接，不加载。页面设置 CSP。

## 已知限制

1. 其他扩展弹出的对话框只能在终端处理，网页只提示有待处理的对话框；扩展自定义的 TUI 渲染在网页里退回通用卡片。
2. 关掉终端，网页就断开；后台运行不在当前范围内。
3. 普通消息及注册命令分派只能确认“已交给 pi”，无法逐条确认入队或失败原因；完整待发队列也看不到，只显示是否非空。M3 源码的会话操作另有已观测结果回执。
4. 多个浏览器都属于同一用户，都可以提交或中止；没有只读访客或多用户隔离。
5. 外部访问的代理路径以本地 TLS 反向代理验证，尚未用真实 Tailscale Serve 验证。
6. M3 源码的文件面板只读 UTF-8 文本并限制在当前工作区；预览/diff 最多 256 KiB，常见凭据文件和构建目录被排除。Git 面板要求当前 cwd 即仓库根目录，暂不展示父目录仓库。

## 开发与验证

```sh
npm ci
npm run build
npm run typecheck
npm test
```

端到端验收在临时目录中启动真实 pi TUI（PTY），使用本地确定性 provider，不调用远程模型。历史浏览器脚本使用 Playwright 驱动本机 Chrome；M3 桌面/移动端交互通过 CUA 另行验证。报告写入 `build-artifacts/`（不提交），真实模型试用单独记录。

| 脚本 | 内容 |
|---|---|
| `m0:smoke`、`m0:browser`、`m0:boundaries`、`m0:lifecycle`、`m0:projection`、`m0:performance` | 协议、生命周期、边界与性能（M0/M1） |
| `m1:render`、`m1:a6` | 渲染与内容安全、1,000 条消息基准 |
| `m2:images` | 图片上传与历史图片（A9） |
| `m2:external` | 外部访问、登录、二维码、移动端（A10/A11） |
| `m2:install` | npm 包内容与 `pi install` 安装（A11） |
| `m3:workbench` | pi 1.1.0 上的工作台读操作、明确命令与 skill/template 分派、会话生命周期、跨工作区、双端和重连 |

脚本需要指定构建产物，例如 `PI_M0_EXTENSION=./dist/extension/index.js npm run m3:workbench`；命令与证据边界见 [tests/README.md](tests/README.md)。

代码结构：`src/extension/`（Hub、Bridge、扩展入口、二维码）、`src/protocol/`（共享协议、校验、资源上限、reducer）、`src/web/`（网页）、`tests/`（单元测试与夹具）、`scripts/`（验收脚本）。
