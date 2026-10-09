# M3 交接工作台状态

更新：2026-10-10，Asia/Shanghai。实现分支：`codex/m3-handoff`，源码 `0.2.0` 尚未发布。正式 npm 与日常安装仍为 `npm:@lilibonk/pi-pane@0.1.0`，本次没有替换日常安装或执行 npm 发布。

维护者的 [M3 调整说明](m3-codex-adjustment.md) 已完整阅读并作为本次范围：`/web` 先正常退出 TUI，同进程留在前台提供网页服务，单个 `pi --mode rpc` 子进程是唯一会话写入者。Ctrl+C 停止服务并打印最新会话恢复命令，关闭终端同时结束服务；镜像路径、内部命令网关、nonce 与跨 Bridge 写屏障删除。

对齐基线不变：`@moonshot-ai/kimi-code@2.1.1`，官方 commit `242ac230006447f8601e1678c49182bfbae89fe9`。参照证据在 `build-artifacts/kimi-alignment/current/`；前台交接与 8 项原型验证见 [spike 记录](m3-handoff-spike.md)。原型只证明可行，不直接发布。

## 当前实现与能力边界

| 范围 | 交接实现 | 验收状态 |
|---|---|---|
| 工作台 | 保留三栏、移动端抽屉、文件引用、fork 草稿恢复与只读 Git | CUA 19/19 通过（1280/390px） |
| 交接入口 | `/web` 仅空闲、无队列的保存 TUI 会话可交接；退出后启动 Hub/Bridge/RPC | 正式 PTY 交接 12/12 通过 |
| 会话目录 | 宿主 list/listAll、当前与最近目录 LRU、按 cwd 分组搜索、只接受目录 ID | 工作台 RPC 16/16 与 CUA 19/19 通过 |
| 会话写入 | RPC new/switch/rename/clone/fork，成功重建 RPC 会话视图/Bridge；当前标记自动更新 | 工作台 RPC 16/16 与 CUA 19/19 通过 |
| 分支 | get_entries 重建只读树；只从用户消息之前 fork，返回 text，已有草稿保留 | tree 导航明确禁用，需要 pi RPC 支持 |
| 命令/模型 | get_commands、get_available_models、set_model、thinking 可用等级与切换 | 边界 22/22、浏览器 10/10 与工作台 16/16 通过 |
| 输入语义 | RPC 展开扩展/skill/template；网页保留并拦截内置名称，不支持的显示原因 | 前端专项及 RPC 集成通过 |
| 工具资源 | 资源面板显示缺少 RPC 工具查询/启停接口 | 禁用，未开私有通道 |
| 扩展 UI | 四种对话框、取消/超时/重连/竞争回答；status/widget/title/editor text/notify | 单元/正式交接/边界及 CUA 通过 |
| 文件与 Git | 查询根跟随当前会话 cwd，保留穿越/符号链接/编码/有界只读规则 | 工作台跨 cwd 回归通过 |
| 唯一写入者 | 协作会话 sidecar 锁；检测空闲期外部文件变化；停止后释放 | 正式交接 12/12 通过 |
| 崩溃 | 子进程异常停止服务，不自动重启；宿主死亡依靠 stdin EOF 结束子进程 | 正式交接 12/12 通过 |
| 外部访问 | M2 HTTPS/代理+密码，交接横幅二维码，网页凭据轮换 | 外部访问 6/6 与轮换 CUA 通过 |

会话锁只协调加载 pi-pane 的 TUI/宿主。上游裸 pi 不遵守它；外部写入检测不是阻止任何程序写文件的 OS 锁，运行期间任意外部写入不能完全归因。macOS/Linux 提供交接实现，Windows 未验证且明确拒绝；具体运行平台证据按下面实际结果记录。

标准扩展 UI 不包含任意 TUI custom 组件；模型认证、持久资源安装/启停、MCP 配置及 Plan/Goal/Agent 的 pi 执行语义尚未完成。关闭终端后存活、后台常驻、实时 attach 不在本次范围。

## 本次验证

开发依赖为 pi / pi-ai 1.1.0。确定性矩阵使用临时 HOME、agent/session/workspace 目录和本地 provider，远程模型调用为 **0**，不读取日常认证。另行执行的真实模型试用使用本次用户明确授权的本地认证引用，结果独立记录。证据目录为 `build-artifacts/m3/handoff/`。

类型检查、生产构建与完整单元测试 **121/121** 通过；其中前端 builtin 拦截、fork 草稿恢复、editor revision 和 ANSI 展示检查 7/7。交接版集成已通过 smoke 22、边界 22、生命周期 9、浏览器 10、投影 2、渲染 7、A6 2、图片 5、外部访问 6、干净包安装 4、正式交接 12、工作台 16 项。性能 3/3 和初始主题 2/2 也通过，确定性矩阵共 **122/122，14 组**。CUA **19/19** 通过（1280/390px，0 console errors），最终 PID/端口/fixture/private access/锁清理通过。以上均为实际结果，定义数量不作为通过数量。

| 检查 | 状态 | 证据/命令 |
|---|---|---|
| 类型检查/构建/完整单元 | 通过，121/121 单元 | npm run typecheck / build / test |
| 确定性 M0–M3 交接矩阵 | 122/122，14 组通过 | regression-matrix.json 与各脚本报告 |
| 性能/初始主题 | 3/3 与 2/2 通过 | m0/performance/report.json；m0/theme/report.json |
| A6 浏览器首快照 | 20 次，WS → render P95 47.8 ms | m1/a6/report.json |
| 正式交接生命周期 | 12/12 通过 | m3:handoff，build-artifacts/m3/handoff/report.json |
| M3 工作台 RPC | 16/16 通过 | m3:workbench，handoff/workbench/report.json |
| 桌面/移动端 CUA | 19/19 通过，0 console errors | browser-report.json；browser-desktop.png、browser-mobile.png、browser-mobile-dialog.png |
| 新源码真实 provider | 5/5 通过，单独用户授权 | m2/real-model/report.json + browser.png |
| 干净包安装 | 4/4 通过，本地 tarball | m2:install，不等于 npm 发布 |
| 清理 | 通过 | cleanup.json，CUA/首次失败的 PID/端口/fixture/private access/锁已清理 |
| npm 发布 | 未执行 | 由维护者执行 |

性能在 macOS arm64 / Node 24.20.0 / pi 1.1.0 的隔离环境执行：相同 256 KiB RPC writer 工作负载在 0/4/8 viewer 时为约 307/312/305 ms，writer event-loop P95 约 10.84–10.96 ms；暂停客户端以 1013/slow_client 回收且 3 个读取端继续工作，2 MiB 工具结果可经 17 页完整读取，历史快照 200 条且可完整分页。此次 `--quick` 每配置只有一次观测，CPU/RSS/event-loop 只测 RPC writer，未测独立网页宿主；TUI 与 RPC 的耗时比不能解释为 pi-pane 开销。未执行 20 秒 overload 或长期 production soak。A6 另以 1,000 条/912,000 字符/无图片数据集在本机 Chrome 采样 20 次，WS open → snapshot rendered P95 47.8 ms；不外推到大图片、浏览器启动或远程网络。

真实试用为 pi 1.1.0 / `qwen-token-plan-cn/qwen3.7-max`，3 次短提示、一次 builtin bash，工具运行中刷新/重连后与 fresh canonical snapshot 一致，0 page/protocol errors，5/5 通过。临时 agent 通过 `auth.json` symlink 引用用户仅为此次试用授权的本地认证；harness 不读取或复制认证内容，模型子进程使用该认证。试用后临时目录/链接已删除，原凭据仍为 0600。`submittedPrompts=3` 不等于 provider 请求/计费次数；短试用不证明一周稳定性或真实设备外部访问。

CUA 覆盖实际 Git diff/文件引用、模型/thinking、四类扩展对话框与 UTF-8 超限、移动端抽屉/嵌套模态焦点和 inert、重命名/当前标记/跨 cwd、用户 fork、空分支 clone 失败后继续对话、已保存分支 clone、第二浏览器竞争回答、待处理对话框刷新、慢流 partial 刷新及凭据轮换后本页刷新。普通未发送草稿不跨全页面刷新保存。

首次 CUA 发现空分支 fork 后 clone 的正常 RPC 失败误触发宿主退出，保留 `browser-clone-first.png`/`.txt` 和 `cua-empty-fork-clone-failure/` 诊断；修复路径别名误判后增加工作台第 16 项回归，并实际重测失败后服务保持连接/下一条消息成功和已保存分支 clone 成功。移动端 steer 被 CSS 隐藏及模型重复选项也已修复并在最终 CUA 重测。

旧慢流重连超时在交接模式重新跟踪；保留原报告，不据新模式的一轮通过推定旧超时根因已定位。失败时保留脱敏终端、provider events、client 快照/近期帧，复跑记录与初次失败分开。

## 迁移与退役

0.2.0 不兼容 0.1.0：去掉 `--web` 启动，TUI 不再并行，网页 slash 改为 RPC 展开，回执使用实际 disposition。README 已写迁移说明。

删除 `/web handoff`、stop/status/qr/--rotate 与 `--mirror`；配置 `--web-*` 保留。二维码直接在外部交接横幅打印，网页资源提供轮换。旧 TUI/网页双写、扩展 rebind、终端主题热切换及 tree 导航测试按交接定义退役；当前矩阵保留消息/安全/分页/图片/性能与失败恢复覆盖。详情见 [测试说明](../tests/README.md)。

## 已保存的历史证据

`codex/m3-workbench` 已先提交为 **`6196c7b`**，再从它创建 `codex/m3-handoff` 合并 `spike/m3-handoff`。历史状态可用 `git show 6196c7b:docs/m3-status.md` 查看，历史证据目录 `build-artifacts/m3/workbench/` 和 `build-artifacts/m3/smoke/` 保留。

原工作台最终记录为 92/92 单测、21/21 smoke、15/15 TUI/WS、22 项 CUA、0 console errors；均针对镜像/网关架构，不作为交接版验证。原慢流重连超时 `report-reconnect-first.json` 缺少足够原始证据，原因未定位；其他通过复跑没有证明它的原因。

已发布 0.1.0 的 pi 1.1.0/Qwen3.7 Max/公共 npm 安装验收也保持原结论，仅属于该版，不能替代新源码的真实 provider 和安装流程。

## 后续边界与发布

本轮交接迁移、回归、真实模型试用、CUA 与清理已完成，没有待执行的性能或清理事项。

1. 工具列表/启停与 tree 导航等待 pi 公开 RPC 支持；任意扩展 custom TUI 与 Plan/Goal/Agent 等执行语义需另行设计。
2. 继续收集日常稳定性反馈；短试用不替代长期观察，本次认证授权不扩展为自动读取日常凭据。
3. 维护者评审并执行 0.2.0 npm 发布；迁移说明与本地干净安装已准备，本地 pack/安装不代替发布，日常 0.1.0 保持原来源。
