/** Test fixture for the M3.1 gates: records runtime cwd, trust and shutdown behaviour. Local only. */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function evidence(event: string, data: Record<string, unknown> = {}) {
  const path = process.env.PI_M0_EVENTS_PATH;
  if (path) appendFileSync(path, `${JSON.stringify({ at: Date.now(), event, pid: process.pid, ...data })}\n`, { mode: 0o600 });
}

export default function m31Probe(pi: ExtensionAPI) {
  pi.on("session_start", (event, ctx) => {
    evidence("m31_session", { reason: event.reason, mode: ctx.mode, ctxCwd: ctx.cwd, processCwd: process.cwd(), argv: process.argv.slice(2),
      sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile() });
  });
  // A global extension that answers the project trust question, like a policy extension would.
  const trust = process.env.PI_M31_TRUST;
  if (trust === "yes" || trust === "no") pi.on("project_trust", (event) => {
    evidence("m31_project_trust", { cwd: event.cwd, answer: trust });
    return { trusted: trust };
  });
  pi.on("session_before_switch", (event) => {
    evidence("m31_before_switch", { reason: event.reason });
    if (process.env.PI_M31_VETO_SWITCH === "1") return { cancel: true };
  });
  pi.on("session_shutdown", async (event, ctx) => {
    evidence("m31_shutdown_begin", { reason: event.reason, mode: ctx.mode });
    // Shutdown probes describe the RPC child; a TUI running the same fixture just exits.
    if (ctx.mode !== "rpc") { evidence("m31_shutdown_end", { reason: event.reason, mode: ctx.mode }); return; }
    if (process.env.PI_M31_SHUTDOWN_APPEND === "1") { pi.appendEntry("m31-shutdown", { at: "shutdown" }); evidence("m31_shutdown_append"); }
    const delay = Number(process.env.PI_M31_SHUTDOWN_DELAY ?? 0);
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    if (process.env.PI_M31_SHUTDOWN_DIALOG === "1") {
      evidence("m31_shutdown_dialog_open");
      const confirmed = await ctx.ui.confirm("M31 shutdown", "Allow shutdown?");
      evidence("m31_shutdown_dialog_result", { confirmed });
    }
    evidence("m31_shutdown_end", { reason: event.reason });
  });
  pi.registerCommand("m31-switch", {
    description: "Test fixture: the child itself switches to another session file.",
    async handler(args, ctx) {
      const result = await ctx.switchSession(args.trim());
      evidence("m31_switch_result", { cancelled: result.cancelled });
    },
  });
}
