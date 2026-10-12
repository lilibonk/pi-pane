/** Local-only compatibility probe: one explicit marker makes one RPC shutdown need a dialog. */
import { appendFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function compatProbe(pi: ExtensionAPI) {
  // Let the real page exercise its explicit Apply button after a saved change.
  // This is the same public extension veto that a real extension can return.
  pi.on("session_before_switch", (_event, ctx) => {
    if (ctx.mode !== "rpc" || process.env.PI_M31_COMPAT !== "1" || !process.env.PI_CODING_AGENT_DIR) return;
    const marker = join(process.env.PI_CODING_AGENT_DIR, "compat-reload-veto-once");
    if (!existsSync(marker)) return;
    unlinkSync(marker);
    if (process.env.PI_M0_EVENTS_PATH) appendFileSync(process.env.PI_M0_EVENTS_PATH, `${JSON.stringify({ event: "m31_compat_reload_veto", pid: process.pid })}\n`);
    return { cancel: true };
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.mode !== "rpc" || process.env.PI_M31_COMPAT !== "1" || !process.env.PI_CODING_AGENT_DIR) return;
    const marker = join(process.env.PI_CODING_AGENT_DIR, "compat-stop-once");
    if (!existsSync(marker)) return;
    unlinkSync(marker);
    if (process.env.PI_M0_EVENTS_PATH) appendFileSync(process.env.PI_M0_EVENTS_PATH, `${JSON.stringify({ event: "m31_compat_shutdown_dialog", pid: process.pid })}\n`);
    await ctx.ui.confirm("M31 compatibility fixture", "Explicit test of a shutdown that needs interaction.");
  });
}
