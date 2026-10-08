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
import { LIMITS, applyProjectionEvent, mergeOlderPage } from "../dist/protocol/index.js";

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
  scope: "M1 paged history, content pages, backpressure and host overhead (A5); browser snapshot P95 (A6) is measured by scripts/m1-a6.mjs", environment, repetitions,
  workload: { kind: "text", chunks: 256, chunkBytes: 1024, yieldMs: 1, outputBytes: 262144 },
  controls: ["Identical provider, PTY drain, evidence writes and 20 ms in-process sampling in all configurations", "Warmup before measurement; generation duration recorded in the provider separately from TUI start/finish commands", "No explicit GC; process RSS/heap includes the pi host's full transcript and fixture telemetry", "Three rounds summarize medians, not a reliable tail-latency or significance estimate"],
  limits: { messageCharacters: LIMITS.messageChars, messageWindow: LIMITS.snapshotWindowMessages, messageWindowBytes: LIMITS.snapshotWindowBytes,
    pageBytes: LIMITS.pageBytes, contentPageCharacters: LIMITS.contentPageChars, toolsMax: LIMITS.maxTools, toolOutputCharacters: LIMITS.toolOutputChars,
    transportFrameBytes: LIMITS.frameBytes, logicalFrameBytes: LIMITS.logicalFrameBytes, serverSendBufferBytes: LIMITS.sendBufferBytes, clientLeases: 8 },
  configurations: [], checks: [], notCovered: ["Browser snapshot P95 (A6) — see scripts/m1-a6.mjs", "OS/browser network process memory", "Long-term production leak soak beyond the repeated bounded-window stress", "Remote networks/LAN or TLS"],
  acceptance: { mandatory: ["Reading clients retain contiguous sequence numbers and remain connected", "Paused peer is closed specifically for slow_client and server buffer stays at the declared bound", "TUI settles during paused-peer stress", "Huge results keep bounded wire previews and remain fully readable through content_page", "Long history is windowed in snapshots and fully reachable through history_page"],
    exploratoryRegressionGuard: "For the identical 256-KiB case, median generation overhead ≤25% and event-loop p95 increase ≤10 ms vs no-pane; these are M0 local engineering guards, not design A6 or statistical confidence claims" },
};
const themeReport = { scope: "Q3 real-TUI/public-API theme synchronization", environment, checks: [], publicAPI: "ctx.ui.setTheme, ctx.ui.theme.colors, ctx.ui.theme.appearance",
  notCovered: [
    "System-theme color reports and appearance notifications are deterministic protocol replies delivered through a real PTY; desktop OS appearance switching and an actual terminal emulator's preference UI were not exercised.",
    "Page background follows export.pageBg when available and otherwise uses an appearance fallback; exact reproduction of the terminal's reported OSC background color is not implemented or claimed.",
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
    closeCode: undefined, closeReason: undefined, protocolErrors: [], errors: [], snapshots: 0, replies: new Map(), assembling: undefined, requestNo: 0,
    stats: { frames: 0, bytes: 0, events: 0, maxFrameBytes: 0, toolUpdates: 0, maxToolValueCharacters: 0 },
    send(frame) { socket.send(JSON.stringify(frame)); },
    async resync() {
      const before = client.snapshots; const started = performance.now();
      client.send({ t: "resync" });
      await waitFor(() => client.snapshots > before, "bounded snapshot response");
      return performance.now() - started;
    },
    /** Directed read request; resolves with the matching reply or error frame. */
    async read(frame) {
      const reqId = `r${++client.requestNo}`;
      client.send({ ...frame, reqId, epoch: client.epoch });
      return waitFor(() => client.replies.get(reqId), `${frame.t} reply`, 20_000);
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
    let frame = JSON.parse(data.toString());
    if (frame.t === "frame_begin") { client.assembling = { id: frame.id, parts: frame.parts, chunks: [] }; client.stats.chunkedFrames = (client.stats.chunkedFrames ?? 0) + 1; return; }
    if (frame.t === "frame_chunk") { client.assembling?.chunks.push(frame.data); return; }
    if (frame.t === "frame_end") {
      const done = client.assembling; client.assembling = undefined;
      if (!done || done.id !== frame.id || done.chunks.length !== done.parts) { client.protocolErrors.push({ chunkEnd: frame.id }); return; }
      frame = JSON.parse(done.chunks.join(""));
    }
    if (frame.reqId && (frame.t === "history_page" || frame.t === "content_page" || frame.t === "error")) { client.replies.set(frame.reqId, frame); return; }
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
    if (event.tool) {
      client.stats.toolUpdates++;
      client.stats.maxToolValueCharacters = Math.max(client.stats.maxToolValueCharacters, (event.tool.output ?? "").length);
    }
    try { client.snapshot = applyProjectionEvent(state, event); }
    catch (error) { client.protocolErrors.push({ seq: frame.seq, type: event?.type, error: String(error) }); }
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
      assert.ok(telemetry.samples.every(sample => sample.maxBufferedBytes <= perfReport.limits.serverSendBufferBytes + 65536), "server buffers stay bounded at the send-buffer limit plus one sampled frame");
      return { clientCloseCode: slow.closeCode, clientCloseReason: slow.closeReason, serverCloseEvents: telemetry.socketCloses,
        serverCloseRequests: telemetry.socketCloseRequests,
        peakBufferedBytes: Math.max(...telemetry.samples.map(sample => sample.maxBufferedBytes)),
        peakRssBytes: Math.max(...telemetry.samples.map(sample => sample.memory.rss)),
        providerDurationMs: telemetry.providers[0]?.durationMs, remainingClients: 3, pressure: "48 legal resync requests for a ~400-KiB bounded snapshot while TCP reads are paused; fixed 256-KiB provider runs concurrently",
        transport: "Node ws.pause() stops TCP receive consumption of the same browser wire protocol; not a browser network-process freeze", rawTelemetry: "slow-client.json" };
    });
    await check(perfReport, "two-MiB tool partials stay bounded on the wire and the final result is readable in full through content pages", async () => {
      const telemetry = await measure(currentFixture, "large-tool-partial", () => perform(currentFixture, { kind: "tool", partialBytes: 2 * 1024 * 1024, updates: 16, yieldMs: 20 }));
      const reader = currentClients[0];
      await reader.resync();
      const tool = reader.snapshot.state.tools.find(tool => tool.name === "m0_perf_tool");
      assert.ok(tool && tool.status === "complete");
      assert.ok(tool.output.length <= LIMITS.toolOutputChars);
      assert.ok(tool.outputTotal > 2 * 1024 * 1024, "the tail advertises the full output length");
      assert.ok(reader.stats.maxToolValueCharacters <= LIMITS.toolOutputChars);
      assert.ok(reader.stats.maxFrameBytes <= LIMITS.frameBytes, "every transport frame stays within 1 MiB");
      const result = reader.snapshot.session.messages.find(message => message.role === "toolResult" && message.toolCallId === tool.id);
      assert.ok(result, "the persisted tool result is in the snapshot window");
      const index = result.content.findIndex(block => block.type === "text" && block.total !== undefined);
      assert.ok(index >= 0 && result.content[index].text.length <= LIMITS.messageChars);
      const total = result.content[index].total;
      const started = performance.now();
      let text = "";
      let pages = 0;
      while (text.length < total) {
        const page = await reader.read({ t: "content_page", messageId: result.id, index, offset: text.length });
        assert.equal(page.t, "content_page", JSON.stringify(page.error ?? {}));
        assert.equal(page.total, total);
        text += page.text; pages++;
      }
      const readMs = performance.now() - started;
      assert.ok(text.startsWith("FINAL\n") && text.length === total);
      return { inputPartialBytes: 2 * 1024 * 1024, updates: 16, toolWireOutputMaxCharacters: reader.stats.maxToolValueCharacters,
        finalOutputTotal: tool.outputTotal, contentPages: pages, fullResultCharacters: total, fullReadMs: readMs,
        peakRssBytes: Math.max(...telemetry.samples.map(sample => sample.memory.rss)),
        toolExecutionDurationMs: telemetry.tools[0]?.durationMs, measurementDurationMs: telemetry.durationMs,
        eventLoopDelayMs: telemetry.eventLoopDelayMs, rawTelemetry: "large-tool-partial.json" };
    });
    await check(perfReport, "1,000 persisted history messages are windowed in snapshots and fully reachable through history pages", async () => {
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
        assert.ok(reader.snapshot.session.olderCursor, "older history is reachable");
        assert.ok(reader.snapshot.session.messages.length <= LIMITS.snapshotWindowMessages + 1);
        const sum = reader.snapshot.session.messages.filter(message => message.entryId).reduce((total, message) => total + Buffer.byteLength(JSON.stringify(message)), 0);
        assert.ok(sum <= LIMITS.snapshotWindowBytes);
        assert.ok(inspection.branchEntries >= (batch + 1) * 250);
      }
      const responseMs = [];
      for (let index = 0; index < 20; index++) responseMs.push(await reader.resync());
      const started = performance.now();
      let messages = reader.snapshot.session.messages;
      let cursor = reader.snapshot.session.olderCursor;
      let pages = 0;
      while (cursor) {
        const page = await reader.read({ t: "history_page", sessionId: reader.snapshot.session.id, branchRevision: reader.snapshot.session.branchRevision, before: cursor });
        assert.equal(page.t, "history_page", JSON.stringify(page.error ?? {}));
        assert.ok(page.messages.length > 0);
        messages = mergeOlderPage(messages, page.messages);
        cursor = page.olderCursor; pages++;
      }
      const pagingMs = performance.now() - started;
      const history = messages.filter(message => message.content.some(block => block.type === "text" && block.text.startsWith("HISTORY ")));
      assert.ok(history.length >= 1000, `all history messages reachable (${history.length})`);
      assert.equal(new Set(messages.map(message => message.id)).size, messages.length, "no duplicate identities");
      assert.ok(reader.stats.maxFrameBytes <= LIMITS.frameBytes, "frames over 1 MiB are chunked");
      await writeFile(join(performanceDir, "history-inspections.json"), `${JSON.stringify({ inspections, snapshotRoundTripMs: responseMs, pages, pagingMs }, null, 2)}\n`);
      return { persistedHistoryAdded: 1000, windowMessages: reader.snapshot.session.messages.length, reachableMessages: messages.length,
        historyPages: pages, fullPagingMs: pagingMs, snapshotBytes: Buffer.byteLength(JSON.stringify(reader.snapshot)), roundTripMs: statistics(responseMs),
        measurement: "Node WS resync to complete snapshot, and sequential history_page reads to the branch root; browser application is A6", rawEvidence: "history-inspections.json" };
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
    const theme = { ...baseTheme, name: "m0-hot-reload", appearance: "dark", vars: { ...baseTheme.vars, paneBackground: "#182622" }, export: { ...baseTheme.export, pageBg: "paneBackground" }, colors: { ...baseTheme.colors, accent: "#37c7a5", text: "#eeeeee", userMessageBg: "#24312b", border: "#47594e" } };
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
      assert.equal(reader.snapshot.theme["--bg"], "#182622", "page background resolves the theme's export variable");
      await page.waitForFunction(() => getComputedStyle(document.body).backgroundColor === "rgb(24, 38, 34)");
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
    await check(themeReport, "export-only edits refresh the background and derived web colors", async () => {
      const previous = { ...reader.snapshot.theme };
      theme.vars.paneBackground = "#202838";
      const started = performance.now();
      await writeFile(`${themePath}.tmp`, JSON.stringify(theme)); await rename(`${themePath}.tmp`, themePath);
      await waitFor(() => reader.snapshot.theme["--bg"] === "#202838", "export-only WS theme update");
      await page.waitForFunction(() => getComputedStyle(document.body).backgroundColor === "rgb(32, 40, 56)");
      const elapsedMs = performance.now() - started;
      assert.ok(elapsedMs < 1000, `background edit visible in ${elapsedMs} ms`);
      assert.equal(reader.snapshot.theme["--accent"], previous["--accent"]);
      const derived = Object.keys(reader.snapshot.theme).filter((key) => !key.startsWith("--pi-") && key !== "--bg" && reader.snapshot.theme[key] !== previous[key]);
      assert.ok(derived.length >= 2, "surface/hover colors follow pageBg even when pi colors do not change");
      return { elapsedMs, background: reader.snapshot.theme["--bg"], derived };
    });
    await check(themeReport, "same theme name switching appearance and terminal-default tokens updates the browser", async () => {
      theme.appearance = "light"; theme.colors.text = ""; theme.colors.userMessageBg = "";
      delete theme.export;
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
      return { transitions, limitation: "Terminal responses are deterministic PTY protocol replies; no manual test against an actual terminal emulator's color preference UI. The system theme has no export.pageBg, so page background uses the appearance fallback rather than exactly matching OSC background." };
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
