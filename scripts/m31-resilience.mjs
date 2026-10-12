#!/usr/bin/env node
/** Real-process replacement fault checks. No production fault hooks and no real credentials. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { execFileSync, spawn } from "node:child_process";
import { chromium } from "playwright";
import { startFixture, openClient, commandResult, workbenchQuery, waitFor, readPiHost } from "./m0-smoke.mjs";

const out = resolve(process.env.PI_M31_REPORT_DIR || "build-artifacts/m3.1/resilience");
await mkdir(out, { recursive: true });
const key = "sk-m31-resilience-fake-local-only";
const redact = value => String(value).replaceAll(key, "[SENTINEL]").replace(/#t=[A-Za-z0-9_-]+/g, "#t=[REDACTED]");
const report = { startedAt: new Date().toISOString(), scope: "M31-5 replacement signals, conflicts, retry and credential-root boundaries",
  realTui: true, realModelCalls: 0, checks: [], cleanup: [], status: "running" };
const fixtures = [], clients = [];
let browser;
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const exists = path => stat(path).then(() => true, () => false);
const lastHost = client => client.frames.filter(frame => frame.t === "host_state").at(-1);
const operation = client => client.frames.filter(frame => frame.t === "account_state").at(-1)?.operation;
let requestNo = 0;
async function query(client, action, args = {}) {
  const reqId = `resilience:${++requestNo}`; client.send({ t: "host_query", reqId, action, args });
  const frame = await waitFor(() => client.frames.find(frame => frame.t === "host_result" && frame.reqId === reqId), action);
  if (frame.error) throw Object.assign(new Error(frame.error.message), { code: frame.error.code });
  return frame.value;
}
async function hostCommand(client, command, args = {}) {
  const commandNo = client.nextCommandNo++, id = `${client.clientId}:${commandNo}`;
  client.send({ t: "host_command", clientId: client.clientId, commandNo, id, hostRevision: lastHost(client).revision, command, args });
  const ack = await waitFor(() => client.frames.find(frame => frame.t === "ack" && frame.id === id), `ack ${command}`);
  if (ack.status !== "dispatched") throw Object.assign(new Error(ack.error?.message), { code: ack.error?.code });
  const result = await waitFor(() => client.frames.find(frame => frame.t === "command_result" && frame.id === id), command, 30_000);
  if (result.status !== "completed") throw Object.assign(new Error(result.error?.message), { code: result.error?.code });
  return result.value;
}
async function run(client, command, args = {}) {
  const item = await client.command(command, args); assert.equal(item.ack.status, "dispatched", item.ack.error?.message);
  return commandResult(client, item.frame);
}
async function check(id, name, action) {
  const started = Date.now();
  try { const details = await action(); report.checks.push({ id, name, status: "passed", durationMs: Date.now() - started, details }); console.log(`PASS ${id} ${name}`); }
  catch (error) { report.checks.push({ id, name, status: "failed", error: redact(error.stack ?? error) }); throw error; }
}
async function start() {
  const fixture = await startFixture({ extraExtensions: ["tests/fixtures/m31-resilience.ts"] }); fixtures.push(fixture);
  const root = await realpath(fixture.directory), target = join(root, "target"); await mkdir(target);
  const saved = SessionManager.create(target, join(fixture.agentDir, "sessions", "target"));
  saved.appendMessage({ role: "user", content: "M31_TARGET_HISTORY", timestamp: Date.now() });
  saved.appendMessage({ role: "assistant", content: [{ type: "text", text: "M31_TARGET_REPLY" }], api: "pi-pane-m0-api", provider: "pi-pane-m0", model: "deterministic",
    timestamp: Date.now(), stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const client = await openClient(fixture.url); clients.push(client); await waitFor(() => client.snapshot, "snapshot");
  const original = (await fixture.events()).find(event => event.event === "m31_resilience_start" && event.mode === "rpc"); assert.ok(original);
  const control = values => writeFile(join(root, "resilience-plan.json"), JSON.stringify({ target, ...values }));
  const children = async () => (await fixture.events()).filter((event, index, all) => event.event === "m31_resilience_start" && event.mode === "rpc"
    && all.findIndex(item => item.event === event.event && item.mode === "rpc" && item.pid === event.pid) === index);
  const switchTarget = async () => { await workbenchQuery(client, "sessions", { scope: "all" }); return run(client, "session_switch", { sessionId: saved.getSessionId() }); };
  return { fixture, root, target, saved, client, original, control, children, switchTarget };
}
async function assertDeadAndLocks(fixture, children, allowStale = false) {
  for (const child of await children()) await waitFor(() => !alive(child.pid), `writer ${child.pid} exited`, 8000);
  const locks = (await readdir(join(fixture.agentDir, "sessions"), { recursive: true })).filter(name => name.endsWith(".pi-pane.lock"));
  for (const path of locks) {
    const record = JSON.parse(await readFile(join(fixture.agentDir, "sessions", path), "utf8"));
    assert.equal(alive(record.pid), false, "no live lock owner");
    if (record.writerPid) assert.equal(alive(record.writerPid), false, "no live writer in a stale lock");
  }
  if (!allowStale) assert.deepEqual(locks, [], "graceful host stop removes every lock");
  return { children: (await children()).length, remainingDeadLocks: locks.length };
}

try {
  const stages = process.env.PI_M31_RESILIENCE_STAGE ? [process.env.PI_M31_RESILIENCE_STAGE] : ["stopping", "starting", "recovery"];
  const signals = process.env.PI_M31_RESILIENCE_SIGNAL ? [process.env.PI_M31_RESILIENCE_SIGNAL] : ["SIGINT", "SIGHUP", "SIGKILL"];
  for (const stage of stages) for (const signal of signals) await check(`SIGNAL-${stage}-${signal}`, `${signal} during ${stage} leaves no live writer or live lock`, async () => {
    const f = await start();
    await f.control(stage === "stopping" ? { shutdownDelay: 30_000 } : stage === "starting" ? { startDelay: 30_000 } : { startCrash: true });
    const switched = f.switchTarget().catch(error => ({ status: "interrupted", error: String(error) }));
    if (stage === "stopping") await waitFor(async () => (await f.fixture.events()).some(event => event.event === "m31_resilience_shutdown_begin" && event.pid === f.original.pid), "shutdown barrier");
    else if (stage === "starting") await waitFor(async () => (await f.fixture.events()).some(event => event.event === "m31_resilience_target_start"), "startup barrier");
    else await waitFor(() => lastHost(f.client)?.phase === "recovery_required", "failed target recovery");
    const before = (await f.children()).length;
    const started = Date.now(); process.kill(f.fixture.hostPid, signal);
    await waitFor(() => f.fixture.exitCode !== undefined, "host exit after signal", 10_000);
    const locks = await assertDeadAndLocks(f.fixture, f.children, signal === "SIGKILL");
    assert.equal((await f.children()).length, before, "stop must not activate another target");
    // Interrupted wire requests can close without a final command_result.
    void switched;
    return { stage, signal, ...locks, stoppedWithinMs: Date.now() - started };
  });
  if (!process.env.PI_M31_RESILIENCE_STAGE) {
    // Input and the lifecycle channel close together when the host dies, in either order. With a shutdown
    // hook, pi may already be waiting in its own shutdown when the child learns the host is gone.
    for (const [id, hook] of [["ORPHAN-COMMAND", undefined], ["ORPHAN-COMMAND-HOOK", "tests/fixtures/m31-orphan-hook.ts"]]) await check(id, `SIGKILL of the host while pi runs a command leaves neither the writer nor the command${hook ? ", with an extension shutdown hook pending" : ""}`, async () => {
      const project = resolve(dirname(fileURLToPath(import.meta.url)), ".."), { cli } = await readPiHost();
      const home = await realpath(await mkdtemp(join(tmpdir(), "pi-pane-m31-orphan-"))), marker = `M31ORPHAN${process.pid}x${Date.now()}`;
      for (const path of ["agent", "tmp", "work"]) await mkdir(join(home, path));
      await writeFile(join(home, "agent", "auth.json"), "{}", { mode: 0o600 });
      const pids = (...args) => { try { return execFileSync("pgrep", args, { encoding: "utf8" }).split("\n").filter(Boolean).map(Number); } catch { return []; } };
      const shells = () => pids("-f", `echo ${marker}`);
      const host = spawn(process.execPath, ["--import", "tsx", join(project, "tests/fixtures/m31-orphan-host.ts"), cli, join(home, "work"), marker, ...(hook ? [join(project, hook)] : [])], { cwd: project, stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: process.env.PATH, HOME: home, TMPDIR: join(home, "tmp"), PI_CODING_AGENT_DIR: join(home, "agent"), PI_CODING_AGENT_SESSION_DIR: join(home, "agent", "sessions"), PI_OFFLINE: "1",
          ...(process.env.PI_M0_EXTENSION ? { PI_M0_EXTENSION: process.env.PI_M0_EXTENSION } : {}) } });
      let stderr = ""; host.stderr.on("data", data => { stderr = (stderr + data).slice(-4000); });
      let writer, tree = [];
      try {
        const first = await new Promise((done, reject) => { createInterface({ input: host.stdout }).once("line", done); host.once("exit", code => reject(new Error(`orphan host exited (${code}): ${stderr}`))); });
        writer = JSON.parse(first).child; assert.ok(alive(writer), "RPC writer is running");
        await waitFor(() => shells().length > 0, "command started", 15_000);
        tree = shells().flatMap(pid => [pid, ...pids("-P", String(pid))]); assert.ok(tree.length >= 2, "the shell and the command it runs");
        const started = Date.now(); process.kill(host.pid, "SIGKILL");
        await waitFor(() => !alive(writer), "writer exited after the host was killed", 8000);
        await waitFor(() => tree.every(pid => !alive(pid)), "command stopped with its writer", 8000);
        assert.deepEqual(shells(), []);
        return { hostSignal: "SIGKILL", shutdownHook: !!hook, writerExited: true, commandProcessesBefore: tree.length, commandProcessesAfter: 0, withinMs: Date.now() - started };
      } finally {
        for (const pid of [host.pid, writer, ...tree, ...shells()]) if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
        await rm(home, { recursive: true, force: true, maxRetries: 3 });
      }
    });
    await check("E2E-REPEAT", "ten A/B project round trips and twenty lease reconnects keep one writer and one reply per prompt", async () => {
      const f = await start(); let client = f.client;
      const prompts = [];
      for (let round = 0; round < 10; round++) for (const [label, path] of [["B", f.target], ["A", f.original.cwd]]) {
        const selected = await realpath(path);
        await hostCommand(client, "project_open", { path: selected });
        await waitFor(async () => client.snapshot && await realpath(client.snapshot.session.cwd) === selected && lastHost(client)?.phase === "ready", `project ${label}`);
        const lease = client.clientId; await client.close();
        client = await openClient(f.fixture.url, lease); clients.push(client);
        await waitFor(async () => client.snapshot && await realpath(client.snapshot.session.cwd) === selected, "reconnected current project");
        assert.equal(client.clientId, lease);
        assert.equal((await f.children()).filter(child => alive(child.pid)).length, 1);
        const text = `M31_REPEAT_${round}_${label}`; prompts.push(text);
        assert.equal((await run(client, "prompt", { text, mode: "followUp" })).status, "completed");
        await client.settled(text);
        assert.equal(client.protocolErrors.length, 0);
      }
      return { roundTrips: 10, projectSwitches: 20, leaseReconnects: 20, exactlyOnceReplies: prompts.length,
        peakObservedWriters: 1, childrenStarted: (await f.children()).length };
    });
    await check("E2E-09-TARGET", "an ordinary TUI append after target lock reservation is refused before activation", async () => {
      const f = await start(); await f.control({ shutdownDelay: 1500 });
      const tui = await startFixture({ autoWeb: false, disablePane: true, seedSession: false, extraArgs: ["--session", f.saved.getSessionFile()] }); fixtures.push(tui);
      const switching = f.switchTarget();
      await waitFor(async () => await exists(`${f.saved.getSessionFile()}.pi-pane.lock`), "target lock reservation");
      await waitFor(async () => (await f.fixture.events()).some(event => event.event === "m31_resilience_shutdown_begin" && event.pid === f.original.pid), "old child shutdown");
      tui.tuiCommand("M31_ORDINARY_TUI_TARGET_APPEND"); await tui.waitEvent("provider_done", 0, event => event.input === "M31_ORDINARY_TUI_TARGET_APPEND");
      // provider_done comes before the TUI has written its reply. Compare against the file only once that
      // line is there and the file has stopped changing; otherwise the TUI's own reply looks like a host write.
      let changed;
      await waitFor(async () => { const text = await readFile(f.saved.getSessionFile(), "utf8"); const settled = text === changed && /M0_REPLY:M31_ORDINARY_TUI_TARGET_APPEND/.test(text); changed = text; return settled; }, "ordinary TUI finished writing its turn");
      assert.match(changed, /M31_ORDINARY_TUI_TARGET_APPEND/);
      const result = await switching; assert.equal(result.status, "failed"); assert.equal(result.error.code, "recovery_required");
      assert.equal(lastHost(f.client).recovery.reason, "start_failed"); assert.equal((await f.children()).length, 1, "target not activated");
      assert.equal(await readFile(f.saved.getSessionFile(), "utf8"), changed, "host did not overwrite the external change");
      await tui.close(); return { externalWriter: "ordinary pi TUI", targetActivated: false };
    });
    await check("E2E-09-RECOVERY", "external change to the old transcript while recovery is displayed prevents restore", async () => {
      const f = await start(); await f.control({ startCrash: true });
      assert.equal((await f.switchTarget()).error?.code, "recovery_required");
      const session = SessionManager.open(f.original.file); session.appendCustomEntry("external-recovery-note", { marker: "M31_EXTERNAL_RECOVERY" });
      const changed = await readFile(f.original.file, "utf8");
      await assert.rejects(hostCommand(f.client, "recover_restore"), { code: "recovery_required" });
      assert.equal(lastHost(f.client).phase, "recovery_required"); assert.equal((await f.children()).length, 2, "failed startup only; restore did not launch another writer");
      assert.equal(await readFile(f.original.file, "utf8"), changed); return { unchangedAfterRefusal: true };
    });
    await check("E2E-09-MESSAGE", "a message appended in the shutdown window prevents switching and safe restore", async () => {
      const f = await start(); await f.control({ shutdownDelay: 1200 });
      const switching = f.switchTarget();
      await waitFor(async () => (await f.fixture.events()).some(event => event.event === "m31_resilience_shutdown_begin" && event.pid === f.original.pid), "shutdown window");
      // A public SessionManager stands in for an external writer during the unowned window.
      SessionManager.open(f.original.file).appendMessage({ role: "user", content: "M31_UNOWNED_SHUTDOWN_MESSAGE", timestamp: Date.now() });
      assert.equal((await switching).error?.code, "recovery_required");
      assert.equal(lastHost(f.client).recovery.reason, "shutdown_conflict"); assert.equal(lastHost(f.client).recovery.canRestore, false);
      await assert.rejects(hostCommand(f.client, "recover_restore"), { code: "restore_unavailable" });
      assert.equal((await f.children()).length, 1); return { appender: "public SessionManager fault injection", targetActivated: false, restoreRefused: true };
    });
    await check("E2E-04-ACCOUNT", "saved credentials survive veto and a second page can explicitly apply them later", async () => {
      const f = await start(); await f.control({ vetoSwitch: true });
      await hostCommand(f.client, "account_begin", { provider: "openai", method: "api_key" });
      const login = await waitFor(() => operation(f.client)?.step && operation(f.client), "API key input");
      f.client.send({ t: "account_answer", operationId: login.id, stepId: login.step.id, value: key });
      await waitFor(() => operation(f.client)?.status === "saved", "key saved");
      await waitFor(async () => (await query(f.client, "accounts")).applyError, "veto is visible");
      assert.equal((JSON.parse(await readFile(join(f.fixture.agentDir, "auth.json"), "utf8"))).openai.key, key);
      const second = await openClient(f.fixture.url); clients.push(second); await waitFor(() => second.snapshot, "second page");
      const pending = await query(second, "accounts"); assert.equal(pending.pendingApply, true); assert.ok(pending.applyError);
      assert.equal(pending.operation?.step, undefined); assert.equal((await f.children()).length, 1);
      assert.equal((await run(second, "prompt", { text: "M31_VETO_STILL_USABLE", mode: "followUp" })).status, "completed");
      await waitFor(() => second.snapshot?.state.idle, "reply settled");
      await f.control({}); await hostCommand(second, "account_apply");
      const applied = await query(second, "accounts"); assert.equal(applied.pendingApply, false); assert.ok(applied.providers.find(item => item.id === "openai").models > 0);
      assert.equal((await f.children()).length, 1); assert.equal(second.snapshot.session.id, f.client.snapshot.session.id);
      assert.ok(!JSON.stringify([f.client.frames, second.frames, await f.fixture.events()]).includes(key));
      return { credentialSavedOnce: true, originalChildKept: true, otherPageRetried: true };
    });
    await check("E2E-10-ROOTS", "credential roots and aliases are refused for open/create/relocate; HOME still filters their contents", async () => {
      const f = await start();
      const relocated = join(f.root, "registered"); await mkdir(relocated); await hostCommand(f.client, "project_open", { path: relocated });
      await hostCommand(f.client, "project_open", { path: f.original.cwd });
      const refused = [join(f.root, ".ssh"), join(f.root, ".aws"), await realpath(f.fixture.agentDir), join(await realpath(f.fixture.agentDir), "sessions")];
      for (let index = 0; index < refused.length; index++) {
        const path = refused[index]; await mkdir(path, { recursive: true }); await writeFile(join(path, "boundary-marker.txt"), "M31_BOUNDARY_SECRET");
        const alias = join(f.root, `alias-${index}`); await symlink(path, alias);
        for (const candidate of [path, alias]) {
          await assert.rejects(hostCommand(f.client, "project_open", { path: candidate }), { code: "project_root_refused" });
          await assert.rejects(hostCommand(f.client, "project_create", { parent: candidate, name: "refused-child" }), { code: "project_root_refused" });
          await assert.rejects(hostCommand(f.client, "project_relocate", { from: relocated, to: candidate }), { code: "project_root_refused" });
          assert.equal(await exists(join(path, "refused-child")), false);
        }
      }
      await hostCommand(f.client, "project_open", { path: f.root });
      execFileSync("git", ["-c", "core.hooksPath=/dev/null", "init", "-b", "boundary-fixture"], {
        cwd: f.root, env: { PATH: process.env.PATH, HOME: f.root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdio: "ignore" });
      const listing = await workbenchQuery(f.client, "files", { query: "boundary-marker" });
      assert.ok(!JSON.stringify(listing).includes("boundary-marker"));
      const git = await workbenchQuery(f.client, "git_status"); assert.equal(git.isRepository, true);
      assert.ok(!JSON.stringify(git).includes("boundary-marker"));
      for (const path of [".ssh/boundary-marker.txt", ".aws/boundary-marker.txt", "agent/boundary-marker.txt", "agent/sessions/boundary-marker.txt", "alias-0/boundary-marker.txt"]) {
        const result = await workbenchQuery(f.client, "file", { path }).then(value => ({ value }), error => ({ error: String(error) }));
        assert.ok(result.error || !JSON.stringify(result.value).includes("M31_BOUNDARY_SECRET"), `filtered ${path}`);
        await assert.rejects(workbenchQuery(f.client, "git_diff", { path }), /excluded|workspace/i);
      }
      browser = await chromium.launch({ channel: "chrome", headless: true });
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await page.goto(f.fixture.url); await page.getByText("已连接", { exact: true }).waitFor();
      await page.getByLabel("添加项目", { exact: true }).click(); await page.getByRole("button", { name: "打开项目", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "打开项目", exact: true });
      await dialog.getByRole("textbox", { name: "文件夹的绝对路径" }).fill(refused[0]);
      await dialog.getByRole("button", { name: "前往", exact: true }).click();
      await dialog.getByRole("alert").filter({ hasText: "不能从网页打开为项目" }).waitFor();
      assert.equal(await dialog.getByRole("button", { name: "打开此文件夹", exact: true }).isDisabled(), true);
      await page.screenshot({ path: join(out, "credential-directory-refused.png") });
      await browser.close(); browser = undefined;
      return { blockedRootsAndAliases: refused.length * 2, operationsPerRoot: 3, homeOpened: true, contentFiltered: true, gitFiltered: true, browserRefusalShown: true };
    });
  }
  report.status = "passed";
} catch (error) { report.status = "failed"; report.error = redact(error.stack ?? error); process.exitCode = 1; console.error(report.error); }
finally {
  await browser?.close();
  for (const client of clients) await client.close().catch(() => {});
  for (const [index, fixture] of fixtures.entries()) {
    const events = await fixture.events().catch(() => []);
    if (report.status === "failed") await writeFile(join(out, `${index}.terminal.log`), redact(fixture.terminal));
    await fixture.close().catch(() => {});
    const remaining = [...new Set(events.filter(event => event.event === "m31_resilience_start" && event.mode === "rpc").map(event => event.pid))].filter(alive);
    for (const pid of remaining) { try { process.kill(pid, "SIGKILL"); } catch {} await waitFor(() => !alive(pid), "owned orphan fixture cleanup", 5000).catch(() => {}); }
    await fixture.remove(); report.cleanup.push({ root: fixture.directory, removed: !await exists(fixture.directory), forcedFixturePids: remaining });
  }
  report.finishedAt = new Date().toISOString(); await writeFile(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.status.toUpperCase()} ${report.checks.filter(item => item.status === "passed").length}/${report.checks.length}; ${join(out, "report.json")}`);
}
