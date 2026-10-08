#!/usr/bin/env node
/** Browser checks against a real isolated pi TUI, using the local deterministic provider. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { openClient, startFixture, textOf, waitFor } from "./m0-smoke.mjs";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = resolve(process.env.PI_M0_REPORT_DIR || join(project, "build-artifacts/m0"));
const redact = value => value.replace(/#t=[A-Za-z0-9_-]+/g, "#t=[REDACTED]").replace(/pi-pane\.bearer\.[A-Za-z0-9_-]+/g, "pi-pane.bearer.[REDACTED]");
const report = {
  startedAt: new Date().toISOString(), realTui: true, realModelCalls: 0,
  isolation: "Credential-free deterministic provider; empty fixture cwd and separate pi agent directory",
  browser: "System Google Chrome, headless Playwright", checks: [], screenshots: [],
  notCovered: ["M2 images/TLS/LAN", "Native OS input-method UI (composition DOM events are exercised)", "Long-history virtualization and snapshot chunking", "Compaction callbacks and terminal custom dialogs"],
};
await mkdir(outputDir, { recursive: true });
let fixture, observer, browser, page;
const browserErrors = [];

const check = async (name, action) => {
  const started = Date.now();
  try {
    const details = await action();
    report.checks.push({ name, status: "passed", durationMs: Date.now() - started, ...(details ? { details } : {}) });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.checks.push({ name, status: "failed", durationMs: Date.now() - started, error: redact(String(error)) });
    throw error;
  }
};
const connected = async () => page.getByText("已连接", { exact: true }).waitFor();
const composer = () => page.getByRole("textbox", { name: "消息" });
const userCount = async text => page.locator(".message-user .message-text").evaluateAll((elements, wanted) => elements.filter(element => element.textContent === wanted).length, text);
const waitUser = async text => waitFor(async () => await userCount(text) === 1, `browser user ${text}`);
const sendPrompt = async (text, mode = "followUp", waitForActual = true) => {
  await composer().fill(text);
  await page.getByRole("button", { name: mode === "steer" ? "steer" : /^(发送 ↗|请求 followUp ↗)$/ }).click();
  if (waitForActual) await waitUser(text);
};
const screenshot = async name => {
  await page.screenshot({ path: join(outputDir, name), fullPage: true });
  report.screenshots.push(name);
};

try {
  fixture = await startFixture();
  observer = await openClient(fixture.url);
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(15_000);
  page.on("pageerror", error => browserErrors.push(error.message));
  // Controlled browser-only hooks exercise dropped ACK and socket reconnection without
  // adding debug APIs to the shipped frontend or recording authentication protocols.
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    window.__m0Sockets = [];
    window.__m0DropNextAck = false;
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        window.__m0Sockets.push(this);
        this.addEventListener("message", event => {
          if (!window.__m0DropNextAck) return;
          try {
            if (JSON.parse(event.data).t === "ack") {
              window.__m0DropNextAck = false;
              event.stopImmediatePropagation();
            }
          } catch { /* The production handler still validates malformed frames. */ }
        });
      }
    };
  });

  await check("first browser attach restores a real TUI stream; fragment is cleared", async () => {
    fixture.command("M0_SLOW_BROWSER_FIRST");
    await waitFor(() => observer.assistants("M0_SLOW_BROWSER_FIRST").some(message => textOf(message).length > 32), "first partial stream");
    await page.goto(fixture.url);
    await connected();
    assert.equal(new URL(page.url()).hash, "", "token removed from browser URL");
    await waitUser("M0_SLOW_BROWSER_FIRST");
    await waitFor(async () => (await page.locator(".message-assistant .message-text").allTextContents()).some(text => text.startsWith("M0_REPLY:M0_SLOW_BROWSER_FIRST:") && text.length > 32), "browser partial restoration");
    assert.ok(await page.locator(".message-assistant .streaming").count(), "browser displays active message");
    await screenshot("browser-stream-desktop.png");
    await observer.settled("M0_SLOW_BROWSER_FIRST");
    await waitFor(async () => await page.locator(".message-assistant .streaming").count() === 0, "browser final message");
    assert.equal(await userCount("M0_SLOW_BROWSER_FIRST"), 1);
  });

  await check("Chinese composition Enter is safe; normal Enter yields an honest receipt and recoverable original", async () => {
    const before = await fixture.eventCount("provider_call");
    await composer().fill("M0_组合输入");
    await composer().dispatchEvent("compositionstart");
    await composer().press("Enter");
    assert.equal(await fixture.eventCount("provider_call"), before);
    assert.equal(await userCount("M0_组合输入"), 0);
    await composer().dispatchEvent("compositionend");
    await page.waitForTimeout(100);
    // DOM-only composition does not invoke an OS IME, so restore the exact intended text.
    await composer().fill("M0_BROWSER_ENTER");
    await composer().press("Enter");
    await waitUser("M0_BROWSER_ENTER");
    await page.locator(".receipt-latest").filter({ hasText: "已交给 pi；提交结果未确认" }).waitFor();
    await page.locator(".receipts > summary").click();
    await page.getByRole("button", { name: "恢复到输入框" }).first().click();
    await waitFor(async () => await composer().inputValue() === "M0_BROWSER_ENTER", "original text recovery");
    await observer.settled("M0_BROWSER_ENTER");
    await composer().fill("");
    await page.locator(".receipts > summary").click();
  });

  await check("followUp and steer buttons reach the real TUI queue and preserve event-driven message order", async () => {
    await sendPrompt("M0_SLOW_BROWSER_QUEUE");
    await waitFor(() => observer.snapshot.state.running, "real host running");
    await sendPrompt("M0_BROWSER_FOLLOW", "followUp", false);
    await waitFor(() => observer.snapshot.state.hasPendingMessages, "followUp enters real pending queue");
    await sendPrompt("M0_BROWSER_STEER", "steer", false);
    await waitFor(() => observer.snapshot.state.hasPendingMessages, "real queue boolean");
    await observer.settled("M0_BROWSER_FOLLOW");
    const messages = observer.snapshot.session.messages;
    assert.ok(messages.findIndex(message => textOf(message) === "M0_BROWSER_STEER") < messages.findIndex(message => textOf(message) === "M0_BROWSER_FOLLOW"));
    assert.equal(await userCount("M0_BROWSER_FOLLOW"), 1);
    assert.equal(await userCount("M0_BROWSER_STEER"), 1);
  });

  await check("lost ACK becomes unknown; reconnect restores stream and draft without resending", async () => {
    await page.evaluate(() => { window.__m0DropNextAck = true; });
    await sendPrompt("M0_SLOW_BROWSER_LOST_ACK");
    await waitFor(() => observer.assistants("M0_SLOW_BROWSER_LOST_ACK").some(message => textOf(message).length > 40), "stream before reconnection");
    await composer().fill("保留未发送的草稿");
    const socketCount = await page.evaluate(() => window.__m0Sockets.length);
    await page.evaluate(() => window.__m0Sockets.at(-1).close(1000, "M0 fixture disconnect"));
    await page.waitForFunction(count => window.__m0Sockets.length > count, socketCount);
    await connected();
    assert.equal(await composer().inputValue(), "保留未发送的草稿");
    await page.locator(".receipt-latest").filter({ hasText: "结果未知" }).waitFor();
    await observer.settled("M0_SLOW_BROWSER_LOST_ACK");
    const calls = (await fixture.events()).filter(event => event.event === "provider_call" && event.input === "M0_SLOW_BROWSER_LOST_ACK");
    assert.equal(calls.length, 1, "reconnection must not invoke the prompt again");
    assert.equal(await userCount("M0_SLOW_BROWSER_LOST_ACK"), 1);
    await screenshot("browser-unknown-receipt.png");
    await composer().fill("");
  });

  await check("tool partial is visible and survives browser refresh with the same authenticated lease", async () => {
    await sendPrompt("M0_TOOL_BROWSER");
    await waitFor(() => observer.snapshot.state.tools.some(tool => tool.status === "running" && tool.output), "real tool partial");
    await page.locator(".tool-running pre").filter({ hasText: "M0_PARTIAL:" }).waitFor();
    await page.reload();
    await connected();
    await page.locator(".tool-running pre").filter({ hasText: "M0_PARTIAL:" }).waitFor();
    assert.equal(new URL(page.url()).hash, "");
    await screenshot("browser-tool-partial.png");
    await observer.settled("M0_TOOL_BROWSER");
    await page.locator(".tool-complete").waitFor();
  });

  await check("abort button interrupts the actual provider; idle comes from host state", async () => {
    await sendPrompt("M0_SLOW_BROWSER_ABORT");
    await waitFor(() => observer.assistants("M0_SLOW_BROWSER_ABORT").some(message => textOf(message).length > 32), "active reply before abort");
    await page.getByRole("button", { name: "■ 中止" }).click();
    await fixture.waitEvent("provider_aborted", 0, event => event.input === "M0_SLOW_BROWSER_ABORT");
    await waitFor(() => observer.snapshot.state.idle, "host idle after abort");
    await page.locator(".session-details").getByText("空闲", { exact: true }).waitFor();
  });

  await check("model-generated HTML remains inert plain text", async () => {
    const input = 'M0_BROWSER_XSS:<img src=x onerror="window.__m0Xss=true">';
    await sendPrompt(input);
    await observer.settled(input);
    assert.equal(await page.evaluate(() => window.__m0Xss), undefined);
    assert.equal(await page.locator(".message img").count(), 0);
    assert.equal(await userCount(input), 1);
  });

  await check("terminal reload and new reset browser transcript while preserving unsent draft", async () => {
    await composer().fill("终端切换时保留此草稿");
    const previousEpoch = observer.snapshot.epoch;
    fixture.command("/reload");
    await waitFor(() => observer.snapshot && observer.snapshot.epoch !== previousEpoch, "real reload epoch");
    await connected();
    assert.equal(await composer().inputValue(), "终端切换时保留此草稿");
    const oldSession = observer.snapshot.session.id;
    fixture.command("/new");
    await waitFor(() => observer.snapshot && observer.snapshot.session.id !== oldSession, "real new session");
    await waitFor(async () => await page.locator(".message").count() === 0, "browser cleared old transcript");
    await connected();
    assert.equal(await composer().inputValue(), "终端切换时保留此草稿");
    await composer().fill("");
    await sendPrompt("M0_BROWSER_NEW_SESSION");
    await observer.settled("M0_BROWSER_NEW_SESSION");
  });

  await check("a copied tab lease pauses the replaced connection; explicit reconnect creates an independent client", async () => {
    // Browsers can clone sessionStorage when duplicating/opening a tab. Keep these values
    // solely in this test process; never write authentication storage into the report.
    const storage = await page.evaluate(() => ({ token: sessionStorage.getItem("pi-pane.token"), client: sessionStorage.getItem("pi-pane.clientId") }));
    const sibling = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    try {
      await sibling.addInitScript(values => {
        sessionStorage.setItem("pi-pane.token", values.token);
        sessionStorage.setItem("pi-pane.clientId", values.client);
      }, storage);
      const socketCount = await page.evaluate(() => window.__m0Sockets.length);
      await sibling.goto(new URL(fixture.url).origin);
      await sibling.getByText("已连接", { exact: true }).waitFor();
      await page.getByText("需重新连接", { exact: true }).waitFor();
      await page.waitForTimeout(750);
      assert.equal(await page.evaluate(() => window.__m0Sockets.length), socketCount, "replaced tab must not reconnect automatically and steal the lease");
      await page.getByRole("button", { name: "重新连接" }).click();
      await connected();
      await sibling.getByText("已连接", { exact: true }).waitFor();
      const newClient = await page.evaluate(() => sessionStorage.getItem("pi-pane.clientId"));
      assert.notEqual(newClient, storage.client);
    } finally { await sibling.close(); }
  });

  await check("desktop and 390px mobile layouts render without horizontal overflow or runtime errors", async () => {
    await screenshot("browser-final-desktop.png");
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await screenshot("browser-final-mobile.png");
    assert.deepEqual(browserErrors, []);
    return { mobileViewport: "390×844", pageErrors: browserErrors.length };
  });
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = redact(error?.stack || String(error));
  console.error(report.error);
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(outputDir, "browser-failure.png"), fullPage: true }).catch(() => {});
    report.screenshots.push("browser-failure.png");
  }
} finally {
  if (observer) await observer.close().catch(() => observer.socket.terminate());
  if (browser) await browser.close();
  if (fixture) {
    await fixture.close();
    await writeFile(join(outputDir, "browser-fixture-events.jsonl"), await readFile(fixture.eventPath, "utf8"));
    await fixture.remove();
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(join(outputDir, "browser-report.json"), `${JSON.stringify(report, null, 2)}\n`);
}
console.log(`Report: ${join(outputDir, "browser-report.json")}`);
process.exitCode = report.status === "passed" ? 0 : 1;
