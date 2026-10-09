/** Test fixture for the /web handoff spike: records which process owns the session and opens a dialog. */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function evidence(event: string, data: Record<string, unknown> = {}) {
  const path = process.env.PI_M0_EVENTS_PATH;
  if (path) appendFileSync(path, `${JSON.stringify({ at: Date.now(), event, ...data })}\n`, { mode: 0o600 });
}

export default function handoffFixture(pi: ExtensionAPI) {
  pi.on("session_start", (event, ctx) => {
    evidence("m3_session", { pid: process.pid, mode: ctx.mode, reason: event.reason, sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile() });
  });
  pi.on("session_shutdown", (event) => { evidence("m3_shutdown", { pid: process.pid, reason: event.reason }); });
  pi.registerCommand("m3-confirm", {
    description: "Test fixture: ask for confirmation through the extension UI.",
    async handler(_args, ctx) {
      const confirmed = await ctx.ui.confirm("M3 dialog", "Allow the fixture action?");
      evidence("m3_dialog", { pid: process.pid, mode: ctx.mode, confirmed });
    },
  });
}
