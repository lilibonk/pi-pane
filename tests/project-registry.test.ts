import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ProjectRegistry, ProjectRegistryError } from "../src/extension/project-registry.js";
import { withFileLock } from "../src/extension/file-lock.js";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-pane-registry-")));
  const agentDir = join(root, "agent");
  const dirs: Record<string, string> = {};
  for (const name of ["a", "b", "c"]) { dirs[name] = join(root, "projects", name); await mkdir(dirs[name]!, { recursive: true }); }
  return { root, agentDir, dirs, registry: new ProjectRegistry(agentDir), remove: () => rm(root, { recursive: true, force: true }) };
}

test("an empty project persists without any session, and a symlink alias is the same project", async () => {
  const { root, dirs, registry, agentDir, remove } = await fixture();
  try {
    assert.deepEqual(await registry.list(), []);
    const first = await registry.open(dirs.a!, "created");
    await symlink(dirs.a!, join(root, "alias"));
    const again = await registry.open(join(root, "alias"));
    assert.equal(again.id, first.id);
    assert.equal(again.source, "created");
    const reopened = await new ProjectRegistry(agentDir).list();
    assert.equal(reopened.length, 1);
    assert.equal(reopened[0]!.path, dirs.a);
    assert.equal(reopened[0]!.lastSession, undefined);
    assert.equal((await stat(registry.path)).mode & 0o777, 0o600);
    const saved = JSON.parse(await readFile(registry.path, "utf8"));
    assert.deepEqual(Object.keys(saved).sort(), ["hidden", "projects", "version"]);
    assert.deepEqual((await readdir(dirname(registry.path))).sort(), ["projects.json"]); // no lock or temporary file left behind
  } finally { await remove(); }
});
test("removing a project hides it from history without touching the directory; reopening brings it back", async () => {
  const { dirs, registry, remove } = await fixture();
  try {
    await registry.open(dirs.a!);
    await writeFile(join(dirs.a!, "keep.txt"), "user file");
    await registry.remove(dirs.a!);
    assert.deepEqual(await registry.view([dirs.a!, dirs.b!]), [{ path: dirs.b, name: "b", source: "history", available: true }]);
    assert.equal(await readFile(join(dirs.a!, "keep.txt"), "utf8"), "user file");
    await registry.open(dirs.a!);
    assert.deepEqual((await registry.view([dirs.a!])).map(item => [item.path, item.source]), [[dirs.a, "opened"]]);
  } finally { await remove(); }
});
test("the view merges history, orders by last use and marks missing directories unavailable", async () => {
  const { root, dirs, registry, remove } = await fixture();
  try {
    await registry.open(dirs.a!);
    await new Promise(done => setTimeout(done, 5));
    const b = await registry.open(dirs.b!);
    await registry.setLastSession(b.id, { id: "s1", file: "/sessions/s1.jsonl" });
    await rm(dirs.a!, { recursive: true });
    const view = await registry.view([dirs.b!, dirs.c!, join(root, "gone")]);
    assert.deepEqual(view.map(item => [item.name, item.source, item.available]), [["b", "opened", true], ["a", "opened", false], ["c", "history", true], ["gone", "history", false]]);
    assert.deepEqual(view[0]!.lastSession, { id: "s1", file: "/sessions/s1.jsonl" });
    await registry.forgetSession("/sessions/s1.jsonl");
    assert.equal((await registry.list()).find(item => item.id === b.id)!.lastSession, undefined);
    await assert.rejects(registry.setLastSession("missing", undefined), (error: ProjectRegistryError) => error.code === "unknown_project");
  } finally { await remove(); }
});
test("a corrupt or newer registry is reported and never replaced", async () => {
  const { dirs, registry, remove } = await fixture();
  try {
    await mkdir(dirname(registry.path), { recursive: true });
    for (const [content, code] of [["{ not json", "registry_corrupt"], [JSON.stringify({ version: 2, projects: [] }), "registry_newer"], [JSON.stringify({ version: 1, projects: "x" }), "registry_corrupt"]] as const) {
      await writeFile(registry.path, content);
      await assert.rejects(registry.list(), (error: ProjectRegistryError) => error.code === code);
      await assert.rejects(registry.open(dirs.a!), (error: ProjectRegistryError) => error.code === code);
      assert.equal(await readFile(registry.path, "utf8"), content);
    }
  } finally { await remove(); }
});
test("concurrent hosts adding different projects lose no entry", async () => {
  const { agentDir, dirs, remove } = await fixture();
  try {
    const hosts = [new ProjectRegistry(agentDir), new ProjectRegistry(agentDir), new ProjectRegistry(agentDir)];
    await Promise.all(["a", "b", "c"].flatMap((name, index) => [hosts[index]!.open(dirs[name]!), hosts[(index + 1) % 3]!.open(dirs[name]!)]));
    assert.deepEqual((await hosts[0]!.list()).map(item => item.name).sort(), ["a", "b", "c"]);
  } finally { await remove(); }
});
test("the file lock reclaims a dead holder and times out on a live one", async () => {
  const { root, remove } = await fixture();
  try {
    const target = join(root, "data.json");
    await writeFile(`${target}.lock`, JSON.stringify({ pid: 2_147_483_646, created: Date.now() }));
    assert.equal(await withFileLock(target, async () => "ran"), "ran");
    await writeFile(`${target}.lock`, JSON.stringify({ pid: process.pid, created: Date.now() }));
    await assert.rejects(withFileLock(target, async () => "ran", { timeoutMs: 80 }), (error: NodeJS.ErrnoException) => error.code === "file_locked");
  } finally { await remove(); }
});
