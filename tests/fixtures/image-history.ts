/** Test fixture: appends displayed custom messages that carry images, without a model turn. */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { png } from "./images.ts";

function evidence(event: string, data: Record<string, unknown> = {}) {
  const path = process.env.PI_M0_EVENTS_PATH;
  if (path) appendFileSync(path, `${JSON.stringify({ at: Date.now(), event, ...data })}\n`, { mode: 0o600 });
}

export default function imageHistory(pi: ExtensionAPI) {
  pi.registerCommand("m2-image-history", {
    description: "Test fixture: append <count> custom messages, each with one noisy PNG of about <side>² × 3 bytes.",
    async handler(args) {
      const [countText, sideText] = args.trim().split(/\s+/);
      const count = Math.min(1000, Math.max(1, Number(countText) || 100));
      const side = Math.min(1500, Math.max(8, Number(sideText) || 64));
      let bytes = 0;
      for (let index = 0; index < count; index++) {
        // Each image differs, so no two blocks share bytes.
        const image = png(side, side, [index % 256, (index * 7) % 256, (index * 13) % 256], true);
        bytes += image.length;
        pi.sendMessage({ customType: "m2-image", display: true,
          content: [{ type: "text", text: `IMAGE ${index}` }, { type: "image", mimeType: "image/png", data: image.toString("base64") }] }, { triggerTurn: false });
      }
      evidence("image_history_added", { count, side, bytes });
    },
  });
}
