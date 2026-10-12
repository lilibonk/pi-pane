import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, opendir, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { ProtocolError } from "../protocol/index.js";
import { canonicalDirectories, insideAny } from "./project-root.js";

const FILE_LIMIT = 500;
const SCAN_LIMIT = 10_000;
const TEXT_BYTES = 256 * 1024;
const STATUS_BYTES = 2 * 1024 * 1024;
const EXCLUDED_DIRECTORIES = new Set([
  ".git", "node_modules", "build-artifacts", "build", "dist", "web-dist", "coverage", ".next", ".cache", ".venv", "venv",
  ".ssh", ".gnupg", ".aws", ".azure", ".pi", ".codex",
]);
const EXCLUDED_FILES = new Set([
  ".npmrc", ".netrc", ".pypirc", ".git-credentials", ".envrc", ".bash_history", ".zsh_history",
  "auth.json", "credentials.json", "credentials", "token", "server.token",
]);
const LANGUAGES: Record<string, string> = {
  ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "jsx",
  ".json": "json", ".md": "markdown", ".mdx": "markdown", ".css": "css", ".html": "html", ".htm": "html",
  ".yml": "yaml", ".yaml": "yaml", ".toml": "toml", ".sh": "bash", ".zsh": "bash", ".bash": "bash",
  ".py": "python", ".go": "go", ".rs": "rust", ".java": "java", ".c": "c", ".h": "c", ".cpp": "cpp", ".hpp": "cpp",
  ".cs": "csharp", ".sql": "sql", ".rb": "ruby", ".php": "php", ".swift": "swift", ".kt": "kotlin", ".diff": "diff", ".patch": "diff",
};

export interface WorkspaceFilesView {
  cwd: string;
  files: Array<{ path: string; name: string; type: "file"; size?: number }>;
  truncated: boolean;
}
export interface WorkspaceFileView { path: string; text: string; language?: string; truncated: boolean; bytes: number }
export interface GitStatusView {
  isRepository: boolean;
  branch?: string;
  files: Array<{ path: string; status: string; staged: boolean; unstaged: boolean; originalPath?: string }>;
  truncated: boolean;
}
export interface GitDiffView { path: string; text: string; truncated: boolean }
interface GitOutput { stdout: Buffer; truncated: boolean; code: number }

function inside(root: string, target: string): boolean {
  const part = relative(root, target);
  return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`));
}
function excluded(path: string): boolean {
  const parts = path.replaceAll("\\", "/").split("/").map((part) => part.toLowerCase());
  if (parts.some((part) => EXCLUDED_DIRECTORIES.has(part))) return true;
  const name = parts.at(-1) ?? "";
  return EXCLUDED_FILES.has(name) || name === ".env" || name.startsWith(".env.") || /^id_(rsa|dsa|ecdsa|ed25519)(\.|$)/.test(name)
    || /\.(pem|key|p12|pfx|jks|keystore)$/.test(name);
}
function validPath(path: string): void {
  if (typeof path !== "string" || !path || path.length > 4096 || path.includes("\0") || isAbsolute(path) || win32.isAbsolute(path) || /^[a-z]:/i.test(path)
    || path.split(/[\\/]/).some((part) => part === ".." || part === "."))
    throw new ProtocolError("invalid_path", "Choose a relative file path inside the workspace.");
  if (excluded(path)) throw new ProtocolError("excluded_file", "This file is excluded from workspace preview.");
}
function decodeText(bytes: Buffer, truncated: boolean): string {
  if (bytes.includes(0)) throw new ProtocolError("binary_file", "Binary files cannot be previewed as text.");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: truncated }); }
  catch { throw new ProtocolError("binary_file", "This file is not UTF-8 text."); }
}
function isCode(error: unknown, code: string): boolean { return (error as NodeJS.ErrnoException)?.code === code; }

/** Read-only files and Git views. Every request stays inside the active workspace. */
export class WorkspaceService {
  private readonly cwd: string;
  constructor(cwd: string, private readonly protectedDirectories: () => readonly string[] = () => []) { this.cwd = resolve(cwd); }

  /**
   * The agent and session directories as real paths, read once per request: a directory registered
   * later is protected from the next request on. Only these are judged by absolute path. Names such as
   * `.ssh` are judged relative to the project, so a project that itself lives below a dot-directory
   * (a tool-managed checkout, say) keeps its files.
   */
  private protectedRoots(): Promise<string[]> { return canonicalDirectories(this.protectedDirectories()); }

  private async root(): Promise<string> {
    try { return await realpath(this.cwd); }
    catch { throw new ProtocolError("workspace_unavailable", "The workspace directory is unavailable."); }
  }

  private async checkedPath(path: string, allowMissing = false, protectedRoots?: readonly string[]): Promise<{ root: string; target: string }> {
    validPath(path);
    const root = await this.root();
    const lexical = resolve(root, path);
    if (!inside(root, lexical)) throw new ProtocolError("outside_workspace", "The file is outside the workspace.");
    let target: string;
    try { target = await realpath(lexical); }
    catch (error) {
      if (!allowMissing || !isCode(error, "ENOENT")) {
        if (isCode(error, "ENOENT")) throw new ProtocolError("file_not_found", "The workspace file no longer exists.");
        throw new ProtocolError("file_unavailable", "The workspace file cannot be read.");
      }
      let parent = dirname(lexical);
      while (true) {
        try { target = resolve(await realpath(parent), relative(parent, lexical)); break; }
        catch (parentError) {
          if (!isCode(parentError, "ENOENT") || parent === root || dirname(parent) === parent)
            throw new ProtocolError("file_unavailable", "The workspace file cannot be read.");
          parent = dirname(parent);
        }
      }
    }
    if (!inside(root, target)) throw new ProtocolError("outside_workspace", "The file is outside the workspace.");
    if (excluded(relative(root, target)) || insideAny(target, protectedRoots ?? await this.protectedRoots()))
      throw new ProtocolError("excluded_file", "This file is excluded from workspace preview.");
    return { root, target };
  }

  async files(query = ""): Promise<WorkspaceFilesView> {
    if (typeof query !== "string" || query.length > 256) throw new ProtocolError("invalid_query", "The file search is too long.");
    const root = await this.root();
    const protectedRoots = await this.protectedRoots();
    const needle = query.trim().toLowerCase();
    const files: WorkspaceFilesView["files"] = [];
    const pending = [root];
    let scanned = 0;
    let truncated = false;
    while (pending.length && !truncated) {
      const directory = pending.pop()!;
      // Directories are never followed through symlinks; re-check before enumeration as well.
      let entries;
      try {
        const canonical = await realpath(directory);
        if (!inside(root, canonical) || insideAny(canonical, protectedRoots)) continue;
        entries = await opendir(directory);
      } catch { continue; }
      for await (const entry of entries) {
        if (++scanned > SCAN_LIMIT) { truncated = true; break; }
        const target = resolve(directory, entry.name);
        const path = relative(root, target).split(sep).join("/");
        if (excluded(path) || entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) { pending.push(target); continue; }
        if (!entry.isFile() || (needle && !path.toLowerCase().includes(needle))) continue;
        if (files.length === FILE_LIMIT) { truncated = true; break; }
        try {
          const checked = await this.checkedPath(path, false, protectedRoots);
          const info = await stat(checked.target);
          if (info.isFile()) files.push({ path, name: basename(path), type: "file", size: info.size });
        } catch { /* A file removed or replaced during enumeration is omitted. */ }
      }
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { cwd: root, files, truncated };
  }

  async file(path: string): Promise<WorkspaceFileView> {
    const { root, target } = await this.checkedPath(path);
    let handle;
    try { handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
      if (isCode(error, "ENOENT")) throw new ProtocolError("file_not_found", "The workspace file no longer exists.");
      throw new ProtocolError("file_unavailable", "The workspace file cannot be read.");
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new ProtocolError("not_a_file", "Only regular files can be previewed.");
      const current = await this.checkedPath(path);
      const pathInfo = await stat(current.target);
      if (current.root !== root || current.target !== target || info.dev !== pathInfo.dev || info.ino !== pathInfo.ino)
        throw new ProtocolError("file_changed", "The file changed while opening. Please retry.");
      const buffer = Buffer.alloc(Math.min(info.size, TEXT_BYTES));
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const part = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (!part.bytesRead) break;
        bytesRead += part.bytesRead;
      }
      const truncated = info.size > TEXT_BYTES;
      const text = decodeText(buffer.subarray(0, bytesRead), truncated);
      const language = basename(path).toLowerCase() === "dockerfile" ? "dockerfile" : LANGUAGES[extname(path).toLowerCase()];
      return { path, text, ...(language ? { language } : {}), truncated, bytes: info.size };
    } finally { await handle.close(); }
  }

  private async git(root: string, args: string[], maxBytes = STATUS_BYTES, acceptedCodes = [0]): Promise<GitOutput> {
    // Status/diff can invoke repository clean/process filters. Disable them per invocation,
    // without changing repository configuration or triggering executable filter programs.
    const names = await this.gitRaw(root, ["config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"], 64 * 1024, [0, 1]);
    if (names.truncated) throw new ProtocolError("git_failed", "The workspace Git filter configuration is too large.");
    const overrides: string[] = [];
    for (const name of names.stdout.toString("utf8").split("\0").filter(Boolean))
      overrides.push("-c", `${name}=${name.endsWith(".required") ? "false" : ""}`);
    return this.gitRaw(root, args, maxBytes, acceptedCodes, overrides);
  }

  private async gitRaw(root: string, args: string[], maxBytes: number, acceptedCodes: number[], overrides: string[] = []): Promise<GitOutput> {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
    env.GIT_OPTIONAL_LOCKS = "0";
    env.GIT_TERMINAL_PROMPT = "0";
    return await new Promise<GitOutput>((done, reject) => {
      const child = spawn("git", ["--no-optional-locks", "--literal-pathspecs", "-c", "core.fsmonitor=false", ...overrides, ...args], {
        cwd: root, env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
      });
      const chunks: Buffer[] = [];
      let length = 0;
      let truncated = false;
      let timedOut = false;
      let forceKill: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        child.kill();
        forceKill ??= setTimeout(() => child.kill("SIGKILL"), 500);
      };
      const timer = setTimeout(() => { timedOut = true; stop(); }, 10_000);
      child.stdout.on("data", (chunk: Buffer) => {
        const remaining = maxBytes - length;
        if (remaining > 0) { const part = chunk.subarray(0, remaining); chunks.push(part); length += part.length; }
        if (chunk.length > remaining) { truncated = true; stop(); }
      });
      child.once("error", (error) => { clearTimeout(timer); clearTimeout(forceKill); reject(error); });
      child.once("close", (code) => {
        clearTimeout(timer);
        clearTimeout(forceKill);
        if (timedOut) { reject(new ProtocolError("git_timeout", "Git took too long to respond.")); return; }
        if (!truncated && !acceptedCodes.includes(code ?? -1)) {
          reject(new ProtocolError("git_failed", "Git could not read this workspace.")); return;
        }
        done({ stdout: Buffer.concat(chunks), truncated, code: code ?? -1 });
      });
    });
  }

  private async repository(): Promise<string | undefined> {
    const root = await this.root();
    try {
      const result = await this.git(root, ["rev-parse", "--show-toplevel"]);
      const top = await realpath(result.stdout.toString("utf8").trim());
      // A project directory inside someone else's repository must not expose its parent.
      return top === root ? root : undefined;
    } catch (error) {
      if (isCode(error, "ENOENT") || (error instanceof ProtocolError && error.code === "git_failed")) return undefined;
      throw error;
    }
  }

  async gitStatus(): Promise<GitStatusView> {
    const root = await this.repository();
    if (!root) return { isRepository: false, files: [], truncated: false };
    const [status, branch] = await Promise.all([
      this.git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      this.git(root, ["symbolic-ref", "--short", "HEAD"], 1024, [0, 1]),
    ]);
    const records = status.stdout.toString("utf8").split("\0");
    if (records.at(-1) !== "") records.pop();
    const files: GitStatusView["files"] = [];
    let truncated = status.truncated;
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (record.length < 4) continue;
      const xy = record.slice(0, 2);
      const path = record.slice(3);
      const originalPath = /[RC]/.test(xy) ? records[++i] : undefined;
      try {
        await this.checkedPath(path, true);
        if (originalPath) await this.checkedPath(originalPath, true);
      } catch { continue; }
      if (files.length === FILE_LIMIT) { truncated = true; break; }
      files.push({ path, status: xy.trim(), staged: xy[0] !== " " && xy[0] !== "?", unstaged: xy[1] !== " ", ...(originalPath ? { originalPath } : {}) });
    }
    const branchName = branch.stdout.toString("utf8").trim();
    return { isRepository: true, ...(branchName ? { branch: branchName } : {}), files, truncated };
  }

  async gitDiff(path: string): Promise<GitDiffView> {
    await this.checkedPath(path, true);
    const root = await this.repository();
    if (!root) throw new ProtocolError("git_unavailable", "The workspace has no Git repository at its root.");
    const change = (await this.gitStatus()).files.find((entry) => entry.path === path);
    const paths = change?.originalPath ? [change.originalPath, path] : [path];
    const diffArgs = ["--no-ext-diff", "--no-textconv", "--no-color"];
    let result: GitOutput;
    if (change?.status === "??") {
      // Git renders an untracked file without changing the index or the worktree.
      result = await this.git(root, ["diff", "--no-index", ...diffArgs, "--", process.platform === "win32" ? "NUL" : "/dev/null", path], TEXT_BYTES, [0, 1]);
    } else {
      const head = await this.git(root, ["rev-parse", "--verify", "HEAD"], 1024, [0, 128]);
      if (head.code === 0) result = await this.git(root, ["diff", ...diffArgs, "HEAD", "--", ...paths], TEXT_BYTES);
      else {
        const staged = await this.git(root, ["diff", "--cached", ...diffArgs, "--", ...paths], TEXT_BYTES);
        const unstaged = await this.git(root, ["diff", ...diffArgs, "--", ...paths], Math.max(0, TEXT_BYTES - staged.stdout.length));
        result = { stdout: Buffer.concat([staged.stdout, unstaged.stdout]), truncated: staged.truncated || unstaged.truncated, code: 0 };
      }
    }
    return { path, text: new TextDecoder().decode(result.stdout, { stream: result.truncated }), truncated: result.truncated };
  }
}
