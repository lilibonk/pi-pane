# M2 验收记录

> 后续更新：2026-10-09 的功能收尾和回归见 [M1/M2 功能收尾](m2-followup-status.md)。下文保留 M2 首轮验收结果；npm 发布与 gallery 状态仍为未执行。

记录日期：2026-10-08，Asia/Shanghai。分支 `m2`。本文件记录 M2 的实现范围、A9–A11 的本地验收证据与未完成项。证据目录 `build-artifacts/m2/final/` 不提交，按文末命令可复现。

**结论**：§13.1 的 A9、A10 本地验收通过；A11 中移动端与“干净环境安装、tarball 含静态资源”通过，**npm 发布与 pi.dev gallery 收录尚未进行**（需维护者发布，见“未完成项”）。M1 的“日常使用一周”反馈仍未开始。

> 本记录由 Claude Code 在本地仓库中生成。项目的 ChatGPT Space（`docs/project.json`）未同步更新。

## 环境

pi 1.0.4、Node 24.20.0、macOS 25.6.0 arm64（Apple M5，10 个逻辑 CPU，32 GiB）、系统 Chrome（Playwright headless）。真实 pi TUI 运行在 PTY 中，使用独立临时配置、空工作目录和本地确定性 provider（已声明支持图片输入，并记录收到的图片）；真实模型调用为 0。

## 实现范围

| 能力 | 实现 |
|---|---|
| 提交图片 | 粘贴、拖入、文件选择；PNG/JPEG/WebP，≤4 张、单张 ≤5 MiB、合计 ≤10 MiB、≤2,000 万像素。共享 `validateImages()` 校验规范 base64、文件结构（PNG IHDR CRC + IEND、JPEG SOF + EOI、WebP RIFF 长度与 VP8/VP8L/VP8X 头）与声明类型一致；浏览器另用 `createImageBitmap` 确认可解码；扩展在调用宿主前再校验一次。命令帧上限 16 MiB |
| 历史图片 | 快照与增量只带元数据（类型、字节数、宽高）；`image_page` 按消息 ID + 块序号定向读取（≤5 MiB，超出返回 `image_too_large`）。前端以 timeline 为根、600px 边距懒加载，最多 2 个并发，object URL 缓存 ≤48 MiB，按最近显示淘汰 |
| 外部访问 | `--public-origin https://…` + `PI_PANE_PASSWORD`（≥12 字符，仅环境变量）+ 直接 TLS（`--tls-cert/--tls-key`）或同机代理（`--proxy`，后端仅回环）；缺一项拒绝启动。bootstrap 链接 + 密码 → `POST /auth/session` 签发 8 小时会话 token（只存摘要），WS 只接受会话 token；精确 Host/Origin；到期定时关闭连接（4401）；退出登录；rotate/stop 撤销全部登录、租约与连接；失败登录按来源与全局限流；CSP 的 `connect-src` 为 `wss://` 公共 origin |
| 二维码 | `/web qr` 以终端组件显示公共链接二维码（字符串 widget 有 10 行上限，故用组件），终端过窄时提示；两分钟后、stop/rotate/会话结束时隐藏；本机模式拒绝。单测用 jsQR 把终端输出解码回原链接 |
| 移动端 / 列表 | 触屏 Enter 换行、按钮提交，按钮 ≥40px，输入框 16px，安全区；页面重新可见即重连；同标签页打开新链接（仅 hash 变化）会读取新 token。消息组件 memo；窗口化列表（跟随时挂载最新 200 条）；`ResizeObserver` 让贴底状态跟随估算高度与图片加载 |
| 发布准备 | 版本 0.1.0；`prepack` 先构建；tarball 52 个文件（packed 460 KB），含 `dist/`、`web-dist/`、README、设计文档；运行时依赖 `ws`、`qrcode-generator`；`docs/preview.png` 由 `scripts/m2-preview.mjs` 生成 |

## 冻结构建的回归

| 检查 | 结果 | 证据（`build-artifacts/m2/final/`） |
|---|---|---|
| TypeScript / 构建 | 通过 | `typecheck.log`、`build.log` |
| 单元测试 | 40/40 | `unit.log` |
| TUI / WS smoke | 21/21 | `smoke/smoke-report.json` |
| 真实 Chrome | 10/10 | `browser/browser-report.json` |
| 输入 / 快照 / 异步边界 | 22/22 | `boundaries/boundary-report.json` |
| 生命周期 / 配置 / 包安装 | 11/11 | `lifecycle/lifecycle-report.json` |
| idle custom / bash 投影 | 2/2 | `projection/report.json` |
| 渲染与内容安全 | 6/6 | `render/render-report.json` |
| A6 浏览器基准 | 2/2，WS→渲染 P95 46.6 ms | `a6/report.json` |
| 性能 / 背压（A5） | 3/3 | `perf/performance/report.json` |
| 主题（A7） | 4/4 | `perf/theme/report.json` |
| A9 图片 | 5/5 | `images/report.json` |
| A10 + A11 移动端 | 6/6 | `external/report.json`、`external/mobile.png` |
| A11 安装 | 3/3 | `install/report.json` |

lifecycle 中一条断言的期望文案随新配置错误信息更新（非回环 host 需配合 publicOrigin），拒绝行为本身不变。

## A9–A11

| 编号 | 场景 | 结论 | 证据 |
|---|---|---|---|
| A9 | 图片及大历史图片加载 | 通过 | 见下方 A9 数据 |
| A10 | 直接 TLS 与同机代理认证 | 通过（代理以本地 TLS 反向代理模拟） | 真实 TUI：`/web --host 0.0.0.0` 无外部配置、缺密码、缺传输、http origin 均拒绝且端口未监听；代理模式下 bootstrap 直接升级 401、错误密码统一提示、正确登录可提交 prompt、`/web status` 显示登录数；退出登录回到登录页；rotate 后旧会话 401、旧链接无法登录、新链接可登录；直接 TLS 下 HTTPS/WSS 可用、明文 HTTP 不提供、bootstrap 升级 401。单元测试另覆盖：配置组合拒绝、缺 Origin/错 Origin/错 Content-Type/超长 body、精确 Origin、过期会话定时关闭（4401）、租约不超过登录有效期、失败登录限流后正确密码也被 429 |
| A11 | 移动端、安装与发布 | 移动端与安装通过；**发布与 gallery 未做** | Pixel 7 视口（触屏）：登录、无横向溢出、Enter 换行、发送与 steer 按钮（高 40px+）送达 pi、断网（代理切断全部连接）后自动重连并沿用同一客户端租约。安装：`npm pack` 内容检查；本地 registry 提供 tarball（其余依赖代理到 npmjs）后 `pi install npm:pi-pane@0.1.0` 装入干净 agent 目录与 npm 缓存，4.5 s，仅 3 个运行时包，无 vite/playwright/preact 等开发依赖；已安装的包以 `--web` 启动，页面与 tarball 内 `web-dist/index.html` 一致，Chrome 中可提交并收到回复 |

### A9 数据

- 上传：同一条消息中粘贴 PNG、拖入 WebP、选择 JPEG（均为 Chrome canvas 编码的真实文件），provider 收到 3 张图片；浏览器中三张均加载并解码。
- 浏览器拒绝（未上传）：截断 PNG、>5 MiB、PNG 冒充 JPEG、5000×4001 WebP、GIF、结构完整但无法解码的 PNG、第 5 张图片，均显示明确错误。
- 扩展拒绝（绕过浏览器直接发 WS 命令）：类型不符、截断、非 base64、5 张 → `invalid_image`；超像素、>5 MiB → `image_too_large`；provider 调用次数不变。
- 大历史：160 条消息各带一张约 469 KiB 的噪声 PNG（合计 76.9 MB 原始字节）。重新加载后快照与首屏图片共 1.96 MB 帧数据，首屏只加载 3 张；从底部滚到顶部，163 张图片全部加载过，浏览器缓存峰值 50,064,071 字节（上限 48 MiB = 50,331,648），最大单帧 640,972 字符（一张图片）。
- 6.0 MiB 的历史图片显示“超过浏览器传输上限”；重新加载后附近图片再次按需加载，超限图片再次明确失败；零 pageerror。

## 本轮修复的问题（验收中发现）

1. `IntersectionObserver` 以视口为根时，内部滚动容器的裁剪使预加载边距失效 → 以 timeline 为根。
2. 粘贴与拖入并发调用附件校验可能绕过 4 张上限 → 串行处理。
3. `content-visibility` 的估算高度与图片使“贴底”失效，新快照后停在离底部数千像素处 → `ResizeObserver` 跟随。
4. 字符串 widget 最多 10 行，二维码被截断 → 改为组件。
5. 同一标签页打开新链接只改变 hash，页面不读取新 token → 监听 `hashchange`。
6. 大图片的 base64 正则回溯导致栈溢出 → 改为单字符类线性扫描。

## 未完成项与限制

1. **npm 发布与 gallery 收录**：`package.json` 仍为 `"private": true`，未发布；发布需维护者确认包名、许可证（目前未声明 `license`）与仓库地址，再 `npm publish`，并在发布后把 `pi.image` 设为预览图的公开 https 地址、核验 pi.dev 收录。
2. 代理路径以本地 TLS 反向代理（保留 Host、Origin、子协议）验证，未用真实 Tailscale Serve 验证；直接 TLS 的非回环绑定由单元测试与回环 TLS 覆盖，未在验收中绑定 0.0.0.0。
3. 登录 8 小时有效期在真实 TUI 中未等待验证，由单元测试以短有效期覆盖。
4. 测试浏览器以 `ignoreHTTPSErrors` 接受自签名证书；真实部署需要设备信任的证书。
5. 移动端为 Chrome 设备模拟（Pixel 7），未在真机与 iOS Safari 上手工验收。
6. 窗口化列表不是严格的虚拟列表：读者上滚或加载更早历史时窗口扩大，回到底部后收回。
7. M1 记录的已知限制（终端对话框、thinking 耗时、输入法真机验证等）仍然适用。

## 复现

```sh
npm ci
npm run build
npm run typecheck
npm test
F=build-artifacts/m2/final; E=./dist/extension/index.js
PI_M0_EXTENSION=$E PI_M0_REPORT_DIR=$F/smoke npm run m0:smoke
PI_M0_EXTENSION=$E PI_M0_REPORT_DIR=$F/browser npm run m0:browser
PI_M0_EXTENSION=$E PI_M0_REPORT_DIR=$F/boundaries npm run m0:boundaries
PI_M0_LIFECYCLE_EXTENSION=$E PI_M0_LIFECYCLE_REPORT_DIR=$F/lifecycle npm run m0:lifecycle
PI_M0_EXTENSION=$E PI_M0_PROJECTION_REPORT_DIR=$F/projection npm run m0:projection
PI_M1_REPORT_DIR=$F/render npm run m1:render
PI_M0_EXTENSION=$E PI_M1_REPORT_DIR=$F/a6 npm run m1:a6
PI_M0_EXTENSION=$E PI_M2_REPORT_DIR=$F/images npm run m2:images
PI_M0_EXTENSION=$E PI_M2_REPORT_DIR=$F/external npm run m2:external
PI_M0_EXTENSION=$E PI_M0_REPORT_DIR=$F/perf node scripts/m0-performance.mjs --skip-overload
PI_M2_REPORT_DIR=$F/install npm run m2:install   # 最后运行：npm pack 会重新构建
node scripts/m2-preview.mjs                       # 重新生成 docs/preview.png
```

需本机 Chrome、Python 3、POSIX PTY 与 `openssl`；`m2:install` 需要访问 npm registry 以获取运行时依赖。
