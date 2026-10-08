import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { AUTH_EXPIRED, Hub, type HubOptions } from "../src/extension/hub.ts";
import type { Bridge } from "../src/extension/bridge.ts";
import { COMMANDS } from "../src/protocol/index.ts";

const PASSWORD = "correct horse battery";
const PUBLIC = "https://pane.example.test";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(predicate: () => T | undefined | false, label: string, timeout = 3_000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = predicate(); if (value) return value; await delay(5); }
  throw new Error(`Timed out: ${label}`);
}
const bridge = {
  sessionId: "fixture-session", branchRevision: 0, isCurrent: () => true, setObserver: () => {}, dispatch: () => {}, flush: () => {},
  snapshot: () => ({
    session: { id: "fixture-session", cwd: "/fixture", leafId: null, branchRevision: 0, messages: [], olderCursor: null },
    state: { idle: true, running: false, compacting: false, hasPendingMessages: false, thinking: "off", models: [], tools: [], uiPrompts: [] },
    theme: {}, caps: { commands: COMMANDS, images: true, promptReceipt: "dispatch_only", queueView: "boolean", terminalDialogs: true, history: "paged", content: "paged" },
  }),
} as unknown as Bridge;

async function fixture(options: Partial<HubOptions>) {
  const directory = await mkdtemp(join(tmpdir(), "pi-pane-external-test-"));
  await writeFile(join(directory, "index.html"), "<!doctype html><title>test</title>");
  const hub = new Hub({ port: 0, webRoot: directory, ...options });
  await hub.start(); hub.bindBridge(bridge);
  return { hub, async close() { await hub.close(); await rm(directory, { recursive: true, force: true }); } };
}
interface Reply { status: number; headers: IncomingHttpHeaders; body: Record<string, unknown> }
function call(port: number, method: string, path: string, headers: Record<string, string>, body?: string, ca?: Buffer): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = (ca ? httpsRequest : httpRequest)({ host: "127.0.0.1", port, method, path, headers, ...(ca ? { ca, servername: "localhost" } : {}) }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* non-JSON */ }
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: parsed });
      });
    });
    request.on("error", reject);
    request.end(body);
  });
}
function upgrade(url: string, token: string, headers: Record<string, string>, ca?: Buffer) {
  const socket = new WebSocket(url, ["pi-pane.v1", `pi-pane.bearer.${token}`], { headers, ...(ca ? { ca, servername: "localhost" } : {}) });
  const frames: Array<Record<string, unknown>> = [];
  const state = { opened: false, closed: false, code: 0, reason: "", status: 0 };
  socket.on("message", (raw) => frames.push(JSON.parse(raw.toString()) as Record<string, unknown>));
  socket.on("open", () => { state.opened = true; socket.send(JSON.stringify({ t: "hello" })); });
  socket.on("unexpected-response", (_request, response) => { state.status = response.statusCode ?? 0; state.closed = true; });
  socket.on("error", () => { state.closed = true; });
  socket.on("close", (code, reason) => { state.closed = true; state.code = code; state.reason = reason.toString(); });
  return { socket, frames, state };
}
const proxyHeaders = { Host: "pane.example.test", Origin: PUBLIC };
const login = (port: number, body: unknown, headers: Record<string, string> = proxyHeaders, ca?: Buffer) =>
  call(port, "POST", "/auth/session", { ...headers, "Content-Type": "application/json" }, JSON.stringify(body), ca);

test("external access refuses plain or incomplete configurations before listening", () => {
  const base = { webRoot: "/nonexistent", port: 0 };
  const cases: Array<[HubOptions, RegExp]> = [
    [{ ...base, host: "0.0.0.0" }, /Non-loopback access needs/],
    [{ ...base, host: "0.0.0.0", external: { publicOrigin: PUBLIC, password: PASSWORD } }, /exactly one of TLS/],
    [{ ...base, external: { publicOrigin: PUBLIC, password: "short", proxy: true } }, /at least 12 characters/],
    [{ ...base, external: { publicOrigin: "http://pane.example.test", password: PASSWORD, proxy: true } }, /https/],
    [{ ...base, external: { publicOrigin: `${PUBLIC}/pane`, password: PASSWORD, proxy: true } }, /without a path/],
    [{ ...base, external: { publicOrigin: "https://0.0.0.0", password: PASSWORD, proxy: true } }, /wildcard/],
    [{ ...base, host: "0.0.0.0", external: { publicOrigin: PUBLIC, password: PASSWORD, proxy: true } }, /loopback only/],
    [{ ...base, external: { publicOrigin: PUBLIC, password: PASSWORD, proxy: true, tls: { cert: "x", key: "y" } } }, /exactly one of TLS/],
  ];
  for (const [options, message] of cases) assert.throws(() => new Hub(options), message);
});

test("proxy mode: bootstrap link plus password yields a session token; only that token upgrades", async () => {
  const f = await fixture({ external: { publicOrigin: PUBLIC, password: PASSWORD, proxy: true } });
  try {
    const port = f.hub.port;
    assert.equal(f.hub.mode, "password");
    assert.equal(f.hub.url, `${PUBLIC}/#t=${f.hub.token}`);
    const info = await call(port, "GET", "/auth/info", proxyHeaders);
    assert.deepEqual(info.body, { mode: "password" });
    assert.match(String(info.headers["content-security-policy"]), /connect-src 'self' wss:\/\/pane\.example\.test;/);
    assert.equal((await call(port, "GET", "/auth/info", { Host: "evil.example.test" })).status, 403);

    // The link token alone never upgrades.
    const direct = upgrade(`ws://127.0.0.1:${port}/ws`, f.hub.token, proxyHeaders);
    await until(() => direct.state.closed, "bootstrap rejected");
    assert.equal(direct.state.status, 401);

    const wrong = await login(port, { bootstrapToken: f.hub.token, password: "wrong password!!" });
    const badLink = await login(port, { bootstrapToken: "x".repeat(43), password: PASSWORD });
    assert.equal(wrong.status, 401); assert.equal(badLink.status, 401);
    assert.equal(wrong.body.message, badLink.body.message, "one message for every failed credential");
    assert.equal((await login(port, { bootstrapToken: f.hub.token, password: PASSWORD }, { Host: "pane.example.test" })).status, 403, "missing Origin");
    assert.equal((await login(port, { bootstrapToken: f.hub.token, password: PASSWORD }, { Host: "pane.example.test", Origin: "https://evil.example.test" })).status, 403);
    assert.equal((await call(port, "POST", "/auth/session", { ...proxyHeaders, "Content-Type": "text/plain" }, "{}")).status, 415);
    assert.equal((await login(port, { bootstrapToken: f.hub.token, password: PASSWORD, extra: true })).status, 401);
    assert.equal((await call(port, "POST", "/auth/session", { ...proxyHeaders, "Content-Type": "application/json" }, "x".repeat(9000))).status, 400);

    const ok = await login(port, { bootstrapToken: f.hub.token, password: PASSWORD });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers["cache-control"], "no-store");
    const token = String(ok.body.sessionToken);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal((await call(port, "GET", "/auth/session", { ...proxyHeaders, Authorization: `Bearer ${token}` })).status, 200);

    // Exact Origin: the loopback origin of the upstream is not a browser origin in external mode.
    const wrongOrigin = upgrade(`ws://127.0.0.1:${port}/ws`, token, { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}` });
    await until(() => wrongOrigin.state.closed, "wrong origin rejected");
    assert.equal(wrongOrigin.state.status, 403);

    const viewer = upgrade(`ws://127.0.0.1:${port}/ws`, token, proxyHeaders);
    await until(() => viewer.frames.find((frame) => frame.t === "snapshot"), "snapshot over login session");
    assert.equal(f.hub.connectionCount, 1);
    // A proxy may forward with the upstream Host; Origin must still be the public one.
    const upstream = upgrade(`ws://127.0.0.1:${port}/ws`, token, { Host: `127.0.0.1:${port}`, Origin: PUBLIC });
    await until(() => upstream.frames.find((frame) => frame.t === "snapshot"), "upstream Host accepted");

    f.hub.rotateToken();
    await until(() => viewer.state.closed && upstream.state.closed, "rotation closes logged-in viewers");
    assert.equal((await call(port, "GET", "/auth/session", { ...proxyHeaders, Authorization: `Bearer ${token}` })).status, 401);
    const after = upgrade(`ws://127.0.0.1:${port}/ws`, token, proxyHeaders);
    await until(() => after.state.closed, "revoked token rejected");
    assert.equal(after.state.status, 401);
  } finally { await f.close(); }
});

test("login sessions expire on time, logout revokes, and failed logins are rate limited", async () => {
  const f = await fixture({ external: { publicOrigin: PUBLIC, password: PASSWORD, proxy: true, authTtlMs: 400 } });
  try {
    const port = f.hub.port;
    const first = String((await login(port, { bootstrapToken: f.hub.token, password: PASSWORD })).body.sessionToken);
    const viewer = upgrade(`ws://127.0.0.1:${port}/ws`, first, proxyHeaders);
    await until(() => viewer.frames.find((frame) => frame.t === "welcome"), "welcome");
    const welcome = viewer.frames.find((frame) => frame.t === "welcome")!;
    assert.ok(Number(welcome.leaseExpiresAt) <= Date.now() + 400, "a lease never outlives its login");
    await until(() => viewer.state.closed, "expired login closes its connection", 2_000);
    assert.equal(viewer.state.code, AUTH_EXPIRED);
    assert.equal(viewer.state.reason, "auth_expired");
    assert.equal((await call(port, "GET", "/auth/session", { ...proxyHeaders, Authorization: `Bearer ${first}` })).status, 401);

    const second = String((await login(port, { bootstrapToken: f.hub.token, password: PASSWORD })).body.sessionToken);
    const other = upgrade(`ws://127.0.0.1:${port}/ws`, second, proxyHeaders);
    await until(() => other.frames.find((frame) => frame.t === "snapshot"), "second login");
    assert.equal((await call(port, "DELETE", "/auth/session", { ...proxyHeaders, Authorization: `Bearer ${second}` })).status, 200);
    await until(() => other.state.closed, "logout closes the connection");
    assert.equal(other.state.reason, "logged_out");

    for (let i = 0; i < 10; i++) assert.equal((await login(port, { bootstrapToken: f.hub.token, password: `wrong-${i}-password` })).status, 401);
    const limited = await login(port, { bootstrapToken: f.hub.token, password: PASSWORD });
    assert.equal(limited.status, 429, "the correct password is refused once the failure budget is spent");
  } finally { await f.close(); }
});

test("direct TLS serves HTTPS/WSS with the certificate and the same login flow", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-pane-tls-test-"));
  try {
    try {
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
        "-addext", "subjectAltName=DNS:localhost", "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem")], { stdio: "ignore" });
    } catch { t.skip("openssl is unavailable"); return; }
    const cert = await readFile(join(directory, "cert.pem"));
    const key = await readFile(join(directory, "key.pem"));
    const port = await new Promise<number>((resolve) => { const probe = createServer().listen(0, "127.0.0.1", () => { const value = (probe.address() as { port: number }).port; probe.close(() => resolve(value)); }); });
    const origin = `https://localhost:${port}`;
    const f = await fixture({ port, external: { publicOrigin: origin, password: PASSWORD, tls: { cert, key } } });
    try {
      assert.equal(f.hub.listenAddress, `https://127.0.0.1:${port}`);
      const headers = { Host: `localhost:${port}`, Origin: origin };
      assert.equal((await call(port, "GET", "/healthz", headers, undefined, cert)).status, 200);
      const ok = await login(port, { bootstrapToken: f.hub.token, password: PASSWORD }, headers, cert);
      assert.equal(ok.status, 200);
      const viewer = upgrade(`wss://127.0.0.1:${port}/ws`, String(ok.body.sessionToken), headers, cert);
      await until(() => viewer.frames.find((frame) => frame.t === "snapshot"), "snapshot over WSS");
      // Plain HTTP to the TLS port is not served.
      await assert.rejects(call(port, "GET", "/healthz", headers));
      viewer.socket.close();
    } finally { await f.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
