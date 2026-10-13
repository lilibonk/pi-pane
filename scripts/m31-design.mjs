#!/usr/bin/env node
/**
 * M31-D visual matrix against the real TUI → /web → RPC page. Every appearance, dialog,
 * navigation, form and conversation is reached through the UI. Evaluation reads DOM/CSS and observes
 * real keyboard events with a temporary DOM listener; it never changes the application store or browser preferences. No real credentials/models.
 * Build first, then: node --import tsx scripts/m31-design.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { exportPageBackground } from "../dist/extension/theme.js";
import { startFixture, waitFor } from "./m0-smoke.mjs";

const out = resolve(process.env.PI_M31_DESIGN_REPORT_DIR || "build-artifacts/m3.1/design");
await mkdir(out, { recursive: true });
const report = {
  startedAt: new Date().toISOString(), scope: "M31-D actual-page visual and interaction matrix",
  browser: "System Google Chrome, headless Playwright", realTui: true, realModelCalls: 0,
  isolation: "temporary HOME/agent/workspace, environment allowlist, local deterministic provider, PI_OFFLINE=1",
  limits: ["Screenshots and measured UI checks require human visual review; this is not a pixel-baseline comparison.",
    "Viewport emulation does not establish behavior of a physical phone or its software keyboard.",
    "Natural workspace keyboard checks install and remove a temporary capture listener; queued real Event references are read after actual key dispatch to observe final defaultPrevented, without app-store or focus mutation through evaluation.",
    "Theme source binding and malformed-manifest rejection are covered by unit tests, not by mutating shipped resources in this browser run."],
  checks: [], screenshots: [], pageErrors: [], externalRequests: [], layout: [], colors: [], focus: [], status: "running",
  assertionChanges: [
    { location: "natural keyboard boundary evidence", before: "require a sampled body focus when the mobile browser crosses the page boundary", after: "observe final defaultPrevented=false for every real Tab/Shift+Tab, verify all controls in DOM order and actual first/last boundary keys, retaining visibility and ring assertions", reason: "Preflight attempt2 showed headless mobile Chrome naturally wraps without a body sample. Browser-native wrap is not an application focus trap." },
    { location: "chooseLook/surfaceMatrix", before: "close settings and immediately scroll the mobile conversation", after: "assert settings returns to its navigation entry, explicitly return to conversation, then retain the original visible content checks", reason: "rc.4 baseline mobile-light stopped at the hidden message; settings intentionally retains the navigation full view." },
    { location: "mobile keyboard", before: "Tab/Shift+Tab must stay trapped in workspace-sidebar", after: "inactive retained pages are inert, natural Tab is unprevented and covers the complete control order and boundary keys, Escape restores the exact header opener", reason: "Mobile workspace navigation is a full page rather than a modal. True settings focus-trap and focus-ring assertions remain unchanged." },
    { location: "navigation search keyboard ring", before: "only the active input's own outline/shadow can satisfy the visible ring assertion", after: "keep input focus-visible and strictly verify the known visible .panel-search:focus-within carrier's actual nontransparent outline; record active/carrier details before assertions", reason: "Preflight attempt1 failed at a legitimate grouped search input: style.css places its ring on .panel-search and deliberately removes the input outline." },
  ],
};
const redact = value => String(value).replace(/#t=[A-Za-z0-9_-]+/g, "#t=[REDACTED]").replace(/pi-pane\.bearer\.[A-Za-z0-9_-]+/g, "pi-pane.bearer.[REDACTED]");
let fixture, browser;
const expectedBackgrounds = new Map();

async function check(id, name, run) {
  const started = Date.now();
  try {
    const details = await run();
    report.checks.push({ id, name, status: "passed", durationMs: Date.now() - started, ...(details ? { details } : {}) });
    console.log(`PASS ${id} ${name}`);
  } catch (error) {
    report.checks.push({ id, name, status: "failed", durationMs: Date.now() - started, error: redact(error.stack ?? error) });
    throw error;
  }
}

async function shot(page, name) {
  await page.screenshot({ path: join(out, `${name}.png`), animations: "disabled" });
  report.screenshots.push(`${name}.png`);
}

async function layout(page, name) {
  const result = await page.evaluate(() => {
    const visible = element => element.getClientRects().length && getComputedStyle(element).visibility !== "hidden" && !element.closest('[inert], [aria-hidden="true"]');
    const surfaces = [...document.querySelectorAll(".dialog, .settings-body, .provider-form, .conversation-panel, .composer, .workspace-sidebar, .workspace-inspector")]
      .filter(visible).map(element => ({ selector: element.className, width: element.clientWidth, content: element.scrollWidth }));
    return { viewport: { width: innerWidth, height: innerHeight }, page: document.documentElement.scrollWidth,
      surfaces, overflow: surfaces.filter(item => item.content > item.width + 1) };
  });
  report.layout.push({ name, ...result });
  assert.ok(result.page <= result.viewport.width + 1, `${name}: page overflows (${result.page}/${result.viewport.width})`);
  assert.deepEqual(result.overflow, [], `${name}: content surfaces do not overflow horizontally`);
  return result;
}

async function colors(page, name) {
  const result = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const names = ["--bg", "--fg", "--fg-muted", "--fg-dim", "--accent", "--border", "--surface", "--sidebar-bg", "--button-fg"];
    const vars = Object.fromEntries(names.map(key => [key, style.getPropertyValue(key).trim()]));
    const rgb = value => /^#[a-f\d]{6}$/i.test(value) ? [1, 3, 5].map(start => Number.parseInt(value.slice(start, start + 2), 16) / 255) : undefined;
    const luminance = value => rgb(value)?.map(part => part <= .04045 ? part / 12.92 : ((part + .055) / 1.055) ** 2.4).reduce((sum, part, index) => sum + part * [.2126, .7152, .0722][index], 0);
    const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return x === undefined || y === undefined ? null : Number(((Math.max(x, y) + .05) / (Math.min(x, y) + .05)).toFixed(2)); };
    return { vars, colorScheme: style.colorScheme, contrast: {
      text: contrast(vars["--fg"], vars["--bg"]), muted: contrast(vars["--fg-muted"], vars["--bg"]),
      dim: contrast(vars["--fg-dim"], vars["--bg"]), accent: contrast(vars["--accent"], vars["--bg"]),
      button: contrast(vars["--button-fg"], vars["--accent"]),
    } };
  });
  report.colors.push({ name, ...result });
  assert.ok(result.contrast.text >= 4.5, `${name}: body text contrast ${result.contrast.text}`);
  assert.ok(result.contrast.button >= 4.5, `${name}: primary button contrast ${result.contrast.button}`);
  return result;
}

async function closeInspector(page) {
  const close = page.getByRole("button", { name: "关闭工作区面板", exact: true });
  if (await close.isVisible()) await close.click();
}

async function openSidebar(page) {
  await closeInspector(page);
  const sidebar = page.locator(".workspace-sidebar");
  if (await sidebar.getAttribute("aria-hidden") === "true") await page.getByRole("button", { name: "打开工作区与会话", exact: true }).click();
  return sidebar;
}

async function closeSidebar(page) {
  const close = page.getByRole("button", { name: "关闭会话侧栏", exact: true });
  if (await close.isVisible()) {
    await close.click();
    await page.locator(".workspace-sidebar").waitFor({ state: "hidden" });
    assert.equal(await page.locator(".workspace-sidebar").getAttribute("aria-hidden"), "true");
    await page.locator(".conversation-panel").waitFor({ state: "visible" });
  }
}

async function openSettings(page, section = "外观") {
  if (!await page.locator(".settings-dialog").isVisible()) {
    await openSidebar(page);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.locator(".settings-dialog").waitFor();
  }
  await page.getByRole("group", { name: "设置分类" }).getByRole("button", { name: section, exact: true }).click();
}

async function closeModal(page) {
  await page.keyboard.press("Escape");
  await page.locator(".dialog-backdrop").waitFor({ state: "detached" });
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
}

async function chooseLook(page, title) {
  await openSettings(page);
  // Wait for the host catalogue, not just the immediately rendered four viewer-mode buttons.
  await page.getByRole("radio", { name: "pi-pane-porcelain", exact: true }).waitFor();
  const option = page.getByRole("radio", { name: title, exact: true });
  await option.waitFor();
  const alreadySaved = await option.locator("small").count() > 0;
  await option.click();
  await waitFor(async () => await option.getAttribute("aria-checked") === "true", `${title} selected`);
  if (!alreadySaved) {
    const commit = page.getByRole("button", { name: "使用此外观", exact: true });
    await commit.waitFor(); await commit.click();
    await option.locator("small").waitFor();
    await page.locator(".setting-preview").waitFor({ state: "detached" });
  }
  const expected = expectedBackgrounds.get(title);
  if (expected) await waitFor(async () => await page.evaluate(value => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() === value, expected), `${title} colors applied from its theme file`);
  await closeModal(page);
  await waitFor(() => page.locator(".workspace-sidebar .settings-button").evaluate(node => node === document.activeElement), "appearance settings restores its navigation entry", 3_000);
  await closeSidebar(page);
  if (expected) assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()), expected, `${title} stayed selected after closing settings`);
  // Two animation frames let the host's directed theme reply paint without imposing a fixed sleep.
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
}

async function send(page, text) {
  await page.getByRole("textbox", { name: "消息", exact: true }).fill(text);
  await page.getByRole("button", { name: /^(发送 ↗|请求 followUp ↗)$/ }).click();
}

async function focusTrap(page, selector, name) {
  const target = page.locator(selector);
  const count = await target.locator('button:enabled, input:enabled, textarea:enabled, select:enabled, a[href], summary').evaluateAll(elements => elements.filter(element => element.getClientRects().length && !element.closest("[inert]")).length);
  assert.ok(count > 0, `${name}: has keyboard controls`);
  // Traverse both boundaries through real keyboard input, not by focusing hidden or disabled nodes.
  for (let index = 0; index < count + 2; index++) {
    await page.keyboard.press("Tab");
    assert.ok(await target.evaluate(element => element.contains(document.activeElement)), `${name}: Tab remains inside`);
  }
  for (let index = 0; index < 3; index++) {
    await page.keyboard.press("Shift+Tab");
    assert.ok(await target.evaluate(element => element.contains(document.activeElement)), `${name}: Shift+Tab remains inside`);
  }
  const active = await page.evaluate(() => {
    const element = document.activeElement, style = getComputedStyle(element);
    return { tag: element.tagName, name: element.getAttribute("aria-label") || element.textContent?.trim().slice(0, 90),
      visible: element.matches(":focus-visible"), outline: style.outlineStyle, width: style.outlineWidth, boxShadow: style.boxShadow };
  });
  assert.ok(active.visible, `${name}: keyboard focus is focus-visible`);
  assert.ok((active.outline !== "none" && Number.parseFloat(active.width) > 0) || active.boxShadow !== "none", `${name}: focused control has a visible ring`);
  return { controls: count, active };
}

async function naturalKeyboard(page, selector, name) {
  const observer = await page.evaluateHandle(selector => {
    const surface = document.querySelector(selector);
    const controls = [...surface.querySelectorAll('button:enabled, input:enabled, textarea:enabled, select:enabled, a[href], summary')].filter(node => node.tabIndex >= 0 && node.getClientRects().length && getComputedStyle(node).visibility === "visible" && !node.closest('[inert], [aria-hidden="true"], details:not([open]) > :not(summary)'));
    const label = node => node.getAttribute("aria-label") || node.textContent?.trim().slice(0, 80) || node.id;
    const records = [];
    const listener = event => {
      if (event.key !== "Tab") return;
      const fromIndex = controls.indexOf(event.target), from = label(event.target);
      // Keep the real Event reference after the capture microtask. read() is called
      // only after Playwright completes dispatch, so defaultPrevented is final.
      queueMicrotask(() => records.push({ event, fromIndex, from }));
    };
    document.addEventListener("keydown", listener, true);
    return { controls, list: controls.map((node, index) => ({ index, tag: node.tagName, label: label(node) })),
      read: () => records.map(({ event, fromIndex, from }) => ({ key: event.key, shiftKey: event.shiftKey, cancelable: event.cancelable, isTrusted: event.isTrusted, defaultPrevented: event.defaultPrevented, fromIndex, from })),
      activeIndex: () => controls.indexOf(document.activeElement),
      dispose: () => document.removeEventListener("keydown", listener, true) };
  }, selector);
  try {
    const controls = await observer.evaluate(state => state.list), count = controls.length;
    assert.ok(count > 0, "the active page has keyboard controls");
    const first = (await observer.evaluateHandle(state => state.controls[0])).asElement();
    const last = (await observer.evaluateHandle(state => state.controls.at(-1))).asElement();
    const events = [];
    const press = async (action, key, fromIndex, nextIndex) => {
      const before = await observer.evaluate(state => state.read().length);
      await action();
      const observed = await waitFor(() => observer.evaluate((state, before) => { const rows = state.read(); return rows.length > before ? rows.slice(before) : null; }, before), `${name}: real ${key} event observed`, 2_000);
      const active = await page.evaluate(selector => {
        const node = document.activeElement, style = getComputedStyle(node);
        const carrier = node.matches(".panel-search input") ? node.closest(".panel-search") : null;
        const groupStyle = carrier && getComputedStyle(carrier), box = carrier?.getBoundingClientRect();
        const group = carrier && { class: carrier.className, focusWithin: carrier.matches(":focus-within"), containsActive: carrier.contains(node), visible: !!carrier.getClientRects().length && groupStyle.visibility === "visible" && Number(groupStyle.opacity) > 0 && !carrier.closest('[inert], [aria-hidden="true"]'), outline: groupStyle.outlineStyle, width: groupStyle.outlineWidth, color: groupStyle.outlineColor, bounds: { x: box.x, y: box.y, width: box.width, height: box.height } };
        const groupRing = !!group && group.focusWithin && group.containsActive && group.visible && !["none", "hidden"].includes(group.outline) && Number.parseFloat(group.width) > 0 && group.color !== "transparent" && !/^rgba\([^)]*,\s*0\)$/.test(group.color);
        return { tag: node.tagName, label: node.getAttribute("aria-label") || node.textContent?.trim().slice(0, 80) || node.id, body: node === document.body || node === document.documentElement, inside: !!node.closest(selector), usable: !!node.getClientRects().length && style.visibility === "visible" && !node.matches(":disabled") && !node.closest('[inert], [aria-hidden="true"]'), focusVisible: node.matches(":focus-visible"), outline: style.outlineStyle, width: style.outlineWidth, color: style.outlineColor, shadow: style.boxShadow, group, groupRing };
      }, selector);
      const activeIndex = await observer.evaluate(state => state.activeIndex());
      report.focus.push({ name, key, expectedFromIndex: fromIndex, events: observed, activeIndex, active });
      assert.equal(observed.length, 1, "each actual key press dispatches one observed Tab event");
      const event = observed[0]; events.push(event);
      assert.equal(event.key, "Tab"); assert.equal(event.shiftKey, key === "Shift+Tab");
      assert.ok(event.isTrusted && event.cancelable, "the observed event is a real cancellable browser keyboard event");
      assert.equal(event.defaultPrevented, false, "the application does not prevent natural workspace Tab or Shift+Tab");
      assert.equal(event.fromIndex, fromIndex, "keyboard traversal reaches the expected control in DOM order");
      if (!active.body) {
        assert.ok(active.inside && active.usable, "keyboard focus never reaches an inactive, hidden or inert page");
        assert.ok(active.focusVisible && (active.outline !== "none" && Number.parseFloat(active.width) > 0 || active.shadow !== "none" || active.groupRing), "keyboard focus has a visible ring on the control or its verified search group");
      }
      if (nextIndex !== undefined) assert.equal(activeIndex, nextIndex, "forward Tab visits every available control in order");
      return { event, activeIndex, active };
    };
    const reverseBoundary = await press(() => first.press("Shift+Tab"), "Shift+Tab", 0);
    assert.ok(reverseBoundary.active.body || reverseBoundary.activeIndex === count - 1, "the first Shift+Tab uses the browser's natural boundary behavior");
    const forwardBoundary = await press(() => last.press("Tab"), "Tab", count - 1);
    assert.ok(forwardBoundary.active.body || forwardBoundary.activeIndex === 0, "the last Tab uses the browser's natural boundary behavior");
    const order = [];
    for (let index = 0; index < count; index++) {
      const result = await press(index === 0 ? () => first.press("Tab") : () => page.keyboard.press("Tab"), "Tab", index, index < count - 1 ? index + 1 : undefined);
      order.push(result.event.fromIndex);
      if (index === count - 1) assert.ok(result.active.body || result.activeIndex === 0, "complete traversal reaches the browser's natural last boundary");
    }
    assert.deepEqual(order, controls.map(item => item.index), "real forward keyboard traversal covers every available control");
    return { controls, events, order, reverseBoundary, forwardBoundary, appPreventedTabs: 0, eventObservation: "capture listener, queued real Event references, final defaultPrevented read after actual dispatch" };
  } finally {
    await observer.evaluate(state => state.dispose()); await observer.dispose();
  }
}

async function navigationKeyboard(page) {
  const target = page.locator(".workspace-sidebar");
  assert.equal(await target.getAttribute("role"), null, "navigation has no dialog role");
  assert.equal(await target.getAttribute("aria-modal"), null, "navigation has no modal semantics");
  assert.equal(await target.getAttribute("inert"), null, "active navigation is interactive");
  for (const selector of [".conversation-panel", ".workspace-inspector"]) {
    const inactive = page.locator(selector);
    assert.equal(await inactive.count(), 1, "inactive pages retain their DOM");
    assert.equal(await inactive.getAttribute("inert"), "", "inactive full pages are inert");
    assert.equal(await inactive.isVisible(), false, "inactive full pages are hidden");
  }
  assert.equal(await page.locator(".drawer-backdrop, .dialog-backdrop").count(), 0);
  return naturalKeyboard(page, ".workspace-sidebar", "mobile-navigation-natural-keyboard");
}

async function decorations(page) {
  return page.locator(".theme-decoration").evaluateAll(elements => elements.map(element => {
    const style = getComputedStyle(element), box = element.getBoundingClientRect();
    return { slot: element.getAttribute("data-slot"), shown: !!box.width && !!box.height && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0,
      opacity: style.opacity, mask: style.maskImage || style.webkitMaskImage, color: style.backgroundColor,
      pointerEvents: style.pointerEvents, inContent: !!element.closest(".message, .markdown, .diff, .provider-form, .tool-body, .composer, .setting-row") };
  }));
}

async function surfaceMatrix(page, prefix, title) {
  await chooseLook(page, title);
  await colors(page, prefix);
  await layout(page, `${prefix}-workbench`);
  await page.locator(".message-assistant .markdown").last().scrollIntoViewIfNeeded();
  await shot(page, `${prefix}-workbench`);

  const tool = page.locator(".tool-card").first();
  if (!await tool.evaluate(element => element.open)) await tool.locator("summary").click();
  await tool.scrollIntoViewIfNeeded();
  await shot(page, `${prefix}-tool`);

  await page.getByRole("button", { name: "文件与改动", exact: true }).click();
  const inspector = page.locator(".workspace-inspector");
  await inspector.getByRole("button", { name: "改动", exact: true }).click();
  await inspector.getByRole("button", { name: /design-fixture\.ts/ }).click();
  await inspector.locator(".diff-add").first().waitFor();
  await layout(page, `${prefix}-diff`);
  await shot(page, `${prefix}-diff`);
  await closeInspector(page);

  await openSettings(page);
  await layout(page, `${prefix}-settings`);
  await shot(page, `${prefix}-settings`);
  await openSettings(page, "账户");
  await page.getByRole("searchbox", { name: "查找服务商" }).fill("openai");
  await page.locator(".account-item").first().waitFor();
  await layout(page, `${prefix}-accounts`);
  await shot(page, `${prefix}-accounts`);

  await openSettings(page, "自定义供应商");
  await page.getByRole("button", { name: "添加供应商", exact: true }).click();
  await page.locator("#provider-id").fill("design-local");
  await page.locator("#provider-url").fill("https://example.invalid/v1");
  await page.getByLabel("第 1 个模型的 ID").fill("design-model");
  await page.getByLabel("第 1 个模型的显示名").fill("设计验收模型");
  await page.getByLabel("第 1 个模型的上下文长度").fill("32000");
  await layout(page, `${prefix}-provider-form`);
  await page.locator("#provider-id").scrollIntoViewIfNeeded();
  await shot(page, `${prefix}-provider-form`);
  await page.locator("#provider-url").fill("invalid-address");
  await page.locator(".provider-form").getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "请填写完整的地址" }).waitFor();
  assert.equal(await page.locator("#provider-url").getAttribute("aria-invalid"), "true");
  await layout(page, `${prefix}-provider-error`);
  await shot(page, `${prefix}-provider-error`);
  await closeModal(page);

  const sidebar = await openSidebar(page);
  const addProject = sidebar.locator(".project-add-menu");
  await addProject.locator("summary").click();
  await addProject.getByRole("button", { name: "打开项目", exact: true }).click();
  await page.getByRole("heading", { name: "打开项目", exact: true }).waitFor();
  await layout(page, `${prefix}-project`);
  await shot(page, `${prefix}-project`);
  await page.getByRole("textbox", { name: "文件夹的绝对路径" }).fill(join(fixture.cwd, "missing-design-fixture"));
  await page.getByRole("button", { name: "前往", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "不存在" }).waitFor();
  await layout(page, `${prefix}-project-error`);
  await shot(page, `${prefix}-project-error`);
  await closeModal(page);
  await closeSidebar(page);
}

try {
  report.sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  for (const [title, file] of [["浅色", resolve("themes/pi-pane-light.json")], ["深色", resolve("themes/pi-pane-dark.json")], ["pi-pane-porcelain", resolve("themes/pi-pane-porcelain.json")],
    ["light", join(getPackageDir(), "dist/modes/interactive/theme/light.json")], ["dark", join(getPackageDir(), "dist/modes/interactive/theme/dark.json")]]) {
    const bg = exportPageBackground(JSON.parse(await readFile(file, "utf8")));
    assert.match(bg, /^#[a-f\d]{6}$/i, `${title}: expected background is present in the source theme`);
    expectedBackgrounds.set(title, bg);
  }
  report.expectedBackgrounds = Object.fromEntries(expectedBackgrounds);
  fixture = await startFixture({ loadThemes: true, extraExtensions: ["tests/fixtures/handoff-fixture.ts"],
    prepareAgentDir: async (_agentDir, directory) => {
      const cwd = join(directory, "workspace"), file = join(cwd, "design-fixture.ts");
      const env = Object.fromEntries(["PATH", "TMPDIR", "LANG", "LC_ALL"].filter(key => process.env[key]).map(key => [key, process.env[key]]));
      Object.assign(env, { HOME: directory, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });
      const git = args => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "user.name=M31 Design Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd, env, stdio: "ignore" });
      git(["init", "--quiet"]);
      await writeFile(file, 'export function welcome(name: string) {\n  return `Hello, ${name}`;\n}\n');
      git(["add", "design-fixture.ts"]); git(["commit", "--quiet", "-m", "Synthetic visual fixture"]);
      await writeFile(file, 'export function welcome(name: string) {\n  const greeting = `你好，${name}`;\n  return greeting;\n}\n');
    },
  });
  report.piVersion = fixture.piVersion;
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const contexts = [];
  for (const viewport of [{ name: "desktop", width: 1280, height: 720 }, { name: "mobile", width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, colorScheme: "light",
      ...(viewport.name === "mobile" ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}) });
    const page = await context.newPage(); page.setDefaultTimeout(15_000);
    page.on("pageerror", error => report.pageErrors.push({ viewport: viewport.name, error: redact(error.message) }));
    page.on("request", request => {
      const url = new URL(request.url());
      if (!new Set(["127.0.0.1", "localhost"]).has(url.hostname) && !["data:", "blob:"].includes(url.protocol)) report.externalRequests.push(`${url.origin}${url.pathname}`);
    });
    await page.goto(fixture.url); await page.getByText("已连接", { exact: true }).waitFor();
    await closeInspector(page);
    contexts.push({ context, page, viewport });
    if (viewport.name === "desktop") {
      await check("CONTENT", "a real local-provider turn renders Markdown/code and a real tool result", async () => {
        const toolPrompt = "M0_TOOL M31_DESIGN_TOOL";
        await send(page, toolPrompt);
        await page.locator(".message-assistant").filter({ hasText: `M0_REPLY:${toolPrompt}:complete` }).waitFor({ timeout: 30_000 });
        const prompt = "M31_DESIGN_MARKDOWN\n\n## 一个安静的工作台\n\n正文、**强调**与 `inline code`。\n\n```typescript\nconst greeting: string = '你好，pi';\nconsole.log(greeting);\n```\n\n| 内容 | 状态 |\n| --- | --- |\n| 项目与会话 | 就绪 |\n\n> 内容的层级由字号、留白和主题表达。";
        await send(page, prompt);
        await page.locator(".message-assistant .markdown h2").filter({ hasText: "一个安静的工作台" }).waitFor();
        await waitFor(async () => await page.getByLabel("模型", { exact: true }).isEnabled(), "provider turn settled");
        await page.locator(".message-assistant .markdown pre code").last().waitFor();
        return { provider: "pi-pane-m0/deterministic", remoteCalls: 0 };
      });
    }

    for (const [name, title] of [["light", "浅色"], ["dark", "深色"], ["pi-light", "light"], ["pi-dark", "dark"], ["porcelain", "pi-pane-porcelain"]]) {
      await check(`${viewport.name}-${name}`, `${viewport.width}×${viewport.height}: ${title}, all main surfaces`, () => surfaceMatrix(page, `${viewport.name}-${name}`, title));
    }

    await check(`${viewport.name}-navigation`, "session actions, rename cancellation, branch navigation and project menu work through their visible controls", async () => {
      const sidebar = await openSidebar(page);
      const menu = sidebar.locator(".session-menu"), summary = menu.locator("summary");
      await summary.click();
      await menu.getByRole("button", { name: "重命名", exact: true }).click();
      await sidebar.getByRole("textbox", { name: "会话名称", exact: true }).fill("M31 cancelled rename");
      await shot(page, `${viewport.name}-session-rename`);
      await sidebar.locator(".rename-session").getByRole("button", { name: "取消", exact: true }).click();
      assert.equal(await sidebar.locator(".rename-session").count(), 0);
      assert.equal(await sidebar.getByText("M31 cancelled rename", { exact: true }).count(), 0, "cancel did not rename the session");
      await summary.click();
      await menu.getByRole("button", { name: "分支树", exact: true }).click();
      await sidebar.locator(".tree-entry").first().waitFor();
      await layout(page, `${viewport.name}-tree`); await shot(page, `${viewport.name}-tree`);
      await sidebar.getByRole("button", { name: "← 返回会话列表", exact: true }).click();
      await sidebar.locator(".session-row").first().waitFor();
      await summary.click();
      await menu.getByRole("button", { name: "会话信息", exact: true }).click();
      await page.getByRole("heading", { name: "会话信息", exact: true }).waitFor();
      await closeModal(page);
      const restored = await page.evaluate(() => ({ tag: document.activeElement?.tagName, class: document.activeElement?.className,
        label: document.activeElement?.getAttribute("aria-label"), text: document.activeElement?.textContent?.trim().slice(0, 100),
        drawerOpen: document.querySelector('.sidebar-toggle')?.getAttribute("aria-expanded") }));
      report.focus.push({ name: `${viewport.name}-session-info-closed`, ...restored });
      if (viewport.name === "mobile") assert.equal(await page.locator(".sidebar-toggle").getAttribute("aria-expanded"), "true", "Escape closes the dialog while keeping its drawer open");
      assert.ok(await summary.evaluate(element => element === document.activeElement), `session-info dialog restores focus to menu summary: ${JSON.stringify(restored)}`);
      await summary.click(); await page.keyboard.press("Escape");
      await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
      assert.equal(await menu.evaluate(element => element.open), false);
      if (viewport.name === "mobile") assert.equal(await page.locator(".sidebar-toggle").getAttribute("aria-expanded"), "true", "Escape closes the session menu while keeping the drawer open");
      assert.ok(await summary.evaluate(element => element === document.activeElement), "session menu restores focus to summary");
      const add = sidebar.locator(".project-add-menu"), addSummary = add.locator("summary");
      await addSummary.click();
      await add.getByRole("button", { name: "打开项目", exact: true }).waitFor();
      await shot(page, `${viewport.name}-project-menu`);
      await page.keyboard.press("Escape");
      await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
      assert.equal(await add.evaluate(element => element.open), false);
      assert.ok(await addSummary.evaluate(element => element === document.activeElement), "project menu restores focus to summary");
      if (viewport.name === "mobile") assert.equal(await page.locator(".sidebar-toggle").getAttribute("aria-expanded"), "true", "Escape closes the menu while keeping the drawer open");
      await closeSidebar(page);
    });

    await check(`${viewport.name}-keyboard`, "settings traps focus; mobile full-page navigation uses natural keyboard order and Escape restores its opener", async () => {
      await openSettings(page);
      const dialog = await focusTrap(page, '.dialog[aria-labelledby="settings-title"]', `${viewport.name} settings`);
      await shot(page, `${viewport.name}-settings-keyboard`);
      await closeModal(page);
      let drawer;
      if (viewport.name === "mobile") {
        await openSidebar(page);
        drawer = await navigationKeyboard(page);
        await shot(page, "mobile-drawer-keyboard");
        await page.keyboard.press("Escape");
        assert.equal(await page.getByRole("button", { name: "打开工作区与会话", exact: true }).getAttribute("aria-expanded"), "false");
        await waitFor(async () => await page.getByRole("button", { name: "打开工作区与会话", exact: true }).evaluate(element => element === document.activeElement), "drawer restores focus to its opener", 2_000);
      }
      return { dialog, ...(drawer ? { drawer } : {}) };
    });

    await check(`${viewport.name}-system`, "following the device responds to dark/light changes and survives reload", async () => {
      await chooseLook(page, "跟随此设备的浅色或深色");
      await page.emulateMedia({ colorScheme: "light" });
      await waitFor(async () => await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme) === "light", "system light applied");
      const light = await colors(page, `${viewport.name}-system-light`); await shot(page, `${viewport.name}-system-light`);
      await page.emulateMedia({ colorScheme: "dark" });
      await waitFor(async () => await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme) === "dark", "system dark applied");
      const dark = await colors(page, `${viewport.name}-system-dark`); await shot(page, `${viewport.name}-system-dark`);
      assert.notEqual(light.vars["--bg"], dark.vars["--bg"]);
      await page.reload(); await page.getByText("已连接", { exact: true }).waitFor(); await closeInspector(page);
      await waitFor(async () => await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme) === "dark", "saved system preference restored");
      await page.emulateMedia({ colorScheme: "light" });
    });

    await check(`${viewport.name}-decorations`, "porcelain decor follows its switch, theme, high contrast and forced colors without changing layout", async () => {
      await chooseLook(page, "pi-pane-porcelain");
      await openSettings(page);
      const toggle = page.getByRole("checkbox", { name: /^显示主题装饰/ });
      assert.equal(await toggle.isChecked(), true, "decorations default to enabled");
      const before = await page.locator(".settings-dialog").boundingBox();
      const normal = await decorations(page);
      if (viewport.name === "desktop") assert.ok(normal.some(item => item.shown), "desktop porcelain has decoration");
      assert.ok(normal.every(item => ["brand", "empty", "settingsHeader", "divider"].includes(item.slot)), "only declared slots");
      assert.ok(normal.every(item => !item.inContent), "no decoration under content");
      assert.ok(normal.filter(item => item.shown).every(item => item.pointerEvents === "none" && item.mask !== "none"), "decorations are non-interactive masks");
      await shot(page, `${viewport.name}-decorations-on`);
      await toggle.uncheck();
      assert.equal((await decorations(page)).filter(item => item.shown).length, 0);
      await page.getByRole("button", { name: "使用此外观", exact: true }).click();
      const after = await page.locator(".settings-dialog").boundingBox();
      assert.deepEqual(after, before, "decoration does not change dialog bounds");
      await shot(page, `${viewport.name}-decorations-off`);
      await closeModal(page);
      await page.reload(); await page.getByText("已连接", { exact: true }).waitFor(); await closeInspector(page); await openSettings(page);
      assert.equal(await toggle.isChecked(), false, "decoration preference survives reload");
      await toggle.check();
      await page.getByRole("button", { name: "使用此外观", exact: true }).click();
      await page.emulateMedia({ forcedColors: "active" });
      assert.equal((await decorations(page)).filter(item => item.shown).length, 0, "forced colors hides decor");
      await shot(page, `${viewport.name}-forced-colors`);
      await page.emulateMedia({ forcedColors: "none", contrast: "more" });
      assert.equal((await decorations(page)).filter(item => item.shown).length, 0, "high contrast hides decor");
      await page.emulateMedia({ contrast: "no-preference" });
      await closeModal(page);
      await chooseLook(page, "浅色");
      assert.equal((await decorations(page)).filter(item => item.shown).length, 0, "changing theme removes decor");
      return { normal, unchangedBounds: before };
    });
  }

  // The session is shared by these two real browser clients. Make it empty only after both have
  // captured their populated conversation; keep it empty while checking every theme/view size.
  await check("EMPTY", "an actual new session presents the centered empty-state composer across themes and viewports", async () => {
    await openSidebar(contexts[0].page);
    await contexts[0].page.getByRole("button", { name: "新建会话", exact: true }).click();
    for (const { page, viewport } of contexts) {
      await waitFor(async () => await page.locator(".message").count() === 0, "real new session snapshot");
      await closeSidebar(page);
      for (const [name, title] of [["light", "浅色"], ["dark", "深色"], ["pi-light", "light"], ["pi-dark", "dark"], ["porcelain", "pi-pane-porcelain"]]) {
        await chooseLook(page, title);
        await page.locator(".empty-state").waitFor();
        await layout(page, `${viewport.name}-${name}-empty`);
        const input = await page.getByRole("textbox", { name: "消息", exact: true }).boundingBox();
        assert.ok(input && input.width > 150 && input.y >= 0 && input.y + input.height <= viewport.height, "empty-state input is visible and usable");
        await shot(page, `${viewport.name}-${name}-empty`);
      }
    }
  });
  assert.deepEqual(report.pageErrors, [], "no uncaught page errors");
  assert.deepEqual(report.externalRequests, [], "no remote browser resource requests");
  const settings = JSON.parse(await readFile(join(fixture.agentDir, "settings.json"), "utf8"));
  assert.equal(settings.theme, undefined, "browser appearance changes did not write pi's global theme");
  assert.deepEqual(JSON.parse(await readFile(join(fixture.agentDir, "auth.json"), "utf8")), {}, "no credentials were stored");
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.error = redact(error.stack ?? error); process.exitCode = 1;
  console.error(report.error);
  for (const [index, page] of (browser?.contexts().flatMap(context => context.pages()) ?? []).entries()) await shot(page, `failure-${index}`).catch(() => {});
} finally {
  report.cleanup = { browserClosed: !browser, hostClosed: !fixture, fixtureRemoved: !fixture };
  try { await browser?.close(); report.cleanup.browserClosed = true; } catch (error) { report.cleanup.browserError = redact(error); }
  if (fixture) {
    try { await fixture.close(); report.cleanup.hostClosed = true; } catch (error) { report.cleanup.hostError = redact(error); }
    try { await fixture.remove(); report.cleanup.fixtureRemoved = true; } catch (error) { report.cleanup.removeError = redact(error); }
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.status.toUpperCase()} — ${report.checks.filter(item => item.status === "passed").length}/${report.checks.length} checks; report: ${join(out, "report.json")}`);
}
