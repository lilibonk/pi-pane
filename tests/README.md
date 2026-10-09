# M0 verification

`npm test` exercises runtime schema validation, Hub leases and command deduplication, transport sequencing, lifecycle cleanup and Bridge boundaries. The Hub tests open short-lived loopback listeners with synthetic session state; they do not run a model.

`npm run m0:smoke` runs the installed pi 1.0.4 CLI in a real POSIX PTY and connects real WebSocket clients. It needs Node.js, Python 3 and a built project. The fixture provider emits deterministic local text and a local streaming echo tool; it has no network request implementation. `PI_OFFLINE=1`, an environment allowlist, a temporary empty working directory and `PI_CODING_AGENT_DIR` keep the run separate from user packages, sessions and authentication.

```sh
npm run build
npm run m0:smoke
PI_M0_EXTENSION=./dist/extension/index.js PI_M0_REPORT_DIR=./build-artifacts/m0-dist npm run m0:smoke
```

Optional `PI_M0_CLI` selects an explicit `pi-coding-agent/dist/cli.js`. `PI_M0_EXTENSION` selects the source or built extension. `PI_M0_REPORT_DIR` selects the evidence directory. Defaults use project-local dependencies and `src/extension/index.ts`.

The selected CLI's package supplies the actual host version. Fixture settings, lifecycle consumer installation and A11 package installation follow that selection, so `PI_M0_CLI` can verify pi 1.1.0 without changing the project's 1.0.4 development baseline. The install command and installed-package startup use the same CLI.

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
