import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../protocol/index.js";
import type { Bridge, BridgeOptions } from "./bridge.js";
import type { RpcChild, RpcRecord } from "./rpc-child.js";

type Entry = { type: string; id: string; parentId: string | null; [key: string]: unknown };
type Message = { role: string; timestamp?: number; content?: unknown; [key: string]: unknown };
interface RpcState {
  model?: { provider: string; id: string; name?: string; input?: string[] };
  thinkingLevel?: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  pendingMessageCount?: number;
}
interface ModelInfo { provider: string; id: string; name?: string; input?: string[] }

/**
 * A synchronous view of the RPC child's session for the existing Bridge, which was written
 * against ExtensionContext. Entries, state and models are cached and refreshed after events;
 * streaming messages are rebuilt from the wire's delta-only updates. Live and persisted
 * messages share one object, so the Bridge's identity-based message mapping keeps working.
 */
export class RpcSessionMirror {
  private entries: Entry[] = [];
  private byId = new Map<string, Entry>();
  private leafId: string | null = null;
  private state: RpcState = {};
  private models: ModelInfo[] = [];
  private streaming = false;
  private pending = 0;
  private current?: Message;
  private toolArgs = new Map<number, string>();
  /** Finished messages awaiting their persisted entry, matched by role and timestamp. */
  private ended: Message[] = [];
  private bridge?: Bridge;
  private syncing?: Promise<void>;
  private resyncAgain = false;
  private disposed = false;
  private unsubscribe: () => void;

  constructor(private readonly child: RpcChild, private readonly cwd: string, private readonly theme: ExtensionContext["ui"]["theme"],
    private readonly themes: () => ReturnType<ExtensionContext["ui"]["getAllThemes"]>, private readonly onUiRequest: (record: RpcRecord) => void) {
    this.unsubscribe = child.onRecord((record) => this.receive(record));
  }
  get sessionFile(): string | undefined { return this.state.sessionFile; }
  get sessionId(): string { return this.state.sessionId ?? ""; }

  async load(): Promise<void> {
    this.entries = []; this.byId.clear(); this.leafId = null; this.ended = []; this.current = undefined;
    const [state, models] = await Promise.all([
      this.child.request<RpcState>("get_state"),
      this.child.request<{ models: ModelInfo[] }>("get_available_models").catch(() => ({ models: [] })),
    ]);
    this.state = state;
    this.models = models.models ?? [];
    this.streaming = !!state.isStreaming;
    this.pending = state.pendingMessageCount ?? 0;
    await this.syncEntries();
  }
  attach(bridge: Bridge): void { this.bridge = bridge; }
  dispose(): void { this.disposed = true; this.bridge = undefined; this.unsubscribe(); }

  /** Appends entries after the last known one; a moved leaf on an unknown cursor reloads everything. */
  private async syncEntries(): Promise<void> {
    const last = this.entries.at(-1)?.id;
    let result: { entries: Entry[]; leafId: string | null };
    try { result = await this.child.request("get_entries", last ? { since: last } : {}); }
    catch { result = await this.child.request("get_entries"); this.entries = []; this.byId.clear(); }
    for (const entry of result.entries) {
      if (this.byId.has(entry.id)) continue;
      if (entry.type === "message" && isRecord(entry.message)) {
        const persisted = entry.message as Message;
        const index = this.ended.findIndex((message) => message.role === persisted.role && message.timestamp === persisted.timestamp);
        if (index >= 0) {
          const live = this.ended.splice(index, 1)[0]!;
          Object.assign(live, persisted);
          entry.message = live;
        }
      }
      this.entries.push(entry);
      this.byId.set(entry.id, entry);
    }
    this.leafId = result.leafId;
  }
  /** Serialized refresh; a request during a refresh schedules exactly one more. */
  private refresh(after?: EventLike): void {
    if (this.syncing) { this.resyncAgain = true; return; }
    this.syncing = (async () => {
      do {
        this.resyncAgain = false;
        try {
          await this.syncEntries();
          const state = await this.child.request<RpcState>("get_state");
          this.state = state;
          this.pending = state.pendingMessageCount ?? this.pending;
        } catch { /* the child may be stopping */ }
      } while (this.resyncAgain);
    })().finally(() => {
      this.syncing = undefined;
      if (!this.disposed) this.forward(after ?? { type: "turn_end" });
    });
  }
  private forward(event: EventLike): void {
    try { this.bridge?.handleEvent(event); } catch { /* projection failures stay local */ }
  }

  private receive(record: RpcRecord): void {
    if (this.disposed) return;
    if (record.type === "extension_ui_request") { this.onUiRequest(record); return; }
    switch (record.type) {
      case "agent_start": this.streaming = true; this.forward(record); break;
      case "agent_settled": this.streaming = false; this.refresh({ type: "agent_settled" }); break;
      case "turn_end": this.refresh({ type: "turn_end" }); break;
      case "queue_update": {
        const steering = Array.isArray(record.steering) ? record.steering.length : 0;
        const followUp = Array.isArray(record.followUp) ? record.followUp.length : 0;
        this.pending = steering + followUp;
        this.forward(record);
        break;
      }
      case "message_start": {
        this.current = record.message as Message;
        this.toolArgs.clear();
        this.forward({ type: "message_start", message: this.current });
        break;
      }
      case "message_update": this.applyDelta(record.assistantMessageEvent); break;
      case "message_end": {
        const finished = record.message as Message;
        const live = this.current && this.current.role === finished.role ? this.current : finished;
        if (live !== finished) { for (const key of Object.keys(live)) delete live[key]; Object.assign(live, finished); }
        this.current = undefined;
        this.ended.push(live);
        this.forward({ type: "message_end", message: live });
        this.refresh({ type: "message_end_persisted" });
        break;
      }
      case "compaction_start": this.state.isCompacting = true; this.forward({ type: "session_before_compact" }); break;
      case "compaction_end":
        this.state.isCompacting = false;
        this.refresh({ type: record.result ? "session_compact" : "session_compact_failed" });
        break;
      case "thinking_level_changed": this.state.thinkingLevel = String(record.level); this.forward({ type: "thinking_level_select" }); break;
      case "session_info_changed": this.state.sessionName = typeof record.name === "string" ? record.name : undefined; this.forward(record); break;
      default:
        if (typeof record.type === "string" && record.type.startsWith("tool_execution_")) this.forward(record);
    }
  }
  /** Rebuilds the cumulative assistant message from wire deltas; *_end values are authoritative. */
  private applyDelta(value: unknown): void {
    const message = this.current;
    if (!message || !isRecord(value)) return;
    if (!Array.isArray(message.content)) message.content = [];
    const content = message.content as Array<Record<string, unknown>>;
    const index = typeof value.contentIndex === "number" ? value.contentIndex : -1;
    switch (value.type) {
      case "text_start": content[index] = { type: "text", text: "" }; break;
      case "text_delta": if (content[index]) content[index] = { ...content[index], text: String(content[index]!.text ?? "") + String(value.delta ?? "") }; break;
      case "text_end": content[index] = { type: "text", text: String(value.content ?? "") }; break;
      case "thinking_start": content[index] = { type: "thinking", thinking: "" }; break;
      case "thinking_delta": if (content[index]) content[index] = { ...content[index], thinking: String(content[index]!.thinking ?? "") + String(value.delta ?? "") }; break;
      case "thinking_end": content[index] = { type: "thinking", thinking: String(value.content ?? "") }; break;
      case "toolcall_start": this.toolArgs.set(index, ""); content[index] = { type: "toolCall", id: value.id, name: value.toolName, arguments: {} }; break;
      case "toolcall_delta": {
        const json = (this.toolArgs.get(index) ?? "") + String(value.delta ?? "");
        this.toolArgs.set(index, json);
        try { if (content[index]) content[index] = { ...content[index], arguments: JSON.parse(json) as unknown }; } catch { /* partial JSON */ }
        break;
      }
      case "toolcall_end": if (isRecord(value.toolCall)) content[index] = value.toolCall; break;
      default: return;
    }
    // A fresh array marks the change; the message object itself keeps its identity.
    message.content = [...content];
    this.forward({ type: "message_update", message });
  }

  private branch(): Entry[] {
    const path: Entry[] = [];
    const seen = new Set<string>();
    for (let id = this.leafId; id && !seen.has(id); id = this.byId.get(id)?.parentId ?? null) {
      seen.add(id);
      const entry = this.byId.get(id);
      if (!entry) break;
      path.push(entry);
    }
    return path.reverse();
  }
  private modelOf(provider: string, id: string) {
    const known = this.models.find((model) => model.provider === provider && model.id === id);
    return known ? { ...known, name: known.name ?? known.id } : undefined;
  }

  /** The subset of ExtensionContext the Bridge reads, backed by the caches above. */
  context(): ExtensionContext {
    const mirror = this;
    return {
      mode: "rpc",
      cwd: this.cwd,
      get model() { return mirror.state.model ? { ...mirror.state.model, name: mirror.state.model.name ?? mirror.state.model.id } : undefined; },
      isIdle: () => !this.streaming && !this.state.isCompacting,
      hasPendingMessages: () => this.pending > 0,
      abort: () => { void this.child.request("abort").catch(() => undefined); },
      compact: (callbacks?: { onComplete?: (result: never) => void; onError?: (error: Error) => void }) => {
        this.child.request("compact", {}, 600_000).then((result) => callbacks?.onComplete?.(result as never), (error: Error) => callbacks?.onError?.(error));
      },
      sessionManager: {
        getSessionId: () => this.sessionId,
        getSessionName: () => this.state.sessionName,
        getSessionFile: () => this.state.sessionFile,
        getLeafId: () => this.leafId,
        getBranch: () => this.branch(),
        getEntry: (id: string) => this.byId.get(id),
      },
      modelRegistry: {
        getAvailable: () => this.models.map((model) => ({ ...model, name: model.name ?? model.id })),
        find: (provider: string, id: string) => this.modelOf(provider, id),
      },
      ui: { theme: this.theme, getAllThemes: this.themes, setStatus: () => {}, notify: () => {} },
    } as unknown as ExtensionContext;
  }
  /** The subset of ExtensionAPI the Bridge calls. Prompts carry an explicit delivery mode, as in the TUI. */
  api(): BridgeOptions["pi"] {
    return {
      sendUserMessage: (content, options) => {
        const parts = typeof content === "string" ? [{ type: "text" as const, text: content }] : content;
        const message = parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
        const images = parts.filter((part) => part.type === "image");
        void this.child.request("prompt", { message, ...(images.length ? { images } : {}), streamingBehavior: options?.deliverAs ?? "followUp" })
          .catch(() => undefined);
      },
      getThinkingLevel: () => (this.state.thinkingLevel ?? "off") as ReturnType<ExtensionAPI["getThinkingLevel"]>,
      setThinkingLevel: (level) => {
        this.state.thinkingLevel = level;
        void this.child.request("set_thinking_level", { level }).then(() => this.refresh({ type: "thinking_level_select" }), () => undefined);
      },
      setModel: async (model) => {
        try {
          await this.child.request("set_model", { provider: model.provider, modelId: model.id });
          this.refresh({ type: "model_select" });
          return true;
        } catch { return false; }
      },
    } as BridgeOptions["pi"];
  }
}
type EventLike = { type: string; [key: string]: unknown };
