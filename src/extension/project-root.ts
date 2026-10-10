import { realpath } from "node:fs/promises";
import { relative, isAbsolute, sep } from "node:path";

/** Directories whose contents are credentials or agent state, wherever they appear in a path. */
const CREDENTIAL_DIRECTORIES = new Set([".ssh", ".gnupg", ".aws", ".azure", ".pi", ".codex"]);
export type ProjectRootProblem = "credential_directory" | "agent_directory";

const inside = (root: string, target: string): boolean => {
  const part = relative(root, target);
  return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`));
};
const canonical = (path: string): Promise<string> => realpath(path).catch(() => path);

/**
 * WorkspaceService filters sensitive files by their path relative to the project root, so a root that
 * is itself inside a credential or agent directory would expose what the filter is meant to hide.
 * `root` must already be a real path. Returns why it cannot be a project opened from the browser.
 */
export async function projectRootProblem(root: string, protectedDirectories: readonly string[]): Promise<ProjectRootProblem | undefined> {
  if (root.split(sep).some(part => CREDENTIAL_DIRECTORIES.has(part.toLowerCase()))) return "credential_directory";
  for (const directory of protectedDirectories) if (inside(await canonical(directory), root)) return "agent_directory";
  return undefined;
}
