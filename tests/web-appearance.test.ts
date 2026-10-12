import assert from "node:assert/strict";
import test from "node:test";
import { DARK_THEME, LIGHT_THEME, parseAppearance, safeVars, serializeAppearance, wantedTheme } from "../src/web/appearance.js";

const vars = { "--bg": "#101010", "--fg": "#f0f0f0", "--accent": "#3366ff" };
test("each look asks for one theme, and following pi asks for none", () => {
  assert.equal(wantedTheme({ mode: "pi" }, true), undefined);
  assert.equal(wantedTheme({ mode: "system" }, true), DARK_THEME); assert.equal(wantedTheme({ mode: "system" }, false), LIGHT_THEME);
  // A fixed look does not move with the device.
  assert.equal(wantedTheme({ mode: "light" }, true), LIGHT_THEME); assert.equal(wantedTheme({ mode: "dark" }, false), DARK_THEME);
  assert.equal(wantedTheme({ mode: "theme", theme: "mine" }, false), "mine");
});
test("only named color variables with hex values are ever applied", () => {
  assert.deepEqual(safeVars({ ...vars, "--x": "url(https://example.com/a.png)", "background-image": "#000000", "--Bad": "#000000", "--ok": "red", "--n": 5 }), vars);
  assert.equal(safeVars({ "--accent": "#3366ff" }), undefined, "a theme without a background and text color is not one");
  assert.equal(safeVars(null), undefined); assert.equal(safeVars([vars]), undefined);
  assert.equal(Object.keys(safeVars(Object.fromEntries([["--bg", "#000000"], ["--fg", "#ffffff"], ...Array.from({ length: 400 }, (_, index) => [`--v${index}`, "#111111"])]))!).length, 256);
});
test("a stored choice survives a reload with the colors it needs, and nothing else", () => {
  const cache = { [LIGHT_THEME]: vars, [DARK_THEME]: vars, mine: vars, other: vars };
  const round = (appearance: Parameters<typeof serializeAppearance>[0]) => parseAppearance(serializeAppearance(appearance, cache));
  assert.deepEqual(round({ mode: "theme", theme: "mine" }), { appearance: { mode: "theme", theme: "mine" }, cache: { mine: vars } });
  assert.deepEqual(Object.keys(round({ mode: "system" }).cache), [LIGHT_THEME, DARK_THEME]);
  assert.deepEqual(round({ mode: "dark", hideThinking: true }), { appearance: { mode: "dark", hideThinking: true }, cache: { [DARK_THEME]: vars } });
  assert.deepEqual(round({ mode: "pi", hideThinking: true }), { appearance: { mode: "pi", hideThinking: true }, cache: {} });
  // The name of a theme is not kept for a look that has none.
  assert.deepEqual(round({ mode: "light", theme: "mine" }).appearance, { mode: "light" });
});
test("anything unexpected in storage means following pi", () => {
  const follow = { appearance: { mode: "pi" }, cache: {} };
  for (const text of [null, "", "{", "[]", "\"dark\"", JSON.stringify({ v: 2, mode: "dark" }), JSON.stringify({ mode: "dark" })]) assert.deepEqual(parseAppearance(text), follow);
  assert.deepEqual(parseAppearance(JSON.stringify({ v: 1, mode: "theme" })).appearance, { mode: "pi" });
  assert.deepEqual(parseAppearance(JSON.stringify({ v: 1, mode: "theme", theme: "x".repeat(65) })).appearance, { mode: "pi" });
  assert.deepEqual(parseAppearance(JSON.stringify({ v: 1, mode: "sepia", hideThinking: "yes" })).appearance, { mode: "pi" });
  const hostile = parseAppearance(JSON.stringify({ v: 1, mode: "theme", theme: "mine", cache: { mine: { "--bg": "url(x)", "--fg": "#ffffff" }, good: { ...vars, "--evil": "expression(1)" } } }));
  assert.deepEqual(hostile, { appearance: { mode: "theme", theme: "mine" }, cache: { good: vars } });
});
test("theme decorations default on and disabling them is a separate persisted browser preference", () => {
  assert.notEqual(parseAppearance(null).appearance.showDecorations, false);
  for (const mode of ["pi", "light", "dark", "system"] as const) {
    const appearance = { mode, showDecorations: false, hideThinking: true };
    assert.deepEqual(parseAppearance(serializeAppearance(appearance, {})).appearance, appearance);
  }
  assert.deepEqual(parseAppearance(serializeAppearance({ mode: "theme", theme: "pi-pane-porcelain", showDecorations: false }, {})).appearance,
    { mode: "theme", theme: "pi-pane-porcelain", showDecorations: false });
  for (const value of [true, "false", null, 0, {}]) assert.notEqual(parseAppearance(JSON.stringify({ v: 1, mode: "pi", showDecorations: value })).appearance.showDecorations, false);
  assert.equal(serializeAppearance({ mode: "pi", showDecorations: true }, {}).includes("showDecorations"), false);
});
