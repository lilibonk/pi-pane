import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { WorkspaceService } from "../src/extension/workspace.ts";

const exec = promisify(execFile);
async function fixture(): Promise<{ root: string; service: WorkspaceService; close(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "pi-pane-workspace-"));
  return { root, service: new WorkspaceService(root), close: () => rm(root, { recursive: true, force: true }) };
}
async function git(root: string, ...args: string[]): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const result = await exec("git", ["-c", "user.name=Workspace Test", "-c", "user.email=workspace@example.invalid", ...args], { cwd: root, env });
  return result.stdout;
}

test("file enumeration, literal search and UTF-8 previews preserve nested names", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, "nested folder"));
    await writeFile(join(f.root, "nested folder", "hello world.ts"), "export const text = '你好';\n");
    await writeFile(join(f.root, "README.md"), "# Project\n");
    const list = await f.service.files("HELLO WORLD");
    assert.equal(list.truncated, false);
    assert.deepEqual(list.files.map((entry) => entry.path), ["nested folder/hello world.ts"]);
    assert.equal(list.files[0].type, "file");
    assert.equal(list.files[0].name, "hello world.ts");
    assert.equal(list.files[0].size, Buffer.byteLength("export const text = '你好';\n"));
    const preview = await f.service.file(list.files[0].path);
    assert.equal(preview.language, "typescript");
    assert.equal(preview.text, "export const text = '你好';\n");
    assert.equal(preview.bytes, Buffer.byteLength(preview.text));
    assert.equal(preview.truncated, false);
  } finally { await f.close(); }
});

test("workspace preview rejects traversal, external symlinks, binaries and credential paths", async () => {
  const f = await fixture();
  const outside = await fixture();
  try {
    await writeFile(join(outside.root, "secret.txt"), "private data");
    await symlink(join(outside.root, "secret.txt"), join(f.root, "outside.txt"));
    await symlink(outside.root, join(f.root, "external"));
    await writeFile(join(f.root, "binary.bin"), Buffer.from([1, 2, 0, 255]));
    await writeFile(join(f.root, "invalid-utf8.bin"), Buffer.from([255, 255, 255]));
    await writeFile(join(f.root, ".env.local"), "API_KEY=private");
    await symlink(join(f.root, ".env.local"), join(f.root, "env-alias.txt"));
    await mkdir(join(f.root, "node_modules"));
    await writeFile(join(f.root, "node_modules", "vendor.ts"), "package");
    await mkdir(join(f.root, ".git"));
    await writeFile(join(f.root, ".git", "config"), "git config");
    await mkdir(join(f.root, "build-artifacts"));
    await writeFile(join(f.root, "build-artifacts", "private.txt"), "build output");
    for (const path of ["../secret.txt", "/etc/passwd", "C:\\Windows\\system.ini", "C:secret.txt", "nested/../file", "nul\0file"])
      await assert.rejects(f.service.file(path), /relative file path/);
    await assert.rejects(f.service.file("outside.txt"), /outside the workspace/);
    await assert.rejects(f.service.file("external/secret.txt"), /outside the workspace/);
    for (const path of [".env.local", "env-alias.txt", ".git/config", "node_modules/vendor.ts", "build-artifacts/private.txt"])
      await assert.rejects(f.service.file(path), /excluded/);
    for (const path of ["binary.bin", "invalid-utf8.bin"]) await assert.rejects(f.service.file(path), /Binary|UTF-8/);
    const list = await f.service.files();
    assert.deepEqual(list.files.map((entry) => entry.path), ["binary.bin", "invalid-utf8.bin"]);
  } finally { await f.close(); await outside.close(); }
});

test("custom agent and session roots stay excluded inside a HOME workspace, including aliases and deleted Git paths", async () => {
  const f = await fixture();
  try {
    const protectedRoots = [join(f.root, "custom-agent"), join(f.root, "custom-sessions")];
    const service = new WorkspaceService(f.root, () => protectedRoots);
    await git(f.root, "init", "-b", "boundaries");
    for (const root of protectedRoots) {
      await mkdir(root); await writeFile(join(root, "private.txt"), "private fixture");
    }
    await writeFile(join(f.root, "visible.txt"), "public fixture");
    await git(f.root, "add", "."); await git(f.root, "commit", "-m", "fixture");
    await symlink(protectedRoots[0], join(f.root, "agent-alias"));
    await symlink(join(protectedRoots[1], "private.txt"), join(f.root, "session-alias.txt"));
    for (const path of ["custom-agent/private.txt", "custom-sessions/private.txt", "agent-alias/private.txt", "session-alias.txt"]) {
      await assert.rejects(service.file(path), { code: "excluded_file" });
      await assert.rejects(service.gitDiff(path), { code: "excluded_file" });
    }
    assert.deepEqual((await service.files()).files.map(item => item.path), ["visible.txt"]);
    await rm(join(protectedRoots[0], "private.txt"));
    await writeFile(join(protectedRoots[1], "private.txt"), "changed private fixture");
    await writeFile(join(f.root, "visible.txt"), "changed public fixture");
    const status = await service.gitStatus();
    assert.deepEqual(status.files.map(item => item.path), ["visible.txt"]);
    await assert.rejects(service.gitDiff("custom-agent/private.txt"), { code: "excluded_file" });
    // A session root registered after construction is immediately protected too.
    await mkdir(join(f.root, "later")); await writeFile(join(f.root, "later", "history.jsonl"), "history");
    protectedRoots.push(join(f.root, "later"));
    await assert.rejects(service.file("later/history.jsonl"), { code: "excluded_file" });
  } finally { await f.close(); }
});

test("file lists and previews have explicit limits without corrupting a UTF-8 boundary", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, "many"));
    await Promise.all(Array.from({ length: 503 }, (_, i) => writeFile(join(f.root, "many", `${i}.txt`), "x")));
    const list = await f.service.files();
    assert.equal(list.files.length, 500);
    assert.equal(list.truncated, true);
    const full = "a".repeat(256 * 1024 - 1) + "你好";
    await writeFile(join(f.root, "huge.txt"), full);
    const preview = await f.service.file("huge.txt");
    assert.equal(preview.bytes, Buffer.byteLength(full));
    assert.equal(preview.truncated, true);
    assert.equal(preview.text, "a".repeat(256 * 1024 - 1));
    assert.ok(Buffer.byteLength(preview.text) <= 256 * 1024);
  } finally { await f.close(); }
});

test("Git views include staged, unstaged, deleted, renamed and literal untracked paths without mutation", async () => {
  const f = await fixture();
  try {
    await git(f.root, "init", "-b", "workbench");
    for (const name of ["tracked.txt", "staged.txt", "old name.txt", "deleted.txt"]) await writeFile(join(f.root, name), `${name} before\n`);
    await git(f.root, "add", ".");
    await git(f.root, "commit", "-m", "fixture");
    await writeFile(join(f.root, "tracked.txt"), "tracked after\n");
    await writeFile(join(f.root, "staged.txt"), "staged after\n");
    await git(f.root, "add", "staged.txt");
    await rename(join(f.root, "old name.txt"), join(f.root, "new name.txt"));
    await git(f.root, "add", "old name.txt", "new name.txt");
    await rm(join(f.root, "deleted.txt"));
    await writeFile(join(f.root, "[untracked] $(touch marker).txt"), "literal path\n");
    await writeFile(join(f.root, ".env"), "SECRET=do not expose");
    const index = await readFile(join(f.root, ".git", "index"));
    const indexTime = (await stat(join(f.root, ".git", "index"))).mtimeMs;
    const result = await f.service.gitStatus();
    assert.equal(result.isRepository, true);
    assert.equal(result.branch, "workbench");
    assert.equal(result.truncated, false);
    const statuses = new Map(result.files.map((file) => [file.path, file]));
    assert.equal(statuses.get("tracked.txt")?.unstaged, true);
    assert.equal(statuses.get("tracked.txt")?.staged, false);
    assert.equal(statuses.get("staged.txt")?.staged, true);
    assert.equal(statuses.get("staged.txt")?.unstaged, false);
    assert.equal(statuses.get("new name.txt")?.originalPath, "old name.txt");
    assert.equal(statuses.get("deleted.txt")?.status, "D");
    assert.equal(statuses.get("[untracked] $(touch marker).txt")?.status, "??");
    assert.equal(statuses.has(".env"), false);
    assert.match((await f.service.gitDiff("tracked.txt")).text, /\+tracked after/);
    assert.match((await f.service.gitDiff("staged.txt")).text, /\+staged after/);
    assert.match((await f.service.gitDiff("deleted.txt")).text, /deleted file mode/);
    assert.match((await f.service.gitDiff("new name.txt")).text, /rename from old name.txt/);
    assert.match((await f.service.gitDiff("[untracked] $(touch marker).txt")).text, /\+literal path/);
    assert.deepEqual(await readFile(join(f.root, ".git", "index")), index);
    assert.equal((await stat(join(f.root, ".git", "index"))).mtimeMs, indexTime);
    await assert.rejects(stat(join(f.root, "marker")), { code: "ENOENT" });
    await assert.rejects(f.service.gitDiff(".env"), /excluded/);
  } finally { await f.close(); }
});

test("Git does not inherit a parent repository or caller GIT_DIR and supports an unborn HEAD", async () => {
  const f = await fixture();
  try {
    await git(f.root, "init");
    await mkdir(join(f.root, "child"));
    assert.equal((await new WorkspaceService(join(f.root, "child")).gitStatus()).isRepository, false);
    await assert.rejects(new WorkspaceService(join(f.root, "child")).gitDiff("missing.txt"), /no Git repository/);
    await writeFile(join(f.root, "first.txt"), "first staged\n");
    await git(f.root, "add", "first.txt");
    assert.match((await f.service.gitDiff("first.txt")).text, /\+first staged/);
    await writeFile(join(f.root, "first.txt"), "first unstaged\n");
    const beforeFirstCommit = await f.service.gitDiff("first.txt");
    assert.match(beforeFirstCommit.text, /\+first staged/);
    assert.match(beforeFirstCommit.text, /\+first unstaged/);
    const original = process.env.GIT_DIR;
    process.env.GIT_DIR = join(tmpdir(), "missing-git-directory");
    try { assert.equal((await f.service.gitStatus()).isRepository, true); }
    finally { if (original === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = original; }
  } finally { await f.close(); }
});

test("large Git status and diffs are bounded", async () => {
  const f = await fixture();
  try {
    await git(f.root, "init");
    await mkdir(join(f.root, "many"));
    await Promise.all(Array.from({ length: 503 }, (_, i) => writeFile(join(f.root, "many", `${i}.txt`), "x")));
    const status = await f.service.gitStatus();
    assert.equal(status.files.length, 500);
    assert.equal(status.truncated, true);
    await writeFile(join(f.root, "huge.txt"), "long untracked line\n".repeat(30_000));
    const diff = await f.service.gitDiff("huge.txt");
    assert.ok(Buffer.byteLength(diff.text) <= 256 * 1024);
    assert.equal(diff.truncated, true);
  } finally { await f.close(); }
});

test("Git views disable executable filters, external diff and fsmonitor without changing config", async () => {
  const f = await fixture();
  try {
    await git(f.root, "init");
    await writeFile(join(f.root, ".gitattributes"), "*.txt filter=preview\n");
    await writeFile(join(f.root, "tracked.txt"), "before\n");
    await git(f.root, "add", ".");
    await git(f.root, "commit", "-m", "fixture");
    await git(f.root, "config", "filter.preview.clean", "sh -c 'printf invoked > filter-marker; cat'");
    await git(f.root, "config", "filter.preview.process", "sh -c 'printf invoked > process-marker; cat'");
    await git(f.root, "config", "filter.preview.required", "true");
    await git(f.root, "config", "diff.external", "sh -c 'printf invoked > diff-marker'");
    await git(f.root, "config", "core.fsmonitor", "sh -c 'printf invoked > monitor-marker'");
    const config = await readFile(join(f.root, ".git", "config"));
    await writeFile(join(f.root, "tracked.txt"), "after\n");
    assert.equal((await f.service.gitStatus()).files.some((file) => file.path === "tracked.txt"), true);
    assert.match((await f.service.gitDiff("tracked.txt")).text, /\+after/);
    for (const marker of ["filter-marker", "process-marker", "diff-marker", "monitor-marker"])
      await assert.rejects(stat(join(f.root, marker)), { code: "ENOENT" });
    assert.deepEqual(await readFile(join(f.root, ".git", "config")), config);
  } finally { await f.close(); }
});

test("a project that itself lives below a dot-directory keeps its files; only the protected roots are hidden", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-pane-workspace-"));
  try {
    // Tool-managed checkouts live in places like ~/.codex/worktrees/<id>/<repo>.
    const root = join(base, ".codex", "worktrees", "a1", "repo"); const agent = join(base, "agent");
    await mkdir(join(root, "src"), { recursive: true }); await mkdir(agent);
    await writeFile(join(root, "src", "index.ts"), "export {};\n"); await writeFile(join(root, "README.md"), "# Repo\n");
    const service = new WorkspaceService(root, () => [agent]);
    assert.deepEqual((await service.files()).files.map(item => item.path), ["README.md", "src/index.ts"]);
    assert.equal((await service.file("src/index.ts")).text, "export {};\n");
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("a protected root that has been deleted stays protected under its real location, so Git cannot show what it held", async () => {
  const f = await fixture();
  try {
    // The session directory is configured through a link; its real location is inside the project.
    await mkdir(join(f.root, "real", "custom-sessions"), { recursive: true }); await symlink(join(f.root, "real"), join(f.root, "alias"));
    const service = new WorkspaceService(f.root, () => [join(f.root, "alias", "custom-sessions")]);
    await git(f.root, "init", "-b", "boundaries");
    await writeFile(join(f.root, "real", "custom-sessions", "history.jsonl"), "PRIVATE HISTORY\n"); await writeFile(join(f.root, "visible.txt"), "public\n");
    await git(f.root, "add", "real", "visible.txt"); await git(f.root, "commit", "-m", "fixture");
    await rm(join(f.root, "real", "custom-sessions"), { recursive: true }); await rm(join(f.root, "visible.txt"));
    assert.deepEqual((await service.gitStatus()).files.map(item => item.path).sort(), ["alias", "visible.txt"]);
    await assert.rejects(service.gitDiff("real/custom-sessions/history.jsonl"), { code: "excluded_file" });
    await assert.rejects(service.gitDiff("alias/custom-sessions/history.jsonl"), { code: "excluded_file" });
    assert.match((await service.gitDiff("visible.txt")).text, /-public/);
    // Nothing of the configured path exists any more, not even the link: the nearest real ancestor still anchors it.
    await rm(join(f.root, "alias"));
    await assert.rejects(service.gitDiff("alias/custom-sessions/history.jsonl"), { code: "excluded_file" });
  } finally { await f.close(); }
});
