# M1 验收记录

记录日期：2026-10-08，Asia/Shanghai。分支 `m1`。本文件记录 M1 的实现范围、A1–A8 验收证据与已知限制。证据目录 `build-artifacts/m1/final/` 不提交，按文末命令可复现。

**结论**：§13.1 中 M1 的 A1–A8 均有通过的本地证据，M1 可进入“日常使用一周”的反馈阶段（§12 的第二项完成标准，尚未开始）。M2（图片、外部访问、发布）未开始。

> 本记录由 Claude Code 在本地仓库中生成。项目的 ChatGPT Space（`docs/project.json`）未同步更新，需要时请另行回写。

## 环境

pi 1.0.4、Node 24.20.0、macOS 25.6.0 arm64（Apple M5，10 个逻辑 CPU，32 GiB）、系统 Chrome（Playwright headless）。真实 pi TUI 运行在 PTY 中，使用独立临时配置、空工作目录和本地确定性 provider；真实模型调用为 0。

## 实现范围

| 能力 | 实现 |
|---|---|
| 历史 | 快照携带最近 200 条 / 768 KiB 的持久化消息与全部活动消息，附 `olderCursor`；只读 `history_page` 以 entry ID 为游标向前取页（每页 ≤768 KiB） |
| 超长内容 | 单条消息共享 32,768 字符内联预算，超出的块保留索引并附 `total`；只读 `content_page` 按 128K 字符读取完整原文；edit 的 patch 作为 `diff` 块 |
| 传输 | 逻辑帧 >1 MiB 时拆成 `frame_begin` / `frame_chunk` / `frame_end`，同步入队不交错；逻辑帧上限 8 MiB；每连接发送缓冲 8 MiB，超出以 1013 `slow_client` 回收 |
| 增量 | 分支投影按 leaf 缓存，不再每个 token 读取整条分支；消息更新 16ms 合并为追加式 `msg_delta` ops，工具 partial 50ms 合并；`agent_state` 不再携带工具列表 |
| 共享 reducer | `applyProjectionEvent` 同时用于浏览器和全部集成测试客户端 |
| 渲染 | GFM Markdown（DOMPurify 清洗、原始 HTML 转义、仅 http/https/mailto 链接、图片改为链接）；Shiki 按需加载语法，配色映射 pi 的 syntax token；工具调用与结果合并为 bash/read/write/edit/grep/find/ls 专用卡片，edit 显示 diff；压缩分隔线；“加载全部”与“加载更早的消息” |
| 主题 | 发布全部解析后的 pi token 为 `--pi-*` CSS 变量，Markdown、diff、工具卡片和代码高亮均由其驱动 |
| 浏览器内存 | 前端历史上限 16 MiB；实时增长时淘汰最旧持久化消息并前移游标，向上加载超限则拒绝并提示 |
| 体积 | 首屏 JS 124 KB（gzip 44 KB）；Shiki 核心（gzip 36 KB）和各语法均为懒加载 chunk |

## 冻结构建的回归

| 检查 | 结果 | 证据 |
|---|---|---|
| TypeScript / 构建 | 通过 | `final/typecheck.log`、`final/build.log` |
| 单元测试 | 31/31 | `final/unit.log` |
| TUI / WS smoke | 21/21 | `final/smoke/smoke-report.json` |
| 真实 Chrome | 10/10 | `final/browser/browser-report.json` |
| 输入 / 快照 / 异步边界 | 22/22 | `final/boundaries/boundary-report.json` |
| 生命周期 / 配置 / 包安装 | 11/11 | `final/lifecycle/lifecycle-report.json` |
| idle custom / bash 投影 | 2/2 | `final/projection/report.json` |
| 渲染与内容安全 | 6/6 | `final/render/render-report.json` |
| A6 浏览器基准 | 2/2 | `final/a6/report.json` |
| 性能 / 背压（A5） | 3/3，另含 0/4/8 端各 3 轮对照 | `final/perf/performance/report.json` |
| 主题（A7） | 4/4 | `final/perf/theme/report.json` |

冻结后修复了一处前端问题（流式增长的超长块在展开后不再显示过期全文，改为提示重新加载），随后重跑渲染 6/6 与真实 Chrome 10/10：`final/render-postfix/`、`final/browser-postfix/`。

## A1–A8

| 编号 | 场景 | 结论 | 证据 |
|---|---|---|---|
| A1 | 生成/工具执行中首次接入、刷新、断线重连 | 通过 | smoke：生成中首次 `/web`、重连恢复活动消息且身份不重复、工具 partial 跨重连；browser：刷新后恢复真实流；boundaries：thinking 与工具参数在流式中途重连 |
| A2 | new/resume/fork/reload/tree，含失败和取消 | 通过 | smoke：reload/new/fork/resume、tree 成功与取消；lifecycle：禁用、导入失败、12 秒慢重建均在期限内释放端口；boundaries：摘要失败恢复屏障 |
| A3 | 两个浏览器与 TUI 同时输入、中止、切模型 | 通过 | smoke：两端同文本不合并、followUp/steer 顺序、中止；boundaries：模型切换与会话替换竞态不进入新 epoch |
| A4 | 无模型、认证失败、输入被消费、压缩期间提交、丢 ack | 通过 | boundaries 22 项；browser：丢 ACK 显示“结果未知”且不重发 |
| A5 | 超长历史、巨大工具输出、慢客户端 | 通过 | 见下方 A5 数据 |
| A6 | 1,000 条消息、≤1 MiB 文本，20 次测量 P95 ≤1 秒 | 通过，P95 48.2 ms | 见下方 A6 数据 |
| A7 | 主题、队列、输入法 | 通过（输入法为模拟） | theme 4/4（更新 173–254 ms）；boundaries：TUI 入队/清空同步布尔队列；browser：中文 composition 期间 Enter 不提交 |
| A8 | 错 token/Origin/Host、恶意 Markdown、非法帧、路径穿越 | 通过 | smoke：错误 token/Origin/Host 在升级前拒绝、rotate 断开旧连接；render：原始 HTML 不执行、`javascript:`/`data:` 链接被移除、远程图片不请求；单元：非法信封/游标/偏移、静态资源路径穿越与错误 Host |

### A5 数据

- 暂停 TCP 读取的客户端在服务端缓冲峰值 8,354,375 字节（上限 8 MiB）时以 `slow_client` 回收；另 3 个读取端序号连续、保持连接，TUI 正常收敛。
- 16 × 2 MiB 工具 partial：线上输出尾部 ≤8,192 字符，完成后 `outputTotal` 为完整长度；对应 toolResult 的 2,097,158 字符通过 17 次 `content_page` 读完，耗时 360 ms，与原文一致。
- 1,000 条 × 2 KiB 历史（分支共 1,226 条可见消息）：快照窗口 200 条；3 次 `history_page` 走到分支起点，耗时 64 ms，无重复身份；所有传输帧 ≤1 MiB。快照重读中位数 21 ms（Node 客户端，含测试轮询）。
- 宿主开销（256 KiB 固定输出，各 3 轮中位数，相对无 pane）：Bridge 未启动 +4.3%、Hub 无连接 −0.7%、4 端 −7.2%、8 端 +0.3%；事件循环 P95 差值 −4.0 ~ +1.8 ms。均在本地守卫（≤25%、≤10 ms）内；三轮不构成统计置信结论。

### A6 数据

数据集：1,000 条可见 custom 消息，每条 912 字符，合计约 0.91 MB 文本，无图片。同一 Chrome 标签页加载 20 次（首次通过 `/web` 链接，之后 reload 复用会话租约）。

| 指标 | min | P50 | P95 | max |
|---|---:|---:|---:|---:|
| WS 打开 → 快照渲染完成 | 42.2 ms | 47.3 ms | **48.2 ms** | 48.3 ms |
| 页面导航 → 快照渲染完成（另记） | 62.3 ms | 63.2 ms | 63.6 ms | 92.1 ms |

“渲染完成”为快照提交后下一个动画帧的 `pi-pane:snapshot-rendered` 标记。随后在同一页面逐页加载全部历史，1,000 条消息全部渲染，用时 189 ms。

## 已知限制

1. 其他扩展的对话框仍只能在终端处理；扩展自定义的 TUI 渲染在网页中退回通用卡片。
2. thinking 未显示耗时（`MessageView` 不含时间戳）。
3. 长列表使用 `content-visibility: auto` + 16 MiB 历史上限，没有实现窗口化虚拟列表；A6 规模下无需。
4. 正在流式生成的超长块可以展开，但内容继续增长后需重新加载；“加载全部”主要面向已结束的消息。
5. 输入法仍以 DOM composition 事件模拟验证，未做真实 OS 输入法手工验收；Windows PTY、pnpm 隔离布局、跨宿主版本未验证。
6. M0 已记录的 4 MiB 无换行文本过载问题属宿主 pi-TUI 长行处理成本，本轮以 `--skip-overload` 跳过，未重新诊断。
7. 代码结构未按 §11 原计划拆出 `snapshot.ts` / `commands.ts` / `auth.ts` / `theme.ts`，相应逻辑仍在 `bridge.ts` 与 `hub.ts`。

## 复现

```sh
npm ci --ignore-scripts
npm run build
npm run typecheck
npm test
F=build-artifacts/m1/final; E=./dist/extension/index.js
PI_M0_EXTENSION=$E PI_M0_REPORT_DIR=$F/smoke npm run m0:smoke
PI_M0_EXTENSION=$E PI_M0_REPORT_DIR=$F/browser npm run m0:browser
PI_M0_EXTENSION=$E PI_M0_REPORT_DIR=$F/boundaries npm run m0:boundaries
PI_M0_LIFECYCLE_EXTENSION=$E PI_M0_LIFECYCLE_REPORT_DIR=$F/lifecycle npm run m0:lifecycle
PI_M0_EXTENSION=$E PI_M0_PROJECTION_REPORT_DIR=$F/projection npm run m0:projection
PI_M1_REPORT_DIR=$F/render npm run m1:render
PI_M0_EXTENSION=$E PI_M1_REPORT_DIR=$F/a6 npm run m1:a6
PI_M0_EXTENSION=$E PI_M0_REPORT_DIR=$F/perf node scripts/m0-performance.mjs --skip-overload
```

需本机 Chrome、Python 3 与 POSIX PTY；详见 `tests/README.md`。
