/** Test fixture for the formal /web foreground handoff: records which process owns the session and opens a dialog. */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function evidence(event: string, data: Record<string, unknown> = {}) {
  const path = process.env.PI_M0_EVENTS_PATH;
  if (path) appendFileSync(path, `${JSON.stringify({ at: Date.now(), event, ...data })}\n`, { mode: 0o600 });
}

export default function handoffFixture(pi: ExtensionAPI) {
  // Like extensions that persist state after an asynchronous step: write well after the turn settled.
  const appendDelay = Number(process.env.PI_M0_APPEND_DELAY ?? 0);
  let appended = 0;
  if (appendDelay > 0) pi.on("agent_end", (_event, ctx) => {
    if (ctx.mode !== "rpc") return;
    setTimeout(() => { pi.appendEntry("m3-probe", { run: ++appended }); evidence("m3_probe_append", { pid: process.pid, run: appended }); }, appendDelay);
  });
  pi.on("session_start", (event, ctx) => {
    evidence("m3_session", { pid: process.pid, mode: ctx.mode, reason: event.reason, sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(), cwd: ctx.cwd });
  });
  pi.on("session_shutdown", (event) => { evidence("m3_shutdown", { pid: process.pid, reason: event.reason }); });
  pi.registerCommand("m3-confirm", {
    description: "Test fixture: ask for confirmation through the extension UI.",
    async handler(_args, ctx) {
      const confirmed = await ctx.ui.confirm("M3 dialog", "Allow the fixture action?");
      evidence("m3_dialog", { pid: process.pid, mode: ctx.mode, confirmed });
    },
  });
  pi.registerCommand("m3-dialog", {
    description: "Fixture: exercise one public RPC extension dialog.",
    async handler(args, ctx) {
      const method = args.trim();
      let value: unknown;
      if (method === "select") value = await ctx.ui.select("M3 select", ["alpha", "beta"]);
      else if (method === "input") value = await ctx.ui.input("M3 input", "Fixture text");
      else if (method === "editor") value = await ctx.ui.editor("M3 editor", "Initial fixture draft");
      else if (method === "timeout") value = await ctx.ui.confirm("M3 timeout", "Do not answer", { timeout: 500 });
      else value = await ctx.ui.confirm("M3 cancel", "Cancel from browser");
      evidence("m3_dialog_value", { pid: process.pid, mode: ctx.mode, method, value });
    },
  });
  pi.registerCommand("m3-ui", {
    description: "Fixture: public extension status, widget, title, notify and editor updates.",
    async handler(args, ctx) {
      const clear = args.trim() === "clear";
      ctx.ui.setStatus("m3-status", clear ? undefined : "M3 status ready");
      ctx.ui.setWidget("m3-widget", clear ? undefined : ["M3 widget first", "M3 widget second"], { placement: "belowEditor" });
      ctx.ui.setTitle(clear ? "M3 cleared" : "M3 fixture title");
      if (!clear) { ctx.ui.setEditorText("M3 extension draft"); ctx.ui.notify("M3 notification", "info"); }
      evidence("m3_ui", { pid: process.pid, mode: ctx.mode, clear });
    },
  });

}
