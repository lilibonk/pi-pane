import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSecureContext } from "node:tls";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ProtocolError } from "../protocol/index.js";
import { Hub, type ExternalAccess } from "./hub.js";
import { readPaneSettings } from "./config.js";
import { qrLines, qrWidth } from "./qr.js";
import { HandoffHost, LaunchProfile, type HandoffTarget } from "./handoff.js";
import { runningPiRpcEntry } from "./rpc-child.js";
import { SessionFileLock } from "./session-lock.js";

export const IMPLEMENTATION_VERSION = "m3.handoff.1";
export const PROCESS_STATE_KEY = Symbol.for("pi-pane.process.handoff.v1");
export interface ProcessState {
  implementationVersion: string;
  generation: number;
  lock?: SessionFileLock;
  hub?: Hub;
  host?: HandoffHost;
  handoff?: HandoffTarget & { args: WebArgs; external?: ExternalAccess; webRoot: string };
}
/** No Bridge, Hub or listening socket exists during TUI operation. */
export function getProcessState(): ProcessState {
  const globals = globalThis as unknown as Record<symbol, ProcessState | undefined>;
  return globals[PROCESS_STATE_KEY] ??= { implementationVersion: IMPLEMENTATION_VERSION, generation: 0 };
}
export interface WebArgs {
  host?: string;
  port?: number;
  noOpen: boolean;
  publicOrigin?: string;
  tlsCert?: string;
  tlsKey?: string;
  proxy?: boolean;
}
export function parseWebArgs(text: string): WebArgs {
  const parts = text.trim() ? text.trim().split(/\s+/) : [];
  const args: WebArgs = { noOpen: false };
  const value = (name: string, index: number): string => {
    const next = parts[index];
    if (!next || next.startsWith("--")) throw new ProtocolError("invalid_args", `${name} needs a value.`);
    return next;
  };
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === "--no-open") args.noOpen = true;
    else if (part === "--proxy") args.proxy = true;
    else if (part === "--host") args.host = value(part, ++i);
    else if (part === "--public-origin") args.publicOrigin = value(part, ++i);
    else if (part === "--tls-cert") args.tlsCert = value(part, ++i);
    else if (part === "--tls-key") args.tlsKey = value(part, ++i);
    else if (part === "--port") {
      const raw = value(part, ++i);
      if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) throw new ProtocolError("invalid_args", "Port must be between 1 and 65535.");
      args.port = Number(raw);
    } else throw new ProtocolError("invalid_args", `Unknown /web argument: ${part}. /web only hands off; stop with Ctrl+C.`);
  }
  return args;
}
/** The access password is read only from the environment. */
async function externalAccess(args: WebArgs, cwd: string): Promise<ExternalAccess | undefined> {
  if (!args.publicOrigin) {
    if (args.tlsCert || args.tlsKey || args.proxy) throw new ProtocolError("invalid_args", "TLS and proxy options need --public-origin https://host[:port].");
    return undefined;
  }
  const password = process.env.PI_PANE_PASSWORD;
  if (!password) throw new ProtocolError("password_required", "External access needs PI_PANE_PASSWORD (at least 12 characters).");
  if (!!args.tlsCert !== !!args.tlsKey) throw new ProtocolError("invalid_args", "Provide both --tls-cert and --tls-key.");
  if (!args.tlsCert && !args.proxy) throw new ProtocolError("transport_required", "External access needs TLS or --proxy; plain HTTP is refused.");
  if (args.tlsCert && args.proxy) throw new ProtocolError("invalid_args", "Choose either direct TLS or proxy mode.");
  let tls: ExternalAccess["tls"];
  if (args.tlsCert) {
    try { tls = { cert: await readFile(resolve(cwd, args.tlsCert)), key: await readFile(resolve(cwd, args.tlsKey!)) }; }
    catch { throw new ProtocolError("tls_unavailable", "The TLS certificate or key could not be read."); }
    try { createSecureContext({ ...tls, minVersion: "TLSv1.2" }); }
    catch { throw new ProtocolError("tls_unavailable", "The TLS certificate and key could not form a valid TLS context."); }
  }
  return { publicOrigin: args.publicOrigin, password, ...(tls ? { tls } : { proxy: true }) };
}

export default function piPane(pi: ExtensionAPI): void {
  const state = getProcessState();
  const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../web-dist");
  // Configuration flags remain; --web startup and the mirror command family are removed.
  pi.registerFlag("web-host", { type: "string", description: "Listen address for /web (loopback by default)." });
  pi.registerFlag("web-port", { type: "string", description: "Explicit port for /web." });
  pi.registerFlag("web-no-open", { type: "boolean", description: "Do not open a browser after /web handoff." });
  pi.registerFlag("web-public-origin", { type: "string", description: "External HTTPS origin; requires PI_PANE_PASSWORD." });
  pi.registerFlag("web-tls-cert", { type: "string", description: "TLS certificate file for /web." });
  pi.registerFlag("web-tls-key", { type: "string", description: "TLS private key file for /web." });
  pi.registerFlag("web-proxy", { type: "boolean", description: "External access through a same-machine TLS proxy." });

  const notify = (ctx: ExtensionContext, text: string, error = false): void => {
    if (ctx.mode === "tui") ctx.ui.notify(text, error ? "error" : "info");
    else process.stderr.write(`pi-pane: ${text}\n`);
  };
  const defaults = (): WebArgs => {
    const config = readPaneSettings(pi.getSettings());
    const port = pi.getFlag("web-port");
    const parsed = parseWebArgs(port === undefined ? "" : `--port ${String(port)}`);
    const strings: Partial<WebArgs> = {};
    for (const [flag, key] of [["web-host", "host"], ["web-public-origin", "publicOrigin"], ["web-tls-cert", "tlsCert"], ["web-tls-key", "tlsKey"]] as const) {
      const val = pi.getFlag(flag);
      if (typeof val === "string" && val) strings[key] = val;
    }
    return { ...config, ...parsed, ...strings,
      ...(pi.getFlag("web-proxy") === true ? { proxy: true } : {}),
      noOpen: typeof pi.getFlag("web-no-open") === "boolean" ? !!pi.getFlag("web-no-open") : config.noOpen ?? false };
  };

  pi.on("session_start", async (_event, ctx) => {
    // Ordinary TUIs never take the lock, so several terminals can open one session as in plain pi.
    // Only a session that a /web host currently owns gets a warning; nothing is closed.
    if (ctx.mode !== "tui") return;
    state.generation++;
    const file = ctx.sessionManager.getSessionFile();
    if (!file) return;
    const owner = await SessionFileLock.inspect(file).catch(() => undefined);
    if (owner && owner.pid !== process.pid)
      notify(ctx, `pi-pane: this session is running in a /web browser host (pid ${owner.pid}). Writing here conflicts with it; stop that host with Ctrl+C first.`, true);
  });
  pi.registerCommand("web", {
    description: "Hand this idle session to a foreground browser service. /web [--no-open]; Ctrl+C stops and prints the terminal resume command.",
    handler: async (text, ctx) => {
      try {
        if (ctx.mode !== "tui") throw new ProtocolError("unsupported_mode", "/web needs an interactive TUI session.");
        if (process.platform === "win32") throw new ProtocolError("unsupported_platform", "/web handoff is currently supported on macOS and Linux; Windows is not validated.");
        if (state.handoff) throw new ProtocolError("busy", "A handoff is already pending.");
        if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new ProtocolError("busy", "Wait until pi is idle and the queue is empty before handing off.");
        const sessionFile = ctx.sessionManager.getSessionFile();
        if (!sessionFile) throw new ProtocolError("no_session_file", "Handoff needs a saved session (not --no-session).");
        const generation = state.generation;
        const assertReady = (): void => {
          if (state.handoff || generation !== state.generation) throw new ProtocolError("stale_session", "The session changed while preparing the handoff; run /web again.");
          if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new ProtocolError("busy", "Wait until pi is idle and the queue is empty before handing off.");
        };
        if (!runningPiRpcEntry()) throw new ProtocolError("unsupported_host", "The running pi installation must provide the pi 1.1.0 RPC entry.");
        const argv = process.argv.slice(2);
        // Fail ambiguous CLI reconstruction while the TUI still exists, and pin relative launch
        // paths to the directory pi was started in before any other project is opened.
        const profile = new LaunchProfile(argv, process.cwd());
        const explicit = parseWebArgs(text);
        const config = defaults();
        const args = { ...config, ...explicit, noOpen: explicit.noOpen || config.noOpen };
        const external = await externalAccess(args, ctx.cwd);
        assertReady();
        // Validate access configuration and TLS before leaving the TUI; do not listen yet.
        new Hub({ host: args.host ?? "127.0.0.1", port: args.port ?? 7878, webRoot, ...(external ? { external } : {}) });
        // Ownership is taken only now. A session another /web host owns refuses the handoff; the TUI stays.
        const lock = await SessionFileLock.acquire(sessionFile);
        try {
          await lock.acceptChanges(); // TUI's own writes are complete before ownership is transferred.
          assertReady();
        } catch (error) { await lock.release(); throw error; }
        state.lock = lock;
        state.handoff = { sessionFile, sessionDir: ctx.sessionManager.getSessionDir(), cwd: ctx.cwd, argv, profile,
          ...(ctx.model ? { model: { provider: ctx.model.provider, id: ctx.model.id } } : {}),
          theme: ctx.ui.theme, themes: ctx.ui.getAllThemes(), lock, args, external, webRoot };
        installExitTakeover(() => runHandoff(state));
        notify(ctx, "pi-pane: handing this session to the browser…");
        ctx.shutdown();
      } catch (error) { notify(ctx, error instanceof Error ? error.message : "pi-pane handoff failed.", true); }
    },
  });
}

/** pi has no public foreground exit takeover hook. Intercept exactly one normal TUI exit. */
export function installExitTakeover(run: () => Promise<number>): void {
  const original = process.exit;
  process.exit = ((code?: number) => {
    process.exit = original;
    if (code && code !== 0) { original(code); return undefined as never; }
    void run().then((final) => original(final), () => original(1));
    return undefined as never;
  }) as typeof process.exit;
}
function write(text: string): void { try { process.stdout.write(text); } catch { /* closed terminal */ } }
export function resumeCommand(cwd: string, sessionFile: string): string {
  const quote = (text: string): string => `'${text.replace(/'/g, "'\\''")}'`;
  return `cd ${quote(cwd)} && pi --session ${quote(sessionFile)}`;
}
async function runHandoff(state: ProcessState): Promise<number> {
  const target = state.handoff;
  state.handoff = undefined;
  if (!target) return 1;
  process.stdout.on("error", () => { /* closed terminal */ });
  let hub: Hub | undefined;
  let host: HandoffHost | undefined;
  let stopRequested = false;
  let resolveStop!: (code: number) => void;
  const stopped = new Promise<number>((resolve) => { resolveStop = resolve; });
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  const onSignal = (): void => { stopRequested = true; resolveStop(0); };
  for (const signal of signals) process.on(signal, onSignal);
  let exitCode = 1;
  try {
    // The TUI's shutdown handlers may append final metadata before disposal.
    // Only now is its last write finished; retain the same ownership sidecar.
    await target.lock?.acceptChanges();
    const attempts = target.args.port === undefined ? 20 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      hub = new Hub({ host: target.args.host ?? "127.0.0.1", port: target.args.port ?? 7878 + attempt,
        webRoot: target.webRoot, ...(target.external ? { external: target.external } : {}),
        onCredentialRotation: (url) => {
          write(`\npi-pane: access credentials rotated. Existing visitors must reconnect.\n  ${url}\n`);
          if (target.external && (process.stdout.columns ?? 0) >= qrWidth(url)) write(`${qrLines(url).join("\n")}\n`);
        } });
      try { await hub.start(); break; }
      catch (error) {
        await hub.close(); hub = undefined;
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt === attempts - 1) throw error;
      }
    }
    if (!hub || stopRequested) return 0;
    state.hub = hub;
    host = new HandoffHost(hub, target, (line) => write(`${line}\n`));
    state.host = host;
    await host.start();
    if (stopRequested) return 0;
    write(`\npi-pane: this session now runs in the browser.\n  ${hub.url}\n  Workspace: ${host.cwd}\n  Stop: Ctrl+C\n`);
    if (hub.mode === "password") {
      write(`  Login with PI_PANE_PASSWORD · listening on ${hub.listenAddress}\n`);
      if ((process.stdout.columns ?? 0) >= qrWidth(hub.url)) write(`${qrLines(hub.url).join("\n")}\n  Scan to open ${hub.origin} · enter the password separately\n`);
      else write("  Widen the terminal to display the QR code; the link above is ready.\n");
    }
    if (!target.args.noOpen) {
      const executable = process.platform === "darwin" ? "open" : "xdg-open";
      try { spawn(executable, [hub.url], { detached: true, stdio: "ignore", shell: false }).on("error", () => write("pi-pane: browser did not open; use the link above.\n")).unref(); } catch { /* URL available */ }
    }
    // Supervise the host, not one child: a planned replacement swaps children without ending the service.
    exitCode = await Promise.race([stopped, host.finished.then(({ exit, planned }) => {
      if (planned) return 0;
      write(`\npi-pane: the RPC session host exited (${exit}); stopping service. No automatic restart.\n`);
      return 1;
    })]);
  } catch (error) { write(`\npi-pane: handoff failed: ${error instanceof Error ? error.message : String(error)}\n`); }
  finally {
    for (const signal of signals) process.off(signal, onSignal);
    const file = host?.sessionFile ?? target.sessionFile;
    const cwd = host?.cwd ?? target.cwd;
    // Keep lock until the child has actually exited. A late second signal uses OS defaults.
    try { await host?.stop(); }
    catch (error) { exitCode = 1; write(`pi-pane: session cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`); }
    finally {
      try { await hub?.close(); }
      finally { await state.lock?.release(); }
    }
    state.lock = undefined; state.host = undefined; state.hub = undefined;
    if (file) write(`To resume this session: ${resumeCommand(cwd, file)}\n`);
  }
  return exitCode;
}
