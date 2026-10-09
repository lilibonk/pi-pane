# M2 真实环境试用与发布计划

更新：2026-10-09，Asia/Shanghai。兼容性试用分支 `codex/pi-1.1-trial`；本次发布分支 `codex/npm-release`。

本轮按维护者调整后的顺序推进：先验证 pi 1.1.0 并接入日常终端，再用真实模型走通完整链路，修复试用问题后发布，稳定后进入 M3。之前的确定性 provider 验收保留为回归证据，不能替代真实模型试用。

## 执行顺序与完成条件

| 顺序 | 工作 | 完成条件 | 当前状态 |
|---|---|---|---|
| 1 | pi 1.1.0 兼容性、日常加载 | 类型与关键 TUI/浏览器回归通过；日常配置加载包，实际启动可发现 `/web` | 通过，日常配置自动加载已实测 |
| 2 | 真实模型全链路试用 | `/web`；终端与网页各发消息且共享同一历史；真实工具执行；运行中刷新与重连后恢复且不重复提交 | qwen-token-plan-cn / qwen3.7-max，5/5 通过 |
| 3 | 修复、npm 发布与正式安装 | 记录并修复可复现试用问题；受影响回归通过；MIT 许可证；正式 npm 发布；干净配置和缓存从正式 registry 安装并验证；核验 gallery 收录 | `@lilibonk/pi-pane@0.1.0` 已公开发布；正式干净安装 5/5、日常 npm 包真实试用 5/5；gallery 暂未可见 |
| 4 | 稳定后推进 M3 | 完成上述验证、发布与安装；补齐一周日常反馈并收敛阻断问题；按 design §12 单独设计交接模式 | 尚未开始 |

“稳定”需有试用记录与问题关闭证据；不得由一次确定性测试或一次真实模型对话直接推定。M3 的唯一写入者、关闭终端后存活、所有权交还与崩溃恢复门槛继续适用。

## 当前环境与验证

- 日常 `pi --version`：1.1.0；Node 24.20.0；macOS arm64。
- 项目开发依赖仍保留 pi 1.0.4，以维护原有回归基线；通过 `PI_M0_CLI` 选择本机 1.1.0 进行额外兼容验证。
- 现有 extension/protocol 使用本机 1.1.0 的宿主类型检查：0 diagnostics；公开 ExtensionAPI/Context 无破坏性差异。
- 构建与项目类型检查通过，单元测试 64/64。1.1.0 确定性 provider 回归：smoke 21/21、Chrome 10/10、边界 22/22、生命周期 11/11；实际模型调用为 0。
- 兼容验证阶段曾安装本地包；发布后已通过 `pi install npm:@lilibonk/pi-pane@0.1.0` 切换为正式 npm 包，并移除本地来源。`pi list` 确认只加载这一份 pi-pane；以后正常启动 pi 自动加载，已有进程可 `/reload`。已核对日常安装 lock 的公共 registry 来源、版本和 integrity，证据为发布目录的 `daily-install.json`。
- 维护者已通过 pi 登录 qwen-token-plan-cn / qwen3.7-max，`pi auth check --json --no-refresh` 返回 ready；验收使用正常认证加载，不显示或复制密钥。
- 维护者已选择 MIT，已补 LICENSE 与元数据，真实模型试用通过后移除 `private`，现已正式发布 0.1.0。
- npm 账号 `lilibonk` 已登录并启用 2FA。首次发布被 E403 拒绝（需 2FA）；维护者启用后完成浏览器验证，第二次发布进一步被 npm 拒绝：`pi-pane` 与已有 `pipane` 名称太相近。采用 npm 建议的公开 scope 包 `@lilibonk/pi-pane`，产品与 GitHub 仓库仍叫 pi-pane。

## 正式发布与安装（2026-10-09）

发布证据目录：`build-artifacts/m2/npm-release/`。实际发布的冻结包为 `release/lilibonk-pi-pane-0.1.0.tgz`：62 文件，470,559 bytes，含 MIT LICENSE、扩展、网页、主题，不含凭据、源码测试或脚本。与上一轮非 scope 候选逐文件比较，只有 package.json 的包名以及 README / design 的安装名称改变，其他 59 文件完全一致；证据为 `release/scoped-candidate-comparison.json`。`npm publish --dry-run` 通过；摘要见 `release/scoped-validation.json`。

两次拒绝分别记录在 `release/publish-error.log` 和 `release/publish-interactive.log`（脱敏）。scope 发布通过浏览器认证且退出 0，npm 提示处理需几分钟；处理中两轮查询/安装曾返回 404，分别保留于 `install-published-processing-first/` 和 `install-published-processing-second/`。随后公共 registry 的版本元数据、安装用 metadata 和 tarball 均返回 200，integrity 与冻结发布包完全一致；正式版本为 [@lilibonk/pi-pane@0.1.0](https://www.npmjs.com/package/@lilibonk/pi-pane)，发布于 2026-10-09 15:20（Asia/Shanghai），MIT。证据见 `release/published-metadata.json`、`release/scoped-validation.json`。

正式安装脚本新增 `PI_M2_PUBLISHED_TARBALL` 模式：跳过重新打包，核验公共 npm 元数据及 lock 的版本、来源、integrity，再用空 npm 配置和全新 HOME / agent dir / cache 安装。已修正 scope 包的 registry 路径及安装目录层级；scope 模拟安装 4/4 通过，Chrome 验证静态资源、对话、刷新恢复及重连后继续发消息、两个包内主题和 CSS 覆盖。证据为 `install-scoped-simulated/report.json`。scope 的生命周期回归 11/11 通过（`lifecycle-scoped/lifecycle-report.json`），独立消费者实际安装、宿主 1.1.0 加载和对话均通过。公共 registry 首轮实际安装成功、扩展也已启动，但 macOS `/var` → `/private/var` 别名让 npm 写入相对路径 lock key，导致验收脚本断言失败（`install-published-lock-first/`、`install-published-debug/`）。安装前统一真实路径后，仍严格核验标准 lock key、版本、公共来源和 integrity；正式干净安装复跑 **5/5 通过**，证据为 `install-published/report.json`。运行代码与发布包保持不变。

正式公开后于 2026-10-09 15:22（Asia/Shanghai）通过正常 Chrome 核验 [精确 scope gallery 查询](https://pi.dev/packages?name=%40lilibonk%2Fpi-pane)，仍显示 0 条匹配。公开元数据的 `pi.image` 返回 200 image/png。gallery 尚未可见，独立于已通过的 npm 发布；[官方 package 文档](https://pi.dev/docs/latest/packages) 未给固定索引时间。证据为 `gallery/status.json`，处理期查询另存 `gallery/status-processing.json`。

首轮新版验收受旧脚本 `lastChangelogVersion: 1.0.4` 影响，启动变更日志遮住自动启动地址。已改为读取所选 CLI 的实际版本，安装和运行也统一宿主；修正后关键回归全部通过，首轮失败证据保留于 `*-first/`。生命周期独立消费者安装的 pi / pi-ai 均为 1.1.0。

| 检查 | 结果 | 证据 |
|---|---|---|
| 1.1.0 宿主类型 | 8 个 extension/protocol 文件，0 diagnostics | `types/report.json` |
| TUI / WS | 21/21，确定性 provider | `smoke/smoke-report.json` |
| Chrome | 10/10，确定性 provider | `browser/browser-report.json` |
| 异步与输入边界 | 22/22，确定性 provider | `boundaries/boundary-report.json` |
| 生命周期 / 独立宿主安装 | 11/11，确定性 provider | `lifecycle/lifecycle-report.json` |
| 干净环境模拟 registry 安装 | 4/4，安装与启动均为 1.1.0 | `install/report.json` |
| 正常日常配置 + 真实模型 | 5/5，三条合成输入，bash 执行计数为 1 | `real-model/report.json`、`real-model/browser.png` |
| 启动阶段中断清理 | SIGINT 后约 5.2 秒退出，提交模型输入 0 条 | `cancel-startup/cancellation-check.json` |

真实模型首轮已完成双端回复和工具最终输出，但脚本等待已完成工具卡的可见输出时忽略了默认折叠状态，造成假失败。修正为先核对保留文本，再展开卡片验证；复跑后 5/5 通过，原报告保留在 `real-model-first/`。本轮未发现需要修改产品代码的可复现问题。

独立复核后进一步补强验收脚本：统计整个临时会话的所有工具，严格要求唯一 bash 及完整命令一致；取消改为可中断轮询并等待任务落定后清理，处理迟到资源。最终再次真实验收 5/5 通过，之前的通过报告保留于 `real-model-second/`；启动 SIGINT 检查确认没有提交模型输入。

上表兼容与初次试用证据目录：`build-artifacts/m2/pi-1.1-trial/`（gitignored）。发布后的正式安装 5/5、scope 生命周期 11/11、npm 包真实模型 5/5 分别在 `build-artifacts/m2/npm-release/install-published/`、`lifecycle-scoped/`、`real-model/`。所有验收记录必须区分确定性 provider 与真实模型调用。

## 试用记录

2026-10-09 的真实模型试用已完成：正常全局包发现启动 `/web`，终端与网页各发一轮；随后网页请求一次真实 bash，运行中刷新后保留客户端租约，结果和计数均保留；最后 fresh canonical snapshot 与在线共享 reducer 完全一致，三条输入各一份、工具调用及结果各一份，页面与协议错误为 0。首轮与两次复跑共提交九条合成输入；这不是 provider 请求数或计费次数。

正式 npm 包额外复跑真实模型 5/5 通过（`build-artifacts/m2/npm-release/real-model/report.json`、`browser.png`）：本轮三条合成输入，唯一 bash 执行一次，运行中刷新保留租约，fresh snapshot 与 reducer 一致，无重复输入/工具和页面/协议错误。此前九条加本轮三条共十二条合成输入；不代表 provider 请求数或计费次数。

一周日常使用反馈仍未完成；实际日常任务中如发现问题，继续记录日期、pi/provider/model、复现步骤、预期与实际、修复及复验。当前短试用通过不代表长期稳定。

## 复现

```sh
npm run build
npm run typecheck
npm test
PI_M0_CLI=/Users/zile.zhou/.pi/agent/install/releases/1.1.0/node_modules/@earendil-works/pi-coding-agent/dist/cli.js \
PI_M0_EXTENSION=./dist/extension/index.js \
PI_M0_REPORT_DIR=./build-artifacts/m2/pi-1.1-trial/smoke npm run m0:smoke
```

浏览器与边界脚本分别使用 `m0:browser` / `m0:boundaries`，并设置各自证据目录。生命周期使用 `PI_M0_LIFECYCLE_EXTENSION` / `PI_M0_LIFECYCLE_REPORT_DIR`，打包时使用 `--ignore-scripts`，不重建。`m2:install` 默认模式内含 prepack 重建，须在其他使用构建产物的套件结束后单独执行。正式 registry 模式设置 `PI_M2_PUBLISHED_TARBALL` 指向冻结包，跳过 pack/prepack，具体命令见 tests/README.md。
