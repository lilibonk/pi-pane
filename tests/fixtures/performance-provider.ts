/** Local deterministic stress provider and in-process telemetry. No network or credentials. */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { Session } from "node:inspector";
import { createAssistantMessageEventStream, Type } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface StressSpec { kind?: "text" | "tool"; chunks?: number; chunkBytes?: number; yieldMs?: number; partialBytes?: number; updates?: number }
interface Meter {
  name: string;
  startedAt: string;
  start: number;
  cpu: ReturnType<typeof process.cpuUsage>;
  initial: ReturnType<typeof process.memoryUsage>;
  histogram: ReturnType<typeof monitorEventLoopDelay>;
  sampler: ReturnType<typeof setInterval>;
  samples: Record<string, unknown>[];
  providers: Record<string, unknown>[];
  tools: Record<string, unknown>[];
  socketCloses: { code: number; reason: string; atMs: number }[];
  socketCloseRequests: { code?: number; reason: string; atMs: number; bufferedBytes: number }[];
  listeners: { socket: any; callback: (code: number, reason: Buffer) => void; originalClose: (...args: any[]) => any }[];
  progress?: { bytes: number; updates: number; durationMs: number };
  profile?: Session;
}
let meter: Meter | undefined;
let currentContext: ExtensionContext | undefined;
const pause = (ms: number) => ms ? new Promise<void>(resolve => setTimeout(resolve, ms)) : new Promise<void>(resolve => setImmediate(resolve));
function evidence(event: string, data: Record<string, unknown> = {}) {
  const path = process.env.PI_M0_EVENTS_PATH;
  if (path) appendFileSync(path, `${JSON.stringify({ at: Date.now(), event, ...data })}\n`, { mode: 0o600 });
}
function ownHub(): any {
  // Test-only diagnostics of this repository's Hub; never inspect token/lease content.
  return (globalThis as any)[Symbol.for("pi-pane.process.v1")]?.hub;
}
function sample(): void {
  if (!meter) return;
  const hub = ownHub();
  const sockets = [...(hub?.wss?.clients ?? [])] as any[];
  meter.samples.push({ atMs: performance.now() - meter.start, memory: process.memoryUsage(),
    authenticatedConnections: hub?.connectionCount ?? 0, socketCount: sockets.length,
    totalBufferedBytes: sockets.reduce((total, socket) => total + socket.bufferedAmount, 0),
    maxBufferedBytes: Math.max(0, ...sockets.map(socket => socket.bufferedAmount)) });
}
async function begin(name: string) {
  if (meter) throw new Error("Finish the preceding performance measurement first.");
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  meter = { name, startedAt: new Date().toISOString(), start: performance.now(), cpu: process.cpuUsage(),
    initial: process.memoryUsage(), histogram, sampler: undefined!, samples: [], providers: [], tools: [], socketCloses: [], socketCloseRequests: [], listeners: [] };
  const sockets = [...(ownHub()?.wss?.clients ?? [])] as any[];
  for (const socket of sockets) {
    const callback = (code: number, reason: Buffer) => meter?.socketCloses.push({ code, reason: reason.toString(), atMs: performance.now() - meter.start });
    const originalClose = socket.close;
    socket.close = function(code?: number, reason?: string | Buffer) {
      meter?.socketCloseRequests.push({ code, reason: reason?.toString() ?? "", atMs: performance.now() - meter.start, bufferedBytes: this.bufferedAmount });
      return originalClose.call(this, code, reason);
    };
    socket.on("close", callback); meter.listeners.push({ socket, callback, originalClose });
  }
  meter.sampler = setInterval(sample, 20);
  meter.sampler.unref();
  sample();
  if (name.startsWith("overload-")) {
    const profile = new Session(); profile.connect(); meter.profile = profile;
    await new Promise<void>((resolve, reject) => profile.post("Profiler.enable", error => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => profile.post("Profiler.start", error => error ? reject(error) : resolve()));
  }
  evidence("perf_meter_started", { name });
}
async function finish() {
  if (!meter) throw new Error("No active performance measurement.");
  sample();
  const completed = meter;
  clearInterval(completed.sampler);
  completed.histogram.disable();
  for (const { socket, callback, originalClose } of completed.listeners) { socket.off("close", callback); socket.close = originalClose; }
  const histogram = completed.histogram;
  const report = { name: completed.name, startedAt: completed.startedAt, durationMs: performance.now() - completed.start,
    nodeVersion: process.version, pid: process.pid, cpuMicroseconds: process.cpuUsage(completed.cpu),
    initialMemory: completed.initial, finalMemory: process.memoryUsage(),
    eventLoopDelayMs: { min: histogram.min / 1e6, max: histogram.max / 1e6, mean: histogram.mean / 1e6,
      p50: histogram.percentile(50) / 1e6, p95: histogram.percentile(95) / 1e6, p99: histogram.percentile(99) / 1e6 },
    providers: completed.providers, tools: completed.tools, progress: completed.progress, samples: completed.samples, socketCloses: completed.socketCloses,
    socketCloseRequests: completed.socketCloseRequests,
    diagnosticsScope: "Test-only readings of pi-pane's own Hub bufferedAmount and connectionCount; no credentials or host internals",
    idleAtFinish: currentContext?.isIdle(), bridgePresent: !!(globalThis as any)[Symbol.for("pi-pane.process.v1")]?.bridge,
  };
  const directory = process.env.PI_M0_PERF_OUTPUT_DIR;
  if (!directory) throw new Error("PI_M0_PERF_OUTPUT_DIR missing.");
  mkdirSync(directory, { recursive: true });
  if (completed.profile) {
    const response = await new Promise<any>((resolve, reject) => completed.profile!.post("Profiler.stop", (error, result) => error ? reject(error) : resolve(result)));
    completed.profile.disconnect();
    writeFileSync(join(directory, `${completed.name}.cpuprofile`), JSON.stringify(response.profile), { mode: 0o600 });
  }
  writeFileSync(join(directory, `${completed.name}.json`), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  meter = undefined;
  evidence("perf_meter_finished", { name: completed.name, durationMs: report.durationMs });
}
function textOf(context: TranscriptContext): string {
  const last = [...context.messages].reverse().find(message => message.role === "user");
  if (!last) return "";
  return typeof last.content === "string" ? last.content : last.content.filter(part => part.type === "text").map(part => part.text).join("");
}
function specOf(input: string): StressSpec {
  try { return input.startsWith("PERF ") ? JSON.parse(input.slice(5)) as StressSpec : {}; } catch { return {}; }
}
function stream(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) {
  const stream = createAssistantMessageEventStream();
  const input = textOf(context);
  const spec = specOf(input);
  const useTool = spec.kind === "tool" && context.messages.at(-1)?.role !== "toolResult";
  const message: AssistantMessage = {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: useTool ? "toolUse" : "stop", timestamp: Date.now(),
  };
  void (async () => {
    const started = performance.now();
    let bytes = 0, updates = 0;
    evidence("perf_provider_started", { useTool, spec });
    try {
      await options?.onPayload?.({ testProvider: true, spec }, model);
      stream.push({ type: "start", partial: structuredClone(message) });
      if (useTool) {
        const toolCall = { type: "toolCall" as const, id: `perf-tool-${message.timestamp}`, name: "m0_perf_tool", arguments: { spec: JSON.stringify(spec) } };
        message.content.push(toolCall);
        stream.push({ type: "toolcall_start", contentIndex: 0, partial: structuredClone(message) });
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: structuredClone(message) });
      } else {
        const part = { type: "text" as const, text: "" };
        message.content.push(part);
        stream.push({ type: "text_start", contentIndex: 0, partial: structuredClone(message) });
        const chunks = spec.kind === "tool" ? 1 : Math.min(8192, Math.max(1, spec.chunks ?? 256));
        const chunkBytes = spec.kind === "tool" ? 32 : Math.min(32_768, Math.max(1, spec.chunkBytes ?? 1024));
        const chunk = "0123456789abcdef".repeat(Math.ceil(chunkBytes / 16)).slice(0, chunkBytes);
        for (let index = 0; index < chunks; index++) {
          await pause(Math.min(1000, Math.max(0, spec.yieldMs ?? 1)));
          if (options?.signal?.aborted) throw new Error("Performance fixture aborted");
          part.text += chunk;
          bytes += chunkBytes; updates++;
          if (meter) meter.progress = { bytes, updates, durationMs: performance.now() - started };
          stream.push({ type: "text_delta", contentIndex: 0, delta: chunk, partial: structuredClone(message) });
        }
        stream.push({ type: "text_end", contentIndex: 0, content: part.text, partial: structuredClone(message) });
      }
      stream.push({ type: "done", reason: useTool ? "toolUse" : "stop", message });
    } catch (error) {
      message.stopReason = options?.signal?.aborted ? "aborted" : "error";
      message.errorMessage = error instanceof Error ? error.message : "Performance fixture failed";
      stream.push({ type: "error", reason: message.stopReason, error: message });
    } finally {
      const details = { useTool, bytes, updates, durationMs: performance.now() - started, spec, stopReason: message.stopReason };
      meter?.providers.push(details);
      evidence("perf_provider_finished", details);
      stream.end();
    }
  })();
  return stream;
}

export default function performanceProvider(pi: ExtensionAPI) {
  pi.registerProvider("pi-pane-m0-perf", {
    baseUrl: "http://does-not-exist.invalid", apiKey: "local-performance-fixture-not-a-secret", api: "pi-pane-m0-perf-api",
    models: [{ id: "deterministic", name: "M0 performance local fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16_777_216, maxTokens: 8_388_608 }],
    streamSimple: stream,
  });
  pi.registerTool({ name: "m0_perf_tool", label: "M0 performance tool", description: "Local deterministic large-partial fixture.",
    parameters: Type.Object({ spec: Type.String() }),
    async execute(_id, args, signal, onUpdate) {
      const spec = JSON.parse(args.spec) as StressSpec;
      const bytes = Math.min(2 * 1024 * 1024, Math.max(1, spec.partialBytes ?? 1024 * 1024));
      const updates = Math.min(2048, Math.max(1, spec.updates ?? 12));
      const payload = "x".repeat(bytes);
      const started = performance.now();
      for (let index = 0; index < updates; index++) {
        if (signal?.aborted) throw new Error("Performance fixture tool aborted");
        onUpdate?.({ content: [{ type: "text", text: `PARTIAL ${index}\n${payload}` }], details: { index, originalBytes: bytes } });
        await pause(Math.min(1000, Math.max(0, spec.yieldMs ?? 20)));
      }
      const details = { bytes, updates, durationMs: performance.now() - started };
      meter?.tools.push(details);
      evidence("perf_tool_finished", details);
      return { content: [{ type: "text", text: `FINAL\n${payload}` }], details: { bytes, updates } };
    },
  });
  pi.on("session_start", (_event, ctx) => { currentContext = ctx; });
  pi.on("session_shutdown", () => {
    if (meter) { clearInterval(meter.sampler); meter.histogram.disable(); }
    meter = undefined;
  });
  pi.registerCommand("m0-perf-start", { description: "Begin local performance telemetry", async handler(args) {
    if (!/^[a-z0-9_-]{1,80}$/.test(args.trim())) throw new Error("Use a safe measurement name.");
    await begin(args.trim());
  } });
  pi.registerCommand("m0-perf-finish", { description: "Write local performance telemetry", async handler(_args, ctx) {
    if (!ctx.isIdle()) throw new Error("Wait until the host settles.");
    await finish();
  } });
  pi.registerCommand("m0-perf-capture", { description: "Capture a timed-out stress test while the host is still active", async handler() {
    await finish();
  } });
  pi.registerCommand("m0-perf-history", { description: "Populate local custom-message history for bounded-window checks", async handler(args) {
    const [countText, bytesText] = args.trim().split(/\s+/);
    const count = Math.min(2000, Math.max(1, Number(countText) || 300));
    const bytes = Math.min(32_768, Math.max(1, Number(bytesText) || 2048));
    for (let index = 0; index < count; index++) pi.sendMessage({ customType: "m0-perf-history", content: `HISTORY ${index}\n${"h".repeat(bytes)}`, display: true }, { triggerTurn: false });
    evidence("perf_history_added", { count, bytes });
  } });
  pi.registerCommand("m0-perf-theme", { description: "Read or change a theme using the public extension UI API", async handler(args, ctx) {
    const name = args.trim();
    const result = name ? ctx.ui.setTheme(name) : { success: true };
    const theme = ctx.ui.theme;
    evidence("perf_theme", { requested: name, result, name: theme.name, appearance: theme.appearance,
      colors: theme.colors, available: ctx.ui.getAllThemes().map(item => ({ name: item.name })) });
  } });
  pi.registerCommand("m0-perf-inspect", { description: "Read bounded projection and branch sizes for fixture evidence", async handler(_args, ctx) {
    const branch = ctx.sessionManager.getBranch();
    const state = (globalThis as any)[Symbol.for("pi-pane.process.v1")];
    const body = state?.bridge?.snapshot();
    evidence("perf_inspect", { branchEntries: branch.length, branchMessages: branch.filter(entry => entry.type === "message").length,
      projectionMessages: body?.session.messages.length ?? 0, projectionMessageBytes: Buffer.byteLength(JSON.stringify(body?.session.messages ?? [])),
      olderCursor: body?.session.olderCursor ?? null, tools: body?.state.tools.length ?? 0,
      projectionBytes: body ? Buffer.byteLength(JSON.stringify(body)) : 0, connections: state?.hub?.connectionCount ?? 0,
      memory: process.memoryUsage() });
  } });
}
