#!/usr/bin/env node
/**
 * M31-E2E-01/02: a fresh, isolated HOME per viewport, real TUI /web, and only browser UI actions.
 * A loopback OpenAI-compatible stand-in asks pi to execute a public extension tool, which really
 * writes in the RPC child's cwd. No real provider, user credentials, daily install or browser store
 * mutation. PI_M0_EXTENSION may select the exact installed candidate's dist/extension/index.js;
 * expected themes and asset hashes are then read from that package, never the source checkout.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectTrustStore, SessionManager } from "@earendil-works/pi-coding-agent";
import { colorToHex, parseColor } from "@earendil-works/pi-tui";
import { chromium } from "playwright";
import { startFixture, waitFor } from "./m0-smoke.mjs";

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.env.PI_M31_INTEGRATION_REPORT_DIR || process.env.PI_M31_REPORT_DIR || "build-artifacts/m3.1/integration");
await mkdir(out, { recursive: true });
const report = { startedAt: new Date().toISOString(), scope: "M31-E2E-01/02 real browser main flow and slash/cancel integration",
  browser: "System Google Chrome, headless Playwright", realTui: true, realRemoteModelCalls: 0,
  isolation: "fresh temporary HOME/agent/workspace per viewport, environment allowlist, PI_OFFLINE=1, synthetic API key, loopback stand-in provider",
  limits: ["The endpoint is a deterministic stand-in; this does not prove any real provider or OAuth login.",
    "390×844 is a touch/mobile viewport, not a physical phone or its software keyboard.",
    "Draft retention is checked across project switches in one page; drafts intentionally clear on refresh.",
    "The writing tool is a real public extension tool with bounded fixture-only output, not a builtin shell tool."],
  checks: [], screenshots: [], layouts: [], pageErrors: [], externalRequests: [], runs: [], cleanup: [], status: "running" };
const fixtures = [], secrets = new Set(), diagnosticFrames = [];
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const exists = path => stat(path).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const redact = value => { let text = String(value).replace(/#t=[A-Za-z0-9_-]+/g, "#t=[REDACTED]").replace(/pi-pane\.bearer\.[A-Za-z0-9_-]+/g, "pi-pane.bearer.[REDACTED]"); for (const key of secrets) text = text.replaceAll(key, "[SYNTHETIC_KEY]"); return text; };
let browser, endpoint;

async function check(id, name, run) {
  const began = Date.now();
  try { const details = await run(); report.checks.push({ id, name, status: "passed", durationMs: Date.now() - began, ...(details ? { details } : {}) }); console.log(`PASS ${id} ${name}`); }
  catch (error) { report.checks.push({ id, name, status: "failed", durationMs: Date.now() - began, error: redact(error.stack ?? error) }); throw error; }
}
async function shot(page, name) { await page.screenshot({ path: join(out, `${name}.png`), animations: "disabled" }); report.screenshots.push(`${name}.png`); }
async function layout(page, name) {
  const item = await page.evaluate(() => {
    const visible = node => node.getClientRects().length && getComputedStyle(node).visibility !== "hidden" && !node.closest('[inert], [aria-hidden="true"]');
    const panels = [...document.querySelectorAll(".dialog, .settings-body, .provider-form, .composer, .conversation-panel, .workspace-sidebar")].filter(visible)
      .map(node => ({ class: node.className, width: node.clientWidth, contentWidth: node.scrollWidth }));
    return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth, panels };
  });
  report.layouts.push({ name, ...item });
  assert.ok(item.documentWidth <= item.width + 1, `${name}: no page overflow`);
  assert.deepEqual(item.panels.filter(panel => panel.contentWidth > panel.width + 1), [], `${name}: no panel overflow`);
}
const composer = page => page.getByRole("textbox", { name: "消息", exact: true });
async function closeInspector(page) {
  const toggle = page.locator(".inspect-toggle"), panel = page.locator(".workspace-inspector");
  if (await toggle.getAttribute("aria-expanded") === "true") {
    try { await page.getByRole("button", { name: "关闭工作区面板", exact: true }).click({ timeout: 2_000 }); }
    catch (error) {
      // A project/slash transition can close the panel between the state read and click.
      // Only an already-closed panel satisfies the action; never retry a business command.
      if (await toggle.getAttribute("aria-expanded") !== "false" || await panel.getAttribute("aria-hidden") !== "true") throw error;
    }
  }
  await waitFor(async () => await toggle.getAttribute("aria-expanded") === "false" && await panel.getAttribute("aria-hidden") === "true", "inspector is closed", 5_000);
  await panel.waitFor({ state: "hidden", timeout: 5_000 });
}
async function openSidebar(page) {
  await closeInspector(page);
  const sidebar = page.locator(".workspace-sidebar");
  if (await sidebar.getAttribute("aria-hidden") === "true") await page.getByRole("button", { name: "打开工作区与会话", exact: true }).click();
  await waitFor(async () => await sidebar.getAttribute("aria-hidden") !== "true", "sidebar is open", 5_000);
  await sidebar.waitFor({ state: "visible", timeout: 5_000 });
  return sidebar;
}
async function closeSidebar(page) {
  const toggle = page.locator(".sidebar-toggle"), sidebar = page.locator(".workspace-sidebar");
  if (!await toggle.isVisible()) return; // The desktop sidebar stays open.
  await page.locator(".dialog-backdrop").waitFor({ state: "detached" });
  // A project change may already be closing the drawer. Escape is safe in either state,
  // whereas waiting for its disappearing close button to stabilize can time out.
  await page.keyboard.press("Escape");
  await waitFor(async () => await toggle.getAttribute("aria-expanded") === "false" && await sidebar.getAttribute("aria-hidden") === "true", "mobile sidebar is closed", 5_000);
  await sidebar.waitFor({ state: "hidden", timeout: 5_000 });
}
async function openSettings(page, section = "外观") {
  if (!await page.locator(".settings-dialog").isVisible()) { await openSidebar(page); await page.getByRole("button", { name: "设置", exact: true }).click(); }
  await page.getByRole("group", { name: "设置分类" }).getByRole("button", { name: section, exact: true }).click();
}
async function closeModal(page, titleId) {
  await page.keyboard.press("Escape");
  await page.locator(titleId ? `.dialog[aria-labelledby="${titleId}"]` : ".dialog-backdrop").waitFor({ state: "detached" });
}
async function slash(page, command) { await composer(page).fill(command); await composer(page).press("Control+Enter"); }
async function submit(page, text) { await composer(page).fill(text); await page.getByRole("button", { name: /^(发送 ↗|请求 followUp ↗)$/ }).click(); }
async function projectIs(page, cwd) { await waitFor(async () => { const title = await page.locator(".workbench-project").getAttribute("title"); return title && await realpath(title) === cwd; }, `active project ${cwd}`, 30_000); }
async function switchProject(page, cwd) {
  const sidebar = await openSidebar(page);
  const button = sidebar.locator(".project-item").filter({ has: page.locator(".project-name") });
  const candidates = await button.count();
  let found;
  for (let index = 0; index < candidates; index++) { const title = await button.nth(index).getAttribute("title"); if (title && await realpath(title) === cwd) { found = button.nth(index); break; } }
  assert.ok(found, `project ${cwd} is listed`);
  await found.click(); await projectIs(page, cwd); await closeSidebar(page);
  await waitFor(async () => await page.getByLabel("模型", { exact: true }).isEnabled(), "project is ready", 30_000);
}
async function cancelKeepsFocus(page, dialogId, expected) {
  const dialog = page.locator(`.dialog[aria-labelledby="${dialogId}"]`);
  await dialog.waitFor();
  await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
  assert.ok(await dialog.evaluate(node => node.contains(document.activeElement)), "keyboard focus stays within the dialog");
  await closeModal(page, dialogId);
  await waitFor(() => expected.evaluate(node => node === document.activeElement), "cancel restores focus", 2_000);
}
async function packageSource() {
  const extension = await realpath(resolve(process.env.PI_M0_EXTENSION || join(checkout, "src/extension/index.ts")));
  let root = dirname(extension), metadata;
  for (;;) {
    try { const found = JSON.parse(await readFile(join(root, "package.json"), "utf8")); if (found.name === "@lilibonk/pi-pane") { metadata = found; break; } } catch (error) { if (error.code !== "ENOENT") throw error; }
    const parent = dirname(root); if (parent === root) throw new Error("Cannot locate the selected extension's pi-pane package root."); root = parent;
  }
  const themeFile = join(root, "themes/pi-pane-porcelain.json"), raw = await readFile(themeFile), theme = JSON.parse(raw.toString("utf8"));
  let value = theme.export.pageBg;
  for (let depth = 0; depth < 64 && typeof value === "string" && !/^(#|ok(?:lch|hsl)\()/i.test(value); depth++) value = theme.vars[value];
  const expectedBg = colorToHex(parseColor(value));
  return { root, extension, metadata, expectedBg, evidence: { packageRoot: root, extension, version: metadata.version,
    themeFile, themeSha256: hash(raw), extensionSha256: hash(await readFile(extension)), webIndexSha256: hash(await readFile(join(root, "web-dist/index.html"))),
    selectedByEnvironment: !!process.env.PI_M0_EXTENSION, candidateTarballSha256: process.env.PI_M31_TARBALL_SHA256 || null } };
}

// The fake endpoint contains no credential resolver or external network request implementation.
const requests = [];
const sentinels = new Map();
async function startEndpoint() {
  endpoint = createServer((request, response) => {
    let body = ""; request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      try {
        const parsed = JSON.parse(body), messages = parsed.messages ?? [];
        const tool = messages.at(-1)?.role === "tool" ? messages.at(-1) : undefined;
        const user = [...messages].reverse().find(message => message.role === "user");
        const text = typeof user?.content === "string" ? user.content : user?.content?.filter(part => part.type === "text").map(part => part.text).join("") ?? "";
        const marker = text.match(/M31_INTEGRATION_WRITE_(desktop|mobile)/)?.[0];
        const requestEvidence = { model: parsed.model, marker, toolResult: !!tool, authorizationMatches: request.headers.authorization === `Bearer ${sentinels.get(parsed.model)}`,
          offeredTools: (parsed.tools ?? []).map(item => item.function?.name), role: tool ? "finish" : "tool-call" };
        requests.push(requestEvidence);
        if (!marker || !requestEvidence.authorizationMatches || !requestEvidence.offeredTools.includes("m31_write_proof")) throw new Error("Unexpected integration request.");
        const chunk = delta => response.write(`data: ${JSON.stringify({ id: "m31-integration", object: "chat.completion.chunk", model: parsed.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (tool) {
          const result = typeof tool.content === "string" ? tool.content : JSON.stringify(tool.content);
          requestEvidence.resultContainsMarker = result.includes(marker);
          chunk({ role: "assistant", content: `M31_INTEGRATION_DONE ${marker}. 文件由当前项目中的真实工具写入。` });
        } else chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${marker}`, type: "function", function: { name: "m31_write_proof", arguments: JSON.stringify({ marker }) } }] });
        response.write(`data: ${JSON.stringify({ id: "m31-integration", object: "chat.completion.chunk", model: parsed.model, choices: [{ index: 0, delta: {}, finish_reason: tool ? "stop" : "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
        response.end("data: [DONE]\n\n");
      } catch (error) { requests.push({ error: String(error) }); if (!response.headersSent) response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: "M31 deterministic endpoint rejected an unexpected request." } })); }
    });
  });
  await new Promise(done => endpoint.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${endpoint.address().port}/v1`;
}

try {
  report.sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim();
  const source = await packageSource(); report.artifact = source.evidence;
  const baseUrl = await startEndpoint();
  browser = await chromium.launch({ channel: "chrome", headless: true });
  for (const viewport of [{ name: "desktop", width: 1280, height: 720 }, { name: "mobile", width: 390, height: 844 }]) {
    const name = viewport.name, providerId = `m31-${name}`, modelId = `integration-${name}`, key = `m31-made-up-${name}-key`, marker = `M31_INTEGRATION_WRITE_${name}`;
    secrets.add(key); sentinels.set(modelId, key);
    const configA = { theme: "light", steeringMode: "one-at-a-time", followUpMode: "all" };
    const fixture = await startFixture({ loadThemes: true, loadPromptTemplates: true,
      extraExtensions: [join(checkout, "tests/fixtures/m31-integration-tool.ts")],
      prepareAgentDir: async (agentDir, directory) => {
        const cwd = join(directory, "workspace");
        await mkdir(join(cwd, ".pi", "prompts"), { recursive: true });
        await writeFile(join(cwd, ".pi", "settings.json"), `${JSON.stringify(configA, null, 2)}\n`);
        await writeFile(join(cwd, ".pi", "prompts", "m31-project-a.md"), "---\ndescription: M31_A_ONLY_RESOURCE\n---\nM31_A_TEMPLATE $ARGUMENTS\n");
        new ProjectTrustStore(agentDir).set(await realpath(cwd), true);
      },
    });
    fixtures.push(fixture);
    const root = await realpath(fixture.directory), a = await realpath(fixture.cwd), b = join(root, `${name} 项目 B`), configPath = join(a, ".pi", "settings.json"), configBytes = await readFile(configPath);
    const aDraft = `M31_A_DRAFT_${name}：留在项目 A 的未发送内容`, bDraft = `M31_B_DRAFT_${name}：留在项目 B 的未发送内容`;
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, ...(name === "mobile" ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}) });
    const page = await context.newPage(); page.setDefaultTimeout(15_000);
    const receivedFrames = [];
    page.on("websocket", socket => socket.on("framereceived", event => { receivedFrames.push(String(event.payload)); diagnosticFrames.push(String(event.payload)); }));
    page.on("pageerror", error => report.pageErrors.push({ viewport: name, error: redact(error.message) }));
    page.on("request", request => { const url = new URL(request.url()); if (!["127.0.0.1", "localhost"].includes(url.hostname) && !["data:", "blob:"].includes(url.protocol)) report.externalRequests.push(`${url.origin}${url.pathname}`); });
    const run = { viewport, piVersion: fixture.piVersion, a, b, extension: fixture.extension, proofFile: join(b, "m31-integration-proof.json"), localRequests: 0 };
    report.runs.push(run);
    await page.goto(fixture.url); await page.getByText("已连接", { exact: true }).waitFor(); await projectIs(page, a);
    await waitFor(async () => await page.getByLabel("模型", { exact: true }).isEnabled(), "initial RPC is ready", 30_000);

    await check(`${name}-01`, "fresh HOME starts in A; /settings opens the UI and cancellation returns keyboard focus", async () => {
      assert.deepEqual(JSON.parse(await readFile(join(fixture.agentDir, "auth.json"), "utf8")), {});
      assert.equal(await exists(join(fixture.agentDir, "models.json")), false);
      for (let attempt = 0; attempt < 3; attempt++) {
        // Keep fill and Enter adjacent: this caught an old render reading an empty draft while the
        // live store already contained /settings, which incorrectly sent a prompt to RPC.
        await slash(page, "/settings"); await page.getByRole("heading", { name: "设置", exact: true }).waitFor();
        if (attempt === 0) { await layout(page, `${name}-settings`); await shot(page, `${name}-a-settings`); }
        await cancelKeepsFocus(page, "settings-title", composer(page));
      }
      assert.equal(await page.locator(".message-user").filter({ hasText: "/settings" }).count(), 0);
      assert.equal(await page.locator(".receipt-item").count(), 0, "rapid input did not send a builtin to RPC");
      await composer(page).fill(aDraft);
      await shot(page, `${name}-a-draft`);
    });

    await check(`${name}-02`, "the user creates B from the host directory picker and A's draft is not carried into it", async () => {
      const sidebar = await openSidebar(page), add = sidebar.locator(".project-add-menu");
      await add.locator("summary").click(); await add.getByRole("button", { name: "新建项目", exact: true }).click();
      await page.getByRole("heading", { name: "新建项目", exact: true }).waitFor();
      const address = page.getByRole("textbox", { name: "文件夹的绝对路径" });
      await waitFor(async () => !!await address.inputValue(), "initial directory is loaded");
      await address.fill(root); await page.getByRole("button", { name: "前往", exact: true }).click();
      await page.locator(".directory-item").filter({ hasText: "workspace" }).waitFor();
      await page.getByLabel("新文件夹名", { exact: true }).fill(`${name} 项目 B`);
      await waitFor(async () => await page.locator(".create-preview code").textContent() === b, "correct creation preview");
      await layout(page, `${name}-create-project`); await shot(page, `${name}-create-project`);
      assert.equal(await exists(b), false, "the directory is not created before confirmation");
      await page.getByRole("button", { name: "创建并打开", exact: true }).click();
      await projectIs(page, b); await page.locator(".dialog-backdrop").waitFor({ state: "detached" }); await closeSidebar(page);
      assert.deepEqual(await readdir(b), [], "B starts empty");
      assert.equal(await composer(page).inputValue(), ""); assert.equal(await page.locator(".message").count(), 0);
      await layout(page, `${name}-b-empty`); await shot(page, `${name}-b-empty`);
    });

    await check(`${name}-03`, "a custom local provider is configured entirely through the form", async () => {
      await openSettings(page, "自定义供应商");
      await page.getByRole("button", { name: "添加供应商", exact: true }).click();
      await page.locator("#provider-id").fill(providerId); await page.locator("#provider-url").fill(baseUrl);
      await page.getByLabel("第 1 个模型的 ID").fill(modelId); await page.getByLabel("第 1 个模型的显示名").fill(`M31 ${name} local model`);
      await page.getByLabel("第 1 个模型的上下文长度").fill("32000");
      await layout(page, `${name}-provider-form`); await shot(page, `${name}-provider-form`);
      await page.getByRole("button", { name: "保存", exact: true }).click();
      const row = page.locator(".provider-row").filter({ hasText: providerId }); await row.waitFor();
      await row.getByText("未设置密钥，模型暂时不可用").waitFor();
      const models = JSON.parse(await readFile(join(fixture.agentDir, "models.json"), "utf8"));
      assert.deepEqual(Object.keys(models.providers), [providerId]); assert.equal(models.providers[providerId].baseUrl, baseUrl);
      assert.equal(JSON.stringify(models).includes(key), false);
      await shot(page, `${name}-provider-saved`);
    });

    await check(`${name}-04`, "cancelled key login stores nothing; a synthetic API key then applies and the model becomes selectable", async () => {
      const row = page.locator(".provider-row").filter({ hasText: providerId });
      await row.getByRole("button", { name: "设置密钥", exact: true }).click();
      await page.locator("#account-step-input").waitFor();
      assert.equal(await page.locator("#account-step-input").getAttribute("type"), "password");
      await page.getByRole("button", { name: "取消登录", exact: true }).click();
      await page.getByRole("heading", { name: `${providerId} 登录未完成`, exact: true }).waitFor();
      await page.locator('.dialog[aria-labelledby="account-dialog-title"]').getByRole("button", { name: "关闭", exact: true }).click();
      await page.locator('.dialog[aria-labelledby="account-dialog-title"]').waitFor({ state: "detached" });
      assert.deepEqual(JSON.parse(await readFile(join(fixture.agentDir, "auth.json"), "utf8")), {});
      await row.getByRole("button", { name: "设置密钥", exact: true }).click();
      await page.locator("#account-step-input").fill(key); await page.getByRole("button", { name: "提交", exact: true }).click();
      await page.getByRole("heading", { name: `${providerId} 的凭据已保存`, exact: true }).waitFor();
      await page.locator('.dialog[aria-labelledby="account-dialog-title"]').getByRole("button", { name: "关闭", exact: true }).click();
      await row.getByText("当前会话可用 1 个模型").waitFor(); await closeModal(page, "settings-title");
      assert.equal(JSON.parse(await readFile(join(fixture.agentDir, "auth.json"), "utf8"))[providerId].key, key);
      await page.getByLabel("模型", { exact: true }).selectOption(JSON.stringify({ provider: providerId, id: modelId }));
      await waitFor(async () => await page.getByLabel("模型", { exact: true }).inputValue() === JSON.stringify({ provider: providerId, id: modelId }), "custom model selected");
      assert.equal(await page.evaluate(sentinel => document.documentElement.outerHTML.includes(sentinel) || JSON.stringify({ ...localStorage, ...sessionStorage }).includes(sentinel), key), false);
    });

    await check(`${name}-05`, "the selected package's porcelain theme is applied and persisted only for this browser", async () => {
      await openSettings(page);
      const option = page.getByRole("radio", { name: "pi-pane-porcelain", exact: true }); await option.waitFor(); await option.click();
      await page.getByRole("button", { name: "使用此外观", exact: true }).click(); await option.locator("small").waitFor();
      await waitFor(async () => await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()) === source.expectedBg, "package theme color applied");
      await layout(page, `${name}-theme`); await shot(page, `${name}-theme`); await closeModal(page, "settings-title");
      assert.equal(JSON.parse(await readFile(join(fixture.agentDir, "settings.json"), "utf8")).theme, undefined);
      assert.ok((await readFile(configPath)).equals(configBytes), "project theme file is unchanged");
      assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()), source.expectedBg);
    });

    await check(`${name}-06`, "the newly configured provider calls a real tool which writes only inside B", async () => {
      const before = requests.length;
      await submit(page, marker);
      await page.locator(".message-assistant").filter({ hasText: `M31_INTEGRATION_DONE ${marker}` }).waitFor({ timeout: 30_000 });
      await waitFor(async () => await page.getByLabel("模型", { exact: true }).isEnabled(), "tool round settled");
      const proof = JSON.parse(await readFile(run.proofFile, "utf8"));
      assert.equal(proof.marker, marker); assert.equal(proof.cwd, b); assert.equal(proof.processCwd, b); assert.equal(proof.file, run.proofFile);
      assert.equal(await exists(join(a, "m31-integration-proof.json")), false);
      assert.equal(await exists(join(root, "m31-integration-proof.json")), false);
      const writes = (await fixture.events()).filter(event => event.event === "m31_integration_write");
      assert.equal(writes.length, 1); assert.equal(writes[0].cwd, b); assert.equal(writes[0].processCwd, b);
      const own = requests.slice(before); assert.equal(own.length, 2); assert.ok(own.every(item => item.authorizationMatches)); assert.equal(own[1].resultContainsMarker, true);
      const sessions = (await fixture.events()).filter(event => event.event === "m31_integration_session" && event.mode === "rpc" && event.cwd === b);
      run.sessionFile = sessions.at(-1).sessionFile; run.sessionId = proof.sessionId; run.localRequests = own.length;
      const native = SessionManager.open(run.sessionFile); assert.equal(await realpath(native.getCwd()), b); assert.equal(native.getSessionId(), proof.sessionId);
      assert.ok(native.getEntries().some(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "m31_write_proof"));
      await layout(page, `${name}-tool-result`); await shot(page, `${name}-tool-result`);
      return { providerRequests: own.length, toolWrites: writes.length, file: run.proofFile, cwd: b, sessionId: proof.sessionId };
    });

    await check(`${name}-07`, "slash settings/login/session/export/model/resume route locally, and cancel restores focus without a model request", async () => {
      const before = requests.length;
      for (const [command, heading, dialogId] of [["/settings", "设置", "settings-title"], ["/login", "设置", "settings-title"], ["/session", "会话信息", "session-dialog-title"], ["/export", "导出会话", "session-dialog-title"]]) {
        await slash(page, command); await page.getByRole("heading", { name: heading, exact: true }).waitFor();
        if (command === "/login") await page.getByRole("searchbox", { name: "查找服务商" }).waitFor();
        await layout(page, `${name}-${command.slice(1)}`); await shot(page, `${name}-slash-${command.slice(1)}`);
        await cancelKeepsFocus(page, dialogId, composer(page));
      }
      assert.equal(await exists(join(fixture.agentDir, "pi-pane", "exports")), false, "export cancellation writes no file");
      await slash(page, "/model"); await page.locator(".workspace-inspector .model-resource").filter({ hasText: modelId }).waitFor(); await closeInspector(page);
      await slash(page, "/resume"); await page.locator(".workspace-sidebar .session-row").first().waitFor(); await closeSidebar(page);
      assert.equal(requests.length, before, "slash commands did not request the provider");
      for (const command of ["/settings", "/login", "/session", "/export", "/model", "/resume"]) assert.equal(await page.locator(".message-user").filter({ hasText: command }).count(), 0, `${command} did not become a user message`);
      await composer(page).fill(bDraft);
    });

    await check(`${name}-08`, "returning to A restores its own draft, original project settings and project resource", async () => {
      await switchProject(page, a);
      assert.equal(await composer(page).inputValue(), aDraft);
      assert.ok((await readFile(configPath)).equals(configBytes));
      assert.equal(await exists(join(a, "m31-integration-proof.json")), false);
      assert.equal(await page.locator(".message-assistant").filter({ hasText: `M31_INTEGRATION_DONE ${marker}` }).count(), 0, "B's conversation did not become A's history");
      await openSettings(page);
      const option = page.getByRole("radio", { name: "跟随 pi", exact: true }); await option.click();
      await page.getByText("当前项目的设置", { exact: false }).first().waitFor();
      await page.getByText("当前项目的设置指定了“light”", { exact: false }).waitFor();
      await shot(page, `${name}-a-project-theme`); await closeModal(page, "settings-title");
      await waitFor(async () => await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()) === source.expectedBg, "canceling the project-theme preview restores the saved browser appearance");
      const inspect = page.getByRole("button", { name: "文件与改动", exact: true }); await inspect.click();
      const panel = page.locator(".workspace-inspector");
      await panel.getByRole("button", { name: "资源", exact: true }).click(); await panel.getByRole("button", { name: "命令", exact: true }).click();
      await panel.locator(".command-resource").filter({ hasText: "/m31-project-a" }).waitFor();
      await shot(page, `${name}-a-resources`); await closeInspector(page);
      assert.equal(await composer(page).inputValue(), aDraft);
      await layout(page, `${name}-a-restored`); await shot(page, `${name}-a-restored`);
    });

    await check(`${name}-09`, "B restores its saved session, model and draft, then survives refresh with native history and theme intact", async () => {
      await switchProject(page, b);
      assert.equal(await composer(page).inputValue(), bDraft);
      await page.locator(".message-assistant").filter({ hasText: `M31_INTEGRATION_DONE ${marker}` }).waitFor();
      const selectedModel = page.getByLabel("模型", { exact: true });
      const expectedModel = JSON.stringify({ provider: providerId, id: modelId });
      // The restored snapshot precedes its asynchronous model catalog; enabled can still be a placeholder.
      await waitFor(async () => await selectedModel.inputValue() === expectedModel, "B model catalog and selection restored", 5_000);
      assert.equal(await selectedModel.inputValue(), expectedModel);
      const last = (await fixture.events()).filter(event => event.event === "m31_integration_session" && event.mode === "rpc").at(-1);
      assert.equal(last.sessionId, run.sessionId); assert.equal(last.cwd, b);
      await page.getByRole("button", { name: "文件与改动", exact: true }).click();
      const panel = page.locator(".workspace-inspector"); await panel.getByRole("button", { name: "资源", exact: true }).click(); await panel.getByRole("button", { name: "命令", exact: true }).click();
      await panel.locator(".command-resource").first().waitFor();
      assert.equal(await panel.locator(".command-resource").filter({ hasText: "/m31-project-a" }).count(), 0, "A's project resource is absent in B");
      await closeInspector(page); await shot(page, `${name}-b-restored-draft`);
      await composer(page).fill(""); const beforeReload = receivedFrames.length;
      await page.reload(); await page.getByText("已连接", { exact: true }).waitFor(); await projectIs(page, b);
      await waitFor(() => receivedFrames.slice(beforeReload).some(frame => JSON.parse(frame).t === "account_state"), "account state restored after refresh");
      await page.locator(".message-assistant").filter({ hasText: `M31_INTEGRATION_DONE ${marker}` }).waitFor();
      await waitFor(async () => await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()) === source.expectedBg, "theme survives reload");
      assert.equal(await page.locator(".dialog-backdrop").count(), 0, "the dismissed login result did not reopen on refresh");
      await composer(page).click();
      await waitFor(() => composer(page).evaluate(node => node === document.activeElement), "the refreshed composer is usable");
      assert.equal(await composer(page).inputValue(), "");
      assert.equal(JSON.parse(await readFile(run.proofFile, "utf8")).sessionId, run.sessionId);
      assert.equal((await fixture.events()).filter(event => event.event === "m31_integration_write").length, 1, "restoring and refreshing did not repeat the tool");
      await layout(page, `${name}-b-refreshed`); await shot(page, `${name}-b-refreshed`);
    });

    await check(`${name}-10`, "synthetic secret isolation, original config, package assets and unique live RPC writer remain correct", async () => {
      const frames = receivedFrames.join("\n"); assert.equal(frames.includes(key), false, "the server never echoed the synthetic key");
      assert.equal((fixture.terminal + fixture.processError + JSON.stringify(await fixture.events())).includes(key), false);
      assert.equal((await readFile(join(fixture.agentDir, "models.json"), "utf8")).includes(key), false);
      for (const file of await readdir(join(fixture.agentDir, "sessions"), { recursive: true })) if (file.endsWith(".jsonl")) assert.equal((await readFile(join(fixture.agentDir, "sessions", file), "utf8")).includes(key), false);
      assert.equal(await page.evaluate(sentinel => document.documentElement.outerHTML.includes(sentinel) || JSON.stringify({ ...localStorage, ...sessionStorage }).includes(sentinel), key), false);
      assert.ok((await readFile(configPath)).equals(configBytes));
      const events = await fixture.events(), children = [...new Set(events.filter(event => event.event === "m31_integration_session" && event.mode === "rpc").map(event => event.pid))];
      const live = children.filter(alive); assert.equal(live.length, 1, "only the current RPC child remains alive");
      assert.equal((await stat(join(fixture.agentDir, "auth.json"))).mode & 0o777, 0o600);
      run.rpcProcesses = children.length; run.liveWriterAtEnd = live[0];
      await writeFile(join(out, `${name}-events.jsonl`), `${events.map(event => redact(JSON.stringify(event))).join("\n")}\n`);
      await writeFile(join(out, `${name}-proof.json`), await readFile(run.proofFile));
      return { childProcessesOverRun: children.length, liveWriters: live.length, credentialMode: (await stat(join(fixture.agentDir, "auth.json"))).mode & 0o777 };
    });
    await context.close();
    await fixture.close();
    const pids = [...new Set((await fixture.events()).filter(event => event.event === "m31_integration_session" && event.mode === "rpc").map(event => event.pid))];
    await waitFor(() => pids.every(pid => !alive(pid)), `${name} RPC processes stopped`, 15_000);
    await fixture.remove();
    report.cleanup.push({ viewport: name, browserContextClosed: true, rpcProcessesStopped: true, temporaryHomeRemoved: !await exists(fixture.directory) });
  }
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.externalRequests, []);
  assert.equal(requests.filter(item => item.error).length, 0); report.localProviderRequests = requests;
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.error = redact(error.stack ?? error); process.exitCode = 1; console.error(report.error);
  for (const [index, page] of (browser?.contexts().flatMap(context => context.pages()) ?? []).entries()) {
    await shot(page, `failure-${index}`).catch(() => {});
    await writeFile(join(out, `failure-${index}.txt`), redact(await page.locator("body").innerText())).catch(() => {});
    await writeFile(join(out, `failure-${index}-receipts.txt`), redact((await page.locator(".receipts").allTextContents()).join("\n"))).catch(() => {});
  }
  await writeFile(join(out, "failure-frames.jsonl"), `${diagnosticFrames.map(redact).join("\n")}\n`);
} finally {
  await browser?.close().catch(error => { report.browserCleanupError = redact(error); });
  for (const fixture of fixtures) if (await exists(fixture.directory)) {
    const cleanup = { interruptedRun: true, hostClosed: false, temporaryHomeRemoved: false };
    try { await fixture.close(); cleanup.hostClosed = true; await fixture.remove(); cleanup.temporaryHomeRemoved = !await exists(fixture.directory); }
    catch (error) { cleanup.error = redact(error); }
    report.cleanup.push(cleanup);
  }
  if (endpoint) await new Promise(done => endpoint.close(done));
  report.finishedAt = new Date().toISOString();
  await writeFile(join(out, "report.json"), `${redact(JSON.stringify(report, null, 2))}\n`);
  console.log(`${report.status.toUpperCase()} — ${report.checks.filter(item => item.status === "passed").length}/${report.checks.length} checks; report: ${join(out, "report.json")}`);
}
