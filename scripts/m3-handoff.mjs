#!/usr/bin/env node
/** Formal real-TUI/PTY → foreground host → public WebSocket acceptance. No remote calls. */
import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { startFixture, openClient, commandResult, workbenchQuery, waitFor, textOf } from "./m0-smoke.mjs";
const out = resolve(process.env.PI_M3_HANDOFF_REPORT_DIR || "build-artifacts/m3/handoff");
await mkdir(out, { recursive: true });
const redact = value => String(value).replace(/#t=[A-Za-z0-9_-]+/g, "#t=[REDACTED]").replace(/pi-pane\.bearer\.[A-Za-z0-9_-]+/g, "pi-pane.bearer.[REDACTED]");
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const report = { startedAt: new Date().toISOString(), scope: "Formal foreground handoff, only RPC writer, dialogs, signals, conflicts and crash strategy", realTui: true, realModelCalls: 0, checks: [], status: "running" };
const fixtures = [], clients = [], contenders = [];
const make = async (options = {}) => { const item = await startFixture({ extraExtensions: ["tests/fixtures/handoff-fixture.ts"], controllingTty: true, ...options }); fixtures.push(item); return item; };
const connect = async fixture => { const client = await openClient(fixture.url); clients.push(client); return client; };
const events = async (fixture, event) => (await fixture.events()).filter(item => item.event === event);
async function pids(fixture) {
  const child = await waitFor(async () => (await events(fixture, "m3_session")).find(item => item.mode === "rpc"), "RPC session start");
  return { hostPid: fixture.hostPid, childPid: child.pid, sessionFile: child.sessionFile };
}
async function check(name, fn) {
  const started = Date.now();
  try { const details = await fn(); report.checks.push({ name, status: "passed", durationMs: Date.now() - started, details }); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({ name, status: "failed", durationMs: Date.now() - started, error: redact(error.stack ?? error) }); throw error; }
}
/** A second real TUI on the same pi configuration, opening `sessionFile`. */
function contender(fixture, sessionFile) {
  const proc = spawn("python3", [resolve("scripts/pty-host.py")], { stdio: ["pipe", "pipe", "pipe"] }); contenders.push(proc);
  const state = { proc, text: "", exitCode: undefined, write(data) { proc.stdin.write(`${JSON.stringify({ type: "write", data })}\n`); } };
  createInterface({ input: proc.stdout }).on("line", line => { const item = JSON.parse(line); if (item.type === "output") { state.text += item.data; if (item.data.includes("\u001b[6n")) state.write("\u001b[1;1R"); } if (item.type === "exit") state.exitCode = item.code; });
  const argv = [...fixture.argv]; const oldSession = argv.indexOf("--session"); if (oldSession >= 0) argv.splice(oldSession, 2); argv.push("--session", sessionFile);
  proc.stdin.write(`${JSON.stringify({ argv, cwd: fixture.cwd, env: fixture.env, controllingTty: true })}\n`);
  return state;
}
const plain = text => text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\s+/g, " ");
async function completed(client, name, args = {}) {
  const operation = await client.command(name, args); assert.equal(operation.ack.status, "dispatched", operation.ack.error?.message);
  const result = await commandResult(client, operation.frame); assert.equal(result.status, "completed", result.error?.message); return result;
}
let fixture, client, owned;
try {
  await check("/web closes the actual TUI then starts a foreground host and exactly one RPC writer", async () => {
    fixture = await make(); client = await connect(fixture); owned = await pids(fixture);
    const tui = (await events(fixture, "m3_session")).find(item => item.mode === "tui");
    assert.equal(tui.pid, owned.hostPid); assert.notEqual(owned.childPid, owned.hostPid);
    assert.ok((await events(fixture, "m3_shutdown")).some(item => item.pid === owned.hostPid && item.reason === "quit"));
    assert.equal(fixture.exitCode, undefined); assert.equal(client.snapshot.caps.host, true);
    await client.settled("M0_HANDOFF_SEED");
    assert.match(fixture.terminal, /Stop: Ctrl\+C/); return owned;
  });
  await check("browser submission runs once in the RPC child and streams without duplicate identities", async () => {
    const prompt = await completed(client, "prompt", { text: "M3_HOST" }); assert.equal(prompt.value.disposition, "started");
    await client.settled("M3_HOST"); assert.deepEqual(client.protocolErrors, []);
  });
  await check("confirm/select/input/editor dialogs return browser responses to public extension UI", async () => {
    for (const [suffix, method, response, expected] of [["", "confirm", { confirmed: true }, true], ["select", "select", { value: "beta" }, "beta"], ["input", "input", { value: "Browser input" }, "Browser input"], ["editor", "editor", { value: "Browser editor\nsecond line" }, "Browser editor\nsecond line"]]) {
      const before = client.frames.length;
      const operation = await client.command("prompt", { text: suffix ? `/m3-dialog ${suffix}` : "/m3-confirm" });
      const dialog = await waitFor(() => client.frames.slice(before).find(frame => frame.t === "ui_request" && frame.method === method), `${method} UI request`);
      client.send({ t: "ui_response", id: dialog.id, ...response });
      assert.equal((await commandResult(client, operation.frame)).value.disposition, "handled");
      const value = await waitFor(async () => (await events(fixture, suffix ? "m3_dialog_value" : "m3_dialog")).find(item => suffix ? item.method === suffix : true), `${method} extension result`);
      assert.equal(suffix ? value.value : value.confirmed, expected); assert.equal(value.mode, "rpc"); assert.equal(value.pid, owned.childPid);
    }
  });
  await check("dialog cancellation/timeout and late responses never apply twice", async () => {
    for (const method of ["cancel", "timeout"]) {
      const before = client.frames.length;
      const operation = await client.command("prompt", { text: `/m3-dialog ${method}` });
      const dialog = await waitFor(() => client.frames.slice(before).find(frame => frame.t === "ui_request"), "cancel/timeout dialog");
      if (method === "cancel") client.send({ t: "ui_response", id: dialog.id, cancelled: true });
      else assert.ok(dialog.expiresAt > Date.now());
      await waitFor(() => client.frames.slice(before).some(frame => frame.t === "ui_resolved" && frame.id === dialog.id), "dialog resolution");
      assert.equal((await commandResult(client, operation.frame)).value.disposition, "handled");
      client.send({ t: "ui_response", id: dialog.id, confirmed: true });
      await waitFor(() => client.frames.slice(before).some(frame => frame.t === "error" && frame.error.code === "dialog_closed"), "late response refused");
    }
  });
  await check("public extension status/widget/title/editor state and notification survive reconnect", async () => {
    await completed(client, "prompt", { text: "/m3-ui" });
    await waitFor(() => client.frames.some(frame => frame.t === "ui_state" && frame.title === "M3 fixture title"), "UI state update");
    const fresh = await connect(fixture);
    assert.equal(fresh.snapshot.ui.statuses["m3-status"], "M3 status ready");
    assert.deepEqual(fresh.snapshot.ui.widgets["m3-widget"].content, ["M3 widget first", "M3 widget second"]);
    assert.equal(fresh.snapshot.ui.editorText, "M3 extension draft"); assert.equal(fresh.snapshot.ui.title, "M3 fixture title");
    assert.ok(client.frames.some(frame => frame.t === "notice" && frame.message === "M3 notification"));
    await completed(client, "prompt", { text: "/m3-ui clear" });
    await waitFor(() => fresh.frames.some(frame => frame.t === "ui_state" && frame.title === "M3 cleared" && !frame.statuses["m3-status"] && !frame.widgets["m3-widget"]), "UI state clears");
  });
  await check("session list/current marker, rename, clone and switch follow RPC state", async () => {
    const original = client.snapshot.session.id;
    await completed(client, "session_rename", { name: "M3 renamed" });
    let sessions = await workbenchQuery(client, "sessions", { scope: "all" });
    assert.ok(sessions.sessions.some(item => item.id === original && item.current && item.name === "M3 renamed"));
    await completed(client, "session_clone"); await waitFor(() => client.snapshot?.session.id !== original, "clone reset");
    assert.equal(client.users("M3_HOST").length, 1);
    sessions = await workbenchQuery(client, "sessions", { scope: "all" });
    assert.equal(sessions.sessions.filter(item => item.current).length, 1);
    assert.ok(sessions.sessions.some(item => item.id === client.snapshot.session.id && item.current));
    await completed(client, "session_switch", { sessionId: original }); await waitFor(() => client.snapshot?.session.id === original, "original restored");
    owned = await pids(fixture);
  });
  await check("another TUI on a /web-owned session is warned but stays open, and its own /web is refused", async () => {
    const active = (await events(fixture, "m3_session")).filter(item => item.mode === "rpc").at(-1);
    const other = contender(fixture, active.sessionFile);
    await waitFor(() => plain(other.text).includes("running in a /web browser host"), "ownership warning", 30_000);
    other.write("/web\r");
    await waitFor(() => plain(other.text).includes("already running in another /web host"), "second /web refused", 30_000);
    await new Promise(done => setTimeout(done, 1000));
    assert.equal(other.exitCode, undefined, "the warned TUI stays open"); assert.equal(fixture.exitCode, undefined);
    assert.equal((await stat(`${active.sessionFile}.pi-pane.lock`)).mode & 0o777, 0o600);
    other.proc.stdin.write(`${JSON.stringify({ type: "terminate" })}\n`); await waitFor(() => other.exitCode !== undefined, "contender closed", 15_000);
  });
  await check("Ctrl+C stops the service and its writer, and recovery names the browser's latest file", async () => {
    const active = (await events(fixture, "m3_session")).filter(item => item.mode === "rpc").at(-1);
    fixture.write("\u0003"); await waitFor(() => fixture.exitCode !== undefined, "Ctrl+C stop");
    assert.equal(fixture.exitCode, 0); await waitFor(() => !alive(active.pid), "RPC child stopped");
    assert.ok(fixture.terminal.includes(active.sessionFile)); assert.match(fixture.terminal, /To resume this session:/);
    await assert.rejects(() => fetch(new URL("/healthz", fixture.url)));
    await assert.rejects(() => stat(`${active.sessionFile}.pi-pane.lock`), error => error.code === "ENOENT");
    const lines = (await readFile(active.sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const entries = lines.filter(entry => entry.type !== "session"), ids = new Set(entries.map(entry => entry.id));
    assert.ok(entries.every(entry => entry.parentId === null || ids.has(entry.parentId)));
    assert.ok(entries.some(entry => entry.type === "message" && entry.message.role === "user" && textOf(entry.message) === "M3_HOST"));
  });
  await check("two ordinary TUIs can open one session; neither takes a lock", async () => {
    const first = await make({ autoWeb: false });
    const session = await waitFor(async () => (await events(first, "m3_session")).find(item => item.mode === "tui"), "first TUI session");
    const second = contender(first, session.sessionFile);
    await waitFor(async () => (await events(first, "m3_session")).filter(item => item.mode === "tui" && item.sessionFile === session.sessionFile).length >= 2, "second TUI session", 30_000);
    await new Promise(done => setTimeout(done, 1500));
    assert.equal(second.exitCode, undefined); assert.equal(first.exitCode, undefined);
    assert.ok(!plain(second.text).includes("/web browser host"), "no ownership warning without a /web host");
    await assert.rejects(() => stat(`${session.sessionFile}.pi-pane.lock`), error => error.code === "ENOENT");
    second.proc.stdin.write(`${JSON.stringify({ type: "terminate" })}\n`); await waitFor(() => second.exitCode !== undefined, "second closed", 15_000);
  });
  await check("an extension persisting entries after the turn settled is the RPC writer, not a conflict", async () => {
    const other = await make({ envOverrides: { PI_M0_APPEND_DELAY: "300" } }); const viewer = await connect(other); const owned = await pids(other);
    for (const [index, text] of ["M3_PROBE_ONE", "M3_PROBE_TWO", "M3_PROBE_THREE"].entries()) {
      await completed(viewer, "prompt", { text }); await viewer.settled(text);
      await waitFor(async () => (await events(other, "m3_probe_append")).length > index, `delayed extension write ${index + 1}`);
    }
    assert.equal(other.exitCode, undefined); assert.ok(alive(owned.childPid));
    assert.equal((await events(other, "provider_call")).filter(item => item.input?.startsWith("M3_PROBE_")).length, 3);
    assert.ok(!/ownership conflict/.test(plain(other.terminal)));
    return { appends: (await events(other, "m3_probe_append")).length };
  });
  if (process.env.PI_M3_LONG === "1") await check("an extension dialog left open past two minutes still takes the answer (PI_M3_LONG=1)", async () => {
    const other = await make(); const viewer = await connect(other); const owned = await pids(other);
    const operation = await viewer.command("prompt", { text: "/m3-confirm" });
    const dialog = await waitFor(() => viewer.frames.find(frame => frame.t === "ui_request"), "dialog");
    await new Promise(done => setTimeout(done, 130_000));
    assert.equal(other.exitCode, undefined); assert.ok(alive(owned.childPid)); assert.equal(viewer.closed, false);
    viewer.send({ t: "ui_response", id: dialog.id, confirmed: true });
    assert.equal((await commandResult(viewer, operation.frame)).value.disposition, "handled");
    const value = await waitFor(async () => (await events(other, "m3_dialog")).at(-1), "answer reached the extension");
    assert.equal(value.confirmed, true); assert.equal(value.pid, owned.childPid);
  });
  await check("closing the terminal sends SIGHUP and stops host plus RPC child", async () => {
    const other = await make(); const owned = await pids(other); other.proc.kill("SIGKILL");
    await waitFor(() => !alive(owned.hostPid) && !alive(owned.childPid), "PTY close cleanup", 15_000); return owned;
  });
  await check("SIGKILL of the host closes stdin and cannot leave an orphan writer", async () => {
    const other = await make(); const owned = await pids(other); process.kill(owned.hostPid, "SIGKILL");
    await waitFor(() => !alive(owned.childPid), "child EOF after host crash", 15_000); return owned;
  });
  await check("RPC child crash stops the foreground service with no automatic restart", async () => {
    const other = await make(); const viewer = await connect(other); const owned = await pids(other);
    const starts = (await events(other, "m3_session")).filter(item => item.mode === "rpc").length;
    process.kill(owned.childPid, "SIGKILL");
    await waitFor(() => other.exitCode !== undefined && viewer.closed, "fail-closed child crash", 15_000);
    assert.equal((await events(other, "m3_session")).filter(item => item.mode === "rpc").length, starts);
    await assert.rejects(() => fetch(new URL("/healthz", other.url)));
    assert.match(other.terminal, /resume|Recovery|recover/i);
  });
  await check("unexpected session-file changes are detected before another web write", async () => {
    const other = await make(); const viewer = await connect(other); const owned = await pids(other);
    await appendFile(owned.sessionFile, "\n");
    const attempt = await viewer.command("prompt", { text: "M3_CONFLICT_MUST_NOT_RUN" });
    if (attempt.ack.status === "dispatched") {
      const outcome = await waitFor(() => viewer.frames.find(frame => frame.t === "command_result" && frame.id === attempt.frame.id) ?? (viewer.closed && { status: "closed" }), "conflict stops or reports failed result");
      assert.ok(["failed", "closed"].includes(outcome.status));
    } else assert.equal(attempt.ack.status, "rejected");
    assert.equal((await other.events()).filter(item => item.event === "provider_call" && item.input === "M3_CONFLICT_MUST_NOT_RUN").length, 0);
  });
  report.status = "passed";
} catch (error) { report.status = "failed"; report.error = redact(error.stack ?? error); process.exitCode = 1; }
finally {
  for (const item of clients) await item.close().catch(() => item.socket.terminate());
  for (const proc of contenders) if (proc.exitCode === null) proc.kill("SIGKILL");
  for (const [i, item] of fixtures.entries()) { await item.close(); await writeFile(join(out, `${i}.terminal.redacted.log`), redact(item.terminal + item.processError)); await writeFile(join(out, `${i}.events.jsonl`), await readFile(item.eventPath)); await item.remove(); }
  report.finishedAt = new Date().toISOString(); await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n"); console.log(JSON.stringify(report, null, 2));
}
