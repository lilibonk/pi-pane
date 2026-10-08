import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ProtocolError } from "../protocol/index.js";
import { Bridge } from "./bridge.js";
import { Hub } from "./hub.js";
import { missingHostCapabilities, readPaneSettings } from "./config.js";

export const IMPLEMENTATION_VERSION = "m1.0";
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

interface WebArgs { action: "start" | "stop" | "status" | "rotate"; host?: string; port?: number; noOpen: boolean }
export function parseWebArgs(text: string): WebArgs {
  const parts = text.trim() ? text.trim().split(/\s+/) : [];
  const args: WebArgs = { action: "start", noOpen: false };
  if (["stop", "status"].includes(parts[0] ?? "")) args.action = parts.shift() as "stop" | "status";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === "--no-open") args.noOpen = true;
    else if (part === "--rotate") args.action = "rotate";
    else if (part === "--host") {
      args.host = parts[++i];
      if (!args.host) throw new ProtocolError("invalid_args", "--host needs an address.");
    } else if (part === "--port") {
      const value = parts[++i];
      if (!value || !/^\d+$/.test(value)) throw new ProtocolError("invalid_args", "--port needs an integer.");
      args.port = Number(value);
      if (args.port < 1 || args.port > 65535) throw new ProtocolError("invalid_args", "Port must be between 1 and 65535.");
    } else throw new ProtocolError("invalid_args", `Unknown /web argument: ${part}`);
  }
  if (args.action !== "start" && (args.host || args.port)) throw new ProtocolError("invalid_args", "Host/port options apply only when starting the service.");
  return args;
}

export default function piPane(pi: ExtensionAPI): void {
  const state = getProcessState();
  let ownedBridge: Bridge | undefined;
  let ownedContext: ExtensionContext | undefined;
  const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../web-dist");

  pi.registerFlag("web", { type: "boolean", default: false, description: "Mirror the current TUI session in a local browser." });
  pi.registerFlag("web-host", { type: "string", description: "Loopback listen address for pi-pane." });
  pi.registerFlag("web-port", { type: "string", description: "Explicit local port for pi-pane." });
  pi.registerFlag("web-no-open", { type: "boolean", description: "Start pi-pane without opening a browser." });

  const notify = (ctx: ExtensionContext, text: string, error = false): void => {
    if (ctx.mode === "tui") ctx.ui.notify(text, error ? "error" : "info");
    else process.stderr.write(`pi-pane: ${text}\n`);
  };
  const updateStatus = (): void => {
    if (!ownedContext || !ownedBridge?.isCurrent()) return;
    try { ownedContext.ui.setStatus("pi-pane", state.hub?.running ? `🌐 web: ${state.hub.connectionCount} viewer${state.hub.connectionCount === 1 ? "" : "s"}` : undefined); } catch { /* stale UI */ }
  };
  const stop = async (): Promise<void> => {
    state.desiredRunning = false;
    const hub = state.hub;
    state.hub = undefined;
    await hub?.close();
    updateStatus();
  };
  const flagArgs = (): WebArgs => {
    const config = readPaneSettings(pi.getSettings());
    const port = pi.getFlag("web-port");
    const host = pi.getFlag("web-host");
    const noOpen = pi.getFlag("web-no-open");
    const parsed = parseWebArgs(port === undefined ? "" : `--port ${String(port)}`);
    return { ...config, ...parsed, ...(typeof host === "string" ? { host } : {}),
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
      if ((args.port !== undefined && args.port !== state.hub.port) || (args.host !== undefined && args.host !== state.hub.host))
        throw new ProtocolError("already_running", "Stop the current service before changing its address.");
      return state.hub;
    }
    if (state.starting) return state.starting;
    state.desiredRunning = true;
    const generation = state.generation;
    state.starting = (async () => {
      const maxAttempts = args.port === undefined ? 20 : 1;
      let lastError: unknown;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const hub = new Hub({ host: args.host ?? "127.0.0.1", port: args.port ?? 7878 + attempt, webRoot, onConnectionCount: updateStatus });
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
    notify(ctx, `pi-pane: ${hub.url}${noOpen ? "" : " (opening browser)"}`);
    if (!noOpen) openBrowser(hub.url, ctx);
  };

  pi.registerCommand("web", {
    description: "Mirror this TUI in a local browser. /web [--no-open], stop, status, --rotate.",
    handler: async (text, ctx) => {
      try {
        if (ctx.mode !== "tui") throw new ProtocolError("unsupported_mode", "/web is available only in TUI mode; no service was started.");
        const explicit = parseWebArgs(text);
        // Revocation and status must remain available even when startup settings are invalid.
        if (explicit.action === "stop") { await stop(); notify(ctx, "pi-pane stopped."); }
        else if (explicit.action === "status") notify(ctx, state.hub?.running ? `pi-pane: ${state.hub.url} · ${state.hub.connectionCount} viewer(s)${state.hub.switching ? " · switching" : ""}` : "pi-pane stopped.");
        else if (explicit.action === "rotate") {
          if (!state.hub?.running) throw new ProtocolError("not_running", "pi-pane is stopped. Run /web first.");
          let noOpen = true;
          try { noOpen = explicit.noOpen || flagArgs().noOpen; } catch { /* Invalid startup config cannot block revocation. */ }
          state.hub.rotateToken(); showUrl(ctx, state.hub, noOpen);
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
