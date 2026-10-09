import assert from "node:assert/strict";
import { test } from "node:test";
import { builtinCommand, resolveSlash } from "../src/web/commands.js";
import type { WorkbenchCommand } from "../src/protocol/workbench.js";

test("pi interactive builtin input cannot reach the model even without a command catalog", () => {
  for (const name of ["new", "resume", "model", "thinking", "fork", "compact", "name", "clone", "settings", "session"]) {
    assert.equal(resolveSlash(`/${name}`, [])?.command?.source, "builtin");
    assert.equal(resolveSlash(`/${name}`, [])?.command?.available, true);
  }
  for (const name of ["tree", "login", "logout", "reload", "quit", "debug", "export", "import", "web", "arminsayshi", "dementedelves"]) {
    const resolved = resolveSlash(`/${name} extra`, []);
    assert.equal(resolved?.command?.available, false);
    assert.ok(resolved?.command?.reason);
  }
  assert.match(builtinCommand("tree")!.reason!, /RPC/);
});

test("builtins retain priority over extensions and Unicode extensions preserve arguments", () => {
  const catalog: WorkbenchCommand[] = [
    { name: "model", source: "extension", description: "collision", available: true },
    { name: "设计", source: "extension", description: "custom", available: true },
  ];
  assert.equal(resolveSlash("/model", catalog)?.command?.source, "builtin");
  const custom = resolveSlash("/设计 第一行\n第二行", catalog);
  assert.equal(custom?.command?.source, "extension");
  assert.equal(custom?.args, "第一行\n第二行");
  assert.equal(resolveSlash("/unknown hello", catalog)?.command, undefined);
  assert.equal(resolveSlash("普通消息", catalog), undefined);
});
