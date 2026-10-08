import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ProtocolError } from "../protocol/index.js";
import { Bridge } from "./bridge.js";
import { Hub, type ExternalAccess } from "./hub.js";
import { missingHostCapabilities, readPaneSettings } from "./config.js";
import { qrLines, qrWidth } from "./qr.js";

export const IMPLEMENTATION_VERSION = "m2.0";
const QR_WIDGET = "pi-pane-qr";
const QR_VISIBLE_MS = 120_000;
export const PROCESS_STATE_KEY = Symbol.for("pi-pane.process.v1");
export interface ProcessState {
  implementationVersion: string;
  autoStartApplied: boolean;
  desiredRunning: boolean;
  generation: number;
  hub?: Hub;
  bridge?: Bridge;
  starting?: Promise<Hub>;
}
/** This record survives stop/reload. It owns no sockets until /web or initial --web. */
export function getProcessState(): ProcessState {
  const globals = globalThis as unknown as Record<symbol, ProcessState | undefined>;
  return globals[PROCESS_STATE_KEY] ??= {
    implementationVersion: IMPLEMENTATION_VERSION, autoStartApplied: false, desiredRunning: false, generation: 0,
  };
}

interface WebArgs {
  action: "start" | "stop" | "status" | "rotate" | "qr";
  host?: string;
  port?: number;
  noOpen: boolean;
  publicOrigin?: string;
  tlsCert?: string;
  tlsKey?: string;
  proxy?: boolean;
}
const ADDRESS_KEYS = ["host", "port", "publicOrigin", "tlsCert", "tlsKey", "proxy"] as const;
export function parseWebArgs(text: string): WebArgs {
  const parts = text.trim() ? text.trim().split(/\s+/) : [];
  const args: WebArgs = { action: "start", noOpen: false };
  if (["stop", "status", "qr"].includes(parts[0] ?? "")) args.action = parts.shift() as "stop" | "status" | "qr";
  const value = (name: string, index: number): string => {
    const next = parts[index];
    if (!next || next.startsWith("--")) throw new ProtocolError("invalid_args", `${name} needs a value.`);
    return next;
  };
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === "--no-open") args.noOpen = true;
    else if (part === "--rotate") args.action = "rotate";
    else if (part === "--proxy") args.proxy = true;
    else if (part === "--host") args.host = value(part, ++i);
    else if (part === "--public-origin") args.publicOrigin = value(part, ++i);
    else if (part === "--tls-cert") args.tlsCert = value(part, ++i);
    else if (part === "--tls-key") args.tlsKey = value(part, ++i);
    else if (part === "--port") {
      const value = parts[++i];
      if (!value || !/^\d+$/.test(value)) throw new ProtocolError("invalid_args", "--port needs an integer.");
      args.port = Number(value);
      if (args.port < 1 || args.port > 65535) throw new ProtocolError("invalid_args", "Port must be between 1 and 65535.");
    } else throw new ProtocolError("invalid_args", `Unknown /web argument: ${part}`);
  }
  if (args.action !== "start" && ADDRESS_KEYS.some((key) => args[key] !== undefined))
    throw new ProtocolError("invalid_args", "Address options apply only when starting the service.");
  return args;
}
/** The password is read from the environment only: never from arguments, flags or settings. */
async function externalAccess(args: WebArgs, cwd: string): Promise<ExternalAccess | undefined> {
  if (!args.publicOrigin) {
    if (args.tlsCert || args.tlsKey || args.proxy) throw new ProtocolError("invalid_args", "TLS and proxy options need --public-origin https://host[:port].");
    return undefined;
  }
  const password = process.env.PI_PANE_PASSWORD;
  if (!password) throw new ProtocolError("password_required", "External access needs the PI_PANE_PASSWORD environment variable (at least 12 characters).");
  if (!!args.tlsCert !== !!args.tlsKey) throw new ProtocolError("invalid_args", "Provide both --tls-cert and --tls-key.");
  if (!args.tlsCert && !args.proxy) throw new ProtocolError("transport_required", "External access needs --tls-cert/--tls-key or --proxy; plain HTTP is refused.");
  if (args.tlsCert && args.proxy) throw new ProtocolError("invalid_args", "Choose either direct TLS or proxy mode.");
  let tls: ExternalAccess["tls"];
  if (args.tlsCert) {
    try { tls = { cert: await readFile(resolve(cwd, args.tlsCert)), key: await readFile(resolve(cwd, args.tlsKey!)) }; }
    catch { throw new ProtocolError("tls_unavailable", "The TLS certificate or key could not be read."); }
  }
  return { publicOrigin: args.publicOrigin, password, ...(tls ? { tls } : { proxy: true }) };
}

export default function piPane(pi: ExtensionAPI): void {
  const state = getProcessState();
  let ownedBridge: Bridge | undefined;
  let ownedContext: ExtensionContext | undefined;
  const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../web-dist");

  pi.registerFlag("web", { type: "boolean", default: false, description: "Mirror the current TUI session in a local browser." });
  pi.registerFlag("web-host", { type: "string", description: "Listen address for pi-pane (loopback unless external access is configured)." });
  pi.registerFlag("web-port", { type: "string", description: "Explicit local port for pi-pane." });
  pi.registerFlag("web-no-open", { type: "boolean", description: "Start pi-pane without opening a browser." });
  pi.registerFlag("web-public-origin", { type: "string", description: "External access: https://host[:port]; needs PI_PANE_PASSWORD." });
  pi.registerFlag("web-tls-cert", { type: "string", description: "External access: TLS certificate file." });
  pi.registerFlag("web-tls-key", { type: "string", description: "External access: TLS private key file." });
  pi.registerFlag("web-proxy", { type: "boolean", description: "External access through a same-machine TLS proxy." });

  const notify = (ctx: ExtensionContext, text: string, error = false): void => {
    if (ctx.mode === "tui") ctx.ui.notify(text, error ? "error" : "info");
    else process.stderr.write(`pi-pane: ${text}\n`);
  };
  const updateStatus = (): void => {
    if (!ownedContext || !ownedBridge?.isCurrent()) return;
    try { ownedContext.ui.setStatus("pi-pane", state.hub?.running ? `🌐 web: ${state.hub.connectionCount} viewer${state.hub.connectionCount === 1 ? "" : "s"}` : undefined); } catch { /* stale UI */ }
  };
  let qrTimer: ReturnType<typeof setTimeout> | undefined;
  const hideQr = (): void => {
    if (qrTimer) { clearTimeout(qrTimer); qrTimer = undefined; }
    try { if (ownedBridge?.isCurrent()) ownedContext?.ui.setWidget(QR_WIDGET, undefined); } catch { /* stale UI */ }
  };
  const stop = async (): Promise<void> => {
    hideQr();
    state.desiredRunning = false;
    const hub = state.hub;
    state.hub = undefined;
    await hub?.close();
    updateStatus();
  };
  const flagArgs = (): WebArgs => {
    const config = readPaneSettings(pi.getSettings());
    const port = pi.getFlag("web-port");
    const noOpen = pi.getFlag("web-no-open");
    const parsed = parseWebArgs(port === undefined ? "" : `--port ${String(port)}`);
    const strings: Partial<WebArgs> = {};
    for (const [flag, key] of [["web-host", "host"], ["web-public-origin", "publicOrigin"], ["web-tls-cert", "tlsCert"], ["web-tls-key", "tlsKey"]] as const) {
      const value = pi.getFlag(flag);
      if (typeof value === "string" && value) strings[key] = value;
    }
    const proxy = pi.getFlag("web-proxy");
    return { ...config, ...parsed, ...strings, ...(proxy === true ? { proxy: true } : {}),
      noOpen: typeof noOpen === "boolean" ? noOpen : config.noOpen ?? false };
  };
  const openBrowser = (url: string, ctx: ExtensionContext): void => {
    const executable = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
    const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
    const child = spawn(executable, args, { detached: true, stdio: "ignore", shell: false });
    child.once("error", () => notify(ctx, "Browser could not open; use the URL shown in the terminal.", true));
    child.unref();
  };
  const start = async (ctx: ExtensionContext, args: WebArgs): Promise<Hub> => {
    if (ctx.mode !== "tui") throw new ProtocolError("unsupported_mode", "--web is available only in TUI mode; no service was started.");
    const bridge = ownedBridge;
    if (!bridge?.isCurrent() || state.bridge !== bridge) throw new ProtocolError("stale_session", "Session is not ready. Run /web after it finishes loading.");
    if (state.hub?.running) {
      if ((args.port !== undefined && args.port !== state.hub.port) || (args.host !== undefined && args.host !== state.hub.host) ||
          (args.publicOrigin !== undefined && new URL(args.publicOrigin).origin !== state.hub.origin))
        throw new ProtocolError("already_running", "Stop the current service before changing its address.");
      return state.hub;
    }
    if (state.starting) return state.starting;
    const external = await externalAccess(args, ctx.cwd);
    // Fail before listening: wrong combinations never fall back to a weaker mode.
    new Hub({ host: args.host ?? "127.0.0.1", port: args.port ?? 7878, webRoot, ...(external ? { external } : {}) });
    state.desiredRunning = true;
    const generation = state.generation;
    state.starting = (async () => {
      const maxAttempts = args.port === undefined ? 20 : 1;
      let lastError: unknown;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const hub = new Hub({ host: args.host ?? "127.0.0.1", port: args.port ?? 7878 + attempt, webRoot, onConnectionCount: updateStatus, ...(external ? { external } : {}) });
        try {
          await hub.start();
          if (state.generation !== generation || !state.desiredRunning || !bridge.isCurrent()) {
            await hub.close();
            throw new ProtocolError("start_cancelled", "Service start was cancelled by a session change or stop.");
          }
          state.hub = hub;
          hub.bindBridge(bridge, "web_start");
          updateStatus();
          return hub;
        } catch (error) {
          await hub.close();
          lastError = error;
          if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") break;
        }
      }
      state.desiredRunning = false;
      throw lastError ?? new Error("Could not start pi-pane.");
    })();
    try { return await state.starting; } finally { state.starting = undefined; }
  };
  const showUrl = (ctx: ExtensionContext, hub: Hub, noOpen: boolean): void => {
    const login = hub.mode === "password" ? ` · login with PI_PANE_PASSWORD · listening on ${hub.listenAddress}` : "";
    notify(ctx, `pi-pane: ${hub.url}${login}${noOpen ? "" : " (opening browser)"}`);
    if (!noOpen) openBrowser(hub.url, ctx);
  };
  const showQr = (ctx: ExtensionContext, hub: Hub): void => {
    if (hub.mode !== "password") throw new ProtocolError("qr_local", "The QR code is for external access. Start with --public-origin and TLS or --proxy; local links only work on this machine.");
    hideQr();
    // A component, not a string array: string widgets are cut at 10 lines and a QR code needs about 20.
    const lines = qrLines(hub.url);
    const width = qrWidth(hub.url);
    const caption = `pi-pane: scan to open ${hub.origin} · enter the password separately · hides in 2 minutes`;
    ctx.ui.setWidget(QR_WIDGET, () => ({
      render: (columns: number) => columns >= width
        ? [...lines, caption.slice(0, columns)]
        : ["pi-pane: the terminal is too narrow for the QR code; widen it or use the link.".slice(0, columns)],
      invalidate: () => {},
    }));
    qrTimer = setTimeout(hideQr, QR_VISIBLE_MS);
    qrTimer.unref?.();
  };

  pi.registerCommand("web", {
    description: "Mirror this TUI in a browser. /web [--no-open], stop, status, qr, --rotate; external access: --public-origin with --tls-cert/--tls-key or --proxy.",
    handler: async (text, ctx) => {
      try {
        if (ctx.mode !== "tui") throw new ProtocolError("unsupported_mode", "/web is available only in TUI mode; no service was started.");
        const explicit = parseWebArgs(text);
        // Revocation and status must remain available even when startup settings are invalid.
        if (explicit.action === "stop") { await stop(); notify(ctx, "pi-pane stopped."); }
        else if (explicit.action === "status") notify(ctx, state.hub?.running
          ? `pi-pane: ${state.hub.url} · ${state.hub.connectionCount} viewer(s)${state.hub.mode === "password" ? ` · ${state.hub.loginCount} login(s) · listening on ${state.hub.listenAddress}` : ""}${state.hub.switching ? " · switching" : ""}`
          : "pi-pane stopped.");
        else if (explicit.action === "rotate") {
          if (!state.hub?.running) throw new ProtocolError("not_running", "pi-pane is stopped. Run /web first.");
          let noOpen = true;
          try { noOpen = explicit.noOpen || flagArgs().noOpen; } catch { /* Invalid startup config cannot block revocation. */ }
          hideQr();
          state.hub.rotateToken(); showUrl(ctx, state.hub, noOpen);
        } else if (explicit.action === "qr") {
          if (!state.hub?.running) throw new ProtocolError("not_running", "pi-pane is stopped. Run /web first.");
          showQr(ctx, state.hub);
        } else {
          const defaults = flagArgs();
          const args = { ...defaults, ...explicit, noOpen: explicit.noOpen || defaults.noOpen };
          showUrl(ctx, await start(ctx, args), args.noOpen);
        }
      } catch (error) { notify(ctx, error instanceof Error ? error.message : "pi-pane operation failed.", true); }
    },
  });

  pi.on("session_start", async (event, ctx) => {
    if (ctx.mode !== "tui") {
      if (pi.getFlag("web") === true) notify(ctx, "--web is available only in TUI mode; no service was started.", true);
      return;
    }
    const missing = missingHostCapabilities(pi, ctx);
    if (missing.length) {
      await stop();
      notify(ctx, `pi-pane requires the pi 1.0.4 extension capabilities; missing: ${missing.join(", ")}. No service was started.`, true);
      return;
    }
    if (state.implementationVersion !== IMPLEMENTATION_VERSION) {
      await stop();
      state.implementationVersion = IMPLEMENTATION_VERSION;
    }
    state.bridge?.dispose();
    const generation = ++state.generation;
    ownedContext = ctx;
    ownedBridge = new Bridge({ pi, ctx, generation, isCurrent: () => state.generation === generation });
    state.bridge = ownedBridge;
    if (state.hub?.running && state.desiredRunning) {
      state.hub.setConnectionListener(updateStatus);
      state.hub.bindBridge(ownedBridge, event.reason);
    }
    if (event.reason === "startup" && !state.autoStartApplied) {
      state.autoStartApplied = true;
      if (pi.getFlag("web") === true) {
        try { const args = flagArgs(); showUrl(ctx, await start(ctx, args), args.noOpen); }
        catch (error) { notify(ctx, error instanceof Error ? error.message : "pi-pane failed to start.", true); }
      }
    }
    updateStatus();
  });
  pi.on("session_shutdown", async (event) => {
    hideQr();
    const bridge = ownedBridge;
    if (!bridge || state.bridge !== bridge) { bridge?.dispose(); return; }
    state.generation++;
    state.bridge = undefined;
    bridge.dispose();
    ownedBridge = undefined;
    if (event.reason === "quit") await stop();
    else if (state.hub?.running) {
      const hub = state.hub;
      const generation = state.generation;
      hub.suspend(event.reason, () => {
        if (state.generation === generation && state.hub === hub) {
          state.desiredRunning = false;
          state.hub = undefined;
        }
      });
    }
  });

  const observe = pi.on as unknown as (event: string, handler: (event: { type: string; [key: string]: unknown }) => void) => () => void;
  for (const name of [
    "agent_start", "agent_end", "agent_settled", "turn_end", "message_start", "message_update", "message_end",
    "tool_execution_start", "tool_execution_update", "tool_execution_end", "model_select", "thinking_level_select",
    "ui_prompt_start", "ui_prompt_end", "session_before_compact", "session_compact", "session_compact_failed",
    "session_before_tree", "session_tree", "session_info_changed", "input",
  ]) observe(name, (event) => {
    try { ownedBridge?.handleEvent(event); }
    catch { /* Projection failures must not interrupt the host agent. Integration tests exercise this boundary. */ }
  });
}
