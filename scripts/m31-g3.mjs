#!/usr/bin/env node
/** M3.1 gate G3: host-side authentication through the public ModelRuntime, and applying it to the RPC child. */
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { baseArgs, makeRoot, project, reporter, rpcChild, waitFor } from "./m31-lib.mjs";

const out = resolve(process.env.PI_M31_REPORT_DIR || join(project, "build-artifacts/m3.1/gates"));
await mkdir(out, { recursive: true });
const { report, observe } = reporter("G3 authentication through public interfaces");
const root = await makeRoot({ projects: ["A"] });
const authPath = join(root.agentDir, "auth.json");
const children = [];
const start = (args = [], env = {}) => { const child = rpcChild(root, root.dirs.A, [...baseArgs(), ...args], env); children.push(child); return child; };
const SENTINEL = "sk-m31-SENTINEL-not-a-real-key-0123456789";
const PROVIDER = "openai";
const providerModels = async (child, provider = PROVIDER) => (await child.request("get_available_models")).models.filter((model) => model.provider === provider).length;
/** The only way secrets reach the official login: a caller-supplied interaction. */
function interaction(answers, seen = []) {
  const controller = new AbortController();
  return { controller, seen, value: { signal: controller.signal,
    prompt: async (prompt) => { seen.push({ kind: "prompt", type: prompt.type }); const answer = answers.shift(); if (answer === undefined) throw new Error("No scripted answer"); return answer; },
    notify: (event) => { seen.push({ kind: "notify", type: event.type }); } } };
}
/** pi stores api keys as config values: a leading ! is a command, $NAME is interpolated; $$ and $! are its escapes. */
const literalKey = (key) => { const escaped = key.replaceAll("$", "$$$$"); return escaped.startsWith("!") ? `$${escaped}` : escaped; };
/** A host-side runtime that holds no session and loads no extensions or project model configuration. */
const hostRuntime = () => ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });

try {
  let child, savedSession;
  await observe("G3-A1", "Before login the RPC child offers no models of the unauthenticated built-in provider", async () => {
    child = start();
    const count = await providerModels(child);
    return { expected: count === 0, provider: PROVIDER, modelsBeforeLogin: count };
  });
  await observe("G3-A2", "Host login through ModelRuntime stores the key in the official file without a session or extensions", async () => {
    await writeFile(authPath, JSON.stringify({ "other-provider": { type: "api_key", key: "other-untouched" } }), { mode: 0o600 });
    const before = (await root.events()).length;
    const runtime = await hostRuntime();
    const script = interaction([SENTINEL]);
    const credential = await runtime.login(PROVIDER, "api_key", script.value);
    const stored = JSON.parse(await readFile(authPath, "utf8"));
    const mode = (await stat(authPath)).mode & 0o777;
    const after = (await root.events()).length;
    const listed = await runtime.listCredentials();
    return { expected: stored[PROVIDER]?.key === SENTINEL && stored["other-provider"]?.key === "other-untouched" && mode === 0o600 && after === before,
      credentialType: credential.type, storedForProvider: stored[PROVIDER]?.key === SENTINEL, otherProviderPreserved: stored["other-provider"]?.key === "other-untouched",
      fileMode: mode.toString(8), interactionSteps: script.seen, extensionEventsDuringLogin: after - before,
      listCredentialsExposesSecret: JSON.stringify(listed).includes(SENTINEL), listed: listed.map((item) => ({ ...item })) };
  });
  await observe("G3-B1", "The running child's model list does not pick the new credential up by itself", async () => {
    const count = await providerModels(child);
    return { modelsAfterLoginWithoutApply: count, pickedUpWithoutApply: count > 0 };
  });
  await observe("G3-B2", "In-process apply on an unsaved session: native new_session rebuilds the model runtime", async () => {
    const before = await child.request("get_state");
    const result = await child.request("new_session");
    const count = await providerModels(child);
    const after = await child.request("get_state");
    return { expected: result.cancelled === false && count > 0, cancelled: result.cancelled, modelsAfterApply: count,
      samePid: true, sessionIdChanged: before.sessionId !== after.sessionId, modelKept: before.model?.id === after.model?.id };
  });
  await observe("G3-B3", "In-process apply on a saved session: native switch_session to the same file keeps history, model and ID", async () => {
    await child.request("set_model", { provider: "pi-pane-m0", modelId: "deterministic-thinking" });
    await child.prompt("M31_G3_SAVED");
    const before = await child.request("get_state");
    savedSession = before.sessionFile;
    const runtime = await hostRuntime();
    await runtime.logout(PROVIDER);
    const stale = await providerModels(child);
    const removed = await child.request("switch_session", { sessionPath: savedSession });
    const afterLogout = await providerModels(child);
    await (await hostRuntime()).login(PROVIDER, "api_key", interaction([SENTINEL]).value);
    const applied = await child.request("switch_session", { sessionPath: savedSession });
    const after = await child.request("get_state");
    const count = await providerModels(child);
    const messages = (await child.request("get_messages")).messages.length;
    return { expected: stale > 0 && afterLogout === 0 && count > 0 && after.sessionId === before.sessionId && after.model?.id === before.model?.id && messages >= 2,
      staleAfterLogoutWithoutApply: stale, modelsAfterLogoutApply: afterLogout, logoutApplyCancelled: removed.cancelled, loginApplyCancelled: applied.cancelled,
      modelsAfterLoginApply: count, sameSessionId: after.sessionId === before.sessionId, sameModel: after.model?.id === before.model?.id, messagesKept: messages };
  });
  await observe("G3-B4", "An extension veto leaves the old runtime usable and the credential saved but not applied", async () => {
    await child.stop();
    await (await hostRuntime()).logout(PROVIDER);
    const vetoing = start(["--session", savedSession], { PI_M31_VETO_SWITCH: "1" });
    await vetoing.request("get_state");
    await (await hostRuntime()).login(PROVIDER, "api_key", interaction([SENTINEL]).value);
    const result = await vetoing.request("switch_session", { sessionPath: savedSession });
    const count = await providerModels(vetoing);
    await vetoing.prompt("M31_G3_AFTER_VETO");
    const stored = JSON.parse(await readFile(authPath, "utf8"));
    await vetoing.stop();
    return { expected: result.cancelled === true && count === 0 && stored[PROVIDER]?.key === SENTINEL, applyCancelled: result.cancelled, modelsStillStale: count === 0,
      credentialStillSaved: stored[PROVIDER]?.key === SENTINEL, oldRuntimeStillAnswers: true };
  });
  await observe("G3-B5", "Fallback apply by replacing the child also works and restores the session", async () => {
    const replaced = start(["--session", savedSession]);
    const count = await providerModels(replaced);
    const state = await replaced.request("get_state");
    await replaced.stop();
    return { expected: count > 0, modelsAfterRestart: count, modelRestored: state.model?.id };
  });

  await observe("G3-C1", "Hazard: a raw key starting with ! handed to the official login is executed as a host command", async () => {
    const marker = join(root.root, "pwned-raw");
    await (await hostRuntime()).login(PROVIDER, "api_key", interaction([`!touch ${marker}`]).value);
    const probe = start(); await providerModels(probe); await probe.stop();
    return { expected: existsSync(marker), commandExecuted: existsSync(marker) };
  });
  await observe("G3-C1b", "Escaping $ as $$ and a leading ! as $! makes every key resolve to the literal the user typed", async () => {
    const marker = join(root.root, "pwned-escaped");
    const results = {};
    for (const [name, key] of [["bang", `!touch ${marker}`], ["dollarName", "$HOME"], ["dollarBrace", "a${PATH}b"], ["doubleDollar", "x$$y"], ["dollarBang", "x$!y"],
      ["quote", `a"b'c\\d`], ["newline", "line1\nline2"], ["plain", SENTINEL]]) {
      const runtime = await hostRuntime();
      await runtime.login(PROVIDER, "api_key", interaction([literalKey(key)]).value);
      const resolved = (await (await hostRuntime()).getAuth(PROVIDER))?.auth?.apiKey;
      const probe = start(); const count = await providerModels(probe); await probe.stop();
      results[name] = { resolvesToLiteral: resolved === key, childListsModels: count > 0 };
    }
    const executed = existsSync(marker);
    return { expected: !executed && Object.values(results).every((item) => item.resolvesToLiteral && item.childListsModels), commandExecuted: executed, results };
  });
  await observe("G3-C2", "Cancelling before the answer leaves the stored credential unchanged", async () => {
    await (await hostRuntime()).login(PROVIDER, "api_key", interaction([SENTINEL]).value);
    const runtime = await hostRuntime();
    const controller = new AbortController();
    let error;
    const pending = runtime.login(PROVIDER, "api_key", { signal: controller.signal, notify() {},
      prompt: () => new Promise((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("cancelled by test")))) });
    controller.abort();
    try { await pending; } catch (caught) { error = caught.message; }
    const stored = JSON.parse(await readFile(authPath, "utf8"))[PROVIDER]?.key;
    return { expected: !!error && stored === SENTINEL, rejected: !!error, storedUnchanged: stored === SENTINEL };
  });
  await observe("G3-C3", "Logout removes only the stored credential of that provider", async () => {
    await writeFile(authPath, JSON.stringify({ [PROVIDER]: { type: "api_key", key: SENTINEL }, "other-provider": { type: "api_key", key: "other-untouched" } }), { mode: 0o600 });
    await (await hostRuntime()).logout(PROVIDER);
    const stored = JSON.parse(await readFile(authPath, "utf8"));
    return { expected: stored[PROVIDER] === undefined && stored["other-provider"]?.key === "other-untouched", providerRemoved: stored[PROVIDER] === undefined, otherProviderPreserved: stored["other-provider"]?.key === "other-untouched" };
  });
  await observe("G3-D1", "The sentinel key never appears in child output, stderr or fixture events", async () => {
    const haystack = JSON.stringify(children.map((item) => [item.records, item.stderr])) + JSON.stringify(await root.events());
    return { expected: !haystack.includes(SENTINEL), sentinelLeaked: haystack.includes(SENTINEL), bytesScanned: haystack.length };
  });
  await observe("G3-E1", "Which built-in providers advertise which login types (metadata only, nothing resolved)", async () => {
    const runtime = await hostRuntime();
    const ids = ["openai", "anthropic", "google", "qwen-token-plan-individual", "kimi-coding", "openai-codex"];
    const table = {};
    for (const id of ids) {
      const provider = runtime.getProvider?.(id);
      table[id] = provider ? { name: provider.name, apiKey: !!provider.auth?.apiKey, oauth: !!provider.auth?.oauth, status: runtime.getProviderAuthStatus(id) } : "not found";
    }
    return { table };
  });
} finally {
  for (const child of children) await child.stop(2000).catch(() => {});
  report.finishedAt = new Date().toISOString();
  report.notCovered = ["device/callback/manual OAuth flows with a synthetic authorization server", "owner-lease directed delivery (pi-pane code, not yet written)", "real provider trial"];
  report.cleanup = { childrenExited: children.every((child) => child.exitCode !== undefined || child.exitSignal !== undefined) };
  await root.remove();
  report.cleanup.temporaryRootRemoved = !existsSync(root.root);
  await writeFile(join(out, "g3.json"), JSON.stringify(report, null, 2));
}
const bad = report.observations.filter((item) => item.status !== "as_expected");
console.log(`G3: ${report.observations.length - bad.length}/${report.observations.length} as expected → ${join(out, "g3.json")}`);
process.exitCode = bad.some((item) => item.status === "error") ? 1 : 0;
void waitFor;
