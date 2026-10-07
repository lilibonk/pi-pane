# M0 verification

`npm test` exercises runtime schema validation, Hub leases and command deduplication, transport sequencing, lifecycle cleanup and Bridge boundaries. The Hub tests open short-lived loopback listeners with synthetic session state; they do not run a model.

`npm run m0:smoke` runs the installed pi 1.0.4 CLI in a real POSIX PTY and connects real WebSocket clients. It needs Node.js, Python 3 and a built project. The fixture provider emits deterministic local text and a local streaming echo tool; it has no network request implementation. `PI_OFFLINE=1`, an environment allowlist, a temporary empty working directory and `PI_CODING_AGENT_DIR` keep the run separate from user packages, sessions and authentication.

```sh
npm run build
npm run m0:smoke
PI_M0_EXTENSION=./dist/extension/index.js PI_M0_REPORT_DIR=./build-artifacts/m0-dist npm run m0:smoke
```

Optional `PI_M0_CLI` selects an explicit `pi-coding-agent/dist/cli.js`. `PI_M0_EXTENSION` selects the source or built extension. `PI_M0_REPORT_DIR` selects the evidence directory. Defaults use project-local dependencies and `src/extension/index.ts`.

The smoke report lists each executed check and explicit uncovered branches. A passing report means those checks passed; it does not mean all M0 questions or M1 acceptance criteria are complete. The test covers TUI text entry, preservation of an unsent draft, multiple browser clients, prompt/steer/followUp, partial text and tool snapshots, reconnect, abort, tree cancellation/navigation, runtime reload/new/fork/resume, stale commands, duplicate IDs, local handshake checks, stop/restart and token rotation. Fork/resume/tree targets are selected through fixture commands that call the real command-context APIs; their built-in selection dialogs are not automated.

The focused integration scripts use the same isolation rules:

```sh
npm run m0:lifecycle
npm run m0:boundaries
npm run m0:projection
npm run m0:performance
```

`m0:lifecycle` tests actual extension removal, syntax errors, a 12-second extension factory delay against the real 10-second rebind deadline, settings precedence, concurrent official settings writers, port conflicts, multiple pi instances and an independent npm consumer of the packed extension. The consumer fixes pi and pi-ai to 1.0.4; this does not verify pnpm's isolated dependency layout or npm publication. The extension reads settings only; preservation by the host's locked merge writer does not prove crash-atomic saving.

`m0:boundaries` loads another real extension to consume/transform inputs, discover a template and a skill, replace a finalized message, open a terminal dialog and fail local summarization. It also checks thinking/tool-argument reconnects, positive TUI template/skill expansion controls, TUI queue consumption/dequeue, unread receipt recovery, and session replacement while input/model hooks or compaction are pending. The compact-success check compares the attached client's history with a fresh canonical snapshot, including the compaction marker. No-model and missing-authentication checks use isolated host preflight; the controlled provider error has no outbound network request.

`m0:projection` checks visible custom messages added by an idle extension and actual TUI `!printf` output. Connected viewers receive the changes without a model turn or resync; hidden custom messages and opaque entry data remain absent. Reconnected snapshots retain the same message IDs and epoch. Unit regressions also cover combined text/error/output limits.

`m0:performance` compares a fixed workload with no pane, Bridge only, Hub with no viewers, and four/eight WebSocket viewers. Measurements are taken inside the host process. Provider generation, browser application latency, host process memory and pane cache bounds are distinct metrics. Three rounds are an exploratory comparison, not a production P95 claim. Theme tests use public `setTheme`, same-name file rewrites and PTY terminal-color responses; they do not verify a desktop OS theme switch.

Reports contain synthetic fixture messages, a redacted terminal transcript and JSON event evidence. Browser tokens are used only in memory for the test connection and are redacted before writing terminal logs. Processes, sockets and temporary test configuration are closed on completion. The PTY harness currently supports macOS/Linux; Windows PTY behavior is not verified.

Prompt receipts are dispatch-only even when a hook consumes input or the host later fails preflight. Race checks prove stale-command rejection and that old completions do not enter a replacement epoch; they do not claim to undo host operations that already began. Lease expiration and receipt-cache eviction use the existing short-TTL Hub integration tests instead of waiting 30 minutes in the TUI harness. All fake-provider calls remain local; no real authentication credentials or model service is used.
