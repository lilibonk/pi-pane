import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BUNDLED_THEME_DIR, loadThemeDecorations, MAX_DECORATION_BYTES, validDecorationSvg, validateDecorationResources } from "../src/extension/theme-decorations.js";
import { applyProjectionEvent, safeDecorations, type ProjectionState } from "../src/protocol/index.js";
import { ThemeMapper } from "../src/extension/theme.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "theme-decorations", "pi-pane-porcelain.json"), "utf8"));
function fixture(run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "pi-pane-decoration-"));
  try {
    for (const path of ["themes", "theme-decorations", "public/decorations"]) cpSync(join(root, path), join(dir, path), { recursive: true });
    run(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("shipped geometry and manifest pass the same build and runtime validation", () => {
  assert.deepEqual(validateDecorationResources(root), manifest);
  assert.deepEqual(loadThemeDecorations(join(BUNDLED_THEME_DIR, "pi-pane-porcelain.json")), manifest);
  assert.equal(loadThemeDecorations(join(BUNDLED_THEME_DIR, "pi-pane-light.json")), undefined);
  assert.equal(loadThemeDecorations(join(BUNDLED_THEME_DIR, "pi-pane-dark.json")), undefined);
  assert.equal(new ThemeMapper().decorations({ name: "pi-pane-porcelain", appearance: "light", colors: {} }), undefined, "a name with no verified source does not bind artwork");
  const wire = JSON.stringify(manifest);
  assert.equal(wire.includes(root), false); assert.doesNotMatch(wire, /url\(|https?:|\.svg|\/Users\//);
});

test("all unknown keys, URLs, paths, roles, slots, invalid alpha and CSS strings are refused", () => {
  const good = manifest.slots.brand;
  for (const invalid of [null, [], { ...manifest, path: "/tmp/other" }, { ...manifest, id: "mine" }, { ...manifest, slots: {} },
    { ...manifest, slots: { content: good } }, ...[
      { ...good, asset: "https://example.com/x.svg" }, { ...good, asset: "../x" }, { ...good, colorRole: "--evil" },
      { ...good, opacity: .21 }, { ...good, opacity: NaN }, { ...good, opacity: 0 }, { ...good, opacity: -1 },
      { ...good, tile: "background-image:url(x)" }, { ...good, url: "x" },
    ].map(spec => ({ ...manifest, slots: { brand: spec } }))]) assert.equal(safeDecorations(invalid), undefined);
});

test("copying a bundled theme name or redirecting its source outside the bundle never binds decorations", () => fixture(dir => {
  const themes = join(dir, "themes"), outside = join(dir, "outside.json");
  writeFileSync(outside, readFileSync(join(themes, "pi-pane-porcelain.json")));
  assert.equal(loadThemeDecorations(outside, themes), undefined);
  rmSync(join(themes, "pi-pane-porcelain.json")); symlinkSync(outside, join(themes, "pi-pane-porcelain.json"));
  assert.equal(loadThemeDecorations(join(themes, "pi-pane-porcelain.json"), themes), undefined);
}));

test("missing, invalid, oversized or escaping assets fail closed without losing the theme", () => fixture(dir => {
  const source = join(dir, "themes", "pi-pane-porcelain.json"), assets = join(dir, "public", "decorations");
  const branch = join(assets, "porcelain-branch.svg"), original = readFileSync(branch, "utf8");
  for (const bad of ["<svg><script>alert(1)</script></svg>", " ".repeat(MAX_DECORATION_BYTES + 1), original.replace("<path", '<path onclick="alert(1)"')]) {
    writeFileSync(branch, bad); assert.equal(loadThemeDecorations(source, join(dir, "themes")), undefined);
  }
  rmSync(branch); assert.equal(loadThemeDecorations(source, join(dir, "themes")), undefined);
  const outside = join(dir, "outside.svg"); writeFileSync(outside, original); symlinkSync(outside, branch);
  assert.equal(loadThemeDecorations(source, join(dir, "themes")), undefined);
  rmSync(branch); writeFileSync(branch, original);
  writeFileSync(join(dir, "theme-decorations", "pi-pane-porcelain.json"), "{broken");
  assert.equal(loadThemeDecorations(source, join(dir, "themes")), undefined);
  writeFileSync(join(dir, "theme-decorations", "pi-pane-porcelain.json"), JSON.stringify(manifest));
  assert.deepEqual(loadThemeDecorations(source, join(dir, "themes")), manifest, "a repaired resource recovers on the next load");
  // Published packages contain web-dist, not the Vite source public directory.
  mkdirSync(join(dir, "web-dist")); cpSync(assets, join(dir, "web-dist", "decorations"), { recursive: true });
  const served = join(dir, "web-dist", "decorations", "porcelain-branch.svg");
  writeFileSync(served, "<svg>invalid</svg>");
  assert.equal(loadThemeDecorations(source, join(dir, "themes")), undefined, "valid source artwork cannot vouch for a modified served build");
  writeFileSync(served, original); rmSync(join(dir, "public"), { recursive: true });
  assert.deepEqual(loadThemeDecorations(source, join(dir, "themes")), manifest);
}));

test("a symlinked resource directory outside the package is not a shipped decoration set", () => fixture(dir => {
  const source = join(dir, "themes", "pi-pane-porcelain.json");
  const outside = mkdtempSync(join(tmpdir(), "pi-pane-external-decoration-"));
  try {
    cpSync(join(dir, "theme-decorations"), outside, { recursive: true });
    rmSync(join(dir, "theme-decorations"), { recursive: true }); symlinkSync(outside, join(dir, "theme-decorations"));
    assert.equal(loadThemeDecorations(source, join(dir, "themes")), undefined);
  } finally { rmSync(outside, { recursive: true, force: true }); }
}));

test("SVG validation permits only inert geometry and rejects references, literal colors and XML entities", () => {
  const svg = readFileSync(join(root, "public", "decorations", "porcelain-wave.svg"), "utf8");
  assert.equal(validDecorationSvg(svg), true);
  for (const bad of [svg.replace("currentColor", "#000000"), svg.replace("<path", '<path style="stroke:red"'),
    svg.replace("<path", '<path href="https://example.com/"'), svg.replace("<path", '<image href="x"'),
    svg.replace("<path", "<foreignObject"), `<!DOCTYPE svg>${svg}`, svg.replace("<path", '<path d="&entity;"'), `${svg}${svg}`]) assert.equal(validDecorationSvg(bad), false);
});

test("a theme event without artwork clears the previous snapshot metadata", () => {
  const initial = { session: {}, state: {}, theme: {}, decorations: manifest } as unknown as ProjectionState;
  const plain = applyProjectionEvent(initial, { type: "theme", theme: { "--bg": "#ffffff" } });
  assert.equal(plain.decorations, undefined); assert.deepEqual(plain.theme, { "--bg": "#ffffff" });
  const decorated = applyProjectionEvent(plain, { type: "theme", theme: {}, decorations: manifest });
  assert.deepEqual(decorated.decorations, manifest);
  assert.equal(applyProjectionEvent(decorated, { type: "theme", theme: {}, decorations: { ...manifest, url: "bad" } }).decorations, undefined);
});
