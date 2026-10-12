import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ThemeDecorations } from "../src/protocol/index.js";
import { clearAppearance, closeSettings, commitAppearance, previewAppearance, setHideThinking, webStore } from "../src/web/store.js";

const decorations = JSON.parse(readFileSync(new URL("../theme-decorations/pi-pane-porcelain.json", import.meta.url), "utf8")) as ThemeDecorations;
test("decoration preference previews, commits and cancels with the selected theme", () => {
  webStore.setState({ connection: "connecting", clientId: null, appearance: { mode: "pi", showDecorations: false }, appearancePreview: null });
  previewAppearance({ mode: "pi", showDecorations: true });
  assert.notEqual(webStore.getState().appearancePreview?.showDecorations, false, "an old saved false must not overwrite a new true");
  assert.equal(webStore.getState().appearance.showDecorations, false, "a preview has not committed");
  closeSettings();
  assert.equal(webStore.getState().appearancePreview, null); assert.equal(webStore.getState().appearance.showDecorations, false);
  previewAppearance({ mode: "theme", theme: "pi-pane-porcelain", showDecorations: true });
  previewAppearance({ mode: "light" });
  assert.notEqual(webStore.getState().appearancePreview?.showDecorations, false, "changing the theme preserves the active preview preference");
  commitAppearance();
  assert.deepEqual(webStore.getState().appearance, { mode: "light" });
  previewAppearance({ mode: "dark", showDecorations: false }); commitAppearance();
  assert.deepEqual(webStore.getState().appearance, { mode: "dark", showDecorations: false });
  previewAppearance({ mode: "theme", theme: "pi-pane-porcelain" });
  assert.equal(webStore.getState().appearancePreview?.showDecorations, false);
  setHideThinking(true); commitAppearance();
  assert.equal(webStore.getState().appearance.hideThinking, true, "committing a preview does not roll back a thinking preference saved meanwhile");
  clearAppearance();
  assert.deepEqual(webStore.getState().appearance, { mode: "pi", hideThinking: true }, "clear restores default artwork and retains the independent reading preference");
});

test("switching and cancelling a named theme clear artwork even before a host can reply", () => {
  webStore.setState({ connection: "connecting", clientId: null, appearance: { mode: "pi" }, appearancePreview: null,
    themeName: "pi-pane-porcelain", themeDecorations: decorations });
  previewAppearance({ mode: "theme", theme: "third-party" });
  assert.equal(webStore.getState().themeName, "third-party"); assert.equal(webStore.getState().themeDecorations, null);
  webStore.setState({ themeDecorations: decorations });
  closeSettings();
  assert.equal(webStore.getState().themeName, ""); assert.equal(webStore.getState().themeDecorations, null);
});
