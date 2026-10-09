import test from "node:test";
import assert from "node:assert/strict";
import { childArgs } from "../src/extension/child-args.js";

test("RPC configuration preserves valued and repeated flags but never replays initial prompts or files", () => {
  const args = childArgs(["--provider", "local", "--model", "fixture", "--api-key", "test-key", "--system-prompt", "a prompt with spaces", "--append-system-prompt", "first", "--append-system-prompt", "second",
    "-e", "fixture.ts", "--session-dir", "/custom", "--tools", "read,bash", "--thinking", "high", "--approve", "--offline", "@picture.png", "initial message", "another message"], "/session.jsonl");
  assert.deepEqual(args, ["--provider", "local", "--model", "fixture", "--api-key", "test-key", "--system-prompt", "a prompt with spaces", "--append-system-prompt", "first", "--append-system-prompt", "second", "-e", "fixture.ts", "--session-dir", "/custom", "--tools", "read,bash", "--thinking", "high", "--approve", "--offline", "--session", "/session.jsonl"]);
});
test("selection, output, name and web options are stripped in both syntaxes", () => {
  assert.deepEqual(childArgs(["--session", "/old", "--session-id=id", "--fork", "/other", "-n", "old name", "--mode", "json", "-c", "-r", "--no-session", "--web", "--web-host=x", "--web-port", "7880", "--web-no-open", "--web-proxy", "--web-public-origin", "https://test", "--web-tls-cert", "cert", "--web-tls-key=key", "-p", "initial", "--no-extensions"], "/new"), ["--no-extensions", "--session", "/new"]);
});
test("double dash discards dash-leading prompts; builtin equals values normalize safely", () => {
  assert.deepEqual(childArgs(["--model=local/fixture", "--append-system-prompt=-text", "--", "-prompt", "@file"], "/new"), ["--model", "local/fixture", "--append-system-prompt", "-text", "--session", "/new"]);
});
test("unknown extension flags require explicit equals syntax rather than guessing a positional value", () => {
  assert.deepEqual(childArgs(["--custom=enabled", "--toggle=true", "initial"], "/new"), ["--custom=enabled", "--toggle=true", "--session", "/new"]);
  assert.throws(() => childArgs(["--custom", "value", "initial"], "/new"), /Cannot safely hand off unknown option/);
  assert.throws(() => childArgs(["--model"], "/new"), /requires a value/);
});
