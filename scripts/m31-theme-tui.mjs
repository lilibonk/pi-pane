#!/usr/bin/env node
/** Save a shipped theme through the real host, then restart a real pi TUI against the same isolated settings. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { startFixture, openClient, waitFor } from "./m0-smoke.mjs";

const out = resolve(process.env.PI_M31_THEME_REPORT_DIR || "build-artifacts/m3.1/theme-tui");
await mkdir(out, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), "pi-pane-theme-probe-"));
const probe = join(scratch, "theme-probe.ts");
await writeFile(probe, `import { appendFileSync } from "node:fs";
export default function (pi) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode === "rpc") return;
    const theme = ctx.ui.theme;
    const available = ctx.ui.getAllThemes().map(item => item.name);
    const sample = theme.fg("accent", "M31_PORCELAIN_COLOR_SAMPLE");
    appendFileSync(process.env.PI_M0_EVENTS_PATH, JSON.stringify({ event: "m31_theme_tui", pid: process.pid,
      mode: ctx.mode, name: theme.name, appearance: theme.appearance, colorCount: Object.keys(theme.colors).length,
      themeKeys: Object.keys(theme), decorationKeys: Object.keys(theme).filter(key => /decor|svg|pattern/i.test(key)),
      available, sample }) + "\\n");
  });
}
`, { mode: 0o600 });

const report = { startedAt: new Date().toISOString(), scope: "M31-D real TUI bundled theme compatibility", realTui: true,
  isolation: "temporary HOME and agent directory, same settings across TUI restart, PI_OFFLINE=1", realModelCalls: 0, providerRequests: 0, checks: [], status: "running" };
let fixture, client, restarted;
async function check(id, fn) {
  const started = Date.now();
  try { const details = await fn(); report.checks.push({ id, status: "passed", durationMs: Date.now() - started, details }); console.log(`PASS ${id}`); }
  catch (error) { report.checks.push({ id, status: "failed", error: String(error.stack ?? error) }); throw error; }
}
let requestNo = 0;
async function query(action, args = {}) {
  const reqId = `theme-tui:${++requestNo}`; client.send({ t: "host_query", reqId, action, args });
  const response = await waitFor(() => client.frames.find(frame => frame.t === "host_result" && frame.reqId === reqId), action);
  assert.equal(response.error, undefined, response.error?.message); return response.value;
}
function restartTui(original) {
  const proc = spawn("python3", [resolve("scripts/pty-host.py")], { stdio: ["pipe", "pipe", "pipe"] });
  const state = { proc, terminal: "", errors: "", exitCode: undefined, pid: undefined,
    write(data) { if (proc.stdin.writable && !proc.stdin.destroyed) proc.stdin.write(`${JSON.stringify({ type: "write", data })}\n`); },
    async close() {
      if (proc.exitCode !== null) return;
      proc.stdin.write(`${JSON.stringify({ type: "terminate" })}\n`);
      await waitFor(() => proc.exitCode !== null, "restarted TUI exit", 5_000).catch(() => proc.kill("SIGKILL"));
    },
  };
  proc.stdin.on("error", error => { if (!["EPIPE", "ERR_STREAM_DESTROYED"].includes(error.code)) state.errors += String(error); });
  proc.stderr.on("data", data => { state.errors += data.toString(); });
  proc.on("exit", code => { state.exitCode = code; });
  createInterface({ input: proc.stdout }).on("line", line => {
    const item = JSON.parse(line);
    if (item.type === "started") state.pid = item.pid;
    if (item.type === "exit") state.exitCode = item.code;
    if (item.type === "output") {
      state.terminal = (state.terminal + item.data).slice(-500_000);
      if (item.data.includes("\u001b[6n")) state.write("\u001b[1;1R");
    }
  });
  proc.stdin.write(`${JSON.stringify({ argv: original.argv, env: original.env, cwd: original.cwd, controllingTty: true })}\n`);
  return state;
}
try {
  fixture = await startFixture({ autoWeb: false, seedSession: false, loadThemes: true, extraExtensions: [probe],
    settings: { themes: [resolve("themes")] } });
  const initial = await fixture.waitEvent("m31_theme_tui");
  await check("TUI-REGISTERED", async () => {
    for (const name of ["pi-pane-light", "pi-pane-dark", "pi-pane-porcelain"]) assert.ok(initial.available.includes(name), `${name} is registered with pi itself`);
    assert.deepEqual(initial.decorationKeys, []);
    const json = JSON.parse(await readFile(resolve("themes/pi-pane-porcelain.json"), "utf8"));
    assert.equal(Object.keys(json.colors).length, 56); assert.equal(json.appearance, "light");
    assert.deepEqual(Object.keys(json).sort(), ["$schema", "appearance", "colors", "export", "name", "vars"]);
    return { available: initial.available, themeColorCount: Object.keys(json.colors).length, themeJsonHasDecorationFields: false };
  });
  await fixture.handoffToWeb(); client = await openClient(fixture.url); await waitFor(() => client.snapshot, "web snapshot");
  await check("TUI-SAVE-DEFAULT", async () => {
    const themes = await query("themes");
    const porcelain = themes.themes.find(item => item.name === "pi-pane-porcelain");
    assert.equal(porcelain?.global, true, "pi knows the registered source from every project");
    const theme = (await query("settings")).items.find(item => item.key === "theme");
    const host = client.frames.filter(frame => frame.t === "host_state").at(-1);
    const commandNo = client.nextCommandNo++, id = `${client.clientId}:${commandNo}`;
    client.send({ t: "host_command", clientId: client.clientId, commandNo, id, hostRevision: host.revision, command: "setting_set", args: { key: "theme", value: "pi-pane-porcelain", expected: theme.global } });
    const ack = await waitFor(() => client.frames.find(frame => frame.t === "ack" && frame.id === id), "save ack");
    assert.equal(ack.status, "dispatched", ack.error?.message);
    const result = await waitFor(() => client.frames.find(frame => frame.t === "command_result" && frame.id === id), "save result");
    assert.equal(result.status, "completed", result.error?.message); assert.equal(result.value.saved, "confirmed");
    const disk = JSON.parse(await readFile(join(fixture.agentDir, "settings.json"), "utf8"));
    assert.equal(disk.theme, "pi-pane-porcelain");
    return { saved: result.value.saved, savedDefault: disk.theme, global: porcelain.global };
  });
  await client.close(); client = undefined; await fixture.close();
  restarted = restartTui(fixture);
  await check("TUI-RESTART-COLOR-ONLY", async () => {
    const loaded = await waitFor(async () => {
      if (restarted.exitCode !== undefined) throw new Error(`Restarted TUI exited early (${restarted.exitCode}): ${restarted.errors}`);
      return (await fixture.events()).find(event => event.event === "m31_theme_tui" && event.pid !== initial.pid);
    }, "saved theme in restarted real TUI", 30_000);
    assert.equal(loaded.name, "pi-pane-porcelain"); assert.equal(loaded.appearance, "light"); assert.equal(loaded.colorCount, 56);
    assert.deepEqual(loaded.decorationKeys, []);
    assert.match(loaded.sample, /\u001b\[38;2;45;95;147mM31_PORCELAIN_COLOR_SAMPLE/);
    assert.doesNotMatch(restarted.terminal + restarted.errors, /(?:failed|error|invalid).{0,70}theme|theme.{0,70}(?:failed|error|invalid)/i);
    assert.equal((await fixture.events()).filter(event => event.event === "provider_call").length, 0);
    return { mode: loaded.mode, theme: loaded.name, appearance: loaded.appearance, colorCount: loaded.colorCount,
      decorationFields: loaded.decorationKeys, accent: "#2d5f93", ansiTrueColorVerified: true, themeLoadErrors: 0, sameAgentDirectory: true, newTuiProcess: loaded.pid !== initial.pid };
  });
  report.status = "passed";
} catch (error) { report.status = "failed"; report.error = String(error.stack ?? error); process.exitCode = 1; console.error(report.error); }
finally {
  await client?.close().catch(() => {}); await restarted?.close().catch(() => {}); await fixture?.close().catch(() => {}); await fixture?.remove().catch(() => {});
  await rm(scratch, { recursive: true, force: true }); report.finishedAt = new Date().toISOString();
  await writeFile(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.status.toUpperCase()} — ${report.checks.filter(item => item.status === "passed").length}/${report.checks.length} checks; report: ${join(out, "report.json")}`);
}
