/** Local evidence for Web command dispatch. Never reads real credentials or calls a provider. */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function workbenchFixture(pi: ExtensionAPI): void {
  let cancelNextSwitch = false;
  let delayNextSwitch = false;
  pi.on("session_before_switch", async () => {
    if (cancelNextSwitch) { cancelNextSwitch = false; return { cancel: true }; }
    if (delayNextSwitch) {
      delayNextSwitch = false;
      const path = process.env.PI_M0_EVENTS_PATH;
      if (path) appendFileSync(path, `${JSON.stringify({ at: Date.now(), event: "m3_switch_waiting" })}\n`, { mode: 0o600 });
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  });
  pi.registerCommand("m3-delay-next", {
    description: "M3 fixture: hold the next session switch to verify the write barrier.",
    handler: async () => {
      delayNextSwitch = true;
      const path = process.env.PI_M0_EVENTS_PATH;
      if (path) appendFileSync(path, `${JSON.stringify({ at: Date.now(), event: "m3_delay_ready" })}\n`, { mode: 0o600 });
    },
  });
  pi.registerCommand("m3-cancel-next", {
    description: "M3 fixture: cancel the next session switch through a real host hook.",
    handler: async () => {
      cancelNextSwitch = true;
      const path = process.env.PI_M0_EVENTS_PATH;
      if (path) appendFileSync(path, `${JSON.stringify({ at: Date.now(), event: "m3_cancel_ready" })}\n`, { mode: 0o600 });
    },
  });
  pi.registerCommand("m3-mark", {
    description: "M3 fixture: record a command invocation without a model turn.",
    handler: async (args, ctx) => {
      const path = process.env.PI_M0_EVENTS_PATH;
      if (path) appendFileSync(path, `${JSON.stringify({ at: Date.now(), event: "m3_mark", args, sessionId: ctx.sessionManager.getSessionId() })}\n`, { mode: 0o600 });
    },
  });
}
