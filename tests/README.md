# Verification

Current source is the unreleased **0.2.0 foreground handoff** on pi/pi-ai 1.1.0. All current end-to-end fixtures follow **real TUI → `/web` → foreground Hub + one public RPC child → browser/WebSocket operations**. There is no parallel TUI writer, private RPC extension channel, internal command gateway, or mirror mode.

The published 0.1.0 M0–M2 reports and the saved M3 workbench commit `6196c7b` remain historical evidence. Their old passing counts do not verify this backend. Current execution results, unresolved failures and cleanup are recorded in [M3 status](../docs/m3-status.md); current reports default to `build-artifacts/m3/handoff/`.

## Isolation and prerequisites

Node.js, Python 3, a POSIX PTY, project-local pi 1.1.0, and built output are required. Browser scripts use local Chrome through the existing Playwright harness; new M3 desktop/mobile QA uses CUA against the real UI.

Deterministic fixtures use a task-owned temporary HOME, `PI_CODING_AGENT_DIR`, session directory and workspace, `PI_OFFLINE=1`, and an environment allowlist. The local deterministic provider has no network request implementation. Skills/templates/test extensions are created only in those temporary directories. Git fixtures avoid user configuration/hooks/filters. The deterministic matrix does not read daily credentials or replace the daily installed pi-pane.

```sh
npm ci
npm run typecheck
npm test
npm run build
PI_M0_EXTENSION=./dist/extension/index.js npm run m0:smoke
```

`PI_M0_CLI` selects an explicit CLI; `PI_M0_EXTENSION` selects source or built extension. `PI_M0_REPORT_DIR` and script-specific report variables change evidence directories. Integration assertions record the actual selected host version. `m3:workbench` requires 1.1.0. The package requires coding-agent ≥1.1.0 <2; only 1.1.0 is currently tested.

Reports contain synthetic inputs, JSON events and redacted terminal transcripts. Private access files are 0600 and removed with fixtures. Tokens are used in memory and redacted from logs. Each harness closes sockets/listeners/processes and removes task-owned temporary resources. Windows handoff is rejected; macOS and Linux implementation support does not imply both were exercised in every report.

## Current regression matrix

```sh
npm run m0:smoke
npm run m0:browser
npm run m0:lifecycle
npm run m0:boundaries
npm run m0:projection
npm run m0:performance
npm run m1:render
npm run m1:a6
npm run m2:images
npm run m2:external
npm run m2:install
npm run m3:handoff
npm run m3:workbench
```

| Script | Handoff coverage |
|---|---|
| `m0:smoke` | Actual TUI seed and idle handoff, prompt/steer/followUp/abort, text/thinking/tool partial snapshots and reconnect, multiple browser clients, RPC new/switch/fork, stale scope, deduplication and handshake errors |
| `m0:browser` | Actual browser replies, IME/draft behavior, prompt/control receipts, refresh/reconnect and model/thinking/compact controls through the RPC writer |
| `m0:lifecycle` | Public settings writer behavior, no listener before explicit `/web`, command/flag/settings precedence, invalid configuration, port conflicts and multiple foreground services, latest-session Ctrl+C recovery |
| `m0:boundaries` | Real fixture input consume/transform, RPC extension/skill/template expansion, no-model/auth/provider/compaction errors, thinking/tool arguments, queue behavior, lost receipt querying, serial scope rejection, dialog forwarding |
| `m0:projection` | Displayed custom messages, hidden extension data exclusion, bash output and stable reconnect projection identities without relying on a live TUI viewer |
| `m0:performance` | Writer telemetry, fixed generation workload, 4/8 viewers, bounded history/content pages, send-buffer backpressure and explicit slow-client recycle; Hub host and RPC writer are separate processes |
| `m1:render` | Fixed safe transcript on a real Hub: Markdown/Shiki/tool cards/diff/thinking, pagination/content expansion, hostile HTML/URLs and 390px layout; no pi model process needed for this rendering test |
| `m1:a6` | 1,000-message reference data set, 20 actual browser samples from WS open to snapshot-rendered, P50/P95/max and complete paging; navigation time separately recorded |
| `m2:images` | Paste/drop/picker upload PNG/JPEG/WebP, browser/server rejection classes, provider receipt of image data, 160 history images lazy loading and 48-MiB cache, oversize history error |
| `m2:external` | TLS and same-machine proxy, password/bootstrap distinction, login/logout/revoke, handoff banner QR, direct TLS, mobile followUp/steer and proxy-cut reconnect |
| `m2:install` | `npm run build` then `npm pack --ignore-scripts` prebuilt assets/themes/CSS, clean HOME/agent/npm cache install, installed TUI `/web` handoff, browser submit/refresh; local tarball is not publication |
| `m3:handoff` | Real TUI shutdown, one RPC writer, four extension dialogs, cancellation/timeout/late answers, reconnect UI state, rename/clone/current marker, session lock, Ctrl+C/SIGHUP/SIGKILL/child crash and unexpected external file changes |
| `m3:workbench` | Session/commands/resources reads, file confinement and real Git diff, extension once-only dispatch, RPC slash/template/skill expansion, new/cancel/scope queue, discovered-ID resume, cross-cwd roots, user-entry fork draft, receipt dedup and slow-stream reconnect |

Script definitions are not passing results. The current deterministic matrix passed 122/122 checks across 14 suites (including 3 performance and 2 initial-theme checks), recorded in `build-artifacts/m3/handoff/regression-matrix.json`; 121/121 unit tests, typecheck and production build also passed. Actual results remain in [M3 status](../docs/m3-status.md). The historical slow-reconnect timeout is tracked again under handoff; subsequent passes cannot prove its old cause. Failure reports retain terminal/provider/client diagnostics before fixture cleanup, and reruns retain the first failure.

## Retired mirror checks and replacements

- **Parallel TUI + browser writes** are removed. Multi-browser serial commands, scope fences, RPC queue/disposition and unique-writer lifecycle replace them.
- **Runtime extension rebind/removal/import-delay after `/web`** no longer governs the network host. TUI stage has no Hub; child crash/exit, host signals and EOF cleanup cover failure shutdown. Rebind and `/web stop/status` assertions are retired explicitly.
- **`--web` auto-start**, `/web qr` widget and TUI `/web --rotate` are removed. Explicit idle handoff/no-listener configuration, banner QR and browser credential rotation replace them.
- **TUI tree navigation and tree cancellation** have no public RPC command. Read-only tree via `get_entries`, native user-entry `fork`, draft recovery and a disabled reason replace navigation; no private channel is added.
- **Live TUI theme switching/same-name theme rewrite after handoff** is retired. Initial theme snapshot, packaged themes and custom CSS remain covered. A rendering helper test may verify CSS derivation without claiming a live RPC theme API.
- **Terminal custom components** cannot run in RPC. Standard select/confirm/input/editor and supported one-way extension UI are adapted and checked; arbitrary custom TUI rendering is excluded.

## Protocol and unit coverage

`npm test` validates runtime schema, leases/deduplication, contiguous projection sequencing, directed workbench reads and pre/post-read scope checks, bounds/backpressure, canonical message identities, encoding/path/symlink/filter boundaries, session sidecar lock, child argument filtering/exit takeover, public RPC host failures, and browser helpers. Synthetic Hub tests open short-lived loopback listeners without a model.

Frontend helpers cover builtins while catalog loading, builtin-vs-extension name conflicts, Unicode command arguments, new-session RPC fork draft recovery in either receipt/snapshot order, preserving edited drafts and rejecting stale recovery. `EditorChangeGuard` ensures reconnect/status/widget snapshots do not repeatedly overwrite edited drafts; only new set_editor_text revisions apply. This concerns fork recovery and reconnecting the same loaded page; ordinary unsent drafts are not persisted across page reloads.

Projection/read frames do not consume client write counters or event seq. Commands are not automatically replayed after network loss. RPC `started`/`queued`/`handled` receipts are observed results, not a fabricated inference from model output. Old retained receipts can be queried without executing again; lease/cache expiry limits still apply.

## Performance and content checks

`m1:a6` uses 1,000 visible messages around 0.91 MiB normalized text with no images, measures 20 browser reloads, and records OS/Node/pi/CPU. The ≤1s P95 goal applies to WS-open → snapshot-rendered for that dataset, not browser launch, large images or slow networks. `m0:performance` explores deterministic RPC-writer telemetry and bounded caches. The current run used `--quick`: one observation per configuration, with 0/4/8 viewers yielding about 307/312/305 ms for 256 KiB and writer event-loop P95 about 10.84–10.96 ms. CPU/RSS/event-loop readings exclude the independent web host; TUI-versus-RPC ratios do not isolate pi-pane overhead. These are local engineering guards, not reliable production tail latency or a long-term leak soak. The 20-second overload profile was not run. Use `--skip-overload` only when recording that diagnostic exclusion. The separate 20-sample A6 run passed with WS-open → snapshot-rendered P95 47.8 ms for the stated dataset.

`m1:render` checks raw HTML as text, sanitized unsafe links, model images as links with no remote fetch, hostile diff text, typed cards, thinking timing and mobile layout. The shared reducer and transport chunk assembler are the same built code the SPA uses.

## External access and installation

`m2:external` uses an OpenSSL test certificate, loopback hostname mapping and a local TLS reverse proxy preserving Host/Origin/subprotocol. Test browser certificate acceptance does not assert a real device trusts that certificate. It exercises the deployment contract, not a real Tailscale Serve installation.

`m2:install` expects prebuilt output (`npm run build`), runs `npm pack --ignore-scripts`, serves the tarball via a local test registry for the package, proxies runtime dependency fetches to npm, installs into a clean isolated agent/npm directory, then starts a real TUI and invokes `/web`. Network access is needed for package dependencies; fixture model calls remain local. Build after final source changes before running it; the isolated pack step does not run prepack. Published-version integrity mode only applies to an explicitly frozen release tarball; 0.1.0 results remain historical and do not validate new 0.2.0 behavior.

## Actual browser M3 QA

CUA separately verifies desktop/mobile workbench actions, current session marker refresh, rename/clone/fork, original draft preservation, builtins that open pickers or explain unavailable capabilities, real file quotation and Git diff, extension dialog focus/cancel/expiry/reconnect, one-way UI, credential rotation and midstream reload. A passing WS report does not imply the corresponding UI interaction passed. Screenshots, widths, console errors and teardown are saved under `build-artifacts/m3/handoff/`; `cleanup.json` confirms the CUA preview and original failed fixture processes, listener, private access and locks were removed. The current final CUA report has 19/19 passing checks at 1280/390px and zero console errors: `browser-report.json`, `browser-desktop.png`, `browser-mobile.png` and `browser-mobile-dialog.png`. The first empty-fork clone failure remains in `browser-clone-first.png`/`.txt` and `cua-empty-fork-clone-failure/`; the native failed result now leaves the service usable, with workbench check 16 and actual CUA reruns covering both failed empty-branch clone and successful persisted-branch clone.

```sh
PI_M0_EXTENSION=./dist/extension/index.js node scripts/m3-workbench.mjs --serve
```

`--serve` preserves the isolated foreground host after checks for human/CUA use and creates a private `access.json` with the visit link. Normal/signal cleanup closes owned resources and removes it. It does not change the daily npm installation.

## Real-provider trial

The real-provider script is a separate explicit opt-in flow; its results are recorded separately from the deterministic matrix. Both `PI_PANE_REAL_MODEL` and `PI_PANE_REAL_AGENT_DIR` must be explicitly provided. The agent directory must resolve under the OS temporary directory and be task-owned; the maintainer prepares/login authenticates it separately. The harness never reads or copies authentication content, rejects daily agent directories, creates a new temporary HOME/workspace/session directory, and passes only allowed environment variables. It does not inherit daily API keys or packages.

For a trial explicitly authorized by the user to reuse existing local authentication, the temporary agent may contain an `auth.json` symlink. This additionally requires `PI_PANE_REAL_AUTH_SYMLINK_TARGET` to name the exact authorized absolute target; the report records `user-authorized-existing-auth-via-symlink`. The model process accesses that authentication for the trial, while the harness neither reads nor copies its content. This authorization applies to that trial only and does not enable daily-credential use in deterministic regressions.

```sh
PI_M0_EXTENSION=./dist/extension/index.js \
PI_PANE_REAL_PROVIDER=<provider> PI_PANE_REAL_MODEL=<model> \
PI_PANE_REAL_AGENT_DIR=/absolute/os-temp/task-owned-agent \
npm run m2:real-model
```

The initial TUI trial reply completes before `/web`. Browser replies and one builtin bash tool then execute in the RPC child, with refresh/reconnect and final canonical projection checks. There are no parallel-terminal assertions. Each turn is limited to 3 minutes, total 10 minutes; temporary resources are cleaned and transcripts redacted. submittedPrompts is not a provider-call/billing count. A successful short trial does not prove weekly stability. npm publishing remains the maintainer's action.

The 2026-10-10 separately authorized source trial passed 5/5 on pi 1.1.0 with `qwen-token-plan-cn/qwen3.7-max`: three short prompts, one builtin bash execution, refresh during the tool and matching fresh canonical snapshots, with zero page/protocol errors. Evidence: `build-artifacts/m3/handoff/m2/real-model/report.json` and `browser.png`. It used the explicitly authorized symlink mode; the temporary agent/reference was removed afterward and the original credential retained mode 0600. Deterministic regressions still have zero remote model calls.
