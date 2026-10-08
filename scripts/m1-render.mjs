#!/usr/bin/env node
// Rendering and content-safety acceptance (A8 subset) against the built web assets.
// A real Hub serves web-dist; a stub Bridge supplies a fixed transcript, so no pi process is needed.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { Hub } from "../dist/extension/hub.js";
import { COMMANDS } from "../dist/protocol/index.js";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportDir = resolve(process.env.PI_M1_REPORT_DIR ?? join(project, "build-artifacts/m1/render"));
await mkdir(reportDir, { recursive: true });

const longOutput = Array.from({ length: 3000 }, (_, index) => `line ${String(index).padStart(4, "0")} ${"·".repeat(20)}`).join("\n") + "\nLONG_OUTPUT_END";
const patch = "--- a/src/price.js\n+++ b/src/price.js\n@@ -1,4 +1,4 @@\n export function price(cents) {\n-  return cents / 10;\n+  return cents / 100;\n }\n";
const markdown = [
  "## 修复结果", "",
  "价格换算错了一个数量级，见 [MDN](https://developer.mozilla.org/)。", "",
  "- 修改 `price()`", "- 补充测试", "",
  "```ts", "export function price(cents: number): number {", "  return cents / 100;", "}", "```", "",
  "| 文件 | 状态 |", "|---|---|", "| src/price.js | 已修改 |", "",
  // Content-safety payloads (A8): none of these may execute or load.
  "<script>window.__xss = 'script'</script>", "",
  "<img src=x onerror=\"window.__xss='img'\">", "",
  "[click](javascript:window.__xss='link') and [data](data:text/html,<script>alert(1)</script>)", "",
  "![tracker](https://example.invalid/pixel.png)",
].join("\n");
const assistantId = "entry:a1";
const messages = [
  { id: "entry:u1", entryId: "u1", role: "user", status: "complete", content: [{ type: "text", text: "修复价格计算并跑测试" }] },
  { id: assistantId, entryId: "a1", role: "assistant", status: "complete", content: [
    { type: "thinking", text: "先读文件，再修改，最后运行测试。", durationMs: 1234, timingStatus: "complete" },
    { type: "toolCall", id: "t-read", name: "read", arguments: { path: "src/price.js" } },
    { type: "toolCall", id: "t-edit", name: "edit", arguments: { path: "src/price.js", edits: [{ oldText: "cents / 10", newText: "cents / 100" }] } },
    { type: "toolCall", id: "t-edit-html", name: "edit", arguments: { path: "src/literal.js", edits: [{ oldText: '<img src=x onerror="window.__xss=1">', newText: '<img src=y onerror="window.__xss=1">' }] } },
    { type: "toolCall", id: "t-bash", name: "bash", arguments: { command: "npm test" } },
    { type: "toolCall", id: "t-long", name: "bash", arguments: { command: "seq 3000" } },
    { type: "toolCall", id: "t-custom", name: "fixture_tool", arguments: { query: "<b>not html</b>" } },
  ] },
  { id: "entry:r1", entryId: "r1", role: "toolResult", toolCallId: "t-read", toolName: "read", status: "complete", content: [{ type: "text", text: "export function price(cents) {\n  return cents / 10;\n}\n" }] },
  { id: "entry:r2", entryId: "r2", role: "toolResult", toolCallId: "t-edit", toolName: "edit", status: "complete", content: [{ type: "text", text: "Successfully replaced 1 block." }, { type: "diff", text: patch }] },
  { id: "entry:r3", entryId: "r3", role: "toolResult", toolCallId: "t-bash", toolName: "bash", status: "complete", content: [{ type: "text", text: "✓ price converts cents (2 ms)\n1 passed" }] },
  { id: "entry:r4", entryId: "r4", role: "toolResult", toolCallId: "t-long", toolName: "bash", status: "complete", content: [{ type: "text", text: longOutput.slice(0, 2000), total: longOutput.length }] },
  { id: "entry:r5", entryId: "r5", role: "toolResult", toolCallId: "t-custom", toolName: "fixture_tool", status: "complete", isError: true, content: [{ type: "text", text: "<img src=x onerror=\"window.__xss='tool'\"> failed" }] },
  { id: "entry:c1", entryId: "c1", role: "system", status: "complete", content: [{ type: "text", text: "[Context compacted]" }] },
  { id: "entry:a2", entryId: "a2", role: "assistant", status: "complete", content: [{ type: "text", text: markdown }] },
];
const older = [{ id: "entry:o1", entryId: "o1", role: "user", status: "complete", content: [{ type: "text", text: "OLDER_PAGE_MESSAGE" }] }];
const contentReads = [];
const bridge = {
  sessionId: "render-session", branchRevision: 0, isCurrent: () => true,
  setObserver: () => {}, dispatch: () => { throw new Error("render fixture is read-only"); }, flush: () => {},
  snapshot: () => structuredClone({
    session: { id: "render-session", name: "渲染验收", cwd: "/fixture/project", leafId: "a2", branchRevision: 0, messages, olderCursor: "u1" },
    state: { idle: true, running: false, compacting: false, hasPendingMessages: false, thinking: "off", tools: [], uiPrompts: [],
      model: { provider: "fixture", id: "fixture", name: "Fixture" }, models: [{ provider: "fixture", id: "fixture", name: "Fixture" }] },
    theme: {}, caps: { commands: COMMANDS, images: false, promptReceipt: "dispatch_only", queueView: "boolean", terminalDialogs: true, history: "paged", content: "paged" },
  }),
  historyPage: (before) => { assert.equal(before, "u1"); return { messages: structuredClone(older), olderCursor: null }; },
  contentPage: (messageId, index, offset) => {
    contentReads.push({ messageId, index, offset });
    assert.equal(messageId, "entry:r4");
    return { messageId, index, offset, text: longOutput.slice(offset, offset + 131072), total: longOutput.length, final: true };
  },
};

const report = { startedAt: new Date().toISOString(), checks: [], status: "running" };
const hub = new Hub({ port: 0, webRoot: join(project, "web-dist") });
let browser;
try {
  await hub.start();
  hub.bindBridge(bridge);
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
  const errors = [];
  const requests = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("request", (request) => requests.push(request.url()));
  page.on("dialog", (dialog) => { errors.push(`dialog: ${dialog.message()}`); void dialog.dismiss(); });
  await page.goto(hub.url);
  await page.getByText("已连接", { exact: true }).waitFor();
  const check = async (name, fn) => {
    try { await fn(); report.checks.push({ name, status: "passed" }); console.log(`PASS ${name}`); }
    catch (error) { report.checks.push({ name, status: "failed", error: String(error) }); console.log(`FAIL ${name}\n${error}`); throw error; }
  };

  await check("Markdown renders headings, lists, tables and highlighted fenced code", async () => {
    const md = page.locator(".message-assistant .markdown").last();
    await md.locator("h2").filter({ hasText: "修复结果" }).waitFor();
    assert.equal(await md.locator("li").count(), 2);
    assert.equal(await md.locator("table td").first().textContent(), "src/price.js");
    await md.locator("pre.shiki span[style*='--shiki-token-keyword']").first().waitFor();
  });
  await check("observed thinking duration is visible while the thought stays collapsed", async () => {
    const thinking = page.locator(".thinking").first();
    assert.match(await thinking.locator("summary").textContent(), /1\.2.*秒/);
    assert.equal(await thinking.evaluate(node => node.open), false);
    await thinking.locator("summary").click();
    assert.equal(await thinking.locator("pre").textContent(), "先读文件，再修改，最后运行测试。");
    await thinking.locator("summary").click();
  });
  await check("raw HTML, script URLs and remote images never execute or load", async () => {
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.equal(await page.locator(".message script, .message img").count(), 0);
    const md = page.locator(".message-assistant .markdown").last();
    assert.match(await md.textContent(), /<script>window.__xss/, "raw HTML is shown as text");
    const hrefs = await md.locator("a").evaluateAll((links) => links.map((link) => [link.getAttribute("href"), link.getAttribute("rel"), link.getAttribute("target")]));
    for (const [href, rel, target] of hrefs) {
      assert.ok(!href || /^(https?:|mailto:|#)/.test(href), `unsafe href ${href}`);
      if (href) { assert.match(rel ?? "", /noopener/); assert.equal(target, "_blank"); }
    }
    assert.ok(!requests.some((url) => url.includes("example.invalid")), "remote image was not requested");
    await md.locator("a").filter({ hasText: "[图片：tracker]" }).waitFor();
    assert.equal(await md.locator("a[href^='javascript'], a[href^='data']").count(), 0);
    const clickable = md.locator("a").filter({ hasText: "click" });
    if (await clickable.count()) { await clickable.click(); await page.waitForTimeout(100); }
    assert.equal(await page.evaluate(() => window.__xss), undefined, "clicking a stripped link does nothing");
    assert.deepEqual(errors, []);
  });
  await check("tool calls pair with their results as typed cards", async () => {
    assert.equal(await page.locator(".message-toolResult").count(), 0, "paired results render inside their call");
    await page.locator(".tool-card[data-tool-id='t-read'] .tool-summary").filter({ hasText: "read src/price.js" }).waitFor();
    await page.locator(".tool-card[data-tool-id='t-bash'] .tool-summary").filter({ hasText: "$ npm test" }).waitFor();
    const edit = page.locator(".tool-card[data-tool-id='t-edit']");
    assert.ok(await edit.evaluate((node) => node.open), "edit cards open with their diff");
    assert.equal(await edit.locator(".diff-add").textContent(), "+  return cents / 100;");
    assert.equal(await edit.locator(".diff-del").textContent(), "-  return cents / 10;");
    assert.deepEqual(await edit.locator(".diff-word-add").allTextContents(), ["100"]);
    assert.deepEqual(await edit.locator(".diff-word-del").allTextContents(), ["10"]);
    const literal = page.locator(".tool-card[data-tool-id='t-edit-html']");
    await literal.locator("summary").click();
    assert.deepEqual(await literal.locator(".diff-word-add").allTextContents(), ["y"]);
    assert.deepEqual(await literal.locator(".diff-word-del").allTextContents(), ["x"]);
    assert.match(await literal.locator(".diff").textContent(), /<img src=x onerror=/);
    assert.equal(await literal.locator("img, script").count(), 0, "diff payloads render as text");
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    const custom = page.locator(".tool-card[data-tool-id='t-custom']");
    assert.ok(await custom.evaluate((node) => node.classList.contains("tool-error") && node.open));
    assert.match(await custom.locator("pre").first().textContent(), /<b>not html<\/b>/);
    await page.locator(".compaction-marker").filter({ hasText: "上下文已压缩" }).waitFor();
  });
  await check("a clipped tool result loads in full through content pages", async () => {
    const card = page.locator(".tool-card[data-tool-id='t-long']");
    await card.locator("summary").click();
    await card.getByRole("button", { name: "加载全部" }).click();
    await card.locator(".truncation").filter({ hasText: "已加载全部" }).waitFor();
    assert.match(await card.locator("pre.tool-output").textContent(), /LONG_OUTPUT_END$/);
    assert.deepEqual(contentReads.map((read) => read.offset), [0]);
  });
  await check("older history loads on request and merges before the window", async () => {
    await page.getByRole("button", { name: "加载更早的消息" }).click();
    await page.locator(".message-user .message-text").filter({ hasText: "OLDER_PAGE_MESSAGE" }).waitFor();
    const order = await page.locator(".message-user .message-text").allTextContents();
    assert.equal(order[0], "OLDER_PAGE_MESSAGE");
    assert.equal(await page.getByRole("button", { name: "加载更早的消息" }).count(), 0, "cursor is exhausted");
  });
  await page.locator(".tool-card[data-tool-id='t-long'] summary").click();
  await page.evaluate(() => document.querySelector(".timeline").scrollTop = 0);
  await page.screenshot({ path: join(reportDir, "render-desktop.png") });
  await page.evaluate(() => { const timeline = document.querySelector(".timeline"); timeline.scrollTop = timeline.scrollHeight; });
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(reportDir, "render-desktop-latest.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await check("390px layout has no horizontal overflow", async () => {
    await page.waitForTimeout(200);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  });
  await page.screenshot({ path: join(reportDir, "render-mobile.png") });
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await hub.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(join(reportDir, "render-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report: ${join(reportDir, "render-report.json")}`);
}
