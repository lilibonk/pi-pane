# M1/M2 功能收尾验收记录

日期：2026-10-09，Asia/Shanghai。接续 `7497e90` 的 M1/M2 实现，开发分支 `codex/m2-followup`。本轮按维护者选择补齐功能缺口并回归，M3 未开始。

**结论**：本轮功能收尾与全部本地回归通过；实际发布、gallery 收录和日常试用反馈仍待维护者完成。

## 实现

| 缺口 | 本轮完成内容 |
|---|---|
| 主题背景与派生 | `theme.ts` 独立处理公开主题路径、`export.pageBg` 与嵌套 vars、IndexedColor / OKLCH / OKHSL；有界读取 ≤256 KiB，缓存文件指纹；缺失、损坏、超限时回退。背景、surface、hover、代码背景与阴影随主题变化，包含仅修改 export 的热更新 |
| 包内主题与网页覆盖 | 提供 `pi-pane-dark` / `pi-pane-light`，通过 `pi.themes` 声明。`public/pi-pane.css` 构建后原样复制，安装后可编辑 `web-dist/pi-pane.css` 并刷新；不扫描工作目录，不扩展静态文件访问范围 |
| edit 按词 diff | 字面文本渲染，支持中文、emoji、空白和多行替换；区分文件头和 hunk 中以 `+++` / `---` 开头的内容。128 KiB、每侧 2,048 token、每补丁累计 250,000 匹配格的预算，超限回退行级着色 |
| thinking 耗时 | 通过宿主 thinking start/end 事件和单调时钟观测，每段独立计时；running 不带递增时长，结束后显示秒数，中断标明已观测时长。重连及同消息持久化保留，未知历史不补算，canonical 改写思考文本时撤销不再可信的耗时 |
| 文档与预览 | 更新协议和主题设计、README 安装状态与使用说明、测试说明、预览图及本地项目元数据 |

主题与计时已拆出独立模块。`snapshot.ts` / `commands.ts` / `auth.ts` 的纯结构拆分未纳入本轮；窗口、命令和认证仍归属 Bridge / Hub，与 design §11 当前结构一致。

## 本地回归

环境：pi 1.0.4、Node 24.20.0、macOS Darwin 25.6.0 arm64、Apple M5（10 核 / 32 GiB）、系统 Chrome。真实 pi 运行于隔离 POSIX PTY，provider 全部为本地确定性夹具，真实模型调用为 0。

证据目录：`build-artifacts/m2/followup/`（gitignored）。新增 24 项单元测试。最终前端修正后重新构建并重跑受影响的浏览器验收；后端验收后源码未变。

| 检查 | 结果 | 证据 |
|---|---|---|
| 类型检查 / 构建 | 通过 | `typecheck.log`、`build.log` |
| 单元测试 | 64/64 | `unit.log` |
| TUI / WS smoke | 21/21 | `smoke/smoke-report.json` |
| Chrome | 10/10 | `browser/browser-report.json` |
| 输入 / 快照 / 异步边界 | 22/22 | `boundaries/boundary-report.json` |
| 生命周期 / 配置 / 独立安装 | 11/11 | `lifecycle/lifecycle-report.json` |
| idle custom / bash 投影 | 2/2 | `projection/report.json` |
| 渲染、词级 diff、思考耗时与内容安全 | 7/7 | `render/render-report.json` |
| A6 长历史浏览器基准 | 2/2，20 次测量的 P95 47.9 ms | `a6/report.json` |
| A5 性能 / 背压 / 大结果 | 3/3，单独复测的全部本地性能守卫通过 | `perf/performance/report.json` |
| A7 主题 | 5/5 | `perf/theme/report.json` |
| A9 图片 | 5/5 | `images/report.json` |
| A10 / A11 外部访问与移动端模拟 | 6/6 | `external/report.json` |
| A11 安装、包内主题与 CSS 覆盖 | 4/4 | `install/report.json` |

首轮性能采样与独立安装存在并行，Bridge-only 的 generation 比例为 1.52、event-loop P95 增量为 48.2 ms，触发本地探索性守卫。保留原始报告于 `perf-first/`。其他测试退出后单独复测，四种 pane 配置的 generation 比例为 0.81–0.93、event-loop P95 增量均为负，全部守卫通过；不据此声称 pane 加速宿主，三轮中位数不构成统计置信结论。

主题仅修改 export 的端到端同步为 171.5 ms，同名颜色热更新均小于 1 秒。thinking 边界验收确认 running 重连以及结束后再次重连保留相同耗时，快照读取不会推进计时。桌面与移动端截图保存在 `render/` 和 `external/`。

安装首轮暴露夹具固定 `--no-themes`，导致包主题发现被关闭；新增显式 `loadThemes` 选项，仅安装验收开启，默认隔离规则保留。修正后真实 pi 可选中两个包内主题，浏览器背景跟随；安装目录中的 CSS 修改后刷新生效。原始失败报告保留于 `install-first/`。最后 prepack 重建后，56 个构建文件与 `build-manifest.json` 的 SHA-256 全部一致。

## 尚需维护者或真实环境完成

- npm 发布、许可证和 pi.dev gallery 收录仍未执行，`private: true` 保留。2026-10-09 已创建 [GitHub 公开仓库](https://github.com/lilibonk/pi-pane)，并配置 package 的仓库、问题反馈与公开预览图地址。
- 一周日常使用反馈、真实 Tailscale Serve、iOS Safari / 真机、真实 OS 输入法，以及 Windows / pnpm / 其他宿主版本验证仍未完成。
- 4 MiB 无换行文本过载仍属历史宿主诊断项，本轮沿用 `--skip-overload`，未声称已解决。
- thinking 观测耗时不写入宿主会话文件；分支重置、扩展重载或进程重启后不回填历史耗时。
- 本地项目状态已更新，ChatGPT Space 的旧页面未自动同步；M3/M4 不属于本轮范围。

## 复现

```sh
npm ci
npm run build
npm run typecheck
npm test
F=build-artifacts/m2/followup; E=./dist/extension/index.js
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
node scripts/m2-preview.mjs
PI_M2_REPORT_DIR=$F/install npm run m2:install
```

性能 / A6 采样应单独运行，避免并行安装和其他测试负载。`m2:install` 必须最后单独执行，因为 prepack 会重新构建；Chrome、Python 3、POSIX PTY、openssl 与 npm 网络访问的要求同 M2。
