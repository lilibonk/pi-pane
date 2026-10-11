import { Theme } from "@earendil-works/pi-coding-agent";
import { parseColor } from "@earendil-works/pi-tui";
import { constants } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import type { PiThemeView, ThemeItem, ThemeProblem, ThemeSource } from "../protocol/index.js";
import { ThemeMapper, exportPageBackground, type PaneTheme } from "./theme.js";

const MAX_THEME_BYTES = 256 * 1024;
const MAX_FILES = 128;
/** pi's `system` theme is generated from the terminal's colors; no file may take its name. */
const SYSTEM = "system";
const BACKGROUNDS = new Set(["selectedBg", "searchMatchBg", "userMessageBg", "customMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg"]);
/** Tokens a theme file may omit, and the token pi uses in their place. */
const FALLBACKS: Readonly<Record<string, string>> = { scrollbarTrack: "muted", scrollbarThumb: "text", thinkingMax: "thinkingXhigh", searchMatchBg: "selectedBg", searchMatchText: "text" };
/** Every token pi 1.1.0 requires of a theme file. A test compares this list with pi's built-in themes. */
export const REQUIRED_TOKENS: readonly string[] = [
  "accent", "border", "borderAccent", "borderMuted", "success", "error", "warning", "muted", "dim", "text", "thinkingText",
  "selectedBg", "userMessageBg", "userMessageText", "customMessageBg", "customMessageText", "customMessageLabel",
  "toolPendingBg", "toolSuccessBg", "toolErrorBg", "toolTitle", "toolOutput",
  "mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder", "mdHr", "mdListBullet",
  "toolDiffAdded", "toolDiffRemoved", "toolDiffContext",
  "syntaxComment", "syntaxKeyword", "syntaxFunction", "syntaxVariable", "syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator", "syntaxPunctuation",
  "thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh", "bashMode",
];
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const clip = (text: string, length: number): string => text.length <= length ? text : `${text.slice(0, length)}…`;
const canonical = (path: string): Promise<string> => realpath(path).catch(() => resolve(path));
const inside = (path: string, directory: string): boolean => path === directory || path.startsWith(directory.endsWith(sep) ? directory : directory + sep);

class ThemeFileError extends Error {
  constructor(readonly code: ThemeProblem["code"], message: string, readonly themeName?: string) { super(message); }
}
/** Reads a regular file of bounded size. A path that turned into a FIFO or grew past the limit is refused, not waited on. */
async function readBounded(path: string): Promise<string> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile()) throw new ThemeFileError("unreadable", "Not a regular file.");
    if (info.size > MAX_THEME_BYTES) throw new ThemeFileError("too_large", "Theme files are limited to 256 KiB.");
    const bytes = Buffer.alloc(MAX_THEME_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_THEME_BYTES) throw new ThemeFileError("too_large", "Theme files are limited to 256 KiB.");
    return bytes.subarray(0, size).toString("utf8").replace(/^﻿/, "");
  } catch (error) {
    if (error instanceof ThemeFileError) throw error;
    throw new ThemeFileError("unreadable", (error as NodeJS.ErrnoException).code === "ENOENT" ? "The file no longer exists." : "The file could not be read.");
  } finally { await file?.close().catch(() => undefined); }
}
/** pi's rule for a color value: a literal, or a name looked up in `vars` until a literal is reached. */
function resolveColor(token: string, value: unknown, vars: Record<string, unknown>): string | number {
  const seen = new Set<string>();
  for (let depth = 0; depth < 64; depth++) {
    if (typeof value === "number") {
      if (Number.isInteger(value) && value >= 0 && value <= 255) return value;
      throw new ThemeFileError("invalid_theme", `"${token}" is not a color index between 0 and 255.`);
    }
    if (typeof value !== "string") throw new ThemeFileError("invalid_theme", `"${token}" is not a color.`);
    if (value === "") return value; // the terminal's default color
    if (value.startsWith("#") || /^ok(lch|hsl)\(/i.test(value)) {
      try { parseColor(value); } catch { throw new ThemeFileError("invalid_theme", `"${token}" is not a valid color.`); }
      return value;
    }
    if (seen.has(value)) throw new ThemeFileError("invalid_theme", `"${token}" refers to itself through "${clip(value, 40)}".`);
    if (!Object.hasOwn(vars, value)) throw new ThemeFileError("invalid_theme", `"${token}" refers to "${clip(value, 40)}", which is not defined.`);
    seen.add(value); value = vars[value];
  }
  throw new ThemeFileError("invalid_theme", `"${token}" is nested too deeply.`);
}
export interface ParsedTheme { name: string; theme: PaneTheme; pageBg?: string }
/**
 * A theme file as pi reads it, built with pi's public `Theme` class and nothing else of pi's loader:
 * the same variable resolution and optional-token fallbacks, plus the validation pi only performs in
 * its TUI. Only colors are taken from the file; unknown fields are ignored.
 */
export function parseThemeText(text: string, sourcePath: string): ParsedTheme {
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new ThemeFileError("invalid_json", "The file is not valid JSON."); }
  if (!record(json) || !record(json.colors)) throw new ThemeFileError("invalid_theme", "A theme needs a name and a colors map.");
  const name = typeof json.name === "string" ? json.name.trim() : "";
  if (!name || name.length > 64 || /[\/\0-\x1f]/.test(name)) throw new ThemeFileError("invalid_theme", "The theme name is missing, too long, or contains a slash.");
  if (name === SYSTEM) throw new ThemeFileError("reserved_name", `"${SYSTEM}" is pi's own terminal theme; a file cannot replace it.`, name);
  const vars = record(json.vars) ? json.vars : {};
  const colors: Record<string, unknown> = { ...json.colors };
  for (const [token, fallback] of Object.entries(FALLBACKS)) colors[token] ??= colors[fallback];
  const missing = REQUIRED_TOKENS.filter(token => colors[token] === undefined);
  if (missing.length) throw new ThemeFileError("invalid_theme", `Missing colors: ${clip(missing.join(", "), 200)}.`, name);
  const fg: Record<string, string | number> = {}, bg: Record<string, string | number> = {};
  try {
    for (const token of [...REQUIRED_TOKENS, ...Object.keys(FALLBACKS)]) (BACKGROUNDS.has(token) ? bg : fg)[token] = resolveColor(token, colors[token], vars);
  } catch (error) { throw error instanceof ThemeFileError ? new ThemeFileError(error.code, error.message, name) : error; }
  const appearance = json.appearance === "light" || json.appearance === "dark" ? json.appearance : undefined;
  const theme = new Theme(fg as never, bg as never, "truecolor", { name, sourcePath, ...(appearance ? { appearance } : {}) });
  const pageBg = exportPageBackground(json);
  return { name, theme, ...(pageBg ? { pageBg } : {}) };
}
export interface CatalogEntry extends ParsedTheme { source: ThemeSource; path: string; global: boolean; vars: Record<string, string> }
export interface Catalog { entries: Map<string, CatalogEntry>; problems: ThemeProblem[]; truncated: boolean; projectThemes: "loaded" | "untrusted" | "none" }
export interface ThemeCatalogOptions {
  agentDir: string;
  /** The `themes` directory shipped with this package. */
  bundledDir: string;
  /** pi's own theme list at the moment `/web` was run: built-ins with their files, and everything pi had discovered. */
  handoff: ReadonlyArray<{ name: string; path: string | undefined }>;
  /** The terminal theme in use when `/web` was run. It is what "follow pi" shows when nothing better is known. */
  handoffTheme: PaneTheme;
  startCwd: string;
  /** False when pi was started with `--no-themes`: the user and project theme directories are then not read here either. */
  discover?: boolean;
}
/**
 * The themes a browser may choose from, for one project at a time.
 *
 * Sources, in the order a name is resolved: the trusted project's `.pi/themes`, pi's user theme
 * directory, what pi had found at handoff, pi's built-in `dark` and `light`, this package's own.
 * Nothing is installed, no package is resolved and no extension is loaded to build the list: themes
 * that only a package or a configured path provides are known from the handoff list, in full for the
 * start project and, elsewhere, only when they live under pi's agent directory.
 */
export class ThemeCatalog {
  private readonly mapper = new ThemeMapper();
  private cache?: { key: string; at: number; catalog: Catalog };
  constructor(private readonly options: ThemeCatalogOptions) {}

  private async files(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    return entries.filter(entry => entry.name.endsWith(".json") && (entry.isFile() || entry.isSymbolicLink())).map(entry => join(directory, entry.name)).sort();
  }
  /** `fresh` re-reads every file; otherwise a list read within the last two seconds is reused. */
  async load(cwd: string, projectTrusted: boolean, fresh = true): Promise<Catalog> {
    const key = `${cwd}\0${projectTrusted}`;
    if (!fresh && this.cache?.key === key && Date.now() - this.cache.at < 2000) return this.cache.catalog;
    const agentDir = await canonical(this.options.agentDir), bundledDir = await canonical(this.options.bundledDir);
    const inStartProject = await canonical(cwd) === await canonical(this.options.startCwd);
    const projectDir = join(cwd, ".pi", "themes");
    const discover = this.options.discover !== false;
    const projectFiles = discover ? await this.files(projectDir) : [];
    const candidates: { path: string; source: ThemeSource }[] = [];
    if (projectTrusted) for (const path of projectFiles) candidates.push({ path, source: "project" });
    if (discover) for (const path of await this.files(join(this.options.agentDir, "themes"))) candidates.push({ path, source: "user" });
    const builtin: typeof candidates = [];
    for (const item of this.options.handoff) {
      if (!item.path || item.name === SYSTEM) continue;
      if (item.name === "dark" || item.name === "light") builtin.push({ path: item.path, source: "builtin" });
      else candidates.push({ path: item.path, source: "handoff" });
    }
    candidates.push(...builtin);
    for (const path of await this.files(this.options.bundledDir)) candidates.push({ path, source: "pi-pane" });

    const entries = new Map<string, CatalogEntry>(), problems: ThemeProblem[] = [], seen = new Set<string>();
    // pi knows a theme everywhere when it is built in, in the user directory, or in a package under the agent directory.
    const known = new Set(this.options.handoff.map(item => item.name));
    let read = 0, truncated = false;
    for (const candidate of candidates) {
      const real = await canonical(candidate.path);
      if (seen.has(real)) continue;
      seen.add(real);
      const source: ThemeSource = inside(real, bundledDir) ? "pi-pane" : candidate.source === "handoff" && inside(real, join(agentDir, "themes")) ? "user" : candidate.source;
      // Outside the start project, a handoff theme is kept only when it belongs to pi's own directory.
      if (source === "handoff" && !inStartProject && !inside(real, agentDir)) continue;
      if (read >= MAX_FILES) { truncated = true; break; }
      read++;
      const problem = (code: ThemeProblem["code"], message: string, name?: string): void => {
        if (problems.length < 64) problems.push({ file: clip(basename(candidate.path), 120), source, code, message: clip(message, 300), ...(name ? { name } : {}) });
      };
      try {
        const parsed = parseThemeText(await readBounded(candidate.path), candidate.path);
        const earlier = entries.get(parsed.name);
        if (earlier) { problem("duplicate", `Another theme named "${parsed.name}" is used instead.`, parsed.name); continue; }
        const global = source === "builtin" || source === "user" || (source === "pi-pane" ? known.has(parsed.name) : source === "handoff" && inside(real, agentDir));
        entries.set(parsed.name, { ...parsed, source, path: candidate.path, global, vars: this.mapper.vars(parsed.theme, parsed.pageBg) });
      } catch (error) {
        if (error instanceof ThemeFileError) problem(error.code, error.message, error.themeName); else problem("invalid_theme", "The theme could not be loaded.");
      }
    }
    const catalog: Catalog = { entries, problems, truncated, projectThemes: projectTrusted && projectFiles.length ? "loaded" : projectFiles.length ? "untrusted" : "none" };
    this.cache = { key, at: Date.now(), catalog };
    return catalog;
  }
  items(catalog: Catalog): ThemeItem[] {
    const rank: Record<ThemeSource, number> = { "pi-pane": 0, builtin: 1, user: 2, project: 3, handoff: 4 };
    return [...catalog.entries.values()].map(entry => ({ name: entry.name, source: entry.source, appearance: entry.theme.appearance, global: entry.global,
      preview: { bg: entry.vars["--bg"]!, fg: entry.vars["--fg"]!, accent: entry.vars["--accent"]! } }))
      .sort((a, b) => rank[a.source] - rank[b.source] || a.name.localeCompare(b.name));
  }
  /**
   * The theme pi would use in this project, from its setting (`name`, or `light/dark` chosen by the
   * terminal's appearance at handoff). `system`, a name that is not in the catalog and a malformed
   * setting all show the handoff theme, and say so.
   */
  resolvePi(catalog: Catalog, setting: string | undefined, source: PiThemeView["source"]): { view: PiThemeView; theme: PaneTheme } {
    const handoff = this.options.handoffTheme;
    const fallback = (reason: NonNullable<PiThemeView["reason"]>): { view: PiThemeView; theme: PaneTheme } =>
      ({ theme: handoff, view: { ...(setting ? { setting: clip(setting, 140) } : {}), source, name: clip(handoff.name ?? SYSTEM, 64), appearance: handoff.appearance, origin: "handoff", reason } });
    const wanted = themeNames(setting ?? SYSTEM);
    if (!wanted) return fallback("invalid");
    const name = wanted.length === 2 ? wanted[handoff.appearance === "light" ? 0 : 1]! : wanted[0]!;
    if (name === SYSTEM) return fallback("system");
    const entry = catalog.entries.get(name);
    if (!entry) return fallback("missing");
    return { theme: entry.theme, view: { ...(setting ? { setting: clip(setting, 140) } : {}), source, name, appearance: entry.theme.appearance, origin: "catalog" } };
  }
}
/** The names in pi's theme setting: one, or a `light/dark` pair. Undefined when it is neither. */
export function themeNames(setting: string): string[] | undefined {
  const parts = setting.split("/").map(part => part.trim());
  return parts.length <= 2 && parts.every(part => part.length > 0 && part.length <= 64) ? parts : undefined;
}
