import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { SettingsController, type SettingChoices, type SettingsRuntime } from "../src/extension/settings-controller.js";
import type { SettingItem, SettingKey } from "../src/protocol/index.js";

const choices: SettingChoices = { themes: ["system", "dark", "light", "mine"], models: ["acme/fast", "router/vendor/large"] };
async function fixture(run: (context: { agentDir: string; project: string; path: string; projectPath: string; disk: () => Promise<Record<string, any>>;
  controller: (cli?: Record<string, string>, confirmMs?: number) => SettingsController }) => Promise<void>, global?: unknown, project?: unknown) {
  const root = await mkdtemp(join(tmpdir(), "pi-pane-settings-")), agentDir = join(root, "agent"), projectDir = join(root, "project");
  await mkdir(agentDir); await mkdir(join(projectDir, ".pi"), { recursive: true });
  const path = join(agentDir, "settings.json"), projectPath = join(projectDir, ".pi", "settings.json");
  if (global !== undefined) await writeFile(path, typeof global === "string" ? global : JSON.stringify(global));
  if (project !== undefined) await writeFile(projectPath, JSON.stringify(project));
  const controller = (cli: Record<string, string> = {}, confirmMs = 300) => new SettingsController({ agentDir, cli, confirmMs });
  try { await run({ agentDir, project: projectDir, path, projectPath, disk: async () => JSON.parse(await readFile(path, "utf8")), controller }); }
  finally { await chmod(path, 0o600).catch(() => undefined); await rm(root, { recursive: true, force: true }); }
}
const item = (items: SettingItem[], key: SettingKey): SettingItem => items.find(entry => entry.key === key)!;

test("an empty configuration shows pi's defaults and that nothing is set", () => fixture(async ({ project, agentDir, controller }) => {
  const view = controller().view({ cwd: project, projectTrusted: true }, choices, true);
  assert.equal(view.agentDir, agentDir); assert.deepEqual(view.project, { path: project, settings: "none" }); assert.deepEqual(view.errors, []);
  assert.deepEqual(view.items.map(entry => [entry.key, entry.global, entry.effective, entry.editable]), [
    ["theme", null, null, true], ["defaultModel", null, null, true], ["defaultThinkingLevel", null, null, true],
    ["steeringMode", null, "one-at-a-time", true], ["followUpMode", null, "one-at-a-time", true],
    ["compaction.enabled", null, true, true], ["retry.enabled", null, true, true], ["images.blockImages", null, false, true], ["hideThinkingBlock", null, false, true]]);
  assert.equal(view.items.every(entry => entry.project === undefined && entry.cli === undefined && entry.effective === entry.defaultValue), true);
  assert.deepEqual(view.items.map(entry => [entry.writes, entry.applies]), [["global", "terminal"], ["global", "new_runtimes"], ["global", "new_runtimes"],
    ["runtime", "now"], ["runtime", "now"], ["runtime", "now"], ["runtime", "now"], ["global", "reload"], ["global", "terminal"]]);
  // Without a running session the settings pi changes itself, and the model list, have nothing to act on.
  const idle = controller().view({ cwd: project, projectTrusted: true }, {}, false);
  assert.deepEqual(idle.items.filter(entry => !entry.editable).map(entry => [entry.key, entry.reason]),
    [["defaultModel", "no_models"], ["steeringMode", "no_runtime"], ["followUpMode", "no_runtime"], ["compaction.enabled", "no_runtime"], ["retry.enabled", "no_runtime"]]);
}));
test("global, trusted project and start-argument layers are shown separately", () => fixture(async ({ project, controller }) => {
  const scope = { cwd: project, projectTrusted: true };
  const view = controller({ provider: "acme", model: "fast", thinking: "high", theme: "light" }).view(scope, { ...choices, runtime: { steeringMode: "all", followUpMode: "one-at-a-time", autoCompactionEnabled: false } }, true);
  assert.deepEqual(item(view.items, "theme"), { key: "theme", kind: "theme", options: choices.themes, effective: "light", global: "dark", defaultValue: null, project: "light", cli: "light", writes: "global", applies: "terminal", editable: true });
  assert.deepEqual([item(view.items, "defaultModel").global, item(view.items, "defaultModel").effective, item(view.items, "defaultModel").cli], ["router/vendor/large", "router/vendor/large", "acme/fast"]);
  assert.deepEqual([item(view.items, "compaction.enabled").global, item(view.items, "compaction.enabled").project, item(view.items, "compaction.enabled").effective, item(view.items, "compaction.enabled").runtime], [true, false, false, false]);
  assert.equal(item(view.items, "steeringMode").runtime, "all"); assert.equal(item(view.items, "retry.enabled").runtime, undefined, "pi's RPC state has no retry field");
  assert.equal(item(view.items, "defaultThinkingLevel").cli, "high"); assert.equal(view.project.settings, "loaded");
  assert.deepEqual(controller().themeSetting(scope), { setting: "light", source: "project" });
  assert.deepEqual(controller({ theme: "mine" }).themeSetting(scope), { setting: "mine", source: "cli" });
  // An untrusted project's file exists and is not read: its values neither show nor decide.
  const untrusted = controller().view({ cwd: project, projectTrusted: false }, choices, true);
  assert.equal(untrusted.project.settings, "untrusted"); assert.equal(item(untrusted.items, "theme").effective, "dark"); assert.equal(item(untrusted.items, "theme").project, undefined);
  assert.equal(item(untrusted.items, "compaction.enabled").effective, true);
  assert.deepEqual(controller().themeSetting({ cwd: project, projectTrusted: false }), { setting: "dark", source: "global" });
}, { theme: "dark", defaultProvider: "router", defaultModel: "vendor/large", compaction: { enabled: true } }, { theme: "light", compaction: { enabled: false } }));
test("a save writes one field through pi's setter, keeps everything else, and is confirmed from disk", () => fixture(async ({ project, path, disk, controller }) => {
  const settings = controller(), scope = { cwd: project, projectTrusted: true };
  const theme = await settings.set(scope, "theme", "light/mine", "dark", choices);
  assert.equal(theme.saved, "confirmed"); assert.equal(theme.applied, "later"); assert.equal(theme.item.global, "light/mine"); assert.equal(theme.item.effective, "light/mine");
  const model = await settings.set(scope, "defaultModel", "router/vendor/large", null, choices);
  assert.equal(model.item.global, "router/vendor/large");
  await settings.set(scope, "defaultThinkingLevel", "high", null, choices);
  assert.equal((await settings.set(scope, "images.blockImages", true, null, choices)).applied, "pending", "a running session reads this once");
  assert.equal((await settings.set(scope, "hideThinkingBlock", true, null, choices)).applied, "later");
  assert.deepEqual(await disk(), { theme: "light/mine", unknownTopLevel: { keep: [1, 2] }, images: { autoResize: false, blockImages: true }, packages: ["npm:example"],
    defaultProvider: "router", defaultModel: "vendor/large", defaultThinkingLevel: "high", hideThinkingBlock: true });
  // A field another program changed after the page was loaded is not written back from memory.
  const raw = await disk(); raw.packages.push("npm:later"); raw.steeringMode = "all"; await writeFile(path, JSON.stringify(raw));
  await settings.set(scope, "hideThinkingBlock", false, true, choices);
  const after = await disk(); assert.deepEqual(after.packages, ["npm:example", "npm:later"]); assert.equal(after.steeringMode, "all"); assert.equal(after.hideThinkingBlock, false);
}, { theme: "dark", unknownTopLevel: { keep: [1, 2] }, images: { autoResize: false }, packages: ["npm:example"] }));
test("a value the page did not see, an unknown choice and a wrong type are refused before anything is written", () => fixture(async ({ project, path, controller }) => {
  const settings = controller(), scope = { cwd: project, projectTrusted: true }, before = await readFile(path, "utf8");
  await assert.rejects(settings.set(scope, "theme", "light", null, choices), { code: "stale_setting" });
  await assert.rejects(settings.set(scope, "theme", "light", "mine", choices), { code: "stale_setting" });
  await assert.rejects(settings.set(scope, "theme", "project-only", "dark", choices), { code: "theme_not_global" });
  await assert.rejects(settings.set(scope, "theme", "light/project-only", "dark", choices), { code: "theme_not_global" });
  await assert.rejects(settings.set(scope, "theme", "a/b/c", "dark", choices), { code: "theme_not_global" });
  await assert.rejects(settings.set(scope, "theme", true, "dark", choices), { code: "theme_not_global" });
  await assert.rejects(settings.set(scope, "defaultModel", "acme/unknown", null, choices), { code: "invalid_setting" });
  await assert.rejects(settings.set(scope, "defaultModel", "acme/fast", null, {}), { code: "invalid_setting" });
  await assert.rejects(settings.set(scope, "defaultThinkingLevel", "extreme", null, choices), { code: "invalid_setting" });
  await assert.rejects(settings.set(scope, "images.blockImages", "true", null, choices), { code: "invalid_setting" });
  await assert.rejects(settings.set(scope, "steeringMode", "sometimes", null, choices, { request: async () => { throw new Error("must not be called"); } }), { code: "invalid_setting" });
  assert.equal(await readFile(path, "utf8"), before);
}, { theme: "dark" }));
test("a project override is reported: the global value is saved and the project still decides", () => fixture(async ({ project, disk, controller }) => {
  const result = await controller().set({ cwd: project, projectTrusted: true }, "theme", "mine", "dark", choices);
  assert.deepEqual([result.saved, result.applied, result.item.global, result.item.project, result.item.effective], ["confirmed", "overridden", "mine", "light", "light"]);
  assert.equal((await disk()).theme, "mine");
  const blocked = await controller().set({ cwd: project, projectTrusted: true }, "images.blockImages", true, null, choices);
  assert.equal(blocked.applied, "overridden"); assert.equal(blocked.item.effective, false);
  // The same save from an untrusted project is not overridden: pi would not read that file.
  assert.equal((await controller().set({ cwd: project, projectTrusted: false }, "theme", "dark", "mine", choices)).applied, "later");
}, { theme: "dark" }, { theme: "light", images: { blockImages: false } }));
test("an unreadable global file is never written over, and a file with a byte-order mark is read", () => fixture(async ({ project, path, controller }) => {
  const settings = controller(), scope = { cwd: project, projectTrusted: true };
  const view = settings.view(scope, choices, true);
  assert.equal(view.errors.length, 1); assert.equal(view.errors[0]!.scope, "global");
  assert.equal(view.items.every(entry => !entry.editable && entry.reason === "unreadable"), true);
  await assert.rejects(settings.set(scope, "theme", "light", null, choices), { code: "settings_unreadable" });
  await assert.rejects(settings.set(scope, "steeringMode", "all", null, choices, { request: async () => { throw new Error("must not be called"); } }), { code: "settings_unreadable" });
  assert.equal(await readFile(path, "utf8"), "{ \"theme\": ");
  await writeFile(path, `﻿${JSON.stringify({ theme: "mine" })}`);
  assert.equal(item(settings.view(scope, choices, true).items, "theme").global, "mine");
  assert.equal((await settings.set(scope, "theme", "light", "mine", choices)).saved, "confirmed");
}, "{ \"theme\": "));
test("a write pi could not make is reported as a failure, not as saved", { skip: process.getuid?.() === 0 }, () => fixture(async ({ project, path, controller }) => {
  const settings = controller(), scope = { cwd: project, projectTrusted: true };
  await chmod(path, 0o400);
  await assert.rejects(settings.set(scope, "theme", "light", "dark", choices), { code: "save_failed" });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { theme: "dark" });
  // The view is rebuilt from disk, so the value that was never saved does not show.
  assert.equal(item(settings.view(scope, choices, true).items, "theme").global, "dark");
  await chmod(path, 0o600);
  assert.equal((await settings.set(scope, "theme", "light", "dark", choices)).saved, "confirmed", "the same choice can be retried");
}, { theme: "dark" }));
test("settings pi changes through RPC are applied there, and the global file is read until it shows them", () => fixture(async ({ project, agentDir, disk, controller }) => {
  const scope = { cwd: project, projectTrusted: true }, calls: [string, unknown][] = [];
  // Like pi's RPC child: the command changes the session and saves the default on its own write queue.
  const state: Record<string, unknown> = { steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", autoCompactionEnabled: true };
  const child = (save: boolean, delay = 0): SettingsRuntime => ({ request: async <T>(command: string, payload: Record<string, unknown> = {}) => {
    calls.push([command, payload]);
    if (command === "get_state") return state as T;
    const manager = SettingsManager.create(project, agentDir, { projectTrusted: true });
    if (command === "set_steering_mode") { state.steeringMode = payload.mode; if (save) manager.setSteeringMode(payload.mode as never); }
    else if (command === "set_follow_up_mode") { state.followUpMode = payload.mode; if (save) manager.setFollowUpMode(payload.mode as never); }
    else if (command === "set_auto_compaction") { if (save) manager.setCompactionEnabled(payload.enabled as boolean); state.autoCompactionEnabled = manager.getCompactionEnabled(); }
    else if (command === "set_auto_retry") { if (save) manager.setRetryEnabled(payload.enabled as boolean); }
    else throw new Error(`unexpected ${command}`);
    if (delay) setTimeout(() => void manager.flush(), delay); else await manager.flush();
    return undefined as T;
  } });
  const settings = controller({}, 400);
  const steering = await settings.set(scope, "steeringMode", "all", null, choices, child(true, 150));
  assert.deepEqual([steering.saved, steering.applied, steering.item.global, steering.item.runtime], ["confirmed", "now", "all", "all"]);
  assert.deepEqual(calls.slice(0, 2), [["set_steering_mode", { mode: "all" }], ["get_state", {}]]);
  assert.equal((await settings.set(scope, "followUpMode", "all", null, choices, child(true))).saved, "confirmed");
  assert.equal((await settings.set(scope, "retry.enabled", false, null, choices, child(true))).applied, "now");
  // The project sets compaction itself: pi saves the global default and the session keeps the project's value.
  const compaction = await settings.set(scope, "compaction.enabled", false, null, choices, child(true));
  assert.deepEqual([compaction.saved, compaction.applied, compaction.item.global, compaction.item.project, compaction.item.runtime], ["confirmed", "overridden", false, true, true]);
  assert.deepEqual(await disk(), { steeringMode: "all", followUpMode: "all", retry: { enabled: false }, compaction: { enabled: false } });
  // pi accepted the command and the file never shows it: said as it is, nothing rolled back.
  const unconfirmed = await settings.set(scope, "steeringMode", "one-at-a-time", "all", choices, child(false));
  assert.deepEqual([unconfirmed.saved, unconfirmed.applied, unconfirmed.item.global, unconfirmed.item.runtime], ["unconfirmed", "now", "all", "one-at-a-time"]);
  await assert.rejects(settings.set(scope, "followUpMode", "one-at-a-time", "all", choices, { request: async () => { throw new Error("rpc failed"); } }), /rpc failed/);
  await assert.rejects(settings.set(scope, "followUpMode", "one-at-a-time", "all", choices), { code: "no_runtime" });
  assert.equal((await disk()).followUpMode, "all");
}, {}, { compaction: { enabled: true } }));
test("other settings are listed with where they are set; commands, paths, proxies and identifiers never leave the host", () => fixture(async ({ project, controller }) => {
  const view = controller().view({ cwd: project, projectTrusted: true }, choices, true);
  const all = Object.fromEntries(view.groups.flatMap(group => group.settings.map(setting => [setting.key, setting])));
  assert.deepEqual(all.httpProxy, { key: "httpProxy", where: ["global"] });
  assert.deepEqual(all.shellCommandPrefix, { key: "shellCommandPrefix", where: ["global"] });
  assert.deepEqual(all.npmCommand, { key: "npmCommand", where: ["global"], value: "[2]" });
  assert.deepEqual(all.externalEditor, { key: "externalEditor", where: ["global"] });
  assert.deepEqual(all.transport, { key: "transport", where: ["global"], value: "websocket" });
  assert.deepEqual(all["retry.maxRetries"], { key: "retry.maxRetries", where: ["global", "project"], value: "9" });
  assert.deepEqual(all["images.autoResize"], { key: "images.autoResize", where: ["global"], value: "false" });
  assert.deepEqual(all.packages, { key: "packages", where: ["project"], value: "[1]" });
  assert.deepEqual(all.enabledModels, { key: "enabledModels", where: [] });
  assert.deepEqual(all.sessionDir, { key: "sessionDir", where: ["global"], value: "/sessions/here" });
  assert.deepEqual(view.groups.map(group => [group.id, group.status]).filter(([, status]) => status !== "later"), [["session", "runtime"], ["network", "runtime"], ["shell", "runtime"], ["terminal", "terminal"]]);
  const wire = JSON.stringify(view);
  for (const secret of ["proxy-password", "secret-wrapper", "private-registry", "device-123", "tracking-456", "extension-private", "code --wait", "git:example.com/private"]) assert.equal(wire.includes(secret), false, secret);
}, { httpProxy: "http://user:proxy-password@proxy.example:8080", shellCommandPrefix: "secret-wrapper --", npmCommand: ["npm", "--registry=https://private-registry.example"], externalEditor: "code --wait",
  transport: "websocket", retry: { maxRetries: 3 }, images: { autoResize: false }, sessionDir: "/sessions/here", deviceId: "device-123", trackingId: "tracking-456", myExtension: { token: "extension-private" } },
{ retry: { maxRetries: 9 }, packages: ["git:example.com/private"] }));
