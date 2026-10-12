import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { colorToHex, colorToOklch, indexedColor, mixColors, oklchColor, parseColor } from "@earendil-works/pi-tui";
import { ThemeMapper, exportPageBackground, type PaneTheme } from "../src/extension/theme.js";

const theme = (overrides: Partial<PaneTheme> = {}): PaneTheme => ({
  name: "fixture", appearance: "dark",
  colors: { text: parseColor("#eeeeee"), accent: parseColor("#a6b9ef"), toolPendingBg: indexedColor(17) },
  ...overrides,
});
function withThemeFile(run: (path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "pi-pane-theme-"));
  try { run(join(directory, "theme.json")); } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("export page background resolves nested variables, indexed and OKLCH/OKHSL colors", () => {
  for (const value of ["#abc", 17, "oklch(65% 0.5 270)", "okhsl(140 60% 40%)"]) {
    assert.equal(exportPageBackground({ vars: { outer: "inner", inner: value }, export: { pageBg: "outer" } }), colorToHex(parseColor(value)));
  }
});

test("invalid export values, cycles and inherited variable names have no CSS output", () => {
  for (const value of ["", undefined, null, {}, [], -1, 256, 1.5, "url(https://example.invalid)", "red; color:blue", "toString", "missing", "oklch(NaN 1 1)"]) {
    assert.equal(exportPageBackground({ export: { pageBg: value } }), undefined);
  }
  assert.equal(exportPageBackground({ vars: { a: "b", b: "a" }, export: { pageBg: "a" } }), undefined);
  const vars = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`v${index}`, `v${index + 1}`]));
  assert.equal(exportPageBackground({ vars, export: { pageBg: "v0" } }), undefined);
  assert.equal(exportPageBackground({ vars: JSON.parse('{"__proto__":"#123456"}'), export: { pageBg: "__proto__" } }), "#123456");
});

test("mapper converts all pi tokens and derives surfaces in OKLCH with appearance changes", () => {
  const mapper = new ThemeMapper();
  const dark = mapper.map(theme());
  const light = mapper.map(theme({ appearance: "light", colors: { text: parseColor("#252525"), accent: parseColor("#445b9f") } }));
  assert.equal(dark["--pi-tool-pending-bg"], colorToHex(indexedColor(17)));
  assert.equal(dark["--bg"], "#111315");
  assert.equal(light["--bg"], "#f5f5f4");
  assert.equal(dark["--hover-bg"], colorToHex(mixColors(parseColor(dark["--bg"]!), parseColor(dark["--accent"]!), .13, "oklch")));
  for (const mapped of [dark, light]) for (const color of Object.values(mapped)) assert.match(color, /^#[\da-f]{6}$/);
  assert.ok(colorToOklch(parseColor(dark["--surface"]!)).l > colorToOklch(parseColor(dark["--bg"]!)).l);
  assert.ok(colorToOklch(parseColor(light["--surface"]!)).l < colorToOklch(parseColor(light["--bg"]!)).l);
  assert.notEqual(dark["--shadow-color"], light["--shadow-color"]);
  assert.equal(mapper.map(theme({ colors: { accent: oklchColor(.7, .9, 80) } }))["--accent"], colorToHex(oklchColor(.7, .9, 80)));
});

test("sourcePath takes priority and export-only atomic replacement updates the same theme", () => withThemeFile((path) => {
  writeFileSync(path, '\uFEFF{"vars":{"page":"#112233"},"export":{"pageBg":"page"}}');
  const mapper = new ThemeMapper();
  const current = theme({ sourcePath: path });
  const unavailable = () => { throw new Error("must not list when sourcePath exists"); };
  assert.equal(mapper.map(current, unavailable)["--bg"], "#112233");
  writeFileSync(`${path}.tmp`, '{"export":{"pageBg":"#332211"}}');
  renameSync(`${path}.tmp`, path);
  assert.equal(mapper.map(current, unavailable)["--bg"], "#332211");
  assert.equal(mapper.map(current, unavailable)["--bg"], "#332211");
  delete (current as { sourcePath?: string }).sourcePath;
  assert.equal(mapper.map(current, () => [])["--bg"], "#111315");
}));

test("public theme paths support built-ins and are only queried when the active theme changes", () => withThemeFile((path) => {
  writeFileSync(path, '{"export":{"pageBg":"#123456"}}');
  let calls = 0;
  const available = () => { calls++; return [{ name: "fixture", path }]; };
  const mapper = new ThemeMapper();
  const first = theme();
  assert.equal(mapper.map(first, available)["--bg"], "#123456");
  assert.equal(mapper.map(first, available)["--bg"], "#123456");
  assert.equal(calls, 1);
  assert.equal(mapper.map(theme({ name: "system" }), available)["--bg"], "#111315");
  assert.equal(calls, 2);
}));

test("deleted, malformed, oversized and non-file theme sources fall back and recover", () => withThemeFile((path) => {
  const mapper = new ThemeMapper();
  const current = theme({ sourcePath: path });
  writeFileSync(path, '{"export":{"pageBg":"#123456"}}');
  assert.equal(mapper.map(current)["--bg"], "#123456");
  rmSync(path);
  assert.equal(mapper.map(current)["--bg"], "#111315");
  for (const content of ["{invalid", " ".repeat(256 * 1024 + 1), '{"export":{"pageBg":[]}}']) {
    writeFileSync(path, content);
    assert.equal(mapper.map(current)["--bg"], "#111315");
  }
  writeFileSync(path, '{"export":{"pageBg":"#654321"}}');
  assert.equal(mapper.map(current)["--bg"], "#654321");
  assert.equal(mapper.map(theme({ sourcePath: tmpdir() }))["--bg"], "#111315");
}));

test("bundled themes declare complete independent palettes and package resources", () => {
  const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(metadata.pi.themes.includes("./themes/*.json"));
  assert.ok(metadata.files.includes("themes"));
  const baseline = JSON.parse(readFileSync(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json", import.meta.url), "utf8"));
  for (const appearance of ["dark", "light", "porcelain"]) {
    const json = JSON.parse(readFileSync(new URL(`../themes/pi-pane-${appearance}.json`, import.meta.url), "utf8"));
    assert.equal(json.name, `pi-pane-${appearance}`);
    assert.equal(json.appearance, appearance === "dark" ? "dark" : "light");
    for (const key of Object.keys(baseline.colors)) {
      assert.ok(Object.hasOwn(json.colors, key), `${appearance}: ${key}`);
      assert.match(exportPageBackground({ ...json, export: { pageBg: json.colors[key] } })!, /^#[\da-f]{6}$/);
    }
    assert.match(exportPageBackground(json)!, /^#[\da-f]{6}$/);
  }
});
test("bundled reading and feedback roles maintain normal-text contrast on the page and derived surfaces", () => {
  const luminance = (hex: string): number => {
    const channels = hex.slice(1).match(/../g)!.map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return channels[0]! * .2126 + channels[1]! * .7152 + channels[2]! * .0722;
  };
  for (const name of ["light", "dark", "porcelain"]) {
    const json = JSON.parse(readFileSync(new URL(`../themes/pi-pane-${name}.json`, import.meta.url), "utf8"));
    const colors = Object.fromEntries(Object.entries(json.colors as Record<string, string>).map(([role, variable]) => [role, parseColor(json.vars[variable])]));
    const vars = new ThemeMapper().vars({ appearance: json.appearance, colors }, exportPageBackground(json));
    for (const role of ["--fg", "--fg-muted", "--fg-dim", "--accent", "--err", "--ok", "--warn"]) {
      for (const background of ["--bg", "--surface", "--sidebar-bg"]) {
        const [first, second] = [luminance(vars[role]!), luminance(vars[background]!)].sort((a, b) => b - a);
        assert.ok((first! + .05) / (second! + .05) >= 4.5, `${name}: ${role} against ${background}`);
      }
    }
  }
});
