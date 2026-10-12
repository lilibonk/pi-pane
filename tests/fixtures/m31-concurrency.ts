/** Local-only browser concurrency controls. Public extension API; no credentials or network. */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function evidence(event: string, data: Record<string, unknown> = {}) {
  const file = process.env.PI_M0_EVENTS_PATH;
  if (file) appendFileSync(file, `${JSON.stringify({ at: Date.now(), event, pid: process.pid, ...data })}\n`, { mode: 0o600 });
}

export default function concurrencyFixture(pi: ExtensionAPI) {
  if (process.env.PI_OFFLINE !== "1") throw new Error("Concurrency fixture requires isolated offline mode.");
  let veto = false;
  pi.on("session_start", (event, ctx) => evidence("m31_concurrency_session", {
    mode: ctx.mode, reason: event.reason, cwd: ctx.cwd, processCwd: process.cwd(),
    sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(),
  }));
  pi.on("session_shutdown", (event, ctx) => evidence("m31_concurrency_shutdown", { mode: ctx.mode, reason: event.reason }));
  pi.on("session_before_switch", event => {
    evidence("m31_concurrency_before_switch", { veto, reason: event.reason });
    if (veto) return { cancel: true };
  });
  for (const enabled of [true, false]) pi.registerCommand(`m31-veto-${enabled ? "on" : "off"}`, {
    description: `Test fixture: ${enabled ? "enable" : "disable"} session reload veto.`,
    handler: async (_args, ctx) => {
      veto = enabled;
      evidence("m31_concurrency_veto", { enabled, cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() });
      ctx.ui.notify(`M31 concurrency veto ${enabled ? "on" : "off"}`, "info");
    },
  });
  pi.registerCommand("m31-page-command", {
    description: "Test fixture: confirm a native command remains usable during another page's login.",
    handler: async (_args, ctx) => {
      evidence("m31_concurrency_command", { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() });
      ctx.ui.notify("M31 concurrent command completed", "info");
    },
  });
}
