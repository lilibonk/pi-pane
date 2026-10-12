import { closeSync, constants, existsSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DECORATION_ASSETS, safeDecorations, type ThemeDecorations } from "../protocol/theme-decorations.js";

export const BUNDLED_THEME_DIR = fileURLToPath(new URL("../../themes/", import.meta.url));
export const MAX_DECORATION_BYTES = 32 * 1024;
const MANIFEST_BYTES = 4 * 1024;
const inside = (path: string, directory: string): boolean => path.startsWith(directory.endsWith(sep) ? directory : directory + sep);
function readBounded(path: string, limit: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error("Decoration resource exceeds its file limit.");
    const bytes = Buffer.alloc(limit + 1); let size = 0;
    while (size < bytes.length) { const count = readSync(fd, bytes, size, bytes.length - size, null); if (!count) break; size += count; }
    if (size > limit) throw new Error("Decoration resource exceeds its file limit.");
    return bytes.subarray(0, size).toString("utf8");
  } finally { closeSync(fd); }
}
/** Deliberately narrow SVG grammar: geometry only, with alpha supplied by currentColor. */
export function validDecorationSvg(svg: string): boolean {
  if (Buffer.byteLength(svg) > MAX_DECORATION_BYTES || /[&!?]/.test(svg)) return false;
  const allowed: Record<string, RegExp> = {
    xmlns: /^http:\/\/www\.w3\.org\/2000\/svg$/, viewBox: /^0 0 [\d.]+ [\d.]+$/,
    fill: /^(none|currentColor)$/, stroke: /^(none|currentColor)$/, "stroke-width": /^[\d.]+$/,
    "stroke-linecap": /^(round|butt|square)$/, "stroke-linejoin": /^(round|miter|bevel)$/,
    d: /^[MmLlHhVvCcSsQqTtAaZz\d.,\s+-]+$/, cx: /^[\d.]+$/, cy: /^[\d.]+$/, r: /^[\d.]+$/, rx: /^[\d.]+$/, ry: /^[\d.]+$/,
  };
  const stack: string[] = []; let root = false, geometry = false;
  for (let remaining = svg.trim(); remaining;) {
    const tag = /^<(\/?)(svg|g|path|circle|ellipse)(\s[^<>]*?)?(\/?)>/.exec(remaining);
    if (!tag) return false;
    const [, closing, name, raw = "", selfClosing] = tag;
    if (closing) { if (raw.trim() || selfClosing || stack.pop() !== name) return false; }
    else {
      if (name === "svg") { if (root || stack.length || selfClosing) return false; root = true; }
      else { if (!stack.length) return false; if (name !== "g") geometry = true; }
      let attributes = raw.trim(); const seen = new Set<string>();
      while (attributes) {
        const attr = /^([A-Za-z-]+)="([^"]*)"(?:\s+|$)/.exec(attributes);
        if (!attr || seen.has(attr[1]!) || !allowed[attr[1]!] || !allowed[attr[1]!]!.test(attr[2]!)) return false;
        if ((attr[1] === "xmlns" || attr[1] === "viewBox") && name !== "svg") return false;
        seen.add(attr[1]!); attributes = attributes.slice(attr[0].length);
      }
      if (name === "svg" && (!seen.has("xmlns") || !seen.has("viewBox"))) return false;
      if (!selfClosing) stack.push(name!);
    }
    remaining = remaining.slice(tag[0].length).trimStart();
    if (!stack.length && remaining) return false;
  }
  return root && geometry && stack.length === 0;
}
/** Validate the shipped set. Used by the build gate too, which surfaces errors instead of hiding them. */
export function validateDecorationResources(packageRoot: string, stage: "source" | "runtime" = "source"): ThemeDecorations {
  const root = realpathSync(packageRoot);
  const manifests = realpathSync(join(root, "theme-decorations"));
  if (!inside(manifests, root)) throw new Error("Decoration manifests escape the package directory.");
  const manifest = realpathSync(join(manifests, "pi-pane-porcelain.json"));
  if (!inside(manifest, manifests)) throw new Error("Decoration manifest escapes the package directory.");
  const decorations = safeDecorations(JSON.parse(readBounded(manifest, MANIFEST_BYTES)));
  if (!decorations) throw new Error("Invalid theme decoration manifest.");
  // Validate the actual served copy at runtime; source artwork cannot vouch for a changed build.
  const assets = stage === "runtime" && existsSync(join(root, "web-dist")) ? "web-dist" : "public";
  const assetRoot = realpathSync(join(root, assets, "decorations"));
  if (!inside(assetRoot, root)) throw new Error("Decoration assets escape the package directory.");
  let total = 0;
  for (const asset of DECORATION_ASSETS) {
    const path = realpathSync(join(assetRoot, `${asset}.svg`));
    if (!inside(path, assetRoot)) throw new Error("Decoration asset escapes the package directory.");
    const svg = readBounded(path, MAX_DECORATION_BYTES); total += Buffer.byteLength(svg);
    if (total > MAX_DECORATION_BYTES || !validDecorationSvg(svg)) throw new Error("Invalid or oversized theme decoration SVG.");
  }
  return decorations;
}
/** Binding is by real source path. A third-party file with the same name never gets decorations. */
export function loadThemeDecorations(sourcePath: string | undefined, bundledDir = BUNDLED_THEME_DIR): ThemeDecorations | undefined {
  if (!sourcePath) return undefined;
  try {
    const directory = realpathSync(bundledDir), source = realpathSync(sourcePath);
    if (!inside(source, directory) || source !== realpathSync(join(directory, "pi-pane-porcelain.json"))) return undefined;
    return validateDecorationResources(dirname(directory), "runtime");
  } catch { return undefined; } // Optional artwork may never prevent a theme or session from loading.
}
