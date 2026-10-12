import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { REQUIRED_TOKENS, ThemeCatalog, parseThemeText, themeNames } from "../src/extension/theme-catalog.js";
import type { PaneTheme } from "../src/extension/theme.js";

const bundledDir = resolve(dirname(fileURLToPath(import.meta.url)), "../themes");
const piThemes = join(getPackageDir(), "dist/modes/interactive/theme");
const OPTIONAL = ["scrollbarTrack", "scrollbarThumb", "thinkingMax", "searchMatchBg", "searchMatchText"];
const handoffTheme = { name: "system", appearance: "dark", colors: {} } as unknown as PaneTheme;

async function fixture(run: (context: { root: string; agentDir: string; start: string; other: string; base: Record<string, any>; write: (path: string, value: unknown) => Promise<string>;
  catalog: (handoff?: { name: string; path: string | undefined }[], theme?: PaneTheme) => ThemeCatalog }) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-pane-themes-")));
  const agentDir = join(root, "agent"), start = join(root, "start"), other = join(root, "other");
  await Promise.all([mkdir(join(agentDir, "themes"), { recursive: true }), mkdir(join(start, ".pi", "themes"), { recursive: true }), mkdir(join(other, ".pi", "themes"), { recursive: true })]);
  const base = JSON.parse(await readFile(join(piThemes, "dark.json"), "utf8"));
  const write = async (path: string, value: unknown) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, typeof value === "string" ? value : JSON.stringify(value)); return path; };
  const builtin = [{ name: "system", path: undefined }, { name: "dark", path: join(piThemes, "dark.json") }, { name: "light", path: join(piThemes, "light.json") }];
  const catalog = (handoff: { name: string; path: string | undefined }[] = [], theme = handoffTheme) =>
    new ThemeCatalog({ agentDir, bundledDir, handoff: [...builtin, ...handoff], handoffTheme: theme, startCwd: start });
  try { await run({ root, agentDir, start, other, base, write, catalog }); } finally { await rm(root, { recursive: true, force: true }); }
}

test("the required token list matches what pi's built-in themes define", async () => {
  for (const name of ["dark", "light"]) {
    const json = JSON.parse(await readFile(join(piThemes, `${name}.json`), "utf8"));
    const keys = Object.keys(json.colors);
    assert.deepEqual(REQUIRED_TOKENS.filter(token => !keys.includes(token)), [], `${name}: a required token is missing from pi's theme`);
    assert.deepEqual(keys.filter(key => !REQUIRED_TOKENS.includes(key) && !OPTIONAL.includes(key)), [], `${name}: pi defines a token this list does not know`);
    const parsed = parseThemeText(JSON.stringify(json), `/themes/${name}.json`);
    assert.equal(parsed.name, name); assert.equal(parsed.theme.appearance, name);
    assert.equal(Object.keys(parsed.theme.colors).length, REQUIRED_TOKENS.length + OPTIONAL.length);
  }
});
test("this package's themes are complete pi themes", async () => {
  for (const name of ["pi-pane-light", "pi-pane-dark", "pi-pane-porcelain"]) {
    const parsed = parseThemeText(await readFile(join(bundledDir, `${name}.json`), "utf8"), join(bundledDir, `${name}.json`));
    assert.equal(parsed.name, name); assert.equal(parsed.theme.appearance, name.endsWith("dark") ? "dark" : "light");
  }
});
test("a user theme that shadows porcelain keeps its colors without acquiring the bundled artwork", () => fixture(async ({ agentDir, start, base, write, catalog }) => {
  const themes = catalog();
  assert.equal((await themes.load(start, false)).entries.get("pi-pane-porcelain")?.decorations?.id, "pi-pane-porcelain");
  await write(join(agentDir, "themes", "porcelain.json"), { ...base, name: "pi-pane-porcelain" });
  const entry = (await themes.load(start, false)).entries.get("pi-pane-porcelain")!;
  assert.equal(entry.source, "user"); assert.equal(entry.decorations, undefined);
}));
test("themes come from the trusted project, the user directory, the handoff list, pi and this package, in that order", () => fixture(async ({ agentDir, start, root, base, write, catalog }) => {
  await write(join(agentDir, "themes", "mine.json"), { ...base, name: "mine" });
  await write(join(agentDir, "themes", "shared.json"), { ...base, name: "shared", appearance: "light" });
  await write(join(start, ".pi", "themes", "shared.json"), { ...base, name: "shared", appearance: "dark" });
  await write(join(start, ".pi", "themes", "local.json"), { ...base, name: "local" });
  const packaged = await write(join(agentDir, "npm", "node_modules", "pack", "themes", "packed.json"), { ...base, name: "packed" });
  const elsewhere = await write(join(root, "elsewhere", "cli.json"), { ...base, name: "cli" });
  const themes = catalog([{ name: "packed", path: packaged }, { name: "cli", path: elsewhere }, { name: "mine", path: join(agentDir, "themes", "mine.json") }, { name: "pi-pane-dark", path: join(bundledDir, "pi-pane-dark.json") }]);
  const trusted = await themes.load(start, true);
  const bySource = Object.fromEntries(themes.items(trusted).map(item => [item.name, item.source]));
  assert.deepEqual(bySource, { "pi-pane-dark": "pi-pane", "pi-pane-light": "pi-pane", "pi-pane-porcelain": "pi-pane", dark: "builtin", light: "builtin", mine: "user", shared: "project", local: "project", packed: "handoff", cli: "handoff" });
  assert.equal(trusted.entries.get("shared")!.theme.appearance, "dark", "the project's theme wins over the user's of the same name");
  assert.deepEqual(trusted.problems.map(problem => [problem.code, problem.file, problem.source]), [["duplicate", "shared.json", "user"]]);
  assert.equal(trusted.projectThemes, "loaded");
  // pi can find these from any project; a project's own theme, a path given on the command line and a
  // package theme pi did not list (this package run from source) cannot be its default.
  assert.deepEqual(themes.items(trusted).filter(item => item.global).map(item => item.name).sort(), ["dark", "light", "mine", "packed", "pi-pane-dark"]);

  const untrusted = await themes.load(start, false);
  assert.equal(untrusted.projectThemes, "untrusted"); assert.equal(untrusted.entries.has("local"), false);
  assert.equal(untrusted.entries.get("shared")!.source, "user"); assert.deepEqual(untrusted.problems, []);
}));
test("another project sees only what belongs to pi itself, never the start project's themes", () => fixture(async ({ agentDir, start, other, root, base, write, catalog }) => {
  const project = await write(join(start, ".pi", "themes", "local.json"), { ...base, name: "local" });
  const packaged = await write(join(agentDir, "git", "example.com", "pack", "packed.json"), { ...base, name: "packed" });
  const elsewhere = await write(join(root, "elsewhere", "cli.json"), { ...base, name: "cli" });
  await write(join(other, ".pi", "themes", "theirs.json"), { ...base, name: "theirs" });
  const themes = catalog([{ name: "local", path: project }, { name: "packed", path: packaged }, { name: "cli", path: elsewhere }]);
  const names = async (cwd: string, trusted: boolean) => themes.items(await themes.load(cwd, trusted)).map(item => item.name).sort();
  assert.deepEqual(await names(start, false), ["cli", "dark", "light", "local", "packed", "pi-pane-dark", "pi-pane-light", "pi-pane-porcelain"], "what pi itself had loaded at handoff");
  assert.deepEqual(await names(other, false), ["dark", "light", "packed", "pi-pane-dark", "pi-pane-light", "pi-pane-porcelain"]);
  assert.deepEqual(await names(other, true), ["dark", "light", "packed", "pi-pane-dark", "pi-pane-light", "pi-pane-porcelain", "theirs"]);
  assert.equal((await themes.load(other, false)).projectThemes, "untrusted");
}));
test("a broken, oversized, misnamed or hostile theme file is reported and nothing of it is used", () => fixture(async ({ agentDir, start, base, write, catalog }) => {
  const dir = join(agentDir, "themes");
  await write(join(dir, "good.json"), { ...base, name: "good", unknownField: { url: "https://example.com/x.css" }, colors: { ...base.colors, notAToken: "#123456" } });
  await write(join(dir, "broken.json"), "{ nope");
  await write(join(dir, "huge.json"), JSON.stringify({ ...base, name: "huge", padding: "x".repeat(300 * 1024) }));
  const { accent: _accent, ...withoutAccent } = base.colors;
  await write(join(dir, "missing.json"), { ...base, name: "missing", colors: withoutAccent });
  await write(join(dir, "circular.json"), { ...base, name: "circular", vars: { a: "b", b: "a" }, colors: { ...base.colors, accent: "a" } });
  await write(join(dir, "undefined-var.json"), { ...base, name: "undefined-var", colors: { ...base.colors, accent: "url(https://example.com/a.png)" } });
  await write(join(dir, "bad-color.json"), { ...base, name: "bad-color", colors: { ...base.colors, accent: "#12" } });
  await write(join(dir, "bad-index.json"), { ...base, name: "bad-index", colors: { ...base.colors, accent: 999 } });
  await write(join(dir, "system.json"), { ...base, name: "system" });
  await write(join(dir, "slash.json"), { ...base, name: "a/b" });
  await write(join(dir, "array.json"), [1, 2, 3]);
  await mkdir(join(dir, "folder.json")); await write(join(dir, "notes.txt"), "not a theme");
  await symlink(join(dir, "gone-target.json"), join(dir, "gone.json"));
  let fifo = false;
  // A FIFO is never opened by name, and one reached through a link is refused without waiting for a writer.
  try { execFileSync("mkfifo", [join(dir, "pipe.json")]); await symlink(join(dir, "pipe.json"), join(dir, "pipe-link.json")); fifo = true; } catch { /* no mkfifo here */ }
  const themes = catalog(), loaded = await themes.load(start, false);
  const expected: Record<string, string> = { "array.json": "invalid_theme", "bad-color.json": "invalid_theme", "bad-index.json": "invalid_theme", "broken.json": "invalid_json", "circular.json": "invalid_theme",
    "gone.json": "unreadable", "huge.json": "too_large", "missing.json": "invalid_theme", "slash.json": "invalid_theme", "system.json": "reserved_name", "undefined-var.json": "invalid_theme" };
  if (fifo) expected["pipe-link.json"] = "unreadable";
  assert.deepEqual(Object.fromEntries(loaded.problems.map(problem => [problem.file, problem.code])), expected);
  assert.match(loaded.problems.find(problem => problem.file === "missing.json")!.message, /accent/);
  assert.deepEqual(themes.items(loaded).map(item => item.name).sort(), ["dark", "good", "light", "pi-pane-dark", "pi-pane-light", "pi-pane-porcelain"]);
  // Only colors leave the host: every value is a hex color and no unknown field or path travels with it.
  const good = loaded.entries.get("good")!;
  for (const [key, value] of Object.entries(good.vars)) { assert.match(key, /^--[a-z][a-z0-9-]*$/); assert.match(value, /^#[0-9a-f]{6}$/i); }
  assert.equal(JSON.stringify(themes.items(loaded)).includes(agentDir), false); assert.equal(JSON.stringify(loaded.problems).includes(agentDir), false);
  assert.equal(JSON.stringify(good.vars).includes("123456"), false, "a token pi does not define is not exported");
}));
test("with --no-themes only pi's own, this package's and explicitly loaded themes are listed", () => fixture(async ({ agentDir, start, root, base, write }) => {
  await write(join(agentDir, "themes", "mine.json"), { ...base, name: "mine" }); await write(join(start, ".pi", "themes", "local.json"), { ...base, name: "local" });
  const explicit = await write(join(root, "elsewhere", "cli.json"), { ...base, name: "cli" });
  const themes = new ThemeCatalog({ agentDir, bundledDir, handoff: [{ name: "dark", path: join(piThemes, "dark.json") }, { name: "cli", path: explicit }], handoffTheme, startCwd: start, discover: false });
  const loaded = await themes.load(start, true);
  assert.deepEqual(themes.items(loaded).map(item => item.name).sort(), ["cli", "dark", "pi-pane-dark", "pi-pane-light", "pi-pane-porcelain"]); assert.equal(loaded.projectThemes, "none");
}));
test("the list is bounded", () => fixture(async ({ agentDir, start, base, write, catalog }) => {
  await Promise.all(Array.from({ length: 140 }, (_, index) => write(join(agentDir, "themes", `t${String(index).padStart(3, "0")}.json`), { ...base, name: `t${index}` })));
  const loaded = await catalog().load(start, false);
  assert.equal(loaded.truncated, true); assert.equal(loaded.entries.size, 128);
}));
test("follow pi resolves the setting, and falls back to the handoff theme with the reason", () => fixture(async ({ agentDir, start, base, write, catalog }) => {
  await write(join(agentDir, "themes", "mine.json"), { ...base, name: "mine" });
  const dark = catalog(), loaded = await dark.load(start, false);
  assert.deepEqual(dark.resolvePi(loaded, undefined, "default").view, { source: "default", name: "system", appearance: "dark", origin: "handoff", reason: "system" });
  assert.deepEqual(dark.resolvePi(loaded, "mine", "global").view, { setting: "mine", source: "global", name: "mine", appearance: "dark", origin: "catalog" });
  assert.equal(dark.resolvePi(loaded, "mine", "global").theme, loaded.entries.get("mine")!.theme);
  assert.deepEqual(dark.resolvePi(loaded, "light/mine", "project").view, { setting: "light/mine", source: "project", name: "mine", appearance: "dark", origin: "catalog" });
  assert.deepEqual(dark.resolvePi(loaded, "gone", "cli").view, { setting: "gone", source: "cli", name: "system", appearance: "dark", origin: "handoff", reason: "missing" });
  assert.equal(dark.resolvePi(loaded, "gone", "cli").theme, handoffTheme);
  assert.equal(dark.resolvePi(loaded, "a/b/c", "global").view.reason, "invalid");
  assert.equal(dark.resolvePi(loaded, "system", "global").view.reason, "system");
  // The pair is chosen by the terminal's appearance when /web was run, the only one the host knows.
  const light = catalog([], { name: "light", appearance: "light", colors: {} } as unknown as PaneTheme);
  assert.equal(light.resolvePi(await light.load(start, false), "light/mine", "global").view.name, "light");
  assert.deepEqual(themeNames("a / b"), ["a", "b"]); assert.equal(themeNames("a//b"), undefined); assert.equal(themeNames(""), undefined);
}));
test("a theme edited on disk is read again on the next fresh load", () => fixture(async ({ agentDir, start, base, write, catalog }) => {
  const path = await write(join(agentDir, "themes", "mine.json"), { ...base, name: "mine", colors: { ...base.colors, accent: "#112233" } });
  const themes = catalog();
  assert.equal((await themes.load(start, false)).entries.get("mine")!.vars["--accent"], "#112233");
  await write(path, { ...base, name: "mine", colors: { ...base.colors, accent: "#445566" } });
  assert.equal((await themes.load(start, false, false)).entries.get("mine")!.vars["--accent"], "#112233", "a list read moments ago is reused for single-theme reads");
  assert.equal((await themes.load(start, false)).entries.get("mine")!.vars["--accent"], "#445566");
  await write(path, "{");
  const broken = await themes.load(start, false);
  assert.equal(broken.entries.has("mine"), false); assert.equal(broken.problems[0]!.code, "invalid_json");
}));
