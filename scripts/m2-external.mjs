#!/usr/bin/env node
// A10 + A11 (mobile): external access through a real pi TUI and system Chrome.
// - Refusals: plain non-loopback, missing password, missing transport.
// - Proxy mode behind a local TLS reverse proxy (stand-in for e.g. Tailscale Serve): login, bootstrap-only upgrade
//   refused, wrong password, logout, /web qr, rotation revoking every login and connection.
// - Direct TLS (node:https) with the same login flow; plain HTTP to the TLS port is not served.
// - Mobile viewport over the proxy: login, Enter inserts a newline, send and steer buttons, reconnect after a network drop.
// Chrome reaches the public host name through --host-resolver-rules and accepts the test certificate (ignoreHTTPSErrors).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest, get as httpGet } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright";
import WebSocket from "ws";
import { startFixture, waitFor } from "./m0-smoke.mjs";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportDir = resolve(process.env.PI_M2_REPORT_DIR ?? join(project, "build-artifacts/m2/external"));
await mkdir(reportDir, { recursive: true });
const PASSWORD = "m2-fixture-password-not-a-secret";
const HOST = "pane.example.test";
const stripAnsi = value => value.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
const redact = value => String(value).replace(/#t=[A-Za-z0-9_-]+/g, "#t=[REDACTED]").replace(/pi-pane\.bearer\.[A-Za-z0-9_-]+/g, "pi-pane.bearer.[REDACTED]").replaceAll(PASSWORD, "[PASSWORD]");
const report = {
  scope: "A10 external access (TLS proxy and direct TLS) and A11 mobile use over a real pi TUI and system Chrome",
  realTui: true, realModelCalls: 0, browser: "system Chrome via Playwright, headless; test certificate accepted via ignoreHTTPSErrors",
  notCovered: ["A real third-party proxy such as Tailscale Serve (a local TLS reverse proxy preserving Host, Origin and subprotocol stands in)",
    "Binding a non-loopback interface with TLS (exercised by unit tests on loopback; the refusal of plain non-loopback is exercised here)",
    "Login expiry in the real TUI (the 8-hour lifetime is exercised with a short lifetime in tests/external.test.ts)"],
  checks: [], status: "running",
};
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
async function freePort() {
  return new Promise(done => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => done(port)); }); });
}
function listening(port) {
  return new Promise(done => { const socket = connect(port, "127.0.0.1"); socket.once("connect", () => { socket.destroy(); done(true); }); socket.once("error", () => done(false)); });
}
const terminalText = fixture => stripAnsi(fixture.terminal).replace(/\s+/g, " ");
async function terminalShows(fixture, text, label = text) { await waitFor(() => terminalText(fixture).includes(text), `terminal: ${label}`); }

/** A same-machine TLS reverse proxy that forwards HTTP and WebSocket upgrades unchanged. */
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
  return {
    /** Simulates a network drop: every open connection is cut. */
    drop() { for (const socket of sockets) socket.destroy(); },
    close() { for (const socket of sockets) socket.destroy(); return new Promise(done => server.close(() => done())); },
  };
}
function call(url, { method = "GET", headers = {}, body, ca } = {}) {
  const target = new URL(url);
  return new Promise((resolvePromise, reject) => {
    const request = (target.protocol === "https:" ? httpsRequest : httpRequest)({ host: "127.0.0.1", port: target.port, method, path: target.pathname,
      headers: { Host: target.host, ...headers }, ...(ca ? { ca, servername: target.hostname, rejectUnauthorized: false } : {}) }, (response) => {
      response.resume(); response.on("end", () => resolvePromise(response.statusCode));
    });
    request.on("error", reject);
    request.end(body);
  });
}
function rejectedUpgrade(url, token, origin) {
  const target = new URL(url);
  return new Promise(done => {
    const socket = new WebSocket(`wss://127.0.0.1:${target.port}/ws`, ["pi-pane.v1", `pi-pane.bearer.${token}`], { headers: { Host: target.host, Origin: origin }, rejectUnauthorized: false });
    socket.on("unexpected-response", (_request, response) => { done(response.statusCode); socket.terminate(); });
    socket.on("open", () => { done("open"); socket.close(); });
    socket.on("error", () => done("error"));
  });
}

let denied, fixture, browser, proxy;
const errors = [];
const directory = await mkdtemp(join(tmpdir(), "pi-pane-m2-tls-"));
try {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", `/CN=${HOST}`,
    "-addext", `subjectAltName=DNS:${HOST},DNS:localhost`, "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem")], { stdio: "ignore" });
  const cert = await readFile(join(directory, "cert.pem"));
  const key = await readFile(join(directory, "key.pem"));

  await check("plain non-loopback, missing password and missing transport are refused without listening", async () => {
    denied = await startFixture({ autoWeb: false });
    const port = await freePort();
    denied.command(`/web --host 0.0.0.0 --port ${port} --no-open`);
    await terminalShows(denied, "Non-loopback access needs");
    assert.equal(await listening(port), false);
    denied.command(`/web --public-origin https://${HOST} --proxy --port ${port} --no-open`);
    await terminalShows(denied, "PI_PANE_PASSWORD environment variable");
    assert.equal(await listening(port), false);
    denied.command("/web qr");
    await terminalShows(denied, "pi-pane is stopped. Run /web first.");
    await denied.close(); await denied.remove(); denied = undefined;

    fixture = await startFixture({ autoWeb: false, envOverrides: { PI_PANE_PASSWORD: PASSWORD } });
    fixture.command(`/web --host 0.0.0.0 --public-origin https://${HOST} --port ${port} --no-open`);
    await terminalShows(fixture, "plain HTTP is refused");
    assert.equal(await listening(port), false);
    fixture.command(`/web --public-origin http://${HOST} --proxy --port ${port} --no-open`);
    await terminalShows(fixture, "must be https://host[:port]");
    assert.equal(await listening(port), false);
    return { port, listened: false };
  });

  const backend = await freePort();
  const proxyPort = await freePort();
  const origin = `https://${HOST}:${proxyPort}`;
  browser = await chromium.launch({ channel: "chrome", headless: true, args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1200, height: 860 } });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(String(error)));
  const loginForm = () => page.getByRole("textbox", { name: "访问密码" });
  const login = async (target, password) => {
    await target.getByRole("textbox", { name: "访问密码" }).fill(password);
    await target.getByRole("button", { name: "登录" }).click();
  };

  await check("proxy mode: bootstrap link + password logs in; prompts reach pi; the link token alone cannot connect", async () => {
    fixture.command(`/web --public-origin ${origin} --proxy --port ${backend} --no-open`);
    await waitFor(() => fixture.publicUrl?.startsWith(origin), "public link in terminal");
    await terminalShows(fixture, "login with PI_PANE_PASSWORD");
    proxy = await tlsProxy({ cert, key, port: proxyPort, upstream: backend });
    const bootstrap = new URL(fixture.publicUrl).hash.slice(3);
    assert.equal(await rejectedUpgrade(origin, bootstrap, origin), 401, "the bootstrap token cannot upgrade");
    await page.goto(fixture.publicUrl);
    await loginForm().waitFor();
    assert.equal(new URL(page.url()).hash, "", "the token is removed from the address bar");
    await login(page, "wrong password for fixture");
    await page.getByText("链接或密码不正确，或链接已失效。").waitFor();
    await login(page, PASSWORD);
    await page.getByText("已连接", { exact: true }).waitFor();
    const stored = await page.evaluate(() => Object.keys(sessionStorage).map(key => [key, sessionStorage.getItem(key)]));
    assert.ok(!JSON.stringify(stored).includes(PASSWORD), "the password is not stored");
    await page.getByRole("textbox", { name: "消息" }).fill("M2_REMOTE");
    await page.getByRole("button", { name: /^(发送 ↗|请求 followUp ↗)$/ }).click();
    await fixture.waitEvent("provider_call", 0, event => event.input === "M2_REMOTE");
    await page.locator(".message-assistant").filter({ hasText: "M0_REPLY:M2_REMOTE:complete" }).waitFor();
    // Direct access to the loopback backend with the public Origin still needs a login session.
    assert.equal(await call(`http://127.0.0.1:${backend}/auth/info`), 200);
    fixture.command("/web status");
    await terminalShows(fixture, "1 login(s)");
    return { origin, backend };
  });

  await check("/web qr shows the external link as a terminal QR code", async () => {
    fixture.command("/web qr");
    await terminalShows(fixture, "scan to open");
    assert.ok(/[▀▄█]{10}/.test(stripAnsi(fixture.terminal)), "half-block QR modules are drawn");
  });

  await check("logout and rotation revoke logins and connections", async () => {
    await page.getByRole("button", { name: "退出登录" }).click();
    await loginForm().waitFor();
    await login(page, PASSWORD);
    await page.getByText("已连接", { exact: true }).waitFor();
    const session = await page.evaluate(() => sessionStorage.getItem("pi-pane.session"));
    assert.equal(await call(`${origin}/auth/session`, { headers: { Origin: origin, Authorization: `Bearer ${session}` }, ca: cert }), 200);
    const previous = fixture.publicUrl;
    fixture.command("/web --rotate --no-open");
    await waitFor(() => fixture.publicUrl !== previous, "new link after rotation");
    await page.getByText("访问凭据已轮换", { exact: false }).waitFor();
    assert.equal(await call(`${origin}/auth/session`, { headers: { Origin: origin, Authorization: `Bearer ${session}` }, ca: cert }), 401, "rotation revokes the login");
    assert.equal(await rejectedUpgrade(origin, session, origin), 401);
    // The old link no longer logs in; the new one does.
    await page.goto(previous);
    await login(page, PASSWORD);
    await page.getByText("链接或密码不正确，或链接已失效。").waitFor();
    await page.goto(fixture.publicUrl);
    await login(page, PASSWORD);
    await page.getByText("已连接", { exact: true }).waitFor();
  });

  await check("A11 mobile: login, newline on Enter, send and steer buttons, reconnect after a network drop", async () => {
    const mobile = await browser.newContext({ ...devices["Pixel 7"], ignoreHTTPSErrors: true });
    const phone = await mobile.newPage();
    phone.on("pageerror", error => errors.push(String(error)));
    await phone.goto(fixture.publicUrl);
    await phone.getByRole("textbox", { name: "访问密码" }).fill(PASSWORD);
    await phone.getByRole("button", { name: "登录" }).tap();
    await phone.getByText("已连接", { exact: true }).waitFor();
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `no horizontal overflow (${overflow})`);
    const box = phone.getByRole("textbox", { name: "消息" });
    await box.tap();
    await box.pressSequentially("M0_SLOW_PHONE");
    await phone.keyboard.press("Enter");
    assert.equal(await box.inputValue(), "M0_SLOW_PHONE\n", "Enter inserts a newline on touch screens");
    await box.fill("M0_SLOW_PHONE");
    await phone.getByRole("button", { name: /^(发送 ↗|请求 followUp ↗)$/ }).tap();
    await fixture.waitEvent("provider_call", 0, event => event.input === "M0_SLOW_PHONE");
    await phone.getByText("正在运行", { exact: true }).waitFor();
    const steerSize = await phone.getByRole("button", { name: "steer" }).boundingBox();
    assert.ok(steerSize.height >= 40, `steer button is a touch target (${steerSize.height}px)`);
    await box.fill("PHONE_STEER");
    await phone.getByRole("button", { name: "steer" }).tap();
    await fixture.waitEvent("provider_call", 0, event => event.input === "PHONE_STEER");
    await phone.screenshot({ path: join(reportDir, "mobile.png") });

    const clientId = await phone.evaluate(() => sessionStorage.getItem("pi-pane.clientId"));
    proxy.drop();
    await phone.getByText("已断开", { exact: true }).waitFor();
    await phone.getByText("已连接", { exact: true }).waitFor({ timeout: 20_000 });
    assert.equal(await phone.evaluate(() => sessionStorage.getItem("pi-pane.clientId")), clientId, "the same client lease resumes");
    await mobile.close();
    return { overflow, steerHeight: steerSize.height };
  });

  await check("direct TLS: HTTPS/WSS with the certificate and the same login; plain HTTP is not served", async () => {
    await proxy.close(); proxy = undefined;
    fixture.command("/web stop");
    await terminalShows(fixture, "pi-pane stopped.");
    const port = await freePort();
    const tlsOrigin = `https://${HOST}:${port}`;
    fixture.command(`/web --port ${port} --public-origin ${tlsOrigin} --tls-cert ${join(directory, "cert.pem")} --tls-key ${join(directory, "key.pem")} --no-open`);
    await waitFor(() => fixture.publicUrl?.startsWith(tlsOrigin), "TLS link in terminal");
    await terminalShows(fixture, `listening on https://127.0.0.1:${port}`);
    await assert.rejects(new Promise((done, fail) => httpGet({ host: "127.0.0.1", port, path: "/healthz", headers: { Host: `${HOST}:${port}` } }, response => { response.resume(); done(response.statusCode); }).on("error", fail)));
    await page.goto(fixture.publicUrl);
    await login(page, PASSWORD);
    await page.getByText("已连接", { exact: true }).waitFor();
    const bootstrap = new URL(fixture.publicUrl).hash.slice(3);
    assert.equal(await rejectedUpgrade(tlsOrigin, bootstrap, tlsOrigin), 401);
    return { origin: tlsOrigin };
  });
  assert.deepEqual(errors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = redact(error?.stack ?? error);
  if (fixture) report.terminalTail = redact(terminalText(fixture).slice(-3000));
  process.exitCode = 1;
} finally {
  await proxy?.close();
  await browser?.close();
  for (const item of [denied, fixture]) if (item) { await item.close(); await item.remove(); }
  await rm(directory, { recursive: true, force: true });
  report.pageErrors = errors.map(redact);
  report.finishedAt = new Date().toISOString();
  await writeFile(join(reportDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report: ${join(reportDir, "report.json")}`);
}
