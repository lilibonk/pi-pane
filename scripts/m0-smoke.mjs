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
  provider = "pi-pane-m0", model = "deterministic", packaged = false, loadThemes = false, prepareAgentDir, cli: selectedCli } = {}) {
  if (process.platform === "win32") throw new Error("The M0 real-TUI harness requires a POSIX PTY (macOS or Linux).");
  for (const key of Object.keys(envOverrides)) if (!key.startsWith("PI_M0_") && key !== "PI_PANE_PASSWORD") throw new Error(`Fixture env override is not allowed: ${key}`);
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
  const port = await freePort();
  // An allowlist avoids inheriting real provider/API credentials into the fixture.
  const env = Object.fromEntries(["PATH", "TMPDIR", "LANG", "LC_ALL", "SYSTEMROOT"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  Object.assign(env, { TERM: "xterm-256color", COLORTERM: "truecolor", PI_OFFLINE: "1", NO_COLOR: "1",
    PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: join(agentDir, "sessions"), PI_M0_EVENTS_PATH: eventPath, ...envOverrides });
  const argv = [process.execPath, cli, ...(packaged ? [] : ["--no-extensions"]), "--no-skills", "--no-prompt-templates", ...(loadThemes ? [] : ["--no-themes"]), "--no-builtin-tools",
    "-e", join(project, "tests/fixtures/deterministic-provider.ts"), ...(!disablePane && !packaged ? ["-e", extension] : []),
    ...extraExtensions.flatMap((path) => ["-e", resolve(path)]),
    ...(provider && model ? ["--provider", provider, "--model", model] : []),
    ...(!disablePane ? [...(autoWeb ? ["--web"] : []), "--web-port", String(port), "--web-no-open"] : [])];
  const proc = spawn("python3", [join(project, "scripts/pty-host.py")], { stdio: ["pipe", "pipe", "pipe"] });
  const fixture = { proc, directory, agentDir, cwd, eventPath, port, cli, piVersion: host.version, extension, env, argv, terminal: "", processError: "", exitCode: undefined, url: undefined,
    write(data) { proc.stdin.write(`${JSON.stringify({ type: "write", data })}\n`); },
    command(text) { fixture.write(`${text}\r`); },
    async events() { return (await readFile(eventPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); },
    async eventCount(name) { return (await fixture.events()).filter((event) => event.event === name).length; },
    async waitEvent(name, after = 0, filter = () => true) {
      return waitFor(async () => (await fixture.events()).filter((event) => event.event === name && filter(event))[after], `fixture ${name}`);
    },
    async close() {
      if (proc.exitCode === null) {
        proc.stdin.write(`${JSON.stringify({ type: "terminate" })}\n`);
        await Promise.race([new Promise((resolvePromise) => proc.once("exit", resolvePromise)), pause(5_000)]);
        if (proc.exitCode === null) proc.kill("SIGKILL");
      }
    },
    async remove() { await rm(directory, { recursive: true, force: true }); },
  };
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
    } else if (item.type === "exit") fixture.exitCode = item.code;
  });
  proc.stdin.write(`${JSON.stringify({ argv, env, cwd })}\n`);
  try {
    if (autoWeb && !disablePane) await waitFor(() => {
      if (fixture.exitCode !== undefined) throw new Error(`pi exited at startup (${fixture.exitCode}): ${redact(stripAnsi(fixture.terminal + fixture.processError)).slice(-6000)}`);
      return fixture.url;
    }, "TUI /web startup URL", 30_000);
    await fixture.waitEvent("session_start");
    return fixture;
  } catch (error) {
    const diagnostic = redact(stripAnsi(fixture.terminal + fixture.processError)).slice(-6000);
    await fixture.close(); await fixture.remove();
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${diagnostic}`);
  }
}

export async function openClient(url, clientId) {
  const parsed = new URL(url);
  const token = new URLSearchParams(parsed.hash.slice(1)).get("t");
  const socket = new WebSocket(`ws://${parsed.host}/ws`, ["pi-pane.v1", `pi-pane.bearer.${token}`], { origin: parsed.origin });
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
  await waitFor(() => client.snapshot && client.clientId, "authenticated snapshot");
  return client;
}

async function rejectedHandshake(url, overrides = {}) {
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
  argv[argv.indexOf("--web-port") + 1] = String(port);
  argv.push("--mode", mode === "print" ? "text" : mode);
  if (mode !== "rpc") argv.push("--print", "M0_NONTUI");
  const proc = spawn(process.execPath, argv, { cwd, env: { ...fixture.env, PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: join(agentDir, "sessions"), PI_M0_EVENTS_PATH: eventsPath }, stdio: ["pipe", "pipe", "pipe"] });
  let output = ""; let error = ""; let exitCode;
  proc.stdout.on("data", (data) => { output += data; }); proc.stderr.on("data", (data) => { error += data; });
  proc.once("exit", (code) => { exitCode = code; });
  // RPC receives a benign read-only request, then EOF. The print modes receive CLI text.
  proc.stdin.end(mode === "rpc" ? `${JSON.stringify({ id: "m0-read", type: "get_state" })}\n` : "");
  try {
    await waitFor(() => exitCode !== undefined, `${mode} mode exits without a listener/timer`, 15_000);
    assert.equal(exitCode, 0, `${mode} exit: ${redact(error).slice(-2000)}`);
    assert.match(error + output, /pi-pane[^\n]*(?:tui|interactive)|(?:tui|interactive)[^\n]*pi-pane/i, `${mode} reports unsupported mode`);
    await assert.rejects(() => fetch(`http://127.0.0.1:${port}/healthz`));
    const events = (await readFile(eventsPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.event === "session_start"), "real host initialized extensions");
    if (mode !== "rpc") assert.ok(events.some((event) => event.event === "provider_call"), "local provider completed non-TUI input");
    return { mode, exitCode, listener: "closed", localProviderCalls: events.filter((event) => event.event === "provider_call").length };
  } finally { if (exitCode === undefined) proc.kill("SIGKILL"); }
}

export async function runSmoke() {
  const report = { startedAt: new Date().toISOString(), nodeVersion: process.version, platform: process.platform, arch: process.arch,
    realTui: true, realModelCalls: 0, isolation: "PI_CODING_AGENT_DIR + empty cwd + PI_OFFLINE + credential-free environment", checks: [],
    notCovered: ["Browser rendering and mobile layout (separate browser test)", "M2 images/TLS/LAN", "Compaction error callbacks and no-model errors", "Other extensions transforming/consuming input or replacing final messages", "Same-name theme file reload and terminal system color changes", "Extension disable/import failure/rebind-timeout injection in real TUI (short Hub timeout tested separately)", "Large-history pagination/backpressure performance", "30-minute lease expiry with real elapsed time (short Hub lease tested separately)", "Persistent custom settings concurrency and atomic writes"] };
  const outputDir = resolve(process.env.PI_M0_REPORT_DIR || join(project, "build-artifacts/m0"));
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
    await check("first /web started from TUI in the middle of an existing response", async () => {
      const late = await startFixture({ autoWeb: false });
      let attached;
      try {
        late.command("M0_SLOW_LATE_SERVICE");
        await late.waitEvent("provider_call", 0, (event) => event.input === "M0_SLOW_LATE_SERVICE");
        await pause(300);
        late.command(`/web --no-open --port ${late.port}`);
        await waitFor(() => late.url, "first /web URL during streaming");
        attached = await openClient(late.url);
        const active = attached.assistants("M0_SLOW_LATE_SERVICE")[0];
        assert.ok(active && active.status === "streaming" && textOf(active).length > 10, "Bridge collected text before Hub startup");
        await attached.settled("M0_SLOW_LATE_SERVICE");
        assert.deepEqual(attached.protocolErrors, []);
        return { restoredCharacters: textOf(active).length };
      } finally { await attached?.close(); await late.close(); await late.remove(); }
    });
    fixture = await startFixture();
    report.piCli = fixture.cli;
    report.extension = fixture.extension;
    report.piVersion = fixture.piVersion;
    await check("print/json/rpc reject --web without leaving sockets or timers", async () => {
      const results = [];
      for (const mode of ["print", "json", "rpc"]) results.push(await checkNonTui(fixture, mode));
      return results;
    });
    await check("real TUI input; first browser attach during generation", async () => {
      fixture.command("M0_SLOW_FIRST");
      await fixture.waitEvent("provider_call", 0, (event) => event.input === "M0_SLOW_FIRST");
      await pause(250);
      await connect();
      const active = client.assistants("M0_SLOW_FIRST")[0];
      assert.ok(active && active.status === "streaming" && textOf(active).length > 10, "snapshot restores partial assistant text");
      await client.settled("M0_SLOW_FIRST");
      return { restoredCharacters: textOf(active).length };
    });
    await check("web prompt produces actual transcript messages", async () => {
      const { ack } = await client.command("prompt", { text: "M0_NORMAL" });
      assert.equal(ack.status, "dispatched"); await client.settled("M0_NORMAL");
    });
    await check("web submission preserves an unsent real TUI draft", async () => {
      fixture.write("M0_UNSENT_DRAFT"); await pause(80);
      await client.command("prompt", { text: "M0_WHILE_TUI_DRAFT" }); await client.settled("M0_WHILE_TUI_DRAFT");
      fixture.write("\r"); await client.settled("M0_UNSENT_DRAFT");
    });
    await check("two live browser clients submit identical text without merging messages", async () => {
      const first = client; const second = await openClient(fixture.url); clients.push(second);
      try {
        await Promise.all([first.command("prompt", { text: "M0_TWO_CLIENTS" }), second.command("prompt", { text: "M0_TWO_CLIENTS" })]);
        await waitFor(() => first.snapshot.state.idle && first.users("M0_TWO_CLIENTS").length === 2 && first.assistants("M0_TWO_CLIENTS").length === 2, "two distinct identical submissions", 20_000);
        assert.equal(new Set(first.users("M0_TWO_CLIENTS").map((message) => message.id)).size, 2);
        assert.equal(second.users("M0_TWO_CLIENTS").length, 2);
      } finally { await second.close(); }
    });
    await check("public TUI theme change reaches the browser without reconnect", async () => {
      const target = client.snapshot.theme["--bg"] === "#f5f5f4" ? "dark" : "light";
      const before = client.snapshot.theme["--bg"]; const start = Date.now();
      fixture.command(`/m0-theme ${target}`);
      const result = await fixture.waitEvent("theme_fixture_result"); assert.equal(result.success, true);
      await waitFor(() => client.snapshot.theme["--bg"] !== before, "theme update", 2_000);
      return { latencyMs: Date.now() - start, theme: target };
    });
    await check("reconnect restores active message without duplicate identity", async () => {
      await client.command("prompt", { text: "M0_SLOW_RECONNECT" });
      await waitFor(() => client.assistants("M0_SLOW_RECONNECT").some((message) => textOf(message).length > 48), "partial reply before reconnect");
      const id = client.clientId;
      const partialId = client.assistants("M0_SLOW_RECONNECT")[0].id;
      await client.close(); await connect(id);
      assert.equal(client.assistants("M0_SLOW_RECONNECT")[0].id, partialId);
      await client.settled("M0_SLOW_RECONNECT");
    });
    await check("followUp and steer queue via real host and keep their order", async () => {
      await client.command("prompt", { text: "M0_SLOW_QUEUE" });
      await waitFor(() => client.snapshot.state.running, "running before queued input");
      assert.equal((await client.command("prompt", { text: "M0_FOLLOW", mode: "followUp" })).ack.status, "dispatched");
      assert.equal((await client.command("prompt", { text: "M0_STEER", mode: "steer" })).ack.status, "dispatched");
      await waitFor(() => client.snapshot.state.hasPendingMessages, "queue boolean becomes true");
      await client.settled("M0_FOLLOW");
      const messages = client.snapshot.session.messages;
      assert.ok(messages.findIndex((message) => textOf(message) === "M0_STEER") < messages.findIndex((message) => textOf(message) === "M0_FOLLOW"));
      assert.equal(client.users("M0_STEER").length, 1);
      assert.equal(client.snapshot.state.hasPendingMessages, false);
    });
    await check("abort interrupts deterministic provider and settles real TUI", async () => {
      await client.command("prompt", { text: "M0_SLOW_ABORT" });
      await waitFor(() => client.assistants("M0_SLOW_ABORT").some((message) => textOf(message).length > 24), "stream before abort");
      assert.equal((await client.command("abort")).ack.status, "dispatched");
      await fixture.waitEvent("provider_aborted", 0, (event) => event.input === "M0_SLOW_ABORT");
      await waitFor(() => client.snapshot.state.idle, "idle after abort");
    });
    await check("tool partial survives reconnect and completes", async () => {
      await client.command("prompt", { text: "M0_TOOL" });
      await waitFor(() => client.snapshot.state.tools.some((tool) => tool.status === "running" && tool.output), "streaming tool partial");
      const id = client.clientId; await client.close(); await connect(id);
      assert.ok(client.snapshot.state.tools.some((tool) => tool.status === "running" && tool.output));
      await client.settled("M0_TOOL");
      assert.ok(client.snapshot.state.tools.some((tool) => tool.status === "complete"));
    });
    await check("duplicate commands invoke host once; conflicting content rejected", async () => {
      const { frame, ack } = await client.command("prompt", { text: "M0_DUPLICATE" });
      assert.equal(ack.status, "dispatched"); client.send(frame);
      await waitFor(() => client.frames.filter((item) => item.t === "ack" && item.id === frame.id).length >= 2, "duplicate receipt");
      await client.settled("M0_DUPLICATE");
      client.send({ ...frame, args: { text: "M0_CONFLICT" } });
      await waitFor(() => client.frames.some((item) => (item.t === "error" || (item.t === "ack" && item.id === frame.id)) && item.error?.code === "command_conflict"), "conflict rejection");
      assert.equal((await fixture.events()).filter((event) => event.event === "provider_call" && event.input === "M0_DUPLICATE").length, 1);
      assert.equal(client.users("M0_CONFLICT").length, 0);
    });
    await check("web slash input does not execute fixture extension command", async () => {
      const before = await fixture.eventCount("tree_fixture_result");
      await client.command("prompt", { text: "/m0-tree cancel" });
      await client.settled("/m0-tree cancel");
      assert.equal(await fixture.eventCount("tree_fixture_result"), before);
    });
    await check("tree cancellation releases barrier; real tree success resets branch", async () => {
      const before = await fixture.eventCount("tree_fixture_result");
      const beforeCancel = structuredClone(client.snapshot);
      fixture.command("/m0-tree cancel");
      const cancelled = await fixture.waitEvent("tree_fixture_result", before);
      assert.equal(cancelled.cancelled, true);
      await pause(600);
      await client.command("prompt", { text: "M0_AFTER_CANCEL" }); await client.settled("M0_AFTER_CANCEL");
      assert.equal(client.snapshot.session.branchRevision, beforeCancel.session.branchRevision);
      const oldVersion = structuredClone(client.snapshot);
      fixture.command("/m0-tree");
      await waitFor(() => client.snapshot && client.snapshot.epoch !== oldVersion.epoch, "tree reset snapshot");
      assert.ok(client.snapshot.session.branchRevision > oldVersion.session.branchRevision);
      assert.ok(client.snapshot.session.messages.length < oldVersion.session.messages.length);
      const { ack } = await client.command("abort", {}, oldVersion);
      assert.equal(ack.status, "rejected"); assert.equal(ack.error.code, "stale_session");
    });
    await check("reload keeps socket, resets epoch and rejects stale command", async () => {
      const oldVersion = structuredClone(client.snapshot);
      fixture.command("/reload");
      await waitFor(() => client.snapshot && client.snapshot.epoch !== oldVersion.epoch, "reload snapshot");
      assert.equal(client.closed, false); assert.equal(client.snapshot.session.id, oldVersion.session.id);
      const { ack } = await client.command("prompt", { text: "M0_STALE_RELOAD" }, oldVersion);
      assert.equal(ack.error.code, "stale_session");
      await client.command("prompt", { text: "M0_AFTER_RELOAD" }); await client.settled("M0_AFTER_RELOAD");
    });
    await check("fork and resume use real runtime replacement and keep the browser connected", async () => {
      const original = structuredClone(client.snapshot);
      const sessionEvent = (await fixture.events()).filter((event) => event.event === "session_start").at(-1);
      assert.ok(sessionEvent?.sessionFile, "fixture history is persisted in the isolated directory");
      fixture.command("/m0-fork");
      await waitFor(() => client.snapshot && client.snapshot.session.id !== original.session.id, "fork snapshot");
      assert.equal(client.closed, false);
      assert.equal((await client.command("abort", {}, original)).ack.error.code, "stale_session");
      await client.command("prompt", { text: "M0_IN_FORK" }); await client.settled("M0_IN_FORK");
      fixture.command(`/m0-resume ${sessionEvent.sessionFile}`);
      await waitFor(() => client.snapshot && client.snapshot.session.id === original.session.id, "resume original session snapshot");
      assert.equal(client.closed, false); assert.equal(client.users("M0_IN_FORK").length, 0);
      assert.equal(client.users("M0_AFTER_RELOAD").length, 1);
      await client.command("prompt", { text: "M0_AFTER_RESUME" }); await client.settled("M0_AFTER_RESUME");
    });
    await check("new session resets transcript and rejects old-session prompt", async () => {
      const oldVersion = structuredClone(client.snapshot); fixture.command("/new");
      await waitFor(() => client.snapshot && client.snapshot.session.id !== oldVersion.session.id, "new session snapshot");
      assert.equal(client.snapshot.session.messages.length, 0);
      const { ack } = await client.command("prompt", { text: "M0_STALE_NEW" }, oldVersion);
      assert.equal(ack.error.code, "stale_session");
      await client.command("prompt", { text: "M0_NEW_SESSION" }); await client.settled("M0_NEW_SESSION");
    });
    await check("invalid token, Origin and Host are rejected before upgrade", async () => {
      for (const override of [{ token: "invalid" }, { origin: "http://evil.invalid" }, { host: "evil.invalid" }]) {
        const status = await rejectedHandshake(fixture.url, override); assert.ok(status >= 400, `HTTP refusal ${status}`);
      }
    });
    await check("stop revokes connection; reload does not reapply --web; explicit start works", async () => {
      const oldUrl = fixture.url;
      fixture.command("/web stop"); await waitFor(() => client.closed, "connection closed on stop");
      const starts = await fixture.eventCount("session_start"); fixture.command("/reload");
      await fixture.waitEvent("session_start", starts); await pause(700);
      await assert.rejects(() => fetch(`http://127.0.0.1:${fixture.port}/healthz`), "stopped listener remains closed after reload");
      fixture.command(`/web --no-open --port ${fixture.port}`);
      await waitFor(() => fixture.url !== oldUrl, "new token after explicit restart");
      await connect(); await client.command("prompt", { text: "M0_RESTART" }); await client.settled("M0_RESTART");
    });
    await check("rotate closes existing sockets and rejects old token", async () => {
      const oldUrl = fixture.url; fixture.command("/web --rotate");
      await waitFor(() => client.closed && fixture.url !== oldUrl, "rotation closes socket and publishes fresh URL");
      assert.ok(await rejectedHandshake(oldUrl) >= 400);
      await connect(); assert.ok(client.snapshot.session.messages.length > 0);
    });
    await check("observed snapshots and broadcast sequence numbers are contiguous", async () => {
      assert.deepEqual(clients.flatMap((item) => item.protocolErrors), []);
      return { connections: clients.length, events: clients.reduce((sum, item) => sum + item.frames.filter((frame) => frame.t === "event").length, 0) };
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
  console.log(`Report: ${resolve(process.env.PI_M0_REPORT_DIR || join(project, "build-artifacts/m0"), "smoke-report.json")}`);
  process.exitCode = report.status === "passed" ? 0 : 1;
}
