/**
 * How this browser looks. A preference of this browser only: it is stored here, changes no pi
 * setting, and other devices keep their own.
 *
 * - `pi`: what pi would use in the current project (the session snapshot's theme).
 * - `system`: this device's light or dark preference, shown with pi-pane's own light and dark themes.
 *   Not pi's `system` theme, which is the terminal's palette.
 * - `light` / `dark`: pi-pane's own themes. `theme`: one installed pi theme, by name.
 */
export type AppearanceMode = "pi" | "system" | "light" | "dark" | "theme";
export interface Appearance { mode: AppearanceMode; theme?: string; hideThinking?: boolean; showDecorations?: boolean }
export type ThemeVars = Record<string, string>;
export const LIGHT_THEME = "pi-pane-light", DARK_THEME = "pi-pane-dark";
export const DEFAULT_APPEARANCE: Appearance = { mode: "pi" };
const KEY = "pi-pane.appearance";
const MAX_CACHED = 4;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The theme the host must be asked for, or undefined when the snapshot's own theme applies. */
export function wantedTheme(appearance: Appearance, prefersDark: boolean): string | undefined {
  switch (appearance.mode) {
    case "pi": return undefined;
    case "system": return prefersDark ? DARK_THEME : LIGHT_THEME;
    case "light": return LIGHT_THEME;
    case "dark": return DARK_THEME;
    case "theme": return appearance.theme;
  }
}
/** Only color variables ever reach the page's style: a name pi-pane defines and a hex color. */
export function safeVars(value: unknown): ThemeVars | undefined {
  if (!isRecord(value)) return undefined;
  const vars: ThemeVars = {};
  let count = 0;
  for (const [key, color] of Object.entries(value)) {
    if (count++ >= 256) break;
    if (/^--[a-z][a-z0-9-]*$/.test(key) && typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color)) vars[key] = color;
  }
  return vars["--bg"] && vars["--fg"] ? vars : undefined;
}
export function parseAppearance(text: string | null): { appearance: Appearance; cache: Record<string, ThemeVars> } {
  const empty = { appearance: DEFAULT_APPEARANCE, cache: {} };
  if (!text) return empty;
  let stored: unknown;
  try { stored = JSON.parse(text); } catch { return empty; }
  if (!isRecord(stored) || stored.v !== 1) return empty;
  const mode = stored.mode === "system" || stored.mode === "light" || stored.mode === "dark" || stored.mode === "theme" ? stored.mode : "pi";
  const theme = typeof stored.theme === "string" && stored.theme.length > 0 && stored.theme.length <= 64 ? stored.theme : undefined;
  const cache: Record<string, ThemeVars> = {};
  if (isRecord(stored.cache)) for (const [name, vars] of Object.entries(stored.cache).slice(0, MAX_CACHED)) {
    const safe = name.length <= 64 ? safeVars(vars) : undefined;
    if (safe) cache[name] = safe;
  }
  // A named theme without a name is no choice at all.
  return { appearance: { mode: mode === "theme" && !theme ? "pi" : mode, ...(mode === "theme" && theme ? { theme } : {}), ...(stored.hideThinking === true ? { hideThinking: true } : {}), ...(stored.showDecorations === false ? { showDecorations: false } : {}) }, cache };
}
export function serializeAppearance(appearance: Appearance, cache: Record<string, ThemeVars>): string {
  // Colors are kept for the themes this choice can show, so the page paints before it connects and
  // keeps its last valid colors when a theme later goes missing.
  const names = appearance.mode === "pi" ? [] : appearance.mode === "theme" ? [appearance.theme!] : appearance.mode === "system" ? [LIGHT_THEME, DARK_THEME] : [appearance.mode === "light" ? LIGHT_THEME : DARK_THEME];
  return JSON.stringify({ v: 1, mode: appearance.mode, ...(appearance.theme && appearance.mode === "theme" ? { theme: appearance.theme } : {}), ...(appearance.hideThinking ? { hideThinking: true } : {}), ...(appearance.showDecorations === false ? { showDecorations: false } : {}),
    cache: Object.fromEntries(names.filter(name => cache[name]).map(name => [name, cache[name]])) });
}
export function loadAppearance(): { appearance: Appearance; cache: Record<string, ThemeVars> } {
  try { return parseAppearance(localStorage.getItem(KEY)); } catch { return { appearance: DEFAULT_APPEARANCE, cache: {} }; }
}
/** Returns false when this browser cannot keep the choice (private mode, storage disabled). */
export function saveAppearance(appearance: Appearance, cache: Record<string, ThemeVars>): boolean {
  try {
    if (appearance.mode === "pi" && !appearance.hideThinking && appearance.showDecorations !== false) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, serializeAppearance(appearance, cache));
    return true;
  } catch { return false; }
}
