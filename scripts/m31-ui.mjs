#!/usr/bin/env node
/**
 * M3.1 pages in a real browser (system Chrome, headless) against a real pi TUI: the custom provider
 * form, setting its key, a reply from it, copying a reply, session numbers, export with download,
 * deleting a session, and the same form at phone width. A loopback stand-in endpoint answers the
 * model requests; a stand-in `trash` keeps deleted files inside the fixture. Made-up keys only.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { startFixture, waitFor } from "./m0-smoke.mjs";

const out = resolve(process.env.PI_M31_REPORT_DIR || "build-artifacts/m3.1/ui");
await mkdir(out, { recursive: true });
const report = { startedAt: new Date().toISOString(), scope: "M31-4b pages in a browser", browser: "System Google Chrome, headless Playwright", realTui: true, realModelCalls: 0,
  isolation: "temporary HOME + agent dir, loopback stand-in endpoint, made-up key, stand-in trash, PI_OFFLINE=1", checks: [], screenshots: [], status: "running" };
const redact = text => text.replace(/#t=[A-Za-z0-9_-]+/g, "#t=[REDACTED]");
async function check(id, name, fn) {
  const started = Date.now();
  try { const details = await fn(); report.checks.push({ id, name, status: "passed", durationMs: Date.now() - started, ...(details ? { details } : {}) }); console.log(`PASS ${id} ${name}`); }
  catch (error) { report.checks.push({ id, name, status: "failed", durationMs: Date.now() - started, error: redact(String(error.stack ?? error)) }); throw error; }
}
const requests = [];
const endpoint = createServer((request, response) => {
  let body = ""; request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    let parsed; try { parsed = JSON.parse(body); } catch { parsed = undefined; }
    requests.push({ authorization: request.headers.authorization, model: parsed?.model });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "m", object: "chat.completion.chunk", model: parsed?.model, choices: [{ index: 0, delta: { role: "assistant", content: `M31_UI_REPLY from ${parsed?.model}` }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: "m", object: "chat.completion.chunk", model: parsed?.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 120, completion_tokens: 12, total_tokens: 132 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
});
await new Promise(done => endpoint.listen(0, "127.0.0.1", done));
const baseUrl = `http://127.0.0.1:${endpoint.address().port}/v1`;
const KEY = "sk-m31-ui-made-up-key";
let fixture, browser, trashDir;
const errors = [];

try {
  fixture = await startFixture({ extraExtensions: ["tests/fixtures/handoff-fixture.ts"],
    prependPath: async directory => { const bin = join(directory, "bin"); trashDir = join(directory, "trash"); await mkdir(bin); await mkdir(trashDir);
      await writeFile(join(bin, "trash"), `#!/bin/sh\n[ "$1" = "--" ] && shift\nexec mv -- "$1" "${trashDir}/"\n`); await chmod(join(bin, "trash"), 0o755); return bin; } });
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const page = await context.newPage(); page.setDefaultTimeout(15_000);
  page.on("pageerror", error => errors.push(error.message));
  const shot = async (target, name) => { await target.screenshot({ path: join(out, name) }); report.screenshots.push(name); };
  const noOverflow = target => target.evaluate(() => ({ page: document.documentElement.scrollWidth <= innerWidth, body: [...document.querySelectorAll(".settings-body, .dialog")].every(element => element.scrollWidth <= element.clientWidth + 1) }));
  const composer = () => page.getByRole("textbox", { name: "消息" });
  /** The page re-renders after the click; what is behind a dialog is usable only once the dialog is gone. */
  const closeDialog = async (name = "关闭") => {
    const title = await page.getByRole("dialog").getAttribute("aria-labelledby");
    await page.getByRole("dialog").getByRole("button", { name, exact: true }).click();
    await page.locator(`.dialog[aria-labelledby="${title}"]`).waitFor({ state: "detached" });
  };
  const send = async text => { await composer().fill(text); await page.getByRole("button", { name: /^(发送 ↗|请求 followUp ↗)$/ }).click(); };
  await page.goto(fixture.url); await page.getByText("已连接", { exact: true }).waitFor();

  await check("UI-PROV-1", "the provider form points at the wrong field, saves a valid provider, and nothing asks for a key in the form", async () => {
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("group", { name: "设置分类" }).getByRole("button", { name: "自定义供应商" }).click();
    await page.getByText("还没有自定义供应商。").waitFor();
    await page.getByRole("button", { name: "添加供应商" }).click();
    assert.equal(await page.locator(".provider-form input[type=password]").count(), 0);
    await page.locator("#provider-id").fill("ui-local"); await page.locator("#provider-url").fill("example.com/v1");
    await page.getByLabel("第 1 个模型的 ID").fill("ui-echo"); await page.getByLabel("第 1 个模型的显示名").fill("UI Echo"); await page.getByLabel("第 1 个模型的上下文长度").fill("32000");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "请填写完整的地址" }).waitFor();
    assert.equal(await page.locator("#provider-url").getAttribute("aria-invalid"), "true"); assert.equal(await page.locator("#provider-id").getAttribute("aria-invalid"), "false");
    await page.locator("#provider-url").fill("http://192.0.2.7:8000/v1"); await page.getByText("明文 http 地址").waitFor(); // warned, not refused
    await page.locator("#provider-url").fill(baseUrl); assert.equal(await page.getByText("明文 http 地址").count(), 0, "loopback is not flagged");
    await page.getByLabel("第 1 个模型的上下文长度").fill("abc"); await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "第 1 个模型：上下文长度必须是大于 0 的整数" }).waitFor();
    await page.getByLabel("第 1 个模型的上下文长度").fill("32000"); await page.getByRole("button", { name: "保存", exact: true }).click();
    const row = page.locator(".provider-row").filter({ hasText: "ui-local" }); await row.waitFor();
    await row.getByText("未设置密钥，模型暂时不可用").waitFor(); await page.getByText("已保存到 models.json").waitFor();
    await shot(page, "providers-desktop.png");
    assert.deepEqual(JSON.parse(await readFile(join(fixture.agentDir, "models.json"), "utf8")), { providers: { "ui-local": { baseUrl, api: "openai-completions", models: [{ id: "ui-echo", name: "UI Echo", contextWindow: 32000 }] } } });
  });
  await check("UI-PROV-2", "the key is typed into pi's login dialog, saved to the auth file, and the provider's model answers from the composer", async () => {
    const row = page.locator(".provider-row").filter({ hasText: "ui-local" });
    await row.getByRole("button", { name: "设置密钥" }).click();
    const secret = page.locator("#account-step-input"); await secret.waitFor(); assert.equal(await secret.getAttribute("type"), "password");
    await secret.fill(KEY); await page.getByRole("button", { name: "提交" }).click();
    await page.getByRole("heading", { name: "ui-local 的凭据已保存" }).waitFor();
    assert.equal(await page.evaluate(key => document.documentElement.outerHTML.includes(key) || JSON.stringify({ ...localStorage, ...sessionStorage }).includes(key), KEY), false, "the key is not left in the page or its storage");
    await closeDialog();
    await row.getByText("当前会话可用 1 个模型").waitFor(); await row.getByText("密钥已保存在 pi 的凭据文件里").waitFor();
    assert.equal(JSON.parse(await readFile(join(fixture.agentDir, "auth.json"), "utf8"))["ui-local"].key, KEY);
    assert.equal((await readFile(join(fixture.agentDir, "models.json"), "utf8")).includes(KEY), false);
    await page.getByRole("group", { name: "设置分类" }).getByRole("button", { name: "账户" }).click();
    await page.locator(".account-item").filter({ hasText: "ui-local" }).getByText("自定义").waitFor();
    await page.keyboard.press("Escape");
    await page.getByLabel("模型", { exact: true }).selectOption(JSON.stringify({ provider: "ui-local", id: "ui-echo" }));
    await waitFor(async () => (await page.getByLabel("模型", { exact: true }).inputValue()).includes("ui-local"), "model selected");
    await send("M31_UI_PROMPT");
    await page.locator(".message-assistant").filter({ hasText: "M31_UI_REPLY from ui-echo" }).waitFor({ timeout: 30_000 });
    assert.deepEqual(requests.at(-1), { authorization: `Bearer ${KEY}`, model: "ui-echo" });
  });
  await check("UI-SES-5", "the composer shows how full the context is, and /session opens pi's numbers for the session", async () => {
    const meter = page.locator(".context-meter"); await meter.waitFor();
    assert.match(await meter.textContent(), /上下文 \d+(\.\d)?%/);
    await send("/session");
    const dialog = page.getByRole("dialog"); await dialog.getByRole("heading", { name: "会话信息" }).waitFor();
    await dialog.getByText(/共 \d+ 条：你 \d+，pi \d+/).waitFor(); await dialog.getByText(/\.jsonl/).waitFor(); await dialog.getByText(/\/ 32,000）/).waitFor();
    assert.equal(await page.locator(".message-user").filter({ hasText: "/session" }).count(), 0, "/session was not sent as a message");
    await shot(page, "session-info.png");
    await closeDialog();
  });
  await check("UI-SES-4", "copy puts the reply's text on the clipboard; when the browser refuses, the text is shown to select and nothing claims success", async () => {
    const reply = page.locator(".message-assistant").filter({ hasText: "M31_UI_REPLY from ui-echo" });
    await reply.hover(); await reply.getByRole("button", { name: "复制" }).click();
    await page.getByText("已复制回复。").waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "M31_UI_REPLY from ui-echo");
    await page.evaluate(() => navigator.clipboard.writeText("")); await send("/copy");
    await waitFor(async () => await page.evaluate(() => navigator.clipboard.readText()) === "M31_UI_REPLY from ui-echo", "/copy copies the last reply");
    await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.reject(new DOMException("denied", "NotAllowedError")), readText: () => Promise.resolve("") } }); });
    await reply.hover(); await reply.getByRole("button", { name: "复制" }).click();
    const dialog = page.getByRole("dialog"); await dialog.getByRole("heading", { name: "手动复制" }).waitFor();
    assert.equal(await dialog.getByLabel("回复内容").inputValue(), "M31_UI_REPLY from ui-echo");
    assert.equal(await page.getByText("已复制回复。").count(), 0);
    await closeDialog();
  });
  await check("UI-SES-3", "export is confirmed first, written by pi into pi-pane's directory, and the downloaded file is the same file", async () => {
    await send("/export");
    const dialog = page.getByRole("dialog"); await dialog.getByRole("heading", { name: "导出会话" }).waitFor();
    await dialog.getByText("其中可能有文件内容、命令输出和密钥").waitFor();
    assert.equal((await readdir(join(fixture.agentDir, "pi-pane")).catch(() => [])).includes("exports"), false, "nothing is written before the user confirms");
    await dialog.getByRole("button", { name: "导出", exact: true }).click();
    const path = (await dialog.locator(".trust-path").textContent()).trim();
    assert.ok(path.includes("/agent/pi-pane/exports/session-") && path.endsWith(".html"));
    const [download] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "下载到此设备" }).click()]);
    const saved = join(out, "downloaded-export.html"); await download.saveAs(saved);
    assert.ok((await readFile(saved)).equals(await readFile(path)), "the browser received the file pi wrote");
    assert.equal(download.suggestedFilename(), path.split("/").at(-1));
    await dialog.getByText("已交给浏览器保存。").waitFor(); await shot(page, "export.png");
    assert.equal((await readdir(fixture.cwd)).some(name => name.endsWith(".html")), false, "nothing in the project directory");
    await closeDialog();
    return { bytes: (await stat(path)).size };
  });
  await check("UI-SES-1", "a session is deleted from the list only after a dialog names it; the open one has no delete button", async () => {
    await page.getByRole("button", { name: "新建会话" }).click();
    await waitFor(async () => await page.locator(".message").count() === 0, "empty new session", 20_000);
    await page.getByLabel("模型", { exact: true }).selectOption(JSON.stringify({ provider: "pi-pane-m0", id: "deterministic" })).catch(() => undefined);
    await send("M31_UI_TO_DELETE"); await page.locator(".message-assistant").filter({ hasText: "M31_UI_TO_DELETE" }).waitFor({ timeout: 30_000 });
    const first = page.locator(".session-row").filter({ hasText: "M0_SAVED_FIXTURE" }); await first.locator(".session-item").click();
    await page.locator(".message-user").filter({ hasText: "M31_UI_PROMPT" }).waitFor({ timeout: 20_000 });
    assert.equal(await first.locator(".session-delete").count(), 0, "the open session cannot be deleted from the list");
    const row = page.locator(".session-row").filter({ hasText: "M31_UI_TO_DELETE" }); await row.waitFor();
    await row.hover(); await row.locator(".session-delete").click();
    const dialog = page.getByRole("dialog"); await dialog.getByRole("heading", { name: "删除这个会话？" }).waitFor();
    await dialog.getByText(/\/agent\/sessions\/.*\.jsonl/).waitFor(); await dialog.getByText("文件会被移入这台电脑的废纸篓").waitFor(); await dialog.getByText("终端里的 pi 正打开着这个会话").waitFor();
    await shot(page, "delete-session.png");
    assert.equal((await readdir(trashDir)).length, 0, "nothing is deleted before the user confirms");
    await dialog.getByRole("button", { name: "移入废纸篓" }).click();
    await dialog.getByRole("heading", { name: "会话已移入废纸篓" }).waitFor(); await closeDialog();
    await waitFor(async () => await page.locator(".session-row").filter({ hasText: "M31_UI_TO_DELETE" }).count() === 0, "the row is gone");
    assert.equal((await readdir(trashDir)).length, 1);
  });
  await check("UI-PROV-8", "at 390 px the provider list and form fit the screen, can be reached from the drawer, and save", async () => {
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const mobile = await phone.newPage(); mobile.setDefaultTimeout(15_000); mobile.on("pageerror", error => errors.push(error.message));
    await mobile.goto(fixture.url); await mobile.getByText("已连接", { exact: true }).waitFor();
    await mobile.getByRole("button", { name: "打开工作区与会话" }).click(); await mobile.getByRole("button", { name: "设置", exact: true }).click();
    await mobile.getByRole("group", { name: "设置分类" }).getByRole("button", { name: "自定义供应商" }).click();
    await mobile.locator(".provider-row").filter({ hasText: "ui-local" }).waitFor();
    assert.deepEqual(await noOverflow(mobile), { page: true, body: true }); await shot(mobile, "providers-mobile.png");
    await mobile.getByRole("button", { name: "添加供应商" }).click();
    await mobile.locator("#provider-id").fill("ui-phone"); await mobile.locator("#provider-url").fill(baseUrl); await mobile.getByLabel("第 1 个模型的 ID").fill("phone-model");
    await mobile.getByRole("button", { name: "添加模型" }).click(); await mobile.getByLabel("第 2 个模型的 ID").fill("phone-model-2");
    assert.deepEqual(await noOverflow(mobile), { page: true, body: true });
    const sizes = await mobile.locator(".provider-form input, .provider-form select, .provider-form button").evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
    assert.ok(Math.min(...sizes) >= 40, `touch targets are at least 40 px (smallest ${Math.min(...sizes)})`);
    await shot(mobile, "provider-form-mobile.png");
    await mobile.getByRole("button", { name: "保存", exact: true }).click();
    await mobile.locator(".provider-row").filter({ hasText: "ui-phone" }).waitFor();
    // The desktop page learns of it without a reload.
    await page.getByRole("button", { name: "设置", exact: true }).click(); await page.getByRole("group", { name: "设置分类" }).getByRole("button", { name: "自定义供应商" }).click();
    await page.locator(".provider-row").filter({ hasText: "ui-phone" }).waitFor();
    // Removing asks first and says what goes with it.
    const row = page.locator(".provider-row").filter({ hasText: "ui-local" });
    await row.getByRole("button", { name: "删除", exact: true }).click(); await row.getByText("会删除这个供应商的 1 个模型和为它保存的密钥").waitFor();
    await row.getByRole("button", { name: "确认删除" }).click(); await page.getByText("已从 models.json 删除 ui-local。为它保存的密钥也已删除。").waitFor();
    assert.equal(JSON.parse(await readFile(join(fixture.agentDir, "auth.json"), "utf8"))["ui-local"], undefined);
    await phone.close();
  });
  assert.deepEqual(errors, [], "no uncaught error in the page");
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.error = redact(String(error.stack ?? error)); process.exitCode = 1; console.error(report.error);
  for (const [index, open] of (browser?.contexts().flatMap(item => item.pages()) ?? []).entries()) await open.screenshot({ path: join(out, `failure-${index}.png`) }).catch(() => {});
}
finally {
  await browser?.close().catch(() => {});
  if (fixture) { await fixture.close().catch(() => {}); await fixture.remove().catch(() => {}); }
  await new Promise(done => endpoint.close(done));
  report.finishedAt = new Date().toISOString(); report.pageErrors = errors;
  await writeFile(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.status.toUpperCase()} — ${report.checks.filter(item => item.status === "passed").length}/${report.checks.length} checks; report: ${join(out, "report.json")}`);
}
