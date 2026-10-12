#!/usr/bin/env node
/** Frozen 0.2 → current → frozen 0.2 native files, cached-page refresh, and CLI model continuity. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { PROTOCOL } from "../dist/protocol/index.js";
import { startFixture, openClient, commandResult, workbenchQuery, waitFor } from "./m0-smoke.mjs";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.env.PI_M31_REPORT_DIR || "build-artifacts/m3.1/compat");
const archive = resolve(process.env.PI_M31_FROZEN_ARCHIVE || "build-artifacts/releases/0.2.0/candidate/lilibonk-pi-pane-0.2.0.tgz");
const currentExtension = join(project, "dist/extension/index.js");
const SENTINEL = "sk-M31-COMPAT-sentinel-not-a-provider-key";
const unknown = { nested: { future: ["keep", 31, true] }, label: "unknown fields survive the upgrade and downgrade" };
const pause = ms => new Promise(done => setTimeout(done, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const redact = value => String(value).split(SENTINEL).join("[SENTINEL]").replace(/#t=[A-Za-z0-9_-]+/g, "#t=[REDACTED]").replace(/pi-pane\.bearer\.[A-Za-z0-9_-]+/g, "pi-pane.bearer.[REDACTED]");
const stripAnsi = value => value.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
const report = { startedAt: new Date().toISOString(), scope: "M31-E2E-06 / M31-E2E-12", status: "running", checks: [],
  realTui: true, realModelCalls: 0, providerRequests: 0, browser: "system Chrome via headless Playwright",
  isolation: "temporary HOME/agent/workspace, allowlisted environment, PI_OFFLINE=1, deterministic local provider, sentinel credential",
  protocol: PROTOCOL, screenshots: [], pageErrors: [], nativeAssistantModels: [], cleanup: [] };
const fixtures = [], clients = [], browsers = [];
let unpacked, requestNo = 0;
const hostState = client => client.frames.filter(frame => frame.t === "host_state").at(-1);
async function check(id, name, run) {
  const start = Date.now();
  try { const details = await run(); report.checks.push({ id, name, status: "passed", durationMs: Date.now() - start, ...(details ? { details } : {}) }); console.log(`PASS ${id} ${name}`); }
  catch (error) { report.checks.push({ id, name, status: "failed", durationMs: Date.now() - start, error: redact(error.stack ?? error) }); throw error; }
}
async function hostQuery(client, action, args = {}) {
  const reqId = `compat-${++requestNo}`; client.send({ t: "host_query", reqId, action, args });
  const result = await waitFor(() => client.frames.find(frame => frame.t === "host_result" && frame.reqId === reqId), `host query ${action}`);
  if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  return result.value;
}
async function hostCommand(client, command, args = {}) {
  const commandNo = client.nextCommandNo++, id = `${client.clientId}:${commandNo}`;
  client.send({ t: "host_command", clientId: client.clientId, commandNo, id, hostRevision: hostState(client)?.revision ?? 0, command, args });
  const ack = await waitFor(() => client.frames.find(frame => frame.t === "ack" && frame.id === id), `host ack ${command}`);
  if (ack.status !== "dispatched") throw Object.assign(new Error(ack.error?.message ?? "rejected"), { code: ack.error?.code });
  const result = await waitFor(() => client.frames.find(frame => frame.t === "command_result" && frame.id === id), `host result ${command}`, 40_000);
  if (result.status !== "completed") throw Object.assign(new Error(result.error?.message ?? "failed"), { code: result.error?.code });
  return result.value;
}
async function command(client, name, args = {}) {
  const operation = await client.command(name, args); assert.equal(operation.ack.status, "dispatched", operation.ack.error?.message);
  const result = await commandResult(client, operation.frame); assert.equal(result.status, "completed", result.error?.message); return result.value;
}
async function reply(client, text, model) {
  await command(client, "prompt", { text, mode: "followUp" }); await client.settled(text);
  await verifyNativeModel(client, text, model);
}
async function verifyNativeModel(client, text, model) {
  if (model) {
    const file = (await client.compatFixture.events()).filter(event => event.event === "m31_session" && event.mode === "rpc").at(-1).sessionFile;
    const entries = (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const assistant = entries.find(entry => entry.message?.role === "assistant" && entry.message.content.some(part => part.type === "text" && part.text.startsWith(`M0_REPLY:${text}:`)));
    assert.equal(assistant?.message.model, model, "the native assistant entry records the expected model");
    report.nativeAssistantModels.push({ prompt: text, model: assistant.message.model, sessionId: client.snapshot.session.id });
  }
}
async function start(options = {}, extension = currentExtension) {
  const saved = process.env.PI_M0_EXTENSION; process.env.PI_M0_EXTENSION = extension;
  try { const fixture = await startFixture(options); fixtures.push(fixture); return fixture; }
  finally { if (saved === undefined) delete process.env.PI_M0_EXTENSION; else process.env.PI_M0_EXTENSION = saved; }
}
async function connect(fixture, protocol = PROTOCOL) { const client = await openClient(fixture.url, undefined, { protocol }); client.compatFixture = fixture; clients.push(client); return client; }
async function stop(fixture, client) {
  await client?.close(); fixture.write("\u0003");
  await waitFor(() => fixture.exitCode !== undefined, "foreground stopped", 20_000);
  assert.equal(fixture.exitCode, 0); await fixture.close();
}
/** Restart the actual foreground pi against exactly the same private files and saved transcript. */
async function restart(original, extension, sessionFile) {
  const argv = original.argv.map(item => item === original.extension ? extension : item);
  const session = argv.indexOf("--session"); assert.ok(session >= 0); argv[session + 1] = sessionFile;
  const proc = spawn("python3", [join(project, "scripts/pty-host.py")], { stdio: ["pipe", "pipe", "pipe"] });
  const fixture = { ...original, proc, extension, argv, terminal: "", processError: "", exitCode: undefined, url: undefined,
    write(data) { if (proc.stdin.writable && !proc.stdin.destroyed) proc.stdin.write(`${JSON.stringify({ type: "write", data })}\n`); },
    async close() { if (proc.exitCode === null) { proc.stdin.write(`${JSON.stringify({ type: "terminate" })}\n`); await Promise.race([new Promise(done => proc.once("exit", done)), pause(5000)]); if (proc.exitCode === null) proc.kill("SIGKILL"); } },
    async remove() {},
  };
  fixtures.push(fixture);
  const previousStarts = (await original.events()).filter(event => event.event === "session_start").length;
  proc.stdin.on("error", () => {}); proc.stderr.on("data", data => { fixture.processError += data; });
  proc.on("error", error => { fixture.processError += error; fixture.exitCode = -1; }); proc.on("exit", code => { fixture.exitCode = code; });
  createInterface({ input: proc.stdout }).on("line", line => {
    const item = JSON.parse(line);
    if (item.type === "output") {
      fixture.terminal = (fixture.terminal + item.data).slice(-1_000_000);
      const urls = [...stripAnsi(fixture.terminal).matchAll(/http:\/\/127\.0\.0\.1:\d+\/#t=[A-Za-z0-9_-]+/g)];
      if (urls.length) fixture.url = urls.at(-1)[0]; if (item.data.includes("\u001b[6n")) fixture.write("\u001b[1;1R");
    } else if (item.type === "started") fixture.hostPid = item.pid; else if (item.type === "exit") fixture.exitCode = item.code;
  });
  proc.stdin.write(`${JSON.stringify({ argv, env: original.env, cwd: original.cwd, controllingTty: true })}\n`);
  try {
    await waitFor(async () => (await original.events()).filter(event => event.event === "session_start").length > previousStarts, "restarted pi TUI");
    await pause(150); fixture.write("/web\r");
    await waitFor(() => { if (fixture.exitCode !== undefined) throw new Error(`pi exited ${fixture.exitCode}`); return fixture.url; }, "restarted /web", 30_000);
    return fixture;
  } catch (error) { throw new Error(`${error.message}\n${redact(stripAnsi(fixture.terminal + fixture.processError)).slice(-4000)}`); }
}
async function screenshot(page, name) { await page.screenshot({ path: join(out, `${name}.png`), animations: "disabled" }); report.screenshots.push(`${name}.png`); }
async function browserFor(fixture) {
  const browser = await chromium.launch({ channel: "chrome", headless: true }); browsers.push(browser);
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", error => report.pageErrors.push(redact(error.message)));
  return { browser, page };
}
async function openSidebar(page) {
  const sidebar = page.locator(".workspace-sidebar");
  if (await sidebar.getAttribute("aria-hidden") === "true") await page.getByRole("button", { name: "打开工作区与会话", exact: true }).click();
  return sidebar;
}
async function openSettings(page, section) {
  if (!await page.locator(".settings-dialog").isVisible()) { await openSidebar(page); await page.getByRole("button", { name: "设置", exact: true }).click(); }
  await page.getByRole("group", { name: "设置分类" }).getByRole("button", { name: section, exact: true }).click();
}
async function closeSettings(page) {
  await page.locator(".settings-head").getByRole("button", { name: "关闭", exact: true }).click();
  await page.locator(".settings-dialog").waitFor({ state: "detached" });
}
async function browserReply(page, client, text, model) {
  const composer = page.getByRole("textbox", { name: "消息", exact: true });
  await composer.fill(text); await page.getByRole("button", { name: "发送 ↗", exact: true }).click();
  await client.settled(text); await verifyNativeModel(client, text, model);
}
async function openProject(page, target) {
  const sidebar = await openSidebar(page), add = sidebar.locator(".project-add-menu");
  await add.locator("summary").click(); await add.getByRole("button", { name: "打开项目", exact: true }).click();
  const address = page.getByRole("textbox", { name: "文件夹的绝对路径" });
  await waitFor(async () => !!await address.inputValue(), "initial directory loaded");
  await address.fill(target); await page.getByRole("button", { name: "前往", exact: true }).click();
  await page.getByText("没有子文件夹。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "打开此文件夹", exact: true }).click();
}

await mkdir(out, { recursive: true });
try {
  report.sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: project, encoding: "utf8" }).trim();
  report.workingTreeDiffSha256 = createHash("sha256").update(execFileSync("git", ["diff", "--binary"], { cwd: project })).digest("hex");
  report.currentBuild = Object.fromEntries(await Promise.all(["dist/extension/index.js", "web-dist/index.html"].map(async path => [path, createHash("sha256").update(await readFile(join(project, path))).digest("hex")])));
  const archiveBytes = await readFile(archive); report.frozenArchive = { path: archive, sha256: createHash("sha256").update(archiveBytes).digest("hex") };
  unpacked = await mkdtemp(join(tmpdir(), "pi-pane-m31-frozen-"));
  execFileSync("tar", ["-xzf", archive, "-C", unpacked]);
  const frozen = join(unpacked, "package"), frozenExtension = join(frozen, "dist/extension/index.js");
  assert.equal(JSON.parse(await readFile(join(frozen, "package.json"), "utf8")).version, "0.2.0");
  await symlink(join(project, "node_modules"), join(frozen, "node_modules"), "dir");
  // The real current HTTP server serves the frozen files. Intercepted HTML in Chromium loses
  // its network address-space metadata and triggers Local Network Access checks for WebSockets.
  // A private copy avoids that browser-test artifact without disabling any browser checks.
  const cached = join(unpacked, "current-with-cached-page"); await mkdir(cached);
  for (const name of ["dist", "themes", "theme-decorations", "package.json"]) await cp(join(project, name), join(cached, name), { recursive: true });
  await cp(join(frozen, "web-dist"), join(cached, "web-dist"), { recursive: true });
  await symlink(join(project, "node_modules"), join(cached, "node_modules"), "dir");
  const cachedExtension = join(cached, "dist/extension/index.js");
  let old, oldClient, upgraded, upgradedClient, sessionFile, sessionId, settingsPath, authPath;

  await check("COMPAT-01", "the frozen 0.2 package creates and reads native settings, authentication and history", async () => {
    old = await start({ extraExtensions: ["tests/fixtures/m31-probe.ts"], settings: { m31FutureUnknown: unknown, retry: { enabled: true, m31FutureUnknown: [1, 2, 3] } },
      prepareAgentDir: async agentDir => writeFile(join(agentDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: SENTINEL } }), { mode: 0o600 }) }, frozenExtension);
    report.piVersion = old.piVersion; oldClient = await connect(old, "pi-pane.v1");
    assert.ok((await workbenchQuery(oldClient, "resources")).models.some(model => model.provider === "openai"), "the old package reads the native sentinel API-key entry");
    await reply(oldClient, "M31_COMPAT_FROM_020", "deterministic"); sessionId = oldClient.snapshot.session.id;
    sessionFile = (await old.events()).filter(event => event.event === "m31_session" && event.mode === "rpc").at(-1).sessionFile;
    settingsPath = join(old.agentDir, "settings.json"); authPath = join(old.agentDir, "auth.json");
    assert.ok(sessionFile); assert.equal(JSON.parse((await readFile(sessionFile, "utf8")).split("\n")[0]).type, "session");
    await stop(old, oldClient);
    return { version: "0.2.0", protocol: "pi-pane.v1", sessionId, nativeAuthReadable: true, nativeTranscriptReadable: true };
  });
  await check("COMPAT-02", "the current package resumes 0.2 data, updates settings and leaves unknown fields intact", async () => {
    upgraded = await restart(old, cachedExtension, sessionFile); upgradedClient = await connect(upgraded);
    assert.equal(upgradedClient.snapshot.session.id, sessionId); assert.equal(upgradedClient.users("M31_COMPAT_FROM_020").length, 1);
    assert.equal((await hostQuery(upgradedClient, "accounts")).providers.find(provider => provider.id === "openai").stored, "api_key");
    await hostCommand(upgradedClient, "setting_set", { key: "images.blockImages", value: true, expected: null });
    await waitFor(async () => !(await hostQuery(upgradedClient, "settings")).pendingApply, "settings applied");
    const settings = JSON.parse(await readFile(settingsPath, "utf8")); assert.deepEqual(settings.m31FutureUnknown, unknown); assert.deepEqual(settings.retry.m31FutureUnknown, [1, 2, 3]);
    assert.equal(settings.images.blockImages, true); assert.equal(JSON.parse(await readFile(authPath, "utf8")).openai.key, SENTINEL);
    await hostCommand(upgradedClient, "project_open", { path: upgradedClient.snapshot.session.cwd });
    assert.ok(await stat(join(old.agentDir, "pi-pane", "projects.json")), "the new project registry exists beside native files");
    await reply(upgradedClient, "M31_COMPAT_FROM_CURRENT", "deterministic");
    return { sessionId, unknownTopLevelPreserved: true, unknownNestedPreserved: true, separateProjectRegistry: true };
  });
  await check("COMPAT-03", "actual cached 0.2 page asks to refresh once; the refreshed current page connects", async () => {
    const { browser, page } = await browserFor(upgraded);
    const served = new Set(), notices = []; let sockets = 0; page.on("websocket", socket => { sockets++; socket.on("framereceived", ({ payload }) => { try { const frame = JSON.parse(String(payload)); if (frame.t === "error") notices.push({ t: frame.t, error: frame.error }); } catch {} }); });
    page.on("response", response => { const path = new URL(response.url()).pathname; if (path === "/" || path === "/pi-pane.css" || path.startsWith("/assets/")) served.add(path); });
    await page.goto(upgraded.url);
    try { await page.getByText("网页版本已过期，请刷新页面以加载新版 pi-pane。", { exact: false }).waitFor({ state: "visible" }); }
    catch (error) { await screenshot(page, "old-page-failure"); report.oldPageDiagnostic = { body: redact(await page.locator("body").innerText()).slice(-4000), notices, sockets, served: [...served] }; throw error; }
    await pause(1600); assert.equal(sockets, 1, "the frozen page stops reconnecting after the fatal refresh notice");
    assert.ok([...served].some(path => path.endsWith("index-CPuYq6WV.js")), "the actual frozen 0.2 browser bundle ran");
    await screenshot(page, "old-page-refresh-required");
    const frozenAssetsServed = [...served].sort();
    await rm(join(cached, "web-dist"), { recursive: true }); await cp(join(project, "web-dist"), join(cached, "web-dist"), { recursive: true }); await page.reload();
    await page.locator(".composer textarea").waitFor({ state: "visible" }); await waitFor(() => page.locator(".composer textarea").isEnabled(), "current page enabled");
    await page.getByText("M31_COMPAT_FROM_CURRENT", { exact: true }).waitFor({ state: "visible" });
    await screenshot(page, "current-page-after-refresh"); await browser.close();
    return { frozenAssetsServed, oldPageWebSocketAttempts: 1, refreshedProtocol: PROTOCOL, actualHttpServer: true, browserChecksDisabled: false };
  });
  await check("COMPAT-04", "the frozen 0.2 package reopens the updated native files and ignores the new registry", async () => {
    await stop(upgraded, upgradedClient); const downgraded = await restart(old, frozenExtension, sessionFile); const client = await connect(downgraded, "pi-pane.v1");
    assert.equal(client.snapshot.session.id, sessionId); assert.equal(client.users("M31_COMPAT_FROM_020").length, 1); assert.equal(client.users("M31_COMPAT_FROM_CURRENT").length, 1);
    assert.ok((await workbenchQuery(client, "resources")).models.some(model => model.provider === "openai"));
    await reply(client, "M31_COMPAT_BACK_TO_020", "deterministic");
    const settings = JSON.parse(await readFile(settingsPath, "utf8")); assert.deepEqual(settings.m31FutureUnknown, unknown); assert.deepEqual(settings.retry.m31FutureUnknown, [1, 2, 3]);
    assert.equal(settings.images.blockImages, true); assert.equal(JSON.parse(await readFile(authPath, "utf8")).openai.key, SENTINEL);
    const native = await readFile(sessionFile, "utf8"); for (const marker of ["M31_COMPAT_FROM_020", "M31_COMPAT_FROM_CURRENT", "M31_COMPAT_BACK_TO_020"]) assert.ok(native.includes(marker));
    assert.ok(!native.includes(SENTINEL)); await stop(downgraded, client);
    return { oldPackageReadsUpdatedTranscript: true, oldPackageReadsNativeAuth: true, unknownFieldsPreserved: true };
  });

  const modelFixture = await start({ extraExtensions: ["tests/fixtures/m31-probe.ts", "tests/fixtures/m31-compat.ts"], envOverrides: { PI_M31_COMPAT: "1" } });
  const modelRoot = await realpath(modelFixture.directory);
  const client = await connect(modelFixture); const originalSession = client.snapshot.session.id;
  const { browser: modelBrowser, page: modelPage } = await browserFor(modelFixture);
  report.modelBrowserActions = [];
  modelPage.on("websocket", socket => socket.on("framesent", ({ payload }) => {
    try { const frame = JSON.parse(String(payload)); if (frame.t === "command" || frame.t === "host_command") report.modelBrowserActions.push({ type: frame.t, command: frame.command }); } catch {}
  }));
  await modelPage.goto(modelFixture.url); await modelPage.getByText("已连接", { exact: true }).waitFor();
  await waitFor(() => modelPage.getByLabel("模型", { exact: true }).isEnabled(), "browser runtime ready");
  const assertY = async label => { assert.equal(client.snapshot.state.model.id, "deterministic-thinking", label); assert.equal(client.snapshot.session.id, originalSession); await browserReply(modelPage, client, label, "deterministic-thinking"); };
  const vetoNextReload = () => writeFile(join(modelFixture.agentDir, "compat-reload-veto-once"), "exercise explicit Apply after one extension veto", { mode: 0o600 });
  await check("MODEL-01", "real browser model selection, credential Apply and setting Apply preserve model Y", async () => {
    assert.equal(client.snapshot.state.model.id, "deterministic");
    await modelPage.getByLabel("模型", { exact: true }).selectOption(JSON.stringify({ provider: "pi-pane-m0", id: "deterministic-thinking" }));
    await waitFor(() => client.snapshot.state.model.id === "deterministic-thinking", "browser selected Y"); await assertY("M31_MODEL_SELECTED_Y");
    await openSettings(modelPage, "账户"); await modelPage.getByRole("searchbox", { name: "查找服务商" }).fill("OpenAI");
    const openai = modelPage.locator(".account-item").filter({ has: modelPage.locator(".account-identity strong").getByText("OpenAI", { exact: true }) });
    await openai.getByRole("button", { name: "用 API key 登录", exact: true }).click();
    await modelPage.locator("#account-step-input").fill(SENTINEL); await vetoNextReload();
    await modelPage.getByRole("button", { name: "提交", exact: true }).click();
    await modelPage.getByRole("heading", { name: "OpenAI 的凭据已保存", exact: true }).waitFor();
    await waitFor(async () => { const view = await hostQuery(client, "accounts"); return view.pendingApply && view.applyError; }, "account saved, first reload declined");
    await modelPage.getByRole("button", { name: "关闭", exact: true }).click();
    await modelPage.locator(".account-banner").getByRole("button", { name: "立即应用", exact: true }).waitFor({ state: "visible" });
    await screenshot(modelPage, "model-y-account-pending");
    await modelPage.locator(".account-banner").getByRole("button", { name: "立即应用", exact: true }).click();
    await waitFor(async () => !(await hostQuery(client, "accounts")).pendingApply, "browser applied account", 20_000);
    assert.equal(JSON.parse(await readFile(join(modelFixture.agentDir, "auth.json"), "utf8")).openai.key, SENTINEL);
    await closeSettings(modelPage); await assertY("M31_MODEL_AFTER_ACCOUNT");
    await openSettings(modelPage, "会话行为"); await modelPage.getByRole("switch", { name: "不向模型发送图片", exact: true }).check(); await vetoNextReload();
    const imageSetting = modelPage.locator(".setting-row").filter({ has: modelPage.locator("#setting-images-blockImages") });
    await imageSetting.getByRole("button", { name: "保存", exact: true }).click();
    await waitFor(async () => { const view = await hostQuery(client, "settings"); return view.pendingApply && view.applyError; }, "setting saved, first reload declined");
    await modelPage.locator(".setting-banner").getByRole("button", { name: "立即应用", exact: true }).waitFor({ state: "visible" });
    await screenshot(modelPage, "model-y-setting-pending");
    await modelPage.locator(".setting-banner").getByRole("button", { name: "立即应用", exact: true }).click();
    await waitFor(async () => !(await hostQuery(client, "settings")).pendingApply, "browser applied setting", 20_000);
    assert.equal(JSON.parse(await readFile(join(modelFixture.agentDir, "settings.json"), "utf8")).images.blockImages, true);
    await closeSettings(modelPage); await assertY("M31_MODEL_AFTER_SETTING");
    assert.equal((await modelFixture.events()).filter(event => event.event === "m31_compat_reload_veto").length, 2);
    return { input: "real DOM controls", cliModel: "pi-pane-m0/deterministic", chosenModel: "pi-pane-m0/deterministic-thinking", sessionId: originalSession, accountAndSettingExplicitApply: true, automaticApplyVetoedOnceEachByFixture: true, actualAssistantModelsVerified: true };
  });
  await check("MODEL-02", "real browser opens a project, then clicks recovery to restore the saved session with model Y", async () => {
    const target = join(modelRoot, "new-project"); await mkdir(target); await writeFile(join(modelFixture.agentDir, "compat-stop-once"), "shutdown needs a dialog", { mode: 0o600 });
    await openProject(modelPage, target);
    await waitFor(() => hostState(client).phase === "recovery_required", "browser project replacement failed", 40_000);
    assert.ok((await modelFixture.events()).some(event => event.event === "m31_compat_shutdown_dialog"));
    await modelPage.getByRole("button", { name: /^回到上一个项目/ }).waitFor(); await screenshot(modelPage, "model-y-recovery-required");
    await modelPage.getByRole("button", { name: /^回到上一个项目/ }).click();
    await waitFor(() => hostState(client).phase === "ready" && client.snapshot?.session.id === originalSession, "browser restored snapshot");
    await assertY("M31_MODEL_AFTER_RECOVERY"); await screenshot(modelPage, "model-y-restored");
    return { input: "real DOM controls", failure: "shutdown requires interaction", explicitRecoveryButton: "回到上一个项目", sameSessionAndModel: true };
  });
  await check("MODEL-03", "browser-created sessions use CLI model X and the page explains model and environment sources", async () => {
    await openSidebar(modelPage); await modelPage.getByRole("button", { name: "新建会话", exact: true }).click();
    await waitFor(() => client.snapshot.session.id !== originalSession, "browser new session"); assert.equal(client.snapshot.state.model.id, "deterministic");
    await browserReply(modelPage, client, "M31_MODEL_NEW_SAME_PROJECT_X", "deterministic");
    const target = join(modelRoot, "new-project"); await openProject(modelPage, target);
    await waitFor(() => client.snapshot?.session.cwd === target, "new project snapshot"); assert.notEqual(client.snapshot.session.id, originalSession); assert.equal(client.snapshot.state.model.id, "deterministic");
    await modelPage.locator(".dialog-backdrop").waitFor({ state: "detached" }); await browserReply(modelPage, client, "M31_MODEL_NEW_SESSION_X", "deterministic");
    const defaults = await hostQuery(client, "settings"); assert.equal(defaults.items.find(item => item.key === "defaultModel").cli, "pi-pane-m0/deterministic");
    await openSidebar(modelPage); await modelPage.locator(".project-context summary").click();
    await modelPage.getByText("工具和命令使用启动 /web 的那个终端的环境变量。", { exact: true }).waitFor({ state: "visible" });
    await screenshot(modelPage, "project-environment-source"); await openSettings(modelPage, "模型默认");
    const row = modelPage.locator(".setting-row").filter({ has: modelPage.locator("#setting-defaultModel") }); await row.locator("summary").click();
    await row.getByText("启动参数", { exact: true }).waitFor({ state: "visible" }); await row.getByText("pi-pane-m0/deterministic（只对本次启动有效）", { exact: true }).waitFor({ state: "visible" });
    await screenshot(modelPage, "model-cli-source"); await modelBrowser.close();
    return { input: "real DOM controls", newSessionModel: "pi-pane-m0/deterministic", newProjectRuntimeModel: "pi-pane-m0/deterministic", cliSourceVisible: true, originTerminalEnvironmentVisible: true };
  });
  assert.deepEqual(report.modelBrowserActions.map(item => item.command), ["set_model", "prompt", "account_begin", "account_apply", "prompt", "setting_set", "account_apply", "prompt", "project_open", "recover_restore", "prompt", "session_new", "prompt", "project_open", "prompt"], "the browser, not the oracle WebSocket client, issued the complete model continuity chain");
  assert.deepEqual(report.pageErrors, []); report.status = "passed";
} catch (error) { report.status = "failed"; report.error = redact(error.stack ?? error); process.exitCode = 1; console.error(report.error); }
finally {
  for (const browser of browsers) await browser.close().catch(() => {});
  for (const client of clients) await client.close().catch(() => {});
  for (const fixture of [...fixtures].reverse()) {
    await fixture.close().catch(() => {});
    report.cleanup.push({ hostPid: fixture.hostPid, exited: fixture.exitCode !== undefined || fixture.proc.exitCode !== null });
  }
  const children = new Set((await Promise.all(fixtures.map(fixture => fixture.events().catch(() => [])))).flat().filter(event => event.event === "m31_session" && event.mode === "rpc").map(event => event.pid));
  for (const pid of children) {
    try { await waitFor(() => !alive(pid), `RPC child ${pid} exited`, 5000); report.cleanup.push({ childPid: pid, exited: true }); }
    catch (error) { report.cleanup.push({ childPid: pid, exited: false }); report.status = "failed"; report.error ??= redact(error); process.exitCode = 1; }
  }
  for (const fixture of fixtures) await fixture.remove().catch(() => {});
  if (unpacked) await rm(unpacked, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString(); await writeFile(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.status.toUpperCase()} — ${report.checks.filter(item => item.status === "passed").length}/${report.checks.length} checks; ${join(out, "report.json")}`);
}
