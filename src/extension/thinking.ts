import { isRecord, type ContentView } from "../protocol/index.js";

type TimingView = Pick<Extract<ContentView, { type: "thinking" }>, "durationMs" | "timingStatus">;
interface Timing {
  startedAt?: number;
  durationMs?: number;
  timingStatus: "running" | "complete" | "interrupted";
  text?: string;
}
type Timings = Map<number, Timing>;

/** Completed timing follows source lifetime; observing history never creates a timer. */
export class ThinkingTimings {
  private sources = new WeakMap<object, Timings>();
  private active = new Map<string, Timings>();

  constructor(private readonly now: () => number, private readonly maxBlocks: number) {}

  clear(): void { this.sources = new WeakMap(); this.active.clear(); }
  runningIds(): string[] {
    return [...this.active].filter(([, timings]) => [...timings.values()].some((timing) => timing.startedAt !== undefined)).map(([id]) => id);
  }
  transfer(previous: object, next: object): void {
    const timings = this.sources.get(previous);
    if (timings) this.sources.set(next, timings);
  }
  observe(id: string, source: Record<string, unknown>, event: unknown): void {
    if (!isRecord(event) || !Number.isInteger(event.contentIndex) || (event.contentIndex as number) < 0 ||
        (event.contentIndex as number) >= this.maxBlocks || !["thinking_start", "thinking_end"].includes(String(event.type))) return;
    const index = event.contentIndex as number;
    const text = this.text(source, index);
    if (text === undefined) return;
    let timings = this.active.get(id);
    if (event.type === "thinking_start") {
      if (!timings) { timings = new Map(); this.active.set(id, timings); }
      // Duplicate starts must not erase time already observed for this content index.
      if (!timings.has(index)) timings.set(index, { startedAt: this.now(), timingStatus: "running" });
    } else {
      const timing = timings?.get(index);
      if (timing?.startedAt !== undefined) this.stop(timing, text, "complete");
    }
    if (timings) this.sources.set(source, timings);
  }
  finish(id: string, source: Record<string, unknown>): void {
    const timings = this.active.get(id);
    if (!timings) return;
    for (const [index, timing] of timings) {
      if (timing.startedAt !== undefined) this.stop(timing, this.text(source, index), "interrupted");
    }
    this.sources.set(source, timings);
    this.active.delete(id);
  }
  view(id: string, source: object, index: number, text: string): TimingView {
    const timing = (this.active.get(id) ?? this.sources.get(source))?.get(index);
    if (!timing) return {};
    if (timing.timingStatus === "running") return { timingStatus: "running" };
    // A canonical rewrite is a different thought; its duration was never observed.
    if (timing.text !== text) return {};
    return { durationMs: timing.durationMs, timingStatus: timing.timingStatus };
  }
  private text(source: Record<string, unknown>, index: number): string | undefined {
    const part: unknown = Array.isArray(source.content) ? source.content[index] : undefined;
    return isRecord(part) && part.type === "thinking" ? String(part.thinking ?? part.text ?? "") : undefined;
  }
  private stop(timing: Timing, text: string | undefined, status: "complete" | "interrupted"): void {
    timing.durationMs = Math.max(0, Math.round(this.now() - timing.startedAt!));
    timing.timingStatus = status;
    timing.text = text;
    delete timing.startedAt;
  }
}
