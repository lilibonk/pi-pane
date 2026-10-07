/** Public-API projection fixtures. No provider calls or private host state. */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function projectionExtra(pi: ExtensionAPI): void {
  pi.registerCommand("m0-projection-visible", {
    description: "Append visible, hidden and opaque test entries while idle.",
    handler: async (_args, ctx) => {
      pi.sendMessage({ customType: "projection-visible", content: "M0_IDLE_VISIBLE", display: true,
        details: { privateValue: "M0_PRIVATE_DETAILS" } }, { triggerTurn: false });
      pi.sendMessage({ customType: "projection-hidden", content: "M0_HIDDEN_MESSAGE", display: false }, { triggerTurn: false });
      pi.appendEntry("projection-opaque", { privateValue: "M0_PRIVATE_ENTRY" });
      if (process.env.PI_M0_EVENTS_PATH) appendFileSync(process.env.PI_M0_EVENTS_PATH,
        `${JSON.stringify({ at: Date.now(), event: "projection_entries_appended", leafId: ctx.sessionManager.getLeafId(), idle: ctx.isIdle() })}\n`);
    },
  });
}
