#!/usr/bin/env node
/** Real pi TUI performance/theme evidence using only isolated deterministic local fixtures. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { cpus, freemem, platform, release, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { chromium } from "playwright";
import { startFixture, waitFor } from "./m0-smoke.mjs";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputBase = resolve(process.env.PI_M0_REPORT_DIR || join(project, "build-artifacts/m0"));
const performanceDir = join(outputBase, "performance");
const themeDir = join(outputBase, "theme");
await mkdir(performanceDir, { recursive: true }); await mkdir(themeDir, { recursive: true });
const perfFixture = join(project, "tests/fixtures/performance-provider.ts");
const repetitions = process.argv.includes("--quick") ? 1 : 3;
const themeOnly = process.argv.includes("--theme-only");
const perfOnly = process.argv.includes("--performance-only");
const overloadOnly = process.argv.includes("--overload-only");
const skipOverload = process.argv.includes("--skip-overload");
const redact = value => String(value).replace(/#t=[A-Za-z0-9_-]+/g, "#t=[REDACTED]").replace(/pi-pane\.bearer\.[A-Za-z0-9_-]+/g, "pi-pane.bearer.[REDACTED]");
const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
const environment = {
  measuredAt: new Date().toISOString(), node: process.version, os: `${platform()} ${release()}`, arch: process.arch,
  cpuModel: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), freeMemoryBytesAtStart: freemem(),
  piVersion: JSON.parse(await readFile(join(project, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8")).version,
  terminal: "real POSIX PTY, 48×180, TERM=xterm-256color, COLORTERM=truecolor; output continuously drained by the same Python/Node harness",
  provider: "local pi-pane-m0-perf deterministic stream; zero network/model calls; credential-free environment",
  sourceSha256: Object.fromEntries(await Promise.all(["src/extension/index.ts", "src/extension/bridge.ts", "src/extension/hub.ts", "src/protocol/index.ts", "tests/fixtures/performance-provider.ts", "scripts/m0-performance.mjs"].map(async name => [name, createHash("sha256").update(await readFile(join(project, name))).digest("hex")]))),
};
const perfReport = {
  scope: "M0 bounded preview and host overhead; not M1 full-history/P95 acceptance", environment, repetitions,
  workload: { kind: "text", chunks: 256, chunkBytes: 1024, yieldMs: 1, outputBytes: 262144 },
  controls: ["Identical provider, PTY drain, evidence writes and 20 ms in-process sampling in all configurations", "Warmup before measurement; generation duration recorded in the provider separately from TUI start/finish commands", "No explicit GC; process RSS/heap includes the pi host's full transcript and fixture telemetry", "Three rounds summarize medians, not a reliable tail-latency or significance estimate"],
  limits: { messageCharacters: 32768, messageWindow: 200, messageWindowBytes: 524288, toolsMax: 64,
    toolValuePreviewCharacters: 2048, snapshotFrameBytes: 1048576, serverSendBufferBytes: 2097152, clientLeases: 8 },
  configurations: [], checks: [], notCovered: ["M1 paged full history and 1,000-message A6 benchmark", "OS/browser network process memory", "Long-term production leak soak beyond the repeated bounded-window stress", "Remote networks/LAN or TLS"],
  acceptance: { mandatory: ["Reading clients retain contiguous sequence numbers and remain connected", "Paused peer is closed specifically for slow_client and server buffer stays at the declared bound", "TUI settles during paused-peer stress", "Huge results and long history keep explicit bounded previews"],
    exploratoryRegressionGuard: "For the identical 256-KiB case, median generation overhead ≤25% and event-loop p95 increase ≤10 ms vs no-pane; these are M0 local engineering guards, not design A6 or statistical confidence claims" },
};
const themeReport = { scope: "Q3 real-TUI/public-API theme synchronization", environment, checks: [], publicAPI: "ctx.ui.setTheme, ctx.ui.theme.colors, ctx.ui.theme.appearance",
  notCovered: [
    "System-theme color reports and appearance notifications are deterministic protocol replies delivered through a real PTY; desktop OS appearance switching and an actual terminal emulator's preference UI were not exercised.",
    "Page background follows the host theme's appearance-derived M0 palette; exact reproduction of the terminal's reported OSC background color is not implemented or claimed.",
    "When the terminal supplies no OSC default colors, empty color tokens use pi's documented appearance-based guessed defaults; actual terminal pixels were not measured.",
  ] };
let currentFixture;
let currentClients = [];
let browser;
async function fixture(options = {}) {
  return startFixture({ extraExtensions: [perfFixture], provider: "pi-pane-m0-perf", model: "deterministic",
    envOverrides: { PI_M0_PERF_OUTPUT_DIR: performanceDir }, ...options });
}
async function cleanupFixture(item, clients = []) {
  await Promise.all(clients.map(client => client.close().catch(() => client.socket.terminate())));
  if (item) {
    await item.close();
    await item.remove();
  }
}
function statistics(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], max: sorted.at(-1), mean: values.reduce((a, b) => a + b, 0) / values.length };
}
async function pressureClient(url) {
  const parsed = new URL(url);
  const token = new URLSearchParams(parsed.hash.slice(1)).get("t");
  const socket = new WebSocket(`ws://${parsed.host}/ws`, ["pi-pane.v1", `pi-pane.bearer.${token}`], { origin: parsed.origin });
  const client = { socket, snapshot: undefined, clientId: undefined, seq: 0, epoch: undefined, closed: false,
    closeCode: undefined, closeReason: undefined, protocolErrors: [], errors: [], snapshots: 0,
    stats: { frames: 0, bytes: 0, events: 0, maxFrameBytes: 0, toolUpdates: 0, maxToolValueCharacters: 0 },
    send(frame) { socket.send(JSON.stringify(frame)); },
    async resync() {
      const before = client.snapshots; const started = performance.now();
      client.send({ t: "resync" });
      await waitFor(() => client.snapshots > before, "bounded snapshot response");
      return performance.now() - started;
    },
    async close() {
      if (client.closed) return;
      socket.resume(); socket.close();
      await waitFor(() => client.closed, "performance client closed", 5000);
    },
  };
  socket.on("error", () => {});
  socket.on("close", (code, reason) => { client.closed = true; client.closeCode = code; client.closeReason = reason.toString(); });
  socket.on("message", data => {
    client.stats.frames++; client.stats.bytes += data.length; client.stats.maxFrameBytes = Math.max(client.stats.maxFrameBytes, data.length);
    const frame = JSON.parse(data.toString());
    if (frame.t === "welcome") client.clientId = frame.clientId;
    if (frame.t === "snapshot") { client.snapshot = frame; client.seq = frame.seq; client.epoch = frame.epoch; client.snapshots++; }
    if (frame.t === "session_reset") { client.snapshot = undefined; client.epoch = frame.epoch; client.seq = 0; }
    if (frame.t === "error") client.errors.push(frame.error);
    if (frame.t !== "event") return;
    client.stats.events++;
    if (frame.epoch !== client.epoch || frame.seq !== client.seq + 1) client.protocolErrors.push({ expectedSeq: client.seq + 1, actualSeq: frame.seq });
    client.seq = frame.seq;
    const state = client.snapshot;
    if (!state) return;
    const event = frame.ev;
    if (event.message) {
      const index = state.session.messages.findIndex(message => message.id === event.message.id);
      if (index === -1) state.session.messages.push(event.message); else state.session.messages[index] = event.message;
      state.session.messages = state.session.messages.slice(-200);
    }
    if (event.tool) {
      client.stats.toolUpdates++;
      client.stats.maxToolValueCharacters = Math.max(client.stats.maxToolValueCharacters, JSON.stringify(event.tool.partial ?? event.tool.result ?? null).length);
      const index = state.state.tools.findIndex(tool => tool.id === event.tool.id);
      if (index === -1) state.state.tools.push(event.tool); else state.state.tools[index] = event.tool;
    }
    if (event.type === "agent_state") state.state = event.state;
    if (event.type === "theme") state.theme = event.theme;
  });
  await new Promise((accept, reject) => { socket.once("open", accept); socket.once("error", reject); });
  client.send({ t: "hello" });
  await waitFor(() => client.snapshot && client.clientId, "performance client initialized");
  return client;
}
async function perform(item, spec, timeout = 120000) {
  const settled = await item.eventCount("agent_settled");
  item.command(`PERF ${JSON.stringify(spec)}`);
  await item.waitEvent("perf_provider_started", 0, event => JSON.stringify(event.spec) === JSON.stringify(spec));
  await waitFor(async () => await item.eventCount("agent_settled") > settled, "performance generation settles", timeout);
}
async function measure(item, name, action) {
  item.command(`/m0-perf-start ${name}`);
  await item.waitEvent("perf_meter_started", 0, event => event.name === name);
  await action();
  item.command("/m0-perf-finish");
  await item.waitEvent("perf_meter_finished", 0, event => event.name === name);
  return JSON.parse(await readFile(join(performanceDir, `${name}.json`), "utf8"));
}
async function check(report, name, action) {
  const started = performance.now();
  try {
    const details = await action();
    report.checks.push({ name, status: "passed", durationMs: performance.now() - started, details });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.checks.push({ name, status: "failed", durationMs: performance.now() - started, error: redact(error?.stack || error) });
    throw error;
  }
}

try {
  if (!themeOnly) {
    if (!overloadOnly) {
    for (const configuration of [
      { name: "no-pane", disablePane: true, autoWeb: false, clients: 0 },
      { name: "bridge-only", disablePane: false, autoWeb: false, clients: 0 },
      { name: "hub-no-viewers", disablePane: false, autoWeb: true, clients: 0 },
      { name: "four-viewers", disablePane: false, autoWeb: true, clients: 4 },
      { name: "eight-viewers", disablePane: false, autoWeb: true, clients: 8 },
    ]) {
      currentFixture = await fixture(configuration);
      currentClients = [];
      for (let index = 0; index < configuration.clients; index++) currentClients.push(await pressureClient(currentFixture.url));
      await perform(currentFixture, { kind: "text", chunks: 1, chunkBytes: 32, yieldMs: 1 });
      const runs = [];
      for (let round = 0; round < repetitions; round++) {
        const before = currentClients.map(client => structuredClone(client.stats));
        const name = `${configuration.name}-${round + 1}`;
        const telemetry = await measure(currentFixture, name, () => perform(currentFixture, perfReport.workload));
        const provider = telemetry.providers.find(item => !item.useTool && item.bytes === perfReport.workload.outputBytes);
        assert.ok(provider, "same fixed-output workload completed");
        assert.equal(provider.stopReason, "stop");
        const wire = currentClients.map((client, index) => ({ frames: client.stats.frames - before[index].frames,
          events: client.stats.events - before[index].events, bytes: client.stats.bytes - before[index].bytes,
          maxFrameBytes: client.stats.maxFrameBytes, closed: client.closed }));
        assert.deepEqual(currentClients.flatMap(client => client.protocolErrors), []);
        assert.ok(currentClients.every(client => !client.closed), "reading clients stay connected");
        runs.push({ name, providerDurationMs: provider.durationMs, generationBytesPerSecond: provider.bytes / (provider.durationMs / 1000),
          cpuMicroseconds: telemetry.cpuMicroseconds, eventLoopDelayMs: telemetry.eventLoopDelayMs,
          initialRssBytes: telemetry.initialMemory.rss, peakRssBytes: Math.max(...telemetry.samples.map(sample => sample.memory.rss)),
          finalRssBytes: telemetry.finalMemory.rss, finalHeapUsedBytes: telemetry.finalMemory.heapUsed, wire,
          rawTelemetry: `${name}.json` });
        console.log(`MEASURE ${name}: ${Math.round(provider.durationMs)} ms`);
      }
      perfReport.configurations.push({ ...configuration, runs,
        providerDurationMs: statistics(runs.map(run => run.providerDurationMs)),
        bytesPerSecond: statistics(runs.map(run => run.generationBytesPerSecond)),
        eventLoopDelayP95Ms: statistics(runs.map(run => run.eventLoopDelayMs.p95)),
        peakRssBytes: statistics(runs.map(run => run.peakRssBytes)) });
      await cleanupFixture(currentFixture, currentClients); currentFixture = undefined; currentClients = [];
    }
    const baseline = perfReport.configurations[0].providerDurationMs.median;
    for (const configuration of perfReport.configurations) configuration.medianDurationVsNoPane = configuration.providerDurationMs.median / baseline;
    }

    if (!process.argv.includes("--quick") && !skipOverload) {
      const diagnostics = [];
      for (const [name, disablePane, viewers] of [["overload-no-pane", true, 0], ["overload-four-viewers", false, 4]]) {
        currentFixture = await fixture({ disablePane, autoWeb: !disablePane });
        currentClients = [];
        for (let index = 0; index < viewers; index++) currentClients.push(await pressureClient(currentFixture.url));
        currentFixture.command(`/m0-perf-start ${name}`);
        await currentFixture.waitEvent("perf_meter_started", 0, event => event.name === name);
        let completed = false;
        try { await perform(currentFixture, { kind: "text", chunks: 4096, chunkBytes: 1024, yieldMs: 0 }, 20_000); completed = true; }
        catch (error) { if (!String(error).includes("Timed out: performance generation settles")) throw error; }
        currentFixture.command(completed ? "/m0-perf-finish" : "/m0-perf-capture");
        await currentFixture.waitEvent("perf_meter_finished", 0, event => event.name === name);
        const telemetry = JSON.parse(await readFile(join(performanceDir, `${name}.json`), "utf8"));
        const profile = JSON.parse(await readFile(join(performanceDir, `${name}.cpuprofile`), "utf8"));
        const timeByNode = new Map();
        for (let index = 0; index < profile.samples.length; index++) timeByNode.set(profile.samples[index], (timeByNode.get(profile.samples[index]) ?? 0) + (profile.timeDeltas[index] ?? 0));
        const functions = profile.nodes.map(node => ({ functionName: node.callFrame.functionName, url: node.callFrame.url,
          ownSampleMilliseconds: (timeByNode.get(node.id) ?? 0) / 1000 })).sort((a, b) => b.ownSampleMilliseconds - a.ownSampleMilliseconds).slice(0, 18);
        diagnostics.push({ name, disablePane, viewers, requestedBytes: 4 * 1024 * 1024, updates: 4096, observationLimitMs: 20_000,
          completed, progressAtCapture: telemetry.progress, actualObservationMs: telemetry.durationMs,
          cpuMicroseconds: telemetry.cpuMicroseconds, eventLoopDelayMs: telemetry.eventLoopDelayMs,
          peakRssBytes: Math.max(...telemetry.samples.map(sample => sample.memory.rss)), functions,
          rawTelemetry: `${name}.json`, cpuProfile: `${name}.cpuprofile` });
        console.log(`DIAGNOSTIC ${name}: completed=${completed}; bytes=${telemetry.progress?.bytes}`);
        await writeFile(join(performanceDir, `${name}-fixture-events.jsonl`), await readFile(currentFixture.eventPath, "utf8"));
        await cleanupFixture(currentFixture, currentClients); currentFixture = undefined; currentClients = [];
      }
      perfReport.overloadDiagnostics = diagnostics;
      perfReport.overloadScope = "Prior 4-MiB/4096-update four-viewer run did not settle in 120 s. These matched, CPU-profiled 20 s observations isolate host/fixture processing from pane cost; noncompletion is retained as a limitation and never counted as a pressure-test PASS.";
      await writeFile(join(performanceDir, "overload-diagnostic-summary.json"), `${JSON.stringify({ diagnostics, scope: perfReport.overloadScope }, null, 2)}\n`);
    }
    else if (skipOverload) {
      try { perfReport.priorOverloadDiagnostic = JSON.parse(await readFile(join(performanceDir, "overload-diagnostic-summary.json"), "utf8")); }
      catch { perfReport.notCovered.push("Matched 4-MiB overload diagnosis was skipped and no prior evidence was available."); }
    }

    if (!overloadOnly) {
    currentFixture = await fixture();
    currentClients = [];
    for (let index = 0; index < 4; index++) currentClients.push(await pressureClient(currentFixture.url));
    await check(perfReport, "paused real WebSocket is recycled at the send-buffer high-water mark while reading clients and TUI settle", async () => {
      const slow = currentClients[3];
      const historyBefore = await currentFixture.eventCount("perf_history_added");
      currentFixture.command("/m0-perf-history 220 2048");
      await currentFixture.waitEvent("perf_history_added", historyBefore);
      await slow.resync();
      slow.socket.pause();
      const telemetry = await measure(currentFixture, "slow-client", async () => {
        const generation = perform(currentFixture, perfReport.workload);
        for (let index = 0; index < 48; index++) {
          if (slow.closed) break;
          slow.send({ t: "resync" });
          await sleep(2);
        }
        await generation;
        await sleep(1200);
      });
      slow.socket.resume();
      await waitFor(() => slow.closed, "nonreading peer recycled", 5000);
      assert.ok(telemetry.socketCloseRequests.some(request => request.code === 1013 && request.reason === "slow_client"), "server explicitly closes for send-buffer pressure, not heartbeat/rate limit");
      assert.ok(currentClients.slice(0, 3).every(client => !client.closed), "reading clients remain connected");
      assert.ok(telemetry.samples.some(sample => sample.authenticatedConnections === 3), "server authenticated count drops to three");
      assert.equal(telemetry.idleAtFinish, true);
      assert.deepEqual(currentClients.slice(0, 3).flatMap(client => client.protocolErrors), []);
      assert.ok(telemetry.samples.every(sample => sample.maxBufferedBytes <= perfReport.limits.serverSendBufferBytes + 65536), "server buffers stay bounded at the M0 limit plus one sampled frame");
      return { clientCloseCode: slow.closeCode, clientCloseReason: slow.closeReason, serverCloseEvents: telemetry.socketCloses,
        serverCloseRequests: telemetry.socketCloseRequests,
        peakBufferedBytes: Math.max(...telemetry.samples.map(sample => sample.maxBufferedBytes)),
        peakRssBytes: Math.max(...telemetry.samples.map(sample => sample.memory.rss)),
        providerDurationMs: telemetry.providers[0]?.durationMs, remainingClients: 3, pressure: "48 legal resync requests for a ~400-KiB bounded snapshot while TCP reads are paused; fixed 256-KiB provider runs concurrently",
        transport: "Node ws.pause() stops TCP receive consumption of the same browser wire protocol; not a browser network-process freeze", rawTelemetry: "slow-client.json" };
    });
    await check(perfReport, "two-MiB tool partials and final result are bounded on the wire with explicit previews", async () => {
      const telemetry = await measure(currentFixture, "large-tool-partial", () => perform(currentFixture, { kind: "tool", partialBytes: 2 * 1024 * 1024, updates: 16, yieldMs: 20 }));
      const reader = currentClients[0];
      await reader.resync();
      const tool = reader.snapshot.state.tools.find(tool => tool.name === "m0_perf_tool");
      assert.ok(tool && tool.status === "complete");
      assert.equal(tool.result.truncated, true);
      assert.ok(tool.result.preview.length <= 2048);
      assert.ok(reader.stats.maxToolValueCharacters < 2200);
      assert.ok(reader.stats.maxFrameBytes <= perfReport.limits.snapshotFrameBytes);
      return { inputPartialBytes: 2 * 1024 * 1024, updates: 16, toolWireValueMaxCharacters: reader.stats.maxToolValueCharacters,
        finalPreviewCharacters: tool.result.preview.length, peakRssBytes: Math.max(...telemetry.samples.map(sample => sample.memory.rss)),
        toolExecutionDurationMs: telemetry.tools[0]?.durationMs, measurementDurationMs: telemetry.durationMs,
        eventLoopDelayMs: telemetry.eventLoopDelayMs, rawTelemetry: "large-tool-partial.json" };
    });
    await check(perfReport, "1,000 persisted history messages retain only the advertised 200-message/512-KiB M0 window", async () => {
      const reader = currentClients[0];
      const inspections = [];
      for (let batch = 0; batch < 4; batch++) {
        const before = await currentFixture.eventCount("perf_history_added");
        currentFixture.command("/m0-perf-history 250 2048");
        await currentFixture.waitEvent("perf_history_added", before);
        await reader.resync();
        const inspectBefore = await currentFixture.eventCount("perf_inspect");
        currentFixture.command("/m0-perf-inspect");
        const inspection = await currentFixture.waitEvent("perf_inspect", inspectBefore);
        inspections.push(inspection);
        assert.ok(reader.snapshot.session.historyTruncated);
        assert.ok(reader.snapshot.session.messages.length <= 200);
        const sum = reader.snapshot.session.messages.reduce((total, message) => total + Buffer.byteLength(JSON.stringify(message)), 0);
        assert.ok(sum <= 512 * 1024);
        assert.ok(inspection.branchEntries >= (batch + 1) * 250);
      }
      const responseMs = [];
      for (let index = 0; index < 20; index++) responseMs.push(await reader.resync());
      await writeFile(join(performanceDir, "history-inspections.json"), `${JSON.stringify({ inspections, snapshotRoundTripMs: responseMs }, null, 2)}\n`);
      return { persistedHistoryAdded: 1000, projectedMessages: reader.snapshot.session.messages.length,
        boundedSnapshotBytes: Buffer.byteLength(JSON.stringify(reader.snapshot)), roundTripMs: statistics(responseMs),
        measurement: "Node WS resync request to complete JSON snapshot; includes harness 20 ms polling; does not measure browser application or full A6 history", rawEvidence: "history-inspections.json" };
    });
    await writeFile(join(performanceDir, "fixture-events.jsonl"), await readFile(currentFixture.eventPath, "utf8"));
    await cleanupFixture(currentFixture, currentClients); currentFixture = undefined; currentClients = [];
    currentFixture = await fixture({ disablePane: true, autoWeb: false });
    const historyBefore = await currentFixture.eventCount("perf_history_added");
    currentFixture.command("/m0-perf-history 220 2048");
    await currentFixture.waitEvent("perf_history_added", historyBefore);
    await perform(currentFixture, perfReport.workload);
    const noPaneTool = await measure(currentFixture, "large-tool-no-pane", () => perform(currentFixture,
      { kind: "tool", partialBytes: 2 * 1024 * 1024, updates: 16, yieldMs: 20 }));
    const paneTool = JSON.parse(await readFile(join(performanceDir, "large-tool-partial.json"), "utf8"));
    perfReport.largeToolComparison = {
      conditions: "Both have 220×2048-byte persisted custom messages and a completed 256-KiB stream before 16×2-MiB tool partials; one fresh process per condition, single stress observation",
      noPane: { toolExecutionDurationMs: noPaneTool.tools[0]?.durationMs, totalMeasurementMs: noPaneTool.durationMs,
        eventLoopDelayMs: noPaneTool.eventLoopDelayMs, peakRssBytes: Math.max(...noPaneTool.samples.map(sample => sample.memory.rss)), rawTelemetry: "large-tool-no-pane.json" },
      paneWithReadingClients: { toolExecutionDurationMs: paneTool.tools[0]?.durationMs, totalMeasurementMs: paneTool.durationMs,
        eventLoopDelayMs: paneTool.eventLoopDelayMs, peakRssBytes: Math.max(...paneTool.samples.map(sample => sample.memory.rss)), rawTelemetry: "large-tool-partial.json" },
      scope: "Absolute large-partial stalls remain a host/fixture limitation even if the pane adds little overhead; wire bounds are evaluated separately from responsiveness."
    };
    await cleanupFixture(currentFixture); currentFixture = undefined;
    const baseline = perfReport.configurations[0];
    perfReport.regressionGuard = perfReport.configurations.map(configuration => ({ name: configuration.name,
      generationRatio: configuration.medianDurationVsNoPane,
      eventLoopP95DeltaMs: configuration.eventLoopDelayP95Ms.median - baseline.eventLoopDelayP95Ms.median,
      withinExploratoryGuard: configuration.medianDurationVsNoPane <= 1.25 && configuration.eventLoopDelayP95Ms.median - baseline.eventLoopDelayP95Ms.median <= 10 }));
    if (perfReport.regressionGuard.some(item => !item.withinExploratoryGuard)) perfReport.performanceDecision = "Investigate the measured local guard regression before claiming Q4 complete.";
    else perfReport.performanceDecision = "Controlled 256-KiB bounded-preview case stays within the stated M0 local overhead guard; full-history/M1 performance remains unclaimed.";
    }
    perfReport.status = "passed";
  }

  if (!perfOnly) {
    currentFixture = await fixture();
    currentClients = [await pressureClient(currentFixture.url)];
    const reader = currentClients[0];
    browser = await chromium.launch({ channel: "chrome", headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(currentFixture.url);
    await page.getByText("已连接", { exact: true }).waitFor();
    await page.getByRole("textbox", { name: "消息" }).fill("未发送的主题验证草稿");
    const contrastObservations = [];
    const buttonContrast = async () => {
      const values = await page.locator(".send-button").evaluate(button => {
        const styles = getComputedStyle(button);
        return { background: styles.backgroundColor, foreground: styles.color,
          colorScheme: getComputedStyle(document.documentElement).colorScheme };
      });
      const luminance = value => {
        const channels = value.match(/[\d.]+/g).slice(0, 3).map(Number).map(channel => {
          const srgb = channel / 255;
          return srgb <= .04045 ? srgb / 12.92 : ((srgb + .055) / 1.055) ** 2.4;
        });
        return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
      };
      const first = luminance(values.background), second = luminance(values.foreground);
      const contrast = (Math.max(first, second) + .05) / (Math.min(first, second) + .05);
      assert.ok(contrast >= 4.5, `send-button text contrast ${contrast}`);
      contrastObservations.push({ ...values, contrast });
      return { ...values, contrast };
    };
    const baseTheme = JSON.parse(await readFile(join(project, "node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json"), "utf8"));
    const theme = { ...baseTheme, name: "m0-hot-reload", appearance: "dark", colors: { ...baseTheme.colors, accent: "#37c7a5", text: "#eeeeee", userMessageBg: "#24312b", border: "#47594e" } };
    const themesDirectory = join(currentFixture.agentDir, "themes");
    await mkdir(themesDirectory, { recursive: true });
    const themePath = join(themesDirectory, "m0-hot-reload.json");
    await writeFile(themePath, JSON.stringify(theme));
    await check(themeReport, "public setTheme changes exact colors without reconnect", async () => {
      const before = await currentFixture.eventCount("perf_theme");
      const started = performance.now();
      currentFixture.command("/m0-perf-theme m0-hot-reload");
      const evidence = await currentFixture.waitEvent("perf_theme", before);
      assert.equal(evidence.result.success, true);
      assert.equal(evidence.name, "m0-hot-reload");
      await waitFor(() => reader.snapshot.theme["--accent"] === "#37c7a5", "WS theme from public API");
      await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() === "#37c7a5");
      const durationMs = performance.now() - started;
      assert.ok(durationMs < 1000);
      return { name: evidence.name, accent: reader.snapshot.theme["--accent"], durationMs, actualHostAppearance: evidence.appearance,
        sendButton: await buttonContrast() };
    });
    await check(themeReport, "same-name file edits including atomic replacement update colors within one second", async () => {
      const edits = [];
      for (const [index, accent] of ["#eec35a", "#96aef5", "#f197af", "#43cfba"].entries()) {
        theme.colors.accent = accent;
        theme.colors.muted = index % 2 ? "#9a9fb0" : "#aba99a";
        const started = performance.now();
        if (index % 2) {
          await writeFile(`${themePath}.tmp`, JSON.stringify(theme)); await rename(`${themePath}.tmp`, themePath);
        } else await writeFile(themePath, JSON.stringify(theme));
        await waitFor(() => reader.snapshot.theme["--accent"] === accent, "same-name WS theme update");
        await page.waitForFunction(expected => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() === expected, accent);
        const elapsedMs = performance.now() - started;
        assert.ok(elapsedMs < 1000, `theme edit visible in ${elapsedMs} ms`);
        const before = await currentFixture.eventCount("perf_theme"); currentFixture.command("/m0-perf-theme");
        const evidence = await currentFixture.waitEvent("perf_theme", before);
        assert.equal(evidence.name, "m0-hot-reload");
        edits.push({ accent, atomicReplacement: !!(index % 2), elapsedMs, name: evidence.name, sendButton: await buttonContrast() });
      }
      await page.screenshot({ path: join(themeDir, "same-name-hot-reload.png"), fullPage: true });
      return { edits, watcher: "pi's custom-theme directory watcher (100 ms debounce) plus Bridge polling; no private onThemeChange callback registration" };
    });
    await check(themeReport, "same theme name switching appearance and terminal-default tokens updates the browser", async () => {
      theme.appearance = "light"; theme.colors.text = ""; theme.colors.userMessageBg = "";
      const started = performance.now(); await writeFile(themePath, JSON.stringify(theme));
      await waitFor(() => reader.snapshot.theme["--bg"] === "#f5f5f4", "light appearance update");
      await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() === "#f5f5f4");
      const before = await currentFixture.eventCount("perf_theme"); currentFixture.command("/m0-perf-theme");
      const evidence = await currentFixture.waitEvent("perf_theme", before);
      assert.equal(evidence.appearance, "light");
      return { elapsedMs: performance.now() - started, pageBackground: reader.snapshot.theme["--bg"],
        foreground: reader.snapshot.theme["--fg"], userBackground: reader.snapshot.theme["--user-bg"],
        sendButton: await buttonContrast(),
        limitation: "PTY initially supplies no OSC default colors; pi returns documented appearance-based guessed defaults, not measured terminal pixels" };
    });
    await check(themeReport, "system theme follows real PTY color replies and appearance notifications", async () => {
      const before = await currentFixture.eventCount("perf_theme"); currentFixture.command("/m0-perf-theme system");
      const initial = await currentFixture.waitEvent("perf_theme", before);
      assert.equal(initial.result.success, true);
      await waitFor(() => reader.snapshot.theme["--accent"] !== theme.colors.accent && reader.snapshot.theme["--bg"] === "#111315", "system theme replaces the custom theme before terminal reports");
      const queryCount = () => currentFixture.terminal.split("\x1b]10;?\x07").length - 1;
      // The general PTY harness answers cursor-position requests but intentionally does
      // not impersonate a color-aware terminal at startup. Even timed-out color queries
      // retain their position until DA1; acknowledge those prior query batches first.
      const startupQueries = queryCount();
      for (let index = 0; index < startupQueries; index++) currentFixture.write("\x1b[?1;2c");
      await sleep(40);
      const transitions = [];
      for (const [appearance, code, foreground, background] of [["light", 2, "#202020", "#eeeeee"], ["dark", 1, "#dddddd", "#181818"]]) {
        const started = performance.now();
        const beforeQueries = queryCount();
        currentFixture.write(`\x1b[?997;${code}n`);
        await waitFor(() => queryCount() > beforeQueries, "pi queries terminal colors after appearance notification");
        // These are ordinary terminal responses to pi's OSC 10/11 + DA1 query, delivered
        // through the PTY input decoder rather than internal theme-controller functions.
        currentFixture.write(`\x1b]10;${foreground}\x07\x1b]11;${background}\x07\x1b[?1;2c`);
        await waitFor(() => reader.snapshot.theme["--fg"] === foreground && reader.snapshot.theme["--bg"] === (appearance === "light" ? "#f5f5f4" : "#111315"), `system ${appearance} WebSocket theme with reported foreground`);
        const count = await currentFixture.eventCount("perf_theme"); currentFixture.command("/m0-perf-theme");
        const evidence = await currentFixture.waitEvent("perf_theme", count);
        assert.equal(evidence.name, "system"); assert.equal(evidence.appearance, appearance);
        await page.waitForFunction(expected => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() === expected,
          appearance === "light" ? "#f5f5f4" : "#111315");
        transitions.push({ appearance, reportedForeground: foreground, reportedBackground: background,
          mappedForeground: reader.snapshot.theme["--fg"], mappedBackground: reader.snapshot.theme["--bg"], elapsedMs: performance.now() - started,
          sendButton: await buttonContrast() });
      }
      return { transitions, limitation: "Terminal responses are deterministic PTY protocol replies; no manual test against an actual terminal emulator's color preference UI. Page background is derived from appearance, as M0 implements, rather than exactly matching OSC background." };
    });
    themeReport.contrastSummary = {
      method: "Chrome getComputedStyle for .send-button background and foreground, evaluated with relative sRGB luminance contrast",
      minimumRequiredRatio: 4.5, observations: contrastObservations.length,
      minimumObservedRatio: Math.min(...contrastObservations.map(value => value.contrast)),
      maximumObservedRatio: Math.max(...contrastObservations.map(value => value.contrast)),
      nativeColorSchemes: [...new Set(contrastObservations.map(value => value.colorScheme))],
      status: "passed",
    };
    await writeFile(join(themeDir, "fixture-events.jsonl"), await readFile(currentFixture.eventPath, "utf8"));
    await browser.close(); browser = undefined;
    await cleanupFixture(currentFixture, currentClients); currentFixture = undefined; currentClients = [];
    themeReport.status = "passed";
  }
} catch (error) {
  const message = redact(error?.stack || error);
  if (!themeOnly && perfReport.status !== "passed") { perfReport.status = "failed"; perfReport.error = message; }
  else { themeReport.status = "failed"; themeReport.error = message; }
  console.error(message);
  process.exitCode = 1;
} finally {
  if (currentFixture) {
    const target = perfReport.status === "passed" || themeOnly ? themeDir : performanceDir;
    await writeFile(join(target, "failure-fixture-events.jsonl"), await readFile(currentFixture.eventPath, "utf8")).catch(() => {});
  }
  if (browser) await browser.close();
  await cleanupFixture(currentFixture, currentClients);
  if (!themeOnly) { perfReport.finishedAt = new Date().toISOString(); await writeFile(join(performanceDir, "report.json"), `${JSON.stringify(perfReport, null, 2)}\n`); }
  if (!perfOnly) { themeReport.finishedAt = new Date().toISOString(); await writeFile(join(themeDir, "report.json"), `${JSON.stringify(themeReport, null, 2)}\n`); }
}
console.log(`Evidence: ${performanceDir} and ${themeDir}`);
