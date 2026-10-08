import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { colorToHex } from "@earendil-works/pi-tui";
import {
  COMMANDS, LIMITS, ProtocolError, commandArgs, diffMessage, encodedSize, isRecord, toWireError,
  type CommandResult, type ContentPage, type ContentView, type HistoryPage, type MessageView, type ModelView,
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
  /** Tests may shrink the per-message inline budget and the snapshot window. */
  maxContentChars?: number;
  windowMessages?: number;
  windowBytes?: number;
  pageBytes?: number;
  pollMs?: number;
}
type EventLike = { type: string; [key: string]: unknown };
type SnapshotBody = Omit<Snapshot, "t" | "epoch" | "seq">;
type Completion = (result: Pick<CommandResult, "status" | "value" | "error">) => void;
type RawBlock =
  | { type: "text" | "thinking" | "diff"; text: string }
  | { type: "toolCall"; id: string; name: string; arguments: unknown };
interface BranchItem { entryId: string; id: string; source: Record<string, unknown> }

const MAX_BLOCKS = 128;
const CANONICAL_TAIL = 32;
const SENT_FINAL_LIMIT = 512;

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (isRecord(value) && Array.isArray(value.content)) {
    return value.content.map((part) => {
      if (isRecord(part) && typeof part.text === "string") return part.text;
      if (isRecord(part) && part.type === "image") return "[Image]";
      return "";
    }).filter(Boolean).join("\n");
  }
  if (value === undefined || value === null) return "";
  try { return JSON.stringify(value, null, 2) ?? ""; } catch { return "[Unavailable]"; }
}

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
  // Persisted branch, rebuilt only when the leaf changes.
  private branchLeaf: string | null | undefined;
  private branch: BranchItem[] = [];
  private branchByEntry = new Map<string, number>();
  private branchById = new Map<string, number>();
  private entryToId = new Map<string, string>();
  private syntheticSources = new WeakMap<object, Record<string, unknown>>();
  private viewCache = new WeakMap<object, MessageView | null>();
  private passiveLeaf: string | null | undefined;
  private passiveViews = new Map<string, string>();
  // Live (not yet persisted) messages in arrival order.
  private live = new Map<string, { source: Record<string, unknown>; view: MessageView }>();
  private sourceIds = new WeakMap<object, string>();
  private activeByRole = new Map<string, string>();
  // Coalescing state. lastSent is the shared baseline every attached client has applied.
  private lastSent = new Map<string, MessageView>();
  private pendingMessages = new Map<string, Record<string, unknown>>();
  private pendingTools = new Set<string>();
  private messageTimer?: ReturnType<typeof setTimeout>;
  private toolTimer?: ReturnType<typeof setTimeout>;
  private sentFinal = new Map<string, string>();
  private tools = new Map<string, ToolView>();
  private uiPrompts: StateView["uiPrompts"] = [];
  private lastState = "";
  private lastTheme = "";
  private readonly timer: ReturnType<typeof setInterval>;
  private refreshTimer?: ReturnType<typeof setTimeout>;

  constructor(options: BridgeOptions) {
    this.options = options;
    this.generation = options.generation;
    this.sessionId = options.ctx.sessionManager.getSessionId();
    this.refreshBranch();
    this.timer = setInterval(() => {
      if (!this.isCurrent() || (!this.observer && !this.treePending)) return;
      try {
        if (this.treePending && this.options.ctx.isIdle()) this.finishTree("tree_cancelled_or_failed");
        // Idle custom/bang messages append entries without extension message events.
        if (this.observer) this.reconcile();
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
    for (const timer of [this.refreshTimer, this.messageTimer, this.toolTimer]) if (timer) clearTimeout(timer);
    this.observer = undefined;
    this.clearProjection();
  }
  private clearProjection(): void {
    this.branch = [];
    this.branchLeaf = undefined;
    this.branchByEntry.clear();
    this.branchById.clear();
    this.entryToId.clear();
    this.viewCache = new WeakMap();
    this.sourceIds = new WeakMap();
    this.live.clear();
    this.activeByRole.clear();
    this.lastSent.clear();
    this.pendingMessages.clear();
    this.pendingTools.clear();
    this.sentFinal.clear();
    this.passiveViews.clear();
    this.passiveLeaf = undefined;
    this.tools.clear();
  }

  // -------------------------------------------------------------------------
  // Publication. Pending coalesced updates always precede any other event.
  // -------------------------------------------------------------------------
  private emit(ev: ProjectionEvent): void {
    if (this.isCurrent()) this.observer?.publish(ev);
  }
  private publish(ev: ProjectionEvent): void {
    if (!this.isCurrent()) return;
    this.flush();
    this.emit(ev);
  }
  /** Publishes all coalesced updates. Hub calls this before capturing a snapshot watermark. */
  flush(): void {
    if (!this.isCurrent()) return;
    if (this.messageTimer) { clearTimeout(this.messageTimer); this.messageTimer = undefined; }
    if (this.toolTimer) { clearTimeout(this.toolTimer); this.toolTimer = undefined; }
    for (const [id, source] of this.pendingMessages) {
      this.pendingMessages.delete(id);
      const view = this.normalize(source, id, false, this.entryIdOf(id));
      if (!view) continue;
      this.storeLive(id, source, view);
      const previous = this.lastSent.get(id);
      this.lastSent.set(id, view);
      const ops = previous ? diffMessage(previous, view) : null;
      if (ops?.length === 0) continue;
      this.emit(ops ? { type: "msg_delta", id, ops } : { type: "msg_delta", id, message: view });
    }
    for (const id of this.pendingTools) {
      this.pendingTools.delete(id);
      const tool = this.tools.get(id);
      if (tool) this.emit({ type: "tool_update", tool });
    }
  }
  private schedule(kind: "message" | "tool"): void {
    if (kind === "message" && !this.messageTimer) {
      this.messageTimer = setTimeout(() => { this.messageTimer = undefined; try { this.flush(); } catch { /* stale */ } }, LIMITS.messageFlushMs);
      this.messageTimer.unref?.();
    } else if (kind === "tool" && !this.toolTimer) {
      this.toolTimer = setTimeout(() => { this.toolTimer = undefined; try { this.flush(); } catch { /* stale */ } }, LIMITS.toolFlushMs);
      this.toolTimer.unref?.();
    }
  }

  // -------------------------------------------------------------------------
  // Normalization. rawBlocks() fixes block indices for both previews and content_page.
  // -------------------------------------------------------------------------
  private rawBlocks(message: Record<string, unknown>): { blocks: RawBlock[]; omitted: boolean } {
    const parts = Array.isArray(message.content) ? message.content
      : typeof message.content === "string" ? [{ type: "text", text: message.content }] : [];
    const blocks: RawBlock[] = [];
    const text = (value: string, type: "text" | "thinking" | "diff" = "text") => { blocks.push({ type, text: value }); };
    if (message.role === "bashExecution") {
      if (typeof message.command === "string") text(`$ ${message.command}\n`);
      if (typeof message.exitCode === "number" && Number.isFinite(message.exitCode)) text(`[Exit code: ${message.exitCode}]\n`);
      if (message.cancelled === true) text("[Cancelled]\n");
      if (message.truncated === true) text("[Output truncated]\n");
    }
    for (const part of parts.slice(0, MAX_BLOCKS)) {
      if (!isRecord(part)) continue;
      if (part.type === "text") text(String(part.text ?? ""));
      else if (part.type === "thinking") text(String(part.thinking ?? part.text ?? ""), "thinking");
      else if (part.type === "toolCall") blocks.push({ type: "toolCall", id: String(part.id ?? "").slice(0, 256), name: String(part.name ?? "tool").slice(0, 256), arguments: part.arguments });
      else if (part.type === "image") text("[Image — not shown in the browser yet]");
    }
    const hasBody = blocks.some((block) => block.type === "toolCall" || block.text.length > 0);
    if ((!parts.length || !hasBody || message.role === "bashExecution") && typeof message.output === "string") text(message.output);
    if (typeof message.errorMessage === "string") text(message.errorMessage);
    // Whitelisted structured details: the unified patch of pi's edit tool.
    if (message.role === "toolResult" && isRecord(message.details) && typeof message.details.patch === "string" && message.details.patch)
      text(message.details.patch, "diff");
    return { blocks, omitted: parts.length > MAX_BLOCKS };
  }
  private previewArgs(value: unknown): { arguments: unknown; argsTruncated?: true } {
    try {
      const json = JSON.stringify(value ?? null);
      if (json.length > LIMITS.toolArgsChars) return { arguments: json.slice(0, LIMITS.toolArgsChars), argsTruncated: true };
      return { arguments: JSON.parse(json) as unknown };
    } catch { return { arguments: { unavailable: true } }; }
  }
  private normalize(message: unknown, id: string, complete: boolean, entryId?: string): MessageView | undefined {
    if (!isRecord(message)) return undefined;
    if (message.role === "custom" && message.display !== true) return undefined;
    const { blocks, omitted } = this.rawBlocks(message);
    // One budget bounds the whole message; overflowing blocks keep their index with an empty prefix.
    let remaining = this.options.maxContentChars ?? LIMITS.messageChars;
    const content: ContentView[] = blocks.map((block) => {
      if (block.type === "toolCall") {
        const preview = this.previewArgs(block.arguments);
        remaining = Math.max(0, remaining - Math.min(remaining, JSON.stringify(preview.arguments).length));
        return { type: "toolCall", id: block.id, name: block.name, ...preview };
      }
      const text = block.text.slice(0, remaining);
      remaining -= text.length;
      return { type: block.type, text, ...(block.text.length > text.length ? { total: block.text.length } : {}) };
    });
    // Pi records structured prompt/tool updates as system messages with content="".
    // Native TUI skips these internal updates; retain genuine nonempty system content.
    if (message.role === "system" && !content.some((part) => part.type === "toolCall" || part.text.trim().length > 0 || part.total)) return undefined;
    return {
      id, ...(entryId ? { entryId } : {}), role: String(message.role ?? "custom"), content,
      status: complete ? "complete" : "streaming",
      ...(typeof message.toolCallId === "string" ? { toolCallId: message.toolCallId } : {}),
      ...(typeof message.toolName === "string" ? { toolName: message.toolName } : {}),
      ...(message.isError === true || message.stopReason === "error" ? { isError: true } : {}),
      ...(omitted || message.truncated === true ? { truncated: true } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Persisted branch and live messages.
  // -------------------------------------------------------------------------
  private sourceOf(entry: { type: string; id: string; [key: string]: unknown }): Record<string, unknown> | undefined {
    if (entry.type === "message") return isRecord(entry.message) ? entry.message : undefined;
    // Custom-message and compaction entries have no message object; keep one synthetic source per entry.
    if (entry.type !== "compaction" && !(entry.type === "custom_message" && entry.display)) return undefined;
    let source = this.syntheticSources.get(entry);
    if (!source) {
      source = entry.type === "compaction" ? { role: "system", content: "[Context compacted]" } : { role: "custom", content: entry.content, display: true };
      this.syntheticSources.set(entry, source);
    }
    return source;
  }
  /** Maps persisted entries by object identity / entry ID, never by text or timestamp. */
  private refreshBranch(force = false): boolean {
    this.assertCurrent();
    const manager = this.options.ctx.sessionManager;
    const leaf = manager.getLeafId();
    if (!force && leaf === this.branchLeaf) return false;
    const branch: BranchItem[] = [];
    for (const entry of manager.getBranch() as unknown as Array<{ type: string; id: string; [key: string]: unknown }>) {
      const source = this.sourceOf(entry);
      if (!source) continue; // Never expose opaque custom entry data.
      const id = this.entryToId.get(entry.id) ?? this.sourceIds.get(source) ?? `entry:${entry.id}`;
      this.entryToId.set(entry.id, id);
      this.sourceIds.set(source, id);
      branch.push({ entryId: entry.id, id, source });
    }
    this.branch = branch;
    this.branchByEntry = new Map(branch.map((item, index) => [item.entryId, index]));
    this.branchById = new Map(branch.map((item, index) => [item.id, index]));
    for (const id of [...this.live.keys()]) if (this.branchById.has(id)) this.live.delete(id);
    this.branchLeaf = leaf;
    return true;
  }
  private entryIdOf(id: string): string | undefined {
    const index = this.branchById.get(id);
    return index === undefined ? this.live.get(id)?.view.entryId : this.branch[index]!.entryId;
  }
  private branchView(item: BranchItem, fresh = false): MessageView | null {
    let view = fresh ? undefined : this.viewCache.get(item.source);
    if (view === undefined || (view && (view.id !== item.id || view.entryId !== item.entryId))) {
      view = this.normalize(item.source, item.id, true, item.entryId) ?? null;
      this.viewCache.set(item.source, view);
    }
    return view;
  }
  private storeLive(id: string, source: Record<string, unknown>, view: MessageView): void {
    if (!this.branchById.has(id)) this.live.set(id, { source, view });
  }
  /** Recent window: newest persisted messages within budget, then live ones. */
  private window(): { messages: MessageView[]; olderCursor: string | null } {
    const maxMessages = this.options.windowMessages ?? LIMITS.snapshotWindowMessages;
    const maxBytes = this.options.windowBytes ?? LIMITS.snapshotWindowBytes;
    const messages: MessageView[] = [];
    let bytes = 0;
    let index = this.branch.length - 1;
    for (; index >= 0; index--) {
      const view = this.branchView(this.branch[index]!);
      if (!view) continue;
      const size = encodedSize(view);
      if (messages.length && (messages.length >= maxMessages || bytes + size > maxBytes)) break;
      bytes += size;
      messages.push(view);
    }
    messages.reverse();
    const olderCursor = index >= 0 ? messages.find((message) => message.entryId)?.entryId ?? null : null;
    return { messages: [...messages, ...[...this.live.values()].map((item) => item.view)], olderCursor };
  }
  /** Re-reads the branch when the leaf moved and republishes changed passive entries. */
  private reconcile(): void {
    this.refreshBranch();
    if (this.passiveLeaf === this.branchLeaf) return;
    const next = new Map<string, string>();
    const start = Math.max(0, this.branch.length - LIMITS.snapshotWindowMessages);
    for (const item of this.branch.slice(start)) {
      if (!["custom", "bashExecution"].includes(String(item.source.role))) continue;
      const view = this.branchView(item);
      if (!view) continue;
      const serialized = JSON.stringify(view);
      next.set(item.entryId, serialized);
      // Persisted-only host messages have no reliable public extension event.
      if (this.observer && this.passiveViews.get(item.entryId) !== serialized) this.publish({ type: "msg_end", message: view });
    }
    this.passiveViews = next;
    this.passiveLeaf = this.branchLeaf;
  }
  /** Republishes recent persisted messages whose canonical form differs from what clients last saw. */
  private publishCanonicalTail(): void {
    for (const item of this.branch.slice(-CANONICAL_TAIL)) {
      const view = this.branchView(item, true);
      if (!view) continue;
      const serialized = JSON.stringify(view);
      if (this.sentFinal.get(item.id) === serialized) continue;
      this.rememberFinal(item.id, serialized);
      this.publish({ type: "msg_end", message: view });
    }
  }
  private rememberFinal(id: string, serialized: string): void {
    this.sentFinal.delete(id);
    this.sentFinal.set(id, serialized);
    while (this.sentFinal.size > SENT_FINAL_LIMIT) this.sentFinal.delete(this.sentFinal.keys().next().value!);
  }
  private updateMessage(source: unknown, type: "msg_start" | "msg_delta" | "msg_end"): void {
    if (!isRecord(source)) return;
    // Custom messages persist as a different entry shape without object identity; reconcile() owns them.
    if (source.role === "custom") return;
    const role = String(source.role ?? "custom");
    let id = this.sourceIds.get(source);
    if (!id && type !== "msg_start") id = this.activeByRole.get(role);
    if (!id) id = `live:${randomUUID()}`;
    this.sourceIds.set(source, id);
    if (type !== "msg_end") this.activeByRole.set(role, id);
    else if (this.activeByRole.get(role) === id) this.activeByRole.delete(role);
    if (type === "msg_delta" && this.lastSent.has(id)) {
      this.pendingMessages.set(id, source);
      this.schedule("message");
      return;
    }
    this.pendingMessages.delete(id);
    this.flush();
    const view = this.normalize(source, id, type === "msg_end", this.entryIdOf(id));
    if (!view) return;
    this.storeLive(id, source, view);
    if (type === "msg_end") {
      this.lastSent.delete(id);
      this.rememberFinal(id, JSON.stringify(view));
      const index = this.branchById.get(id);
      if (index !== undefined) this.viewCache.set(this.branch[index]!.source, view);
    } else this.lastSent.set(id, view);
    this.emit({ type: type === "msg_delta" ? "msg_start" : type, message: view });
  }
  private refreshLater(): void {
    if (this.refreshTimer || !this.isCurrent()) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      if (!this.isCurrent()) return;
      try { this.reconcile(); this.publishState(); } catch { /* Stale runtime. */ }
    }, 0);
    this.refreshTimer.unref?.();
  }
  private toolView(event: EventLike, old: ToolView | undefined, end: boolean): ToolView {
    const value = end ? event.result : event.partialResult;
    const text = value === undefined ? undefined : textOf(value);
    const output = text === undefined ? old?.output : text.slice(-LIMITS.toolOutputChars);
    const outputTotal = text === undefined ? old?.outputTotal : text.length > LIMITS.toolOutputChars ? text.length : undefined;
    return {
      id: String(event.toolCallId), name: String(event.toolName ?? old?.name ?? "tool"),
      args: event.args === undefined ? old?.args ?? null : this.previewArgs(event.args).arguments,
      ...(typeof event.parentToolCallId === "string" ? { parentToolCallId: event.parentToolCallId } : old?.parentToolCallId ? { parentToolCallId: old.parentToolCallId } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(outputTotal !== undefined ? { outputTotal } : {}),
      status: end ? event.isError ? "error" : "complete" : "running",
    };
  }
  handleEvent(event: EventLike): void {
    if (!this.isCurrent()) return;
    if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
      this.reconcile();
      this.updateMessage(event.message, event.type === "message_start" ? "msg_start" : event.type === "message_update" ? "msg_delta" : "msg_end");
      if (event.type === "message_end") this.refreshLater();
    } else if (event.type.startsWith("tool_execution_")) {
      const id = String(event.toolCallId);
      const end = event.type === "tool_execution_end";
      const tool = this.toolView(event, this.tools.get(id), end);
      this.tools.delete(id);
      this.tools.set(id, tool);
      if (this.tools.size > LIMITS.retainCompletedTools) {
        for (const [key, value] of this.tools) { if (value.status !== "running" && key !== id) { this.tools.delete(key); break; } }
      }
      if (this.tools.size > LIMITS.maxTools) this.tools.delete(this.tools.keys().next().value!);
      if (event.type === "tool_execution_update") { this.pendingTools.add(id); this.schedule("tool"); }
      else {
        this.pendingTools.delete(id);
        this.publish({ type: end ? "tool_end" : "tool_start", tool });
      }
    } else if (event.type === "session_before_tree") {
      this.treePending = true;
      this.flush();
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
      this.refreshBranch(true);
      if (event.type === "session_compact") {
        // Compaction appends a persisted entry without message events. Replace the attached
        // clients' window in one sequenced event; keep the epoch for the compact completion.
        const window = this.window();
        this.publish({ type: "history_window", ...window });
      }
      this.refreshLater();
    } else if (event.type === "session_info_changed") {
      this.publish({ type: "session_meta", ...(typeof event.name === "string" ? { name: event.name } : {}) });
    } else if (event.type === "turn_end" || event.type === "agent_settled") {
      this.reconcile();
      // Other extensions may replace finalized content after message_end.
      this.publishCanonicalTail();
    }
    this.publishState();
  }
  private finishTree(reason: string): void {
    this.treePending = false;
    if (reason === "tree") this.branchRevision++;
    if (this.messageTimer) { clearTimeout(this.messageTimer); this.messageTimer = undefined; }
    if (this.toolTimer) { clearTimeout(this.toolTimer); this.toolTimer = undefined; }
    this.clearProjection();
    this.refreshBranch();
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
    const colors = theme.colors as Record<string, Parameters<typeof colorToHex>[0]>;
    const vars: Record<string, string> = {};
    // Every resolved pi token, for Markdown, syntax, diff and tool styling.
    for (const key of Object.keys(colors).sort()) {
      try { vars[`--pi-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`] = colorToHex(colors[key]!); } catch { /* skip */ }
    }
    const color = (key: string, fallback: string): string => vars[`--pi-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`] ?? fallback;
    return {
      ...vars,
      "--bg": theme.appearance === "light" ? "#f5f5f4" : "#111315",
      "--fg": color("text", "#eeeeee"), "--fg-muted": color("muted", "#aaaaaa"), "--fg-dim": color("dim", "#888888"),
      "--accent": color("accent", "#a6b9ef"), "--border": color("border", "#343434"),
      "--user-bg": color("userMessageBg", "#25272a"), "--err": color("error", "#f88b8b"),
      "--ok": color("success", "#97cba8"), "--warn": color("warning", "#e5c07b"),
    };
  }
  private publishState(): void {
    if (!this.observer || !this.isCurrent()) return;
    const state = this.state();
    // Tool progress travels as tool_* events; agent_state carries everything else.
    const serialized = JSON.stringify({ ...state, tools: undefined });
    if (serialized !== this.lastState) { this.lastState = serialized; this.publish({ type: "agent_state", state: { ...state, tools: [] } }); }
  }
  private publishTheme(): void {
    const theme = this.theme();
    const serialized = JSON.stringify(theme);
    if (serialized !== this.lastTheme) { this.lastTheme = serialized; this.publish({ type: "theme", theme }); }
  }
  snapshot(): SnapshotBody {
    this.assertCurrent();
    this.refreshBranch();
    const window = this.window();
    return structuredClone({
      session: {
        id: this.sessionId, name: this.options.ctx.sessionManager.getSessionName(), cwd: this.options.ctx.cwd,
        leafId: this.options.ctx.sessionManager.getLeafId(), branchRevision: this.branchRevision,
        messages: window.messages, olderCursor: window.olderCursor,
      },
      state: this.state(), theme: this.theme(),
      caps: { commands: COMMANDS, images: false, promptReceipt: "dispatch_only", queueView: "boolean", terminalDialogs: true, history: "paged", content: "paged" },
    });
  }
  /** Older persisted messages strictly before `before`, newest page first in budget, returned in order. */
  historyPage(before: string, branchRevision: number): Omit<HistoryPage, "t" | "reqId" | "epoch"> {
    this.assertCurrent();
    if (this.treePending || branchRevision !== this.branchRevision) throw new ProtocolError("stale_session", "Refresh the session snapshot before paging.");
    this.refreshBranch();
    const start = this.branchByEntry.get(before);
    if (start === undefined) throw new ProtocolError("cursor_unknown", "The history cursor is not on the current branch.");
    const budget = this.options.pageBytes ?? LIMITS.pageBytes;
    const messages: MessageView[] = [];
    let bytes = 0;
    let index = start - 1;
    for (; index >= 0; index--) {
      const view = this.branchView(this.branch[index]!);
      if (!view) continue;
      const size = encodedSize(view);
      if (messages.length && bytes + size > budget) break;
      bytes += size;
      messages.push(view);
    }
    messages.reverse();
    return { messages: structuredClone(messages), olderCursor: index >= 0 ? messages[0]?.entryId ?? null : null };
  }
  /** A slice of one text block in its full, untruncated form. Never accepts file paths. */
  contentPage(messageId: string, index: number, offset: number): Omit<ContentPage, "t" | "reqId" | "epoch"> {
    this.assertCurrent();
    this.refreshBranch();
    const branchIndex = this.branchById.get(messageId);
    const live = this.live.get(messageId);
    const source = branchIndex !== undefined ? this.branch[branchIndex]!.source : live?.source;
    if (!source) throw new ProtocolError("content_unavailable", "The message is no longer retained by this session view.");
    const block = this.rawBlocks(source).blocks[index];
    if (!block || block.type === "toolCall") throw new ProtocolError("content_unavailable", "This block has no readable text.");
    if (offset > block.text.length) throw new ProtocolError("invalid_args", "Offset is beyond the end of the block.");
    return {
      messageId, index, offset, text: block.text.slice(offset, offset + LIMITS.contentPageChars), total: block.text.length,
      final: branchIndex !== undefined || live?.view.status === "complete",
    };
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
