/** pi does not export its CLI parser. Preserve known configuration, never replay initial prompts. */
const DROP = new Set(["--web", "--web-no-open", "--web-proxy", "--continue", "-c", "--resume", "-r", "--print", "-p", "--no-session", "--help", "-h", "--version", "-v", "--list-models"]);
const DROP_VALUE = new Set(["--web-host", "--web-port", "--web-public-origin", "--web-tls-cert", "--web-tls-key", "--session", "--session-id", "--fork", "--mode", "--name", "-n", "--export", "--tui-mode"]);
const VALUE = new Set(["--provider", "--model", "--api-key", "--system-prompt", "--append-system-prompt", "--session-dir", "--models", "--tools", "-t", "--exclude-tools", "-xt", "--thinking", "--extension", "-e", "--skill", "--prompt-template", "--theme", "--use-theme"]);
const BOOLEAN = new Set(["--no-tools", "-nt", "--no-builtin-tools", "-nbt", "--no-extensions", "-ne", "--no-mcp", "--no-skills", "-ns", "--no-prompt-templates", "-np", "--no-themes", "--no-context-files", "-nc", "--verbose", "--approve", "-a", "--no-approve", "-na", "--offline"]);

/** One preserved launch option: a built-in flag with or without a value, or an extension flag in `--name=value` form. */
export type LaunchOption = { kind: "value"; name: string; value: string } | { kind: "boolean"; name: string } | { kind: "extension"; token: string };

/** The configuration part of a pi command line, in order. Selection, output and initial prompts are dropped. */
export function launchOptions(argv: readonly string[]): LaunchOption[] {
  const options: LaunchOption[] = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (token === "--") break; // everything after this is an initial prompt or attachment
    const equal = token.indexOf("=");
    const name = equal < 0 ? token : token.slice(0, equal);
    if (DROP.has(name)) {
      if ((name === "--print" || name === "-p" || name === "--list-models") && equal < 0 && argv[index + 1] && !argv[index + 1]!.startsWith("-")) index++;
      continue;
    }
    if (DROP_VALUE.has(name)) { if (equal < 0) index++; continue; }
    if (VALUE.has(name)) {
      const value = equal < 0 ? argv[++index] : token.slice(equal + 1);
      if (value === undefined) throw new Error(`Cannot hand off: ${name} requires a value.`);
      // pi's own CLI only understands space-separated built-in option values.
      options.push({ kind: "value", name, value });
      continue;
    }
    if (BOOLEAN.has(name)) { options.push({ kind: "boolean", name }); continue; }
    if (!token.startsWith("-")) continue; // initial message / @attachment; never replay it
    if (token.startsWith("--") && equal >= 0) { options.push({ kind: "extension", token }); continue; }
    throw new Error(`Cannot safely hand off unknown option ${name}. Use --${name.replace(/^-+/, "")}=value (or =true for a boolean) so it cannot be confused with an initial prompt.`);
  }
  return options;
}
export const optionTokens = (options: readonly LaunchOption[]): string[] =>
  options.flatMap(option => option.kind === "value" ? [option.name, option.value] : option.kind === "boolean" ? [option.name] : [option.token]);

export function childArgs(argv: readonly string[], sessionFile: string): string[] {
  return [...optionTokens(launchOptions(argv)), "--session", sessionFile];
}
