/** Public extension tool used only by the isolated M31 integration browser fixture. */
import { appendFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function evidence(event: string, data: Record<string, unknown>) {
  const path = process.env.PI_M0_EVENTS_PATH;
  if (!path) throw new Error("The integration fixture requires its own event file.");
  appendFileSync(path, `${JSON.stringify({ at: Date.now(), event, pid: process.pid, ...data })}\n`, { mode: 0o600 });
}

export default function integrationTool(pi: ExtensionAPI) {
  pi.on("session_start", (event, ctx) => evidence("m31_integration_session", {
    reason: event.reason, mode: ctx.mode, cwd: ctx.cwd, processCwd: process.cwd(),
    sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(),
  }));
  pi.on("session_shutdown", (event, ctx) => evidence("m31_integration_shutdown", { reason: event.reason, mode: ctx.mode }));
  pi.registerTool({
    name: "m31_write_proof", label: "M31 integration write", description: "Write one deterministic proof file in the current isolated fixture project.",
    parameters: Type.Object({ marker: Type.String({ pattern: "^M31_INTEGRATION_WRITE_(desktop|mobile)$" }) }),
    async execute(_id, args, _signal, _onUpdate, ctx) {
      const eventPath = process.env.PI_M0_EVENTS_PATH;
      if (!eventPath || process.env.PI_OFFLINE !== "1") throw new Error("The integration writer only runs inside an offline test fixture.");
      const fixtureRoot = realpathSync(dirname(eventPath)), cwd = realpathSync(ctx.cwd), processCwd = realpathSync(process.cwd());
      const within = relative(fixtureRoot, cwd);
      if (!within || within.startsWith("..") || within.split(/[\\/]/).length !== 1 || within === "agent") throw new Error("The integration writer refused a directory outside its fixture project.");
      if (cwd !== processCwd) throw new Error("The RPC process cwd and tool context cwd disagree.");
      const file = join(cwd, "m31-integration-proof.json");
      const proof = { marker: args.marker, cwd, processCwd, file, sessionId: ctx.sessionManager.getSessionId(), source: "public extension tool" };
      writeFileSync(file, `${JSON.stringify(proof, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      evidence("m31_integration_write", proof);
      return { content: [{ type: "text", text: JSON.stringify(proof) }], details: proof };
    },
  });
}
