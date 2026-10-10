#!/usr/bin/env node
/** Real pi TUI + WebSocket integration checks with an isolated, local-only provider. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import WebSocket from "ws";
import { applyProjectionEvent } from "../dist/protocol/index.js";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturesByUrl = new Map();
export function setFixtureControl(url, client) {
  const fixture = fixturesByUrl.get(url);
  if (fixture && (!fixture.webClient || fixture.webClient.socket.readyState !== WebSocket.OPEN)) fixture.webClient = client;
}
const pause = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
export const textOf = (message) => message?.content?.filter((part) => part.type === "text").map((part) => part.text).join("") ?? "";
const stripAnsi = (value) => value.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
const redact = (value) => value.replace(/#t=[A-Za-z0-9_-]+/g, "#t=[REDACTED]").replace(/pi-pane\.bearer\.[A-Za-z0-9_-]+/g, "pi-pane.bearer.[REDACTED]");

/** Resolve the selected CLI's own package, including bundled CLI entrypoints. */
export async function readPiHost(selectedCli = process.env.PI_M0_CLI || join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js")) {
  const cli = await realpath(resolve(selectedCli));
  let directory = dirname(cli);
  while (true) {
    let manifest;
    try { manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (manifest?.name === "@earendil-works/pi-coding-agent") {
      if (typeof manifest.version !== "string" || !manifest.version) throw new Error(`Selected pi host has no package version: ${directory}`);
      return { cli, packageRoot: directory, version: manifest.version };
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Selected CLI does not belong to @earendil-works/pi-coding-agent: ${cli}`);
    directory = parent;
  }
}

export async function waitFor(predicate, label, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await predicate();
    if (result) return result;
    await pause(20);
  }
  throw new Error(`Timed out: ${label}`);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolvePromise); });
  const port = server.address().port;
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return port;
}

export async function startFixture({ autoWeb = true, extraExtensions = [], settings = {}, envOverrides = {}, disablePane = false,
  provider = "pi-pane-m0", model = "deterministic", packaged = false, loadThemes = false, loadSkills = false, loadPromptTemplates = false, prepareAgentDir, cli: selectedCli, controllingTty = true, webArgs = [], extraArgs = [], seedSession = true, webConfigFlags = true } = {}) {
  if (process.platform === "win32") throw new Error("The M0 real-TUI harness requires a POSIX PTY (macOS or Linux).");
  for (const key of Object.keys(envOverrides)) if (!key.startsWith("PI_M0_") && !key.startsWith("PI_M31_") && key !== "PI_PANE_PASSWORD") throw new Error(`Fixture env override is not allowed: ${key}`);
  const host = await readPiHost(selectedCli);
  const { cli } = host;
  const extension = resolve(process.env.PI_M0_EXTENSION || join(project, "src/extension/index.ts"));
  const directory = await mkdtemp(join(tmpdir(), "pi-pane-m0-"));
  const agentDir = join(directory, "agent");
  const cwd = join(directory, "workspace");
  await mkdir(agentDir);
  await mkdir(cwd);
  await writeFile(join(agentDir, "auth.json"), "{}", { mode: 0o600 });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    ...(provider && model ? { defaultProvider: provider, defaultModel: model } : {}), quietStartup: true,
    lastChangelogVersion: host.version, packages: [], compaction: { enabled: false },
    ...settings,
  }), { mode: 0o600 });
  // `packaged`: pi-pane comes from a package installed into the agent directory, not from -e.
  if (prepareAgentDir) await prepareAgentDir(agentDir, directory);
  const eventPath = join(directory, "fixture-events.jsonl");
  await writeFile(eventPath, "", { mode: 0o600 });
  let seedSessionFile;
  if (!disablePane && seedSession) {
    // Failure/large-stream fixtures still need a saved file to hand off. Public SessionManager
    // writes a synthetic history only in the task-owned directory; it never loads auth.
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const session = SessionManager.create(cwd, join(agentDir, "sessions"));
    session.appendMessage({ role: "user", content: [{ type: "text", text: "M0_SAVED_FIXTURE" }], timestamp: Date.now() });
    session.appendMessage({ role: "assistant", content: [{ type: "text", text: "M0_SAVED_FIXTURE_REPLY" }], api: "pi-pane-m0-api", provider: "pi-pane-m0", model: "deterministic", timestamp: Date.now(), stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    seedSessionFile = session.getSessionFile();
  }
  const port = await freePort();
  // An allowlist avoids inheriting real provider/API credentials into the fixture.
  const env = Object.fromEntries(["PATH", "TMPDIR", "LANG", "LC_ALL", "SYSTEMROOT"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  Object.assign(env, { HOME: directory, TERM: "xterm-256color", COLORTERM: "truecolor", PI_OFFLINE: "1", NO_COLOR: "1",
    PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: join(agentDir, "sessions"), PI_M0_EVENTS_PATH: eventPath, ...envOverrides });
  const argv = [process.execPath, cli, ...(packaged ? [] : ["--no-extensions"]), ...(loadSkills ? [] : ["--no-skills"]), ...(loadPromptTemplates ? [] : ["--no-prompt-templates"]), ...(loadThemes ? [] : ["--no-themes"]), "--no-builtin-tools",
    "-e", join(project, "tests/fixtures/deterministic-provider.ts"), ...(!disablePane && !packaged ? ["-e", extension] : []),
    ...extraExtensions.flatMap((path) => ["-e", resolve(path)]),
    ...(provider && model ? ["--provider", provider, "--model", model] : []),
    ...(!disablePane && webConfigFlags ? ["--web-port", String(port), "--web-no-open"] : []), ...(seedSessionFile ? ["--session", seedSessionFile] : []), ...extraArgs];
  const proc = spawn("python3", [join(project, "scripts/pty-host.py")], { stdio: ["pipe", "pipe", "pipe"] });
  const fixture = { proc, directory, agentDir, cwd, eventPath, port, cli, piVersion: host.version, extension, env, argv, terminal: "", processError: "", exitCode: undefined, url: undefined,
    write(data) { if (proc.stdin.writable && !proc.stdin.destroyed) proc.stdin.write(`${JSON.stringify({ type: "write", data })}\n`); },
    handoff: false, commandErrors: [], webClient: undefined,
    tuiCommand(text) { fixture.write(`${text}\r`); },
    command(text) {
      if (!fixture.handoff) return fixture.tuiCommand(text);
      const operation = fixture.webCommand(text);
      operation.catch(error => { fixture.commandErrors.push(String(error)); fixture.processError += `\nWEB COMMAND ERROR: ${error}\n`; });
      return operation;
    },
    async webCommand(text) {
      if (!fixture.webClient || fixture.webClient.socket.readyState !== WebSocket.OPEN) fixture.webClient = await openClient(fixture.url);
      const client = fixture.webClient;
      if (text === "/new") return client.command("session_new");
      if (text.startsWith("/name ")) return client.command("session_rename", { name: text.slice(6) });
      if (text === "/m0-fork") {
        const tree = await workbenchQuery(client, "tree");
        const user = tree.entries.filter(entry => entry.role === "user").at(-1);
        assert.ok(user, "a real user entry exists for RPC fork");
        return client.command("session_fork", { entryId: user.id });
      }
      if (text.startsWith("!")) throw new Error("TUI bang execution is unavailable after handoff; use model tools or saved pre-handoff history.");
      return client.command("prompt", { text, mode: "followUp" });
    },
    async handoffToWeb(args = webArgs) {
      assert.equal(fixture.handoff, false, "handoff happens once per foreground host");
      fixture.tuiCommand(["/web", ...args].join(" "));
      await waitFor(() => {
        if (fixture.exitCode !== undefined) throw new Error(`pi exited during handoff (${fixture.exitCode})`);
        return fixture.url;
      }, "foreground /web handoff URL", 30_000);
      fixture.handoff = true; fixturesByUrl.set(fixture.url, fixture);
      return fixture.url;
    },
    async events() { return (await readFile(eventPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); },
    async eventCount(name) { return (await fixture.events()).filter((event) => event.event === name).length; },
    async waitEvent(name, after = 0, filter = () => true) {
      return waitFor(async () => (await fixture.events()).filter((event) => event.event === name && filter(event))[after], `fixture ${name}`);
    },
    async close() {
      await fixture.webClient?.close().catch(() => {});
      if (proc.exitCode === null) {
        if (proc.stdin.writable && !proc.stdin.destroyed) proc.stdin.write(`${JSON.stringify({ type: "terminate" })}\n`);
        await Promise.race([new Promise((resolvePromise) => proc.once("exit", resolvePromise)), pause(5_000)]);
        if (proc.exitCode === null) proc.kill("SIGKILL");
      }
    },
    async remove() { await rm(directory, { recursive: true, force: true }); },
  };
  proc.stdin.on("error", error => { if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") fixture.processError += `PTY input: ${error}\n`; });
  proc.on("error", error => { fixture.processError += `PTY process: ${error}\n`; fixture.exitCode = -1; });
  proc.stderr.on("data", (data) => { fixture.processError += data.toString(); });
  proc.on("exit", (code) => { fixture.exitCode = code; });
  createInterface({ input: proc.stdout }).on("line", (line) => {
    const item = JSON.parse(line);
    if (item.type === "output") {
      fixture.terminal = (fixture.terminal + item.data).slice(-1_000_000);
      const urls = [...stripAnsi(fixture.terminal).matchAll(/http:\/\/127\.0\.0\.1:\d+\/#t=[A-Za-z0-9_-]+/g)];
      if (urls.length) fixture.url = urls.at(-1)[0];
      const external = [...stripAnsi(fixture.terminal).matchAll(/https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/#t=[A-Za-z0-9_-]{43}/g)];
      if (external.length) fixture.publicUrl = external.at(-1)[0];
      // Answer terminal capability queries so TUI startup does not depend on a real emulator.
      if (item.data.includes("\u001b[6n")) fixture.write("\u001b[1;1R");
    } else if (item.type === "started") fixture.hostPid = item.pid;
    else if (item.type === "exit") fixture.exitCode = item.code;
  });
  proc.stdin.write(`${JSON.stringify({ argv, env, cwd, controllingTty })}\n`);
  try {
    await fixture.waitEvent("session_start");
    await pause(100);
    if (autoWeb && !disablePane) {
      if (seedSession && provider === "pi-pane-m0" && model === "deterministic" && !envOverrides.PI_M0_NO_PROVIDER) {
        fixture.tuiCommand("M0_HANDOFF_SEED");
        await fixture.waitEvent("provider_done", 0, event => event.input === "M0_HANDOFF_SEED");
        await pause(100);
      }
      await fixture.handoffToWeb();
    }
    return fixture;
  } catch (error) {
    const diagnostic = redact(stripAnsi(fixture.terminal + fixture.processError)).slice(-6000);
    await fixture.close(); await fixture.remove();
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${diagnostic}`);
  }
}

export async function openClient(url, clientId, options = {}) {
  const parsed = new URL(url);
  const token = options.token ?? new URLSearchParams(parsed.hash.slice(1)).get("t");
  const socket = new WebSocket(`${parsed.protocol === "https:" ? "wss" : "ws"}://${parsed.host}/ws`, ["pi-pane.v1", `pi-pane.bearer.${token}`], { origin: parsed.origin, ...options });
  const client = { socket, frames: [], snapshot: undefined, clientId, nextCommandNo: 1, closed: false, protocolErrors: [],
    send(frame) { socket.send(JSON.stringify(frame)); },
    makeCommand(command, args = {}, version = client.snapshot) {
      assert.ok(version, "snapshot is available before submitting");
      const commandNo = client.nextCommandNo++;
      return { t: "command", clientId: client.clientId, commandNo, id: `${client.clientId}:${commandNo}`,
        epoch: version.epoch, sessionId: version.session.id, branchRevision: version.session.branchRevision, command, args };
    },
    async command(command, args = {}, version) {
      const frame = client.makeCommand(command, args, version);
      client.send(frame);
      const ack = await waitFor(() => client.frames.find((item) => item.t === "ack" && item.id === frame.id), `ack ${command}`);
      return { ack, frame };
    },
    async close() {
      if (client.closed) return;
      socket.close();
      await waitFor(() => client.closed, "client close", 3_000);
    },
    users(text) { return client.snapshot?.session.messages.filter((message) => message.role === "user" && textOf(message) === text) ?? []; },
    assistants(text) { return client.snapshot?.session.messages.filter((message) => message.role === "assistant" && textOf(message).startsWith(`M0_REPLY:${text}:`)) ?? []; },
    async settled(text) {
      await waitFor(() => client.snapshot?.state.idle && client.assistants(text).some((message) => message.status === "complete"), `settled ${text}`, 20_000);
      assert.equal(client.users(text).length, 1, "one user message");
      assert.equal(client.assistants(text).length, 1, "one assistant message");
      assert.equal(textOf(client.assistants(text)[0]), `M0_REPLY:${text}:` + (text.includes("M0_SLOW") ? "0123456789abcdef".repeat(30) : "complete"), "final text is complete, not just a valid prefix");
    },
  };
  socket.on("close", () => { client.closed = true; });
  socket.on("error", () => {});
  let assembling;
  socket.on("message", (data) => {
    let frame = JSON.parse(data.toString());
    // Logical frames above 1 MiB arrive as contiguous frame_begin/frame_chunk/frame_end parts.
    if (frame.t === "frame_begin") { assembling = { id: frame.id, parts: frame.parts, chunks: [] }; return; }
    if (frame.t === "frame_chunk") {
      if (!assembling || frame.id !== assembling.id || frame.index !== assembling.chunks.length) client.protocolErrors.push({ chunk: frame.index });
      else assembling.chunks.push(frame.data);
      return;
    }
    if (frame.t === "frame_end") {
      const done = assembling; assembling = undefined;
      if (!done || done.id !== frame.id || done.chunks.length !== done.parts) { client.protocolErrors.push({ chunkEnd: frame.id }); return; }
      frame = JSON.parse(done.chunks.join(""));
    }
    client.frames.push(frame);
    if (frame.t === "welcome") { client.clientId = frame.clientId; client.nextCommandNo = frame.nextCommandNo; }
    if (frame.t === "ack") client.nextCommandNo = Math.max(client.nextCommandNo, frame.nextCommandNo ?? 1);
    if (frame.t === "snapshot") client.snapshot = structuredClone(frame);
    if (frame.t === "session_reset") client.snapshot = undefined;
    if (frame.t !== "event") return;
    const state = client.snapshot;
    if (!state || frame.epoch !== state.epoch || frame.seq !== state.seq + 1) {
      client.protocolErrors.push({ expectedEpoch: state?.epoch, gotEpoch: frame.epoch, expectedSeq: (state?.seq ?? -1) + 1, gotSeq: frame.seq });
      return;
    }
    // The browser and the harness apply events through the same shared reducer.
    try { client.snapshot = { ...applyProjectionEvent(state, frame.ev), seq: frame.seq }; }
    catch (error) { client.protocolErrors.push({ seq: frame.seq, type: frame.ev?.type, error: String(error) }); }
  });
  await new Promise((resolvePromise, reject) => { socket.once("open", resolvePromise); socket.once("error", reject); });
  client.send({ t: "hello", ...(clientId ? { clientId } : {}) });
  // `sessionless`: the host may have no session to show (a failed runtime replacement).
  await waitFor(() => (client.snapshot || options.sessionless) && client.clientId, "authenticated snapshot");
  setFixtureControl(url, client);
  return client;
}

export async function workbenchQuery(client, action, args = {}) {
  const version = client.snapshot;
  assert.ok(version, "read query has a live version");
  const reqId = `fixture-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  client.send({ t: "workbench_query", reqId, epoch: version.epoch, sessionId: version.session.id, branchRevision: version.session.branchRevision, action, args });
  const reply = await waitFor(() => client.frames.find(frame => frame.reqId === reqId && ["workbench_result", "error"].includes(frame.t)), `workbench ${action}`);
  if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
  return reply.value;
}

export async function commandResult(client, frame) {
  return waitFor(() => client.frames.find(item => item.t === "command_result" && item.id === frame.id), `result ${frame.command}`);
}

export async function rejectedHandshake(url, overrides = {}) {
  const parsed = new URL(url);
  const token = new URLSearchParams(parsed.hash.slice(1)).get("t");
  return new Promise((resolvePromise, reject) => {
    const socket = new WebSocket(`ws://${parsed.host}/ws`, ["pi-pane.v1", `pi-pane.bearer.${overrides.token ?? token}`],
      { origin: overrides.origin ?? parsed.origin, ...(overrides.host ? { headers: { Host: overrides.host } } : {}) });
    const timeout = setTimeout(() => { socket.terminate(); reject(new Error("Unauthorized handshake did not settle")); }, 3_000);
    socket.once("open", () => { clearTimeout(timeout); socket.close(); reject(new Error("Unauthorized handshake was accepted")); });
    socket.on("error", () => {});
    socket.once("unexpected-response", (_request, response) => {
      clearTimeout(timeout); response.resume(); socket.terminate(); resolvePromise(response.statusCode);
    });
    socket.once("close", () => { clearTimeout(timeout); resolvePromise(0); });
  });
}

async function checkNonTui(fixture, mode) {
  const directory = join(fixture.directory, `non-tui-${mode}`);
  const agentDir = join(directory, "agent");
  const cwd = join(directory, "workspace");
  await mkdir(agentDir, { recursive: true }); await mkdir(cwd);
  await writeFile(join(agentDir, "auth.json"), "{}", { mode: 0o600 });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [], compaction: { enabled: false } }));
  const eventsPath = join(directory, "events.jsonl"); await writeFile(eventsPath, "");
  const port = await freePort();
  const argv = [...fixture.argv.slice(1)];
  // Noninteractive modes must never borrow the handed-off transcript. Print/json
  // persist their prompt, so sharing --session would correctly trip its lock.
  const sessionIndex = argv.indexOf("--session");
  if (sessionIndex >= 0) argv.splice(sessionIndex, 2);
  argv[argv.indexOf("--web-port") + 1] = String(port);
  argv.push("--mode", mode === "print" ? "text" : mode);
  if (mode !== "rpc") argv.push("--print", "M0_NONTUI");
  const proc = spawn(process.execPath, argv, { cwd, env: { ...fixture.env, HOME: directory, PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: join(agentDir, "sessions"), PI_M0_EVENTS_PATH: eventsPath }, stdio: ["pipe", "pipe", "pipe"] });
  let output = ""; let error = ""; let exitCode;
  proc.stdout.on("data", (data) => { output += data; }); proc.stderr.on("data", (data) => { error += data; });
  proc.once("exit", (code) => { exitCode = code; });
  // RPC receives a benign read-only request, then EOF. The print modes receive CLI text.
  proc.stdin.end(mode === "rpc" ? `${JSON.stringify({ id: "m0-read", type: "get_state" })}\n` : "");
  try {
    await waitFor(() => exitCode !== undefined, `${mode} mode exits without a listener/timer`, 15_000);
    assert.equal(exitCode, 0, `${mode} exit: ${redact(error).slice(-2000)}`);
    assert.doesNotMatch(error + output, /#t=[A-Za-z0-9_-]{43}/, `${mode} does not start a pane listener from configuration flags`);
    await assert.rejects(() => fetch(`http://127.0.0.1:${port}/healthz`));
    const events = (await readFile(eventsPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.event === "session_start"), "real host initialized extensions");
    if (mode !== "rpc") assert.ok(events.some((event) => event.event === "provider_call"), "local provider completed non-TUI input");
    return { mode, exitCode, listener: "closed", localProviderCalls: events.filter((event) => event.event === "provider_call").length };
  } finally { if (exitCode === undefined) proc.kill("SIGKILL"); }
}

export async function runSmoke() {
  const report = { startedAt: new Date().toISOString(), nodeVersion: process.version, platform: process.platform, arch: process.arch,
    realTui: true, realModelCalls: 0, isolation: "temporary HOME + agent/session dirs + local deterministic provider + credential-free environment", checks: [],
    notCovered: ["Browser rendering and mobile layout (separate browser test)", "M2 images/TLS/LAN", "Compaction error callbacks and no-model errors", "Other extensions transforming/consuming input or replacing final messages", "RPC does not support TUI theme reloading or in-session tree navigation; readonly tree/theme snapshots are verified", "Extension disable/import failure/rebind-timeout injection in real TUI (short Hub timeout tested separately)", "Large-history pagination/backpressure performance", "30-minute lease expiry with real elapsed time (short Hub lease tested separately)", "Persistent custom settings concurrency and atomic writes"] };
  const outputDir = resolve(process.env.PI_M0_REPORT_DIR || join(project, "build-artifacts/m3/handoff/m0/smoke"));
  await mkdir(outputDir, { recursive: true });
  let fixture;
  let client;
  const clients = [];
  const check = async (name, fn) => {
    const start = Date.now();
    try { const details = await fn(); report.checks.push({ name, status: "passed", durationMs: Date.now() - start, ...(details ? { details } : {}) }); console.log(`PASS ${name}`); }
    catch (error) { report.checks.push({ name, status: "failed", durationMs: Date.now() - start, error: redact(String(error)) }); throw error; }
  };
  const connect = async (id) => { client = await openClient(fixture.url, id); clients.push(client); return client; };
  try {
    await check("/web refuses an active TUI response and then hands off its saved history when idle", async () => {
      const late = await startFixture({ autoWeb: false });
      let attached;
      try {
        late.tuiCommand("M0_SLOW_LATE_SERVICE");
        await late.waitEvent("provider_call", 0, event => event.input === "M0_SLOW_LATE_SERVICE");
        await pause(200);
        late.write("M0_FOLLOW_BEFORE_HANDOFF\u001b[13;3u");
        late.tuiCommand("/web");
        await pause(250);
        assert.equal(late.url, undefined, "busy transfer creates no listener");
        await late.waitEvent("provider_done", 0, event => event.input === "M0_SLOW_LATE_SERVICE");
        await late.waitEvent("provider_done", 0, event => event.input === "M0_FOLLOW_BEFORE_HANDOFF");
        await pause(100);
        await late.handoffToWeb();
        attached = await openClient(late.url);
        await attached.settled("M0_SLOW_LATE_SERVICE");
        await attached.settled("M0_FOLLOW_BEFORE_HANDOFF");
        assert.deepEqual(attached.protocolErrors, []);
        return { onlyWriter: "RPC child after TUI shutdown" };
      } finally { await attached?.close(); await late.close(); await late.remove(); }
    });
    fixture = await startFixture();
    report.piCli = fixture.cli; report.extension = fixture.extension; report.piVersion = fixture.piVersion;
    await connect();
    await check("print/json/rpc ignore /web configuration flags without listeners or timers", async () => {
      const results = [];
      for (const mode of ["print", "json", "rpc"]) results.push(await checkNonTui(fixture, mode));
      return results;
    });
    await check("saved TUI history is restored by the only RPC writer", async () => {
      await client.settled("M0_HANDOFF_SEED");
      assert.equal(client.snapshot.caps.extensionDialogs, true);
      assert.equal(client.snapshot.caps.promptReceipt, "rpc");
      assert.equal(client.snapshot.caps.terminalDialogs, undefined);
    });
    await check("browser attach during generation restores partial streaming text", async () => {
      await client.command("prompt", { text: "M0_SLOW_FIRST" });
      await waitFor(() => client.assistants("M0_SLOW_FIRST").some(message => textOf(message).length > 32), "partial text");
      const another = await openClient(fixture.url); clients.push(another);
      assert.ok(another.assistants("M0_SLOW_FIRST").some(message => message.status === "streaming"));
      await client.settled("M0_SLOW_FIRST");
    });
    await check("web prompt returns the RPC started disposition and actual transcript", async () => {
      const { ack, frame } = await client.command("prompt", { text: "M0_NORMAL" });
      assert.equal(ack.status, "dispatched");
      const result = await commandResult(client, frame);
      assert.equal(result.status, "completed"); assert.equal(result.value.disposition, "started");
      await client.settled("M0_NORMAL");
    });
    await check("two browser clients submit identical text with distinct transcript identities", async () => {
      const second = await openClient(fixture.url); clients.push(second);
      await Promise.all([client.command("prompt", { text: "M0_TWO_CLIENTS" }), second.command("prompt", { text: "M0_TWO_CLIENTS", mode: "followUp" })]);
      await waitFor(() => client.snapshot.state.idle && client.users("M0_TWO_CLIENTS").length === 2 && client.assistants("M0_TWO_CLIENTS").length === 2, "two independent identical submissions", 20_000);
      assert.equal(new Set(client.users("M0_TWO_CLIENTS").map(message => message.id)).size, 2);
    });
    await check("theme remains a bounded snapshot after TUI shutdown", async () => {
      assert.ok(Object.keys(client.snapshot.theme).length > 0);
      assert.ok(Object.values(client.snapshot.theme).every(value => typeof value === "string" && value.length < 256));
      const reconnected = await openClient(fixture.url); clients.push(reconnected);
      assert.deepEqual(reconnected.snapshot.theme, client.snapshot.theme);
    });
    await check("slow reconnect restores one complete message with the same identity", async () => {
      await client.command("prompt", { text: "M0_SLOW_RECONNECT" });
      await waitFor(() => client.assistants("M0_SLOW_RECONNECT").some(message => textOf(message).length > 48), "partial reply before reconnect");
      const id = client.clientId; const partialId = client.assistants("M0_SLOW_RECONNECT")[0].id;
      await client.close(); await connect(id);
      assert.equal(client.assistants("M0_SLOW_RECONNECT")[0].id, partialId);
      await client.settled("M0_SLOW_RECONNECT");
    });
    await check("followUp and steer preserve queue order and report queued dispositions", async () => {
      await client.command("prompt", { text: "M0_SLOW_QUEUE" });
      await waitFor(() => client.snapshot.state.running, "running before queue");
      for (const [text, mode] of [["M0_FOLLOW", "followUp"], ["M0_STEER", "steer"]]) {
        const operation = await client.command("prompt", { text, mode });
        assert.equal(operation.ack.status, "dispatched");
        assert.equal((await commandResult(client, operation.frame)).value.disposition, "queued");
      }
      await waitFor(() => client.snapshot.state.hasPendingMessages, "queue true");
      await client.settled("M0_FOLLOW");
      const messages = client.snapshot.session.messages;
      assert.ok(messages.findIndex(message => textOf(message) === "M0_STEER") < messages.findIndex(message => textOf(message) === "M0_FOLLOW"));
      assert.equal(client.snapshot.state.hasPendingMessages, false);
    });
    await check("abort interrupts the actual RPC provider and settles", async () => {
      await client.command("prompt", { text: "M0_SLOW_ABORT" });
      await waitFor(() => client.assistants("M0_SLOW_ABORT").some(message => textOf(message).length > 24), "before abort");
      assert.equal((await client.command("abort")).ack.status, "dispatched");
      await fixture.waitEvent("provider_aborted", 0, event => event.input === "M0_SLOW_ABORT");
      await waitFor(() => client.snapshot.state.idle, "idle after abort");
    });
    await check("tool partial survives reconnect and completes", async () => {
      await client.command("prompt", { text: "M0_TOOL" });
      await waitFor(() => client.snapshot.state.tools.some(tool => tool.status === "running" && tool.output), "tool partial");
      const id = client.clientId; await client.close(); await connect(id);
      assert.ok(client.snapshot.state.tools.some(tool => tool.status === "running" && tool.output));
      await client.settled("M0_TOOL");
      assert.ok(client.snapshot.state.tools.some(tool => tool.status === "complete"));
    });
    await check("duplicate commands invoke RPC once and conflicting content is rejected", async () => {
      const { frame, ack } = await client.command("prompt", { text: "M0_DUPLICATE" });
      assert.equal(ack.status, "dispatched"); client.send(frame);
      await waitFor(() => client.frames.filter(item => item.t === "ack" && item.id === frame.id).length >= 2, "duplicate receipt");
      await client.settled("M0_DUPLICATE"); client.send({ ...frame, args: { text: "M0_CONFLICT" } });
      await waitFor(() => client.frames.some(item => item.error?.code === "command_conflict"), "conflict refusal");
      assert.equal((await fixture.events()).filter(event => event.event === "provider_call" && event.input === "M0_DUPLICATE").length, 1);
    });
    await check("RPC extension commands are handled without a model turn", async () => {
      const before = await fixture.eventCount("provider_call");
      const { frame, ack } = await client.command("prompt", { text: "/m0-mark handled" });
      assert.equal(ack.status, "dispatched");
      assert.equal((await commandResult(client, frame)).value.disposition, "handled");
      assert.equal(await fixture.eventCount("provider_call"), before);
    });
    await check("unsupported tree navigation is excluded while readonly native tree remains queryable", async () => {
      assert.ok(!client.snapshot.caps.commands.includes("session_tree"));
      const tree = await workbenchQuery(client, "tree");
      assert.ok(tree.entries.some(entry => entry.role === "user"));
      const commands = await workbenchQuery(client, "commands");
      assert.ok(commands.commands.find(command => command.name === "tree")?.reason);
    });
    await check("built-in slash input is intercepted before it can reach a model", async () => {
      const before = await fixture.eventCount("provider_call");
      const sent = await client.command("prompt", { text: "/model" });
      if (sent.ack.status === "dispatched") assert.equal((await commandResult(client, sent.frame)).status, "failed");
      else assert.equal(sent.ack.status, "rejected");
      assert.equal(await fixture.eventCount("provider_call"), before);
    });
    let originalId;
    await check("clone replaces the session with real persisted history and rejects stale writes", async () => {
      const old = structuredClone(client.snapshot); originalId = old.session.id;
      const operation = await client.command("session_clone");
      assert.equal(operation.ack.status, "dispatched"); assert.equal((await commandResult(client, operation.frame)).status, "completed");
      await waitFor(() => client.snapshot?.session.id !== old.session.id, "clone reset");
      assert.equal((await client.command("abort", {}, old)).ack.error.code, "stale_session");
      assert.equal(client.users("M0_NORMAL").length, 1);
    });
    await check("resume accepts only a discovered ID and refreshes both clients", async () => {
      await workbenchQuery(client, "sessions", { scope: "all" });
      const operation = await client.command("session_switch", { sessionId: originalId });
      assert.equal((await commandResult(client, operation.frame)).status, "completed");
      await waitFor(() => client.snapshot?.session.id === originalId, "resumed original");
      await client.command("prompt", { text: "M0_AFTER_RESUME" }); await client.settled("M0_AFTER_RESUME");
    });
    await check("new session resets transcript and rejects the old session version", async () => {
      const old = structuredClone(client.snapshot); const operation = await client.command("session_new");
      assert.equal((await commandResult(client, operation.frame)).status, "completed");
      await waitFor(() => client.snapshot?.session.id !== old.session.id, "new session reset");
      assert.equal(client.snapshot.session.messages.length, 0);
      assert.equal((await client.command("prompt", { text: "M0_STALE_NEW" }, old)).ack.error.code, "stale_session");
      await client.command("prompt", { text: "M0_NEW_SESSION" }); await client.settled("M0_NEW_SESSION");
    });
    await check("invalid token Origin and Host are rejected before upgrade", async () => {
      for (const override of [{ token: "invalid" }, { origin: "http://evil.invalid" }, { host: "evil.invalid" }]) assert.ok(await rejectedHandshake(fixture.url, override) >= 400);
    });
    await check("observed snapshots and event sequences remain contiguous across replacements", async () => {
      assert.deepEqual(clients.flatMap(item => item.protocolErrors), []);
      return { connections: clients.length, events: clients.reduce((sum, item) => sum + item.frames.filter(frame => frame.t === "event").length, 0) };
    });
    await check("web credential rotation revokes existing viewers and the old URL", async () => {
      const previous = fixture.url;
      const operation = await client.command("access_rotate");
      const completion = await commandResult(client, operation.frame);
      assert.equal(completion.status, "completed");
      await waitFor(() => client.closed, "rotated viewers close");
      assert.ok(await rejectedHandshake(previous) >= 400);
      fixture.url = completion.value.url;
      await connect();
      assert.equal(client.users("M0_NEW_SESSION").length, 1);
    });
    await check("Ctrl+C stops the foreground listener and the RPC writer", async () => {
      fixture.write("\u0003");
      await waitFor(() => fixture.exitCode !== undefined, "foreground host exits");
      assert.equal(fixture.exitCode, 0);
      await waitFor(() => clients.every(item => item.closed), "all viewers closed");
      await assert.rejects(() => fetch(new URL("/healthz", fixture.url)));
    });
    report.status = "passed";
  } catch (error) {
    report.status = "failed"; report.error = redact(error?.stack || String(error));
    console.error(report.error);
  } finally {
    await Promise.all(clients.map((item) => item.close().catch(() => item.socket.terminate())));
    if (fixture) {
      await fixture.close();
      await writeFile(join(outputDir, "terminal.redacted.log"), redact(stripAnsi(fixture.terminal + fixture.processError)));
      await writeFile(join(outputDir, "fixture-events.jsonl"), await readFile(fixture.eventPath, "utf8"));
      await fixture.remove();
    }
    report.finishedAt = new Date().toISOString();
    await writeFile(join(outputDir, "smoke-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = await runSmoke();
  console.log(`Report: ${resolve(process.env.PI_M0_REPORT_DIR || join(project, "build-artifacts/m3/handoff/m0/smoke"), "smoke-report.json")}`);
  process.exitCode = report.status === "passed" ? 0 : 1;
}
