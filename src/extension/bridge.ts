import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { colorToHex } from "@earendil-works/pi-tui";
import {
  COMMANDS, M0_MAX_MESSAGES, M0_MESSAGE_BYTES, M0_MAX_TOOLS, M0_RETAIN_COMPLETED_TOOLS,
  ProtocolError, commandArgs, isRecord, toWireError,
  type CommandResult, type ContentView, type MessageView, type ModelView,
  type ProjectionEvent, type Snapshot, type StateView, type ToolView,
} from "../protocol/index.js";

export interface BridgeObserver {
  publish(event: ProjectionEvent): void;
  reset(reason: string): void;
  switching(reason: string): void;
}
export interface BridgeOptions {
  pi: Pick<ExtensionAPI, "sendUserMessage" | "getThinkingLevel" | "setThinkingLevel" | "setModel">;
  ctx: ExtensionContext;
  generation: number;
  isCurrent?: () => boolean;
  maxMessages?: number;
  maxContentChars?: number;
  pollMs?: number;
}
type EventLike = { type: string; [key: string]: unknown };
type SnapshotBody = Omit<Snapshot, "t" | "epoch" | "seq">;
type Completion = (result: Pick<CommandResult, "status" | "value" | "error">) => void;

/** Session-scoped projection. Construction starts observation before /web is requested. */
export class Bridge {
  readonly generation: number;
  readonly sessionId: string;
  branchRevision = 0;
  private readonly options: BridgeOptions;
  private observer?: BridgeObserver;
  private disposed = false;
  private treePending = false;
  private compactPending = false;
  private mutationPending = false;
  private messages: MessageView[] = [];
  private sourceIds = new WeakMap<object, string>();
  private activeByRole = new Map<string, string>();
  private tools = new Map<string, ToolView>();
  private uiPrompts: StateView["uiPrompts"] = [];
  private lastState = "";
  private lastTheme = "";
  private historyTruncated = false;
  private historyLeaf: string | null | undefined;
  private passiveEntryViews = new Map<string, string>();
  private readonly timer: ReturnType<typeof setInterval>;
  private refreshTimer?: ReturnType<typeof setTimeout>;

  constructor(options: BridgeOptions) {
    this.options = options;
    this.generation = options.generation;
    this.sessionId = options.ctx.sessionManager.getSessionId();
    this.syncHistory();
    this.timer = setInterval(() => {
      if (!this.isCurrent() || (!this.observer && !this.treePending)) return;
      try {
        if (this.treePending && this.options.ctx.isIdle()) this.finishTree("tree_cancelled_or_failed");
        // Idle custom/bang messages append entries without extension message events.
        if (this.observer && this.options.ctx.sessionManager.getLeafId() !== this.historyLeaf) this.syncHistory();
        this.publishState();
        this.publishTheme();
      } catch { /* Old contexts are invalid after replacement; lifecycle owns disposal. */ }
    }, options.pollMs ?? 250);
    this.timer.unref?.();
  }

  isCurrent(): boolean { return !this.disposed && (this.options.isCurrent?.() ?? true); }
  get blocked(): boolean { return this.treePending; }
  setObserver(observer?: BridgeObserver): void {
    this.observer = observer;
    this.lastState = "";
    this.lastTheme = "";
  }
  private assertCurrent(): void {
    if (!this.isCurrent()) throw new ProtocolError("stale_session", "This session has been replaced.");
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.observer = undefined;
    this.messages = [];
    this.tools.clear();
    this.activeByRole.clear();
    this.passiveEntryViews.clear();
  }
  private publish(ev: ProjectionEvent): void {
    if (this.isCurrent()) this.observer?.publish(ev);
  }
  private safeValue(value: unknown, limit = 2048): unknown {
    try {
      const json = JSON.stringify(value ?? null);
      if (json.length > limit) return { truncated: true, preview: json.slice(0, Math.max(0, limit)) };
      return JSON.parse(json) as unknown;
    } catch { return { unavailable: true }; }
  }
  private normalize(message: unknown, id: string, complete: boolean, entryId?: string): MessageView | undefined {
    if (!isRecord(message)) return undefined;
    if (message.role === "custom" && message.display !== true) return undefined;
    const parts = Array.isArray(message.content) ? message.content : typeof message.content === "string" ? [{ type: "text", text: message.content }] : [];
    const content: ContentView[] = [];
    let truncated = parts.length > 128;
    // Bound the whole message, not every block independently.
    let remaining = this.options.maxContentChars ?? 32_768;
    const addText = (raw: string, type: "text" | "thinking" = "text"): void => {
      const text = raw.slice(0, remaining);
      truncated ||= raw.length > remaining;
      remaining -= text.length;
      if (text.length) content.push({ type, text });
    };
    if (message.role === "bashExecution") {
      if (typeof message.command === "string") addText(`$ ${message.command}\n`);
      if (typeof message.exitCode === "number" && Number.isFinite(message.exitCode)) addText(`[Exit code: ${message.exitCode}]\n`);
      if (message.cancelled === true) addText("[Cancelled]\n");
      if (message.truncated === true) { addText("[Output truncated]\n"); truncated = true; }
    }
    for (const part of parts.slice(0, 128)) {
      if (!isRecord(part)) continue;
      if (part.type === "text" || part.type === "thinking") {
        const raw = String(part.type === "thinking" ? part.thinking ?? part.text ?? "" : part.text ?? "");
        addText(raw, part.type);
      } else if (part.type === "toolCall") {
        const args = this.safeValue(part.arguments, Math.min(remaining, 2048));
        const argsLength = JSON.stringify(args).length;
        if (isRecord(args) && args.truncated === true) truncated = true;
        remaining = Math.max(0, remaining - argsLength);
        content.push({ type: "toolCall", id: String(part.id ?? "").slice(0, 256), name: String(part.name ?? "tool").slice(0, 256), arguments: args });
      } else if (part.type === "image") {
        addText("[Image — unavailable in the M0 text spike]");
      }
    }
    if ((!parts.length || !content.length || message.role === "bashExecution") && typeof message.output === "string") addText(message.output);
    if (typeof message.errorMessage === "string") addText(message.errorMessage);
    // Pi records structured prompt/tool updates as system messages with content="".
    // Native TUI skips these internal updates. Do not render an empty chat bubble or
    // expose structured prompt sections; retain genuine nonempty system content.
    if (message.role === "system" && !content.some((part) => part.type === "toolCall" || part.text.trim().length > 0)) return undefined;
    return {
      id, ...(entryId ? { entryId } : {}), role: String(message.role ?? "custom"), content,
      status: complete ? "complete" : "streaming",
      ...(typeof message.toolCallId === "string" ? { toolCallId: message.toolCallId } : {}),
      ...(typeof message.toolName === "string" ? { toolName: message.toolName } : {}),
      ...(message.isError === true || message.stopReason === "error" ? { isError: true } : {}),
      ...(truncated ? { truncated: true } : {}),
    };
  }
  private trimMessages(): void {
    const maxMessages = this.options.maxMessages ?? M0_MAX_MESSAGES;
    if (this.messages.length > maxMessages) {
      this.messages.splice(0, this.messages.length - maxMessages);
      this.historyTruncated = true;
    }
    // M0 explicitly advertises a bounded history window, not full-history paging.
    let bytes = 0;
    let first = this.messages.length;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      bytes += Buffer.byteLength(JSON.stringify(this.messages[i]), "utf8");
      if (bytes > M0_MESSAGE_BYTES) break;
      first = i;
    }
    if (first > 0) {
      this.messages.splice(0, first);
      this.historyTruncated = true;
    }
  }
  /** Map persisted entries by object identity / entry ID, never by text or timestamp. */
  syncHistory(publishPassiveChanges = true): void {
    this.assertCurrent();
    const entries = this.options.ctx.sessionManager.getBranch();
    const existingByEntry = new Map(this.messages.filter((m) => m.entryId).map((m) => [m.entryId!, m.id]));
    const persisted: MessageView[] = [];
    const mapped = new Set<string>();
    const start = Math.max(0, entries.length - (this.options.maxMessages ?? M0_MAX_MESSAGES) * 2);
    if (start > 0) this.historyTruncated = true;
    for (const entry of entries.slice(start)) {
      let source: unknown;
      if (entry.type === "message") source = entry.message;
      else if (entry.type === "custom_message" && entry.display) source = { role: "custom", content: entry.content, display: true };
      else if (entry.type === "compaction") source = { role: "system", content: "[Context compacted]" };
      else continue; // Never expose opaque custom entry data.
      const objectId = typeof source === "object" && source ? this.sourceIds.get(source) : undefined;
      const id = existingByEntry.get(entry.id) ?? objectId ?? `entry:${entry.id}`;
      if (typeof source === "object" && source) this.sourceIds.set(source, id);
      const view = this.normalize(source, id, true, entry.id);
      if (view) { persisted.push(view); mapped.add(id); }
    }
    const pending = this.messages.filter((m) => !m.entryId && !mapped.has(m.id));
    this.messages = [...persisted, ...pending];
    this.trimMessages();
    // These persisted-only host messages have no reliable public extension event.
    // Reconcile them here as well as on the idle leaf poll so a subsequent live
    // user/assistant event cannot appear before an earlier visible custom entry.
    if (publishPassiveChanges || !this.observer) {
      const next = new Map<string, string>();
      for (const message of this.messages) {
        if (!message.entryId || !["custom", "bashExecution"].includes(message.role)) continue;
        const serialized = JSON.stringify(message);
        next.set(message.entryId, serialized);
        if (this.passiveEntryViews.get(message.entryId) !== serialized) this.publish({ type: "msg_end", message });
      }
      this.passiveEntryViews = next;
      this.historyLeaf = this.options.ctx.sessionManager.getLeafId();
    }
  }
  private updateMessage(source: unknown, type: "msg_start" | "msg_delta" | "msg_end"): void {
    if (!isRecord(source)) return;
    // Custom messages persist as a different entry shape without object identity.
    // M0 includes their visible persisted form during reconciliation, not a speculative live duplicate.
    if (source.role === "custom") return;
    const role = String(source.role ?? "custom");
    let id = this.sourceIds.get(source);
    if (!id && type !== "msg_start") id = this.activeByRole.get(role);
    if (!id) id = `live:${randomUUID()}`;
    this.sourceIds.set(source, id);
    if (type !== "msg_end") this.activeByRole.set(role, id);
    else if (this.activeByRole.get(role) === id) this.activeByRole.delete(role);
    const previous = this.messages.find((message) => message.id === id);
    const view = this.normalize(source, id, type === "msg_end", previous?.entryId);
    if (!view) return;
    const index = this.messages.findIndex((message) => message.id === id);
    if (index >= 0) this.messages[index] = view;
    else this.messages.push(view);
    this.trimMessages();
    this.publish({ type, message: view });
  }
  private refreshLater(): void {
    if (this.refreshTimer || !this.isCurrent()) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      if (!this.isCurrent()) return;
      try { this.syncHistory(); this.publishState(); } catch { /* Stale runtime. */ }
    }, 0);
    this.refreshTimer.unref?.();
  }
  handleEvent(event: EventLike): void {
    if (!this.isCurrent()) return;
    if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
      this.syncHistory();
      this.updateMessage(event.message, event.type === "message_start" ? "msg_start" : event.type === "message_update" ? "msg_delta" : "msg_end");
      if (event.type === "message_end") this.refreshLater();
    } else if (event.type.startsWith("tool_execution_")) {
      const id = String(event.toolCallId);
      const old = this.tools.get(id);
      const end = event.type === "tool_execution_end";
      const tool: ToolView = {
        id, name: String(event.toolName ?? old?.name ?? "tool"),
        args: event.args === undefined ? old?.args ?? null : this.safeValue(event.args),
        ...(typeof event.parentToolCallId === "string" ? { parentToolCallId: event.parentToolCallId } : {}),
        ...(end ? { result: this.safeValue(event.result) } : event.partialResult !== undefined ? { partial: this.safeValue(event.partialResult) } : {}),
        status: end ? event.isError ? "error" : "complete" : "running",
      };
      this.tools.set(id, tool);
      if (this.tools.size > M0_RETAIN_COMPLETED_TOOLS) {
        for (const [key, value] of this.tools) { if (value.status !== "running" && key !== id) { this.tools.delete(key); break; } }
      }
      if (this.tools.size > M0_MAX_TOOLS) this.tools.delete(this.tools.keys().next().value!);
      this.publish({ type: end ? "tool_end" : event.type === "tool_execution_start" ? "tool_start" : "tool_update", tool });
    } else if (event.type === "session_before_tree") {
      this.treePending = true;
      this.observer?.switching("tree");
    } else if (event.type === "session_tree") {
      this.finishTree("tree");
    } else if (event.type === "ui_prompt_start") {
      this.uiPrompts.push({ kind: String(event.kind), ...(typeof event.title === "string" ? { title: event.title } : {}) });
    } else if (event.type === "ui_prompt_end") {
      const index = this.uiPrompts.findIndex((prompt) => prompt.kind === event.kind && prompt.title === event.title);
      if (index >= 0) this.uiPrompts.splice(index, 1);
    } else if (event.type === "session_before_compact") {
      this.compactPending = true;
    } else if (event.type === "session_compact" || event.type === "session_compact_failed") {
      this.compactPending = false;
      this.syncHistory();
      if (event.type === "session_compact") {
        // Compaction appends a persisted entry without emitting message events.
        // Publish the bounded canonical window in order so attached clients see
        // its marker and apply the same rolling window as a fresh snapshot.
        // Keep the epoch: the compact command still has a completion to deliver.
        for (const message of this.messages) this.publish({ type: message.status === "streaming" ? "msg_delta" : "msg_end", message });
      }
      this.refreshLater();
    } else if (event.type === "session_info_changed") {
      this.publish({ type: "session_meta", ...(typeof event.name === "string" ? { name: event.name } : {}) });
    } else if (event.type === "turn_end" || event.type === "agent_settled") {
      this.syncHistory();
      // Re-emit canonical final messages after other extensions may have replaced content.
      for (const message of this.messages.filter((m) => m.entryId).slice(-32)) this.publish({ type: "msg_end", message });
    }
    this.publishState();
  }
  private finishTree(reason: string): void {
    this.treePending = false;
    if (reason === "tree") this.branchRevision++;
    this.messages = [];
    this.tools.clear();
    this.sourceIds = new WeakMap();
    this.activeByRole.clear();
    this.historyTruncated = false;
    this.syncHistory();
    this.observer?.reset(reason);
  }
  private modelView(model: { provider: string; id: string; name: string }): ModelView {
    return { provider: model.provider, id: model.id, name: model.name };
  }
  private state(): StateView {
    const ctx = this.options.ctx;
    const idle = ctx.isIdle();
    return {
      idle, running: !idle, compacting: this.compactPending,
      hasPendingMessages: ctx.hasPendingMessages(),
      ...(ctx.model ? { model: this.modelView(ctx.model) } : {}),
      thinking: this.options.pi.getThinkingLevel(),
      models: ctx.modelRegistry.getAvailable().slice(0, 256).map((model) => this.modelView(model)),
      tools: [...this.tools.values()], uiPrompts: [...this.uiPrompts],
    };
  }
  private theme(): Record<string, string> {
    const theme = this.options.ctx.ui.theme;
    const colors = theme.colors;
    const color = (key: keyof typeof colors, fallback: string): string => {
      try { return colorToHex(colors[key]); } catch { return fallback; }
    };
    return {
      "--bg": theme.appearance === "light" ? "#f5f5f4" : "#111315",
      "--fg": color("text", "#eeeeee"), "--fg-muted": color("muted", "#aaaaaa"),
      "--accent": color("accent", "#a6b9ef"), "--border": color("border", "#343434"),
      "--user-bg": color("userMessageBg", "#25272a"), "--err": color("error", "#f88b8b"),
      "--ok": color("success", "#97cba8"),
    };
  }
  private publishState(): void {
    if (!this.observer || !this.isCurrent()) return;
    const state = this.state();
    const serialized = JSON.stringify(state);
    if (serialized !== this.lastState) { this.lastState = serialized; this.publish({ type: "agent_state", state }); }
  }
  private publishTheme(): void {
    const theme = this.theme();
    const serialized = JSON.stringify(theme);
    if (serialized !== this.lastTheme) { this.lastTheme = serialized; this.publish({ type: "theme", theme }); }
  }
  snapshot(): SnapshotBody {
    this.assertCurrent();
    this.syncHistory(false);
    return structuredClone({
      session: {
        id: this.sessionId, name: this.options.ctx.sessionManager.getSessionName(), cwd: this.options.ctx.cwd,
        leafId: this.options.ctx.sessionManager.getLeafId(), branchRevision: this.branchRevision,
        messages: this.messages, historyTruncated: this.historyTruncated,
      },
      state: this.state(), theme: this.theme(),
      caps: { commands: COMMANDS, images: false, promptReceipt: "dispatch_only", queueView: "boolean", terminalDialogs: true, history: "bounded_spike" },
    });
  }
  /** Validation / host dispatch is synchronous. Never waits for a model turn. */
  dispatch(command: string, input: unknown, complete: Completion): void {
    this.assertCurrent();
    if (this.treePending) throw new ProtocolError("stale_session", "Branch navigation is in progress.");
    const args = commandArgs(command, input);
    const ctx = this.options.ctx;
    const pi = this.options.pi;
    if (command !== "prompt" && command !== "abort" &&
      (!ctx.isIdle() || this.compactPending || this.mutationPending || this.uiPrompts.length > 0))
      throw new ProtocolError("busy", "Wait until the session and terminal dialogs are idle.");
    const revision = this.branchRevision;
    const done: Completion = (result) => {
      if (this.isCurrent() && revision === this.branchRevision) complete(result);
    };
    if (command === "prompt") {
      pi.sendUserMessage(args.text as string, { deliverAs: (args.mode ?? "followUp") as "steer" | "followUp", expandPromptTemplates: false });
    } else if (command === "abort") {
      ctx.abort();
    } else if (command === "set_model") {
      const model = ctx.modelRegistry.find(args.provider as string, args.id as string);
      if (!model) throw new ProtocolError("unknown_model", "Model is not registered.");
      this.mutationPending = true;
      void pi.setModel(model).then((ok) => {
        done(ok ? { status: "completed", value: this.modelView(model) } : { status: "failed", error: { code: "model_auth_unavailable", message: "Model authentication is not configured." } });
      }, (error: unknown) => done({ status: "failed", error: toWireError(error) })).finally(() => {
        this.mutationPending = false;
        if (this.isCurrent()) this.publishState();
      });
    } else if (command === "set_thinking") {
      pi.setThinkingLevel(args.level as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
      done({ status: "completed", value: { level: pi.getThinkingLevel() } });
    } else if (command === "compact") {
      if (ctx.hasPendingMessages()) throw new ProtocolError("busy", "Queued messages must settle before compaction.");
      this.compactPending = true;
      ctx.compact({
        onComplete: () => { this.compactPending = false; done({ status: "completed" }); this.refreshLater(); },
        onError: (error) => { this.compactPending = false; done({ status: "failed", error: toWireError(error) }); this.refreshLater(); },
      });
    }
    this.refreshLater();
  }
}
