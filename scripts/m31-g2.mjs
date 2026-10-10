#!/usr/bin/env node
/** M3.1 gate G2: project trust, launch arguments and planned-stop behaviour of the public RPC child. */
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { baseArgs, makeRoot, project, reporter, rpcChild, sleep, waitFor } from "./m31-lib.mjs";

const out = resolve(process.env.PI_M31_REPORT_DIR || join(project, "build-artifacts/m3.1/gates"));
await mkdir(out, { recursive: true });
const { report, observe } = reporter("G2 trust, launch arguments and lifecycle");
const root = await makeRoot({ projects: ["A", "B", "C"] });
await root.addProjectExtension("B");
await root.addProjectExtension("C");
const children = [];
const start = (cwd, args = [], env = {}) => { const child = rpcChild(root, cwd, [...baseArgs({ discovery: true }), ...args], env); children.push(child); return child; };
const loaded = async (name, child) => (await root.events("m31_project_extension")).some((item) => item.project === name && (!child || item.pid === child.pid));
const pwd = async (child) => (await child.request("bash", { command: "pwd" })).output.trim();
/** A saved session in a project, created by a normal child that was explicitly allowed to load it. */
async function savedSession(name, args = ["--approve"]) {
  const child = start(root.dirs[name], args);
  await child.prompt(`M31_G2_SEED_${name}`);
  const state = await child.request("get_state");
  await child.stop();
  return state.sessionFile;
}

try {
  await observe("G2-T1", "An unknown project with trust-gated resources is not trusted by an RPC child (no UI to ask)", async () => {
    const child = start(root.dirs.B); await child.request("get_state");
    const result = await loaded("B", child); await child.stop();
    return { expected: result === false, projectExtensionLoaded: result };
  });
  await observe("G2-T2", "A decision written through the public ProjectTrustStore is honoured by the next child", async () => {
    new ProjectTrustStore(root.agentDir).set(root.dirs.B, true);
    const child = start(root.dirs.B); await child.request("get_state");
    const result = await loaded("B", child); await child.stop();
    return { expected: result === true, projectExtensionLoaded: result };
  });
  await observe("G2-T3", "A global project_trust extension that answers no overrides the stored yes", async () => {
    const child = start(root.dirs.B, [], { PI_M31_TRUST: "no" }); await child.request("get_state");
    const result = await loaded("B", child);
    const asked = (await root.events("m31_project_trust")).some((item) => item.pid === child.pid);
    await child.stop();
    return { expected: result === false && asked, projectExtensionLoaded: result, globalExtensionAsked: asked };
  });
  await observe("G2-T4", "--approve skips the global project_trust extension entirely", async () => {
    const child = start(root.dirs.B, ["--approve"], { PI_M31_TRUST: "no" }); await child.request("get_state");
    const result = await loaded("B", child);
    const asked = (await root.events("m31_project_trust")).some((item) => item.pid === child.pid);
    await child.stop();
    return { expected: result === true && !asked, projectExtensionLoaded: result, globalExtensionAsked: asked };
  });
  await observe("G2-T5", "--no-approve keeps a stored-trusted project unloaded", async () => {
    const child = start(root.dirs.B, ["--no-approve"]); await child.request("get_state");
    const result = await loaded("B", child); await child.stop();
    return { expected: result === false, projectExtensionLoaded: result };
  });

  let sessionC;
  await observe("G2-T6", "--approve is process-wide: a native switch to another project's session trusts that project too", async () => {
    sessionC = await savedSession("C");
    await root.clearEvents();
    const child = start(root.dirs.B, ["--approve"]); await child.request("get_state");
    const result = await child.request("switch_session", { sessionPath: sessionC });
    const state = await child.request("get_state");
    const leaked = await loaded("C", child);
    const session = (await root.events("m31_session")).filter((item) => item.pid === child.pid).at(-1);
    const toolCwd = await pwd(child);
    await child.stop();
    return { expected: leaked === true, switchCancelled: result.cancelled, otherProjectExtensionLoaded: leaked, sessionSwitched: state.sessionFile === sessionC,
      ctxCwdIsOtherProject: session.ctxCwd === root.dirs.C, processCwdStaysAtLaunchProject: session.processCwd === root.dirs.B, toolCwdIsOtherProject: toolCwd === root.dirs.C };
  });
  await observe("G2-T7", "Without an override, the same native switch does not trust the other unknown project", async () => {
    await root.clearEvents();
    const child = start(root.dirs.B); await child.request("get_state");
    await child.request("switch_session", { sessionPath: sessionC });
    const leaked = await loaded("C", child); await child.stop();
    return { expected: leaked === false, otherProjectExtensionLoaded: leaked };
  });
  await observe("G2-T8", "An extension command can make the child switch project by itself; the host only sees it afterwards", async () => {
    await root.clearEvents();
    const child = start(root.dirs.B, ["--approve"]);
    const before = await child.request("get_state");
    const disposition = await child.prompt(`/m31-switch ${sessionC}`);
    const after = await child.request("get_state");
    const leaked = await loaded("C", child); await child.stop();
    return { expected: after.sessionFile === sessionC && leaked === true, disposition: disposition?.disposition, sessionChanged: before.sessionFile !== after.sessionFile, otherProjectExtensionLoaded: leaked };
  });
  await observe("G2-T9", "RPC get_state exposes neither the runtime cwd nor the trust result", async () => {
    const child = start(root.dirs.B); const state = await child.request("get_state"); await child.stop();
    const keys = Object.keys(state);
    return { expected: !keys.includes("cwd") && !keys.some((key) => /trust/i.test(key)), stateKeys: keys };
  });

  await observe("G2-M1", "CLI --model wins over the model stored in a resumed session; without it the session's model is restored", async () => {
    const first = start(root.dirs.A, ["--provider", "pi-pane-m0", "--model", "deterministic"]);
    await first.request("set_model", { provider: "pi-pane-m0", modelId: "deterministic-thinking" });
    await first.prompt("M31_G2_MODEL");
    const file = (await first.request("get_state")).sessionFile;
    await first.stop();
    const replayed = start(root.dirs.A, ["--provider", "pi-pane-m0", "--model", "deterministic", "--session", file]);
    const withCli = (await replayed.request("get_state")).model?.id; await replayed.stop();
    const plain = start(root.dirs.A, ["--session", file]);
    const withoutCli = (await plain.request("get_state")).model?.id; await plain.stop();
    return { expected: withCli === "deterministic" && withoutCli === "deterministic-thinking", modelWithCliFlag: withCli, modelWithoutCliFlag: withoutCli };
  });

  let sessionA;
  await observe("G2-S1", "Planned stop: end of input runs session_shutdown handlers and exits with code 0", async () => {
    await root.clearEvents();
    const child = start(root.dirs.A); await child.prompt("M31_G2_STOP");
    sessionA = (await child.request("get_state")).sessionFile;
    child.end(); await child.exited;
    const events = (await root.events()).filter((item) => item.pid === child.pid).map((item) => item.event);
    return { expected: child.exitCode === 0 && events.includes("m31_shutdown_end"), exitCode: child.exitCode, stopMs: child.exitedAt - child.endedAt, shutdownHandlerCompleted: events.includes("m31_shutdown_end") };
  });
  await observe("G2-S2", "A slow shutdown handler is awaited by the child: the host decides how long to wait", async () => {
    await root.clearEvents();
    const child = start(root.dirs.A, ["--session", sessionA], { PI_M31_SHUTDOWN_DELAY: "3500" }); await child.request("get_state");
    child.end(); await child.exited;
    const done = (await root.events("m31_shutdown_end")).some((item) => item.pid === child.pid);
    return { expected: child.exitCode === 0 && done && child.exitedAt - child.endedAt >= 3000, exitCode: child.exitCode, stopMs: child.exitedAt - child.endedAt, shutdownHandlerCompleted: done };
  });
  await observe("G2-S3", "Entries appended during shutdown reach the file after input has closed, when nothing can attest them", async () => {
    await root.clearEvents();
    const child = start(root.dirs.A, ["--session", sessionA], { PI_M31_SHUTDOWN_APPEND: "1" }); await child.request("get_state");
    const sizeBefore = (await stat(sessionA)).size;
    child.end(); await child.exited;
    const text = await readFile(sessionA, "utf8");
    const appended = text.trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => entry.customType === "m31-shutdown");
    let lateRequest = "accepted";
    try { child.proc.stdin.write("{}\n"); } catch { lateRequest = "refused"; }
    return { expected: appended.length === 1 && (await stat(sessionA)).size > sizeBefore, appendedEntries: appended.length, appendedEntryType: appended[0]?.type,
      fileGrew: (await stat(sessionA)).size > sizeBefore, childAliveToAttest: child.exitCode === undefined, writeAfterEnd: lateRequest };
  });
  await observe("G2-S4", "A dialog opened during shutdown cannot be answered after input has closed: the child exits 0 with its handler cut short", async () => {
    await root.clearEvents();
    const child = start(root.dirs.A, ["--session", sessionA], { PI_M31_SHUTDOWN_DIALOG: "1" }); await child.request("get_state");
    child.end();
    const request = await waitFor(() => child.records.find((record) => record.type === "extension_ui_request" && record.method === "confirm"), "shutdown dialog request", 5000).catch(() => undefined);
    await Promise.race([child.exited, sleep(6000)]);
    const exitedByItself = child.exitCode !== undefined || child.exitSignal !== undefined;
    if (!exitedByItself) { child.proc.kill("SIGTERM"); await child.exited; }
    const events = (await root.events()).filter((item) => item.pid === child.pid).map((item) => item.event);
    return { expected: !!request && exitedByItself && child.exitCode === 0 && !events.includes("m31_shutdown_dialog_result") && !events.includes("m31_shutdown_end"),
      dialogRequestSeenAfterEnd: !!request, exitedByItself, exitCode: child.exitCode, stopMs: child.exitedAt - child.endedAt,
      dialogEverAnswered: events.includes("m31_shutdown_dialog_result"), shutdownHandlerCompleted: events.includes("m31_shutdown_end") };
  });
  await observe("G2-S5", "A dialog opened during an in-process session replacement can still be answered", async () => {
    await root.clearEvents();
    const child = start(root.dirs.A, ["--session", sessionA], { PI_M31_SHUTDOWN_DIALOG: "1" }); await child.request("get_state");
    const pending = child.request("new_session");
    const request = await waitFor(() => child.records.find((record) => record.type === "extension_ui_request" && record.method === "confirm"), "replacement dialog request", 5000);
    child.send({ type: "extension_ui_response", id: request.id, confirmed: true });
    const result = await pending;
    const answered = (await root.events("m31_shutdown_dialog_result")).find((item) => item.pid === child.pid);
    child.proc.kill("SIGKILL"); await child.exited;
    return { expected: result.cancelled === false && answered?.confirmed === true, replacementCancelled: result.cancelled, dialogAnsweredWith: answered?.confirmed };
  });
  await observe("G2-S6", "An extension can veto an in-process replacement; nothing equivalent exists for a child replacement", async () => {
    const child = start(root.dirs.A, ["--session", sessionA], { PI_M31_VETO_SWITCH: "1" }); await child.request("get_state");
    const result = await child.request("new_session");
    const state = await child.request("get_state"); await child.stop();
    return { expected: result.cancelled === true && state.sessionFile === sessionA, replacementCancelled: result.cancelled, sessionUnchanged: state.sessionFile === sessionA };
  });
} finally {
  for (const child of children) await child.stop(2000).catch(() => {});
  report.finishedAt = new Date().toISOString();
  report.cleanup = { childrenExited: children.every((child) => child.exitCode !== undefined || child.exitSignal !== undefined) };
  await root.remove();
  report.cleanup.temporaryRootRemoved = !existsSync(root.root);
  await writeFile(join(out, "g2.json"), JSON.stringify(report, null, 2));
}
const bad = report.observations.filter((item) => item.status !== "as_expected");
console.log(`G2: ${report.observations.length - bad.length}/${report.observations.length} as expected → ${join(out, "g2.json")}`);
process.exitCode = bad.some((item) => item.status === "error") ? 1 : 0;
