import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
/**
 * The RPC entry of the pi installation running this process (found from its CLI path), so the child
 * is the same pi version as the TUI it replaces, not whatever copy this package resolves.
 */
export function runningPiRpcEntry(cliPath = process.argv[1]): string | undefined {
  if (!cliPath) return undefined;
  let directory: string;
  try { directory = dirname(realpathSync(cliPath)); } catch { return undefined; }
  for (; directory !== dirname(directory); directory = dirname(directory)) {
    const manifest = join(directory, "package.json");
    if (!existsSync(manifest)) continue;
    try {
      const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string; exports?: Record<string, { import?: string } | string> };
      if (pkg.name !== PI_PACKAGE) continue;
      const target = pkg.exports?.["./rpc-entry"];
      const relative = typeof target === "string" ? target : target?.import;
      return relative ? join(directory, relative) : undefined;
    } catch { return undefined; }
  }
  return undefined;
}

/**
 * Requests that only read state. They are bounded by a timeout; a timed-out read fails on its own and
 * leaves the child running. Everything else may run extension code (commands, dialogs, session hooks)
 * for as long as the user takes, so it has no timeout: abort, a dialog answer or Ctrl+C ends it.
 */
export const RPC_READS = new Set(["get_state", "get_entries", "get_messages", "get_commands", "get_available_models",
  "get_available_thinking_levels", "get_tree", "get_fork_messages", "get_session_stats", "get_last_assistant_text"]);
export const DEFAULT_READ_TIMEOUT_MS = 30_000;

/** One RPC record from the child: a response, a session event or an extension UI request. */
export type RpcRecord = { type: string; [key: string]: unknown };
export interface RpcConnection {
  readonly exited: Promise<number | null>;
  readonly running: boolean;
  readonly diagnostics: string;
  readonly pid?: number;
  start(): void;
  /** Release the launch gate after the host has durably recorded this writer's PID. */
  activate?(): void;
  request<T = unknown>(type: string, payload?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  onRecord(listener: (record: RpcRecord) => void): () => void;
  respondUi(id: string, response: Record<string, unknown>): void;
  stop(): Promise<void>;
}

/**
 * pi in RPC mode as a child process: the session's only writer after a handoff.
 * Uses the package's exported `rpc-entry`, so the child runs the CLI's own runtime factory
 * (settings, trust, auth, built-in extensions) instead of a host-side reconstruction.
 */
export class RpcChild implements RpcConnection {
  private process?: ChildProcess;
  private nextId = 0;
  private pending = new Map<string, { resolve: (value: RpcRecord) => void; reject: (error: Error) => void }>();
  private listeners = new Set<(record: RpcRecord) => void>();
  private stderr = "";
  private finished = false;
  readonly exited: Promise<number | null>;
  private resolveExit!: (code: number | null) => void;

  constructor(private readonly args: string[], private readonly cwd: string, private readonly entry = runningPiRpcEntry(), private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly readTimeoutMs = DEFAULT_READ_TIMEOUT_MS) {
    this.exited = new Promise((resolve) => { this.resolveExit = resolve; });
  }

  start(): void {
    if (this.process || this.finished) throw new Error("pi RPC child can only be started once.");
    const entry = this.entry;
    if (!entry) throw new Error("The running pi installation does not provide an RPC entry.");
    // Own process group: Ctrl+C in the terminal reaches the host, which stops the child in order.
    // The child exits when its stdin closes, so it cannot outlive a crashed host as a second writer.
    // Startup gate prevents a host crash between spawn and durable writer-PID registration
    // from exposing an unlocked child. It is process lifecycle IPC, not an extension channel.
    const bootstrap = `import {pathToFileURL} from "node:url"; const orphan=()=>process.exit(0); process.on("disconnect",orphan); const timer=setTimeout(()=>process.exit(1),10000); process.once("message",async value=>{if(value!=="start")return; clearTimeout(timer); process.off("disconnect",orphan); process.disconnect(); await import(pathToFileURL(process.argv[1]).href);});`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", bootstrap, entry, ...this.args], { cwd: this.cwd, env: this.env, stdio: ["pipe", "pipe", "pipe", "ipc"], detached: true });
    this.process = child;
    child.stderr!.on("data", (data: Buffer) => { this.stderr = (this.stderr + data.toString()).slice(-16_384); });
    const finish = (code: number | null, error?: Error) => {
      if (this.finished) return;
      this.finished = true;
      for (const { reject } of this.pending.values()) reject(error ?? new Error(`pi RPC child exited (${code}); the web host must stop.`));
      this.pending.clear();
      this.resolveExit(code);
    };
    child.once("error", (error) => finish(null, error));
    child.once("exit", (code) => finish(code));
    child.stdin!.on("error", () => { /* pending requests reject on child exit */ });
    createInterface({ input: child.stdout! }).on("line", (line) => {
      let record: RpcRecord;
      try { record = JSON.parse(line) as RpcRecord; } catch { return; }
      if (!record || typeof record !== "object" || typeof record.type !== "string") return;
      if (record.type === "response" && typeof record.id === "string" && this.pending.has(record.id)) {
        const request = this.pending.get(record.id)!;
        this.pending.delete(record.id);
        request.resolve(record);
        return;
      }
      for (const listener of [...this.listeners]) {
        try { listener(record); } catch { /* listener failures stay local */ }
      }
    });
  }
  get running(): boolean { return !!this.process && !this.finished && this.process.exitCode === null; }
  get pid(): number | undefined { return this.process?.pid; }
  activate(): void {
    if (!this.process?.connected) throw new Error("The RPC launch gate is not connected.");
    this.process.send("start", error => { if (error) void this.stop(); });
  }
  get diagnostics(): string { return this.stderr; }
  onRecord(listener: (record: RpcRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private write(record: Record<string, unknown>): void {
    if (!this.process?.stdin?.writable) throw new Error("pi RPC host is not running.");
    this.process.stdin.write(`${JSON.stringify(record)}\n`);
  }
  /**
   * Sends a command and resolves with its `data`; rejects when the response reports failure.
   * Reads time out after `timeoutMs` (default: the read timeout) without stopping the child; other
   * commands wait for their response, or reject when the child exits.
   */
  async request<T = unknown>(type: string, payload: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    const id = `h${++this.nextId}`;
    const limit = RPC_READS.has(type) ? timeoutMs ?? this.readTimeoutMs : undefined;
    const response = await new Promise<RpcRecord>((resolve, reject) => {
      const timer = limit === undefined ? undefined : setTimeout(() => {
        // A late response is then ignored; reads change nothing, so the child keeps running.
        this.pending.delete(id);
        reject(new Error(`pi RPC ${type} did not answer within ${Math.round(limit / 1000)} s.`));
      }, limit);
      timer?.unref?.();
      this.pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      try { this.write({ id, type, ...payload }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error as Error); }
    });
    if (response.success === false) throw new Error(String(response.error ?? `pi RPC ${type} failed.`));
    return response.data as T;
  }
  /** Answers an extension dialog (select/confirm/input/editor). */
  respondUi(id: string, response: Record<string, unknown>): void {
    this.write({ type: "extension_ui_response", id, ...response });
  }
  /** Graceful stop: close stdin, then SIGTERM, then SIGKILL. */
  async stop(): Promise<void> {
    const child = this.process;
    if (!child || this.finished || child.exitCode !== null) return;
    child.stdin?.end();
    const signal = (value: NodeJS.Signals) => {
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, value); else child.kill(value); }
      catch { /* already exited */ }
    };
    const terminate = setTimeout(() => signal("SIGTERM"), 2000);
    const kill = setTimeout(() => signal("SIGKILL"), 5000);
    await this.exited;
    clearTimeout(terminate);
    clearTimeout(kill);
  }
}
