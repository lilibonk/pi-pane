import test from "node:test";
import assert from "node:assert/strict";
import { configValueKind, literalConfigValue } from "../src/extension/config-value.js";

/** pi 1.1.0's resolution of a non-command value, reduced to what matters here: `$$`, `$!` and `$NAME`. */
function resolveLikePi(value: string, env: Record<string, string>): string | undefined | "COMMAND" {
  if (value.startsWith("!")) return "COMMAND";
  let out = "";
  for (let index = 0; index < value.length;) {
    if (value[index] !== "$") { out += value[index++]; continue; }
    const next = value[index + 1];
    if (next === "$" || next === "!") { out += next; index += 2; continue; }
    const name = /^\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(value.slice(index + 1)) ?? /^([A-Za-z_][A-Za-z0-9_]*)/.exec(value.slice(index + 1));
    if (!name) { out += "$"; index++; continue; }
    if (env[name[1]!] === undefined) return undefined;
    out += env[name[1]!]; index += 1 + name[0].length;
  }
  return out;
}
const KEYS = ["sk-plain", "!touch /tmp/x", "$HOME", "a${PATH}b", "x$$y", "x$!y", "!", "$", "$!cmd", "!$HOME", `a"b'c\\d`, "line1\nline2", "", "价格$100!"];

test("an escaped key resolves back to exactly what was typed and is never a command", () => {
  for (const key of KEYS) {
    const stored = literalConfigValue(key);
    assert.equal(resolveLikePi(stored, { HOME: "/home/x", PATH: "/bin" }), key, JSON.stringify(key));
    assert.equal(configValueKind(stored), "literal", JSON.stringify(key));
  }
});
test("existing stored values are classified without resolving them", () => {
  assert.equal(configValueKind("!op read secret"), "command");
  assert.equal(configValueKind("$OPENAI_API_KEY"), "environment");
  assert.equal(configValueKind("prefix-${TOKEN}"), "environment");
  assert.equal(configValueKind("sk-abc"), "literal");
  assert.equal(configValueKind("cost $5"), "literal");
  assert.equal(configValueKind("a$$b"), "literal");
});
