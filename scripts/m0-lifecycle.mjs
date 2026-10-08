#!/usr/bin/env node
/** Q1/Q10: real, isolated pi lifecycle faults, configuration, ports and local tarball install. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openClient, waitFor } from "./m0-smoke.mjs";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(process.env.PI_M0_LIFECYCLE_REPORT_DIR || join(project, "build-artifacts/m0/lifecycle"));
const cli = process.env.PI_M0_CLI || join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
const sourceEntry = resolve(process.env.PI_M0_LIFECYCLE_EXTENSION || join(project, "src/extension/index.ts"));
const packageModule = import.meta.resolve("@earendil-works/pi-coding-agent");
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const stripAnsi = (value) => value.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
const redact = (value) => String(value).replace(/#t=[A-Za-z0-9_-]+/g, "#t=[REDACTED]").replace(/pi-pane\.bearer\.[A-Za-z0-9_-]+/g, "pi-pane.bearer.[REDACTED]");
const envBase = () => Object.fromEntries(["PATH", "TMPDIR", "LANG", "LC_ALL", "SYSTEMROOT"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
const report = { startedAt: new Date().toISOString(), piVersion: "1.0.4", node: process.version, platform: process.platform, arch: process.arch,
  realTui: true, realModelCalls: 0, isolation: "Empty fixture cwd, isolated agent/auth {}, explicit environment allowlist, no inherited model credentials", checks: [],
  decisions: [], notCovered: ["Host event compatibility outside pi 1.0.4", "Arbitrary piPane settings writes or crash-atomic persistence", "npm registry publication", "pnpm isolated dependency layout"] };
await mkdir(output, { recursive: true });

async function run(command, args, options = {}) {
  const child = spawn(command, args, { cwd: options.cwd ?? project, env: options.env ?? envBase(), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  const code = await new Promise((done, reject) => { child.once("error", reject); child.once("exit", done); });
  if (code !== 0) throw new Error(`${command} failed (${code}): ${redact(stderr + stdout).slice(-5000)}`);
  return { stdout, stderr };
}
async function listeningServer(port = 0) {
  const server = createServer((_request, response) => { response.end("fixture occupied port"); });
  await new Promise((done, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", done); });
  return { server, port: server.address().port, close: () => new Promise((done) => server.close(done)) };
}
async function freePort() { const occupied = await listeningServer(); const port = occupied.port; await occupied.close(); return port; }
async function health(port) {
  try { const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(700) }); return response.ok && (await response.text()) === '{"ok":true}'; }
  catch { return false; }
}
async function check(name, action) {
  const started = Date.now();
  try { const details = await action(); report.checks.push({ name, status: "passed", durationMs: Date.now() - started, ...(details ? { details } : {}) }); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({ name, status: "failed", durationMs: Date.now() - started, error: redact(error.stack ?? error) }); throw error; }
  finally { await writeFile(join(output, "lifecycle-report.json"), JSON.stringify(report, null, 2)); }
}

async function startReal(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-pane-lifecycle-"));
  const agentDir = join(directory, "agent"), cwd = join(directory, "workspace");
  await mkdir(agentDir); await mkdir(cwd);
  await writeFile(join(agentDir, "auth.json"), "{}", { mode: 0o600 });
  const eventsPath = join(directory, "fixture-events.jsonl"), probePath = join(directory, "settings-probe.jsonl");
  await writeFile(eventsPath, ""); await writeFile(probePath, "");
  const wrapper = join(directory, "lifecycle-wrapper.ts");
  const settingsPath = join(agentDir, "settings.json");
  const port = options.defaultPort ? undefined : options.port ?? await freePort();
  const settings = { defaultProvider: "pi-pane-m0", defaultModel: "deterministic", defaultProjectTrust: "always", quietStartup: true,
    lastChangelogVersion: "1.0.4", packages: [], compaction: { enabled: false },
    extensions: options.packageRoot ? [] : [wrapper], ...options.settings };
  await writeFile(settingsPath, JSON.stringify(settings), { mode: 0o600 });
  if (options.projectSettings) {
    await mkdir(join(cwd, ".pi"));
    await writeFile(join(cwd, ".pi/settings.json"), JSON.stringify(options.projectSettings));
  }
  const wrapperSource = (delayMs = 0) => `import pane from ${JSON.stringify(sourceEntry)};
import { appendFileSync } from 'node:fs';
export default async function(pi) {
  ${delayMs ? `await new Promise(resolve => setTimeout(resolve, ${delayMs}));` : ""}
  const register = pi.registerCommand.bind(pi);
  pi.registerCommand = (name, options) => register(name, name === 'web' ? { ...options, handler: async (args, ctx) => {
    try { return await options.handler(args, ctx); }
    finally { appendFileSync(${JSON.stringify(probePath)}, JSON.stringify({event:'web_command_completed',args})+'\\n'); }
  }} : options);
  ${options.missingApi ? `pi[${JSON.stringify(options.missingApi)}] = undefined;` : ""}
  pane(pi);
  pi.on('session_start', (event, ctx) => {
    if (typeof pi.getSettings !== 'function') return;
    const snapshot = pi.getSettings();
    const original = snapshot.piPane;
    if (snapshot.piPane) snapshot.piPane.port = 65534;
    appendFileSync(${JSON.stringify(probePath)}, JSON.stringify({ event:'settings_read', reason:event.reason, piPane: pi.getSettings().piPane,
      copyDetached: JSON.stringify(original) !== JSON.stringify(pi.getSettings().piPane), mode:ctx.mode })+'\\n');
  });
}
`;
  await writeFile(wrapper, wrapperSource());
  const env = { ...envBase(), TERM: "xterm-256color", COLORTERM: "truecolor", PI_OFFLINE: "1", NO_COLOR: "1",
    PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: join(agentDir, "sessions"), PI_M0_EVENTS_PATH: eventsPath };
  const argv = [process.execPath, options.cli ?? cli, "--no-skills", "--no-prompt-templates", "--no-themes", "--no-builtin-tools",
    "-e", join(project, "tests/fixtures/deterministic-provider.ts"), ...(options.packageRoot ? ["-e", options.packageRoot] : []),
    "--provider", "pi-pane-m0", "--model", "deterministic", ...(options.autoWeb === false ? [] : ["--web"]),
    ...(port === undefined || options.omitPortFlag ? [] : ["--web-port", String(port)]), ...(options.omitNoOpenFlag ? [] : ["--web-no-open"])];
  const proc = spawn("python3", [join(project, "scripts/pty-host.py")], { stdio: ["pipe", "pipe", "pipe"] });
  const fixture = { directory, agentDir, cwd, settingsPath, wrapper, eventsPath, probePath, port, proc, env, terminal: "", stderr: "", url: undefined, exitCode: undefined,
    write(data) { proc.stdin.write(`${JSON.stringify({ type: "write", data })}\n`); },
    command(text) { fixture.write(`${text}\r`); },
    async events() { return (await readFile(eventsPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); },
    async probes() { return (await readFile(probePath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); },
    async starts() { return (await fixture.events()).filter((event) => event.event === "session_start").length; },
    async reload() { const starts = await fixture.starts(); fixture.command("/reload"); await waitFor(async () => (await fixture.starts()) > starts, "real reload finishes", 30_000); },
    async setWrapper(delayMs = 0) { await writeFile(wrapper, wrapperSource(delayMs)); },
    async setSettings(update) { const current = JSON.parse(await readFile(settingsPath, "utf8")); await writeFile(settingsPath, JSON.stringify({ ...current, ...update })); },
    async close(name) {
      if (proc.exitCode === null) {
        proc.stdin.write(`${JSON.stringify({ type: "terminate" })}\n`);
        await Promise.race([new Promise((done) => proc.once("exit", done)), pause(5000)]);
        if (proc.exitCode === null) proc.kill("SIGKILL");
      }
      if (name) {
        await writeFile(join(output, `${name}.terminal.redacted.log`), redact(stripAnsi(fixture.terminal + fixture.stderr)));
        await writeFile(join(output, `${name}.events.jsonl`), await readFile(eventsPath));
        await writeFile(join(output, `${name}.settings-probe.jsonl`), await readFile(probePath));
      }
      await rm(directory, { recursive: true, force: true });
    },
  };
  proc.stderr.on("data", (data) => { fixture.stderr += data; });
  proc.on("exit", (code) => { fixture.exitCode = code; });
  createInterface({ input: proc.stdout }).on("line", (line) => {
    const item = JSON.parse(line);
    if (item.type === "output") {
      fixture.terminal = (fixture.terminal + item.data).slice(-1_000_000);
      const matches = [...stripAnsi(fixture.terminal).matchAll(/http:\/\/(?:127\.0\.0\.1|\[::1\]):\d+\/#t=[A-Za-z0-9_-]+/g)];
      if (matches.length) fixture.url = matches.at(-1)[0];
      if (item.data.includes("\u001b[6n")) fixture.write("\u001b[1;1R");
    } else if (item.type === "exit") fixture.exitCode = item.code;
  });
  proc.stdin.write(`${JSON.stringify({ argv, cwd, env })}\n`);
  try {
    await waitFor(async () => {
      if (fixture.exitCode !== undefined) throw new Error(`pi exited: ${redact(stripAnsi(fixture.terminal + fixture.stderr)).slice(-3000)}`);
      return await fixture.starts();
    }, "real TUI session starts", 30_000);
    if (options.expectUrl !== false && options.autoWeb !== false) await waitFor(() => fixture.url, "real TUI URL", 15_000);
    return fixture;
  } catch (error) { await fixture.close("startup-failure"); throw error; }
}

async function verifyNoAutoRestart(fixture, oldUrl) {
  await pause(500);
  assert.equal(await health(Number(new URL(oldUrl).port)), false, "late session_start must not revive --web");
  fixture.command("/web --no-open");
  await waitFor(() => fixture.url && fixture.url !== oldUrl, "manual /web gets a new token");
  assert.equal(await health(Number(new URL(fixture.url).port)), true);
  const restored = await openClient(fixture.url); await restored.close();
}

async function lifecycleFaults() {
  const fixture = await startReal();
  try {
    for (const failure of ["disabled", "import-failure", "slow-rebind"]) {
      await check(`real reload ${failure}: deadline releases port, late start requires explicit /web`, async () => {
        const client = await openClient(fixture.url);
        const oldUrl = fixture.url;
        const oldPort = Number(new URL(oldUrl).port);
        const started = Date.now();
        const startCount = await fixture.starts();
        if (failure === "disabled") await fixture.setSettings({ extensions: [] });
        else if (failure === "import-failure") await writeFile(fixture.wrapper, "export default function ( { THIS IS A REAL SYNTAX ERROR\n");
        else await fixture.setWrapper(12_000);
        fixture.command("/reload");
        await waitFor(() => client.frames.some((frame) => frame.t === "switching" && frame.reason === "reload"), "old Hub received reload shutdown");
        await waitFor(() => client.closed, "real 10-second rebind deadline closes WS", 16_000);
        const closeMs = Date.now() - started;
        assert.ok(closeMs >= 9_500 && closeMs < 15_000, `expected approximately 10s deadline, observed ${closeMs}ms`);
        assert.equal(await health(oldPort), false);
        await waitFor(async () => (await fixture.starts()) > startCount, "replacement runtime reaches session_start", 20_000);
        if (failure === "disabled") { await fixture.setSettings({ extensions: [fixture.wrapper] }); await fixture.reload(); }
        else if (failure === "import-failure") { await fixture.setWrapper(); await fixture.reload(); }
        else await fixture.setWrapper();
        await verifyNoAutoRestart(fixture, oldUrl);
        return { deadlineMs: 10_000, observedSocketCloseMs: closeMs, releasedPort: oldPort, resumedManually: true };
      });
    }
  } finally { await fixture.close("reload-faults"); }
}

async function configurationAndPorts() {
  await check("trusted project piPane deep-merges global values and command/flags override settings", async () => {
    const globalPort = await freePort(), projectPort = await freePort(), flagPort = await freePort(), commandPort = await freePort();
    const fixture = await startReal({ port: flagPort, settings: { piPane: { host: "127.0.0.1", port: globalPort, noOpen: true } },
      projectSettings: { piPane: { port: projectPort } }, omitNoOpenFlag: true });
    try {
      assert.equal(Number(new URL(fixture.url).port), flagPort);
      const probe = await waitFor(async () => (await fixture.probes())[0], "getSettings probe");
      assert.deepEqual(probe.piPane, { host: "127.0.0.1", port: projectPort, noOpen: true });
      assert.equal(probe.copyDetached, true);
      fixture.command("/web stop"); await waitFor(async () => !await health(flagPort), "stop configured instance");
      fixture.command(`/web --no-open --port ${commandPort}`);
      await waitFor(() => fixture.url && Number(new URL(fixture.url).port) === commandPort, "command override port");
      const client = await openClient(fixture.url); await client.close();
      // A malformed configuration introduced by reload cannot disable revocation/status.
      await fixture.setSettings({ piPane: { host: "0.0.0.0", noOpen: true } });
      await fixture.reload();
      const active = await openClient(fixture.url);
      const beforeStatus = fixture.terminal.length;
      fixture.command("/web status");
      await waitFor(() => stripAnsi(fixture.terminal.slice(beforeStatus)).includes("viewer(s)"), "status still works with invalid startup config");
      const beforeRotate = fixture.url;
      fixture.command("/web --rotate --no-open");
      await waitFor(() => fixture.url !== beforeRotate && active.closed, "rotate still works with invalid startup config");
      const rotated = await openClient(fixture.url);
      fixture.command("/web stop");
      await waitFor(() => rotated.closed, "stop still works with invalid startup config");
      assert.equal(await health(commandPort), false);
      return { precedence: "command > flag > trusted project > global", snapshotCopyDetached: true, merged: probe.piPane,
        invalidConfigCannotBlock: ["status", "rotate", "stop"] };
    } finally { await fixture.close("config-precedence"); }
  });
  await check("merged persistent port starts without a web-port flag and malformed nonloopback config is rejected", async () => {
    const configuredPort = await freePort();
    const fixture = await startReal({ omitPortFlag: true, omitNoOpenFlag: true, settings: { piPane: { host: "127.0.0.1", port: configuredPort, noOpen: true } } });
    try { assert.equal(Number(new URL(fixture.url).port), configuredPort); }
    finally { await fixture.close("config-only"); }
    const deniedPort = await freePort();
    const denied = await startReal({ expectUrl: false, omitPortFlag: true, settings: { piPane: { host: "0.0.0.0", port: deniedPort, noOpen: true } } });
    try {
      await waitFor(() => stripAnsi(denied.terminal).includes("piPane.host may be non-loopback only"), "config rejection is visible");
      assert.equal(await health(deniedPort), false); assert.equal(denied.url, undefined);
    } finally { await denied.close("config-denied"); }
    return { configuredPortWorks: true, nonloopbackRejected: true };
  });
  await check("explicit occupied port fails visibly without falling back", async () => {
    const occupied = await listeningServer();
    let fixture;
    try {
      fixture = await startReal({ port: occupied.port, expectUrl: false });
      await waitFor(() => stripAnsi(fixture.terminal).includes("EADDRINUSE"), "explicit address-in-use notice");
      assert.equal(fixture.url, undefined);
      fixture.command("/web status");
      await waitFor(() => stripAnsi(fixture.terminal).includes("pi-pane stopped."), "failed start leaves stopped state");
      return { port: occupied.port, fallback: false };
    } finally { await fixture?.close("explicit-port-conflict"); await occupied.close(); }
  });
  await check("IPv6 loopback permits repeated /web --host ::1 without address mismatch", async () => {
    const fixture = await startReal({ settings: { piPane: { host: "::1", noOpen: true } } });
    try {
      assert.equal(new URL(fixture.url).hostname, "[::1]");
      const client = await openClient(fixture.url);
      const previousUrl = fixture.url, after = fixture.terminal.length;
      fixture.command("/web --host ::1 --no-open");
      await waitFor(async () => (await fixture.probes()).some((event) => event.event === "web_command_completed" && event.args === "--host ::1 --no-open"), "IPv6 /web command completed");
      await pause(100);
      assert.equal(fixture.url, previousUrl);
      assert.ok(!stripAnsi(fixture.terminal.slice(after)).includes("Stop the current service before changing"));
      assert.equal((await fetch(new URL("/healthz", fixture.url))).status, 200);
      await client.close();
      return { sameAddressReused: true, IPv6OriginAndHostVerified: true };
    } finally { await fixture.close("ipv6-repeat"); }
  });
  await check("missing required public API yields a visible compatibility error without listening", async () => {
    const fixture = await startReal({ expectUrl: false, missingApi: "getSettings" });
    try {
      await waitFor(() => stripAnsi(fixture.terminal).includes("missing: pi.getSettings"), "compatibility error is visible");
      assert.equal(fixture.url, undefined); assert.equal(await health(fixture.port), false);
      return { injectedMissingApi: "pi.getSettings", listening: false };
    } finally { await fixture.close("missing-api"); }
  });
  await check("default port fallback supports two independent pi instances and repeated /web", async () => {
    let occupied;
    try { occupied = await listeningServer(7878); } catch (error) { if (error.code !== "EADDRINUSE") throw error; }
    let first, second;
    try {
      first = await startReal({ defaultPort: true });
      second = await startReal({ defaultPort: true });
      const firstPort = Number(new URL(first.url).port), secondPort = Number(new URL(second.url).port);
      assert.ok(firstPort > 7878 && firstPort <= 7897); assert.ok(secondPort > firstPort && secondPort <= 7897);
      const firstClient = await openClient(first.url), secondClient = await openClient(second.url);
      assert.notEqual(firstClient.snapshot.session.id, secondClient.snapshot.session.id);
      const initialUrl = first.url;
      first.command("/web --no-open"); await pause(250);
      assert.equal(first.url, initialUrl, "repeated /web keeps token/listener");
      first.command("/web stop"); await waitFor(() => firstClient.closed, "one instance stops");
      assert.equal(await health(secondPort), true, "second instance stays independent");
      await secondClient.close();
      return { initialPortOccupiedByHarness: !!occupied, firstPort, secondPort, independentSessionIds: true };
    } finally { await first?.close("multi-first"); await second?.close("multi-second"); await occupied?.close(); }
  });
}

async function settingsConcurrency() {
  await check("official concurrent settings writers preserve unknown piPane fields; snapshots are not writers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pane-settings-"));
    const agentDir = join(directory, "agent"), cwd = join(directory, "workspace");
    await mkdir(agentDir); await mkdir(cwd);
    const config = { host: "127.0.0.1", port: 8234, noOpen: true };
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ piPane: config, marker: { preserved: true } }));
    const env = { ...envBase(), PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };
    const workers = ["theme", "padding"].map((kind) => {
      const code = `import {SettingsManager} from ${JSON.stringify(packageModule)};
import {writeFile,access} from 'node:fs/promises';
const manager=SettingsManager.create(${JSON.stringify(cwd)},${JSON.stringify(agentDir)});
const snapshot=manager.getSettings(); snapshot.piPane.port=65534;
await writeFile(${JSON.stringify(join(directory, `${kind}.ready`))},'ready');
while (true) { try { await access(${JSON.stringify(join(directory, "go"))}); break; } catch { await new Promise(r=>setTimeout(r,10)); } }
${kind === "theme" ? "manager.setTheme('light');" : "manager.setEditorPaddingX(5);"}
await manager.flush();
if(manager.drainErrors().length) process.exitCode=1;
`;
      return run(process.execPath, ["--input-type=module", "-e", code], { cwd, env });
    });
    try {
      await waitFor(async () => {
        try { await readFile(join(directory, "theme.ready")); await readFile(join(directory, "padding.ready")); return true; } catch { return false; }
      }, "both SettingsManager instances captured the initial file");
      await writeFile(join(directory, "go"), "go");
      await Promise.all(workers);
      const saved = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
      assert.deepEqual(saved.piPane, config); assert.equal(saved.theme, "light"); assert.equal(saved.editorPaddingX, 3); assert.deepEqual(saved.marker, { preserved: true });
      report.decisions.push("piPane is strictly read-only through pi.getSettings(); no public arbitrary-field writer exists. Host known-field saves preserve unknown fields, but writeFileSync is not crash-atomic rename.");
      return { concurrentKnownFieldWrites: ["theme", "editorPaddingX"], unknownPiPanePreserved: true, directSnapshotMutationPersisted: false,
        saveImplementation: "proper-lockfile + reread/dirty-field merge + writeFileSync", automaticPiPaneWrites: "unsupported; intentionally absent" };
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}

async function isolatedPackageInstall() {
  await check("packed prebuilt package installs dependencies in a separate directory and serves its own assets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pane-package-"));
    let fixture;
    try {
      const installDir = join(directory, "install"); await mkdir(installDir);
      const userNpmrc = join(directory, "user.npmrc"), globalNpmrc = join(directory, "global.npmrc");
      await writeFile(userNpmrc, ""); await writeFile(globalNpmrc, "");
      const npmEnv = { ...envBase(), NPM_CONFIG_USERCONFIG: userNpmrc, NPM_CONFIG_GLOBALCONFIG: globalNpmrc, NPM_CONFIG_CACHE: join(directory, "npm-cache") };
      const pack = await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], { env: npmEnv });
      const packageInfo = JSON.parse(pack.stdout)[0];
      await writeFile(join(installDir, "package.json"), JSON.stringify({ name: "pi-pane-m0-isolated-install", private: true, type: "module" }));
      await run("npm", ["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", join(directory, packageInfo.filename),
        "@earendil-works/pi-coding-agent@1.0.4", "@earendil-works/pi-ai@1.0.4"], { cwd: installDir, env: npmEnv });
      const packageRoot = join(installDir, "node_modules/pi-pane");
      const ws = JSON.parse(await readFile(join(installDir, "node_modules/ws/package.json"), "utf8"));
      assert.equal(ws.version, "8.22.0");
      const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
      assert.deepEqual(manifest.pi.extensions, ["./dist/extension/index.js"]);
      const installedHostRoot = join(installDir, "node_modules/@earendil-works/pi-coding-agent");
      const installedHostVersion = JSON.parse(await readFile(join(installedHostRoot, "package.json"), "utf8")).version;
      assert.equal(installedHostVersion, "1.0.4");
      const installedAiVersion = JSON.parse(await readFile(join(installDir, "node_modules/@earendil-works/pi-ai/package.json"), "utf8")).version;
      assert.equal(installedAiVersion, "1.0.4");
      const installedTuiVersion = JSON.parse(await readFile(join(installDir, "node_modules/@earendil-works/pi-tui/package.json"), "utf8")).version;
      fixture = await startReal({ packageRoot, cli: join(installedHostRoot, "dist/cli.js") });
      const client = await openClient(fixture.url);
      const response = await fetch(new URL("/", fixture.url));
      assert.equal(response.status, 200);
      const html = await response.text();
      const asset = /src="([^"]+\.js)"/.exec(html)?.[1]; assert.ok(asset);
      assert.equal((await fetch(new URL(asset, fixture.url))).status, 200);
      const submitted = await client.command("prompt", { text: "M0_INSTALLED_PACKAGE" });
      assert.equal(submitted.ack.status, "dispatched"); await client.settled("M0_INSTALLED_PACKAGE"); await client.close();
      return { tarball: packageInfo.filename, packageFiles: packageInfo.files.length, wsInstalledIndependently: ws.version,
        hostPeers: "independently installed and explicitly pinned", installedHostVersion, installedAiVersion, installedTuiVersion,
        piTuiResolution: "actual extension loaded from the npm consumer's host transitive dependency; pnpm isolation not covered", installedPackagePath: packageRoot,
        installedHostPath: installedHostRoot, npmPublication: false, staticAsset: asset, actualConversation: true };
    } finally { await fixture?.close("isolated-package"); await rm(directory, { recursive: true, force: true }); }
  });
}

try {
  // Independent tests make progress while real lifecycle leases expire in the other lane.
  const outcomes = await Promise.allSettled([lifecycleFaults(), (async () => { await configurationAndPorts(); await settingsConcurrency(); await isolatedPackageInstall(); })()]);
  const failed = outcomes.find((outcome) => outcome.status === "rejected");
  if (failed) throw failed.reason;
  report.finishedAt = new Date().toISOString(); report.status = "passed";
} catch (error) { report.finishedAt = new Date().toISOString(); report.status = "failed"; report.error = redact(error.stack ?? error); console.error(report.error); process.exitCode = 1; }
finally { await writeFile(join(output, "lifecycle-report.json"), JSON.stringify(report, null, 2)); }
