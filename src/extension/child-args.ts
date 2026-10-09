/** pi does not export its CLI parser. Preserve known configuration, never replay initial prompts. */
const DROP = new Set(["--web", "--web-no-open", "--web-proxy", "--continue", "-c", "--resume", "-r", "--print", "-p", "--no-session", "--help", "-h", "--version", "-v", "--list-models"]);
const DROP_VALUE = new Set(["--web-host", "--web-port", "--web-public-origin", "--web-tls-cert", "--web-tls-key", "--session", "--session-id", "--fork", "--mode", "--name", "-n", "--export", "--tui-mode"]);
const VALUE = new Set(["--provider", "--model", "--api-key", "--system-prompt", "--append-system-prompt", "--session-dir", "--models", "--tools", "-t", "--exclude-tools", "-xt", "--thinking", "--extension", "-e", "--skill", "--prompt-template", "--theme", "--use-theme"]);
const BOOLEAN = new Set(["--no-tools", "-nt", "--no-builtin-tools", "-nbt", "--no-extensions", "-ne", "--no-mcp", "--no-skills", "-ns", "--no-prompt-templates", "-np", "--no-themes", "--no-context-files", "-nc", "--verbose", "--approve", "-a", "--no-approve", "-na", "--offline"]);

export function childArgs(argv: readonly string[], sessionFile: string): string[] {
  const args: string[] = [];
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
      args.push(name, value);
      continue;
    }
    if (BOOLEAN.has(name)) { args.push(name); continue; }
    if (!token.startsWith("-")) continue; // initial message / @attachment; never replay it
    if (token.startsWith("--") && equal >= 0) { args.push(token); continue; }
    throw new Error(`Cannot safely hand off unknown option ${name}. Use --${name.replace(/^-+/, "")}=value (or =true for a boolean) so it cannot be confused with an initial prompt.`);
  }
  return [...args, "--session", sessionFile];
}
