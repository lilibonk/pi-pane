import test from "node:test";
import assert from "node:assert/strict";
import { LaunchProfile } from "../src/extension/launch-profile.js";

const START = "/work/start";
const profile = (argv: string[], files: string[] = []) => new LaunchProfile(argv, START, path => files.includes(path));

test("relative resource paths, session-dir and existing prompt files are pinned to the start directory", () => {
  const launch = profile(["-e", "./ext.ts", "--skill", "skills/a", "--theme", "/abs/theme.json", "--prompt-template", "~/t.md", "-e", "npm:@scope/pkg",
    "--session-dir", "sessions", "--system-prompt", "prompt.md", "--append-system-prompt", "plain text"], ["/work/start/prompt.md"]);
  assert.deepEqual(launch.args({ cwd: "/work/other" }), ["-e", "/work/start/ext.ts", "--skill", "/work/start/skills/a", "--theme", "/abs/theme.json", "--prompt-template", "~/t.md", "-e", "npm:@scope/pkg",
    "--session-dir", "/work/start/sessions", "--system-prompt", "/work/start/prompt.md", "--append-system-prompt", "plain text"]);
});
test("a new session keeps the start model; a saved session restores its own", () => {
  const launch = profile(["--provider", "local", "--model", "fixture", "--thinking", "high", "--tools", "read"]);
  assert.deepEqual(launch.startModel, { provider: "local", model: "fixture", thinking: "high" });
  assert.deepEqual(launch.args({ cwd: "/work/other" }), ["--provider", "local", "--model", "fixture", "--thinking", "high", "--tools", "read"]);
  assert.deepEqual(launch.args({ cwd: START, session: { file: "/s/new.jsonl", saved: false } }), ["--provider", "local", "--model", "fixture", "--thinking", "high", "--tools", "read", "--session", "/s/new.jsonl"]);
  assert.deepEqual(launch.args({ cwd: START, session: { file: "/s/a.jsonl", saved: true } }), ["--tools", "read", "--session", "/s/a.jsonl"]);
});
test("the start trust override stays in the start project and --approve is never generated", () => {
  const approved = profile(["--approve", "--offline"]);
  assert.equal(approved.startTrust, "approve");
  assert.deepEqual(approved.args({ cwd: START }), ["--approve", "--offline"]);
  assert.deepEqual(approved.args({ cwd: "/work/other" }), ["--offline"]);
  assert.deepEqual(approved.args({ cwd: "/work/other", withholdTrust: true }), ["--offline", "--no-approve"]);
  assert.deepEqual(approved.args({ cwd: START, withholdTrust: true }), ["--offline", "--no-approve"]);
  const refused = profile(["-na"]);
  assert.equal(refused.startTrust, "no-approve");
  assert.deepEqual(refused.args({ cwd: START }), ["-na"]);
  assert.deepEqual(refused.args({ cwd: "/work/other" }), []);
  assert.equal(profile([]).startTrust, undefined);
  for (const cwd of [START, "/work/other"]) for (const withholdTrust of [false, true])
    assert.ok(!profile([]).args({ cwd, withholdTrust }).includes("--approve"));
});
test("selection options and initial prompts are never replayed; extension flags travel", () => {
  const launch = profile(["--session", "/old.jsonl", "-c", "--custom=1", "initial prompt", "@file.png"]);
  assert.deepEqual(launch.args({ cwd: "/work/other" }), ["--custom=1"]);
});
