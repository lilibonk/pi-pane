/** Isolated real pi host with synthetic resources for workbench verification. */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { startFixture } from "./m0-smoke.mjs";

const execute = promisify(execFile);
export async function startWorkbenchFixture() {
  const fixture = await startFixture({
    loadSkills: true,
    loadPromptTemplates: true,
    extraExtensions: ["tests/fixtures/workbench.ts"],
    async prepareAgentDir(agentDir) {
      const skillDir = join(agentDir, "skills", "m3-reference");
      const promptDir = join(agentDir, "prompts");
      await mkdir(skillDir, { recursive: true });
      await mkdir(promptDir, { recursive: true });
      await writeFile(join(skillDir, "SKILL.md"), "---\nname: m3-reference\ndescription: A local fixture for testing explicit Web skill expansion.\n---\n\nM3_SKILL_EXPANDED\nUse only this synthetic fixture context.\n");
      await writeFile(join(promptDir, "m3-template.md"), "---\ndescription: A local fixture for testing explicit Web template expansion.\n---\nM3_TEMPLATE_EXPANDED:$ARGUMENTS\n");
    },
  });
  try {
    const gitEnv = { ...fixture.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    for (const key of Object.keys(gitEnv)) if (key.startsWith("GIT_") && !["GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL"].includes(key)) delete gitEnv[key];
    const git = args => execute("git", ["-c", "core.hooksPath=/dev/null", "-c", "init.templateDir=", ...args], { cwd: fixture.cwd, env: gitEnv });
    await mkdir(join(fixture.cwd, "src"));
    await writeFile(join(fixture.cwd, "README.md"), "# Web workbench fixture\n\nA synthetic workspace for session, context and Git verification.\n");
    await writeFile(join(fixture.cwd, "src", "greet.ts"), 'export const greet = (name: string) => `Hello, ${name}`;\n');
    await git(["init", "-q"]);
    await git(["add", "."]);
    await git(["-c", "user.name=M3 Fixture", "-c", "user.email=m3-fixture@example.invalid", "commit", "-qm", "Synthetic baseline"]);
    await writeFile(join(fixture.cwd, "src", "greet.ts"), 'export const greet = (name: string) => `Welcome, ${name}`;\n');
    await writeFile(join(fixture.cwd, "notes with spaces.md"), "# Fixture note\n\nExplicit file context can be read from the browser.\n");
    const foreignCwd = join(fixture.directory, "alternate-workspace");
    await mkdir(foreignCwd);
    await writeFile(join(foreignCwd, "alternate.txt"), "M3_FOREIGN_WORKSPACE_ONLY\n");
    const foreign = SessionManager.create(foreignCwd, join(fixture.agentDir, "sessions", "m3-alternate-workspace"));
    foreign.appendMessage({ role: "user", content: [{ type: "text", text: "M3_FOREIGN_HISTORY" }], timestamp: Date.now() });
    foreign.appendMessage({ role: "assistant", content: [{ type: "text", text: "M3_FOREIGN_REPLY" }], api: "pi-pane-m0-api", provider: "pi-pane-m0", model: "deterministic", timestamp: Date.now(), stopReason: "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    foreign.appendSessionInfo("另一工作区");
    fixture.foreignWorkspace = foreignCwd;
    fixture.foreignSessionId = foreign.getSessionId();
    return fixture;
  } catch (error) { await fixture.close(); await fixture.remove(); throw error; }
}
