import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Directories whose contents are credentials or agent state, wherever they appear in a path. */
const CREDENTIAL_DIRECTORIES = new Set([".ssh", ".gnupg", ".aws", ".azure", ".pi", ".codex"]);
export type ProjectRootProblem = "credential_directory" | "agent_directory";

const inside = (root: string, target: string): boolean => {
  const part = relative(root, target);
  return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`));
};
/**
 * The real path; for a path that does not exist, the real path of its nearest existing ancestor with
 * the missing part appended. A protected directory that was deleted, or was configured through a link,
 * is then still compared in the form the paths tested against it are resolved to.
 */
async function canonical(path: string): Promise<string> {
  const missing: string[] = [];
  for (let current = resolve(path); ;) {
    try { return join(await realpath(current), ...missing); } catch { /* not there: anchor at the parent */ }
    const parent = dirname(current);
    if (parent === current) return path;
    missing.unshift(basename(current)); current = parent;
  }
}

/**
 * WorkspaceService filters sensitive files by their path relative to the project root, so a root that
 * is itself inside a credential or agent directory would expose what the filter is meant to hide.
 * `root` must already be a real path. Returns why it cannot be a project opened from the browser.
 */
export async function projectRootProblem(root: string, protectedDirectories: readonly string[]): Promise<ProjectRootProblem | undefined> {
  if (root.split(sep).some(part => CREDENTIAL_DIRECTORIES.has(part.toLowerCase()))) return "credential_directory";
  return insideAny(root, await canonicalDirectories(protectedDirectories)) ? "agent_directory" : undefined;
}
/** Real paths of the protected directories, for a caller that checks many paths in one request. */
export function canonicalDirectories(directories: readonly string[]): Promise<string[]> { return Promise.all(directories.map(canonical)); }
/** Whether a real path is one of these directories or lies inside one. */
export function insideAny(target: string, canonical: readonly string[]): boolean { return canonical.some(directory => inside(directory, target)); }
