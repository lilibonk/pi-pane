#!/usr/bin/env node
/**
 * M3.1 themes and settings with a real pi TUI and real RPC children: the theme list and what "follow pi"
 * shows, saving pi's default theme, settings pi changes through RPC, a setting applied by reloading the
 * running session, trust boundaries, stale and failed saves.
 * Temporary HOME/agent directories, the deterministic provider, PI_OFFLINE: no provider is contacted.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { startFixture, openClient, commandResult, waitFor } from "./m0-smoke.mjs";
import { png } from "../tests/fixtures/images.ts";

const out = resolve(process.env.PI_M31_REPORT_DIR || "build-artifacts/m3.1/settings");
await mkdir(out, { recursive: true });
const report = { startedAt: new Date().toISOString(), scope: "M31-4 themes and settings", realTui: true, realModelCalls: 0, providerRequests: 0,
  isolation: "temporary HOME + agent dir, deterministic provider, PI_OFFLINE=1", checks: [], status: "running" };
const fixtures = [], clients = [];
const SECRET = "m31-proxy-password";
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
  const state = client.frames.filter(item => item.t === "host_state").at(-1);
  const commandNo = client.nextCommandNo++; const id = `${client.clientId}:${commandNo}`;
  client.send({ t: "host_command", clientId: client.clientId, commandNo, id, hostRevision: state?.revision ?? 0, command, args });
  const ack = await waitFor(() => client.frames.find(item => item.t === "ack" && item.id === id), `ack ${command}`);
  if (ack.status !== "dispatched") throw Object.assign(new Error(ack.error?.message ?? "rejected"), { code: ack.error?.code });
  const result = await waitFor(() => client.frames.find(item => item.t === "command_result" && item.id === id), `result ${command}`, 40_000);
  if (result.status !== "completed") throw Object.assign(new Error(result.error?.message ?? "failed"), { code: result.error?.code });
  return result.value;
}
/** A frame the protocol itself refuses: it gets an error frame, uses no command number and leaves the connection open. */
async function refused(client, args) {
  const from = client.frames.length, commandNo = client.nextCommandNo, state = client.frames.filter(item => item.t === "host_state").at(-1);
  client.send({ t: "host_command", clientId: client.clientId, commandNo, id: `${client.clientId}:${commandNo}`, hostRevision: state?.revision ?? 0, command: "setting_set", args });
  return (await waitFor(() => client.frames.slice(from).find(item => item.t === "error"), "protocol error")).error?.code;
}
const rejects = (promise, code) => assert.rejects(promise, error => { assert.equal(error.code, code, error.message); return true; });
const set = (client, key, value, expected) => hostCommand(client, "setting_set", { key, value, expected });
const item = async (client, key) => (await hostQuery(client, "settings")).items.find(entry => entry.key === key);
async function reply(client, text, images) {
  const operation = await client.command("prompt", { text, mode: "followUp", ...(images ? { images } : {}) }); assert.equal(operation.ack.status, "dispatched", operation.ack.error?.message);
  assert.equal((await commandResult(client, operation.frame)).status, "completed");
  await waitFor(() => client.snapshot?.state.idle && client.snapshot.session.messages.some(message => message.role === "assistant" && JSON.stringify(message.content).includes(`M0_REPLY:${text}:`)), `reply to ${text}`, 30_000);
}

try {
  let base;
  const theme = (name, accent, appearance = "dark") => JSON.stringify({ ...base, name, appearance, colors: { ...base.colors, accent } });
  const fixture = await startFixture({ loadThemes: true, extraExtensions: ["tests/fixtures/handoff-fixture.ts", "tests/fixtures/m31-probe.ts"],
    settings: { httpProxy: `http://user:${SECRET}@proxy.invalid:8080`, shellCommandPrefix: "m31-wrapper --", unknownTopLevel: { keep: true }, images: { autoResize: true } },
    prepareAgentDir: async agentDir => {
      base = JSON.parse(await readFile(resolve("themes/pi-pane-dark.json"), "utf8"));
      await mkdir(join(agentDir, "themes"));
      await writeFile(join(agentDir, "themes", "m31-user.json"), theme("m31-user", "#13579b"));
      await writeFile(join(agentDir, "themes", "m31-light.json"), theme("m31-light", "#2468ac", "light"));
      await writeFile(join(agentDir, "themes", "m31-broken.json"), "{ nope");
    } });
  fixtures.push(fixture);
  const client = await openClient(fixture.url); clients.push(client);
  const other = await openClient(fixture.url); clients.push(other);
  await waitFor(() => client.snapshot && other.snapshot, "snapshots");
  const settingsPath = join(fixture.agentDir, "settings.json");
  const disk = async () => JSON.parse(await readFile(settingsPath, "utf8"));
  const children = async () => (await fixture.events()).filter((entry, index, all) => entry.event === "m31_session" && entry.mode === "rpc" && all.findIndex(other => other.event === "m31_session" && other.mode === "rpc" && other.pid === entry.pid) === index);
  const accent = view => view.snapshot.theme["--accent"];
  const base0 = await realpath(fixture.directory);
  const sessionId = client.snapshot.session.id;

  await check("THM-04", "the theme list has pi's built-ins, this package's, the user directory's, and reports a broken file without a host path", async () => {
    const view = await hostQuery(client, "themes");
    const sources = Object.fromEntries(view.themes.map(entry => [entry.name, entry.source]));
    assert.deepEqual(sources, { "pi-pane-dark": "pi-pane", "pi-pane-light": "pi-pane", dark: "builtin", light: "builtin", "m31-light": "user", "m31-user": "user" });
    assert.deepEqual(view.problems, [{ file: "m31-broken.json", source: "user", code: "invalid_json", message: view.problems[0].message }]);
    assert.equal(JSON.stringify(view).includes(base0), false, "no host path in the theme list");
    assert.equal(view.projectThemes, "none");
    const one = await hostQuery(client, "theme", { name: "m31-user" }); assert.equal(one.vars["--accent"], "#13579b");
    for (const value of Object.values(one.vars)) assert.match(value, /^#[0-9a-f]{6}$/i);
    await rejects(hostQuery(client, "theme", { name: "m31-broken" }), "theme_missing");
    return { themes: view.themes.length };
  });
  await check("THM-02", "with no theme set, follow pi is the terminal theme captured at handoff and is labelled so", async () => {
    const view = await hostQuery(client, "themes");
    assert.deepEqual(view.pi, { source: "default", name: "system", appearance: view.pi.appearance, origin: "handoff", reason: "system" });
    assert.ok(accent(client)); assert.notEqual(accent(client), "#13579b");
    assert.equal((await disk()).theme, undefined, "reading themes wrote no setting");
  });
  await check("THM-03", "saving pi's default theme writes the global setting, is read back by pi's own settings, and follow pi changes on every page", async () => {
    const before = await item(client, "theme"); assert.equal(before.global, null); assert.ok(before.options.includes("m31-user")); assert.ok(before.options.includes("dark"));
    assert.equal(before.options.includes("pi-pane-dark"), false, "pi does not know this package's themes when it is loaded from source");
    const result = await set(client, "theme", "m31-user", null);
    assert.deepEqual([result.saved, result.applied, result.item.global], ["confirmed", "later", "m31-user"]);
    assert.equal(SettingsManager.create(fixture.cwd, fixture.agentDir, { projectTrusted: false }).getThemeSetting(), "m31-user", "what a pi started now would read");
    await waitFor(() => accent(client) === "#13579b" && accent(other) === "#13579b", "both pages show the new theme");
    assert.deepEqual((await hostQuery(other, "themes")).pi, { setting: "m31-user", source: "global", name: "m31-user", appearance: "dark", origin: "catalog" });
    // A light/dark pair is saved as pi writes it and stays a pair when read back.
    const pair = await set(other, "theme", "m31-light/m31-user", "m31-user"); assert.equal(pair.item.global, "m31-light/m31-user");
    const manager = SettingsManager.create(fixture.cwd, fixture.agentDir, { projectTrusted: false });
    assert.equal(manager.getThemeSetting(), "m31-light/m31-user"); assert.equal(manager.getTheme(), undefined, "pi's single-name getter cannot express the pair");
    const view = await hostQuery(client, "themes"); assert.equal(view.pi.setting, "m31-light/m31-user"); assert.ok(["m31-light", "m31-user"].includes(view.pi.name));
    const saved = await disk(); assert.deepEqual(saved.unknownTopLevel, { keep: true }); assert.deepEqual(saved.images, { autoResize: true }); assert.ok(saved.httpProxy.includes(SECRET));
    await set(client, "theme", "m31-user", "m31-light/m31-user");
  });
  await check("SET-02", "two pages: a stale view of the same setting is refused; different settings are both kept", async () => {
    await rejects(set(other, "theme", "dark", null), "stale_setting");
    assert.equal((await disk()).theme, "m31-user");
    const [first, second] = await Promise.allSettled([set(client, "defaultThinkingLevel", "high", null), set(other, "hideThinkingBlock", true, null)]);
    assert.equal(first.status, "fulfilled", String(first.reason)); assert.equal(second.status, "fulfilled", String(second.reason));
    const saved = await disk(); assert.equal(saved.defaultThinkingLevel, "high"); assert.equal(saved.hideThinkingBlock, true);
    const [one, two] = await Promise.allSettled([set(client, "defaultThinkingLevel", "low", "high"), set(other, "defaultThinkingLevel", "medium", "high")]);
    assert.deepEqual([one.status, two.status].sort(), ["fulfilled", "rejected"]); assert.equal([one, two].find(entry => entry.status === "rejected").reason.code, "stale_setting");
  });
  await check("SET-06", "queue modes, auto-compaction and auto-retry go through pi's RPC: the session changes and pi saves the global default", async () => {
    const before = (await children()).length;
    const steering = await set(client, "steeringMode", "all", null);
    assert.deepEqual([steering.saved, steering.applied, steering.item.runtime, steering.item.global], ["confirmed", "now", "all", "all"]);
    assert.equal((await set(client, "followUpMode", "all", null)).saved, "confirmed");
    // The fixture starts with compaction off in the global file.
    const compaction = await set(client, "compaction.enabled", true, false);
    assert.deepEqual([compaction.saved, compaction.applied, compaction.item.runtime], ["confirmed", "now", true]);
    const retry = await set(client, "retry.enabled", false, null);
    assert.deepEqual([retry.saved, retry.applied, retry.item.runtime], ["confirmed", "now", undefined]);
    const saved = await disk();
    assert.deepEqual([saved.steeringMode, saved.followUpMode, saved.compaction.enabled, saved.retry.enabled], ["all", "all", true, false]);
    assert.deepEqual(saved.unknownTopLevel, { keep: true });
    assert.equal((await item(other, "steeringMode")).runtime, "all", "another page sees the session's value");
    assert.equal((await children()).length, before, "no child was restarted");
    await set(client, "compaction.enabled", false, true);
  });
  await check("SET-08", "while pi is replying, a session setting is refused and a saved default waits; the reply is not interrupted", async () => {
    const slow = await client.command("prompt", { text: "M0_SLOW_M31_SETTINGS", mode: "followUp" }); assert.equal(slow.ack.status, "dispatched");
    await waitFor(() => client.snapshot?.state.running, "running reply");
    await rejects(set(other, "steeringMode", "one-at-a-time", "all"), "busy");
    const blocked = await set(other, "images.blockImages", true, null); assert.deepEqual([blocked.saved, blocked.applied], ["confirmed", "pending"]);
    assert.equal((await hostQuery(client, "settings")).pendingApply, true);
    await rejects(hostCommand(other, "account_apply"), "busy");
    await waitFor(() => client.snapshot?.state.idle && !client.snapshot.state.running, "reply settled", 30_000);
    assert.ok(client.snapshot.session.messages.some(message => JSON.stringify(message.content).includes("M0_REPLY:M0_SLOW_M31_SETTINGS:")), "the reply completed");
    assert.equal((await hostQuery(client, "settings")).pendingApply, true, "the end of the reply did not apply it");
    assert.equal((await disk()).steeringMode, "all");
  });
  await check("SET-APPLY", "a saved setting the session reads once is applied by reloading the session in the same child", async () => {
    const before = (await children()).length, image = [{ mimeType: "image/png", data: png(8, 8).toString("base64") }];
    // pi replaces a blocked image with a note in the message, so the provider's input is matched by its start.
    const seen = async text => {
      const operation = await client.command("prompt", { text, mode: "followUp", images: image }); assert.equal(operation.ack.status, "dispatched", operation.ack.error?.message);
      assert.equal((await commandResult(client, operation.frame)).status, "completed");
      const call = await waitFor(async () => (await fixture.events()).find(entry => entry.event === "provider_call" && String(entry.input).startsWith(text)), `provider call for ${text}`, 30_000);
      await waitFor(() => client.snapshot?.state.idle && !client.snapshot.state.running, `settled ${text}`, 30_000);
      return call.images?.length ?? 0;
    };
    // Saved while busy in the check before: the running session still sends images.
    assert.equal(await seen("M31_IMAGE_BEFORE_APPLY"), 1);
    await hostCommand(client, "account_apply"); assert.equal((await hostQuery(client, "settings")).pendingApply, false);
    assert.equal(await seen("M31_IMAGE_AFTER_APPLY"), 0, "pi no longer sends the image");
    assert.equal(client.snapshot.session.id, sessionId, "same session"); assert.equal((await children()).length, before, "same child");
    // Idle: saving applies at once.
    assert.equal((await set(client, "images.blockImages", false, true)).applied, "pending");
    await waitFor(async () => !(await hostQuery(client, "settings")).pendingApply, "applied when idle", 20_000);
    assert.equal(await seen("M31_IMAGE_UNBLOCKED"), 1);
    assert.equal((await children()).length, before);
    report.realModelCalls = 0;
  });
  await check("SET-07", "saving a default model does not change the running session; the start argument is shown as an override", async () => {
    const before = client.snapshot.state.model; const entry = await item(client, "defaultModel");
    assert.equal(entry.cli, "pi-pane-m0/deterministic"); assert.equal(entry.global, "pi-pane-m0/deterministic");
    const target = entry.options.find(option => option !== entry.global); assert.ok(target, "the fixture offers a second model");
    const result = await set(client, "defaultModel", target, entry.global); assert.deepEqual([result.saved, result.applied], ["confirmed", "later"]);
    const saved = await disk(); assert.equal(`${saved.defaultProvider}/${saved.defaultModel}`, target);
    await reply(client, "M31_AFTER_DEFAULT_MODEL");
    assert.deepEqual([client.snapshot.state.model.provider, client.snapshot.state.model.id], [before.provider, before.id]);
    await rejects(set(client, "defaultModel", "nobody/nothing", target), "invalid_setting");
    return { savedDefault: target };
  });
  await check("SET-03", "a field changed by another program is kept; a broken or read-only global file is never overwritten and never reported as saved", async () => {
    const raw = await disk(); raw.externalField = ["added elsewhere"]; await writeFile(settingsPath, JSON.stringify(raw));
    await set(client, "hideThinkingBlock", false, true);
    assert.deepEqual((await disk()).externalField, ["added elsewhere"]);
    const good = await readFile(settingsPath, "utf8");
    await writeFile(settingsPath, "{ \"theme\": ");
    const view = await hostQuery(client, "settings");
    assert.equal(view.errors[0].scope, "global"); assert.ok(view.items.every(entry => !entry.editable && entry.reason === "unreadable"));
    await rejects(set(client, "theme", "dark", null), "settings_unreadable");
    assert.equal(await readFile(settingsPath, "utf8"), "{ \"theme\": ");
    await writeFile(settingsPath, good);
    if (process.getuid?.() !== 0) {
      await chmod(settingsPath, 0o400);
      try { await rejects(set(client, "defaultThinkingLevel", "off", (await disk()).defaultThinkingLevel), "save_failed"); assert.equal(await readFile(settingsPath, "utf8"), good); }
      finally { await chmod(settingsPath, 0o600); }
    }
    assert.equal((await item(client, "theme")).editable, true, "the page recovers once the file is readable again");
    await reply(client, "M31_AFTER_BROKEN_SETTINGS");
  });
  await check("SET-09", "unknown settings are refused by the protocol, and the settings view carries no secret, command or identifier", async () => {
    assert.equal(await refused(client, { key: "httpProxy", value: "http://evil.invalid", expected: null }), "invalid_args");
    assert.equal(await refused(client, { key: "theme", value: "dark", expected: "m31-user", scope: "project" }), "invalid_args");
    assert.equal(await refused(client, { key: "theme", value: { raw: "json" }, expected: null }), "invalid_args");
    assert.ok(!(await readFile(settingsPath, "utf8")).includes("evil.invalid"));
    const view = await hostQuery(client, "settings"), wire = JSON.stringify(view);
    for (const secret of [SECRET, "m31-wrapper", "proxy.invalid"]) assert.equal(wire.includes(secret), false, secret);
    const all = Object.fromEntries(view.groups.flatMap(group => group.settings.map(entry => [entry.key, entry])));
    assert.deepEqual(all.httpProxy, { key: "httpProxy", where: ["global"] }); assert.deepEqual(all.shellCommandPrefix, { key: "shellCommandPrefix", where: ["global"] });
    assert.deepEqual(all["images.autoResize"], { key: "images.autoResize", where: ["global"], value: "true" });
    const frames = JSON.stringify(clients.flatMap(entry => entry.frames));
    for (const secret of [SECRET, "m31-wrapper"]) assert.equal(frames.includes(secret), false, `${secret} in a frame`);
    await rejects((async () => { const operation = await client.command("prompt", { text: "/settings" }); if (operation.ack.status !== "dispatched") throw Object.assign(new Error("rejected"), { code: operation.ack.error?.code }); const result = await commandResult(client, operation.frame); if (result.status !== "completed") throw Object.assign(new Error("failed"), { code: result.error?.code }); })(), "picker_required");
    return { readOnlySettings: Object.keys(all).length };
  });
  await check("THM-05", "another project's themes and settings are read only once it is trusted, and do not follow you back", async () => {
    const gated = join(base0, "gated"); await mkdir(join(gated, ".pi", "themes"), { recursive: true });
    await writeFile(join(gated, ".pi", "themes", "theirs.json"), theme("m31-theirs", "#c0ffee", "light"));
    await writeFile(join(gated, ".pi", "settings.json"), JSON.stringify({ theme: "m31-theirs", images: { blockImages: true } }));
    await hostCommand(client, "project_open", { path: gated, trust: "withhold" });
    await waitFor(() => client.snapshot?.session.cwd === gated, "snapshot of the gated project", 30_000);
    let view = await hostQuery(client, "themes");
    assert.equal(view.projectThemes, "untrusted"); assert.equal(view.themes.some(entry => entry.name === "m31-theirs"), false);
    assert.equal(view.pi.name, "m31-user"); assert.equal(accent(client), "#13579b", "pi's global default, not the untrusted project's theme");
    let settings = await hostQuery(client, "settings"); assert.equal(settings.project.settings, "untrusted");
    assert.equal(settings.items.find(entry => entry.key === "theme").project, undefined);
    await hostCommand(client, "project_open", { path: gated, trust: "remember" });
    await waitFor(() => client.snapshot && accent(client) === "#c0ffee", "the trusted project's theme", 30_000);
    view = await hostQuery(client, "themes");
    assert.equal(view.projectThemes, "loaded"); assert.deepEqual(view.pi, { setting: "m31-theirs", source: "project", name: "m31-theirs", appearance: "light", origin: "catalog" });
    settings = await hostQuery(client, "settings"); assert.equal(settings.project.settings, "loaded");
    const themeItem = settings.items.find(entry => entry.key === "theme");
    assert.deepEqual([themeItem.global, themeItem.project, themeItem.effective], ["m31-user", "m31-theirs", "m31-theirs"]);
    assert.equal(themeItem.options.includes("m31-theirs"), false);
    // THM-09: a project's own theme cannot become the default for every project.
    await rejects(set(client, "theme", "m31-theirs", "m31-user"), "theme_not_global");
    // SET-05: saving the global default here succeeds, and the project still decides.
    const result = await set(client, "theme", "dark", "m31-user");
    assert.deepEqual([result.saved, result.applied, result.item.global, result.item.effective], ["confirmed", "overridden", "dark", "m31-theirs"]);
    assert.equal(accent(client), "#c0ffee");
    const blocked = settings.items.find(entry => entry.key === "images.blockImages"); assert.deepEqual([blocked.global, blocked.project, blocked.effective], [false, true, true]);
    await hostCommand(client, "project_open", { path: await realpath(fixture.cwd) });
    await waitFor(() => client.snapshot?.session.cwd === fixture.cwd || client.snapshot?.session.cwd?.endsWith("/workspace"), "back in the start project", 30_000);
    view = await hostQuery(client, "themes");
    assert.equal(view.themes.some(entry => entry.name === "m31-theirs"), false); assert.deepEqual([view.pi.setting, view.pi.name, view.pi.source], ["dark", "dark", "global"]);
    await waitFor(() => accent(client) !== "#c0ffee", "the other project's theme is gone");
  });
  await check("THM-06", "a default theme that disappears keeps the page usable: follow pi falls back to the handoff colors and says why", async () => {
    await set(client, "theme", "m31-user", "dark");
    await waitFor(() => accent(client) === "#13579b", "user theme shown");
    await writeFile(join(fixture.agentDir, "themes", "m31-user.json"), "{ broken");
    const view = await hostQuery(client, "themes");
    assert.deepEqual([view.pi.setting, view.pi.origin, view.pi.reason], ["m31-user", "handoff", "missing"]);
    assert.ok(view.problems.some(problem => problem.file === "m31-user.json" && problem.code === "invalid_json"));
    await waitFor(() => client.snapshot && accent(client) !== "#13579b" && /^#[0-9a-f]{6}$/i.test(accent(client)), "fallback colors");
    await reply(client, "M31_AFTER_THEME_REMOVED");
  });
  report.status = "passed";
} catch (error) { report.status = "failed"; report.error = String(error.stack ?? error); process.exitCode = 1; console.error(report.error); }
finally {
  for (const client of clients) await client.close().catch(() => {});
  for (const fixture of fixtures) { await fixture.close().catch(() => {}); await fixture.remove().catch(() => {}); }
  report.finishedAt = new Date().toISOString();
  await writeFile(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.status.toUpperCase()} — ${report.checks.filter(item => item.status === "passed").length}/${report.checks.length} checks; report: ${join(out, "report.json")}`);
}
