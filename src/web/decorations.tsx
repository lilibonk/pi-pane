import { useSyncExternalStore } from "preact/compat";
import { safeDecorations, type DecorationSlot } from "../protocol/theme-decorations.js";
import { webStore } from "./store.js";

// These same-origin URLs are compiled application code, never provided by themes or wire data.
const MASKS = {
  "porcelain-branch": 'url("/decorations/porcelain-branch.svg")',
  "porcelain-wave": 'url("/decorations/porcelain-wave.svg")',
};
const COLORS = { accent: "var(--pi-accent)", borderAccent: "var(--pi-border-accent)", muted: "var(--pi-muted)" };

/** Empty, inert layout box. It remains present when artwork is unavailable or disabled. */
export function ThemeDecoration({ slot }: { slot: DecorationSlot }) {
  const state = useSyncExternalStore(webStore.subscribe, webStore.getState);
  const appearance = state.appearancePreview ?? state.appearance;
  const decorations = safeDecorations(state.themeName ? state.themeDecorations : state.snapshot?.decorations);
  const spec = appearance.showDecorations === false ? undefined : decorations?.slots[slot];
  const mask = spec && MASKS[spec.asset];
  return <span aria-hidden="true" class="theme-decoration" data-slot={slot} data-active={spec ? "true" : "false"} data-tile={spec?.tile}
    style={spec ? { backgroundColor: COLORS[spec.colorRole], opacity: spec.opacity, maskImage: mask, WebkitMaskImage: mask,
      maskSize: spec.tile === "none" ? "contain" : "auto 100%", WebkitMaskSize: spec.tile === "none" ? "contain" : "auto 100%",
      maskPosition: "center", WebkitMaskPosition: "center", maskRepeat: spec.tile === "none" ? "no-repeat" : "repeat-x", WebkitMaskRepeat: spec.tile === "none" ? "no-repeat" : "repeat-x",
      pointerEvents: "none" } : { visibility: "hidden", pointerEvents: "none" }} />;
}
