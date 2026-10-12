/** A small, closed vocabulary: neither theme files nor wire data may supply URLs or CSS. */
export const DECORATION_SLOTS = ["brand", "empty", "settingsHeader", "divider"] as const;
export const DECORATION_ASSETS = ["porcelain-branch", "porcelain-wave"] as const;
export const DECORATION_ROLES = ["accent", "borderAccent", "muted"] as const;
export type DecorationSlot = (typeof DECORATION_SLOTS)[number];
export type DecorationAsset = (typeof DECORATION_ASSETS)[number];
export interface ThemeDecorationSpec {
  asset: DecorationAsset;
  colorRole: (typeof DECORATION_ROLES)[number];
  /** Maximum alpha, in addition to any further reduction by the layout. */
  opacity: number;
  tile: "none" | "repeat-x";
}
export interface ThemeDecorations {
  id: "pi-pane-porcelain";
  slots: Partial<Record<DecorationSlot, ThemeDecorationSpec>>;
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
/** Used at build, host load and browser receipt. Invalid data disables the whole decoration set. */
export function safeDecorations(value: unknown): ThemeDecorations | undefined {
  if (!record(value) || !exactKeys(value, ["id", "slots"]) || value.id !== "pi-pane-porcelain" || !record(value.slots)) return undefined;
  const entries = Object.entries(value.slots);
  if (!entries.length || entries.length > DECORATION_SLOTS.length) return undefined;
  const slots: ThemeDecorations["slots"] = {};
  for (const [slot, spec] of entries) {
    if (!DECORATION_SLOTS.includes(slot as DecorationSlot) || !record(spec) || !exactKeys(spec, ["asset", "colorRole", "opacity", "tile"]) ||
      !DECORATION_ASSETS.includes(spec.asset as DecorationAsset) || !DECORATION_ROLES.includes(spec.colorRole as ThemeDecorationSpec["colorRole"]) ||
      typeof spec.opacity !== "number" || !Number.isFinite(spec.opacity) || spec.opacity <= 0 || spec.opacity > .2 || (spec.tile !== "none" && spec.tile !== "repeat-x")) return undefined;
    slots[slot as DecorationSlot] = { asset: spec.asset as DecorationAsset, colorRole: spec.colorRole as ThemeDecorationSpec["colorRole"], opacity: spec.opacity, tile: spec.tile };
  }
  return { id: "pi-pane-porcelain", slots };
}
