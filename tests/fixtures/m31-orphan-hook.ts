import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** An extension whose shutdown takes a moment, as real ones do: pi waits for it before it stops its commands. */
export default function orphanHook(pi: ExtensionAPI) {
  pi.on("session_shutdown", async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
}
