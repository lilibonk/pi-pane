import assert from "node:assert/strict";
import test from "node:test";
import { commandArgs, parseClientMessage, ProtocolError } from "../src/protocol/index.ts";

test("wire validation rejects ambiguous identities and unsafe command counters", () => {
  const valid = { t: "command", clientId: "client", commandNo: 1, id: "client:1", epoch: "epoch", sessionId: "session", branchRevision: 0, command: "abort", args: {} };
  assert.deepEqual(parseClientMessage(valid), valid);
  for (const patch of [{ id: "different" }, { commandNo: 1.5 }, { commandNo: Number.MAX_SAFE_INTEGER + 1 }, { branchRevision: -1 }, { privileged: true }]) {
    assert.throws(() => parseClientMessage({ ...valid, ...patch }), ProtocolError);
  }
});

test("prompt limit counts UTF-8 bytes and M0 refuses unsupported uploads", () => {
  assert.equal(commandArgs("prompt", { text: "汉".repeat(21_845), mode: "steer" }).mode, "steer");
  assert.throws(() => commandArgs("prompt", { text: "汉".repeat(21_846) }), ProtocolError);
  assert.throws(() => commandArgs("prompt", { text: "test", images: [] }), ProtocolError);
  assert.throws(() => commandArgs("prompt", { text: "   " }), ProtocolError);
  assert.throws(() => commandArgs("prompt", { text: "test", mode: "immediate" }), ProtocolError);
});

test("unknown commands and malformed control messages fail closed", () => {
  for (const value of [null, [], { t: "hello", clientId: "" }, { t: "resync", command: "abort" }, { t: "receipt_query", clientId: "c" }]) {
    assert.throws(() => parseClientMessage(value), ProtocolError);
  }
  assert.throws(() => commandArgs("shutdown", {}), /Unknown command/);
  assert.throws(() => commandArgs("abort", { other: true }), ProtocolError);
});
