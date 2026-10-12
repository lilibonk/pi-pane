import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import { colorToHex, mixColors, parseColor, type Color } from "@earendil-works/pi-tui";
import { loadThemeDecorations } from "./theme-decorations.js";
import type { ThemeDecorations } from "../protocol/theme-decorations.js";

export interface PaneTheme {
  readonly name?: string;
  readonly sourcePath?: string;
  readonly appearance: "light" | "dark";
  readonly colors: Readonly<Record<string, Color>>;
}
type ThemePaths = () => { name: string; path: string | undefined }[];
const MAX_THEME_BYTES = 256 * 1024;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const tokenName = (key: string): string => `--pi-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;

/** Resolve only a color, never CSS or a path, from the optional export section. */
export function exportPageBackground(json: unknown): string | undefined {
  if (!record(json) || !record(json.export)) return undefined;
  let value: unknown = json.export.pageBg;
  const vars = record(json.vars) ? json.vars : {};
  const visited = new Set<string>();
  for (let depth = 0; depth < 64; depth++) {
    if (value === "" || value === undefined) return undefined;
    if (typeof value === "number" || (typeof value === "string" && /^(#|ok(?:lch|hsl)\()/i.test(value))) {
      try { return colorToHex(parseColor(value)); } catch { return undefined; }
    }
    if (typeof value !== "string" || visited.has(value) || !Object.hasOwn(vars, value)) return undefined;
    visited.add(value);
    value = vars[value];
  }
  return undefined;
}

/** Synchronous, bounded reads preserve the snapshot/sequence capture boundary. */
export class ThemeMapper {
  private theme?: PaneTheme;
  private name?: string;
  private sourcePath?: string;
  private path?: string;
  private fingerprint?: string;
  private pageBg?: string;

  private background(theme: PaneTheme, available?: ThemePaths): string | undefined {
    if (theme !== this.theme || theme.name !== this.name || theme.sourcePath !== this.sourcePath) {
      this.theme = theme;
      this.name = theme.name;
      this.sourcePath = theme.sourcePath;
      let path = theme.sourcePath;
      // Built-in themes have no sourcePath; their paths are exposed by the public UI API.
      if (!path && theme.name && available) {
        try { path = available().find((entry) => entry.name === theme.name)?.path; } catch { /* optional metadata */ }
      }
      if (path !== this.path) {
        this.path = path;
        this.fingerprint = undefined;
        this.pageBg = undefined;
      }
    }
    if (!this.path) return undefined;
    let fd: number | undefined;
    try {
      const info = statSync(this.path);
      const fingerprint = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      if (fingerprint === this.fingerprint) return this.pageBg;
      this.fingerprint = fingerprint;
      this.pageBg = undefined;
      if (!info.isFile() || info.size > MAX_THEME_BYTES) return undefined;
      // O_NONBLOCK also prevents a replaced path from hanging the host if it becomes a FIFO.
      fd = openSync(this.path, constants.O_RDONLY | constants.O_NONBLOCK);
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.size > MAX_THEME_BYTES) return undefined;
      const bytes = Buffer.alloc(MAX_THEME_BYTES + 1);
      let size = 0;
      while (size < bytes.length) {
        const count = readSync(fd, bytes, size, bytes.length - size, null);
        if (!count) break;
        size += count;
      }
      if (size > MAX_THEME_BYTES) return undefined;
      // Cache malformed documents too; an editor may leave one unchanged between saves.
      try { this.pageBg = exportPageBackground(JSON.parse(bytes.subarray(0, size).toString("utf8").replace(/^\uFEFF/, ""))); }
      catch { return undefined; }
      return this.pageBg;
    } catch {
      this.fingerprint = undefined;
      this.pageBg = undefined;
      return undefined;
    } finally { if (fd !== undefined) closeSync(fd); }
  }

  map(theme: PaneTheme, available?: ThemePaths): Record<string, string> { return this.vars(theme, this.background(theme, available)); }
  /** Unlike color fallback, decoration binding must never infer a source from a display name. */
  decorations(theme: PaneTheme): ThemeDecorations | undefined { return loadThemeDecorations(theme.sourcePath); }
  /** The page's CSS variables for a theme whose export background, if it has one, is already known. */
  vars(theme: PaneTheme, pageBg?: string): Record<string, string> {
    const light = theme.appearance === "light";
    const vars: Record<string, string> = {};
    const colors = theme.colors;
    for (const key of Object.keys(colors).sort()) {
      try {
        const value = colorToHex(colors[key]!);
        if (/^#[\da-f]{6}$/i.test(value)) vars[tokenName(key)] = value;
      } catch { /* A malformed optional token must not interrupt session updates. */ }
    }
    const color = (key: string, fallback: string): string => vars[tokenName(key)] ?? fallback;
    const bg = pageBg ?? (light ? "#f5f5f4" : "#111315");
    const fg = color("text", light ? "#252525" : "#eeeeee");
    const accent = color("accent", light ? "#445b9f" : "#a6b9ef");
    const mix = (first: string, second: string, amount: number): string => colorToHex(mixColors(parseColor(first), parseColor(second), amount, "oklch"));
    return {
      ...vars,
      "--bg": bg, "--fg": fg,
      "--fg-muted": color("muted", light ? "#626262" : "#aaaaaa"),
      "--fg-dim": color("dim", light ? "#737373" : "#888888"),
      "--accent": accent, "--border": color("border", light ? "#cecece" : "#343434"),
      "--user-bg": color("userMessageBg", light ? "#e7e7e7" : "#25272a"),
      "--err": color("error", light ? "#ab3333" : "#f88b8b"),
      "--ok": color("success", light ? "#277640" : "#97cba8"),
      "--warn": color("warning", light ? "#846008" : "#e5c07b"),
      "--surface": mix(bg, fg, light ? .025 : .05),
      "--sidebar-bg": mix(bg, accent, light ? .025 : .04),
      "--hover-bg": mix(bg, accent, light ? .09 : .13),
      "--code-bg": mix(bg, fg, light ? .035 : .07),
      "--shadow-color": mix(bg, "#000000", light ? .35 : .7),
    };
  }
}
