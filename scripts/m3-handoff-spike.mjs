#!/usr/bin/env node
// M3 handoff spike: Kimi-style `/web` in a real pi TUI (PTY) and system Chrome.
// The TUI shuts down; the same process stays in the foreground serving the web UI while a pi RPC
// child owns the session. Checks: continuity, prompts, extension dialogs, session list/switch,
// Ctrl+C return with a valid single-writer session file, no orphan after SIGHUP or a crash, and
// external access (TLS proxy + password) carried across the handoff.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startFixture, waitFor } from "./m0-smoke.mjs";
import { RpcChild, runningPiRpcEntry } from "../dist/extension/rpc-child.js";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportDir = resolve(process.env.PI_M3_REPORT_DIR ?? join(project, "build-artifacts/m3-spike"));
await mkdir(reportDir, { recursive: true });
const FIXTURE = join(project, "tests/fixtures/handoff-fixture.ts");
const stripAnsi = value => value.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
const redact = value => String(value).replace(/#t=[A-Za-z0-9_-]+/g, "#t=[REDACTED]");
const terminal = fixture => stripAnsi(fixture.terminal).replace(/\s+/g, " ");
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const report = { scope: "M3 spike: Kimi-style /web handoff to a pi RPC child", realTui: true, realModelCalls: 0, checks: [], status: "running" };
const check = async (name, action) => {
  const started = Date.now();
  try {
    const details = await action();
    report.checks.push({ name, status: "passed", durationMs: Date.now() - started, ...(details ? { details } : {}) });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.checks.push({ name, status: "failed", durationMs: Date.now() - started, error: redact(error?.stack ?? error) });
    console.log(`FAIL ${name}: ${redact(error)}`);
    throw error;
  }
};
const events = async (fixture, name) => (await fixture.events()).filter(event => event.event === name);
const sendTui = async (fixture, text) => {
  const before = (await events(fixture, "provider_call")).length;
  fixture.command(text);
  await waitFor(async () => (await events(fixture, "provider_done")).some(event => event.input === text), `TUI reply ${text}`);
  return before;
};
/** Hands the session to the browser and returns the TUI and RPC child process IDs. */
async function handoff(fixture) {
  const [tui] = (await events(fixture, "m3_session")).filter(event => event.mode === "tui").slice(-1);
  fixture.command("/web handoff");
  await waitFor(() => terminal(fixture).includes("this session now runs in the browser"), "handoff banner", 30_000);
  const child = await waitFor(async () => (await events(fixture, "m3_session")).find(event => event.mode === "rpc"), "RPC child session_start");
  return { tuiPid: tui.pid, childPid: child.pid, child };
}

const PASSWORD = "m3-fixture-password-not-a-secret";
const PUBLIC_HOST = "pane.example.test";
const freePort = () => new Promise(done => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => done(port)); }); });
const listening = port => new Promise(done => { const socket = connect(port, "127.0.0.1"); socket.once("connect", () => { socket.destroy(); done(true); }); socket.once("error", () => done(false)); });
/** A same-machine TLS reverse proxy forwarding HTTP and WebSocket upgrades unchanged (stand-in for e.g. Tailscale Serve). */
async function tlsProxy({ cert, key, port, upstream }) {
  const sockets = new Set();
  const server = createHttpsServer({ cert, key }, (request, response) => {
    const forward = httpRequest({ host: "127.0.0.1", port: upstream, method: request.method, path: request.url, headers: request.headers }, (reply) => {
      response.writeHead(reply.statusCode ?? 502, reply.headers); reply.pipe(response);
    });
    forward.on("error", () => { response.writeHead(502); response.end(); });
    request.pipe(forward);
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.on("upgrade", (request, socket, head) => {
    const backend = connect(upstream, "127.0.0.1", () => {
      let raw = `${request.method} ${request.url} HTTP/1.1\r\n`;
      for (let i = 0; i < request.rawHeaders.length; i += 2) raw += `${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}\r\n`;
      backend.write(`${raw}\r\n`); backend.write(head);
      backend.pipe(socket); socket.pipe(backend);
    });
    sockets.add(backend); backend.on("close", () => sockets.delete(backend));
    backend.on("error", () => socket.destroy()); socket.on("error", () => backend.destroy());
  });
  await new Promise(done => server.listen(port, "127.0.0.1", done));
  return { close() { for (const socket of sockets) socket.destroy(); return new Promise(done => server.close(() => done())); } };
}

let fixture, browser, externalBrowser, proxy, certDir;
const extra = [];
try {
  fixture = await startFixture({ extraExtensions: [FIXTURE], controllingTty: true });
  await sendTui(fixture, "M3_FIRST");
  fixture.command("/new");
  await waitFor(async () => (await events(fixture, "m3_session")).filter(event => event.mode === "tui").length >= 2, "second TUI session");
  await sendTui(fixture, "M3_SECOND");
  const [first, second] = (await events(fixture, "m3_session")).filter(event => event.mode === "tui");
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 860 } });
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(String(error)));
  await page.goto(fixture.url);
  await page.getByText("已连接", { exact: true }).waitFor();
  await page.locator(".message-user").filter({ hasText: "M3_SECOND" }).waitFor();
  let pids;

  await check("/web handoff: the TUI shuts down, the process stays, and the browser keeps the same session and URL", async () => {
    pids = await handoff(fixture);
    assert.equal(fixture.exitCode, undefined, "the pi process is still running");
    assert.equal(pids.tuiPid, (await events(fixture, "m3_shutdown")).find(event => event.reason === "quit")?.pid, "the TUI's session shut down normally");
    assert.notEqual(pids.childPid, pids.tuiPid, "an RPC child owns the session");
    assert.equal(pids.child.sessionId, second.sessionId, "the child opened the handed-off session");
    await page.getByText("已连接", { exact: true }).waitFor();
    await page.locator(".message-user").filter({ hasText: "M3_SECOND" }).waitFor();
    await page.locator(".sessions-button").waitFor();
    return { tuiPid: pids.tuiPid, childPid: pids.childPid };
  });

  await check("prompts from the browser run in the RPC child and stream back", async () => {
    await page.getByRole("textbox", { name: "消息" }).fill("M3_HOST");
    await page.getByRole("button", { name: /^(发送 ↗|请求 followUp ↗)$/ }).click();
    await waitFor(async () => (await events(fixture, "provider_done")).some(event => event.input === "M3_HOST"), "provider ran M3_HOST");
    await page.locator(".message-assistant").filter({ hasText: "M0_REPLY:M3_HOST:complete" }).waitFor();
    // The live message became the persisted one: no duplicate bubbles.
    await page.waitForTimeout(500);
    assert.equal(await page.locator(".message-user").filter({ hasText: "M3_HOST" }).count(), 1);
    assert.equal(await page.locator(".message-assistant").filter({ hasText: "M0_REPLY:M3_HOST:complete" }).count(), 1);
  });

  await check("an extension dialog opens in the browser and the answer reaches the extension", async () => {
    await page.getByRole("textbox", { name: "消息" }).fill("/m3-confirm");
    await page.getByRole("button", { name: /^(发送 ↗|请求 followUp ↗)$/ }).click();
    const dialog = page.getByRole("dialog", { name: "M3 dialog" });
    await dialog.waitFor();
    assert.match(await dialog.textContent(), /Allow the fixture action\?/);
    await dialog.getByRole("button", { name: "确认" }).click();
    const result = await waitFor(async () => (await events(fixture, "m3_dialog"))[0], "dialog result");
    assert.equal(result.confirmed, true); assert.equal(result.mode, "rpc"); assert.equal(result.pid, pids.childPid);
    await waitFor(async () => await dialog.count() === 0, "the dialog closes");
  });

  await check("the browser lists sessions from all projects and opens an earlier one", async () => {
    await page.locator(".sessions-button").click();
    const row = page.locator(`[data-session-id="${first.sessionId}"]`);
    await row.waitFor({ timeout: 8000 }).catch(async (error) => { report.panel = await page.locator(".sessions-panel").textContent().catch(() => null); report.notice = await page.locator(".notice").textContent().catch(() => null); throw error; });
    assert.ok(await page.locator(`[data-session-id="${second.sessionId}"]`).filter({ hasText: "当前" }).count());
    await row.getByRole("button", { name: "打开" }).click();
    await page.locator(".message-user").filter({ hasText: "M3_FIRST" }).waitFor();
    assert.equal(await page.locator(".message-user").filter({ hasText: "M3_SECOND" }).count(), 0, "the view switched sessions");
    await page.getByRole("textbox", { name: "消息" }).fill("M3_IN_FIRST");
    await page.getByRole("button", { name: /^(发送 ↗|请求 followUp ↗)$/ }).click();
    await page.locator(".message-assistant").filter({ hasText: "M0_REPLY:M3_IN_FIRST:complete" }).waitFor();
    await page.screenshot({ path: join(reportDir, "handoff-browser.png") });
  });

  await check("Ctrl+C stops the web service, prints the resume command and leaves one consistent writer's file", async () => {
    fixture.write("\u0003");
    await waitFor(() => fixture.exitCode !== undefined, "pi process exits", 15_000);
    assert.equal(fixture.exitCode, 0);
    assert.ok(!alive(pids.childPid), "the RPC child has exited");
    const text = terminal(fixture);
    assert.ok(text.includes(`To resume this session: pi --session ${first.sessionFile}`), "resume hint names the session the browser ended on");
    for (const [session, wanted] of [[first, ["M3_FIRST", "M3_IN_FIRST"]], [second, ["M3_SECOND", "M3_HOST"]]]) {
      const entries = (await readFile(session.sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line)).filter(entry => entry.type !== "session");
      const byId = new Map(entries.map(entry => [entry.id, entry]));
      for (const entry of entries) assert.ok(entry.parentId === null || byId.has(entry.parentId), `entry ${entry.id} has a known parent`);
      // The last entry is the leaf; its chain must contain every user prompt in order (no fork from a stale writer).
      const chain = [];
      for (let entry = entries.at(-1); entry; entry = byId.get(entry.parentId)) chain.unshift(entry);
      const users = chain.filter(entry => entry.type === "message" && entry.message.role === "user")
        .map(entry => typeof entry.message.content === "string" ? entry.message.content : entry.message.content.map(part => part.text ?? "").join(""));
      assert.deepEqual(users.filter(text => wanted.includes(text)), wanted, `${session.sessionId} branch holds ${wanted}`);
    }
    // pi itself resumes the file with the browser's messages.
    const rpc = new RpcChild(["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-builtin-tools", "--session", first.sessionFile],
      fixture.cwd, runningPiRpcEntry(fixture.cli));
    const env = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = fixture.agentDir;
    rpc.start();
    try {
      const messages = await rpc.request("get_messages");
      const texts = messages.messages.map(message => typeof message.content === "string" ? message.content : (message.content ?? []).map(part => part.text ?? "").join(""));
      assert.ok(texts.includes("M3_IN_FIRST") && texts.includes("M0_REPLY:M3_IN_FIRST:complete"), "pi --session sees the browser's turn");
    } finally { await rpc.stop(); if (env === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = env; }
  });

  await check("closing the terminal (SIGHUP) stops the host and its child", async () => {
    const other = await startFixture({ extraExtensions: [FIXTURE], controllingTty: true });
    extra.push(other);
    const handed = await handoff(other);
    // Closing the terminal: the PTY master goes away and the kernel sends SIGHUP to the session.
    other.proc.kill("SIGKILL");
    await waitFor(() => !alive(handed.tuiPid) && !alive(handed.childPid), "host and child exit after SIGHUP", 15_000);
    return handed;
  });

  await check("a crashed host (SIGKILL) cannot leave the child running as a second writer", async () => {
    const other = await startFixture({ extraExtensions: [FIXTURE], controllingTty: true });
    extra.push(other);
    const handed = await handoff(other);
    process.kill(handed.tuiPid, "SIGKILL");
    await waitFor(() => !alive(handed.childPid), "child exits when the host's pipe closes", 15_000);
    return handed;
  });

  await check("external access: a password login survives the handoff, the banner shows the QR code and new viewers still need the password", async () => {
    certDir = await mkdtemp(join(tmpdir(), "pi-pane-m3-tls-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", `/CN=${PUBLIC_HOST}`,
      "-addext", `subjectAltName=DNS:${PUBLIC_HOST}`, "-keyout", join(certDir, "key.pem"), "-out", join(certDir, "cert.pem")], { stdio: "ignore" });
    const other = await startFixture({ extraExtensions: [FIXTURE], controllingTty: true, autoWeb: false, envOverrides: { PI_PANE_PASSWORD: PASSWORD } });
    extra.push(other);
    await sendTui(other, "M3_EXTERNAL");
    const backend = await freePort();
    const proxyPort = await freePort();
    const origin = `https://${PUBLIC_HOST}:${proxyPort}`;
    other.command(`/web --public-origin ${origin} --proxy --port ${backend} --no-open`);
    await waitFor(() => other.publicUrl?.startsWith(origin), "public link in terminal");
    proxy = await tlsProxy({ cert: await readFile(join(certDir, "cert.pem")), key: await readFile(join(certDir, "key.pem")), port: proxyPort, upstream: backend });
    externalBrowser = await chromium.launch({ channel: "chrome", headless: true, args: [`--host-resolver-rules=MAP ${PUBLIC_HOST} 127.0.0.1`] });
    const remote = await (await externalBrowser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1200, height: 860 } })).newPage();
    remote.on("pageerror", error => pageErrors.push(String(error)));
    await remote.goto(other.publicUrl);
    await remote.getByRole("textbox", { name: "访问密码" }).fill(PASSWORD);
    await remote.getByRole("button", { name: "登录" }).click();
    await remote.getByText("已连接", { exact: true }).waitFor();
    await remote.locator(".message-user").filter({ hasText: "M3_EXTERNAL" }).waitFor();

    const handed = await handoff(other);
    const banner = stripAnsi(other.terminal).slice(stripAnsi(other.terminal).lastIndexOf("this session now runs in the browser"));
    assert.ok(banner.includes(`${origin}/#t=`), "the banner shows the external link");
    assert.ok(banner.includes("Login with PI_PANE_PASSWORD"), "the banner names the password login");
    assert.ok(/[▀▄█]{10}/.test(banner), "the banner draws the QR code");
    // The logged-in viewer stays logged in and now drives the RPC child.
    await remote.locator(".sessions-button").waitFor();
    await remote.getByText("已连接", { exact: true }).waitFor();
    assert.equal(await remote.getByRole("textbox", { name: "访问密码" }).count(), 0, "no second login");
    await remote.getByRole("textbox", { name: "消息" }).fill("M3_EXTERNAL_HOST");
    await remote.getByRole("button", { name: /^(发送 ↗|请求 followUp ↗)$/ }).click();
    await waitFor(async () => (await events(other, "provider_done")).some(event => event.input === "M3_EXTERNAL_HOST"), "provider ran M3_EXTERNAL_HOST");
    await remote.locator(".message-assistant").filter({ hasText: "M0_REPLY:M3_EXTERNAL_HOST:complete" }).waitFor();
    // A new viewer, even with the link, still has to enter the password.
    const stranger = await (await externalBrowser.newContext({ ignoreHTTPSErrors: true })).newPage();
    await stranger.goto(other.publicUrl);
    await stranger.getByRole("textbox", { name: "访问密码" }).waitFor();
    assert.equal(await stranger.getByText("已连接", { exact: true }).count(), 0);

    other.write("\u0003");
    await waitFor(() => other.exitCode !== undefined, "pi process exits", 15_000);
    assert.equal(other.exitCode, 0);
    assert.ok(!alive(handed.childPid), "the RPC child has exited");
    assert.equal(await listening(backend), false, "the backend port is closed");
    return { tuiPid: handed.tuiPid, childPid: handed.childPid };
  });
  assert.deepEqual(pageErrors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = redact(error?.stack ?? error);
  if (fixture) report.terminalTail = redact(terminal(fixture).slice(-3000));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await externalBrowser?.close();
  await proxy?.close();
  if (certDir) await rm(certDir, { recursive: true, force: true });
  for (const item of [fixture, ...extra]) if (item) { await item.close(); await item.remove(); }
  report.finishedAt = new Date().toISOString();
  await writeFile(join(reportDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report: ${join(reportDir, "report.json")}`);
}
