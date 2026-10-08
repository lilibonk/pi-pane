import type { HighlighterCore } from "shiki/core";
import { sanitizeHighlight } from "./markdown.js";

/** Each grammar is a separate chunk, loaded only when a block in that language is shown. */
const LANGS: Record<string, () => Promise<{ default: unknown }>> = {
  typescript: () => import("@shikijs/langs/typescript"),
  tsx: () => import("@shikijs/langs/tsx"),
  javascript: () => import("@shikijs/langs/javascript"),
  jsx: () => import("@shikijs/langs/jsx"),
  json: () => import("@shikijs/langs/json"),
  bash: () => import("@shikijs/langs/bash"),
  python: () => import("@shikijs/langs/python"),
  go: () => import("@shikijs/langs/go"),
  rust: () => import("@shikijs/langs/rust"),
  java: () => import("@shikijs/langs/java"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  css: () => import("@shikijs/langs/css"),
  html: () => import("@shikijs/langs/html"),
  markdown: () => import("@shikijs/langs/markdown"),
  yaml: () => import("@shikijs/langs/yaml"),
  toml: () => import("@shikijs/langs/toml"),
  sql: () => import("@shikijs/langs/sql"),
  diff: () => import("@shikijs/langs/diff"),
  ruby: () => import("@shikijs/langs/ruby"),
  php: () => import("@shikijs/langs/php"),
  swift: () => import("@shikijs/langs/swift"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  dockerfile: () => import("@shikijs/langs/dockerfile"),
};
const ALIASES: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", js: "javascript", mjs: "javascript", cjs: "javascript",
  sh: "bash", shell: "bash", zsh: "bash", console: "bash", py: "python", rs: "rust", "c++": "cpp", cc: "cpp", h: "c", hpp: "cpp",
  cs: "csharp", htm: "html", md: "markdown", yml: "yaml", rb: "ruby", kt: "kotlin", kts: "kotlin", patch: "diff",
};
const EXTENSIONS: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx", js: "javascript", mjs: "javascript", cjs: "javascript",
  jsx: "jsx", json: "json", sh: "bash", bash: "bash", zsh: "bash", py: "python", go: "go", rs: "rust", java: "java",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp", css: "css", html: "html", htm: "html", md: "markdown",
  yml: "yaml", yaml: "yaml", toml: "toml", sql: "sql", diff: "diff", patch: "diff", rb: "ruby", php: "php",
  swift: "swift", kt: "kotlin", kts: "kotlin",
};
/** Larger inputs stay plain: highlighting is a convenience, not worth stalling the page. */
const MAX_CHARS = 200_000;

export function languageOf(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const key = name.trim().toLowerCase();
  const lang = ALIASES[key] ?? key;
  return lang in LANGS ? lang : undefined;
}
export function languageForPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const base = path.split("/").pop() ?? "";
  if (/^dockerfile$/i.test(base)) return "dockerfile";
  const extension = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
  return EXTENSIONS[extension];
}

let highlighter: Promise<HighlighterCore> | undefined;
function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore, createCssVariablesTheme }, { createJavaScriptRegexEngine }] =
      await Promise.all([import("shiki/core"), import("shiki/engine/javascript")]);
    // Colors come from CSS variables mapped to the user's pi syntax tokens.
    const theme = createCssVariablesTheme({ name: "pi", variablePrefix: "--shiki-", fontStyle: true });
    return createHighlighterCore({ themes: [theme], langs: [], engine: createJavaScriptRegexEngine() });
  })();
  return highlighter;
}

const results = new Map<string, string | null>();
/** Highlighted, sanitized HTML, or null when the language is unknown or the input is too large. */
export async function highlight(code: string, lang: string | undefined): Promise<string | null> {
  const name = languageOf(lang);
  if (!name || code.length > MAX_CHARS) return null;
  const key = `${name}\u0000${code}`;
  if (results.has(key)) return results.get(key)!;
  try {
    const instance = await getHighlighter();
    if (!instance.getLoadedLanguages().includes(name)) await instance.loadLanguage((await LANGS[name]!()).default as never);
    const html = sanitizeHighlight(instance.codeToHtml(code, { lang: name, theme: "pi" }));
    if (results.size > 128) results.delete(results.keys().next().value!);
    results.set(key, html);
    return html;
  } catch {
    results.set(key, null);
    return null;
  }
}
