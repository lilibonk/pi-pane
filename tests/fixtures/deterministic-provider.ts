/** Local-only test provider. Never contacts a model service or reads credentials. */
import { appendFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { createAssistantMessageEventStream, parseStreamingJson, Type } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Model, SimpleStreamOptions, ToolCall, TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function evidence(event: string, data: Record<string, unknown> = {}) {
  const path = process.env.PI_M0_EVENTS_PATH;
  if (path) appendFileSync(path, `${JSON.stringify({ at: Date.now(), event, ...data })}\n`, { mode: 0o600 });
}
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function userImages(context: TranscriptContext): Array<{ mimeType: string; bytes: number }> {
  const user = [...context.messages].reverse().find((message) => message.role === "user");
  if (!user || typeof user.content === "string") return [];
  return user.content.flatMap((part) => part.type === "image" ? [{ mimeType: part.mimeType, bytes: Buffer.from(part.data, "base64").length }] : []);
}
function userText(context: TranscriptContext): string {
  const user = [...context.messages].reverse().find((message) => message.role === "user");
  if (!user) return "";
  return typeof user.content === "string" ? user.content : user.content.filter((part) => part.type === "text").map((part) => part.text).join("");
}

export function deterministicStream(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) {
  const stream = createAssistantMessageEventStream();
  const input = userText(context);
  const last = context.messages.at(-1);
  const control = process.env.PI_M0_NEXT_PROVIDER_MODE;
  delete process.env.PI_M0_NEXT_PROVIDER_MODE;
  const summarization = input.startsWith("<conversation>") || input.startsWith("# Conversation\n");
  const useTool = !control && !summarization && input.startsWith("M0_TOOL") && last?.role !== "toolResult";
  const reply = control || summarization ? "M0_SUMMARY_COMPLETE" : `M0_REPLY:${input}:` + (input.startsWith("M0_SLOW") ? "0123456789abcdef".repeat(30) : "complete");
  const message: AssistantMessage = {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: useTool ? "toolUse" : "stop", timestamp: Date.now(),
  };
  void (async () => {
    evidence("provider_call", { input, useTool, control, summarization, images: userImages(context) });
    try {
      // This provider has no HTTP request/response; no onResponse callback is fabricated.
      await options?.onPayload?.({ testProvider: true, input }, model);
      stream.push({ type: "start", partial: structuredClone(message) });
      if (control === "error-auth" || control === "error-summary") {
        await pause(250);
        throw new Error(control === "error-auth" ? "401 Unauthorized: M0 controlled authentication failure" : "M0 controlled summarization failure");
      }
      if (useTool) {
        const toolCall: ToolCall = { type: "toolCall", id: `m0-tool-${message.timestamp}`, name: "m0_echo", arguments: {} };
        message.content.push(toolCall);
        stream.push({ type: "toolcall_start", contentIndex: 0, partial: structuredClone(message) });
        if (input.startsWith("M0_TOOL_ARGUMENTS")) {
          const args = JSON.stringify({ text: input });
          for (let length = 1; length <= args.length; length++) {
            await pause(55);
            if (options?.signal?.aborted) throw new Error("Fixture tool arguments aborted");
            toolCall.arguments = parseStreamingJson<ToolCall["arguments"]>(args.slice(0, length));
            stream.push({ type: "toolcall_delta", contentIndex: 0, delta: args[length - 1]!, partial: structuredClone(message) });
          }
        }
        toolCall.arguments = { text: input };
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: structuredClone(message) });
      } else {
        if (input.startsWith("M0_THINKING") && !control) {
          const thought = { type: "thinking" as const, thinking: "" };
          message.content.push(thought);
          stream.push({ type: "thinking_start", contentIndex: 0, partial: structuredClone(message) });
          const fullThought = "M0_THOUGHT:" + "thinking-block-".repeat(16);
          for (let offset = 0; offset < fullThought.length; offset += 8) {
            await pause(55);
            if (options?.signal?.aborted) throw new Error("Fixture thinking aborted");
            const delta = fullThought.slice(offset, offset + 8); thought.thinking += delta;
            stream.push({ type: "thinking_delta", contentIndex: 0, delta, partial: structuredClone(message) });
          }
          stream.push({ type: "thinking_end", contentIndex: 0, content: fullThought, partial: structuredClone(message) });
        }
        const part = { type: "text" as const, text: "" };
        const contentIndex = message.content.length;
        message.content.push(part);
        stream.push({ type: "text_start", contentIndex, partial: structuredClone(message) });
        for (let offset = 0; offset < reply.length; offset += 8) {
          await pause(control ? 300 : input.startsWith("M0_SLOW") ? 60 : 8);
          if (options?.signal?.aborted) throw new Error("Fixture stream aborted");
          const delta = reply.slice(offset, offset + 8);
          part.text += delta;
          stream.push({ type: "text_delta", contentIndex, delta, partial: structuredClone(message) });
        }
        stream.push({ type: "text_end", contentIndex, content: part.text, partial: structuredClone(message) });
      }
      stream.push({ type: "done", reason: useTool ? "toolUse" : "stop", message });
      evidence("provider_done", { input });
    } catch (error) {
      message.stopReason = options?.signal?.aborted ? "aborted" : "error";
      message.errorMessage = error instanceof Error ? error.message : "Fixture failure";
      stream.push({ type: "error", reason: message.stopReason, error: message });
      evidence(message.stopReason === "aborted" ? "provider_aborted" : "provider_failed", { input, error: message.errorMessage, control });
    } finally { stream.end(); }
  })();
  return stream;
}

export default function deterministicProvider(pi: ExtensionAPI) {
  if (process.env.PI_M0_NO_PROVIDER !== "1") pi.registerProvider("pi-pane-m0", {
    baseUrl: "http://does-not-exist.invalid", apiKey: "m0-local-fixture-not-a-secret", api: "pi-pane-m0-api",
    models: [false, true].map((reasoning) => ({ id: reasoning ? "deterministic-thinking" : "deterministic", name: `M0 deterministic local fixture${reasoning ? " (thinking)" : ""}`, reasoning, input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16_384, maxTokens: 2_048 })),
    streamSimple: deterministicStream,
  });
  pi.registerTool({
    name: "m0_echo", label: "M0 fixture echo", description: "Deterministic local streaming tool for tests only.",
    parameters: Type.Object({ text: Type.String() }),
    async execute(_id, args, signal, onUpdate) {
      for (let index = 0; index < 12; index++) {
        if (signal?.aborted) throw new Error("Fixture tool aborted");
        onUpdate?.({ content: [{ type: "text", text: `M0_PARTIAL:${index}:${args.text}` }], details: { index } });
        await pause(80);
      }
      return { content: [{ type: "text", text: `M0_TOOL_DONE:${args.text}` }], details: { complete: true } };
    },
  });
  let cancelTree = false;
  pi.on("session_start", (event, ctx) => { evidence("session_start", { reason: event.reason, sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile() }); });
  pi.on("session_shutdown", (event) => { evidence("session_shutdown", { reason: event.reason }); });
  pi.on("message_start", (event) => { evidence("message_start", { role: event.message.role }); });
  pi.on("message_end", (event) => { evidence("message_end", { role: event.message.role }); });
  pi.on("agent_settled", () => { evidence("agent_settled"); });
  pi.on("session_before_tree", () => {
    evidence("session_before_tree", { cancelled: cancelTree });
    if (cancelTree) { cancelTree = false; return { cancel: true }; }
  });
  pi.on("session_tree", (event) => { evidence("session_tree", { newLeafId: event.newLeafId }); });
  pi.registerCommand("m0-mark", { description: "Local fixture dispatch evidence", async handler(args, ctx) { evidence("m0_mark", { args, mode: ctx.mode }); } });
  pi.registerCommand("m0-tree", {
    description: "Test fixture: navigate to an earlier branch entry, optionally cancel via the real extension hook.",
    async handler(args, ctx) {
      const entries = ctx.sessionManager.getBranch();
      const target = entries.find((entry) => entry.type === "message" && entry.message.role === "assistant");
      if (!target) { evidence("tree_fixture_error", { reason: "no earlier assistant entry" }); return; }
      cancelTree = args.trim() === "cancel";
      const result = await ctx.navigateTree(target.id, { summarize: false });
      evidence("tree_fixture_result", { cancelled: result.cancelled });
    },
  });
  pi.registerCommand("m0-theme", {
    description: "Test fixture: select a built-in theme through the public TUI API.",
    async handler(args, ctx) { const result = ctx.ui.setTheme(args.trim()); evidence("theme_fixture_result", { theme: args.trim(), ...result }); },
  });
  pi.registerCommand("m0-fork", {
    description: "Test fixture: fork through the actual host lifecycle without the selection dialog.",
    async handler(_args, ctx) {
      const target = ctx.sessionManager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "assistant");
      if (!target) throw new Error("No fixture entry available to fork");
      await ctx.fork(target.id, { position: "at" });
    },
  });
  pi.registerCommand("m0-resume", {
    description: "Test fixture: reopen a session created inside the isolated test agent directory.",
    async handler(args, ctx) {
      const agentDir = process.env.PI_CODING_AGENT_DIR;
      const path = resolve(args.trim());
      if (!agentDir || !path.startsWith(`${resolve(agentDir)}${sep}`)) throw new Error("Fixture resume is limited to the isolated agent directory");
      await ctx.switchSession(path);
    },
  });
}
