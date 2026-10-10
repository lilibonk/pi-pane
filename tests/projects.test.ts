import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { ProjectService } from "../src/extension/projects.js";

async function fixture(run: (service: ProjectService, root: string, agentDir: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-pane-projects-"))); const agentDir = join(root, "home", ".pi", "agent"); const sessions = join(root, "sessions");
  await mkdir(agentDir, { recursive: true }); await mkdir(sessions);
  try { await run(new ProjectService({ agentDir, protectedDirectories: () => [agentDir, sessions], home: join(root, "home") }), root, agentDir); }
  finally { await rm(root, { recursive: true, force: true }); }
}
test("directory listing names subdirectories only, follows directory links and never lists files", async () => fixture(async (service, root) => {
  const base = join(root, "work"); await mkdir(join(base, "beta"), { recursive: true }); await mkdir(join(base, "Alpha 项目")); await mkdir(join(base, ".hidden"));
  await writeFile(join(base, "secret.txt"), "TOP_SECRET"); await symlink(join(base, "beta"), join(base, "link-to-beta")); await symlink(join(base, "secret.txt"), join(base, "link-to-file")); await symlink(join(base, "missing"), join(base, "broken"));
  const view = await service.directories(base);
  assert.equal(view.path, base); assert.equal(view.parent, root); assert.equal(view.writable, true); assert.equal(view.truncated, false);
  assert.deepEqual(view.entries, [{ name: "Alpha 项目", hidden: false }, { name: "beta", hidden: false }, { name: "link-to-beta", hidden: false }, { name: ".hidden", hidden: true }]);
  assert(!JSON.stringify(view).includes("secret") && !JSON.stringify(view).includes("TOP_SECRET"));
  // A symlinked directory is reported at its real location.
  assert.equal((await service.directories(join(base, "link-to-beta"))).path, join(base, "beta"));
  assert.equal((await service.directories("/")).parent, undefined);
}));
test("listing reports missing, non-directory, relative and unreadable paths without leaking contents", async () => fixture(async (service, root) => {
  await writeFile(join(root, "file.txt"), "x"); await mkdir(join(root, "locked", "inner"), { recursive: true });
  await assert.rejects(service.directories(join(root, "nope")), { code: "not_found" });
  await assert.rejects(service.directories(join(root, "file.txt")), { code: "not_directory" });
  await assert.rejects(service.directories("relative/path"), { code: "invalid_path" });
  await assert.rejects(service.directories(`${root}\0/x`), { code: "invalid_path" });
  if (process.getuid?.() !== 0) {
    await chmod(join(root, "locked"), 0o000);
    try { await assert.rejects(service.directories(join(root, "locked")), { code: "permission_denied" }); await assert.rejects(service.root(join(root, "locked")), { code: "permission_denied" }); }
    finally { await chmod(join(root, "locked"), 0o700); }
  }
}));
test("large directories are bounded", async () => fixture(async (service, root) => {
  const base = join(root, "many"); await mkdir(base);
  await Promise.all(Array.from({ length: 520 }, (_, index) => mkdir(join(base, `d${String(index).padStart(4, "0")}`))));
  const view = await service.directories(base); assert.equal(view.entries.length, 500); assert.equal(view.truncated, true); assert.equal(view.entries[0]!.name, "d0000");
}));
test("credential and agent directories are neither listed nor accepted as project roots, including through links", async () => fixture(async (service, root, agentDir) => {
  const ssh = join(root, "home", ".ssh"); await mkdir(join(ssh, "keys"), { recursive: true }); await mkdir(join(agentDir, "pi-pane"), { recursive: true });
  await symlink(ssh, join(root, "innocent")); await symlink(agentDir, join(root, "agent-alias")); await mkdir(join(root, "project", "build"), { recursive: true });
  for (const [path, reason] of [[ssh, "credential_directory"], [join(ssh, "keys"), "credential_directory"], [join(root, "innocent"), "credential_directory"],
    [agentDir, "credential_directory"], [join(root, "agent-alias"), "credential_directory"], [join(root, "sessions"), "agent_directory"]] as const) {
    const view = await service.directories(path); assert.equal(view.refused, reason, path); assert.deepEqual(view.entries, []); assert.equal(view.writable, false);
    await assert.rejects(service.root(path), { code: "project_root_refused" });
  }
  // Names excluded from file previews only to reduce noise are ordinary project roots.
  assert.equal(await service.root(join(root, "project", "build")), join(root, "project", "build"));
  await assert.rejects(service.create(join(root, "project"), ".aws"), { code: "project_root_refused" });
  await assert.rejects(service.create(join(root, "sessions"), "inside"), { code: "project_root_refused" });
}));
test("creation is exclusive, takes one literal folder name and never goes through a shell", async () => fixture(async (service, root) => {
  const parent = join(root, "work"); await mkdir(parent);
  for (const name of ["中文 项目", "it's \"quoted\"", "$(touch pwned); `id` && rm -rf x", "a\\b", " leading", "-rf"]) {
    const created = await service.create(parent, name); assert.equal(created, join(parent, name)); assert.deepEqual(await readdir(created), []);
  }
  assert.deepEqual((await readdir(parent)).sort(), [" leading", "$(touch pwned); `id` && rm -rf x", "-rf", "a\\b", "it's \"quoted\"", "中文 项目"].sort());
  for (const name of ["", ".", "..", "a/b", "/abs", "x\0y", "é".repeat(200)]) await assert.rejects(service.create(parent, name), { code: "invalid_name" }, JSON.stringify(name));
  await writeFile(join(parent, "中文 项目", "keep.txt"), "user file");
  await assert.rejects(service.create(parent, "中文 项目"), { code: "project_exists" }); assert.deepEqual(await readdir(join(parent, "中文 项目")), ["keep.txt"]);
  await writeFile(join(parent, "plain"), "x"); await assert.rejects(service.create(parent, "plain"), { code: "path_exists" });
  await symlink(join(parent, "missing-target"), join(parent, "dangling")); await assert.rejects(service.create(parent, "dangling"), { code: "path_exists" });
  await assert.rejects(service.create(join(root, "absent"), "x"), { code: "not_found" });
  await assert.rejects(service.create(join(parent, "plain"), "x"), { code: "not_directory" });
  if (process.getuid?.() !== 0) {
    const readonly = join(root, "readonly"); await mkdir(readonly); await chmod(readonly, 0o500);
    try { await assert.rejects(service.create(readonly, "x"), { code: "permission_denied" }); } finally { await chmod(readonly, 0o700); }
  }
}));
test("the trust question exists only for an unrecorded project with trust-gated resources", async () => fixture(async (service, root, agentDir) => {
  const plain = join(root, "plain"), gated = join(root, "gated"), child = join(gated, "packages", "app");
  await mkdir(plain); await mkdir(join(gated, ".pi", "extensions"), { recursive: true }); await writeFile(join(gated, ".pi", "extensions", "x.ts"), "export default () => {};\n");
  await mkdir(join(child, ".pi", "extensions"), { recursive: true }); await writeFile(join(child, ".pi", "extensions", "y.ts"), "export default () => {};\n");
  assert.deepEqual(service.trust(plain), { required: false, choice: "unknown", policy: "ask", ask: false });
  assert.deepEqual(service.trust(gated), { required: true, choice: "unknown", policy: "ask", ask: true });
  service.remember(gated);
  assert.deepEqual(service.trust(gated), { required: true, choice: "trusted", policy: "ask", ask: false });
  assert.equal(new ProjectTrustStore(agentDir).get(gated), true);
  // pi's own rule: a recorded parent decision is inherited; this service never records one for a parent itself.
  assert.equal(service.trust(child).choice, "trusted"); assert.equal(new ProjectTrustStore(agentDir).getEntry(child)?.path, gated);
  new ProjectTrustStore(agentDir).set(gated, false);
  assert.deepEqual(service.trust(gated), { required: true, choice: "untrusted", policy: "ask", ask: false });
  new ProjectTrustStore(agentDir).set(gated, null);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never" }));
  assert.deepEqual(service.trust(gated), { required: true, choice: "unknown", policy: "never", ask: false });
}));
