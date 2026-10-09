#!/usr/bin/env node
/** Real TUI → /web foreground handoff configuration/lifecycle checks, zero remote calls. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startFixture, openClient, readPiHost, commandResult, waitFor } from "./m0-smoke.mjs";
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(process.env.PI_M0_LIFECYCLE_REPORT_DIR || join(project, "build-artifacts/m3/handoff/m0/lifecycle"));
const host = await readPiHost();
const packageModule = pathToFileURL(join(host.packageRoot, "dist/index.js")).href;
const pause = ms => new Promise(done => setTimeout(done, ms));
const stripAnsi = value => value.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
const redact = value => String(value).replace(/#t=[A-Za-z0-9_-]+/g, "#t=[REDACTED]");
const envBase = () => Object.fromEntries(["PATH", "TMPDIR", "LANG", "LC_ALL", "SYSTEMROOT"].filter(key => process.env[key]).map(key => [key, process.env[key]]));
const report = { startedAt: new Date().toISOString(), piVersion: host.version, realTui: true, realModelCalls: 0,
  isolation: "Temporary HOME and agent/session directories, local deterministic provider, no daily credentials", checks: [], decisions: [],
  retiredMirrorChecks: ["TUI extension reload/rebind deadline: there is no TUI/Bridge/Hub mirror after handoff; replaced by fail-closed child/host crash checks in m3-handoff", "Repeated /web/status/stop/rotate in a live TUI: those commands are removed; refusal, Ctrl+C, public access_rotate replace them", "Local prebuilt tarball consumer install: covered by m2-install, avoiding a duplicate package/network install"] };
await mkdir(output, { recursive: true });
async function run(command, args, options = {}) {
  const child = spawn(command, args, { cwd: options.cwd ?? project, env: options.env ?? envBase(), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
  const code = await new Promise((done, reject) => { child.once("error", reject); child.once("exit", done); });
  if (code !== 0) throw new Error(`${command} failed (${code}): ${redact(stderr + stdout).slice(-5000)}`);
  return { stdout, stderr };
}
async function occupiedPort(port = 0) {
  const server = createServer((_request, response) => response.end("occupied by fixture"));
  await new Promise((done, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", done); });
  return { server, port: server.address().port, close: () => new Promise(done => server.close(done)) };
}
async function freePort() { const item = await occupiedPort(); const port = item.port; await item.close(); return port; }
async function health(port) { try { return (await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(700) })).ok; } catch { return false; } }
async function check(name, action) {
  const started = Date.now();
  try { const details = await action(); report.checks.push({ name, status: "passed", durationMs: Date.now() - started, details }); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({ name, status: "failed", durationMs: Date.now() - started, error: redact(error.stack ?? error) }); throw error; }
}
const fixtures = [];
async function fixture(options = {}) { const item = await startFixture(options); fixtures.push(item); return item; }
async function settingsConcurrency() {
  await check("official concurrent settings writers preserve unknown piPane fields; snapshots are not writers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pane-settings-"));
    const agentDir = join(directory, "agent"), cwd = join(directory, "workspace");
    await mkdir(agentDir); await mkdir(cwd);
    const config = { host: "127.0.0.1", port: 8234, noOpen: true };
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ piPane: config, marker: { preserved: true } }));
    const env = { ...envBase(), HOME: directory, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };
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


try {
  await check("configuration flags never start a listener before an explicit idle /web", async () => {
    const item = await fixture({ autoWeb: false });
    assert.equal(item.argv.includes("--web"), false);
    assert.equal(item.url, undefined); assert.equal(await health(item.port), false);
    for (const arg of ["status", "stop", "handoff", "--mirror", "--rotate", "qr"]) {
      const before = item.terminal.length; item.tuiCommand(`/web ${arg}`);
      await waitFor(() => stripAnsi(item.terminal.slice(before)).includes("Unknown /web argument"), `removed command ${arg} is refused`);
      assert.equal(await health(item.port), false);
    }
    await item.handoffToWeb(); assert.equal(await health(item.port), true);
  });
  await check("an in-memory --no-session TUI refuses handoff before starting any service", async () => {
    const item = await fixture({ autoWeb: false, seedSession: false, extraArgs: ["--no-session"] });
    const before = item.terminal.length; item.tuiCommand("/web");
    await waitFor(() => /saved|persist|session file|--no-session/i.test(stripAnsi(item.terminal.slice(before))), "no saved session refusal");
    assert.equal(item.url, undefined); assert.equal(item.exitCode, undefined); assert.equal(await health(item.port), false);
  });
  await check("CLI /web configuration overrides persistent piPane settings without writing settings", async () => {
    const persistent = await freePort(), flag = await freePort();
    const item = await fixture({ settings: { piPane: { host: "127.0.0.1", port: persistent, noOpen: true }, marker: "preserved" }, extraArgs: ["--web-port", String(flag)] });
    assert.equal(Number(new URL(item.url).port), flag);
    const saved = JSON.parse(await readFile(join(item.agentDir, "settings.json"), "utf8"));
    assert.equal(saved.piPane.port, persistent); assert.equal(saved.marker, "preserved");
  });
  await check("/web command options override CLI and persistent options", async () => {
    const commandPort = await freePort(); const item = await fixture({ autoWeb: false, settings: { piPane: { port: await freePort(), noOpen: true } } });
    await item.handoffToWeb(["--port", String(commandPort), "--no-open"]);
    assert.equal(Number(new URL(item.url).port), commandPort); assert.equal(await health(item.port), false);
  });
  await check("persistent piPane options apply when no CLI port override is supplied", async () => {
    const configuredPort = await freePort();
    const item = await fixture({ webConfigFlags: false, settings: { piPane: { host: "127.0.0.1", port: configuredPort, noOpen: true } } });
    assert.equal(Number(new URL(item.url).port), configuredPort);
  });
  await check("invalid persistent settings fail closed and preserve the TUI", async () => {
    const item = await fixture({ autoWeb: false, settings: { piPane: { host: "0.0.0.0" } } });
    item.tuiCommand("/web");
    await waitFor(() => /piPane|loopback/.test(stripAnsi(item.terminal)), "invalid settings error");
    await pause(100); assert.equal(item.url, undefined); assert.equal(item.exitCode, undefined); assert.equal(await health(item.port), false);
  });
  await check("occupied default port falls forward and multiple foreground hosts remain independent", async () => {
    const busy = await occupiedPort(7878).catch(error => { if (error.code !== "EADDRINUSE") throw error; return { port: 7878, close: async () => {} }; });
    try {
      const first = await fixture({ webConfigFlags: false, settings: { piPane: { noOpen: true } } });
      const firstPort = Number(new URL(first.url).port); assert.ok(firstPort > busy.port);
      const second = await fixture({ webConfigFlags: false, settings: { piPane: { noOpen: true } } });
      const secondPort = Number(new URL(second.url).port); assert.notEqual(firstPort, secondPort);
      const a = await openClient(first.url), b = await openClient(second.url);
      assert.notEqual(a.snapshot.session.id, b.snapshot.session.id);
      first.write("\u0003"); await waitFor(() => first.exitCode !== undefined, "first stops");
      assert.equal(await health(firstPort), false); assert.equal(await health(secondPort), true);
      await a.close(); await b.close(); return { firstPort, secondPort };
    } finally { await busy.close(); }
  });
  await check("Ctrl+C prints a recovery command for the browser's latest session", async () => {
    const item = await fixture(); const client = await openClient(item.url);
    const moving = await client.command("session_new"); assert.equal((await commandResult(client, moving.frame)).status, "completed");
    await client.command("prompt", { text: "M0_RECOVERY_LAST" }); await client.settled("M0_RECOVERY_LAST");
    const sessionId = client.snapshot.session.id;
    item.write("\u0003"); await waitFor(() => item.exitCode !== undefined, "host stops");
    assert.equal(item.exitCode, 0); assert.equal(await health(Number(new URL(item.url).port)), false);
    assert.match(stripAnsi(item.terminal), /To resume this session:.*pi --session/);
    const session = (await item.events()).filter(event => event.event === "session_start" && event.sessionId === sessionId).at(-1);
    assert.ok(stripAnsi(item.terminal).includes(session.sessionFile)); await client.close();
  });
  await settingsConcurrency();
  report.status = "passed";
} catch (error) { report.status = "failed"; report.error = redact(error.stack ?? error); process.exitCode = 1; }
finally {
  for (const [index, item] of fixtures.entries()) { await item.close(); await writeFile(join(output, `${index}.terminal.log`), redact(stripAnsi(item.terminal + item.processError))); await item.remove(); }
  report.finishedAt = new Date().toISOString(); await writeFile(join(output, "lifecycle-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
