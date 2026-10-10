#!/usr/bin/env node
/** M3.1 gate G1: a new project and its not-yet-persisted session, through the public CLI/RPC only. */
import { existsSync } from "node:fs";
import { mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { SessionFileLock } from "../src/extension/session-lock.ts";
import { baseArgs, makeRoot, project, reporter, rpcChild, sessionHeader } from "./m31-lib.mjs";

const out = resolve(process.env.PI_M31_REPORT_DIR || join(project, "build-artifacts/m3.1/gates"));
await mkdir(out, { recursive: true });
const { report, observe } = reporter("G1 new project and unsaved session");
const root = await makeRoot({ projects: ["A", "B", "B2", "D"] });
const children = [];
const start = (cwd, args = [], env = {}) => { const child = rpcChild(root, cwd, [...baseArgs(), ...args], env); children.push(child); return child; };
const pwd = async (child) => (await child.request("bash", { command: "pwd" })).output.trim();

try {
  let candidateA;
  await observe("G1-A1", "Candidate A: no --session in a fresh project yields a preallocated, unwritten path in pi's own session directory", async () => {
    const child = start(root.dirs.B);
    const state = await child.request("get_state");
    const directory = dirname(state.sessionFile);
    candidateA = { child, state };
    return { expected: !!state.sessionFile && !existsSync(state.sessionFile) && directory.startsWith(join(root.agentDir, "sessions")),
      sessionFile: state.sessionFile.replace(root.root, "<root>"), sessionId: state.sessionId, fileExists: existsSync(state.sessionFile),
      sessionDirExists: existsSync(directory), sessionDirEntries: existsSync(directory) ? await readdir(directory) : null };
  });
  await observe("G1-A2", "Candidate A: the lock can be taken after get_state, and nothing is written before the first message", async () => {
    const { child, state } = candidateA;
    const lock = await SessionFileLock.acquire(state.sessionFile);
    await lock.setWriterPid(child.pid);
    candidateA.lock = lock;
    const afterLock = existsSync(state.sessionFile);
    await child.request("set_model", { provider: "pi-pane-m0", modelId: "deterministic-thinking" });
    await child.request("set_session_name", { name: "g1 unsaved" });
    const actualCwd = await pwd(child);
    const afterMetadata = existsSync(state.sessionFile);
    return { expected: !afterLock && !afterMetadata && actualCwd === root.dirs.B, lockPath: basename(lock.lockPath), fileExistsAfterLock: afterLock,
      fileExistsAfterModelNameAndBash: afterMetadata, toolCwdMatchesTarget: actualCwd === root.dirs.B };
  });
  await observe("G1-A3", "Candidate A: the first real message persists a header with the target cwd and the reported session ID", async () => {
    const { child, state, lock } = candidateA;
    await child.prompt("M31_G1_FIRST");
    const header = await sessionHeader(state.sessionFile);
    const session = (await root.events("m31_session")).find((item) => item.pid === child.pid);
    let ownership = "verified";
    try { await lock.verifyAppends(async () => (await child.request("get_entries", {})).entries); } catch (error) { ownership = String(error.message); }
    return { expected: header.cwd === root.dirs.B && header.id === state.sessionId && ownership === "verified" && session.processCwd === root.dirs.B,
      headerCwdMatchesTarget: header.cwd === root.dirs.B, headerIdMatchesState: header.id === state.sessionId, ownershipCheck: ownership,
      processCwdMatchesTarget: session.processCwd === root.dirs.B, ctxCwdMatchesTarget: session.ctxCwd === root.dirs.B };
  });
  await observe("G1-A4", "Planned stop by end of input exits cleanly, and a standard pi process can reopen the saved session", async () => {
    const { child, state, lock } = candidateA;
    child.end(); await child.exited;
    await lock.release();
    const reopened = start(root.dirs.B, ["--session", state.sessionFile]);
    const messages = (await reopened.request("get_messages")).messages;
    const reopenedState = await reopened.request("get_state");
    await reopened.stop();
    return { expected: child.exitCode === 0 && messages.length >= 2 && reopenedState.sessionId === state.sessionId,
      exitCode: child.exitCode, stopMs: child.exitedAt - child.endedAt, reopenedMessages: messages.length, sameSessionId: reopenedState.sessionId === state.sessionId };
  });

  await observe("G1-B1", "Candidate B: the existing lock cannot reserve a path whose session directory does not exist yet", async () => {
    const path = join(root.agentDir, "sessions", "not-created-yet", `${randomUUID()}.jsonl`);
    let error;
    try { await (await SessionFileLock.acquire(path)).release(); } catch (caught) { error = caught.code ?? caught.message; }
    return { expected: error !== undefined, error: String(error) };
  });
  await observe("G1-B2", "Candidate B: --session <not existing path> starts an unsaved session in the spawn cwd", async () => {
    const directory = join(root.agentDir, "sessions", "preallocated");
    await mkdir(directory, { recursive: true });
    const id = randomUUID();
    const path = join(directory, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
    const lock = await SessionFileLock.acquire(path);
    const child = start(root.dirs.B2, ["--session", path]);
    await lock.setWriterPid(child.pid);
    const state = await child.request("get_state");
    const before = existsSync(path);
    await child.prompt("M31_G1_PREALLOCATED");
    const header = await sessionHeader(path);
    await child.request("new_session");
    const next = await child.request("get_state");
    await child.stop(); await lock.release();
    return { expected: (await realpath(state.sessionFile)) === (await realpath(path)) && !before && header.cwd === root.dirs.B2,
      reportedPathMatches: (await realpath(state.sessionFile)) === (await realpath(path)), fileExistedBeforeFirstMessage: before,
      headerCwdMatchesTarget: header.cwd === root.dirs.B2, sessionIdEqualsFileNameUuid: state.sessionId === id, headerIdEqualsFileNameUuid: header.id === id,
      nextNewSessionDirectory: dirname(next.sessionFile).replace(root.root, "<root>") };
  });

  await observe("G1-C1", "A project sessionDir setting is honoured by candidate A without the host computing it", async () => {
    const custom = join(root.root, "custom-sessions");
    await mkdir(join(root.dirs.D, ".pi"), { recursive: true });
    await writeFile(join(root.dirs.D, ".pi", "settings.json"), JSON.stringify({ sessionDir: custom }));
    const child = start(root.dirs.D);
    const state = await child.request("get_state");
    await child.stop();
    return { expected: dirname(state.sessionFile) === custom, sessionDirectory: dirname(state.sessionFile).replace(root.root, "<root>"), usesProjectSetting: dirname(state.sessionFile) === custom };
  });
  await observe("G1-C2", "With candidate B, a host-chosen path wins over the project sessionDir for the first file", async () => {
    const directory = join(root.agentDir, "sessions", "preallocated");
    const path = join(directory, `2026-01-01T00-00-01-000Z_${randomUUID()}.jsonl`);
    const child = start(root.dirs.D, ["--session", path]);
    const state = await child.request("get_state");
    await child.request("new_session");
    const next = await child.request("get_state");
    await child.stop();
    return { firstFileDirectory: dirname(state.sessionFile).replace(root.root, "<root>"), nextNewSessionDirectory: dirname(next.sessionFile).replace(root.root, "<root>"),
      directoriesDiffer: dirname(state.sessionFile) !== dirname(next.sessionFile) };
  });
} finally {
  for (const child of children) await child.stop(2000).catch(() => {});
  report.finishedAt = new Date().toISOString();
  report.cleanup = { childrenExited: children.every((child) => child.exitCode !== undefined || child.exitSignal !== undefined) };
  await root.remove();
  report.cleanup.temporaryRootRemoved = !existsSync(root.root);
  await writeFile(join(out, "g1.json"), JSON.stringify(report, null, 2));
}
const bad = report.observations.filter((item) => item.status !== "as_expected");
console.log(`G1: ${report.observations.length - bad.length}/${report.observations.length} as expected → ${join(out, "g1.json")}`);
process.exitCode = bad.some((item) => item.status === "error") ? 1 : 0;
