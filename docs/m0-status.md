# M0 验收结论

记录日期：2026-10-08，Asia/Shanghai。M0 已完成：Q1–Q10 的运行证据、结论与能力降级已记录，核心一致性缺陷已修复，冻结后的构建回归通过。本机纯文本 Spike 可作为 M1 的输入；M1 尚未开始，不代表 M1/M2 发布验收通过。

[项目 Space](https://chatgpt.com/space/page_6ac669a979c48191a25f7d5411b378f6) 保存立项与资料索引，[M0 执行计划与跟进](https://chatgpt.com/space/page_6ac66a64d11c8191bbcc2dc63d862e09) 是任务状态唯一来源。本文件保存技术结论与可复现证据。

## 环境与最终回归

pi 1.0.4、Node 24.20.0、macOS 25.6.0 arm64、Apple M5（10 个逻辑 CPU、32 GiB 内存），系统 Chrome 的 Playwright headless 控制。真实 pi TUI 在 48×180 PTY 中运行，使用独立临时配置、空工作目录、环境白名单和本地确定性 provider。真实模型调用为 0，没有读取或继承用户模型凭据。

最终集成均加载 dist/extension/index.js；性能/主题专项加载相同冻结源码，报告保存生产文件哈希。更早报告保留为过程证据，以 final/ 下报告和专项最终报告为当前结论。

| 检查 | 冻结构建的结果 | 本地证据 |
|---|---|---|
| 构建 / TypeScript | 通过 | build-artifacts/m0/validation-report.json；dist、web-dist |
| 单测 | 23/23 | 协议、Hub、Bridge、配置及补充投影 |
| TUI / WS smoke | 21/21；6 次连接、1,029 条连续增量 | build-artifacts/m0/final/smoke/smoke-report.json |
| 真实 Chrome | 10/10，零 pageerror；390px 无横向溢出 | build-artifacts/m0/final/browser/browser-report.json |
| 输入 / 快照 / 异步边界 | 22/22；8 次连接、1,202 条连续增量 | build-artifacts/m0/final/boundaries/boundary-report.json |
| 生命周期 / 配置 / 包安装 | 11/11；真实 npm 消费者 | build-artifacts/m0/final/lifecycle/lifecycle-report.json |
| idle custom / bash | 2/2；184/276ms；ID 与 epoch 一致 | build-artifacts/m0/final/projection/report.json |
| 主题专项 | 4/4；8 次主按钮对比度 ≥4.5 | build-artifacts/m0/theme/report.json |
| 性能与资源专项 | 3 项资源检查通过，另有各组 3 轮量测；过载未计作通过 | build-artifacts/m0/performance/report.json |
| 依赖审计与打包 | audit 0 项已知漏洞；包入口/资源及独立安装通过 | build-artifacts/m0/baseline-report.json |

## Q1–Q10 技术结论

| 问题 | M0 结论 | 证据与边界 |
|---|---|---|
| Q1 重绑与回收 | 通过 | 正常 reload/new/resume/fork；移除、导入错误、12 秒加载延迟均约 10 秒回收 WS/端口，不因迟到启动复活，显式 /web 可恢复 |
| Q2 提交与回执 | 通过 | 草稿、同文本多端、followUp/steer、真实输入消费/转换、无模型、缺认证与 provider 错误；dispatched 始终只代表宿主调用 |
| Q3 主题 | 通过，保留模拟边界 | 公开 setTheme、同名直接/原子覆写、appearance/default token、system PTY 协议；更新 225–274ms。8 次 Chrome 主按钮对比度 6.408–12.589；未实测桌面 OS/终端设置切换，网页背景按 appearance 派生 |
| Q4 性能与背压 | 有界 Spike 范围通过 | 256 KiB×3 轮、0/4/8 端对照、暂停 TCP 接收后的真实高水位回收、2 MiB×16 partial 预览、1,000 条历史窗口；4 MiB/4,096 更新未完成，不计通过，长期泄漏与 M1 A5/A6 未验收 |
| Q5 slash | 通过 | 网页 slash、模板、skill 为字面输入，无命令副作用；真实终端模板/skill 正向展开已验证，宿主 input hook 仍生效 |
| Q6 非 TUI | 通过 | 真实 print/json/rpc 拒绝 --web，无监听且正常退出；不构造 Bridge/Hub |
| Q7 快照与最终内容 | 有界预览范围通过 | 文本/thinking/工具参数/partial 中途接入和重连、同文本身份、另一真实扩展替换最终消息；compact/custom/bash 在线同步已修复。完整内容引用、分页及分块未实现，移交 M1 |
| Q8 旧操作与分支 | 通过 | tree 成功/取消/摘要失败恢复屏障；旧 prompt/abort/model/compact 拒绝；input/model/compact 与 new 的真实竞态不向新 epoch 发旧结果；已进入宿主的操作不保证撤回 |
| Q9 去重与队列 | 通过，租约用短 TTL 验证 | 实际未读 ACK、重连查询与重复只调用宿主一次；冲突、淘汰高水位、Hub 重启、复制标签页、短 TTL；终端入队/清空 62/61ms 收敛，未真实等待 30 分钟 |
| Q10 配置与安装 | 通过，配置只读 | 公开设置读取与可信项目合并、命令/flags 优先级、坏配置下 stop/status/rotate、端口冲突、IPv6、多实例、缺 API、宿主并发保存保留自定义字段、独立 npm 消费者加载 tgz；无任意字段公开 writer/崩溃原子保存，pnpm 隔离未验收 |

## 性能实测与限制

固定 256×1,024 字节流、每次 1ms yield，预热后每组 3 轮；相同 provider、PTY 消费、证据写入和宿主进程采样。量测为 provider 生成耗时；事件循环延迟是进程内 histogram 的单轮 P95，表中列各轮中位数，不是浏览器首屏应用 P95。

| 配置 | 生成耗时中位数 | 相对无 pane | 各轮事件循环 P95 的中位数 |
|---|---:|---:|---:|
| 无 pane | 1,442ms | 基线 | 24.49ms |
| Bridge，Hub 未启动 | 1,470ms | +1.89% | 25.90ms |
| Hub，0 个 viewer | 1,542ms | +6.87% | 27.33ms |
| 4 个 viewer | 1,457ms | +1.04% | 26.44ms |
| 8 个 viewer | 1,484ms | +2.89% | 26.38ms |

本地探索守卫为生成中位耗时增幅 ≤25%、事件循环 P95 增幅 ≤10ms；本轮满足。三轮不能给出统计置信结论，也不等于设计 A6 的 20 次浏览器快照应用验收。

停止一个真实 WS 的 TCP 接收，再发送 48 个合法的约 400 KiB 快照重读请求，同时继续 256 KiB 生成。Hub 在约 51ms 请求 close(1013, slow_client)，约 1 秒后强制回收；观察峰值 bufferedAmount 1,736,587 字节，另 3 端持续读取且序号连续。客户端最终观察到 1006 属于强制回收，不冒充完整 close 握手，也不是浏览器网络进程冻结测试。

2 MiB×16 工具 partial 的 wire 预览保持 2,048 字符（封装另有元数据），但宿主明显停顿：匹配对照的无 pane / 3 个读取端工具执行为 4,202 / 4,125ms，事件循环 P95 为 282 / 271ms，RSS 峰值约 1.145 / 1.160 GiB。该单次观测支持宿主/fixture 本身存在巨大 partial 成本，不能以有界 wire 证明交互性能良好。

4 MiB 无换行文本/4,096 更新曾在 120 秒内未完成，已保留失败证据。匹配的 20 秒无 pane / 4 端 CPU profile 也均未完成，推进约 1.30 / 1.16 MB；约半数 CPU 样本位于 pi-TUI 的 breakLongWord，另有 Markdown、wrap 和 GC 成本。该过载不计作通过，后续须改善宿主长行处理或调整真实输出数据集。短期 RSS 和窗口测试不证明长期无泄漏。

1,000 条历史仅验证投影保留 200 条、439,395 字节快照；Node WS 重读约 21ms 含 harness 轮询，不是完整历史或浏览器应用指标。

## 本轮修复与能力降级

修复了 IME composition Enter、复制标签页租约争抢、reload 状态栏旧回调、空 system 消息、主题变量、主按钮前景对比度和 native color-scheme；新增配置校验、坏配置下服务撤销、IPv6 重复启动与公开 API 检测。compact 成功新增的历史标记、idle 可见 custom 消息和 !/!! bash 输出现可在线同步，不必刷新。正文、错误、输出和图片占位共享单消息文本预算；隐藏消息、opaque entry 数据和 bash 内部文件路径不发送。

M0 上限为消息 200 条/512 KiB、每消息文本 32,768 字符、工具最多 64 项（完成项保留目标 32）、单工具值预览 2,048 字符、快照帧 1 MiB、每端发送缓冲 2 MiB、租约最多 8 个。超限明确截断或关闭连接。

没有 snapshot_chunk、history_page、content_page、完整内容引用恢复、Markdown/diff、图片或远程访问；引用与 delta 的版本衔接移至 M1。终端对话框仍在终端回答。IME 仅模拟 DOM composition；system/default 颜色通过真实 PTY 的确定性协议回复验证，不是桌面 OS/终端设置 UI 实测，网页背景由 appearance 派生。短 TTL 测试没有实际等待 30 分钟，Windows PTY 与跨宿主版本未验证。

pi.getSettings() 可读取宿主合并后的 piPane 配置；无任意字段公开 writer，因此扩展只读、不自动保存。官方已知字段的 lock+reread merge 并发测试保留 piPane，但不是崩溃原子替换。包运行已验证独立 npm 消费者与 pi/pi-ai/pi-tui 1.0.4、ws 8.22.0；不承诺 pnpm 隔离布局。

dispatched 仅表示调用宿主；sendUserMessage 返回 void，不能确认成功、入队或最终结果。队列只同步布尔值，未确认提交不自动重发，已进入宿主的操作不保证撤回。

## 移交与跟进

M0-01 至 M0-06 已关闭，任务状态和 M1 建议已写回现有 Space。M1 应先完成分页/分块/内容版本、长列表与真实浏览器性能验收，再扩展 Markdown/diff；M2 再处理图片与外部访问。两小时跟进任务 pi-pane-m0-space 保持暂停；本轮三个子智能体已完成，没有后台常驻子智能体。

## 复现

```sh
npm ci --ignore-scripts
npm run build
npm run typecheck
npm test
PI_M0_EXTENSION=./dist/extension/index.js PI_M0_REPORT_DIR=build-artifacts/m0/final/smoke npm run m0:smoke
PI_M0_EXTENSION=./dist/extension/index.js PI_M0_REPORT_DIR=build-artifacts/m0/final/browser npm run m0:browser
PI_M0_EXTENSION=./dist/extension/index.js PI_M0_REPORT_DIR=build-artifacts/m0/final/boundaries npm run m0:boundaries
PI_M0_LIFECYCLE_EXTENSION=./dist/extension/index.js PI_M0_LIFECYCLE_REPORT_DIR=build-artifacts/m0/final/lifecycle npm run m0:lifecycle
PI_M0_EXTENSION=./dist/extension/index.js PI_M0_PROJECTION_REPORT_DIR=build-artifacts/m0/final/projection npm run m0:projection
npm run m0:performance
```

需本机 Chrome、Python 3 和 POSIX PTY；详见 tests/README.md。报告与脱敏日志不含访问 token，临时配置已删除，原始生成目录已加入 .gitignore。
