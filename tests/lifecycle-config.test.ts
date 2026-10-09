import assert from "node:assert/strict";
import test from "node:test";
import { readPaneSettings } from "../src/extension/config.js";

test("piPane reads validated settings without mutating the host's effective snapshot", () => {
  const settings = { piPane: { host: "127.0.0.1", port: 8123, noOpen: true }, theme: "light" };
  const result = readPaneSettings(settings);
  assert.deepEqual(result, settings.piPane);
  result.port = 9999;
  assert.equal(settings.piPane.port, 8123);
  assert.deepEqual(readPaneSettings({}), {});
});

test("unsupported or nonloopback persistent options fail closed", () => {
  for (const piPane of [null, [], { host: "0.0.0.0" }, { host: ["localhost"] }, { port: "8123" }, { port: 0 }, { noOpen: "true" }, { password: "fixture" }])
    assert.throws(() => readPaneSettings({ piPane }), /piPane|Unsupported/);
});

test("web startup is not a persistent option in handoff mode", () => {
  assert.throws(() => readPaneSettings({ piPane: { web: true } }), /Unsupported|piPane/);
  assert.throws(() => readPaneSettings({ piPane: { mirror: true } }), /Unsupported|piPane/);
});
