import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { launchOptions, optionTokens, type LaunchOption } from "./child-args.js";

const MODEL = new Set(["--provider", "--model", "--thinking"]);
const TRUST = new Set(["--approve", "-a", "--no-approve", "-na"]);
const RESOURCE_PATH = new Set(["--extension", "-e", "--skill", "--prompt-template", "--theme"]);
const PROMPT_INPUT = new Set(["--system-prompt", "--append-system-prompt"]);
/** pi's own test for package sources that are not paths (`isLocalPath`). */
const REMOTE_SOURCE = /^(npm|git|github|http|https|ssh|builtin):/;
/** Projects are compared by real path: the same directory reached through a link is the same project. */
const canonical = (path: string): string => { try { return realpathSync(path); } catch { return resolve(path); } };
const cwdIndependent = (value: string): boolean => isAbsolute(value) || value.startsWith("~") || value.startsWith("file:");

/**
 * Where a relaunched RPC child will run.
 * - `session.saved`: an existing transcript is being resumed; it restores its own model.
 * - `withholdTrust`: the user chose to continue without loading the project's configuration.
 */
export interface LaunchTarget {
  cwd: string;
  session?: { file: string; saved: boolean };
  withholdTrust?: boolean;
}

/**
 * The user's original pi command line, classified by how far each part may travel.
 * Built once while the start directory still exists as the process cwd: relative resource paths and
 * prompt files are pinned to it, so another project never reinterprets them.
 */
export class LaunchProfile {
  private readonly options: LaunchOption[];
  constructor(argv: readonly string[], readonly startCwd: string, exists: (path: string) => boolean = existsSync) {
    this.options = launchOptions(argv).map(option => {
      if (option.kind !== "value") return option;
      const { name, value } = option;
      if (RESOURCE_PATH.has(name)) return REMOTE_SOURCE.test(value.trim()) || cwdIndependent(value) ? option : { ...option, value: resolve(startCwd, value) };
      if (name === "--session-dir") return cwdIndependent(value) ? option : { ...option, value: resolve(startCwd, value) };
      // pi reads a prompt option as a file only when that path exists; decide it the same way, once.
      if (PROMPT_INPUT.has(name) && !cwdIndependent(value) && exists(resolve(startCwd, value))) return { ...option, value: resolve(startCwd, value) };
      return option;
    });
  }
  /** The explicit trust override the user started pi with, if any. It belongs to the start project only. */
  get startTrust(): "approve" | "no-approve" | undefined {
    const last = this.options.filter((option): option is Extract<LaunchOption, { kind: "boolean" }> => option.kind === "boolean" && TRUST.has(option.name)).at(-1)?.name;
    return last === undefined ? undefined : last === "--approve" || last === "-a" ? "approve" : "no-approve";
  }
  /** The model the user started pi with; shown as an override source, applied only to sessions that have no model of their own. */
  get startModel(): { provider?: string; model?: string; thinking?: string } {
    const value = (name: string) => this.options.filter((option): option is Extract<LaunchOption, { kind: "value" }> => option.kind === "value" && option.name === name).at(-1)?.value;
    return { ...(value("--provider") ? { provider: value("--provider") } : {}), ...(value("--model") ? { model: value("--model") } : {}), ...(value("--thinking") ? { thinking: value("--thinking") } : {}) };
  }
  /**
   * Arguments for an RPC child at `target`.
   * - A saved session restores its own model, so the start model is not replayed over it.
   * - `--approve` is process-wide in pi: it is replayed only for the start project and never generated here.
   * - No `--session` for a new session: pi allocates the path in its own session directory.
   */
  args(target: LaunchTarget): string[] {
    const inStartProject = canonical(target.cwd) === canonical(this.startCwd);
    const kept = this.options.filter(option => {
      if (option.kind === "value" && MODEL.has(option.name)) return !target.session?.saved;
      if (option.kind === "boolean" && TRUST.has(option.name)) return inStartProject && !target.withholdTrust;
      return true;
    });
    return [...optionTokens(kept), ...(target.withholdTrust ? ["--no-approve"] : []), ...(target.session ? ["--session", target.session.file] : [])];
  }
}
