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

/** One RPC record from the child: a response, a session event or an extension UI request. */
export type RpcRecord = { type: string; [key: string]: unknown };

/**
 * pi in RPC mode as a child process: the session's only writer after a handoff.
 * Uses the package's exported `rpc-entry`, so the child runs the CLI's own runtime factory
 * (settings, trust, auth, built-in extensions) instead of a host-side reconstruction.
 */
export class RpcChild {
  private process?: ChildProcess;
  private nextId = 0;
  private pending = new Map<string, { resolve: (value: RpcRecord) => void; reject: (error: Error) => void }>();
  private listeners = new Set<(record: RpcRecord) => void>();
  private stderr = "";
  readonly exited: Promise<number | null>;
  private resolveExit!: (code: number | null) => void;

  constructor(private readonly args: string[], private readonly cwd: string, private readonly entry = runningPiRpcEntry()) {
    this.exited = new Promise((resolve) => { this.resolveExit = resolve; });
  }

  start(): void {
    const entry = this.entry;
    if (!entry) throw new Error("The running pi installation does not provide an RPC entry.");
    // Own process group: Ctrl+C in the terminal reaches the host, which stops the child in order.
    // The child exits when its stdin closes, so it cannot outlive a crashed host as a second writer.
    const child = spawn(process.execPath, [entry, ...this.args], { cwd: this.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    this.process = child;
    child.stderr!.on("data", (data: Buffer) => { this.stderr = (this.stderr + data.toString()).slice(-16_384); });
    child.once("exit", (code) => {
      for (const { reject } of this.pending.values()) reject(new Error(`pi RPC host exited (${code}). ${this.stderr.slice(-2000)}`));
      this.pending.clear();
      this.resolveExit(code);
    });
    createInterface({ input: child.stdout! }).on("line", (line) => {
      let record: RpcRecord;
      try { record = JSON.parse(line) as RpcRecord; } catch { return; }
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
  get running(): boolean { return !!this.process && this.process.exitCode === null; }
  get diagnostics(): string { return this.stderr; }
  onRecord(listener: (record: RpcRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private write(record: Record<string, unknown>): void {
    if (!this.process?.stdin?.writable) throw new Error("pi RPC host is not running.");
    this.process.stdin.write(`${JSON.stringify(record)}\n`);
  }
  /** Sends a command and resolves with its `data`; rejects when the response reports failure. */
  async request<T = unknown>(type: string, payload: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<T> {
    const id = `h${++this.nextId}`;
    const response = await new Promise<RpcRecord>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`pi RPC ${type} timed out.`)); }, timeoutMs);
      timer.unref?.();
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
    if (!child || child.exitCode !== null) return;
    child.stdin?.end();
    const terminate = setTimeout(() => child.kill("SIGTERM"), 2000);
    const kill = setTimeout(() => child.kill("SIGKILL"), 5000);
    await this.exited;
    clearTimeout(terminate);
    clearTimeout(kill);
  }
}
