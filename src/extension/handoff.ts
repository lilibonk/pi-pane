import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ProtocolError, isRecord } from "../protocol/index.js";
import { Bridge } from "./bridge.js";
import type { Hub, HostHandler } from "./hub.js";
import { RpcChild, type RpcRecord } from "./rpc-child.js";
import { RpcSessionMirror } from "./rpc-session.js";

/** What the TUI hands over: the session it was editing and the CLI configuration it ran with. */
export interface HandoffTarget {
  sessionFile: string;
  /** The TUI's effective session directory; a custom one is not covered by listAll(). */
  sessionDir?: string;
  cwd: string;
  argv: string[];
  theme: ExtensionContext["ui"]["theme"];
  themes: ReturnType<ExtensionContext["ui"]["getAllThemes"]>;
}

const DROP_FLAGS = new Set(["--web", "--web-no-open", "--web-proxy", "--continue", "-c", "--resume", "-r", "--print", "-p"]);
const DROP_WITH_VALUE = new Set(["--web-host", "--web-port", "--web-public-origin", "--web-tls-cert", "--web-tls-key",
  "--session", "--fork", "--mode", "--name"]);
/**
 * The TUI's CLI arguments for the RPC child, minus session selection, output mode and pi-pane's
 * own flags. pi does not export its argument parser, so positional prompts cannot be told apart
 * from flag values; a TUI started with an initial prompt passes it through (spike limitation).
 */
export function childArgs(argv: readonly string[], sessionFile: string): string[] {
  const args: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    const name = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
    if (DROP_FLAGS.has(token)) continue;
    if (DROP_WITH_VALUE.has(name)) { if (!token.includes("=")) index++; continue; }
    args.push(token);
  }
  return [...args, "--session", sessionFile];
}

export interface SessionListing { id: string; name?: string; cwd: string; modified: string; preview: string; current: boolean; messages: number }

/**
 * Kimi-style `/web` handoff: after the TUI has shut down, this process stays in the foreground and
 * a pi RPC child owns the session (the only writer). The existing Hub keeps its URL and token; the
 * browser drives sessions, prompts and extension dialogs through the child.
 */
export class HandoffHost implements HostHandler {
  private child?: RpcChild;
  private mirror?: RpcSessionMirror;
  private bridge?: Bridge;
  private generation = 0;
  private paths = new Map<string, string>();
  private dialogs = new Map<string, Record<string, unknown> & { t: string }>();
  private switching = false;

  constructor(private readonly hub: Hub, private readonly target: HandoffTarget, private readonly log: (line: string) => void) {}

  get sessionFile(): string | undefined { return this.mirror?.sessionFile ?? this.target.sessionFile; }
  get childExited(): Promise<number | null> | undefined { return this.child?.exited; }

  async start(): Promise<void> {
    this.child = new RpcChild(childArgs(this.target.argv, this.target.sessionFile), this.target.cwd);
    this.child.start();
    // Registered before the first snapshot, which advertises the host capabilities.
    this.hub.setHostHandler(this);
    await this.rebind("handoff");
  }
  /** A fresh mirror and Bridge per session: replacement resets the browser's epoch like /new in the TUI. */
  private async rebind(reason: string): Promise<void> {
    this.mirror?.dispose();
    this.bridge?.dispose();
    for (const id of this.dialogs.keys()) this.hub.notifyAll({ t: "ui_resolved", id });
    this.dialogs.clear();
    const generation = ++this.generation;
    const mirror = new RpcSessionMirror(this.child!, this.target.cwd, this.target.theme, () => this.target.themes, (record) => this.dialog(record));
    await mirror.load();
    const bridge = new Bridge({ pi: mirror.api(), ctx: mirror.context(), generation, isCurrent: () => this.generation === generation });
    mirror.attach(bridge);
    this.mirror = mirror;
    this.bridge = bridge;
    this.hub.bindBridge(bridge, reason);
  }

  // ---------------------------------------------------------------------------
  // HostHandler: reads, commands and dialog answers routed by the Hub.
  // ---------------------------------------------------------------------------
  async read(action: string): Promise<unknown> {
    if (action !== "sessions") throw new ProtocolError("unknown_action", "Unknown host read.");
    const lists = await Promise.all([SessionManager.listAll(), ...(this.target.sessionDir ? [SessionManager.listAll(this.target.sessionDir)] : [])]);
    const sessions = [...new Map(lists.flat().map((session) => [session.id, session])).values()];
    const current = this.mirror?.sessionId;
    sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
    const listing = sessions.slice(0, 200);
    this.paths = new Map(listing.map((session) => [session.id, session.path]));
    return listing.map((session): SessionListing => ({
      id: session.id, ...(session.name ? { name: session.name.slice(0, 200) } : {}), cwd: session.cwd,
      modified: session.modified.toISOString(), preview: (session.firstMessage ?? "").slice(0, 200),
      current: session.id === current, messages: session.messageCount,
    }));
  }
  async command(name: string, args: unknown): Promise<unknown> {
    if (this.switching) throw new ProtocolError("busy", "A session change is already in progress.");
    if (!this.mirror?.context().isIdle()) throw new ProtocolError("busy", "Wait until the session is idle before changing sessions.");
    this.switching = true;
    try {
      let result: { cancelled?: boolean };
      if (name === "host_new") result = await this.child!.request("new_session");
      else if (name === "host_switch") {
        const path = isRecord(args) && typeof args.sessionId === "string" ? this.paths.get(args.sessionId) : undefined;
        if (!path) throw new ProtocolError("unknown_session", "List sessions again and choose one of them.");
        result = await this.child!.request("switch_session", { sessionPath: path });
      } else throw new ProtocolError("unknown_command", "Unknown host command.");
      if (!result.cancelled) await this.rebind(name === "host_new" ? "new" : "resume");
      return { cancelled: !!result.cancelled, sessionId: this.mirror?.sessionId };
    } finally { this.switching = false; }
  }
  answer(id: string, response: Record<string, unknown>): void {
    if (!this.dialogs.delete(id)) throw new ProtocolError("dialog_closed", "This dialog was already answered or closed.");
    this.child!.respondUi(id, response);
    // Every viewer closes the dialog, whoever answered it.
    this.hub.notifyAll({ t: "ui_resolved", id });
  }
  pendingDialogs(): unknown[] { return [...this.dialogs.values()]; }

  /** Extension UI from the child: dialogs go to every browser; notifications become notices. */
  private dialog(record: RpcRecord): void {
    const id = typeof record.id === "string" ? record.id : undefined;
    if (!id) return;
    if (["select", "confirm", "input", "editor"].includes(String(record.method))) {
      const request = { t: "ui_request" as const, id, method: String(record.method),
        ...(typeof record.title === "string" ? { title: record.title.slice(0, 500) } : {}),
        ...(typeof record.message === "string" ? { message: record.message.slice(0, 4000) } : {}),
        ...(Array.isArray(record.options) ? { options: record.options.slice(0, 64).map((option) => String(option).slice(0, 500)) } : {}),
        ...(typeof record.placeholder === "string" ? { placeholder: record.placeholder.slice(0, 500) } : {}),
        ...(typeof record.prefill === "string" ? { prefill: record.prefill.slice(0, 64_000) } : {}),
        ...(typeof record.timeout === "number" ? { timeout: record.timeout } : {}) };
      this.dialogs.set(id, request);
      this.hub.notifyAll(request);
      if (typeof record.timeout === "number") {
        // pi resolves timed-out dialogs itself; close them in the browsers too.
        const timer = setTimeout(() => { if (this.dialogs.delete(id)) this.hub.notifyAll({ t: "ui_resolved", id }); }, record.timeout);
        timer.unref?.();
      }
    } else if (record.method === "notify" && typeof record.message === "string") {
      this.hub.notifyAll({ t: "notice", message: record.message.slice(0, 2000) });
    }
  }

  async stop(): Promise<void> {
    this.mirror?.dispose();
    this.bridge?.dispose();
    await this.child?.stop();
  }
}
