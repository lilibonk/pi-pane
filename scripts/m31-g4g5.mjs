#!/usr/bin/env node
/** M3.1 gates G4 (settings and themes on disk) and G5 (custom providers, session extras). Public interfaces only. */
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DefaultResourceLoader, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { SessionFileLock } from "../src/extension/session-lock.ts";
import { baseArgs, makeRoot, project, reporter, rpcChild } from "./m31-lib.mjs";

const out = resolve(process.env.PI_M31_REPORT_DIR || join(project, "build-artifacts/m3.1/gates"));
await mkdir(out, { recursive: true });
const g4 = reporter("G4 settings and themes on disk");
const g5 = reporter("G5 custom providers and session extras");
const root = await makeRoot({ projects: ["A", "P"], settings: { theme: "dark", unknownTopLevel: { keep: true }, images: { autoResize: true } } });
const settingsPath = join(root.agentDir, "settings.json");
const modelsPath = join(root.agentDir, "models.json");
const authPath = join(root.agentDir, "auth.json");
const disk = async (path = settingsPath) => JSON.parse(await readFile(path, "utf8"));
const children = [];
const start = (cwd, args = [], env = {}, { discovery = false } = {}) => { const child = rpcChild(root, cwd, [...baseArgs({ discovery }), ...args], env); children.push(child); return child; };
const modelsOf = async (child, provider) => (await child.request("get_available_models")).models.filter((model) => model.provider === provider).map((model) => model.id);
const CUSTOM = "m31-custom";
const customProvider = (extra = {}) => ({ baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "m31-literal-key", models: [{ id: "m31-model-a", contextWindow: 32000 }], ...extra });

try {
  // ---------------------------------------------------------------- G4
  await g4.observe("G4-S1", "A global setter writes only its field to disk; unknown and unrelated fields survive", async () => {
    const manager = SettingsManager.create(root.dirs.A, root.agentDir, { projectTrusted: false });
    manager.setTheme("light"); await manager.flush();
    const errors = manager.drainErrors(); const saved = await disk();
    return { expected: errors.length === 0 && saved.theme === "light" && saved.unknownTopLevel?.keep === true && saved.images?.autoResize === true && saved.defaultModel === "deterministic",
      errors: errors.length, themeOnDisk: saved.theme, unknownFieldKept: saved.unknownTopLevel?.keep === true, nestedFieldKept: saved.images?.autoResize === true };
  });
  await g4.observe("G4-S2", "A field changed by another process after the manager was created is not overwritten", async () => {
    const manager = SettingsManager.create(root.dirs.A, root.agentDir, { projectTrusted: false });
    const external = await disk(); external.quietStartup = false; external.addedByOther = 1; external.theme = "dark";
    await writeFile(settingsPath, JSON.stringify(external));
    manager.setHideThinkingBlock(true); await manager.flush();
    const saved = await disk();
    return { expected: saved.hideThinkingBlock === true && saved.quietStartup === false && saved.addedByOther === 1 && saved.theme === "dark",
      ownFieldWritten: saved.hideThinkingBlock === true, otherProcessFieldsKept: saved.quietStartup === false && saved.addedByOther === 1,
      staleThemeNotWrittenBack: saved.theme === "dark", errors: manager.drainErrors().length };
  });
  await g4.observe("G4-S3", "Same field changed by another process: the later official write wins (no compare-and-set)", async () => {
    const manager = SettingsManager.create(root.dirs.A, root.agentDir, { projectTrusted: false });
    const external = await disk(); external.theme = "external-theme"; await writeFile(settingsPath, JSON.stringify(external));
    manager.setTheme("light"); await manager.flush();
    return { themeOnDisk: (await disk()).theme, externalValueLost: (await disk()).theme !== "external-theme" };
  });
  await g4.observe("G4-S4", "A read-only settings file: flush resolves, the error is only in drainErrors, memory and disk disagree", async () => {
    const before = (await disk()).theme;
    await chmod(settingsPath, 0o400); await chmod(root.agentDir, 0o500);
    const manager = SettingsManager.create(root.dirs.A, root.agentDir, { projectTrusted: false });
    let flushRejected = false;
    manager.setTheme("dark"); try { await manager.flush(); } catch { flushRejected = true; }
    const errors = manager.drainErrors();
    await chmod(root.agentDir, 0o700); await chmod(settingsPath, 0o600);
    const after = (await disk()).theme;
    return { expected: !flushRejected && errors.length > 0 && after === before && manager.getThemeSetting() === "dark",
      flushRejected, errors: errors.length, memoryValue: manager.getThemeSetting(), diskValue: after, diskUnchanged: after === before };
  });
  await g4.observe("G4-S5", "Corrupt settings JSON is reported and never overwritten by a setter", async () => {
    const good = await readFile(settingsPath, "utf8");
    await writeFile(settingsPath, "{ not json");
    const manager = SettingsManager.create(root.dirs.A, root.agentDir, { projectTrusted: false });
    const loadErrors = manager.drainErrors().length;
    manager.setTheme("light"); await manager.flush();
    const writeErrors = manager.drainErrors().length;
    const text = await readFile(settingsPath, "utf8");
    await writeFile(settingsPath, good);
    return { expected: text === "{ not json" && loadErrors + writeErrors > 0, loadErrors, writeErrors, fileLeftUntouched: text === "{ not json" };
  });
  await g4.observe("G4-S6", "Project override: the global write succeeds while the effective value stays the project's, only when trusted", async () => {
    await mkdir(join(root.dirs.P, ".pi"), { recursive: true });
    await writeFile(join(root.dirs.P, ".pi", "settings.json"), JSON.stringify({ theme: "project-theme" }));
    const trusted = SettingsManager.create(root.dirs.P, root.agentDir, { projectTrusted: true });
    trusted.setTheme("light"); await trusted.flush();
    const untrusted = SettingsManager.create(root.dirs.P, root.agentDir, { projectTrusted: false });
    return { expected: trusted.getThemeSetting() === "project-theme" && untrusted.getThemeSetting() === "light" && trusted.getGlobalSettings().theme === "light",
      effectiveWhenTrusted: trusted.getThemeSetting(), effectiveWhenUntrusted: untrusted.getThemeSetting(), globalValue: trusted.getGlobalSettings().theme,
      projectValueVisibleWhenUntrusted: untrusted.getProjectSettings().theme ?? null };
  });
  await g4.observe("G4-R1", "RPC session-behaviour setters: which of them also persist a global default", async () => {
    const child = start(root.dirs.A);
    const before = await disk();
    await child.request("set_steering_mode", { mode: "all" });
    await child.request("set_follow_up_mode", { mode: "all" });
    await child.request("set_auto_compaction", { enabled: true });
    await child.request("set_auto_retry", { enabled: false });
    const state = await child.request("get_state");
    await child.stop();
    const after = await disk();
    return { stateSteeringMode: state.steeringMode, stateFollowUpMode: state.followUpMode, stateAutoCompaction: state.autoCompactionEnabled, stateHasRetryField: "autoRetryEnabled" in state,
      diskBefore: { steeringMode: before.steeringMode ?? null, followUpMode: before.followUpMode ?? null, compaction: before.compaction ?? null, retry: before.retry ?? null },
      diskAfter: { steeringMode: after.steeringMode ?? null, followUpMode: after.followUpMode ?? null, compaction: after.compaction ?? null, retry: after.retry ?? null } };
  });
  await g4.observe("G4-R2", "RPC set_model and set_thinking_level: do they write global defaults", async () => {
    const child = start(root.dirs.A);
    const before = await disk();
    await child.request("set_model", { provider: "pi-pane-m0", modelId: "deterministic-thinking" });
    await child.request("set_thinking_level", { level: "high" });
    await child.stop();
    const after = await disk();
    return { defaultModelBefore: before.defaultModel, defaultModelAfter: after.defaultModel, defaultThinkingBefore: before.defaultThinkingLevel ?? null, defaultThinkingAfter: after.defaultThinkingLevel ?? null,
      writesGlobalDefaults: before.defaultModel !== after.defaultModel || (before.defaultThinkingLevel ?? null) !== (after.defaultThinkingLevel ?? null) };
  });
  await g4.observe("G4-T1", "Themes can be discovered by the public resource loader without loading any extension", async () => {
    await root.addProjectExtension("P");
    await mkdir(join(root.agentDir, "themes"), { recursive: true });
    const base = await disk(join(project, "themes/pi-pane-light.json"));
    await writeFile(join(root.agentDir, "themes", "m31-user.json"), JSON.stringify({ ...base, name: "m31-user" }));
    await writeFile(join(root.agentDir, "themes", "m31-broken.json"), "{ nope");
    await mkdir(join(root.agentDir, "themes", "decorations"), { recursive: true });
    await writeFile(join(root.agentDir, "themes", "decorations", "manifest.json"), JSON.stringify({ notATheme: true }));
    await root.clearEvents();
    const previous = { ...process.env };
    Object.assign(process.env, { PI_M0_EVENTS_PATH: root.eventPath, PI_OFFLINE: "1" });
    let themes, diagnostics;
    try {
      const settingsManager = SettingsManager.create(root.dirs.P, root.agentDir, { projectTrusted: true });
      const loader = new DefaultResourceLoader({ cwd: root.dirs.P, agentDir: root.agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true });
      await loader.reload();
      ({ themes, diagnostics } = loader.getThemes());
    } finally { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); }
    const names = themes.map((theme) => theme.name);
    const extensionRan = (await root.events("m31_project_extension")).length > 0;
    return { expected: names.includes("m31-user") && !extensionRan, themeNames: names, userThemeFound: names.includes("m31-user"), projectExtensionExecuted: extensionRan,
      diagnostics: diagnostics.map((item) => `${item.type}: ${String(item.message).replace(root.root, "<root>").slice(0, 120)}`),
      subdirectoryManifestTreatedAsTheme: diagnostics.some((item) => String(item.message + (item.path ?? "")).includes("decorations")) || names.includes("manifest") };
  });
  await g4.observe("G4-I1", "images.blockImages is applied to images sent through RPC prompt", async () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const send = async () => {
      await root.clearEvents();
      const child = start(root.dirs.A);
      const from = child.records.length;
      await child.request("prompt", { message: "M31_G4_IMAGE", images: [{ type: "image", data: png, mimeType: "image/png" }] });
      const { waitFor } = await import("./m31-lib.mjs");
      await waitFor(() => child.records.slice(from).some((record) => record.type === "agent_settled"), "image prompt settled");
      await child.stop();
      return (await root.events("provider_call")).at(-1)?.images?.length ?? null;
    };
    const allowed = await send();
    const settings = await disk(); settings.images = { ...settings.images, blockImages: true }; await writeFile(settingsPath, JSON.stringify(settings));
    const blocked = await send();
    settings.images.blockImages = false; await writeFile(settingsPath, JSON.stringify(settings));
    return { imagesSeenByProviderDefault: allowed, imagesSeenByProviderWhenBlocked: blocked, settingAppliesToRpc: allowed === 1 && blocked === 0 };
  });

  // ---------------------------------------------------------------- G5
  let child, saved;
  await g5.observe("G5-P1", "A provider added to models.json is listed by a running child at once; an in-process apply keeps it", async () => {
    child = start(root.dirs.A);
    await writeFile(modelsPath, JSON.stringify({ providers: { [CUSTOM]: customProvider() } }, null, 2), { mode: 0o600 });
    const before = await modelsOf(child, CUSTOM);
    const applied = await child.request("new_session");
    const after = await modelsOf(child, CUSTOM);
    return { expected: after.includes("m31-model-a") && applied.cancelled === false, listedWithoutApply: before.length > 0, modelsBeforeApply: before, modelsAfterApply: after };
  });
  await g5.observe("G5-P2", "Editing and removing the provider follow the same apply step", async () => {
    await writeFile(modelsPath, JSON.stringify({ providers: { [CUSTOM]: customProvider({ models: [{ id: "m31-model-a" }, { id: "m31-model-b", name: "Model B" }] }) } }, null, 2));
    await child.request("new_session");
    const edited = await modelsOf(child, CUSTOM);
    await writeFile(modelsPath, JSON.stringify({ providers: {} }, null, 2));
    await child.request("new_session");
    const removed = await modelsOf(child, CUSTOM);
    return { expected: edited.length === 2 && removed.length === 0, modelsAfterEdit: edited, modelsAfterRemoval: removed };
  });
  await g5.observe("G5-P3", "Unknown provider-level and top-level fields do not stop the file from loading", async () => {
    await writeFile(modelsPath, JSON.stringify({ unknownTop: 1, providers: { [CUSTOM]: customProvider({ unknownProviderField: { a: 1 }, headers: { "X-Test": "1" } }) } }, null, 2));
    await child.request("new_session");
    const models = await modelsOf(child, CUSTOM);
    return { modelsWithUnknownFields: models, stillLoads: models.length > 0 };
  });
  await g5.observe("G5-P4", "Corrupt models.json: the child keeps running and the custom provider disappears", async () => {
    await writeFile(modelsPath, "{ broken");
    const result = await child.request("new_session");
    const custom = await modelsOf(child, CUSTOM);
    const builtin = await modelsOf(child, "pi-pane-m0");
    const fresh = start(root.dirs.A); let freshStarts = true;
    try { await fresh.request("get_state"); } catch { freshStarts = false; }
    await fresh.stop();
    return { applyCancelled: result.cancelled, customModels: custom.length, otherProvidersStillListed: builtin.length > 0, freshChildStarts: freshStarts, freshChildStderr: fresh.stderr.replace(root.root, "<root>").slice(0, 300) };
  });
  await g5.observe("G5-K1", "Hazard: an apiKey starting with ! in models.json — is it executed just by listing models", async () => {
    const marker = join(root.root, "pwned-models-list");
    await writeFile(modelsPath, JSON.stringify({ providers: { [CUSTOM]: customProvider({ apiKey: `!touch ${marker}` }) } }, null, 2));
    await child.request("new_session");
    const models = await modelsOf(child, CUSTOM);
    return { commandExecutedOnListing: existsSync(marker), modelsListed: models.length };
  });
  await g5.observe("G5-K2", "Escaped literal keys in models.json are not executed", async () => {
    const marker = join(root.root, "pwned-models-escaped");
    await writeFile(modelsPath, JSON.stringify({ providers: { [CUSTOM]: customProvider({ apiKey: `$!touch ${marker} $$HOME` }) } }, null, 2));
    await child.request("new_session");
    const models = await modelsOf(child, CUSTOM);
    return { expected: !existsSync(marker) && models.length > 0, commandExecuted: existsSync(marker), modelsListed: models.length };
  });
  await g5.observe("G5-K3", "Can the key live in the official credential store instead of models.json", async () => {
    await writeFile(modelsPath, JSON.stringify({ providers: { [CUSTOM]: (({ apiKey, ...rest }) => rest)(customProvider()) } }, null, 2));
    await child.request("new_session");
    const withoutKey = await modelsOf(child, CUSTOM);
    let loginError;
    try {
      const runtime = await ModelRuntime.create({ authPath, modelsPath, refreshOnCreate: false, allowModelNetwork: false });
      await runtime.login(CUSTOM, "api_key", { signal: new AbortController().signal, notify() {}, prompt: async () => "m31-stored-key" });
    } catch (error) { loginError = String(error.message).slice(0, 200); }
    const stored = (await disk(authPath))[CUSTOM];
    if (!stored) await writeFile(authPath, JSON.stringify({ ...(await disk(authPath)), [CUSTOM]: { type: "api_key", key: "m31-stored-key" } }), { mode: 0o600 });
    await child.request("new_session");
    const withStoredKey = await modelsOf(child, CUSTOM);
    return { modelsWithoutAnyKey: withoutKey.length, officialLoginForCustomProvider: loginError ? `failed: ${loginError}` : "ok", credentialWrittenByLogin: !!stored,
      modelsWithKeyOnlyInAuthStore: withStoredKey.length, keyCanLiveInAuthStore: withStoredKey.length > 0 };
  });
  await g5.observe("G5-N1", "Same name as a built-in provider: what the file does to that provider's models", async () => {
    await writeFile(modelsPath, JSON.stringify({ providers: { openai: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "m31-literal-key", models: [{ id: "m31-override-only" }] } } }, null, 2));
    await child.request("new_session");
    const models = await modelsOf(child, "openai");
    return { builtinProviderModelCount: models.length, containsCustomModel: models.includes("m31-override-only"), builtinModelsReplaced: models.length === 1 };
  });

  await g5.observe("G5-E1", "export_html without a path writes into the child's working directory (the project); a given path is honoured", async () => {
    await writeFile(modelsPath, JSON.stringify({ providers: {} }));
    await child.request("new_session");
    await child.prompt("M31_G5_EXPORT");
    saved = (await child.request("get_state")).sessionFile;
    const byDefault = (await child.request("export_html")).path;
    const target = join(root.root, "exports", "session.html"); await mkdir(dirname(target), { recursive: true });
    const explicit = (await child.request("export_html", { outputPath: target })).path;
    const size = (await stat(explicit)).size;
    const landed = resolve(root.dirs.A, byDefault);
    return { expected: existsSync(landed) && explicit === target, defaultPathAsReported: byDefault.replace(root.root, "<root>"), reportedPathIsRelative: !byDefault.startsWith("/"),
      defaultLandsInProjectDirectory: existsSync(landed) && dirname(landed) === root.dirs.A, defaultInsideSessionDir: dirname(landed) === dirname(saved), explicitPathHonoured: explicit === target, bytes: size };
  });
  await g5.observe("G5-E2", "get_session_stats and get_last_assistant_text return what the web needs", async () => {
    const stats = await child.request("get_session_stats");
    const last = await child.request("get_last_assistant_text");
    return { expected: typeof stats.totalMessages === "number" && typeof last.text === "string", statsKeys: Object.keys(stats), tokensKeys: Object.keys(stats.tokens ?? {}),
      contextUsage: stats.contextUsage ?? null, cost: stats.cost, lastAssistantTextStartsWith: last.text?.slice(0, 24) };
  });
  await g5.observe("G5-D1", "Deletion guard: a session owned by a /web host is detectable; an unowned one is not", async () => {
    const lock = await SessionFileLock.acquire(saved); await lock.setWriterPid(child.pid);
    const owned = await SessionFileLock.inspect(saved);
    await lock.release();
    const free = await SessionFileLock.inspect(saved);
    return { expected: !!owned && !free, ownerDetectedWhileLocked: !!owned, ownerAfterRelease: free ?? null, trashCommandAvailable: existsSync("/usr/bin/trash") };
  });
} finally {
  for (const item of children) await item.stop(2000).catch(() => {});
  const cleanup = { childrenExited: children.every((item) => item.exitCode !== undefined || item.exitSignal !== undefined) };
  await chmod(root.agentDir, 0o700).catch(() => {});
  await root.remove();
  cleanup.temporaryRootRemoved = !existsSync(root.root);
  for (const [name, { report }] of [["g4", g4], ["g5", g5]]) {
    report.finishedAt = new Date().toISOString(); report.cleanup = cleanup;
    await writeFile(join(out, `${name}.json`), JSON.stringify(report, null, 2));
  }
}
for (const [name, { report }] of [["G4", g4], ["G5", g5]]) {
  const bad = report.observations.filter((item) => item.status !== "as_expected");
  console.log(`${name}: ${report.observations.length - bad.length}/${report.observations.length} as expected`);
}
