/**
 * pi resolves stored API keys and header values as configuration values: a leading `!` runs the rest
 * as a shell command, `$NAME` / `${NAME}` interpolate the environment, and `$$` / `$!` escape `$` / `!`.
 * Text typed in a browser must never reach that resolver unescaped.
 */

/** Encodes `text` so pi resolves it back to exactly `text`, with no command and no interpolation. */
export function literalConfigValue(text: string): string {
  const escaped = text.replaceAll("$", "$$$$");
  return escaped.startsWith("!") ? `$${escaped}` : escaped;
}

/** How an existing stored value would be resolved. For display only: never resolve it to find out. */
export function configValueKind(value: string): "literal" | "environment" | "command" {
  if (value.startsWith("!")) return "command";
  for (let index = value.indexOf("$"); index >= 0; index = value.indexOf("$", index)) {
    const next = value[index + 1];
    if (next === "$" || next === "!") { index += 2; continue; }
    if (next === "{" ? /^\{[A-Za-z_][A-Za-z0-9_]*\}/.test(value.slice(index + 1)) : /^[A-Za-z_]/.test(next ?? "")) return "environment";
    index += 1;
  }
  return "literal";
}
