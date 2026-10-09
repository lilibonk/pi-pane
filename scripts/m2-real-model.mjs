#!/usr/bin/env node
/** Opt-in real-model trial with explicit task-owned authentication and a temporary HOME. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { openClient, readPiHost, textOf } from "./m0-smoke.mjs";

const model = process.env.PI_PANE_REAL_MODEL?.trim();
const selectedAgentDir = process.env.PI_PANE_REAL_AGENT_DIR?.trim();
const authorizedAuthLinkTarget = process.env.PI_PANE_REAL_AUTH_SYMLINK_TARGET?.trim();
if (!model || !selectedAgentDir) {
  console.error("Real model trial is disabled. Set PI_PANE_REAL_MODEL and PI_PANE_REAL_AGENT_DIR to an explicitly authenticated task-owned agent directory under the OS temporary directory. Existing credentials require an explicitly authorized auth.json link and PI_PANE_REAL_AUTH_SYMLINK_TARGET; no credentials are read or copied by this harness.");
  process.exit(2);
}
if (process.platform === "win32") throw new Error("This real-TUI trial requires a POSIX PTY (macOS or Linux).");
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = resolve(process.env.PI_M2_REPORT_DIR || join(project, "build-artifacts/m3/handoff/m2/real-model"));
const TURN_TIMEOUT_MS = 180_000;
const TOTAL_TIMEOUT_MS = 600_000;
const pause = ms => new Promise(done => setTimeout(done, ms));
const stripAnsi = value => value.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
// Do not inspect credential files or environment values to build the redaction list.
const redact = value => stripAnsi(String(value))
  .replace(/https?:\/\/[^\s\u0000-\u001f<>"']+/g, "[URL REDACTED]")
  .replace(/pi-pane\.bearer\.[A-Za-z0-9_-]+/g, "pi-pane.bearer.[REDACTED]")
  .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, "[CREDENTIAL REDACTED]")
  .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
  .replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|password|secret)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, "$1[REDACTED]");
const nonce = randomBytes(6).toString("hex");
const tuiReply = `PI_PANE_REAL_TUI_${nonce}`;
const webReply = `PI_PANE_REAL_WEB_${nonce}`;
const toolStart = `PI_PANE_REAL_TOOL_START_${nonce}`;
const toolDone = `PI_PANE_REAL_TOOL_DONE_${nonce}`;
const toolReply = `PI_PANE_REAL_TOOL_OK_${nonce}`;
// Expected replies are split in the input, so a terminal echo of the prompt cannot satisfy the reply check.
const tuiPrompt = `Do not use tools. Reply with only the concatenation of "PI_PANE_REAL_TUI_" and "${nonce}".`;
const webPrompt = `Do not use tools. Reply with only the concatenation of "PI_PANE_REAL_WEB_" and "${nonce}".`;
const bashCommand = `printf '%s\\n' '${toolStart}'; printf '%s\\n' '${nonce}' >> pi-pane-tool-runs.txt; sleep 6; printf '%s\\n' '${toolDone}'`;
const toolPrompt = `In the current temporary directory, run the builtin bash tool exactly once with this exact command: ${bashCommand}. Do not run any other tools. After it succeeds, reply with only the concatenation of "PI_PANE_REAL_TOOL_OK_" and "${nonce}".`;
const prompts = [tuiPrompt, webPrompt, toolPrompt];
const report = {
  startedAt: new Date().toISOString(), realTui: true, realModel: true, submittedPrompts: 0,
  scope: "pi 1.1.0, source pi-pane, saved TUI history → foreground /web RPC, builtin bash, refresh/reconnect",
  isolation: "Temporary HOME, cwd and session directory; explicitly selected task-owned temporary agent; no daily settings/models or pi installation; harness does not read or copy credential content",
  authenticationMode: authorizedAuthLinkTarget ? "user-authorized-existing-auth-via-symlink" : "explicit-task-owned-authentication",
  limits: { turnTimeoutMs: TURN_TIMEOUT_MS, totalTimeoutMs: TOTAL_TIMEOUT_MS },
  checks: [], status: "running",
  notCovered: ["Daily-use stability beyond this trial", "External HTTPS access and mobile devices", "Exact provider request count, billing or retries"],
};
let directory, fixture, observer, fresh, browser, page;
const pageErrors = [];
const cancellation = new AbortController();
let cancelled = false;
const cancel = reason => {
  if (cancelled) return;
  cancelled = true;
  cancellation.abort(new Error(reason));
  fixture?.terminate();
  observer?.socket.terminate();
  fresh?.socket.terminate();
  void browser?.close().catch(() => {});
};
const onInterrupt = () => cancel("Real-model trial interrupted; child pi was terminated.");
process.once("SIGINT", onInterrupt);
process.once("SIGTERM", onInterrupt);
const deadline = setTimeout(() => cancel("Real-model trial reached its hard 10-minute limit."), TOTAL_TIMEOUT_MS);

const check = async (name, action) => {
  const started = Date.now();
  try {
    ensureLive();
    const details = await action();
    ensureLive();
    report.checks.push({ name, status: "passed", durationMs: Date.now() - started, ...(details ? { details } : {}) });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.checks.push({ name, status: "failed", durationMs: Date.now() - started, error: redact(error?.message || error) });
    throw error;
  }
};
const ensureLive = () => {
  if (cancelled) throw cancellation.signal.reason;
  if (fixture?.exitCode !== undefined) throw new Error(`pi exited before the trial completed (exit ${fixture.exitCode}).`);
};
// Interrupt the model wait immediately, while keeping the trial tracked until cleanup can own every resource.
const waitFor = async (predicate, label, timeout = 15_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    ensureLive();
    const result = await predicate();
    ensureLive();
    if (result) return result;
    try { await sleep(20, undefined, { signal: cancellation.signal }); }
    catch (error) { ensureLive(); throw error; }
  }
  throw new Error(`Timed out: ${label}`);
};
const users = (client, prompt) => client.snapshot?.session.messages.filter(message => message.role === "user" && textOf(message) === prompt) ?? [];
const assistantHas = (client, marker) => client.snapshot?.session.messages.some(message => message.role === "assistant" && message.status === "complete" && textOf(message).includes(marker));
const throwTurnFailure = prompt => {
  const messages = observer.snapshot?.session.messages ?? [];
  const index = messages.findIndex(message => message.role === "user" && textOf(message) === prompt);
  if (index === -1) return;
  const failed = messages.slice(index + 1).find(message => message.status === "complete" && message.isError);
  if (failed) throw new Error(`Real model/tool failed: ${redact(textOf(failed)).slice(0, 500) || "completed error message"}`);
};
const settled = async (prompt, marker) => {
  await waitFor(() => {
    ensureLive();
    throwTurnFailure(prompt);
    return observer.snapshot?.state.idle && users(observer, prompt).length === 1 && assistantHas(observer, marker);
  }, `real model completes ${marker}`, TURN_TIMEOUT_MS);
  await page.locator(".message-assistant .message-text").filter({ hasText: marker }).waitFor({ timeout: 30_000 });
};
const connected = () => page.getByText("已连接", { exact: true }).waitFor({ timeout: 30_000 });
const browserUserCount = prompt => page.locator(".message-user .message-text").evaluateAll((elements, wanted) => elements.filter(element => element.textContent === wanted).length, prompt);
const sendWeb = async prompt => {
  await page.getByRole("textbox", { name: "消息" }).fill(prompt);
  ensureLive();
  await page.getByRole("button", { name: /^(发送 ↗|请求 followUp ↗)$/ }).click();
  report.submittedPrompts++;
  await waitFor(() => { ensureLive(); return users(observer, prompt).length === 1; }, "web prompt reaches pi", 30_000);
};

async function startPi(host) {
  directory = await mkdtemp(join(tmpdir(), "pi-pane-real-model-"));
  ensureLive();
  const cwd = join(directory, "workspace");
  const sessionDir = join(directory, "sessions");
  await mkdir(cwd); await mkdir(sessionDir);
  ensureLive();
  const actualCwd = await realpath(cwd);
  ensureLive();
  const listener = createServer();
  let port;
  try {
    await new Promise((done, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", done); });
    ensureLive();
    port = listener.address().port;
  } finally { await new Promise(done => listener.close(done)); }
  ensureLive();
  const agentDir = await realpath(resolve(selectedAgentDir));
  const temporaryRoot = await realpath(tmpdir());
  assert.ok(agentDir.startsWith(temporaryRoot + "/"), "real-model agent directory must be task-owned under the OS temporary directory");
  // This opt-in permits an explicitly authorized link for a single manual trial.
  // Check link metadata only: neither read nor copy the credential file here.
  const authPath = join(agentDir, "auth.json");
  const authMetadata = await lstat(authPath);
  if (authMetadata.isSymbolicLink()) {
    assert.ok(authorizedAuthLinkTarget && resolve(authorizedAuthLinkTarget) === authorizedAuthLinkTarget,
      "an auth.json symlink requires an explicit absolute PI_PANE_REAL_AUTH_SYMLINK_TARGET authorization");
    assert.equal(resolve(agentDir, await readlink(authPath)), resolve(authorizedAuthLinkTarget), "test auth link matches the explicitly authorized file");
  } else {
    assert.ok(!authorizedAuthLinkTarget, "existing auth authorization requires a symbolic link instead of a copied credential file");
    assert.ok(authMetadata.isFile(), "task-owned auth.json must be a file or an explicitly authorized symbolic link");
  }
  const systemPrompt = `You are performing a synthetic pi-pane acceptance test. Follow each test prompt exactly and keep replies short. Only use the allowed builtin tools when explicitly asked. All shell commands, reads and writes must stay inside the temporary working directory ${actualCwd}. Never inspect credentials, environment variables, home directories, authentication files or other projects. Do not use network tools or invoke other agents.`;
  const argv = [process.execPath, host.cli, "--offline", "--verbose", "--no-extensions", "-e", resolve(process.env.PI_M0_EXTENSION || join(project, "dist/extension/index.js")), "--web-port", String(port), "--web-no-open", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-mcp",
    "--tools", "read,bash,write,edit", "--session-dir", sessionDir, "--system-prompt", systemPrompt,
    "--model", model, ...(process.env.PI_PANE_REAL_PROVIDER?.trim() ? ["--provider", process.env.PI_PANE_REAL_PROVIDER.trim()] : [])];
  // pi reads only the explicitly prepared test authentication directory. The script never
  // reads credential content or inherits model keys, npm credentials or the daily HOME.
  const env = Object.fromEntries(["PATH", "TMPDIR", "LANG", "LC_ALL"].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, { HOME: directory, TERM: "xterm-256color", COLORTERM: "truecolor", NO_COLOR: "1", PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: sessionDir });
  const proc = spawn("python3", [join(project, "scripts/pty-host.py")], { stdio: ["pipe", "pipe", "pipe"] });
  const state = { proc, cwd: actualCwd, port, terminal: "", stderr: "", pid: undefined, exitCode: undefined, url: undefined,
    command(text) { ensureLive(); proc.stdin.write(`${JSON.stringify({ type: "write", data: `${text}\r` })}\n`); },
    terminate() {
      if (state.pid) { try { process.kill(-state.pid, "SIGTERM"); } catch { /* Already exited. */ } }
      if (proc.exitCode === null && !proc.stdin.destroyed) proc.stdin.write(`${JSON.stringify({ type: "terminate" })}\n`);
    },
    async close() {
      state.terminate();
      if (proc.exitCode === null) await Promise.race([new Promise(done => proc.once("exit", done)), pause(5_000)]);
      if (state.pid) { try { process.kill(-state.pid, "SIGKILL"); } catch { /* Already exited. */ } }
      if (proc.exitCode === null) proc.kill("SIGKILL");
    },
  };
  proc.stdin.on("error", error => { if (error.code !== "EPIPE") cancel("PTY input failed."); });
  proc.on("error", error => { state.stderr += error.message; state.exitCode = -1; });
  proc.on("exit", code => { state.exitCode = code ?? -1; });
  proc.stderr.on("data", bytes => { state.stderr = (state.stderr + bytes).slice(-64_000); });
  createInterface({ input: proc.stdout }).on("line", line => {
    let item;
    try { item = JSON.parse(line); } catch { cancel("PTY emitted malformed control output."); return; }
    if (item.type === "started") state.pid = item.pid;
    if (item.type === "exit") state.exitCode = item.code;
    if (item.type !== "output") return;
    state.terminal = (state.terminal + item.data).slice(-2_000_000);
    const urls = [...stripAnsi(state.terminal).matchAll(/http:\/\/127\.0\.0\.1:\d+\/#t=[A-Za-z0-9_-]+/g)];
    if (urls.length) state.url = urls.at(-1)[0];
    if (item.data.includes("\u001b[6n") && !proc.stdin.destroyed) proc.stdin.write(`${JSON.stringify({ type: "write", data: "\u001b[1;1R" })}\n`);
  });
  proc.stdin.write(`${JSON.stringify({ argv, env, cwd: actualCwd, controllingTty: true })}\n`);
  return state;
}

async function trial() {
  const host = await readPiHost();
  ensureLive();
  assert.equal(host.version, "1.1.0", "Select pi 1.1.0 with PI_M0_CLI (or install it in the project).");
  report.piVersion = host.version;
  fixture = await startPi(host);
  ensureLive();
  await check("/web hands off a saved real-model TUI session to the source RPC host", async () => {
    // pi renders its footer before startup finishes. With --verbose, [Extensions] is rendered
    // only after input handlers are installed and session extensions have finished binding.
    await waitFor(() => {
      ensureLive();
      const terminal = stripAnsi(fixture.terminal);
      return terminal.includes(fixture.cwd) && terminal.includes("[Extensions]");
    }, "interactive TUI and installed extensions ready", 45_000);
    fixture.command(tuiPrompt); report.submittedPrompts++;
    await waitFor(() => { ensureLive(); return stripAnsi(fixture.terminal).includes(tuiReply); }, "real model finishes the TUI seed", TURN_TIMEOUT_MS);
    await pause(300);
    fixture.command(`/web --no-open --port ${fixture.port}`);
    await waitFor(() => { ensureLive(); return fixture.url; }, "TUI /web link", 30_000);
    observer = await openClient(fixture.url);
    ensureLive();
    assert.equal(users(observer, tuiPrompt).length, 1, "RPC host retains the handed-off TUI seed exactly once");
    report.selectedModel = { provider: observer.snapshot.state.model?.provider, id: observer.snapshot.state.model?.id };
    browser = await chromium.launch({ channel: "chrome", headless: true });
    // A cancelled launch can still return a browser; retain it before throwing so finally closes it.
    ensureLive();
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    ensureLive();
    page.setDefaultTimeout(30_000);
    page.on("pageerror", error => pageErrors.push(redact(error.message)));
    await page.goto(fixture.url);
    await connected();
    assert.equal(new URL(page.url()).hash, "", "bootstrap token is removed from the address bar");
    return { preservedTuiHistory: true, sourceExtension: true };
  });
  await check("terminal prompt and real model reply appear in the browser", async () => {
    await settled(tuiPrompt, tuiReply);
    assert.equal(await browserUserCount(tuiPrompt), 1);
    assert.ok(stripAnsi(fixture.terminal).includes(tuiReply), "terminal rendered the reply, not merely the split-marker input");
    return { userMessages: 1, expectedReply: tuiReply };
  });
  await check("browser prompt and real model reply persist in the sole RPC session", async () => {
    await sendWeb(webPrompt);
    await settled(webPrompt, webReply);
    assert.ok(assistantHas(observer, webReply));
    assert.equal(fixture.exitCode, undefined, "foreground host stays alive");
    assert.equal(await browserUserCount(webPrompt), 1);
    return { userMessages: 1, expectedReply: webReply };
  });
  let toolId;
  await check("builtin bash runs once and browser refresh reconnects during its execution", async () => {
    await sendWeb(toolPrompt);
    const tool = await waitFor(() => {
      ensureLive();
      throwTurnFailure(toolPrompt);
      return observer.snapshot?.state.tools.find(item => item.name === "bash" && item.status === "running" && item.args?.command === bashCommand && item.output?.includes(toolStart));
    }, "builtin bash partial output", TURN_TIMEOUT_MS);
    toolId = tool.id;
    await page.locator(".tool-running pre").filter({ hasText: toolStart }).waitFor();
    const lease = await page.evaluate(() => sessionStorage.getItem("pi-pane.clientId"));
    assert.equal(observer.snapshot.state.tools.find(item => item.id === toolId)?.status, "running", "refresh begins while the tool is running");
    await page.reload();
    await connected();
    assert.equal(await page.evaluate(() => sessionStorage.getItem("pi-pane.clientId")), lease, "refresh retains its client lease");
    assert.equal(new URL(page.url()).hash, "");
    await settled(toolPrompt, toolReply);
    const result = observer.snapshot.state.tools.find(item => item.id === toolId);
    assert.equal(result?.status, "complete");
    assert.ok(result.output?.includes(toolDone), "real tool final output survives refresh");
    // Completed bash cards collapse by default. Check their retained output, then open the card
    // through its real summary before requiring visible text.
    const completedCard = page.locator("details.tool-complete").filter({
      has: page.locator("pre.tool-output").filter({ hasText: toolDone }),
    });
    await completedCard.waitFor({ state: "attached" });
    assert.ok((await completedCard.locator("pre.tool-output").textContent()).includes(toolDone));
    if (!await completedCard.evaluate(element => element.open)) await completedCard.locator(":scope > summary").click();
    await completedCard.locator("pre.tool-output").waitFor({ state: "visible" });
    // Count the whole empty-session trial, so extra tools cannot hide behind a different command or nonce.
    const starts = observer.frames.filter(frame => frame.t === "event" && frame.ev.type === "tool_start");
    assert.equal(starts.length, 1, "only one real tool execution started in the trial");
    assert.equal(starts[0].ev.tool.id, toolId);
    assert.equal(starts[0].ev.tool.name, "bash");
    assert.equal(starts[0].ev.tool.args?.command, bashCommand);
    const runs = (await readFile(join(fixture.cwd, "pi-pane-tool-runs.txt"), "utf8")).trim().split("\n");
    assert.deepEqual(runs, [nonce], "temporary execution counter confirms no duplicated command");
    assert.equal(await browserUserCount(toolPrompt), 1);
    return { refreshDuringRunningTool: true, retainedLease: true, executions: runs.length, expectedOutput: toolDone };
  });
  await check("fresh canonical snapshot matches the live reducer and contains no duplicated inputs or tools", async () => {
    fresh = await openClient(fixture.url);
    ensureLive();
    await waitFor(() => observer.snapshot?.seq === fresh.snapshot?.seq, "live and fresh snapshot reach the same sequence", 15_000);
    assert.equal(observer.snapshot.epoch, fresh.snapshot.epoch);
    assert.equal(observer.snapshot.session.id, fresh.snapshot.session.id);
    assert.deepEqual(observer.snapshot.session.messages, fresh.snapshot.session.messages);
    assert.deepEqual(observer.snapshot.state.tools, fresh.snapshot.state.tools);
    assert.equal(fresh.snapshot.state.idle, true);
    for (const prompt of prompts) { assert.equal(users(fresh, prompt).length, 1); assert.equal(await browserUserCount(prompt), 1); }
    assert.equal(fresh.snapshot.session.messages.filter(message => message.role === "toolResult" && message.toolCallId === toolId).length, 1);
    const calls = fresh.snapshot.session.messages.flatMap(message => message.content).filter(part => part.type === "toolCall");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, toolId);
    assert.equal(calls[0].name, "bash");
    assert.equal(calls[0].arguments?.command, bashCommand);
    assert.deepEqual(observer.protocolErrors, []);
    assert.deepEqual(fresh.protocolErrors, []);
    assert.deepEqual(pageErrors, []);
    await page.screenshot({ path: join(outputDir, "browser.png"), fullPage: true });
    report.browserScreenshot = "browser.png";
    return { submittedPrompts: prompts.length, matchingSnapshots: true, bashCalls: calls.length, protocolErrors: 0, pageErrors: 0 };
  });
  report.status = "passed";
}

try {
  await mkdir(outputDir, { recursive: true });
  // Await the trial itself: racing only the outer promise lets late resources outlive finally.
  await trial();
} catch (error) {
  report.status = "failed";
  report.error = redact(error?.message || error);
  console.error(report.error);
} finally {
  clearTimeout(deadline);
  process.removeListener("SIGINT", onInterrupt);
  process.removeListener("SIGTERM", onInterrupt);
  for (const client of [fresh, observer]) if (client) await client.close().catch(() => client.socket.terminate());
  await browser?.close().catch(() => {});
  if (fixture) {
    await fixture.close();
    await writeFile(join(outputDir, "terminal.redacted.log"), redact(fixture.terminal + fixture.stderr), { mode: 0o600 });
  }
  if (directory) await rm(directory, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  report.pageErrors = pageErrors.length;
  await writeFile(join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}
console.log(`Report: ${join(outputDir, "report.json")}`);
process.exitCode = report.status === "passed" ? 0 : 1;
