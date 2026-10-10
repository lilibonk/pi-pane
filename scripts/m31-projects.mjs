#!/usr/bin/env node
/**
 * M3.1 project management with a real pi TUI and real RPC children: host directory listing, opening
 * empty and existing directories, creating a project, the trust question, removal and relocation.
 * Temporary HOME/agent directories and the local deterministic provider only.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ProjectTrustStore, SessionManager } from "@earendil-works/pi-coding-agent";
import { startFixture, openClient, commandResult, workbenchQuery, waitFor } from "./m0-smoke.mjs";
import { SessionFileLock } from "../src/extension/session-lock.ts";

const out = resolve(process.env.PI_M31_REPORT_DIR || "build-artifacts/m3.1/projects");
await mkdir(out, { recursive: true });
const report = { startedAt: new Date().toISOString(), scope: "M31-2 project management", realTui: true, realModelCalls: 0,
  isolation: "temporary HOME + agent/session dirs + local deterministic provider", checks: [], status: "running" };
const fixtures = [], clients = [];
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const plain = text => text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
const exists = path => readFile(path).then(() => true, () => false);
const lockOf = async file => JSON.parse(await readFile(`${file}.pi-pane.lock`, "utf8"));
async function check(id, name, fn) {
  const started = Date.now();
  try { const details = await fn(); report.checks.push({ id, name, status: "passed", durationMs: Date.now() - started, ...(details ? { details } : {}) }); console.log(`PASS ${id} ${name}`); }
  catch (error) { report.checks.push({ id, name, status: "failed", durationMs: Date.now() - started, error: String(error.stack ?? error) }); throw error; }
}
let requestNo = 0;
async function hostQuery(client, action, args = {}) {
  const reqId = `q${++requestNo}`; client.send({ t: "host_query", reqId, action, args });
  const frame = await waitFor(() => client.frames.find(item => item.t === "host_result" && item.reqId === reqId), `host_result ${action}`);
  if (frame.error) throw Object.assign(new Error(frame.error.message), { code: frame.error.code });
  return frame.value;
}
async function hostCommand(client, command, args = {}) {
  const state = client.frames.filter(item => item.t === "host_state").at(-1); assert.ok(state, "host state is known");
  const commandNo = client.nextCommandNo++; const id = `${client.clientId}:${commandNo}`;
  client.send({ t: "host_command", clientId: client.clientId, commandNo, id, hostRevision: state.revision, command, args });
  const ack = await waitFor(() => client.frames.find(item => item.t === "ack" && item.id === id), `ack ${command}`);
  if (ack.status !== "dispatched") throw Object.assign(new Error(ack.error?.message ?? "rejected"), { code: ack.error?.code });
  const result = await waitFor(() => client.frames.find(item => item.t === "command_result" && item.id === id), `result ${command}`, 40_000);
  if (result.status !== "completed") throw Object.assign(new Error(result.error?.message ?? "failed"), { code: result.error?.code });
  return result.value;
}
const rejects = (promise, code) => assert.rejects(promise, error => { assert.equal(error.code, code, error.message); return true; });
async function reply(client, text) {
  const operation = await client.command("prompt", { text, mode: "followUp" }); assert.equal(operation.ack.status, "dispatched", operation.ack.error?.message);
  assert.equal((await commandResult(client, operation.frame)).status, "completed");
  await waitFor(() => client.snapshot?.state.idle && client.snapshot.session.messages.some(message => message.role === "assistant" && JSON.stringify(message.content).includes(`M0_REPLY:${text}:`)), `reply to ${text}`, 20_000);
}
async function start(options = {}) {
  const fixture = await startFixture({ extraExtensions: ["tests/fixtures/handoff-fixture.ts", "tests/fixtures/m31-probe.ts"], loadPromptTemplates: true, ...options });
  fixtures.push(fixture);
  const base = await realpath(fixture.directory);
  // A project whose prompt template is a project resource: loading it requires trust.
  const gated = join(base, "gated"); await mkdir(join(gated, ".pi", "prompts"), { recursive: true });
  await writeFile(join(gated, ".pi", "prompts", "m31-gated.md"), "---\ndescription: A project template that must only load when the project is trusted.\n---\nM31_GATED:$ARGUMENTS\n");
  await writeFile(join(gated, "gated.txt"), "M31_GATED_FILE\n");
  const client = await openClient(fixture.url); clients.push(client);
  await waitFor(() => client.snapshot && client.frames.some(item => item.t === "host_state"), "first snapshot and host state");
  // One entry per RPC child process, in start order.
  const children = async () => (await fixture.events()).filter((item, index, all) => item.event === "m31_session" && item.mode === "rpc"
    && all.findIndex(other => other.event === "m31_session" && other.mode === "rpc" && other.pid === item.pid) === index);
  const child = async count => waitFor(async () => { const list = await children(); return list.length >= count && list[count - 1]; }, `RPC child ${count}`);
  const commands = async () => (await workbenchQuery(client, "commands")).commands.filter(command => command.source !== "builtin").map(command => command.name);
  return { fixture, client, base, gated, children, child, commands, home: await realpath(fixture.cwd), first: await child(1), originalId: client.snapshot.session.id };
}

try {
  {
    const { fixture, client, base, gated, children, child, commands, home, first, originalId } = await start();
    const empty = join(base, "空 项目"); await mkdir(empty);
    await writeFile(join(base, "not-a-directory.txt"), "M31_FILE_CONTENT_MUST_NOT_LEAK"); await mkdir(join(base, ".ssh")); await writeFile(join(base, ".ssh", "id_fixture"), "M31_KEY");
    let emptySession;
    await check("P-16", "directory listing shows folder names only and refuses credential and agent directories", async () => {
      const view = await hostQuery(client, "directories", { path: base });
      const names = view.entries.map(entry => entry.name);
      for (const name of ["gated", "空 项目", "workspace", ".ssh", "agent"]) assert.ok(names.includes(name), name);
      assert.ok(!JSON.stringify(view).includes("not-a-directory") && !JSON.stringify(view).includes("MUST_NOT_LEAK"));
      const ssh = await hostQuery(client, "directories", { path: join(base, ".ssh") }); assert.equal(ssh.refused, "credential_directory"); assert.deepEqual(ssh.entries, []);
      assert.equal((await hostQuery(client, "directories", { path: fixture.agentDir })).refused, "agent_directory");
      assert.equal((await hostQuery(client, "directories")).path, home);
      await rejects(hostQuery(client, "directories", { path: join(base, "not-a-directory.txt") }), "not_directory");
      await rejects(hostCommand(client, "project_open", { path: join(base, ".ssh") }), "project_root_refused");
      await rejects(hostCommand(client, "project_open", { path: join(fixture.agentDir, "sessions") }), "project_root_refused");
      assert.equal((await children()).length, 1); assert.equal(client.snapshot.session.id, originalId);
      // Existing workspace previews keep their own boundary.
      await assert.rejects(workbenchQuery(client, "file", { path: "../not-a-directory.txt" }));
    });
    await check("P-01", "an empty directory without any pi history opens as a project with zero sessions and no invented message", async () => {
      assert.deepEqual(await hostCommand(client, "project_open", { path: empty }), { path: empty });
      await waitFor(() => client.snapshot?.session.cwd === empty, "empty project snapshot");
      const second = await child(2);
      assert.equal(await realpath(second.processCwd), empty); assert.equal(await realpath(second.ctxCwd), empty); assert.ok(!second.argv.includes("--session"));
      assert.deepEqual(client.snapshot.session.messages, []); emptySession = second.sessionFile;
      assert.equal(await exists(emptySession), false, "no transcript before the first message");
      assert.equal((await lockOf(emptySession)).writerPid, second.pid, "the unsaved path is already owned");
      const view = await hostQuery(client, "projects");
      assert.deepEqual(view.projects.filter(project => project.current).map(project => [project.path, project.sessions, project.source]), [[empty, 0, "opened"]]);
      assert.ok(view.projects.some(project => project.path === home && !project.current && project.sessions >= 1));
      await waitFor(() => !alive(first.pid), "first child exited");
      return { secondChild: second.pid };
    });
    await check("P-04", "the first real prompt writes the transcript with the project's cwd, and pi can open it natively", async () => {
      await reply(client, "M31_FIRST_IN_EMPTY");
      const header = JSON.parse((await readFile(emptySession, "utf8")).split("\n", 1)[0]);
      assert.equal(header.type, "session"); assert.equal(await realpath(header.cwd), empty);
      const native = SessionManager.open(emptySession); assert.equal(await realpath(native.getCwd()), empty);
      assert.ok(native.getEntries().some(entry => entry.type === "message" && JSON.stringify(entry.message.content).includes("M31_FIRST_IN_EMPTY")));
      assert.equal((await hostQuery(client, "projects")).projects.find(project => project.current).sessions, 1);
    });
    await check("P-02", "creating a project makes one literally named folder; conflicts and bad parents change nothing", async () => {
      const parent = join(base, "parent dir"); await mkdir(parent);
      const name = "新项目 it's \"x\" $(touch pwned) `id`";
      assert.deepEqual(await hostCommand(client, "project_create", { parent, name }), { path: join(parent, name) });
      await waitFor(() => client.snapshot?.session.cwd === join(parent, name), "created project snapshot");
      assert.deepEqual(await readdir(parent), [name]); assert.deepEqual(await readdir(join(parent, name)), []); assert.equal(await exists(join(base, "pwned")), false);
      const third = await child(3); assert.equal(await realpath(third.processCwd), join(parent, name));
      await writeFile(join(parent, name, "mine.txt"), "user file");
      await rejects(hostCommand(client, "project_create", { parent, name }), "project_exists"); assert.equal(await readFile(join(parent, name, "mine.txt"), "utf8"), "user file");
      await rejects(hostCommand(client, "project_create", { parent: join(base, "no such parent"), name: "x" }), "not_found");
      await rejects(hostCommand(client, "project_create", { parent, name: "a\u0000b" }), "invalid_name");
      await rejects(hostCommand(client, "project_create", { parent, name: ".." }), "invalid_name");
      await rejects(hostCommand(client, "project_create", { parent: join(base, ".ssh"), name: "x" }), "project_root_refused");
      assert.equal((await children()).length, 3); await reply(client, "M31_STILL_WORKS");
    });
    await check("P-06", "an unknown project with project resources is asked about; withhold loads nothing, remember loads it, and no child ever gets --approve", async () => {
      const inspection = await hostQuery(client, "project_inspect", { path: gated });
      assert.deepEqual(inspection.trust, { required: true, choice: "unknown", policy: "ask", ask: true });
      const before = client.snapshot.session.cwd;
      await rejects(hostCommand(client, "project_open", { path: gated }), "trust_required");
      assert.equal(client.snapshot.session.cwd, before); assert.equal((await children()).length, 3);
      await hostCommand(client, "project_open", { path: gated, trust: "withhold" });
      await waitFor(() => client.snapshot?.session.cwd === gated, "gated project snapshot");
      const withheld = await child(4); assert.ok(withheld.argv.includes("--no-approve"));
      assert.ok(!(await commands()).includes("m31-gated"), "project template not loaded");
      let trust = (await hostQuery(client, "projects")).current.trust; assert.equal(trust.withheld, true); assert.equal(trust.loaded, 0); assert.equal(trust.ask, true);
      assert.equal(new ProjectTrustStore(fixture.agentDir).get(gated), null, "withhold records nothing");
      assert.match((await workbenchQuery(client, "file", { path: "gated.txt" })).text, /M31_GATED_FILE/, "an untrusted project is still an ordinary workspace");
      const inspectAgain = await hostQuery(client, "project_inspect", { path: gated }); assert.equal(inspectAgain.trust.ask, true, "the next opening asks again");
      await hostCommand(client, "project_open", { path: gated, trust: "remember" });
      const trusted = await child(5); assert.ok(!trusted.argv.includes("--no-approve"));
      await waitFor(async () => client.snapshot?.session.cwd === gated && (await commands().catch(() => [])).includes("m31-gated"), "project template loaded");
      trust = (await hostQuery(client, "projects")).current.trust; assert.deepEqual(trust, { required: true, choice: "trusted", policy: "ask", ask: false, loaded: 1 });
      assert.equal(new ProjectTrustStore(fixture.agentDir).get(gated), true); assert.equal(new ProjectTrustStore(fixture.agentDir).getEntry(gated).path, gated);
      for (const item of await children()) assert.ok(!item.argv.includes("--approve") && !item.argv.includes("-a"), "the host never generates --approve");
    });
    await check("P-05", "going back to the start project restores its session and leaks nothing from the other project", async () => {
      assert.deepEqual(await hostCommand(client, "project_open", { path: home }), { path: home });
      await waitFor(() => client.snapshot?.session.id === originalId, "start project session restored");
      const back = await child(6);
      assert.equal(await realpath(back.processCwd), home); assert.equal(back.sessionFile, first.sessionFile);
      assert.ok(!(await commands()).includes("m31-gated")); await assert.rejects(workbenchQuery(client, "file", { path: "gated.txt" }));
      assert.equal((await hostQuery(client, "projects")).current.trust.required, false);
    });
    await check("P-08", "a saved session restores its own model; new sessions keep the start model; prompts are not replayed", async () => {
      const list = await children();
      const model = argv => argv.includes("--model") ? argv[argv.indexOf("--model") + 1] : undefined;
      assert.equal(model(list[5].argv), undefined, "restoring the saved start session does not replay --model");
      for (const index of [1, 2, 3]) assert.equal(model(list[index].argv), "deterministic", "new sessions take the start model");
      for (const item of list) assert.ok(!item.argv.some(value => /^M0_|^\/web/.test(value)), "no initial prompt in child arguments");
      assert.equal(client.snapshot.state.model?.id, "deterministic");
    });
    await check("P-09", "a project switch is refused while pi is replying, and two viewers cannot both switch from the same state", async () => {
      const slow = await client.command("prompt", { text: "M0_SLOW_M31", mode: "followUp" }); assert.equal(slow.ack.status, "dispatched");
      await waitFor(() => client.snapshot?.state.running, "running reply");
      await rejects(hostCommand(client, "project_open", { path: empty }), "busy");
      await waitFor(() => client.snapshot?.state.idle && !client.snapshot.state.running, "reply settled", 30_000);
      const other = await openClient(fixture.url); clients.push(other); await waitFor(() => other.frames.some(item => item.t === "host_state"), "second viewer");
      const results = await Promise.allSettled([hostCommand(client, "project_open", { path: empty }), hostCommand(other, "project_open", { path: gated })]);
      assert.deepEqual(results.map(result => result.status).sort(), ["fulfilled", "rejected"]);
      assert.equal(results.find(result => result.status === "rejected").reason.code, "stale_host");
      const winner = results[0].status === "fulfilled" ? empty : gated;
      await waitFor(() => client.snapshot?.session.cwd === winner && other.snapshot?.session.cwd === winner, "both viewers follow the one switch");
      assert.equal((await children()).length, 7);
      if (winner !== empty) { await hostCommand(client, "project_open", { path: empty }); await waitFor(() => client.snapshot?.session.cwd === empty, "empty project"); }
      // Opening a project returns to its last saved session.
      assert.ok(client.snapshot.session.messages.some(message => JSON.stringify(message.content).includes("M31_FIRST_IN_EMPTY")));
    });
    await check("P-10", "a project whose last session is owned by another /web host is refused and the current project stays usable", async () => {
      await hostCommand(client, "project_open", { path: home }); await waitFor(() => client.snapshot?.session.id === originalId, "start project");
      const count = (await children()).length;
      const foreignLock = await SessionFileLock.acquire(emptySession);
      try { await rejects(hostCommand(client, "project_open", { path: empty }), "session_locked"); }
      finally { await foreignLock.release(); }
      assert.equal((await children()).length, count); assert.equal(client.snapshot.session.id, originalId); await reply(client, "M31_AFTER_LOCK_REFUSAL");
    });
    await check("P-03", "a symlink opens the real directory once; a moved project is unavailable until the user relocates it", async () => {
      const alias = join(base, "alias-to-empty"); await symlink(empty, alias);
      assert.deepEqual(await hostCommand(client, "project_open", { path: alias }), { path: empty });
      await waitFor(() => client.snapshot?.session.cwd === empty, "alias opens the real project");
      assert.equal((await hostQuery(client, "projects")).projects.filter(project => project.path === empty || project.path === alias).length, 1);
      await hostCommand(client, "project_open", { path: home }); await waitFor(() => client.snapshot?.session.id === originalId, "start project");
      const moved = join(base, "moved 项目"); await rename(empty, moved); await mkdir(join(base, "空 项目 copy"));
      let listed = (await hostQuery(client, "projects")).projects.find(project => project.path === empty); assert.equal(listed.available, false);
      await rejects(hostCommand(client, "project_open", { path: empty }), "not_found"); assert.equal(client.snapshot.session.id, originalId, "no silent fallback to another directory");
      assert.deepEqual(await hostCommand(client, "project_relocate", { from: empty, to: moved }), { path: moved });
      listed = (await hostQuery(client, "projects")).projects; assert.ok(listed.find(project => project.path === moved)?.available); assert.ok(!listed.some(project => project.path === empty));
    });
    await check("P-15", "removing from the list deletes neither the folder nor its sessions, and history does not bring it back", async () => {
      await rejects(hostCommand(client, "project_remove", { path: home }), "project_current");
      assert.deepEqual(await hostCommand(client, "project_remove", { path: gated }), { path: gated });
      assert.ok(!(await hostQuery(client, "projects")).projects.some(project => project.path === gated));
      assert.match(await readFile(join(gated, "gated.txt"), "utf8"), /M31_GATED_FILE/);
      const registry = JSON.parse(await readFile(join(fixture.agentDir, "pi-pane", "projects.json"), "utf8"));
      assert.ok(registry.hidden.includes(gated)); assert.ok(!JSON.stringify(registry).includes("M31_FIRST_IN_EMPTY"), "no conversation text in the project list");
      assert.ok(!/key|token|password/i.test(JSON.stringify(Object.keys(registry.projects[0] ?? {}))));
    });
    await check("P-13", "Ctrl+C after several project switches stops the current child, frees every lock and names the final session", async () => {
      const current = (await children()).at(-1);
      fixture.write("\u0003"); await waitFor(() => fixture.exitCode !== undefined, "Ctrl+C stop", 20_000);
      assert.equal(fixture.exitCode, 0);
      for (const item of await children()) await waitFor(() => !alive(item.pid), `child ${item.pid} exited`);
      assert.ok(plain(fixture.terminal).includes(`pi --session '${first.sessionFile}'`));
      const sessionDir = join(fixture.agentDir, "sessions");
      assert.deepEqual((await readdir(sessionDir, { recursive: true })).filter(name => name.endsWith(".pi-pane.lock")), []);
      const registry = JSON.parse(await readFile(join(fixture.agentDir, "pi-pane", "projects.json"), "utf8"));
      assert.equal(registry.projects.find(project => project.path === home)?.lastSession?.file, first.sessionFile);
      return { children: (await children()).length, last: current.pid };
    });
  }
  {
    const { fixture, client, gated, child, commands } = await start({ envOverrides: { PI_M31_TRUST: "no" }, extraArgs: ["--approve"] });
    await check("P-07", "the start --approve does not trust a later project, and a global policy veto is shown as not loaded rather than trusted-and-loaded", async () => {
      const inspection = await hostQuery(client, "project_inspect", { path: gated }); assert.equal(inspection.trust.ask, true); assert.equal(inspection.trust.override, undefined);
      await hostCommand(client, "project_open", { path: gated, trust: "remember" });
      await waitFor(() => client.snapshot?.session.cwd === gated, "gated project snapshot");
      const second = await child(2); assert.ok(!second.argv.includes("--approve"), "--approve stays with the start project");
      assert.ok((await fixture.events()).some(item => item.event === "m31_project_trust" && item.pid === second.pid), "the global policy extension was consulted");
      assert.ok(!(await commands()).includes("m31-gated"), "the veto wins over the remembered choice");
      const trust = (await hostQuery(client, "projects")).current.trust;
      assert.equal(trust.choice, "trusted"); assert.equal(trust.loaded, 0, "choice and actual loading are reported separately");
      await hostCommand(client, "project_open", { path: await realpath(fixture.cwd) });
      const third = await child(3); assert.ok(third.argv.includes("--approve"), "the start project keeps the flag it was started with");
      assert.equal((await hostQuery(client, "projects")).current.trust.override, "approve");
    });
  }
  report.status = "passed";
} catch (error) { report.status = "failed"; report.error = String(error.stack ?? error); process.exitCode = 1; console.error(error); }
finally {
  for (const client of clients) await client.close().catch(() => {});
  for (const fixture of fixtures) { await fixture.close().catch(() => {}); await fixture.remove().catch(() => {}); }
  report.finishedAt = new Date().toISOString();
  await writeFile(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.status.toUpperCase()} — ${report.checks.filter(item => item.status === "passed").length}/${report.checks.length} checks; report: ${join(out, "report.json")}`);
}
