import assert from "node:assert/strict";
import { test } from "node:test";
import { EditorChangeGuard } from "../src/web/ui-state.js";

test("status changes and reconnect snapshots do not overwrite an edited draft again", () => {
  const guard = new EditorChangeGuard();
  const ui = { editorRevision: 1, editorText: "extension draft" };
  assert.equal(guard.read("session-epoch", ui), "extension draft");
  assert.equal(guard.read("session-epoch", { ...ui }), undefined);
  assert.equal(guard.read("session-epoch", { ...ui, editorRevision: 0 }), undefined);
  assert.equal(guard.read("session-epoch", { ...ui, editorRevision: 2 }), "extension draft");
  assert.equal(guard.read("other-session-epoch", { editorRevision: 0, editorText: "" }), "");
  assert.equal(guard.read("other-session-epoch", { editorText: "unversioned" }), undefined);
});

test("extension TUI colors and OSC links display as plain text without changing values", async () => {
  const { extensionText } = await import("../src/web/ui-state.js");
  assert.equal(extensionText("\u001b[32mready\u001b[0m"), "ready");
  assert.equal(extensionText("\u001b]8;;https://example.test\u0007label\u001b]8;;\u0007"), "label");
});
