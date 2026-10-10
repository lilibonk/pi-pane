import { constants } from "node:fs";
import { access, lstat, mkdir, opendir, realpath, rmdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { ProjectTrustStore, SettingsManager, hasTrustRequiringProjectResources } from "@earendil-works/pi-coding-agent";
import { ProtocolError, type DirectoriesView, type ProjectTrustView } from "../protocol/index.js";
import { projectRootProblem } from "./project-root.js";

const MAX_ENTRIES = 500;
/** Entries examined in one directory before the listing gives up; large directories stay responsive. */
const MAX_SCANNED = 20_000;
const REFUSALS = {
  credential_directory: "This directory holds credentials or agent state and cannot be opened as a project from the browser. Start pi there from a terminal if you mean to.",
  agent_directory: "This directory belongs to pi's own data (agent, session or pi-pane files) and cannot be opened as a project from the browser.",
};
const fsError = (error: unknown, path: string): ProtocolError => {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return new ProtocolError("not_found", `${path} does not exist on the machine running pi.`);
  if (code === "ENOTDIR") return new ProtocolError("not_directory", `${path} is not a directory.`);
  if (code === "EACCES" || code === "EPERM") return new ProtocolError("permission_denied", `pi is not allowed to use ${path}.`);
  if (code === "ELOOP" || code === "ENAMETOOLONG") return new ProtocolError("invalid_path", `${path} cannot be resolved.`);
  return error instanceof ProtocolError ? error : new ProtocolError("path_unavailable", `${path} cannot be used: ${error instanceof Error ? error.message : String(error)}`);
};

export interface ProjectServiceOptions {
  agentDir: string;
  /** Directories that may never be a project root, besides credential directories: agent, session and pi-pane data. */
  protectedDirectories: () => readonly string[];
  home?: string;
}
/**
 * Host directories as projects: browsing, validation, creation and the trust question.
 * Paths are only ever handed to file APIs, never to a shell. Nothing here reads file contents,
 * and nothing here starts or stops a session; the host decides when a validated project is opened.
 */
export class ProjectService {
  private readonly home: string;
  constructor(private readonly options: ProjectServiceOptions) { this.home = options.home ?? homedir(); }

  /** The real path of an existing directory pi can enter. Throws the reason otherwise. */
  private async directory(path: string): Promise<string> {
    if (!isAbsolute(path) || path.includes("\0")) throw new ProtocolError("invalid_path", "Provide an absolute path on the machine running pi.");
    let real: string;
    try {
      real = await realpath(path);
      if (!(await stat(real)).isDirectory()) throw new ProtocolError("not_directory", `${path} is not a directory.`);
      await access(real, constants.R_OK | constants.X_OK);
    } catch (error) { throw fsError(error, path); }
    return real;
  }
  refusal(root: string) { return projectRootProblem(root, this.options.protectedDirectories()); }
  /** A directory that may be opened as a project. The result is its real path: symlink aliases collapse to it. */
  async root(path: string): Promise<string> {
    const real = await this.directory(path);
    const problem = await this.refusal(real);
    if (problem) throw new ProtocolError("project_root_refused", REFUSALS[problem]);
    return real;
  }
  /** Subdirectories of `path`, by name only. Files are never listed and nothing is read. */
  async directories(path: string): Promise<DirectoriesView> {
    const real = await this.directory(path);
    const parent = dirname(real);
    const view: DirectoriesView = { path: real, ...(parent !== real ? { parent } : {}), home: this.home, entries: [], truncated: false,
      writable: await access(real, constants.W_OK).then(() => true, () => false) };
    const refused = await this.refusal(real);
    if (refused) return { ...view, refused, writable: false };
    const names: string[] = [];
    let scanned = 0;
    try {
      const handle = await opendir(real);
      for await (const entry of handle) {
        if (++scanned > MAX_SCANNED) { view.truncated = true; break; }
        // A link counts when it leads to a directory; a broken or looping one is simply not offered.
        if (entry.isDirectory() || (entry.isSymbolicLink() && await stat(join(real, entry.name)).then(info => info.isDirectory(), () => false))) names.push(entry.name);
      }
    } catch (error) { throw fsError(error, path); }
    names.sort((a, b) => Number(a.startsWith(".")) - Number(b.startsWith(".")) || a.localeCompare(b));
    if (names.length > MAX_ENTRIES) view.truncated = true;
    view.entries = names.slice(0, MAX_ENTRIES).map(name => ({ name, hidden: name.startsWith(".") }));
    return view;
  }
  /**
   * What pi itself would decide for `root`, in its order: a recorded choice, then the global default.
   * A global extension can still answer differently when the child starts; that is not knowable here.
   */
  trust(root: string): ProjectTrustView {
    let required = false, choice: ProjectTrustView["choice"] = "unknown", policy: ProjectTrustView["policy"] = "unknown";
    // Public exports of the installed pi; when one is missing or changed, say "unknown" instead of failing the listing.
    try { required = hasTrustRequiringProjectResources(root); } catch { return { required: false, choice, policy, ask: false }; }
    try { const decision = new ProjectTrustStore(this.options.agentDir).get(root); choice = decision === true ? "trusted" : decision === false ? "untrusted" : "unknown"; } catch { /* unknown */ }
    try { policy = SettingsManager.create(root, this.options.agentDir, { projectTrusted: false }).getDefaultProjectTrust(); } catch { /* unknown */ }
    // Without a UI an RPC child treats "ask" as no. Only then is there a question for the browser to put.
    return { required, choice, policy, ask: required && choice === "unknown" && (policy === "ask" || policy === "unknown") };
  }
  /** Records "trust and remember" for exactly this directory, never for a parent. */
  remember(root: string): void { new ProjectTrustStore(this.options.agentDir).set(root, true); }
  /**
   * Creates one new folder under an existing directory and returns its real path.
   * Exclusive: an existing name is reported, never reused or overwritten. Nothing is removed on a later failure.
   */
  async create(parent: string, name: string): Promise<string> {
    if (!name || name === "." || name === ".." || /[/\0]/.test(name) || Buffer.byteLength(name) > 255)
      throw new ProtocolError("invalid_name", "Use one folder name: not empty, not . or .., without / and at most 255 bytes.");
    const real = await this.directory(parent);
    const before = await stat(real);
    const target = join(real, name);
    const problem = await this.refusal(target);
    if (problem) throw new ProtocolError("project_root_refused", REFUSALS[problem]);
    const existing = await lstat(target).catch(() => undefined);
    if (existing) throw existing.isDirectory()
      ? new ProtocolError("project_exists", `${target} already exists. Open it as an existing project instead.`)
      : new ProtocolError("path_exists", `${target} already exists and is not a directory.`);
    // The parent the user confirmed must still be the same directory when the folder is made.
    const now = await stat(await realpath(parent).catch(() => "")).catch(() => undefined);
    if (!now || now.dev !== before.dev || now.ino !== before.ino) throw new ProtocolError("parent_changed", "The parent directory changed while creating the project; choose it again.");
    try { await mkdir(target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ProtocolError("project_exists", `${target} already exists. Open it as an existing project instead.`);
      throw fsError(error, target);
    }
    const created = await realpath(target);
    if (created !== target) { await rmdir(target).catch(() => undefined); throw new ProtocolError("parent_changed", "The parent directory changed while creating the project; choose it again."); }
    return created;
  }
  name(root: string): string { return basename(root) || root; }
}
