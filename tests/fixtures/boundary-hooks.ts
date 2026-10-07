/** Real extension hooks used to test host interception/failure paths. Loaded after pi-pane. */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { deterministicStream } from "./deterministic-provider.ts";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function record(event: string, data: Record<string, unknown> = {}) {
  const path = process.env.PI_M0_EVENTS_PATH;
  if (path) appendFileSync(path, `${JSON.stringify({ at: Date.now(), event, ...data })}\n`, { mode: 0o600 });
}
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter((part) => part.type === "text").map((part) => part.text).join("") : "";
}

export default function boundaryHooks(pi: ExtensionAPI) {
  // This custom provider deliberately has no configured key in the isolated environment.
  pi.registerProvider("pi-pane-m0-noauth", {
    baseUrl: "http://does-not-exist.invalid", apiKey: "$PI_M0_ABSENT_AUTH_KEY", api: "pi-pane-m0-noauth-api",
    models: [{ id: "deterministic", name: "M0 controlled missing authentication", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16_384, maxTokens: 2_048 }],
    streamSimple: deterministicStream,
  });
  pi.on("resources_discover", () => {
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    if (!agentDir?.includes("pi-pane-m0-")) throw new Error("Boundary fixture requires the isolated test agent directory");
    const root = join(agentDir, "boundary-resources"); const skill = join(root, "m0-boundary-skill");
    mkdirSync(skill, { recursive: true });
    const prompt = join(root, "m0-boundary-template.md");
    writeFileSync(prompt, "---\ndescription: Local M0 template fixture\n---\nM0_TEMPLATE_EXPANDED $ARGUMENTS\n");
    writeFileSync(join(skill, "SKILL.md"), "---\nname: m0-boundary-skill\ndescription: Local M0 skill expansion fixture\n---\nM0_SKILL_EXPANDED\n");
    record("boundary_resources", { template: "m0-boundary-template", skill: "m0-boundary-skill" });
    return { promptPaths: [prompt], skillPaths: [skill] };
  });
  pi.on("input", async (event) => {
    record("boundary_input", { text: event.text, source: event.source, mode: event.streamingBehavior });
    if (event.text === "M0_CONSUME") { record("input_consumed"); return { action: "handled" }; }
    if (event.text === "M0_TRANSFORM") { record("input_transformed"); return { action: "transform", text: "M0_TRANSFORMED_BY_EXTENSION" }; }
    if (event.text === "M0_DELAY_INPUT") {
      record("input_delayed_start"); await pause(700); record("input_delayed_end");
      return { action: "transform", text: "M0_DELAYED_DELIVERED" };
    }
  });
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant" && contentText(event.message.content).startsWith("M0_REPLY:M0_REPLACE_FINAL:")) {
      record("final_message_replaced");
      return { message: { ...event.message, content: [{ type: "text", text: "M0_REPLACED_FINAL" }] } };
    }
  });
  pi.on("session_before_compact", (event) => { record("boundary_compact_start", { reason: event.reason }); });
  pi.on("session_compact", (event) => { record("boundary_compact_success", { summary: event.compactionEntry.summary, fromExtension: event.fromExtension }); });
  pi.on("session_compact_failed", (event) => { record("boundary_compact_failure", { error: event.errorMessage, aborted: event.aborted, fromExtension: event.fromExtension }); });
  pi.on("ui_prompt_start", (event) => { record("boundary_dialog_start", { kind: event.kind, title: event.title }); });
  pi.on("ui_prompt_end", (event) => { record("boundary_dialog_end", { kind: event.kind, title: event.title }); });
  pi.on("model_select", async (event) => {
    if (process.env.PI_M0_DELAY_MODEL !== "1") return;
    delete process.env.PI_M0_DELAY_MODEL;
    record("boundary_model_delay_start", { model: event.model.id });
    await pause(700);
    record("boundary_model_delay_end", { model: event.model.id });
  });
  pi.registerCommand("m0-delay-model", {
    description: "Boundary fixture: delay the next real model-select hook.",
    async handler() { process.env.PI_M0_DELAY_MODEL = "1"; record("boundary_model_delay_armed"); },
  });
  pi.registerCommand("m0-provider-mode", {
    description: "Boundary fixture: control the next local provider request only.",
    async handler(args) {
      const mode = args.trim();
      if (!["summary-ok", "error-summary", "error-auth"].includes(mode)) throw new Error("Unknown fixture mode");
      process.env.PI_M0_NEXT_PROVIDER_MODE = mode; record("provider_mode_set", { mode });
    },
  });
  pi.registerCommand("m0-dialog", {
    description: "Boundary fixture: open a real terminal confirm dialog.",
    async handler(_args, ctx) {
      const result = await ctx.ui.confirm("M0 boundary confirm", "This fixture dialog must be answered in the terminal.");
      record("boundary_dialog_result", { result });
    },
  });
  pi.registerCommand("m0-tree-summary-failure", {
    description: "Boundary fixture: fail actual branch summarization through the local provider.",
    async handler(_args, ctx) {
      const target = ctx.sessionManager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "assistant");
      if (!target) throw new Error("Need an earlier assistant entry");
      process.env.PI_M0_NEXT_PROVIDER_MODE = "error-summary";
      try {
        const result = await ctx.navigateTree(target.id, { summarize: true });
        record("boundary_tree_failure_result", { ...result, failed: false });
      } catch (error) {
        record("boundary_tree_failure_result", { failed: true, error: error instanceof Error ? error.message : String(error) });
      }
    },
  });
  pi.registerCommand("m0-host-transcript", {
    description: "Boundary fixture: record the actual isolated host transcript for comparison.",
    async handler(_args, ctx) {
      record("host_transcript", { sessionId: ctx.sessionManager.getSessionId(), leafId: ctx.sessionManager.getLeafId(),
        messages: ctx.sessionManager.getBranch().filter((entry) => entry.type === "message").map((entry) => ({ id: entry.id, role: entry.message.role, text: contentText("content" in entry.message ? entry.message.content : "") })) });
    },
  });
}
