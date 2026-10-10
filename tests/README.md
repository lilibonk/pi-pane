# Verification

The published **0.2.0 foreground handoff** archive corresponds to source `439c545`, based on `d5cd02d` plus the release-review fixes, on pi/pi-ai 1.1.0. Public version metadata and the downloaded archive match the frozen candidate, and the separate public-registry installation passed 5/5. All current end-to-end fixtures follow **real TUI → `/web` → foreground Hub + one public RPC child → browser/WebSocket operations**. There is no parallel TUI writer, private RPC extension channel, internal command gateway, or mirror mode.

The published 0.1.0 M0–M2 reports and the saved M3 workbench commit `6196c7b` remain historical evidence. Their old passing counts do not verify this backend. Current execution results, unresolved failures and cleanup are recorded in [M3 status](../docs/m3-status.md); script reports default to `build-artifacts/m3/handoff/`, while this frozen candidate is verified separately under `build-artifacts/releases/0.2.0/`.

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
npm run m31:runtime
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
| `m3:handoff` | Real TUI shutdown, one RPC writer, four extension dialogs, cancellation/timeout/late answers, reconnect UI state, rename/clone/current marker, `/web`-only session lock (a second TUI is warned, stays open, and its `/web` is refused; two ordinary TUIs share a session), extension entries persisted after a turn settled, Ctrl+C/SIGHUP/SIGKILL/child crash and unexpected external file changes. `PI_M3_LONG=1` adds an extension dialog answered after 130 s |
| `m3:workbench` | Session/commands/resources reads, file confinement and real Git diff, extension once-only dispatch, RPC slash/template/skill expansion, new/cancel/scope queue, discovered-ID resume, cross-cwd roots, user-entry fork draft, receipt dedup and slow-stream reconnect |
| `m31:runtime` | M3.1 runtime control with a real TUI and real RPC children: a session of another project starts a new child in that directory (process cwd, lock ownership, old child's shutdown handlers finished, Hub and viewers stay connected); a child that moves itself to another project's session stops the service; a shutdown dialog leaves `recovery_required` (no target child, late viewer sees the state first), then restore and stop through `host_command`; a 3 s shutdown handler is waited for and its non-message entry accepted; Ctrl+C after a replacement names the current project's session |

Script definitions are not passing results. The frozen release candidate passed typecheck, build and **136/136 unit tests**, with logs and `build-checks.json` under `build-artifacts/releases/0.2.0/`. The sequential deterministic run has **121/121 checks across 13 report suites** in `regression/summary.json`, including `PI_M3_LONG=1` handoff **15/15**, performance **3/3** and theme **2/2**. The exact candidate archive installation passed another **4/4** in `install/report.json`, making **125/125 across 14 suites**. Source and built-asset hashes were unchanged during the matrix; the runner temporary HOME and 25 referenced fixture roots were removed. The independently recorded daily-package discovery check is additional and does not change this total.

`integrity-verification.json` records the `439c545` freeze-time comparison: all 83 packaged files matched between the archive, repository and then-daily unpacked installation, and all 131 regression source/build hashes were unchanged. Later repository publication-status documentation updates do not modify or repack the published archive. The public download and current daily npm installation still match the frozen archive across all 83 packaged files. The candidate archive SHA-256 is `5bba224d3b106139ee56614e5ec83079ba97f324a56bfc11c29a0656177f2eb0`; it is saved as `candidate/lilibonk-pi-pane-0.2.0.tgz`. Earlier `d5cd02d` reports had 124 deterministic checks and 129 reported unit tests. The old `build-artifacts/m3/handoff/regression-matrix.json` and `validation.json` are still `38152e1` aggregates with 122/121 counts; they are historical evidence, not the current candidate summary. Failure reports retain terminal/provider/client diagnostics, and subsequent passes cannot prove the historical slow-reconnect timeout's cause.

## Retired mirror checks and replacements

- **Parallel TUI + browser writes** are removed. Multi-browser serial commands, scope fences, RPC queue/disposition and unique-writer lifecycle replace them.
- **Runtime extension rebind/removal/import-delay after `/web`** no longer governs the network host. TUI stage has no Hub; child crash/exit, host signals and EOF cleanup cover failure shutdown. Rebind and `/web stop/status` assertions are retired explicitly.
- **`--web` auto-start**, `/web qr` widget and TUI `/web --rotate` are removed. Explicit idle handoff/no-listener configuration, banner QR and browser credential rotation replace them.
- **TUI tree navigation and tree cancellation** have no public RPC command. Read-only tree via `get_entries`, native user-entry `fork`, draft recovery and a disabled reason replace navigation; no private channel is added.
- **Live TUI theme switching/same-name theme rewrite after handoff** is retired. Initial theme snapshot, packaged themes and custom CSS remain covered. A rendering helper test may verify CSS derivation without claiming a live RPC theme API.
- **Terminal custom components** cannot run in RPC. Standard select/confirm/input/editor and supported one-way extension UI are adapted and checked; arbitrary custom TUI rendering is excluded.

## Protocol and unit coverage

`npm test` validates runtime schema, leases/deduplication, contiguous projection sequencing, directed workbench reads and pre/post-read scope checks, bounds/backpressure, canonical message identities, encoding/path/symlink/filter boundaries, session sidecar lock (complete accepted-prefix hashing, atomic-replacement and truncation checks, full-entry append comparison, guard reclamation, read-only inspection), RPC read timeouts versus untimed commands, child argument filtering/exit takeover, public RPC host failures, and browser helpers. Ownership-query timeouts refuse only the dependent operation and keep the child available; timed-out reads are not implicitly retried, and failed full refreshes retain the reload request. Synthetic Hub tests open short-lived loopback listeners without a model.

Frontend helpers cover builtins while catalog loading, builtin-vs-extension name conflicts, Unicode command arguments, new-session RPC fork draft recovery in either receipt/snapshot order, preserving edited drafts and rejecting stale recovery. `EditorChangeGuard` ensures reconnect/status/widget snapshots do not repeatedly overwrite edited drafts; only new set_editor_text revisions apply. This concerns fork recovery and reconnecting the same loaded page; ordinary unsent drafts are not persisted across page reloads.

Projection/read frames do not consume client write counters or event seq. Commands are not automatically replayed after network loss. RPC `started`/`queued`/`handled` receipts are observed results, not a fabricated inference from model output. Old retained receipts can be queried without executing again; lease/cache expiry limits still apply.

## Performance and content checks

`m1:a6` uses 1,000 visible messages around 0.91 MiB normalized text with no images, measures 20 browser reloads, and records OS/Node/pi/CPU. The ≤1s P95 goal applies to WS-open → snapshot-rendered for that dataset, not browser launch, large images or slow networks. `m0:performance` explores deterministic RPC-writer telemetry and bounded caches. The frozen-candidate run used three observations per configuration, with 0/4/8 viewers yielding median durations of about 331/324/320 ms for 256 KiB and median writer event-loop P95 of about 11.05/10.94/10.83 ms. CPU/RSS/event-loop readings exclude the independent web host, including its complete-prefix verification I/O and resource cost; TUI-versus-RPC ratios do not isolate pi-pane overhead. These are local engineering guards, not reliable production tail latency or a long-term leak soak. The 20-second overload diagnostic ran: the TUI baseline was unfinished at the cutoff (1,383,424 B of 4 MiB), while the four-viewer RPC run completed 4 MiB in about 2.31 s. This cross-mode diagnostic is not an overall overload acceptance pass. Use `--skip-overload` only when recording that diagnostic exclusion. The separate 20-sample A6 run passed with WS-open → snapshot-rendered P95 48.2 ms for the stated dataset.

`m1:render` checks raw HTML as text, sanitized unsafe links, model images as links with no remote fetch, hostile diff text, typed cards, thinking timing and mobile layout. The shared reducer and transport chunk assembler are the same built code the SPA uses.

## External access and installation

`m2:external` uses an OpenSSL test certificate, loopback hostname mapping and a local TLS reverse proxy preserving Host/Origin/subprotocol. Test browser certificate acceptance does not assert a real device trusts that certificate. It exercises the deployment contract, not a real Tailscale Serve installation.

`m2:install` expects prebuilt output (`npm run build`), runs `npm pack --ignore-scripts`, serves the tarball via a local test registry for the package, proxies runtime dependency fetches to npm, installs into a clean isolated agent/npm directory, then starts a real TUI and invokes `/web`. Network access is needed for package dependencies; fixture model calls remain local. Build after final source changes before running it; the isolated pack step does not run prepack.

Set `PI_M2_CANDIDATE_TARBALL` to the absolute path of a frozen candidate `.tgz` to run the same four installation checks against that exact archive through the local registry; the report records archive SHA-256 and integrity. `PI_M2_PUBLISHED_TARBALL` instead checks an explicitly frozen release archive against installation from the public npm registry. Its five checks include an additional public version/integrity assertion; record this separately from the four-check candidate installation and the 125-check matrix. These two variables are mutually exclusive. Candidate-tarball success does not imply publication or public-registry installation. The 0.1.0 published-install results remain historical and do not validate new 0.2.0 behavior.

The candidate-stage daily installation at `/Users/zile.zhou/.pi/agent/local/pi-pane/0.2.0-5bba224d3b10` was verified separately in `build-artifacts/releases/0.2.0/daily-install.json`: an isolated HOME, the same relative source and actual daily pi 1.1.0 CLI automatically discovered the package without `-e` pane, completed `/web` and a deterministic reply, and reported zero protocol errors. Its temporary resources were removed. This historical discovery check is outside the 125-check matrix.

The user authorized npm login and publication of this exact 0.2.0 archive. Publication succeeded, public version metadata and the install index show 0.2.0, and the downloaded archive SHA-256/integrity match the frozen candidate. Public-registry installation passed **5/5** using the actual daily pi 1.1.0 CLI, temporary HOME/agent/cache and a local deterministic provider: package contents, public metadata/integrity, clean installation, TUI handoff/browser conversation/reload, and themes/CSS. These five checks are separate from the 125-check candidate matrix and real-model trial. The runner HOME was removed, with zero real-model calls or daily credentials read. Evidence under `build-artifacts/releases/0.2.0/` includes `publication.json`, `public-install/report.json`, `public-install.log` and `public-install-cleanup.json`.

The daily plugin now has one registered source, `npm:@lilibonk/pi-pane@0.2.0`, installed at `/Users/zile.zhou/.pi/agent/npm/node_modules/@lilibonk/pi-pane`. `daily-public-install.json` confirms the npm lock uses the public tarball and expected integrity, all 83 packaged files match the frozen archive, other settings hashes are unchanged, and temporary npm configuration/cache were removed. The local candidate directory remains as an unregistered rollback snapshot. Restart already-open pi processes to load the published plugin.

## Actual browser M3 QA

CUA separately verifies desktop/mobile workbench actions, current session marker refresh, rename/clone/fork, original draft preservation, builtins that open pickers or explain unavailable capabilities, real file quotation and Git diff, extension dialog focus/cancel/reconnect, one-way UI, credential rotation and midstream reload. A passing WS report does not imply the corresponding UI interaction passed. The retained `38152e1` report in `build-artifacts/m3/handoff/` has 19/19 passing checks at 1280/390px and zero console errors. Its screenshots, first empty-fork clone failure and cleanup remain historical evidence.

On 2026-10-10 the actual published `@lilibonk/pi-pane@0.2.0` installation completed a fresh **19/19 CUA run**, using the daily pi 1.1.0 CLI with temporary HOME/agent/workspaces and the credential-free deterministic provider. Desktop 1280×720 and mobile 390×844 interactions passed with zero console errors in both browser pages. No product changes were required. The 83 loaded package files match the frozen published archive. The second-page check verifies one pending dialog answered once and closed on both pages; it does not claim a simultaneous UI double-submit race. Slow response content matched the fixture exactly after midstream reload, with one provider call and no duplicate bubbles.

The public [acceptance summary and screenshots](../docs/m3-final-acceptance.md) accompany the source; full local evidence is in `build-artifacts/releases/0.2.0/cua/` (`browser-report.json`, `event-audit.json`, `console-errors.json`, `package-hashes.json`, and `cleanup.json`). All fixture processes, listener, locks and private access data were removed, and browser tabs/viewport overrides were cleaned up. These checks are separate from the 125-check deterministic matrix, 5-check real-provider trial and 5-check public installation.

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

The 2026-10-10 release-candidate trial passed **5/5** using the actual daily pi 1.1.0 Node CLI and `qwen-token-plan-cn/qwen3.7-max`, with the exact candidate extension unpacked at the historical local candidate path above. It sent three short prompts and executed one builtin bash, refreshed during that tool, and matched fresh canonical snapshots with zero page/protocol errors. Evidence is `build-artifacts/releases/0.2.0/real-model/report.json`, `real-model/browser.png` and `real-model-cleanup.json`. This run used a newly authorized temporary authentication symlink; the wrapper did not read or copy credentials, the temporary agent/reference was removed, and the original credential retained mode 0600. The authorization is limited to this trial and does not permit future automatic credential reuse. Deterministic regressions still have zero remote model calls. The earlier `38152e1` 5/5 report remains in `build-artifacts/m3/handoff/m2/real-model/` as separate historical evidence.
