import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { withFileLock, writeFileAtomic } from "./file-lock.js";

/** A host directory the user opened or created as a project. It exists without any saved session. */
export interface ProjectEntry {
  id: string;
  /** Real path at registration time. */
  path: string;
  name: string;
  source: "opened" | "created";
  createdAt: string;
  lastOpenedAt: string;
  /** The last session of this project that had been saved to disk. */
  lastSession?: { id: string; file: string };
}
interface RegistryFile { version: 1; projects: ProjectEntry[]; /** Paths the user removed from the list; session history must not bring them back. */ hidden: string[] }
/** What the browser lists: registered projects plus directories only known from saved sessions. */
export interface ProjectView { id?: string; path: string; name: string; source: ProjectEntry["source"] | "history"; available: boolean; lastOpenedAt?: string; lastSession?: ProjectEntry["lastSession"] }

export class ProjectRegistryError extends Error {
  constructor(readonly code: "registry_corrupt" | "registry_newer" | "unknown_project", message: string) { super(message); this.name = "ProjectRegistryError"; }
}
const empty = (): RegistryFile => ({ version: 1, projects: [], hidden: [] });
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
function parse(content: string, path: string): RegistryFile {
  let value: unknown;
  try { value = JSON.parse(content); } catch { throw new ProjectRegistryError("registry_corrupt", `The project list ${path} is not valid JSON. It was left untouched; repair or remove it.`); }
  const file = value as Partial<RegistryFile> | null;
  if (!file || typeof file !== "object" || typeof file.version !== "number") throw new ProjectRegistryError("registry_corrupt", `The project list ${path} has an unknown shape. It was left untouched; repair or remove it.`);
  if (file.version > 1) throw new ProjectRegistryError("registry_newer", `The project list ${path} was written by a newer pi-pane and is not changed by this version.`);
  if (!Array.isArray(file.projects) || !Array.isArray(file.hidden ?? [])) throw new ProjectRegistryError("registry_corrupt", `The project list ${path} has an unknown shape. It was left untouched; repair or remove it.`);
  const projects = file.projects.filter((item): item is ProjectEntry => !!item && text(item.id) && text(item.path) && text(item.name) && text(item.createdAt) && text(item.lastOpenedAt));
  return { version: 1, projects, hidden: (file.hidden ?? []).filter(text) };
}
const isDirectory = (path: string): Promise<boolean> => stat(path).then(info => info.isDirectory(), () => false);

/**
 * `<agentDir>/pi-pane/projects.json`: project entries only, never chat content, keys or access tokens.
 * Several hosts may share it; every change is a locked read-modify-write followed by an atomic replace.
 */
export class ProjectRegistry {
  readonly path: string;
  constructor(agentDir: string) { this.path = join(agentDir, "pi-pane", "projects.json"); }

  private async read(): Promise<RegistryFile> {
    let content: string;
    try { content = await readFile(this.path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty(); throw error; }
    return parse(content, this.path);
  }
  private async change<T>(apply: (file: RegistryFile) => T): Promise<T> {
    await mkdir(join(this.path, ".."), { recursive: true, mode: 0o700 });
    return withFileLock(this.path, async () => {
      const file = await this.read(); // a corrupt or newer file throws here and is never replaced
      const result = apply(file);
      await writeFileAtomic(this.path, `${JSON.stringify(file, null, 2)}\n`);
      return result;
    });
  }
  async list(): Promise<ProjectEntry[]> { return (await this.read()).projects; }
  /** Registers `directory` (which must exist) or refreshes the entry that already names the same real path. */
  async open(directory: string, source: ProjectEntry["source"] = "opened"): Promise<ProjectEntry> {
    const path = await realpath(directory);
    const now = new Date().toISOString();
    return this.change(file => {
      file.hidden = file.hidden.filter(hidden => hidden !== path);
      const existing = file.projects.find(project => project.path === path);
      if (existing) { existing.lastOpenedAt = now; return { ...existing }; }
      const entry: ProjectEntry = { id: randomUUID(), path, name: basename(path) || path, source, createdAt: now, lastOpenedAt: now };
      file.projects.push(entry);
      return { ...entry };
    });
  }
  /** Records the project's last saved session, or clears it when that session no longer exists. */
  async setLastSession(id: string, session: ProjectEntry["lastSession"] | undefined): Promise<void> {
    await this.change(file => {
      const project = file.projects.find(item => item.id === id);
      if (!project) throw new ProjectRegistryError("unknown_project", "This project is no longer in the list.");
      if (session) project.lastSession = { id: session.id, file: session.file }; else delete project.lastSession;
    });
  }
  /** Forgets every reference to a deleted session file. */
  async forgetSession(file: string): Promise<void> {
    if (!(await this.read()).projects.some(project => project.lastSession?.file === file)) return;
    await this.change(registry => { for (const project of registry.projects) if (project.lastSession?.file === file) delete project.lastSession; });
  }
  /**
   * Points a listed project whose directory moved at the directory the user chose. The old path is
   * hidden so history does not list it again; the last-session reference belonged to the old path.
   */
  async relocate(from: string, directory: string): Promise<ProjectEntry> {
    const path = await realpath(directory);
    return this.change(file => {
      const project = file.projects.find(item => item.path === from);
      if (!project) throw new ProjectRegistryError("unknown_project", "This project is no longer in the list.");
      file.projects = file.projects.filter(item => item === project || item.path !== path);
      if (!file.hidden.includes(from)) file.hidden.push(from);
      file.hidden = file.hidden.filter(hidden => hidden !== path);
      project.path = path; project.name = basename(path) || path; project.lastOpenedAt = new Date().toISOString(); delete project.lastSession;
      return { ...project };
    });
  }
  /** Removes a project from the list only. Its directory and sessions stay; history will not re-add it. */
  async remove(path: string): Promise<void> {
    await this.change(file => {
      file.projects = file.projects.filter(project => project.path !== path);
      if (!file.hidden.includes(path)) file.hidden.push(path);
    });
  }
  /** Registered projects first (most recently opened first), then directories seen only in saved sessions. */
  async view(historyCwds: readonly string[] = []): Promise<ProjectView[]> {
    const file = await this.read();
    const known = new Set([...file.projects.map(project => project.path), ...file.hidden]);
    const registered = [...file.projects].sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
    const views: ProjectView[] = [];
    for (const project of registered) views.push({ id: project.id, path: project.path, name: project.name, source: project.source, available: await isDirectory(project.path), lastOpenedAt: project.lastOpenedAt, ...(project.lastSession ? { lastSession: project.lastSession } : {}) });
    for (const cwd of new Set(historyCwds)) {
      // A session header records the path as pi saw it; compare by real path when the directory still exists.
      const path = await realpath(cwd).catch(() => cwd);
      if (known.has(path)) continue;
      known.add(path);
      views.push({ path, name: basename(path) || path, source: "history", available: await isDirectory(path) });
    }
    return views;
  }
}
