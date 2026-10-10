import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectRootProblem } from "../src/extension/project-root.js";

test("credential directories and the agent directory cannot be project roots, by real path", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-pane-root-")));
  try {
    const agent = join(root, "home", ".pi", "agent");
    const sessions = join(root, "sessions-elsewhere");
    for (const path of [agent, join(agent, "sessions", "x"), sessions, join(root, "home", ".ssh"), join(root, "home", ".AWS", "sso"), join(root, "home", "code", "build", "app"), join(root, "home", "code", "ok")])
      await mkdir(path, { recursive: true });
    const guarded = [agent, sessions];
    assert.equal(await projectRootProblem(join(root, "home", ".ssh"), guarded), "credential_directory");
    assert.equal(await projectRootProblem(join(root, "home", ".AWS", "sso"), guarded), "credential_directory");
    assert.equal(await projectRootProblem(agent, guarded), "credential_directory"); // its path contains .pi
    assert.equal(await projectRootProblem(sessions, guarded), "agent_directory");
    assert.equal(await projectRootProblem(join(sessions, "nested"), guarded), "agent_directory");
    // Noise-only exclusions (build, dist, node_modules) are ordinary project locations.
    assert.equal(await projectRootProblem(join(root, "home", "code", "build", "app"), guarded), undefined);
    assert.equal(await projectRootProblem(join(root, "home", "code", "ok"), guarded), undefined);
    // The home directory contains credential directories but is not inside one.
    assert.equal(await projectRootProblem(join(root, "home"), guarded), undefined);
    // A symlink alias is judged by where it leads: callers pass the real path.
    await symlink(join(root, "home", ".ssh"), join(root, "home", "code", "alias"));
    assert.equal(await projectRootProblem(await realpath(join(root, "home", "code", "alias")), guarded), "credential_directory");
    // A guarded directory given through a symlink is still recognised.
    await symlink(sessions, join(root, "sessions-link"));
    assert.equal(await projectRootProblem(sessions, [join(root, "sessions-link")]), "agent_directory");
  } finally { await rm(root, { recursive: true, force: true }); }
});
