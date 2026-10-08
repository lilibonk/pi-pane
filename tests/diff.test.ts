import assert from "node:assert/strict";
import test from "node:test";
import { DIFF_LIMITS, parseDiff, type DiffLine } from "../src/web/diff.ts";

const changed = (line: DiffLine) => line.parts.filter(part => part.changed).map(part => part.text).join("");
function parse(patch: string, fragment = false): DiffLine[] {
  const lines = parseDiff(patch, fragment);
  assert.deepEqual(lines.map(line => line.parts.map(part => part.text).join("")), patch.replace(/\n$/, "").split("\n"), "all source characters survive word matching");
  return lines;
}

test("word diff highlights changed numbers and names while preserving common code", () => {
  const lines = parse("@@ -1,2 +1,2 @@\n-  return cents / 10;\n-const oldValue = 1;\n+  return cents / 100;\n+const newValue = 1;\n");
  assert.deepEqual(lines.map(changed), ["", "10", "oldValue", "100", "newValue"]);
  assert.equal(lines[1]!.parts[0]!.text, "-  return cents / ");
});

test("file headers stay metadata but triple signs inside hunks remain changed code", () => {
  const lines = parse("--- a/one\n+++ b/one\n@@ -1 +1 @@\n--- old\n+++ new\n--- a/two\n+++ b/two\n@@ -0,0 +1 @@\n+++ added\n");
  assert.deepEqual(lines.map(line => line.kind), ["meta", "meta", "hunk", "del", "add", "meta", "meta", "hunk", "add"]);
  assert.match(changed(lines[3]!), /old/);
  assert.match(changed(lines[4]!), /new/);
  const preview = parse("--- old\n+++ new", true);
  assert.deepEqual(preview.map(line => line.kind), ["del", "add"]);
});

test("Unicode words, Chinese changes and emoji keep their original characters", () => {
  const lines = parse("-你好，世界 👩🏽‍💻 café\n+你好，朋友 👨🏽‍💻 café", true);
  assert.equal(changed(lines[0]!), "世界👩🏽‍💻");
  assert.equal(changed(lines[1]!), "朋友👨🏽‍💻");
  assert.ok(lines.every(line => line.parts.some(part => !part.changed && part.text.includes("café"))));
});

test("whitespace edits are visible and CRLF remains literal", () => {
  const lines = parse("-\treturn  value;\r\n+  return value;\r\n", true);
  assert.equal(changed(lines[0]!), "\t  ");
  assert.equal(changed(lines[1]!), "   ");
  assert.ok(lines.every(line => line.parts.at(-1)!.text.endsWith(";\r")));
});

test("a line split compares the whole replacement group without marking shared words", () => {
  const lines = parse("@@ -1 +1,2 @@\n-return first + second;\n+return first\n+  + second;\n");
  assert.ok(lines.slice(1).every(line => !/return|first|second/.test(changed(line))));
  assert.equal(lines[2]!.parts.map(part => part.text).join(""), "+return first");
});

test("pure additions, removals, empty input and independent hunks keep line styling", () => {
  assert.deepEqual(parse("").map(changed), [""]);
  assert.deepEqual(parse("+added\n+", true).map(changed), ["", ""]);
  assert.deepEqual(parse("-deleted\n-", true).map(changed), ["", ""]);
  const lines = parse("@@ -1 +1 @@\n-old alpha\n+new alpha\n@@ -10 +10 @@\n-new beta\n+old beta\n");
  assert.deepEqual(lines.map(changed), ["", "old", "new", "", "new", "old"]);
});

test("no-newline markers do not prevent paired word comparison", () => {
  const lines = parse("@@ -1 +1 @@\n-old value\n\\ No newline at end of file\n+new value\n\\ No newline at end of file\n");
  assert.deepEqual(lines.map(changed), ["", "old", "", "new", ""]);
  assert.equal(lines[2]!.kind, "meta");
});

test("HTML and script payloads remain literal data in diff parts", () => {
  const payload = '<img src=x onerror="window.__xss=1"><script>alert(1)</script>';
  const lines = parse(`-${payload}\n+${payload.replace("src=x", "src=y")}`, true);
  assert.equal(changed(lines[0]!), "x");
  assert.equal(changed(lines[1]!), "y");
  assert.ok(lines[0]!.parts.some(part => part.text.includes("<script>")));
});

test("large text, token counts and matrix work fall back to line-only diff", () => {
  const large = "x".repeat(DIFF_LIMITS.characters);
  assert.ok(parse(`-${large}\n+${large}y`, true).every(line => !changed(line)));
  const many = "x ".repeat(DIFF_LIMITS.tokensPerSide);
  assert.ok(parse(`-${many}\n+${many}y`, true).every(line => !changed(line)));
  const dense = "x ".repeat(300);
  assert.ok(parse(`-${dense}\n+${dense}y`, true).every(line => !changed(line)));
});

test("word matching shares a cumulative budget across many small hunks", () => {
  const text = "x ".repeat(60);
  const patch = Array.from({ length: 30 }, (_, i) => `@@ -${i + 1} +${i + 1} @@\n-${text}old\n+${text}new`).join("\n");
  const lines = parse(patch);
  assert.equal(changed(lines[1]!), "old");
  assert.equal(changed(lines.at(-1)!), "", "later groups use line coloring after the shared budget is spent");
});
