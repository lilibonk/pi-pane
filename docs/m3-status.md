# M3 交接工作台状态

更新：2026-10-10，Asia/Shanghai。当前分支：`main`。本次 0.2.0 发布候选以 `d5cd02d` 为基线，包含下述发布前修复，已通过确定性回归、真实模型试用和精确包安装。日常 pi 已改为加载本地 0.2.0 候选；公共 npm 仍为 0.1.0，尚未发布 0.2.0 或推送本次改动。

维护者的 [M3 调整说明](m3-codex-adjustment.md) 已完整阅读并作为本次范围：`/web` 先正常退出 TUI，同进程留在前台提供网页服务，单个 `pi --mode rpc` 子进程是唯一会话写入者。Ctrl+C 停止服务并打印最新会话恢复命令，关闭终端同时结束服务；镜像路径、内部命令网关、nonce 与跨 Bridge 写屏障删除。

对齐基线不变：`@moonshot-ai/kimi-code@2.1.1`，官方 commit `242ac230006447f8601e1678c49182bfbae89fe9`。参照证据在 `build-artifacts/kimi-alignment/current/`；前台交接与 8 项原型验证见 [spike 记录](m3-handoff-spike.md)。原型只证明可行，不直接发布。

## 当前实现与能力边界

| 范围 | 交接实现 | 验收状态 |
|---|---|---|
| 工作台 | 保留三栏、移动端抽屉、文件引用、fork 草稿恢复与只读 Git | `38152e1` CUA 19/19（1280/390px）；审阅修正后未复跑 CUA |
| 交接入口 | `/web` 仅空闲、无队列的保存 TUI 会话可交接；退出后启动 Hub/Bridge/RPC | 正式 PTY 交接长时模式 15/15 通过 |
| 会话目录 | 宿主 list/listAll、当前与最近目录 LRU、按 cwd 分组搜索、只接受目录 ID | 本次候选工作台 RPC 16/16；CUA 19/19 属于 `38152e1` |
| 会话写入 | RPC new/switch/rename/clone/fork，成功重建 RPC 会话视图/Bridge；当前标记自动更新 | 本次候选工作台 RPC 16/16；CUA 19/19 属于 `38152e1` |
| 分支 | get_entries 重建只读树；只从用户消息之前 fork，返回 text，已有草稿保留 | tree 导航明确禁用，需要 pi RPC 支持 |
| 命令/模型 | get_commands、get_available_models、set_model、thinking 可用等级与切换 | 边界 22/22、浏览器 10/10 与工作台 16/16 通过 |
| 输入语义 | RPC 展开扩展/skill/template；网页保留并拦截内置名称，不支持的显示原因 | 前端专项及 RPC 集成通过 |
| 工具资源 | 资源面板显示缺少 RPC 工具查询/启停接口 | 禁用，未开私有通道 |
| 扩展 UI | 四种对话框、取消/超时/重连/竞争回答；status/widget/title/editor text/notify | 本次候选单元/正式交接/边界通过；CUA 属于 `38152e1` |
| 文件与 Git | 查询根跟随当前会话 cwd，保留穿越/符号链接/编码/有界只读规则 | 工作台跨 cwd 回归通过 |
| 唯一写入者 | 只由 `/web` 获取的协作会话 sidecar 锁；写入前后核对会话文件只追加子进程自身条目；停止后释放 | 本次候选长时模式 15/15，含 130 秒对话框 |
| 崩溃 | 子进程异常停止服务，不自动重启；宿主死亡依靠 stdin EOF 结束子进程 | 本次候选长时模式 15/15 通过 |
| 外部访问 | M2 HTTPS/代理+密码，交接横幅二维码，网页凭据轮换 | 本次候选外部访问 6/6；轮换 CUA 属于 `38152e1` |

会话锁只协调 `/web` 宿主；普通 TUI 不加锁，打开被宿主持有的会话时只提示。上游裸 pi 不遵守它；外部写入检测不是阻止任何程序写文件的 OS 锁。macOS/Linux 提供交接实现，Windows 未验证且明确拒绝；具体运行平台证据按下面实际结果记录。

标准扩展 UI 不包含任意 TUI custom 组件；模型认证、持久资源安装/启停、MCP 配置及 Plan/Goal/Agent 的 pi 执行语义尚未完成。关闭终端后存活、后台常驻、实时 attach 不在本次范围。

## 本次验证

本次候选证据目录为 `build-artifacts/releases/0.2.0/`。类型检查、生产构建和单元测试 **136/136** 通过，日志见 `build-checks.json`、`typecheck.log`、`build.log`、`test.log`。确定性回归使用临时 HOME、agent/session/workspace 和本地 provider，远程模型调用为 **0**，不读取日常认证。

完整矩阵 **125/125，14 组**：smoke 22、浏览器 10、生命周期 9、边界 22、投影 2、渲染 7、A6 2、图片 5、外部访问 6、正式交接长时模式 15、工作台 16、性能 3、初始主题 2，另加精确候选包安装 4。`regression/summary.json` 保存前 13 组 **121/121** 的实际结果及源码/构建 SHA-256；安装证据独立保存于 `install/report.json`。本次未重跑旧 19 项 CUA，不能把它们计入新版验收。

| 检查 | 本次候选状态 | 证据（相对本次候选目录） |
|---|---|---|
| 类型检查/构建/完整单元 | 通过，136/136 单元 | build-checks.json 与对应日志 |
| 确定性 M0–M3 矩阵 | 125/125，14 组通过（含安装 4 项） | regression/summary.json；install/report.json |
| 性能/初始主题 | 3/3 与 2/2；性能每配置 3 轮 | regression/m0/performance/report.json；regression/m0/theme/report.json |
| A6 浏览器首快照 | 20 次，WS → render P95 48.2 ms | regression/m1/a6/report.json |
| 正式交接生命周期及长时对话框 | PI_M3_LONG=1，15/15；130 秒后回答有效 | regression/m3/handoff-long/report.json |
| M3 工作台 RPC | 16/16 | regression/m3/workbench/report.json |
| 桌面/移动端 CUA | 未复跑；`38152e1` 旧证据 19/19 | 历史 build-artifacts/m3/handoff/browser-report.json |
| 真实 provider | 5/5，新获限定授权 | real-model/report.json；real-model/browser.png |
| 冻结候选安装 | 4/4；精确 tgz 经本地模拟 registry 安装 | install/report.json |
| 清理 | runner HOME、25 个报告引用的 fixture 根、临时认证引用均已清理 | regression/summary.json；real-model-cleanup.json |
| 日常插件来源 | 已切换本地 0.2.0；自动发现、交接与确定性回复通过 | daily-install.json |
| 公共 npm 发布及正式安装 | 未执行；npm whoami 返回 E401，需维护者重新登录发布 | 发布后再验证公共 registry 安装 |

性能在 macOS arm64 / Node 24.20.0 / pi 1.1.0 的隔离环境单独执行，源码和构建产物在测试前后 SHA-256 一致。相同 256 KiB RPC writer 工作负载每配置 3 轮，0/4/8 viewer 耗时中位数约 **331/324/320 ms**，writer event-loop P95 中位数约 **11.05/10.94/10.83 ms**。暂停客户端以 1013/slow_client 回收，其他 3 个读取端继续工作；2 MiB 工具结果可经 17 页完整读取；历史快照 200 条，可分页取回全部 1,228 条。

20 秒 overload 诊断中，裸 TUI 在截止时处理 1,383,424 B/4 MiB，未完成；4-viewer RPC 完成 4 MiB 用时约 2.31 秒。保留未完成结果，跨模式比较不作为完整压力验收通过。CPU/RSS/event-loop 只测 RPC writer，独立 Hub 的完整前缀校验 I/O 和资源开销未单独计量，不能由本次数据推断 pi-pane 总开销；长期 production soak 尚未执行。A6 以 1,000 条/912,000 字符/无图片数据集采样 20 次，P95 **48.2 ms** 不外推到大图片、浏览器启动或远程网络。

真实试用加载同一候选解包目录，使用日常 pi 1.1.0 的 Node CLI 与 `qwen-token-plan-cn/qwen3.7-max`，在隔离 HOME、会话与工作区执行 3 次短提示、一次 builtin bash；工具运行中刷新/重连，最终与 fresh canonical snapshot 一致，0 page/protocol errors，**5/5** 通过。临时 agent 以 symlink 引用用户新获授权的本地认证，wrapper 不读取或复制认证内容；试用后临时目录/链接已删除，原凭据仍为 0600。授权仅用于这次限定试用，不扩展为后续自动读取日常凭据。`submittedPrompts=3` 不等于 provider 请求/计费次数，短试用不证明长期稳定性。

`integrity-verification.json` 确认候选 tgz、仓库与日常解包安装中的 83 个包文件逐字节一致，131 个回归源码和构建哈希仍匹配。冻结候选：`build-artifacts/releases/0.2.0/candidate/lilibonk-pi-pane-0.2.0.tgz`，SHA-256：

```text
5bba224d3b106139ee56614e5ec83079ba97f324a56bfc11c29a0656177f2eb0
```

日常 pi 已通过 `pi remove` / `pi install` 切换为 `/Users/zile.zhou/.pi/agent/local/pi-pane/0.2.0-5bba224d3b10`。只有该包来源变更，其余 settings 哈希保持不变。隔离 HOME 复用相同相对来源及实际日常 pi 1.1.0 CLI，未显式 `-e` 加载 pane，自动发现、`/web` 与确定性回复通过，0 协议错误且临时资源已清理；此检查单列，不计入 125 项矩阵。已打开的 pi 需重启后加载新版。这是同一候选的本地安装，公共 npm 仍为 0.1.0；本地安装和真实试用不替代发布后 registry 完整性与安装验证。发布准备汇总见 `build-artifacts/releases/0.2.0/release-readiness.json`。

`38152e1` 的 CUA 覆盖实际 Git diff/文件引用、模型/thinking、四类扩展对话框与 UTF-8 超限、移动端抽屉/嵌套模态焦点和 inert、重命名/当前标记/跨 cwd、用户 fork、空分支 clone 失败后继续对话、已保存分支 clone、第二浏览器竞争回答、待处理对话框刷新、慢流 partial 刷新及凭据轮换后本页刷新。审阅修正未改网页源码，但没有重跑这 19 项实际交互。普通未发送草稿不跨全页面刷新保存。

`38152e1` 阶段的首次 CUA 发现空分支 fork 后 clone 的正常 RPC 失败误触发宿主退出，保留 `browser-clone-first.png`/`.txt` 和 `cua-empty-fork-clone-failure/` 诊断；修复路径别名误判后增加工作台第 16 项回归，并实际重测失败后服务保持连接/下一条消息成功和已保存分支 clone 成功。移动端 steer 被 CSS 隐藏及模型重复选项也已修复并在最终 CUA 重测。

旧慢流重连超时在交接模式重新跟踪；保留原报告，不据新模式的一轮通过推定旧超时根因已定位。失败时保留脱敏终端、provider events、client 快照/近期帧，复跑记录与初次失败分开。


## 审阅修正（2026-10-10）

`d5cd02d` 对 `38152e1` 的审阅在真实 TUI + RPC 子进程中复现了两个会意外关闭网页服务的问题，并按维护者决定收窄了会话锁。以下保留当时修正记录；文件校验与超时路径的进一步修正见下一节：

| 问题 | 修正 | 验证 |
|---|---|---|
| 扩展在回复结束后异步写入会话（如 300 ms 后 `pi.appendEntry`），下一次网页写入被误判为外部冲突，服务停止 | 宿主不再只在特定事件后认可文件变化；写入前和每轮写入后核对新增的完整行都是子进程 `get_entries` 报告的条目（id 与类型），文件只增长且已接受内容末尾未变；未完成的末行留到下次 | 单元（追加、未完成行、未知条目/空行/截断/改写、文件替换）；正式交接“延后写入”检查，3 轮均执行且无冲突 |
| 扩展对话框 120 秒未回答（或扩展命令运行超过 120 秒），RPC 请求超时后停止子进程 | 只有只读查询有超时（默认 30 秒），超时只让该次查询失败；prompt、会话切换、压缩等不设超时，由中止、回答/取消或 Ctrl+C 结束 | 单元（慢查询不停子进程、写请求无超时）；`PI_M3_LONG=1` 正式交接中对话框 130 秒后回答仍生效，15/15 |
| 每个 TUI 打开会话即加锁，冲突时关闭 TUI；残留 guard 需手动删除 | 只有 `/web` 加锁，加不上则拒绝交接、TUI 保持打开；普通 TUI 不加锁，打开被 `/web` 宿主持有的会话只提示；guard 在持有进程退出或超过 30 秒后自动回收 | 单元（guard 回收、只读 inspect）；正式交接“两个普通 TUI 共用会话”“被提示的 TUI 保持打开且其 `/web` 被拒绝” |

## 发布候选补充修正（2026-10-10）

发布前复核继续发现会话文件校验与读取超时的边界，候选在 `d5cd02d` 基础上修正，并新增 7 项单元测试：

| 问题 | 本次候选行为 |
|---|---|
| 只校验最后 4 KiB，可能漏掉更早的同长度改写；原子替换可能绕过截断检查 | 对全部已接受前缀按固定大小分块计算 SHA-256；更换 inode 后仍要求保留完整前缀；追加条目与子进程报告的完整对象深比较 |
| ownership 的 get_entries 查询超时被误认为失去写入所有权，停止服务 | 区分只读超时；仅拒绝依赖该结果的本次操作，保留子进程和原校验基线，后续操作可重新查询；实际冲突仍停止服务 |
| 增量读取超时隐式重试、全量刷新失败丢失刷新意图 | 超时不立即发起第二次读取；失败后保留全量刷新标记，让后续事件或操作读取最终持久化内容 |

上述修正由 136/136 单元、125/125 确定性矩阵与同一候选的 5/5 真实模型试用覆盖。19 项 CUA 未重跑，继续保留为历史证据。

## 迁移与退役

0.2.0 不兼容 0.1.0：去掉 `--web` 启动，TUI 不再并行，网页 slash 改为 RPC 展开，回执使用实际 disposition。README 已写迁移说明。

删除 `/web handoff`、stop/status/qr/--rotate 与 `--mirror`；配置 `--web-*` 保留。二维码直接在外部交接横幅打印，网页资源提供轮换。旧 TUI/网页双写、扩展 rebind、终端主题热切换及 tree 导航测试按交接定义退役；当前矩阵保留消息/安全/分页/图片/性能与失败恢复覆盖。详情见 [测试说明](../tests/README.md)。

## 已保存的历史证据

`d5cd02d` 的审阅修正曾记录 129/129 单元和独立报告 124/124 确定性检查；该轮未重跑 CUA 与真实模型。旧 `build-artifacts/m3/handoff/regression-matrix.json`、`validation.json` 仍为 `38152e1` 的 122/121 汇总；本次候选使用独立 release 目录，未覆盖这些旧结果。`38152e1` 的真实模型 5/5 也继续保留，其授权与本次授权分别记录。

原 `codex/m3-workbench` 已先提交为 **`6196c7b`**，再从它创建 `codex/m3-handoff` 合并 `spike/m3-handoff` 为 **`38152e1`**，后续审阅修正提交为 **`d5cd02d`**。这些提交现已包含在 `main`；已合并的本地开发分支与 spike worktree 已清理，原型证据保留在 `build-artifacts/m3-spike/`。历史状态可用 `git show 6196c7b:docs/m3-status.md` 查看，历史证据目录 `build-artifacts/m3/workbench/` 和 `build-artifacts/m3/smoke/` 保留。

原工作台最终记录为 92/92 单测、21/21 smoke、15/15 TUI/WS、22 项 CUA、0 console errors；均针对镜像/网关架构，不作为交接版验证。原慢流重连超时 `report-reconnect-first.json` 缺少足够原始证据，原因未定位；其他通过复跑没有证明它的原因。

已发布 0.1.0 的 pi 1.1.0/Qwen3.7 Max/公共 npm 安装验收也保持原结论，仅属于该版，不能替代新源码的真实 provider 和安装流程。

## 后续边界与发布

本次候选开发、确定性验收、限定真实模型试用和日常本地版本切换已完成；新版 CUA 19 项未复跑，公共 npm 发布与发布后正式安装验证尚待维护者执行。当前 npm 登录返回 E401，需要重新登录。

维护者在仓库根目录登录后，可发布已验证的精确候选包：

```sh
npm publish build-artifacts/releases/0.2.0/candidate/lilibonk-pi-pane-0.2.0.tgz --access public
```

发布后核对公共 registry 的版本与 tarball integrity，再通过 `PI_M2_PUBLISHED_TARBALL` 完成公共 npm 安装验证；确认后将日常本地来源切换为 `npm:@lilibonk/pi-pane@0.2.0`。本次尚未执行 npm 发布或 Git 推送。

工具列表/启停与 tree 导航仍等待 pi 公开 RPC 支持；任意扩展 custom TUI 与 Plan/Goal/Agent 等执行语义需另行设计。继续收集日常稳定性反馈，短试用不替代长期观察。
