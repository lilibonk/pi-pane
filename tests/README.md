# Verification

`npm test` exercises runtime schema validation, Hub leases and command deduplication, transport sequencing, lifecycle cleanup and Bridge boundaries. The Hub tests open short-lived loopback listeners with synthetic session state; they do not run a model.

`npm run m0:smoke` runs the selected pi CLI in a real POSIX PTY and connects real WebSocket clients. Current development dependencies use pi 1.1.0; the original M0/M1 reports used 1.0.4. It needs Node.js, Python 3 and a built project. The fixture provider emits deterministic local text and a local streaming echo tool; it has no network request implementation. `PI_OFFLINE=1`, an environment allowlist, a task-owned HOME, working directory and `PI_CODING_AGENT_DIR` keep the run separate from user packages, sessions and authentication.

```sh
npm run build
npm run m0:smoke
PI_M0_EXTENSION=./dist/extension/index.js PI_M0_REPORT_DIR=./build-artifacts/m0-dist npm run m0:smoke
```

Optional `PI_M0_CLI` selects an explicit `pi-coding-agent/dist/cli.js`. `PI_M0_EXTENSION` selects the source or built extension. `PI_M0_REPORT_DIR` selects the evidence directory. Defaults use project-local dependencies and `src/extension/index.ts`.

The selected CLI's package supplies the actual host version. Fixture settings, lifecycle consumer installation and A11 package installation follow that selection. `PI_M0_CLI` can select a different explicit host; the install command and installed-package startup use the same CLI. M3 workbench acceptance specifically asserts pi 1.1.0.

The smoke report lists each executed check and explicit uncovered branches. A passing report means those checks passed; it does not mean all M0 questions or M1 acceptance criteria are complete. The test covers TUI text entry, preservation of an unsent draft, multiple browser clients, prompt/steer/followUp, partial text and tool snapshots, reconnect, abort, tree cancellation/navigation, runtime reload/new/fork/resume, stale commands, duplicate IDs, local handshake checks, stop/restart and token rotation. Fork/resume/tree targets are selected through fixture commands that call the real command-context APIs; their built-in selection dialogs are not automated.

The focused integration scripts use the same isolation rules:

```sh
npm run m0:lifecycle
npm run m0:boundaries
npm run m0:projection
npm run m0:performance
```

`m0:lifecycle` tests actual extension removal, syntax errors, a 12-second extension factory delay against the real 10-second rebind deadline, settings precedence, concurrent official settings writers, port conflicts, multiple pi instances and an independent npm consumer of the packed extension. The consumer pins pi and pi-ai to the selected CLI's version; this does not verify pnpm's isolated dependency layout or npm publication. The extension reads settings only; preservation by the host's locked merge writer does not prove crash-atomic saving.

`m0:boundaries` loads another real extension to consume/transform inputs, discover a template and a skill, replace a finalized message, open a terminal dialog and fail local summarization. It also checks thinking/tool-argument reconnects, positive TUI template/skill expansion controls, TUI queue consumption/dequeue, unread receipt recovery, and session replacement while input/model hooks or compaction are pending. The compact-success check compares the attached client's history with a fresh canonical snapshot, including the compaction marker. No-model and missing-authentication checks use isolated host preflight; the controlled provider error has no outbound network request.

`m0:projection` checks visible custom messages added by an idle extension and actual TUI `!printf` output. Connected viewers receive the changes without a model turn or resync; hidden custom messages and opaque entry data remain absent. Reconnected snapshots retain the same message IDs and epoch. Unit regressions also cover combined text/error/output limits.

`m0:performance` compares a fixed workload with no pane, Bridge only, Hub with no viewers, and four/eight WebSocket viewers. Measurements are taken inside the host process. Provider generation, browser application latency, host process memory and pane cache bounds are distinct metrics. Three rounds are an exploratory comparison, not a production P95 claim. Theme tests use public `setTheme`, same-name file rewrites and PTY terminal-color responses; they do not verify a desktop OS theme switch.

Reports contain synthetic fixture messages, a redacted terminal transcript and JSON event evidence. Browser tokens are used only in memory for the test connection and are redacted before writing terminal logs. Processes, sockets and temporary test configuration are closed on completion. The PTY harness currently supports macOS/Linux; Windows PTY behavior is not verified.

Prompt receipts are dispatch-only even when a hook consumes input or the host later fails preflight. Race checks prove stale-command rejection and that old completions do not enter a replacement epoch; they do not claim to undo host operations that already began. Lease expiration and receipt-cache eviction use the existing short-TTL Hub integration tests instead of waiting 30 minutes in the TUI harness. All fake-provider calls remain local; no real authentication credentials or model service is used.

## M1 additions

The M0 harnesses remain the regression suite and now speak the M1 protocol: their WebSocket clients reassemble `frame_begin`/`frame_chunk`/`frame_end` and apply events through the shared `applyProjectionEvent` reducer from `dist/protocol`, the same code the browser uses. Build before running them.

```sh
npm run build
npm run m1:render
npm run m1:a6
node scripts/m0-performance.mjs --skip-overload
```

`m1:render` starts a real Hub on the built `web-dist` with a stub Bridge holding a fixed transcript (no pi process). It checks Markdown, Shiki highlighting, typed tool cards and diffs, `content_page` expansion, `history_page` loading and the 390px layout, and the content-safety part of A8: raw HTML stays text, `javascript:`/`data:` links are removed, Markdown images become links and nothing remote is requested.

`m1:a6` runs the real TUI with the performance fixture, adds 1,000 visible custom messages of 912 characters (≈0.91 MB of normalized text, no images) and reloads one Chrome tab 20 times. Each sample is the time between the page's `pi-pane:ws-open` and `pi-pane:snapshot-rendered` performance marks (the latter is set one animation frame after the snapshot commit). It reports P50/P95/max, navigation-to-rendered separately, and then pages the whole dataset into the same tab.

`m0-performance` (A5) now verifies the 8 MiB send-buffer recycle of a paused peer, reads a 2 MiB tool result in full through `content_page`, and pages more than 1,000 history messages back to the branch root with every transport frame at most 1 MiB. `--skip-overload` skips the 4 MiB CPU-profile diagnostic, whose earlier non-completion is a host/fixture limitation.

## M2 additions

The fixture provider now declares image input and records the images it receives (`provider_call.images`). `tests/fixtures/image-history.ts` appends displayed custom messages that carry noisy PNGs without a model turn. `startFixture` accepts `PI_PANE_PASSWORD` as an environment override, captures external `https://…/#t=` links as `publicUrl`, and supports `packaged: true` with `prepareAgentDir` to load pi-pane from an installed package instead of `-e`.

```sh
npm run build
PI_M0_EXTENSION=./dist/extension/index.js npm run m2:images
PI_M0_EXTENSION=./dist/extension/index.js npm run m2:external
npm run m2:install
```

`m2:images` (A9) attaches Chrome-encoded PNG/JPEG/WebP by paste, drop and picker and checks they reach the provider; rejects damaged, oversized, mislabeled, over-pixel, unsupported, undecodable and fifth images in the browser and the same classes again over a raw WebSocket; loads 160 history images lazily while scrolling with the browser image cache at most 48 MiB; and shows an explicit error for a 6 MiB history image.

`m2:external` (A10, A11 mobile) generates a test certificate with `openssl`, maps a public host name to loopback with Chrome's host resolver rules and accepts the certificate with `ignoreHTTPSErrors`. A local TLS reverse proxy preserving Host, Origin and the WebSocket subprotocol stands in for a same-machine proxy such as Tailscale Serve. It covers refusals, login, bootstrap-only upgrades, logout, `/web qr`, rotation, direct TLS, and a Pixel 7 touch viewport including reconnect after the proxy cuts every connection.

`m2:install` (A11) runs `npm pack` (which rebuilds through `prepack`), checks the tarball, serves it from a local registry that proxies other packages to npmjs, runs `pi install npm:@lilibonk/pi-pane@<version>` into a clean agent directory and npm cache, and starts the installed package with `--web`. It needs network access for the runtime dependencies. Publication and gallery listing are not covered.

For a published version, set `PI_M2_PUBLISHED_TARBALL` to the absolute path of the frozen release tarball. This skips pack/prepack, verifies the public registry's version and integrity, and installs from `https://registry.npmjs.org/` with empty npm configuration, a fresh HOME, agent directory and cache. The npm lock must record that public source and the same integrity. The browser checks also cover refresh, restored history and a new prompt after reconnect; gallery and real-provider conversations remain separate checks.

```sh
PI_M0_CLI=/path/to/pi-coding-agent/dist/cli.js \
PI_M2_PUBLISHED_TARBALL=/absolute/path/lilibonk-pi-pane-0.1.0.tgz \
PI_M2_REPORT_DIR=./build-artifacts/m2/npm-release/install-published npm run m2:install
```

Unit tests add image structure and limit validation (`images.test.ts`), external access with real HTTP/WS and HTTPS/WSS listeners (`external.test.ts`), and a QR round trip through jsQR (`qr.test.ts`).

## M1/M2 收尾

`diff.test.ts` 验证按词 diff 的中文、emoji、空白、多行替换、文件头与内容区分以及计算预算；`theme.test.ts` 验证公开主题路径、`export.pageBg`/vars、OKLCH 派生、文件原子替换与异常降级、包内主题资源；`thinking.test.ts` 验证多段观测计时、重连快照、canonical 改写、未知历史、中断和生命周期清理。协议测试确认耗时变化走块级替换，共享 reducer 不丢字段。

`m1:render` 新增词级范围、恶意 HTML diff 纯文本渲染与折叠思考耗时检查；`m0:boundaries` 验证真实 thinking 流在重连和落盘后保留耗时；`m0:performance` 的主题部分新增仅修改 export 背景及其派生颜色的热更新检查；`m2:install` 检查 tarball 中的主题与覆盖 CSS，并在干净安装后切换两个包内主题、直接修改 CSS 后刷新验证生效。安装夹具显式设置 `loadThemes: true`；其他夹具默认仍使用 `--no-themes`。

这轮完整回归命令与结果见 [M1/M2 收尾验收记录](../docs/m2-followup-status.md)。`m2:install` 的 prepack 会重新构建，仍须最后单独运行。

## 真实模型试用

`m2:real-model` 与上述夹具分开，只有显式设置 `PI_PANE_REAL_MODEL` 才会运行。它使用现有 pi 登录和日常安装的 pi-pane，在临时工作目录和会话目录中发送三条合成输入；不加载项目上下文、skills、模板或 MCP。真实模型可使用内置 read/bash/write/edit，系统说明将操作限制在临时目录。

```sh
PI_M0_CLI=/path/to/pi-coding-agent/dist/cli.js \
PI_PANE_REAL_PROVIDER=qwen-token-plan-cn PI_PANE_REAL_MODEL=qwen3.7-max \
PI_M2_REPORT_DIR=./build-artifacts/m2/pi-1.1-trial/real-model npm run m2:real-model
```

脚本检查 TUI `/web`、终端与网页各一轮真实回复、真实 bash 的执行计数、工具运行时刷新和同租约重连，以及 fresh snapshot 与共享 reducer 的一致性。每轮最长 3 分钟，总上限 10 分钟；结束时清理临时目录和子进程，报告与终端日志脱敏。`submittedPrompts` 是提交数，不能当作 provider 请求数或账单调用数。一次通过不代表日常一周稳定性，发布后的正式 registry 安装仍须另外验证。

## M3 工作台

```sh
npm run typecheck
npm test
npm run build
PI_M0_EXTENSION=./dist/extension/index.js npm run m3:workbench
```

`m3:workbench` 启动真实 pi 1.1.0 TUI，并用两个真实 WebSocket 客户端检查首批工作台协议。`scripts/m3-fixture.mjs` 在临时 HOME / agent 目录创建独立 skill、模板、测试扩展、Git 工作区及另一 cwd 的会话；`startFixture` 的 `loadSkills` / `loadPromptTemplates` 仅在本夹具显式启用，其他夹具保持默认禁用。不会加载日常资源或认证，本地 provider 不实现网络请求，远程模型调用为 0。

15 项集成场景包括：

1. workbench 能力、会话目录、命令与资源发现。
2. 文件发现、有界预览及工作区路径边界。
3. 实际 Git 状态、已跟踪与未跟踪文件的 diff。
4. 注册扩展命令明确分派一次，重复命令不再调用宿主，也不触发模型回合。
5. 普通 prompt 中的 slash 仍为字面文本。
6. 明确选择的模板经真实宿主展开。
7. 明确选择的 skill 经真实宿主展开。
8. 新建同步两个客户端，并拒绝旧会话命令。
9. 宿主取消保留当前会话，后续读取仍可用。
10. 通过目录 ID 恢复会话，使用 fresh command context，拒绝未发现目标。
11. 跨工作区恢复后 cwd、文件查询和命令网关一致，再回到原工作区。
12. 真实 fork/tree，用户消息导航到父节点并返回文本草稿。
13. epoch 替换后会话操作仍去重，重连可查询保留的旧 epoch 结果。
14. 运行中拒绝会话切换，同时流式消息、租约重连和双端投影保持一致。
15. 真实宿主延迟会话切换 500 ms，另一客户端的竞争 prompt 被 busy 拒绝，provider 调用不增加，并验证切换结束后的后续操作。

报告默认写到 `build-artifacts/m3/workbench/report.json`，可用 `PI_M3_REPORT_DIR` 改目录。它记录实际运行结果与未覆盖范围；测试定义 15 项不表示全部通过。第 15 项来自浏览器发现的 new→prompt 竞态：跨 Bridge 写屏障与 `StateView.mutating` 必须同时证明宿主拒绝及所有客户端禁用提交/保留草稿。桌面、移动端、焦点、抽屉、文件引用、命令菜单与刷新等 UI 操作通过 CUA 在真实界面另验收，截图和浏览器记录保存在同一目录。完整状态见 [M3 验收记录](../docs/m3-status.md)。

2026-10-09 最终源码类型/构建通过，单测 92/92、真实 TUI/WS 15/15、smoke 21/21、CUA 22 项通过。此前一轮并行复跑的 slow reconnect settled 等待超时保留为 `report-reconnect-first.json`，缺少足够原始证据，原因待定位；不能凭随后独立复跑与实际浏览器刷新通过将其归因为负载。脚本已增加失败时终端、provider events 和 client 状态落盘，供后续再现；已通过的本批验收不等于长期稳定。

```sh
PI_M0_EXTENSION=./dist/extension/index.js node scripts/m3-workbench.mjs --serve
```

`--serve` 在集成通过后保留临时 TUI 供浏览器操作，写入权限 0600 的 `access.json`；访问链接不输出到报告。结束进程会清理客户端、监听、临时 HOME/agent/工作区及访问文件，不修改日常 npm 来源。此模式用于人工或 CUA 验收，不新增浏览器自动化断言。

`workbench.test.ts` 检查严格的读/写 schema、目录/资源投影、自定义会话目录与跨工作区恢复、nonce 只消费一次、生命周期取消、fresh context、主机同步失败后释放控制锁、普通输入/明确展开区分、内建名称冲突与 Unicode 命令。`workspace.test.ts` 检查路径与符号链接边界、文本编码/上限，以及实际 Git 状态/diff 和禁用仓库过滤器；`web-draft-recovery.test.ts` 验证现场树导航在快照与结果任意顺序下仅恢复一次，不用旧回执覆写新草稿。Hub 测试另覆盖在途读取上限、定向响应和会话替换后的迟到结果。

资源写入、标准对话框/审批、Plan/Goal/Agent 语义和后台交接属于后续 M3-C/D，不能由本批确定性检查推定已完成；新增 M3 也尚未作真实远程 provider 全链路试用或 npm 发布。
