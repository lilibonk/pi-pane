import assert from "node:assert/strict";
import test from "node:test";
import { commandArgs, parseClientMessage } from "../src/protocol/index.js";

test("workbench query and mutation schemas reject unknown fields, paths and commands", () => {
  const query = { t: "workbench_query", reqId: "read-1", epoch: "epoch", sessionId: "session", branchRevision: 0, action: "sessions", args: { scope: "workspace", query: "test" } };
  assert.deepEqual(parseClientMessage(query), query);
  assert.throws(() => parseClientMessage({ ...query, args: { directory: "/anywhere" } }), /search query/);
  assert.throws(() => parseClientMessage({ ...query, action: "file", args: { path: "x", extra: true } }), /file path/);
  assert.throws(() => parseClientMessage({ ...query, branchRevision: -1 }), /envelope/);
  assert.throws(() => commandArgs("session_switch", { sessionId: "ok", path: "/arbitrary.jsonl" }), /session ID/);
  assert.throws(() => commandArgs("run_command", { name: "foo bar" }), /registered command/);
  assert.deepEqual(commandArgs("run_command", { name: "说明" }), { name: "说明" });
  assert.throws(() => commandArgs("session_fork", { entryId: "entry", position: "at" }), /fork before/);
  assert.deepEqual(commandArgs("session_fork", { entryId: "entry" }), { entryId: "entry" });
});

test("handoff keeps one read protocol and rejects removed mirror/private commands", () => {
  assert.throws(() => parseClientMessage({ t: "host_read", reqId: "read", action: "sessions" }), /envelope/);
  for (const command of ["host_new", "host_switch", "session_tree"]) assert.throws(() => commandArgs(command, {}), /Unknown command/);
  assert.deepEqual(commandArgs("session_clone", {}), {});
  assert.deepEqual(commandArgs("session_rename", { name: "A real name" }), { name: "A real name" });
  for (const name of ["", "  ", "bad\nname", "x".repeat(257)]) assert.throws(() => commandArgs("session_rename", { name }), /session name/);
});
test("extension UI responses bound UTF-8 editor text and refuse injected fields", () => {
  const value = { t: "ui_response", id: "dialog", value: "你好" };
  assert.deepEqual(parseClientMessage(value), value);
  assert.throws(() => parseClientMessage({ ...value, value: "你".repeat(22000) }), /envelope/);
  assert.throws(() => parseClientMessage({ ...value, method: "exec" }), /envelope/);
  assert.deepEqual(parseClientMessage({ t: "ui_response", id: "dialog", cancelled: true }), { t: "ui_response", id: "dialog", cancelled: true });
});
