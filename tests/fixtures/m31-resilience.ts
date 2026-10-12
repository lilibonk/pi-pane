/** Fault barriers for M31-5. Only the task-owned sibling plan file controls this fixture. */
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function plan(): Record<string, unknown> {
  try { return JSON.parse(readFileSync(join(dirname(process.cwd()), "resilience-plan.json"), "utf8")); }
  catch { return {}; }
}
function evidence(event: string, data: Record<string, unknown> = {}) {
  if (process.env.PI_M0_EVENTS_PATH) appendFileSync(process.env.PI_M0_EVENTS_PATH,
    `${JSON.stringify({ at: Date.now(), event, pid: process.pid, cwd: process.cwd(), ...data })}\n`);
}
const pause = (ms: unknown) => new Promise(resolve => setTimeout(resolve, Number(ms) || 0));

export default function resilience(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const control = plan();
    evidence("m31_resilience_start", { mode: ctx.mode, file: ctx.sessionManager.getSessionFile() });
    if (ctx.mode !== "rpc" || process.cwd() !== control.target) return;
    evidence("m31_resilience_target_start", { file: ctx.sessionManager.getSessionFile() });
    if (control.startCrash) process.exit(23);
    await pause(control.startDelay);
    evidence("m31_resilience_target_ready");
  });
  pi.on("session_before_switch", () => {
    if (plan().vetoSwitch) { evidence("m31_resilience_veto"); return { cancel: true }; }
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.mode !== "rpc") return;
    const control = plan();
    evidence("m31_resilience_shutdown_begin", { file: ctx.sessionManager.getSessionFile() });
    await pause(control.shutdownDelay);
    evidence("m31_resilience_shutdown_end");
  });
}
