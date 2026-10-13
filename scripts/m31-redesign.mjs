#!/usr/bin/env node
/**
 * Built-checkout UI verification. Build the selected checkout first, then:
 *   PI_M0_EXTENSION="$PWD/dist/extension/index.js" node --import tsx scripts/m31-redesign.mjs
 * This starts the real pi TUI → /web → RPC fixture, with a temporary HOME and the
 * local deterministic provider. Archive exact-install startup is verified separately.
 * All product actions use visible browser controls. Evaluation reads DOM/CSS and observes
 * real keyboard events with a temporary DOM listener; no application-store, preference, authentication, or socket mutation is used.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { applyProjectionEvent } from "../dist/protocol/index.js";
import { startFixture, textOf, waitFor } from "./m0-smoke.mjs";

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.env.PI_M31_REDESIGN_REPORT_DIR || join(checkout, "build-artifacts/releases/0.3.0-rc.4/verification", `redesign-${new Date().toISOString().replace(/[:.]/g, "-")}`));
const viewports = [
  { name: "desktop-1280", width: 1280, height: 720, mobile: false },
  { name: "desktop-1024", width: 1024, height: 768, mobile: false },
  { name: "mobile-390", width: 390, height: 844, mobile: true },
  { name: "mobile-320", width: 320, height: 740, mobile: true },
];
const sections = ["外观", "模型默认", "会话行为", "账户", "自定义供应商", "其他设置"];
const report = {
  startedAt: new Date().toISOString(), scope: "M31-D built checkout browser verification",
  artifactKind: "built checkout", releaseAction: "none",
  baseline: "Before-edit reports are retained separately; these screenshots and measured actions verify the selected checkout's built dist.",
  exactInstall: "Separate evidence: this run loads checkout dist through the real TUI and does not install or launch from a tarball.",
  browser: "System Google Chrome, headless Playwright", realTui: true, realRemoteModelCalls: 0,
  isolation: "fresh temporary HOME/agent/workspace per viewport; inherited environment allowlist; PI_OFFLINE=1; local deterministic provider",
  limits: [
    "These are actual browser screenshots and measured behavior, not a pixel-baseline comparison or human visual approval.",
    "Mobile sizes emulate viewports and touch input, not a physical phone, its browser chrome, or its software keyboard.",
    "Natural workspace keyboard checks install and remove a temporary capture listener; queued real Event references are read after actual key dispatch to observe final defaultPrevented, without app-store or focus mutation through evaluation.",
    "The provider and public extension tool are deterministic local fixtures; no provider login or remote model is tested.",
    "The check covers the existing file/diff/resource capabilities; it does not introduce or exercise new Git write operations.",
  ],
  checks: [], screenshots: [], layouts: [], controls: [], focus: [], focusPaths: [], references: [], commandInsertions: [], runs: [], pageErrors: [], externalRequests: [], cleanup: [], status: "running", expectedChecks: 36,
  assertionChanges: [
    { location: "natural workspace keyboard evidence", before: "no direct final defaultPrevented/order observation for the mobile navigation and inspector", after: "temporary capture listener observes queued real key events after dispatch; every Tab/Shift+Tab remains unprevented, every control is visited in order, first/last boundary keys and all visible rings are verified", reason: "Verify application keyboard behavior without assuming headless mobile Chrome exposes a body focus at its browser-native boundary." },
    { location: "03 actual file reference", before: "reference contains 文件：redesign-fixture.ts", after: "reference contains 文件： followed by JSON.stringify(path), the entire actual fixture source and the original draft", reason: "All four rc.4 baseline 03 failures used an unquoted path expectation; the product has always quoted the path." },
    { location: "02 desktop space recovery", before: "chat width alone grows by >100 px after collapsing navigation", after: "chat grows and chat+dock recover the measured navigation width, after bounded layout settlement", reason: "At 1024 the two columns share the 200 px navigation space, so exactly 100 px per column is correct. The replacement checks the complete recovered space." },
    { location: "mobile checkbox targets", before: "only an enclosing label is considered a native checkbox's target", after: "measure visible associated node.labels (including for/id), report input and target dimensions, and keep the >=40x40 requirement", reason: "The actual settings label is a for/id sibling. A label below the threshold still fails; no arbitrary ancestor or threshold relaxation is allowed." },
    { location: "settings composer restoration", before: "returnConversation permits queued close-panel RAF to overlap immediately submitted /settings", after: "settle existing close-panel rendering before submitting, record the opener and retain exact composer restoration and failure diagnostics", reason: "Desktop baseline 04 timed out; this addresses a possible script sequencing race without changing the required focus destination. Any remaining failure is a product issue." },
    { location: "08 responsive", before: "only desktop-1280 runs a geometry/draft check and immediately samples desktop class", after: "each of four viewports runs all five focus paths with bounded media/layout settlement and real commands; no click is inserted before recovery assertions", reason: "Produce exactly 9 checks per viewport (36 total) and make the five requested focus paths independently observable." },
    { location: "02 project and connection visibility", before: "header has no full-path interaction or connection text visibility assertion", after: "click the real 查看项目完整路径 button, verify the full host path in session info and exact button restoration; measure complete connection text", reason: "Verify rc.4 header affordance and removed clipping through actual controls without introducing a mock action." },
    { location: "report metadata and evidence output", before: "working-tree/rc.3-only wording and a reused historical default directory", after: "built-checkout package version and optional caller-supplied archive SHA association, separate exact-install provenance, and a fresh timestamped rc.4 output that rejects nonempty directories", reason: "The same matrix can verify the built frozen checkout without claiming startup from the archive or overwriting before-edit evidence." },
    { location: "keyboard ring evidence", before: "record active focus only after a self-outline/shadow assertion passes", after: "record active and the known .panel-search:focus-within carrier before the assertion; require input focus-visible and an actual visible nontransparent carrier outline when used", reason: "Keep the real modal focus-ring assertion strict while recognizing the product's explicit grouped-search ring and preserving failure diagnostics." },
    { location: "03 committed composer text", before: "read inputValue immediately after reference/command writes the synchronous store", after: "bounded wait for the real rendered input value, preserving quoted path, complete actual file source and prior draft; save actual strings and each predicate", reason: "Attempt4 reached the asynchronous Preact boundary before the DOM value committed. Existing DOM-content requirements remain unchanged." },
    { location: "03 model resource locator", before: "filter has a dock-scoped descendant locator whose ancestor is outside each model candidate", after: "filter has a page-scoped exact provider/id text locator and also require the actual RPC snapshot's matching provider/id", reason: "Playwright evaluates has relative to each candidate; the workspace-inspector ancestor cannot be inside a model button." },
    { location: "08 hidden mobile-return setup", before: "set up Shift+Tab as soon as navigation is displayed, before its queued initial autofocus settles", after: "wait two actual animation frames and verify initial search focus before real keyboard setup; keep the exact hidden-return and resize assertions", reason: "Attempt4 mobile390 autofocus arrived after keyboard setup and returned focus to search. No manual focus or destination relaxation is introduced." },
  ],
};
const fixtures = [], viewers = [];
let browser, outputValidated = false;
const previousExtension = process.env.PI_M0_EXTENSION;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const redact = value => String(value)
  .replace(/#(?:t|token)=[A-Za-z0-9_-]+/g, "#t=[REDACTED]")
  .replace(/pi-pane\.bearer\.[A-Za-z0-9_-]+/g, "pi-pane.bearer.[REDACTED]");
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const composer = page => page.getByRole("textbox", { name: "消息", exact: true });
const panel = page => page.locator(".workspace-inspector");
const sidebar = page => page.locator(".workspace-sidebar");
const main = page => page.locator(".conversation-panel");
const settingsModal = page => page.locator('.dialog[aria-labelledby="settings-title"]');

async function paint(page) { await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))); }
async function focused(page) {
  return page.evaluate(() => {
    const node = document.activeElement;
    if (!(node instanceof HTMLElement)) return { usable: false, tag: null };
    const style = getComputedStyle(node), box = node.getBoundingClientRect();
    const body = node === document.body || node === document.documentElement;
    const blocked = !!node.closest('[inert], [aria-hidden="true"], details:not([open]) > :not(summary)');
    return { tag: node.tagName, label: node.getAttribute("aria-label") || node.textContent?.trim().slice(0, 80) || node.id, title: node.title, class: node.className, body, connected: node.isConnected, visible: !!node.getClientRects().length && style.visibility === "visible", inertOrHidden: blocked, disabled: node.matches(":disabled"), width: box.width, height: box.height,
      usable: !body && node.isConnected && !!node.getClientRects().length && style.visibility === "visible" && !blocked && !node.matches(":disabled") };
  });
}
async function usableFocus(view, name) {
  try { await waitFor(async () => (await focused(view.page)).usable, name, 3_000); }
  catch (error) { report.focus.push({ name, status: "failed", ...(await focused(view.page)) }); throw error; }
  const active = await focused(view.page); report.focus.push({ name, ...active }); return active;
}
async function exactFocus(view, expected, name) {
  try { await waitFor(() => expected.evaluate(node => node.isConnected && node === document.activeElement), name, 3_000); }
  catch (error) { report.focus.push({ name, status: "failed", ...(await focused(view.page)) }); throw error; }
  const active = await usableFocus(view, name);
  return { exact: true, active };
}
async function resize(view, width, height, mobileMode = "conversation") {
  await view.page.setViewportSize({ width, height });
  await waitFor(() => view.page.locator(".workbench").evaluate((node, expected) => {
    if (innerWidth !== expected.width || innerHeight !== expected.height) return false;
    if (expected.width > 760) return !node.classList.contains("mobile-navigation") && !node.classList.contains("mobile-inspector");
    if (expected.mode === "conversation") return !node.classList.contains("mobile-navigation") && !node.classList.contains("mobile-inspector") && node.querySelector(".workspace-sidebar").inert && node.querySelector(".workspace-inspector").inert;
    return node.classList.contains(`mobile-${expected.mode}`);
  }, { width, height, mode: mobileMode }), `media state settles at ${width}x${height} (${mobileMode})`, 3_000);
  await paint(view.page);
}
async function recoverNavigationSpace(view, before) {
  await waitFor(async () => {
    const [chat, dock] = await Promise.all([main(view.page).boundingBox(), panel(view.page).boundingBox()]);
    return chat && dock && chat.width > before.chat.width && chat.width + dock.width >= before.chat.width + before.dock.width + before.navigation.width - 2;
  }, "chat and dock recover the complete collapsed navigation width", 3_000);
  const [chat, dock] = await Promise.all([main(view.page).boundingBox(), panel(view.page).boundingBox()]);
  const recovered = chat.width + dock.width - before.chat.width - before.dock.width;
  assert.ok(Math.abs(recovered - before.navigation.width) <= 2, "the two columns recover the measured navigation width");
  assert.ok(chat.width > before.chat.width, "the conversation gains usable space");
  return { navigationWidth: before.navigation.width, recovered, chatGrowth: chat.width - before.chat.width, dockGrowth: dock.width - before.dock.width };
}
async function headerEvidence(view) {
  const path = await realpath(view.fixture.cwd), opener = view.page.getByRole("button", { name: "查看项目完整路径", exact: true });
  assert.equal(await view.page.locator(".session-identity p[title]").getAttribute("title"), path);
  assert.equal(await opener.getAttribute("title"), path);
  const original = await opener.elementHandle();
  await opener.click();
  const modal = view.page.locator('.dialog[aria-labelledby="session-dialog-title"]');
  await modal.getByRole("heading", { name: "会话信息", exact: true }).waitFor();
  await modal.getByText(path, { exact: true }).waitFor();
  await view.page.keyboard.press("Escape"); await modal.waitFor({ state: "detached" });
  await exactFocus(view, original, `${view.name}-full-project-path-restores-button`);
  const connection = await view.page.locator(".connection > span").last().evaluate(node => {
    const range = document.createRange(); range.selectNodeContents(node);
    const textBox = range.getBoundingClientRect(), box = node.getBoundingClientRect();
    const ancestorClips = [];
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
      if (["hidden", "clip"].includes(style.overflowX) && (textBox.left < bounds.left - 1 || textBox.right > bounds.right + 1)) ancestorClips.push(parent.className);
    }
    return { text: node.textContent?.trim(), textWidth: textBox.width, width: box.width, left: box.left, right: box.right, pageWidth: innerWidth, ancestorClips, clipped: textBox.left < box.left - 1 || textBox.right > box.right + 1 };
  });
  assert.equal(connection.text, "已连接"); assert.equal(connection.clipped, false, "connection status text is completely visible");
  assert.deepEqual(connection.ancestorClips, [], "no ancestor clips the connection status text");
  assert.ok(connection.left >= 0 && connection.right <= connection.pageWidth + 1);
  return { path, exactPathButtonRestoration: true, connection };
}

async function shot(view, name) {
  const file = `${name}.png`;
  await view.page.screenshot({ path: join(out, file), animations: "disabled" });
  report.screenshots.push({ file, viewport: view.name, width: view.page.viewportSize().width, height: view.page.viewportSize().height });
}

async function check(view, id, name, run) {
  const started = Date.now();
  try {
    const details = await run();
    report.checks.push({ id: `${view.name}-${id}`, name, status: "passed", durationMs: Date.now() - started, ...(details ? { details } : {}) });
    console.log(`PASS ${view.name}-${id} ${name}`);
    return true;
  } catch (error) {
    if (id === "08-responsive") { const coverage = report.focusPaths.find(item => item.viewport === view.name); if (coverage) coverage.status = "failed"; }
    report.checks.push({ id: `${view.name}-${id}`, name, status: "failed", durationMs: Date.now() - started, error: redact(error.stack ?? error) });
    console.error(`FAIL ${view.name}-${id}: ${redact(error.message ?? error)}`);
    await shot(view, `${view.name}-${id}-failure`).catch(() => {});
    return false;
  }
}

async function layout(view, name) {
  const measured = await view.page.evaluate(() => {
    const visible = node => {
      if (!node.getClientRects().length || getComputedStyle(node).visibility === "hidden" || node.closest('[aria-hidden="true"]')) return false;
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        if (parent.tagName === "DETAILS" && !parent.open && !parent.querySelector(":scope > summary")?.contains(node)) return false;
      }
      return true;
    };
    const surfaces = [...document.querySelectorAll(".workbench, .conversation-panel, .composer, .composer-toolbar, .workspace-sidebar, .workspace-inspector, .inspector-scroll, .settings-dialog, .settings-body, .provider-form, .dialog")]
      .filter(visible).map(node => ({ class: node.className, width: node.clientWidth, contentWidth: node.scrollWidth }));
    return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth, surfaces };
  });
  report.layouts.push({ name, ...measured });
  assert.ok(measured.documentWidth <= measured.width + 1, `${name}: no page horizontal overflow (${measured.documentWidth}/${measured.width})`);
  assert.deepEqual(measured.surfaces.filter(item => item.contentWidth > item.width + 1), [], `${name}: no content surface horizontal overflow`);
  return measured;
}

async function mobileControls(view, name) {
  if (view.page.viewportSize().width > 760) return;
  const measured = await view.page.evaluate(() => {
    const visible = node => {
      if (!node.getClientRects().length || getComputedStyle(node).visibility === "hidden" || node.closest('[inert], [aria-hidden="true"]')) return false;
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        if (parent.tagName === "DETAILS" && !parent.open && !parent.querySelector(":scope > summary")?.contains(node)) return false;
      }
      return true;
    };
    const label = node => node.getAttribute("aria-label") || node.getAttribute("placeholder") || node.textContent?.trim().slice(0, 80) || node.id || node.tagName;
    const controls = [...new Set(document.querySelectorAll('button, summary, input:not([type="hidden"]):not([type="file"]), select, textarea, [role="radio"], [role="tab"], [role="checkbox"], [role="switch"]'))]
      .filter(visible).map(node => {
        // A labelled native checkbox/radio has the label's real clickable target.
        const labelled = node.matches('input[type="checkbox"], input[type="radio"]') ? [...(node.labels ?? [])].filter(visible) : [];
        const target = labelled.find(item => { const box = item.getBoundingClientRect(); return box.width >= 39.5 && box.height >= 39.5; }) || labelled.sort((a, b) => { const x = a.getBoundingClientRect(), y = b.getBoundingClientRect(); return y.width * y.height - x.width * x.height; })[0] || node;
        const box = target.getBoundingClientRect();
        const inputBox = node.getBoundingClientRect();
        return { label: label(node), tag: node.tagName, disabled: !!node.disabled, targetTag: target.tagName, targetFor: target.htmlFor || null, nativeWidth: Number(inputBox.width.toFixed(2)), nativeHeight: Number(inputBox.height.toFixed(2)), width: Number(box.width.toFixed(2)), height: Number(box.height.toFixed(2)), fontSize: Number.parseFloat(getComputedStyle(node).fontSize), textInput: node.matches('textarea, select, input:not([type="checkbox"]):not([type="radio"])') };
      });
    return { controls, tooSmall: controls.filter(item => item.width < 39.5 || item.height < 39.5), smallText: controls.filter(item => item.textInput && item.fontSize < 15.9) };
  });
  report.controls.push({ name, ...measured });
  assert.deepEqual(measured.tooSmall, [], `${name}: mobile clickable targets are at least 40×40 CSS px`);
  assert.deepEqual(measured.smallText, [], `${name}: mobile inputs and selects use at least 16 CSS px`);
  return { targets: measured.controls.length };
}

async function noWorkbenchModal(view, name, active) {
  const measured = await view.page.evaluate(() => {
    const workbench = document.querySelector(".workbench");
    const shown = node => node.getClientRects().length && getComputedStyle(node).visibility !== "hidden" && !node.closest('[aria-hidden="true"]');
    const surfaces = [...workbench.querySelectorAll(".conversation-panel, .workspace-sidebar, .workspace-inspector")].map(node => ({
      class: node.className, role: node.getAttribute("role"), ariaModal: node.getAttribute("aria-modal"), shown: !!shown(node), inert: !!node.closest("[inert]"), position: getComputedStyle(node).position,
    }));
    return { workbenchClass: workbench.className, display: getComputedStyle(workbench).display,
      backdrops: [...document.querySelectorAll(".drawer-backdrop, .dialog-backdrop")].filter(shown).length,
      dialogs: [...workbench.querySelectorAll('[role="dialog"], [aria-modal="true"]')].filter(shown).length, surfaces };
  });
  report.layouts.push({ name, modalSemantics: measured });
  assert.equal(measured.backdrops, 0, `${name}: workspace navigation/inspection has no backdrop`);
  assert.equal(measured.dialogs, 0, `${name}: workspace navigation/inspection has no dialog or aria-modal semantics`);
  for (const surface of measured.surfaces.filter(item => item.shown)) assert.equal(surface.inert, false, `${name}: visible ${surface.class} is interactive`);
  assert.equal(await active.isVisible(), true, `${name}: intended workspace surface is visible`);
  return measured;
}

async function closeModals(view) {
  for (let attempt = 0; attempt < 4 && await view.page.locator(".dialog-backdrop").count(); attempt++) {
    const count = await view.page.locator(".dialog-backdrop").count();
    await view.page.keyboard.press("Escape");
    await waitFor(async () => await view.page.locator(".dialog-backdrop").count() < count, "the active modal closes before dismissing another", 3_000);
  }
  await view.page.locator(".dialog-backdrop").waitFor({ state: "detached" });
}

async function returnConversation(view) {
  await closeModals(view);
  const rightClose = view.page.getByRole("button", { name: "关闭工作区面板", exact: true });
  if (await rightClose.isVisible()) await rightClose.click();
  const leftClose = view.page.getByRole("button", { name: "关闭会话侧栏", exact: true });
  if (view.page.viewportSize().width <= 760 && await leftClose.isVisible()) await leftClose.click();
  await main(view.page).waitFor({ state: "visible" });
  await composer(view.page).waitFor({ state: "visible" });
  await paint(view.page);
}

async function openInspector(view, tab = "改动") {
  if (!await panel(view.page).isVisible()) {
    await returnConversation(view);
    await view.page.locator(".inspect-toggle").click();
  }
  await panel(view.page).waitFor({ state: "visible" });
  await panel(view.page).getByRole("group", { name: "工作区面板", exact: true }).getByRole("button", { name: tab, exact: true }).click();
  return panel(view.page);
}

async function openNavigation(view) {
  if (!await sidebar(view.page).isVisible()) {
    await returnConversation(view);
    await view.page.locator(".sidebar-toggle").click();
  }
  await sidebar(view.page).waitFor({ state: "visible" });
  return sidebar(view.page);
}

async function send(view, text, mode = "followUp") {
  await composer(view.page).fill(text);
  await view.page.getByRole("button", { name: mode === "steer" ? "steer" : /^(发送 ↗|请求 followUp ↗)$/, exact: mode === "steer" }).click();
}

async function settled(view, text) {
  await waitFor(() => view.snapshot?.state.idle && view.snapshot.session.messages.some(message => message.role === "assistant" && message.status === "complete" && textOf(message) === `M0_REPLY:${text}:` + (text.startsWith("M0_SLOW") ? "0123456789abcdef".repeat(30) : "complete")), `local turn settled: ${text.split("\n")[0]}`, 30_000);
  const users = view.snapshot.session.messages.filter(message => message.role === "user" && textOf(message) === text);
  assert.equal(users.length, 1, "exactly one actual user message was submitted");
}

async function openSettings(view, section = "外观") {
  if (!await settingsModal(view.page).isVisible()) {
    await returnConversation(view);
    await composer(view.page).fill("/settings");
    report.focus.push({ name: `${view.name}-settings-opener-before-command`, ...(await focused(view.page)) });
    await composer(view.page).press("Control+Enter");
    await settingsModal(view.page).waitFor();
  }
  await view.page.getByRole("group", { name: "设置分类", exact: true }).getByRole("button", { name: section, exact: true }).click();
  await view.page.locator(".settings-section-head h3").filter({ hasText: section }).waitFor();
  if (section === "外观") await view.page.getByRole("radio", { name: "浅色", exact: true }).waitFor();
  else if (section === "模型默认") await view.page.getByLabel("默认思考强度", { exact: true }).waitFor();
  else if (section === "会话行为") await waitFor(async () => await view.page.locator(".settings-body .setting-row").count() >= 5, "behavior settings loaded");
  else if (section === "账户") await view.page.getByRole("searchbox", { name: "查找服务商", exact: true }).waitFor();
  else if (section === "自定义供应商") await view.page.getByRole("button", { name: "添加供应商", exact: true }).waitFor();
  else await view.page.locator(".setting-readonly").first().waitFor();
}

async function closeSettings(view) {
  await view.page.keyboard.press("Escape");
  await settingsModal(view.page).waitFor({ state: "detached" });
  await exactFocus(view, composer(view.page), "settings restores composer focus");
  assert.equal(await view.page.locator(".workbench").getAttribute("inert"), null, "settings releases the workspace");
}

async function chooseLook(view, title) {
  await openSettings(view);
  const option = view.page.getByRole("radio", { name: title, exact: true });
  await option.waitFor();
  const saved = await option.locator("small").count() > 0;
  await option.click();
  await waitFor(async () => await option.getAttribute("aria-checked") === "true", `${title} appearance selected`);
  if (!saved) {
    const commit = view.page.getByRole("button", { name: "使用此外观", exact: true });
    await commit.waitFor(); await commit.click();
    await option.locator("small").waitFor();
  }
  await closeSettings(view);
}

async function modalFocus(view, modal, name) {
  assert.equal(await modal.getAttribute("role"), "dialog");
  assert.equal(await modal.getAttribute("aria-modal"), "true");
  assert.equal(await view.page.locator(".workbench").getAttribute("inert"), "", "a true modal makes the workspace inert");
  const count = await modal.locator("button:enabled, input:enabled, textarea:enabled, select:enabled, a[href], summary").evaluateAll(nodes => nodes.filter(node => node.getClientRects().length && getComputedStyle(node).visibility !== "hidden" && !node.closest("[inert]")).length);
  assert.ok(count > 0, "the real modal has usable controls");
  for (let index = 0; index < count + 2; index++) {
    await view.page.keyboard.press("Tab");
    assert.equal(await modal.evaluate(node => node.contains(document.activeElement)), true, "Tab stays within the true modal");
  }
  for (let index = 0; index < 3; index++) {
    await view.page.keyboard.press("Shift+Tab");
    assert.equal(await modal.evaluate(node => node.contains(document.activeElement)), true, "Shift+Tab stays within the true modal");
  }
  const active = await view.page.evaluate(() => {
    const node = document.activeElement, style = getComputedStyle(node);
    const carrier = node.matches(".panel-search input") ? node.closest(".panel-search") : null;
    const groupStyle = carrier && getComputedStyle(carrier), box = carrier?.getBoundingClientRect();
    const group = carrier && { class: carrier.className, focusWithin: carrier.matches(":focus-within"), containsActive: carrier.contains(node), visible: !!carrier.getClientRects().length && groupStyle.visibility === "visible" && Number(groupStyle.opacity) > 0 && !carrier.closest('[inert], [aria-hidden="true"]'), outline: groupStyle.outlineStyle, width: groupStyle.outlineWidth, color: groupStyle.outlineColor, bounds: { x: box.x, y: box.y, width: box.width, height: box.height } };
    const groupRing = !!group && group.focusWithin && group.containsActive && group.visible && !["none", "hidden"].includes(group.outline) && Number.parseFloat(group.width) > 0 && group.color !== "transparent" && !/^rgba\([^)]*,\s*0\)$/.test(group.color);
    return { tag: node.tagName, label: node.getAttribute("aria-label") || node.textContent?.trim().slice(0, 80), focusVisible: node.matches(":focus-visible"), outline: style.outlineStyle, width: style.outlineWidth, color: style.outlineColor, shadow: style.boxShadow, group, groupRing };
  });
  report.focus.push({ name: `${view.name}-${name}`, count, active });
  assert.ok(active.focusVisible && (active.outline !== "none" && Number.parseFloat(active.width) > 0 || active.shadow !== "none" || active.groupRing), "keyboard focus has a visible ring on the control or its verified search group");
  return { controls: count, active };
}
async function settingsFocus(view) { return modalFocus(view, settingsModal(view.page), "settings"); }

async function desktopDock(view, name, testChatFocus = true) {
  await noWorkbenchModal(view, name, panel(view.page));
  assert.equal(await main(view.page).isVisible(), true);
  const [chat, dock] = await Promise.all([main(view.page).boundingBox(), panel(view.page).boundingBox()]);
  assert.ok(chat && dock && dock.x >= chat.x + chat.width - 2, "inspection panel is beside the conversation, within the workspace");
  assert.ok(chat.width >= 300 && dock.width >= 240 && dock.x + dock.width <= view.page.viewportSize().width + 1, "both docked surfaces remain usable");
  assert.ok(!["fixed", "absolute"].includes(await panel(view.page).evaluate(node => getComputedStyle(node).position)), "desktop inspection panel participates in the layout");
  if (testChatFocus) {
    await composer(view.page).click();
    assert.equal(await composer(view.page).evaluate(node => node === document.activeElement), true, "chat input remains focusable while the panel is docked");
  }
  await layout(view, name);
  return { chat, dock };
}

async function wholeView(view, kind, name) {
  const active = kind === "navigation" ? sidebar(view.page) : panel(view.page);
  await waitFor(async () => await view.page.locator(".workbench").evaluate((node, expected) => node.classList.contains(expected), `mobile-${kind}`), `mobile ${kind} mode`);
  await noWorkbenchModal(view, name, active);
  assert.equal(await main(view.page).isVisible(), false, "the mobile workspace selects one full view");
  const box = await active.boundingBox(), size = view.page.viewportSize();
  assert.ok(box && box.x <= 1 && box.y <= 1 && box.width >= size.width - 1 && box.height >= size.height - 2, "mobile workspace surface fills the viewport");
  const close = view.page.getByRole("button", { name: kind === "navigation" ? "关闭会话侧栏" : "关闭工作区面板", exact: true });
  assert.match(await close.innerText(), /返回对话/, "mobile return action is visually named 返回对话");
  await layout(view, name); await mobileControls(view, name); await shot(view, name);
  return { box };
}

async function createViewer(viewport, extension, noProvider = false) {
  const fixture = await startFixture({ loadThemes: true, loadPromptTemplates: true, extraExtensions: [join(checkout, "tests/fixtures/handoff-fixture.ts")],
    ...(noProvider ? { provider: null, model: null, envOverrides: { PI_M0_NO_PROVIDER: "1" } } : {}),
    prepareAgentDir: async (agentDir, directory) => {
      const cwd = join(directory, "workspace");
      const env = Object.fromEntries(["PATH", "TMPDIR", "LANG", "LC_ALL"].filter(key => process.env[key]).map(key => [key, process.env[key]]));
      Object.assign(env, { HOME: directory, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });
      const git = args => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "user.name=M31 Redesign Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd, env, stdio: "ignore" });
      git(["init", "--quiet"]);
      await writeFile(join(cwd, "redesign-fixture.ts"), 'export function welcome(name: string) {\n  return `Hello, ${name}`;\n}\n');
      git(["add", "redesign-fixture.ts"]); git(["commit", "--quiet", "-m", "Synthetic redesign fixture"]);
      await writeFile(join(cwd, "redesign-fixture.ts"), 'export function welcome(name: string) {\n  const greeting = `你好，${name}`;\n  return greeting;\n}\n');
      await mkdir(join(cwd, ".pi", "prompts"), { recursive: true });
      await writeFile(join(cwd, ".pi", "prompts", "m31-redesign-note.md"), "---\ndescription: M31 redesign local prompt fixture\n---\nM31_REDESIGN_TEMPLATE $ARGUMENTS\n");
      new ProjectTrustStore(agentDir).set(await realpath(cwd), true);
    },
  });
  fixtures.push(fixture);
  assert.equal(await realpath(fixture.extension), extension, "the real TUI loaded the selected checkout dist extension");
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, colorScheme: "light", ...(viewport.mobile ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}) });
  const page = await context.newPage(); page.setDefaultTimeout(15_000);
  const view = { ...viewport, fixture, context, page, snapshot: undefined, sent: [], protocolErrors: [] };
  viewers.push(view);
  let assembled;
  page.on("websocket", socket => {
    socket.on("framesent", event => {
      try { const frame = JSON.parse(String(event.payload)); if (["command", "host_command"].includes(frame.t)) view.sent.push({ id: frame.id, command: frame.command, mode: frame.args?.mode }); } catch {}
    });
    socket.on("framereceived", event => {
      try {
        let frame = JSON.parse(String(event.payload));
        if (frame.t === "frame_begin") { assembled = { id: frame.id, parts: frame.parts, chunks: [] }; return; }
        if (frame.t === "frame_chunk") { if (assembled?.id === frame.id && assembled.chunks.length === frame.index) assembled.chunks.push(frame.data); else view.protocolErrors.push("non-contiguous logical frame"); return; }
        if (frame.t === "frame_end") { const done = assembled; assembled = undefined; if (!done || done.id !== frame.id || done.chunks.length !== done.parts) { view.protocolErrors.push("incomplete logical frame"); return; } frame = JSON.parse(done.chunks.join("")); }
        if (frame.t === "snapshot") view.snapshot = structuredClone(frame);
        else if (frame.t === "session_reset") view.snapshot = undefined;
        else if (frame.t === "event") {
          const state = view.snapshot;
          if (!state || frame.epoch !== state.epoch || frame.seq !== state.seq + 1) { view.protocolErrors.push(`event sequence mismatch: ${frame.seq}`); return; }
          view.snapshot = { ...applyProjectionEvent(state, frame.ev), seq: frame.seq };
        }
      } catch (error) { view.protocolErrors.push(redact(error.message ?? error)); }
    });
  });
  page.on("pageerror", error => report.pageErrors.push({ viewport: view.name, error: redact(error.message) }));
  page.on("request", request => {
    const url = new URL(request.url());
    if (!["127.0.0.1", "localhost"].includes(url.hostname) && !["data:", "blob:"].includes(url.protocol)) report.externalRequests.push({ viewport: view.name, url: `${url.origin}${url.pathname}` });
  });
  await page.goto(fixture.url); await page.getByText("已连接", { exact: true }).waitFor();
  await waitFor(() => view.snapshot?.state.idle, "initial real RPC idle", 30_000);
  await returnConversation(view);
  report.runs.push({ viewport, piVersion: fixture.piVersion, extension: fixture.extension, temporaryHome: fixture.directory, workspace: fixture.cwd, realRemoteModelCalls: 0 });
  return view;
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

async function retainedMobilePage(view, kind, name) {
  const active = kind === "navigation" ? sidebar(view.page) : panel(view.page);
  await waitFor(() => view.page.locator(".workbench").evaluate((node, value) => node.classList.contains(`mobile-${value}`), kind), name, 3_000);
  await noWorkbenchModal(view, name, active);
  for (const inactive of [main(view.page), kind === "navigation" ? panel(view.page) : sidebar(view.page)]) {
    assert.equal(await inactive.count(), 1, "inactive workspace pages remain mounted");
    assert.equal(await inactive.getAttribute("inert"), "", "inactive workspace pages are inert");
    assert.equal(await inactive.isVisible(), false, "inactive workspace pages are hidden");
  }
  await usableFocus(view, `${name}-active-focus`);
}

async function mobileReturnFocus(view, kind, entry, method) {
  await returnConversation(view);
  const opener = entry === "header" ? view.page.locator(kind === "navigation" ? ".sidebar-toggle" : ".inspect-toggle") : composer(view.page);
  const original = await opener.elementHandle();
  if (entry === "header") await opener.click();
  else {
    await opener.fill(kind === "navigation" ? "/resume" : "/model");
    await opener.press("Control+Enter");
  }
  const name = `${view.name}-path2-${kind}-${entry}-${method}`;
  await retainedMobilePage(view, kind, name);
  let keyboard;
  if (entry === "header" && method === "return") {
    await paint(view.page);
    await (kind === "navigation" ? sidebar(view.page) : panel(view.page)).getByText("正在加载…", { exact: true }).waitFor({ state: "hidden" });
    keyboard = await naturalKeyboard(view.page, kind === "navigation" ? ".workspace-sidebar" : ".workspace-inspector", `${name}-natural-keyboard`);
  }
  if (method === "Escape") await view.page.keyboard.press("Escape");
  else await view.page.getByRole("button", { name: kind === "navigation" ? "关闭会话侧栏" : "关闭工作区面板", exact: true }).click();
  await main(view.page).waitFor({ state: "visible" });
  const result = await exactFocus(view, original, `${name}-exact-opener`);
  const inactive = kind === "navigation" ? sidebar(view.page) : panel(view.page);
  assert.equal(await inactive.getAttribute("aria-hidden"), "true");
  return { kind, entry, method, ...result, ...(keyboard ? { keyboard } : {}) };
}

async function extensionFocus(view, peer, kind) {
  await returnConversation(view);
  if (kind === "navigation") await openNavigation(view);
  else await openInspector(view, "文件");
  const surface = kind === "navigation" ? sidebar(view.page) : panel(view.page);
  if (kind === "inspector" && await surface.getByRole("button", { name: "关闭文件预览", exact: true }).isVisible()) await surface.getByRole("button", { name: "关闭文件预览", exact: true }).click();
  const control = surface.getByRole("searchbox", { name: kind === "navigation" ? "搜索会话" : "查找工作区文件", exact: true });
  await control.click();
  const original = await control.elementHandle(), before = await view.fixture.eventCount("m3_dialog_value"), calls = await view.fixture.eventCount("provider_call");
  await composer(peer).fill("/m3-dialog input"); await composer(peer).press("Control+Enter");
  const modal = view.page.locator('.dialog[aria-labelledby="extension-dialog-title"]');
  await modal.getByRole("textbox", { name: "对话框输入", exact: true }).waitFor();
  assert.equal(await surface.isVisible(), true, "the extension question retains the active workspace page behind it");
  await modalFocus(view, modal, `path3-extension-${kind}`);
  await shot(view, `${view.name}-path3-extension-${kind}`);
  await view.page.keyboard.press("Escape"); await modal.waitFor({ state: "detached" });
  await peer.locator('.dialog[aria-labelledby="extension-dialog-title"]').waitFor({ state: "detached" });
  const result = await exactFocus(view, original, `${view.name}-path3-extension-${kind}-exact-control`);
  const event = await view.fixture.waitEvent("m3_dialog_value", before, item => item.method === "input");
  assert.equal(event.mode, "rpc"); assert.equal(event.value, undefined, "Escape cancellation reaches the real extension");
  await waitFor(() => view.snapshot?.state.idle && !view.snapshot.state.uiPrompts.length, "extension cancellation settles the actual host", 15_000);
  assert.equal(await view.fixture.eventCount("provider_call"), calls, "the extension question made no model request");
  await retainedMobilePage(view, kind, `${view.name}-path3-extension-${kind}-restored-page`);
  return { kind, actualExtensionRpc: true, cancelled: true, ...result };
}

async function panelSettingsFocus(view) {
  const width = view.mobile ? view.width : 390, height = view.mobile ? view.height : 844;
  const auxiliary = await createViewer({ name: `${view.name}-no-model`, width, height, mobile: true }, await realpath(view.fixture.extension), true);
  const run = report.runs.find(item => item.viewport.name === auxiliary.name); run.auxiliary = "actual empty-model resource settings entry";
  try {
    const dock = await openInspector(auxiliary, "资源");
    await dock.getByRole("group", { name: "资源类型", exact: true }).getByRole("button", { name: "模型", exact: true }).click();
    await dock.getByText("没有可用模型。先登录一个模型服务商。", { exact: true }).waitFor();
    assert.equal(await dock.locator(".model-resource").count(), 0, "the auxiliary real runtime has no configured models");
    const entry = dock.getByRole("button", { name: "打开账户", exact: true }), original = await entry.elementHandle();
    await entry.click(); await settingsModal(auxiliary.page).waitFor();
    await auxiliary.page.getByRole("searchbox", { name: "查找服务商", exact: true }).waitFor();
    assert.equal(await dock.isVisible(), true, "panel settings preserves the inspector background page");
    await settingsFocus(auxiliary); await mobileControls(auxiliary, `${view.name}-path3-panel-settings-targets`);
    await shot(auxiliary, `${view.name}-path3-no-model-panel-settings`);
    await auxiliary.page.keyboard.press("Escape"); await settingsModal(auxiliary.page).waitFor({ state: "detached" });
    const result = await exactFocus(auxiliary, original, `${view.name}-path3-panel-settings-exact-account-entry`);
    await retainedMobilePage(auxiliary, "inspector", `${view.name}-path3-panel-settings-restored-page`);
    assert.equal(await auxiliary.fixture.eventCount("provider_call"), 0);
    assert.deepEqual(auxiliary.protocolErrors, [], "the auxiliary runtime has no projection protocol errors");
    return { actualNoModelRuntime: true, temporaryHome: auxiliary.fixture.directory, ...result };
  } finally {
    run.commands = auxiliary.sent;
    await auxiliary.context.close(); await auxiliary.fixture.close();
  }
}

async function previewReturnFocus(view, mode) {
  await returnConversation(view);
  const dock = await openInspector(view, mode === "diff" ? "改动" : "文件");
  const close = dock.getByRole("button", { name: "关闭文件预览", exact: true });
  if (await close.isVisible()) await close.click();
  const query = "redesign-fixture";
  if (mode === "file") await dock.getByRole("searchbox", { name: "查找工作区文件", exact: true }).fill(query);
  const entry = dock.locator('.file-item[title="redesign-fixture.ts"]');
  await entry.waitFor(); await entry.click();
  const heading = dock.locator(".preview-heading");
  await heading.waitFor();
  await waitFor(() => heading.evaluate(node => node.contains(document.activeElement) && document.activeElement.matches("button:not(:disabled)")), `${view.name}-path4-${mode} selection focuses an enabled preview action`, 3_000);
  const selected = await usableFocus(view, `${view.name}-path4-${mode}-preview-focus`);
  if (mode === "diff") assert.equal(selected.label, "查看文件", "diff selection focuses its first available action");
  assert.equal(await dock.locator(".file-item").count(), 0, "preview replaces the file list");
  await close.click(); await entry.waitFor();
  const restored = await exactFocus(view, entry, `${view.name}-path4-${mode}-exact-original-file-row`);
  if (mode === "file") assert.equal(await dock.getByRole("searchbox", { name: "查找工作区文件", exact: true }).inputValue(), query, "return preserves the file search");
  await shot(view, `${view.name}-path4-${mode}-returned-file`);
  return { mode, path: "redesign-fixture.ts", selected, ...restored, ...(mode === "file" ? { retainedQuery: query } : {}) };
}

async function focusPaths(view) {
  await returnConversation(view); await resize(view, 1280, 720); await returnConversation(view);
  const draft = `M31_FOCUS_DRAFT_${view.name}`; await composer(view.page).fill(draft);
  const paths = { "1": [], "2": [], "3": [], "4": [], "5": [] };
  const coverage = { viewport: view.name, status: "running", requestedPaths: { "1": "1280→390→1280 never leaves focus invisible or inert", "2": "mobile return and Escape restore the exact opener", "3": "settings and public extension questions restore a usable workspace location", "4": "file preview returns focus to the exact original path row", "5": "collapsing desktop navigation does not lose focus to body" }, results: paths };
  report.focusPaths.push(coverage);
  const originalComposer = await composer(view.page).elementHandle();
  await resize(view, 390, 844); paths["1"].push({ scenario: "visible composer 1280→390", ...(await exactFocus(view, originalComposer, `${view.name}-path1-visible-composer-mobile`)) });
  await resize(view, 1280, 720); paths["1"].push({ scenario: "visible composer 390→1280", ...(await exactFocus(view, originalComposer, `${view.name}-path1-visible-composer-desktop`)) });
  if (!await sidebar(view.page).isVisible()) { await view.page.locator(".sidebar-toggle").click(); await sidebar(view.page).waitFor(); }
  await sidebar(view.page).getByRole("searchbox", { name: "搜索会话", exact: true }).click();
  await resize(view, 390, 844); paths["1"].push({ scenario: "desktop navigation search becomes hidden", active: await usableFocus(view, `${view.name}-path1-hidden-desktop-navigation-search`) });
  await view.page.locator(".sidebar-toggle").click(); await retainedMobilePage(view, "navigation", `${view.name}-path1-mobile-navigation`);
  await paint(view.page);
  await exactFocus(view, sidebar(view.page).getByRole("searchbox", { name: "搜索会话", exact: true }), `${view.name}-path1-navigation-initial-focus-settled`);
  await sidebar(view.page).getByRole("button", { name: "新建会话", exact: true }).press("Shift+Tab");
  await exactFocus(view, view.page.getByRole("button", { name: "关闭会话侧栏", exact: true }), `${view.name}-path1-before-hidden-mobile-return`);
  await resize(view, 1280, 720); paths["1"].push({ scenario: "mobile return button becomes hidden in expanded desktop navigation", ...(await exactFocus(view, originalComposer, `${view.name}-path1-mobile-return-hidden-desktop`)) });
  assert.equal(await composer(view.page).inputValue(), draft, "responsive focus changes retain the draft");
  // Start from a known header opener, then read collapse recovery before any helper clicks.
  await view.page.getByRole("button", { name: "收起工作区与会话", exact: true }).click(); await sidebar(view.page).waitFor({ state: "hidden" });
  await usableFocus(view, `${view.name}-path5-initial-collapse-usable`);
  const header = view.page.locator(".sidebar-toggle"), originalHeader = await header.elementHandle();
  await header.click(); await sidebar(view.page).waitFor();
  await sidebar(view.page).getByRole("searchbox", { name: "搜索会话", exact: true }).click();
  await view.page.getByRole("button", { name: "收起工作区与会话", exact: true }).click(); await sidebar(view.page).waitFor({ state: "hidden" });
  paths["5"].push({ scenario: "desktop collapse restores known header opener", ...(await exactFocus(view, originalHeader, `${view.name}-path5-collapse-exact-header`)) });
  assert.equal(await sidebar(view.page).getAttribute("inert"), ""); assert.equal(await composer(view.page).inputValue(), draft);
  await resize(view, 390, 844); await header.click(); await retainedMobilePage(view, "navigation", `${view.name}-path1-collapsed-desktop-mobile-navigation`);
  await resize(view, 1280, 720); paths["1"].push({ scenario: "collapsed desktop→mobile navigation→desktop", ...(await exactFocus(view, originalHeader, `${view.name}-path1-collapsed-navigation-resize-header`)) });
  assert.equal(await sidebar(view.page).isVisible(), false); assert.equal(await sidebar(view.page).getAttribute("inert"), "");
  await resize(view, 390, 844, "navigation"); await returnConversation(view);
  for (const kind of ["navigation", "inspector"]) for (const entry of ["header", "composer"]) for (const method of ["return", "Escape"]) paths["2"].push(await mobileReturnFocus(view, kind, entry, method));
  await returnConversation(view); await openInspector(view, "文件");
  const previewClose = panel(view.page).getByRole("button", { name: "关闭文件预览", exact: true });
  if (await previewClose.isVisible()) await previewClose.click();
  const fileSearch = panel(view.page).getByRole("searchbox", { name: "查找工作区文件", exact: true }); await fileSearch.click();
  const originalSearch = await fileSearch.elementHandle();
  await resize(view, 320, 740, "inspector"); paths["1"].push({ scenario: "inspector focus remains usable at 320", ...(await exactFocus(view, originalSearch, `${view.name}-path1-inspector-320`)) });
  await resize(view, 1280, 720); paths["1"].push({ scenario: "inspector remains visible on desktop", ...(await exactFocus(view, originalSearch, `${view.name}-path1-inspector-desktop`)) });
  await desktopDock(view, `${view.name}-path1-desktop-dock`, false);
  await returnConversation(view); await resize(view, 390, 844); await openNavigation(view);
  const settingsEntry = sidebar(view.page).locator(".settings-button"), originalSettings = await settingsEntry.elementHandle();
  await settingsEntry.click(); await settingsModal(view.page).waitFor(); await settingsFocus(view);
  await view.page.keyboard.press("Escape"); await settingsModal(view.page).waitFor({ state: "detached" });
  paths["3"].push({ scenario: "mobile navigation settings returns exact entry", ...(await exactFocus(view, originalSettings, `${view.name}-path3-navigation-settings-exact-entry`)) });
  await retainedMobilePage(view, "navigation", `${view.name}-path3-navigation-settings-retained`);
  // A true modal owns focus during resize; only closing it may repair its now-hidden opener.
  await settingsEntry.click(); await settingsModal(view.page).waitFor();
  await waitFor(() => settingsModal(view.page).evaluate(node => node.contains(document.activeElement)), "settings takes focus before the modal resize scenario", 3_000);
  const modalControl = await settingsModal(view.page).locator(":focus").elementHandle();
  assert.ok(modalControl, "settings has an active control before resizing");
  await resize(view, 1280, 720); await exactFocus(view, modalControl, `${view.name}-path3-resize-does-not-steal-modal-focus`);
  assert.equal(await view.page.locator(".workbench").getAttribute("inert"), "");
  await view.page.keyboard.press("Escape"); await settingsModal(view.page).waitFor({ state: "detached" });
  paths["3"].push({ scenario: "resize while settings open repairs the hidden navigation entry", ...(await exactFocus(view, originalHeader, `${view.name}-path3-modal-resize-visible-fallback`)) });
  await resize(view, 390, 844, "navigation"); await returnConversation(view);
  const peer = await view.context.newPage(); peer.setDefaultTimeout(15_000);
  peer.on("pageerror", error => report.pageErrors.push({ viewport: `${view.name}-peer`, error: redact(error.message) }));
  peer.on("request", request => { const url = new URL(request.url()); if (!["127.0.0.1", "localhost"].includes(url.hostname) && !["data:", "blob:"].includes(url.protocol)) report.externalRequests.push({ viewport: `${view.name}-peer`, url: `${url.origin}${url.pathname}` }); });
  try {
    await peer.goto(view.fixture.url); await peer.getByText("已连接", { exact: true }).waitFor(); await composer(peer).waitFor();
    for (const kind of ["navigation", "inspector"]) paths["3"].push(await extensionFocus(view, peer, kind));
  } finally { await peer.close(); }
  paths["3"].push({ scenario: "actual mobile no-model inspector opens account settings", ...(await panelSettingsFocus(view)) });
  // Desktop settings may open from navigation while the right dock stays mounted and visible.
  await returnConversation(view); await resize(view, 1280, 720); await returnConversation(view);
  if (!await sidebar(view.page).isVisible()) { await header.click(); await sidebar(view.page).waitFor(); }
  await openInspector(view, "文件");
  const desktopEntry = sidebar(view.page).locator(".settings-button"), originalDesktopEntry = await desktopEntry.elementHandle();
  await desktopEntry.click(); await settingsModal(view.page).waitFor(); await settingsFocus(view);
  assert.equal(await panel(view.page).isVisible(), true, "desktop settings retains the dock");
  await view.page.keyboard.press("Escape"); await settingsModal(view.page).waitFor({ state: "detached" });
  paths["3"].push({ scenario: "desktop settings retains dock and exact navigation entry", ...(await exactFocus(view, originalDesktopEntry, `${view.name}-path3-desktop-dock-settings-entry`)) });
  await desktopDock(view, `${view.name}-path3-desktop-dock-restored`, false);
  await returnConversation(view); await resize(view, view.width, view.height); await returnConversation(view);
  for (const mode of ["diff", "file"]) paths["4"].push(await previewReturnFocus(view, mode));
  await returnConversation(view); await composer(view.page).fill(draft);
  await layout(view, `${view.name}-focus-paths-restored`); await mobileControls(view, `${view.name}-focus-paths-restored`); await shot(view, `${view.name}-focus-paths-restored`);
  coverage.status = "passed";
  return { userPaths: paths, allFivePaths: true, exactOpenerCases: paths["2"].length, widths: [1280, 390, 1280, 390, 320, 1280, view.width], retainedResponsiveDraft: true, originalViewportRestored: view.page.viewportSize() };
}

async function verify(view) {
  await check(view, "01-content", "real local provider renders Markdown, code and a public extension tool", async () => {
    await chooseLook(view, "浅色");
    const toolText = `M0_TOOL M31_REDESIGN_TOOL_${view.name}`;
    await send(view, toolText); await settled(view, toolText);
    await view.page.locator(".tool-complete").waitFor();
    const text = `M31_REDESIGN_MARKDOWN_${view.name}\n\n## 开发工作台\n\n正文、**强调**与 \`inline code\`。\n\n\`\`\`typescript\nconst greeting: string = "你好，pi";\nconsole.log(greeting);\n\`\`\`\n\n| 内容 | 状态 |\n| --- | --- |\n| 文件与会话 | 就绪 |\n\n> 检查文件时，可以继续整理下一条消息。`;
    await send(view, text); await settled(view, text);
    await view.page.locator(".message-assistant .markdown h2").filter({ hasText: "开发工作台" }).waitFor();
    assert.equal(await view.page.locator(".composer-toolbar").count(), 1, "a single composer toolbar presents the main controls");
    await layout(view, `${view.name}-workbench`); await mobileControls(view, `${view.name}-workbench`); await shot(view, `${view.name}-01-light-workbench`);
    return { actualProvider: "pi-pane-m0/deterministic", actualTool: "m0_echo" };
  });

  await check(view, "02-workspace", view.mobile ? "mobile navigation and inspection use full views, returning preserves the draft" : "desktop inspection docks beside usable chat and the navigation can collapse", async () => {
    await returnConversation(view);
    const header = await headerEvidence(view);
    const draft = `M31_DRAFT_${view.name}：关闭面板后保留这段未发送内容。`;
    await composer(view.page).fill(draft);
    if (view.mobile) {
      await openNavigation(view); await wholeView(view, "navigation", `${view.name}-02-navigation-full-view`);
      await view.page.getByRole("button", { name: "关闭会话侧栏", exact: true }).click();
      await composer(view.page).waitFor(); assert.equal(await composer(view.page).inputValue(), draft);
      await openInspector(view); await wholeView(view, "inspector", `${view.name}-03-inspector-full-view`);
      await view.page.getByRole("button", { name: "关闭工作区面板", exact: true }).click();
      await composer(view.page).waitFor(); assert.equal(await composer(view.page).inputValue(), draft);
      await shot(view, `${view.name}-04-returned-draft`);
    } else {
      await openInspector(view); await desktopDock(view, `${view.name}-docked`); await shot(view, `${view.name}-02-docked-workbench`);
      const before = { chat: await main(view.page).boundingBox(), dock: await panel(view.page).boundingBox(), navigation: await sidebar(view.page).boundingBox() };
      await view.page.getByRole("button", { name: "收起工作区与会话", exact: true }).click();
      await waitFor(async () => await view.page.locator(".workbench").evaluate(node => node.classList.contains("nav-collapsed")), "desktop navigation collapsed");
      assert.equal(await sidebar(view.page).isVisible(), false);
      await usableFocus(view, `${view.name}-collapse-focus-before-any-helper-click`);
      const space = await recoverNavigationSpace(view, before);
      report.layouts.push({ name: `${view.name}-collapsed-space`, ...space });
      await desktopDock(view, `${view.name}-docked-nav-collapsed`, false); await shot(view, `${view.name}-03-nav-collapsed`);
      await view.page.locator(".sidebar-toggle").click(); await sidebar(view.page).waitFor();
      assert.equal(await composer(view.page).inputValue(), draft);
      await returnConversation(view);
    }
    await noWorkbenchModal(view, `${view.name}-returned`, main(view.page));
    return { retainedDraft: true, header };
  });

  await check(view, "03-inspection", "file, diff, real-content reference, model and command resources remain available", async () => {
    await returnConversation(view);
    const prefix = `M31_REFERENCE_DRAFT_${view.name}`;
    await composer(view.page).fill(prefix);
    const dock = await openInspector(view, "改动");
    await dock.getByRole("button", { name: /redesign-fixture\.ts/ }).click();
    await dock.locator(".diff-add").first().waitFor(); await dock.locator(".diff-del").first().waitFor();
    await noWorkbenchModal(view, `${view.name}-diff`, dock); await layout(view, `${view.name}-diff`); await mobileControls(view, `${view.name}-diff`); await shot(view, `${view.name}-05-git-diff`);
    await dock.getByRole("group", { name: "工作区面板", exact: true }).getByRole("button", { name: "文件", exact: true }).click();
    await dock.getByRole("searchbox", { name: "查找工作区文件", exact: true }).fill("redesign-fixture");
    await dock.getByRole("button", { name: "redesign-fixture.ts", exact: true }).click();
    await dock.getByRole("button", { name: "引用到消息", exact: true }).waitFor();
    await layout(view, `${view.name}-file`); await mobileControls(view, `${view.name}-file`); await shot(view, `${view.name}-06-file-preview`);
    await dock.getByRole("button", { name: "引用到消息", exact: true }).click();
    await composer(view.page).waitFor();
    const source = await readFile(join(view.fixture.cwd, "redesign-fixture.ts"), "utf8");
    const quotedPath = `文件：${JSON.stringify("redesign-fixture.ts")}`;
    const proof = { viewport: view.name, prefix, quotedPath, source, sourceSha256: hash(source), observations: [], matched: false };
    report.references.push(proof);
    const began = Date.now();
    let reference;
    await waitFor(async () => {
      reference = await composer(view.page).inputValue();
      const predicates = { retainsDraft: reference.startsWith(prefix), quotedPath: reference.includes(quotedPath), completeFileSource: reference.includes(source) };
      proof.actual = reference; proof.predicates = predicates;
      if (!proof.observations.length || proof.observations.at(-1).actual !== reference) proof.observations.push({ elapsedMs: Date.now() - began, actual: reference, predicates });
      return Object.values(predicates).every(Boolean);
    }, "rendered reference retains the draft, quoted path and complete fixture bytes", 3_000);
    assert.ok(reference.startsWith(prefix) && reference.includes(`文件：${JSON.stringify("redesign-fixture.ts")}`) && reference.includes(source), "reference includes the quoted path, complete actual file contents and existing draft");
    proof.matched = true;
    assert.equal(await dock.isVisible(), !view.mobile, "desktop keeps the dock; mobile returns to the conversation");
    await shot(view, `${view.name}-07-file-reference`);
    await openInspector(view, "资源");
    await dock.getByRole("group", { name: "资源类型", exact: true }).getByRole("button", { name: "模型", exact: true }).click();
    await dock.locator(".model-resource").filter({ has: view.page.getByText("pi-pane-m0 · deterministic-thinking", { exact: true }) }).click();
    await waitFor(() => view.snapshot?.state.model?.provider === "pi-pane-m0" && view.snapshot.state.model.id === "deterministic-thinking" && view.snapshot.state.idle, "resource provider/model applies to real RPC");
    await mobileControls(view, `${view.name}-models`); await shot(view, `${view.name}-08-model-resources`);
    await dock.locator(".model-resource").filter({ has: view.page.getByText("pi-pane-m0 · deterministic", { exact: true }) }).click();
    await waitFor(() => view.snapshot?.state.model?.provider === "pi-pane-m0" && view.snapshot.state.model.id === "deterministic" && view.snapshot.state.idle, "restore exact local fixture provider/model");
    await dock.getByRole("group", { name: "资源类型", exact: true }).getByRole("button", { name: "工具", exact: true }).click();
    await layout(view, `${view.name}-tools`); await mobileControls(view, `${view.name}-tools`); await shot(view, `${view.name}-09-tool-resources`);
    await dock.getByRole("group", { name: "资源类型", exact: true }).getByRole("button", { name: "命令", exact: true }).click();
    const command = dock.locator(".command-resource").filter({ hasText: "/m0-mark" }); await command.waitFor();
    await layout(view, `${view.name}-commands`); await mobileControls(view, `${view.name}-commands`); await shot(view, `${view.name}-10-command-resources`);
    await command.click(); await composer(view.page).waitFor();
    const insertion = { viewport: view.name, expected: "/m0-mark ", observations: [], matched: false }; report.commandInsertions.push(insertion);
    await waitFor(async () => {
      const actual = await composer(view.page).inputValue(); insertion.actual = actual;
      if (!insertion.observations.length || insertion.observations.at(-1) !== actual) insertion.observations.push(actual);
      return actual === insertion.expected;
    }, "the real command resource text commits to the composer", 3_000);
    assert.equal(await composer(view.page).inputValue(), "/m0-mark ");
    insertion.matched = true;
    if (!view.mobile) await returnConversation(view);
    await composer(view.page).fill(`/m0-mark M31_REDESIGN_COMMAND_${view.name}`); await composer(view.page).press("Control+Enter");
    await view.fixture.waitEvent("m0_mark", 0, event => event.args === `M31_REDESIGN_COMMAND_${view.name}` && event.mode === "rpc");
    await openInspector(view, "资源");
    await dock.getByRole("group", { name: "资源类型", exact: true }).getByRole("button", { name: "能力", exact: true }).click();
    await layout(view, `${view.name}-capabilities`); await mobileControls(view, `${view.name}-capabilities`); await shot(view, `${view.name}-11-capabilities`);
    await returnConversation(view);
    return { actualFileReference: true, modelApplied: true, extensionCommandDispatched: true };
  });

  await check(view, "04-settings", "six settings categories keep a true modal and restore focus after closing", async () => {
    await returnConversation(view);
    for (const [index, section] of sections.entries()) {
      await openSettings(view, section);
      assert.equal(await settingsModal(view.page).getAttribute("role"), "dialog");
      await layout(view, `${view.name}-settings-${section}`); await mobileControls(view, `${view.name}-settings-${section}`); await shot(view, `${view.name}-settings-${index + 1}`);
    }
    await openSettings(view, "外观"); await settingsFocus(view); await shot(view, `${view.name}-12-settings-keyboard`);
    await closeSettings(view);
    await noWorkbenchModal(view, `${view.name}-settings-closed`, main(view.page));
    const navigation = await openNavigation(view);
    const settingsEntry = navigation.locator(".settings-button");
    await settingsEntry.click(); await settingsModal(view.page).waitFor();
    assert.equal(await navigation.isVisible(), true, "settings retains navigation as its background view");
    if (view.mobile) assert.equal(await main(view.page).isVisible(), false, "settings does not silently return the mobile navigation to chat");
    await shot(view, `${view.name}-12-settings-from-navigation`);
    await view.page.keyboard.press("Escape"); await settingsModal(view.page).waitFor({ state: "detached" });
    await waitFor(() => settingsEntry.evaluate(node => node === document.activeElement), "settings restores its navigation entry", 3_000);
    await noWorkbenchModal(view, `${view.name}-navigation-settings-closed`, navigation);
    if (view.mobile) {
      assert.ok((await view.page.locator(".workbench").getAttribute("class")).includes("mobile-navigation"), "modal close returns to the navigation full view");
      await wholeView(view, "navigation", `${view.name}-12-navigation-restored`);
    }
    await returnConversation(view);
    return { categories: sections, closesWithEscape: true, composerFocusRestored: true, navigationViewAndFocusRestored: true };
  });

  await check(view, "05-provider-error", "a two-model provider form associates the error directly with its URL field", async () => {
    await openSettings(view, "自定义供应商");
    await view.page.getByRole("button", { name: "添加供应商", exact: true }).click();
    await view.page.locator("#provider-id").fill("redesign-validation"); await view.page.locator("#provider-url").fill("invalid-address");
    await view.page.getByLabel("第 1 个模型的 ID", { exact: true }).fill("model-one");
    await view.page.getByRole("button", { name: "添加模型", exact: true }).click();
    await view.page.getByLabel("第 2 个模型的 ID", { exact: true }).fill("model-two");
    await view.page.locator(".provider-form").getByRole("button", { name: "保存", exact: true }).click();
    await view.page.locator("#provider-url").getAttribute("aria-invalid").then(value => assert.equal(value, "true"));
    const evidence = await view.page.locator("#provider-url").evaluate(control => {
      const ids = control.getAttribute("aria-describedby")?.split(/\s+/) || [];
      const error = ids.map(id => document.getElementById(id)).find(node => node?.getAttribute("role") === "alert");
      const a = control.getBoundingClientRect(), b = error?.getBoundingClientRect();
      return { associated: !!error, sameField: !!error && error.closest(".provider-field") === control.closest(".provider-field"), gap: b ? b.top - a.bottom : null, focused: document.activeElement === control };
    });
    assert.ok(evidence.associated && evidence.sameField && evidence.focused && evidence.gap >= -1 && evidence.gap <= 24, "URL error is linked, close to the input, and focuses the invalid field");
    await layout(view, `${view.name}-provider-error`); await mobileControls(view, `${view.name}-provider-error`); await shot(view, `${view.name}-13-provider-field-error`);
    await view.page.locator(".provider-form").getByRole("button", { name: "取消", exact: true }).click();
    await closeSettings(view);
    return evidence;
  });

  await check(view, "06-queue", "followUp and steer reach the real RPC queue in the expected order", async () => {
    await returnConversation(view);
    const slow = `M0_SLOW_M31_REDESIGN_QUEUE_${view.name}`, follow = `M31_REDESIGN_FOLLOW_${view.name}`, steer = `M31_REDESIGN_STEER_${view.name}`;
    await send(view, slow); await waitFor(() => view.snapshot?.state.running, "local provider is running");
    await shot(view, `${view.name}-14-running`);
    await send(view, follow); await waitFor(() => view.snapshot?.state.hasPendingMessages, "followUp enters the actual pending queue");
    await send(view, steer, "steer");
    await layout(view, `${view.name}-queue`); await mobileControls(view, `${view.name}-queue`); await shot(view, `${view.name}-15-pending-steer-followup`);
    await settled(view, follow);
    const messages = view.snapshot.session.messages;
    assert.ok(messages.findIndex(message => message.role === "user" && textOf(message) === steer) < messages.findIndex(message => message.role === "user" && textOf(message) === follow), "steer is processed before followUp");
    assert.equal(messages.filter(message => message.role === "user" && textOf(message) === steer).length, 1);
    assert.ok(view.sent.some(frame => frame.command === "prompt" && frame.mode === "steer") && view.sent.some(frame => frame.command === "prompt" && frame.mode === "followUp"));
    await shot(view, `${view.name}-16-queue-settled`);
    return { steerBeforeFollowUp: true, realHostIdle: true };
  });

  await check(view, "07-abort", "the abort control stops the actual deterministic provider", async () => {
    await returnConversation(view);
    const marker = `M0_SLOW_M31_REDESIGN_ABORT_${view.name}`;
    await send(view, marker);
    await waitFor(() => view.snapshot?.session.messages.some(message => message.role === "assistant" && textOf(message).startsWith(`M0_REPLY:${marker}:`) && textOf(message).length > marker.length + 30), "partial output before abort");
    await mobileControls(view, `${view.name}-abort-running`); await shot(view, `${view.name}-17-before-abort`);
    await view.page.locator(".abort-button").click();
    await view.fixture.waitEvent("provider_aborted", 0, event => event.input === marker);
    await waitFor(() => view.snapshot?.state.idle, "actual host idle after abort");
    await shot(view, `${view.name}-18-after-abort`);
    return { actualProviderAborted: true };
  });

  await check(view, "08-responsive", "all five focus paths use real controls across desktop/mobile transitions, modal interruptions and file preview return", () => focusPaths(view));

  await check(view, "09-appearance-empty", "light, dark and porcelain preserve workspace layout; an actual new session shows the empty composer", async () => {
    await returnConversation(view); await resize(view, view.width, view.height); await returnConversation(view);
    for (const [name, title] of [["dark", "深色"], ["porcelain", "pi-pane-porcelain"]]) {
      await chooseLook(view, title); await layout(view, `${view.name}-${name}`); await mobileControls(view, `${view.name}-${name}`); await shot(view, `${view.name}-19-${name}-workbench`);
    }
    await chooseLook(view, "浅色");
    await composer(view.page).fill("/new"); await composer(view.page).press("Control+Enter");
    await waitFor(() => view.snapshot?.state.idle && view.snapshot.session.messages.length === 0, "actual new empty session", 30_000);
    await view.page.locator(".empty-ready").waitFor();
    const box = await composer(view.page).boundingBox(); assert.ok(box && box.y >= 0 && box.y + box.height <= view.height && box.width > 150, "empty composer is fully visible");
    await layout(view, `${view.name}-empty`); await mobileControls(view, `${view.name}-empty`); await shot(view, `${view.name}-20-light-empty`);
    return { themes: ["浅色", "深色", "pi-pane-porcelain"], actualNewSession: true };
  });
}

function htmlReport() {
  const escape = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const checks = report.checks.map(item => `<tr><td>${escape(item.id)}</td><td>${escape(item.name)}</td><td class="${item.status}">${escape(item.status)}</td><td>${escape(item.error || "")}</td></tr>`).join("");
  const images = report.screenshots.map(item => `<figure><a href="${escape(item.file)}"><img src="${escape(item.file)}" loading="lazy" alt="${escape(item.file)}"></a><figcaption>${escape(item.file)} · ${item.width}×${item.height}</figcaption></figure>`).join("");
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>M31-D built checkout verification</title><style>body{font:15px/1.6 system-ui,sans-serif;max-width:1440px;margin:auto;padding:24px;background:#fafafa;color:#202124}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:8px;text-align:left;vertical-align:top}td:last-child{white-space:pre-wrap;max-width:480px;overflow-wrap:anywhere}.passed{color:#276440}.failed{color:#b3261e}.screens{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:20px}figure{margin:0}img{display:block;width:100%;height:auto;border:1px solid #ddd}figcaption{font-size:12px;overflow-wrap:anywhere}</style><h1>M31-D built checkout verification</h1><p>Status: <strong>${escape(report.status)}</strong>. Built checkout ${escape(report.version || "unknown")}; tarball exact-install startup is verified separately.</p><p>${escape(report.isolation)}</p><p>Source: ${escape(report.sourceCommit || "unknown")} · Package: ${escape(report.version || "unknown")} · Associated archive SHA-256: ${escape(report.candidateArchiveSha256 || "none supplied")} · <a href="report.json">Machine-readable report</a></p><ul>${report.limits.map(item => `<li>${escape(item)}</li>`).join("")}</ul><h2>Checks</h2><table><thead><tr><th>ID</th><th>Behavior</th><th>Result</th><th>Failure evidence</th></tr></thead><tbody>${checks}</tbody></table><h2>Actual screenshots</h2><div class="screens">${images}</div>`;
}

try {
  assert.ok(out.startsWith(`${join(checkout, "build-artifacts")}/`), "verification output stays within this checkout's build-artifacts");
  const existing = await readdir(out).catch(error => { if (error.code === "ENOENT") return []; throw error; });
  const runnerLog = process.env.PI_M31_REGRESSION_LOG === join(out, "suite.log") ? "suite.log" : undefined;
  assert.deepEqual(existing.filter(name => name !== runnerLog), [], "verification output must contain no prior evidence; only the current runner's explicitly identified log may exist");
  outputValidated = true;
  await mkdir(out, { recursive: true });
  const manifest = JSON.parse(await readFile(join(checkout, "package.json"), "utf8"));
  assert.equal(typeof manifest.version, "string", "the selected checkout has a package version");
  report.version = manifest.version;
  const candidateArchiveSha256 = process.env.PI_M31_TARBALL_SHA256;
  if (candidateArchiveSha256 !== undefined) {
    assert.match(candidateArchiveSha256, /^[a-f0-9]{64}$/i, "optional candidate archive association is a SHA-256");
    report.candidateArchiveSha256 = candidateArchiveSha256;
    report.candidateAssociation = "Caller-supplied PI_M31_TARBALL_SHA256; this run verifies checkout dist, and archive exact-install startup has separate evidence.";
  }
  const extension = await realpath(resolve(process.env.PI_M0_EXTENSION || join(checkout, "dist/extension/index.js")));
  assert.equal(extension, await realpath(join(checkout, "dist/extension/index.js")), "PI_M0_EXTENSION must select this checkout's built dist extension");
  process.env.PI_M0_EXTENSION = extension;
  report.sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim();
  report.workingTreeChangedPaths = execFileSync("git", ["diff", "--name-only", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim().split("\n").filter(Boolean);
  report.artifact = { kind: "built checkout dist", version: report.version, extension, extensionSha256: hash(await readFile(extension)), webIndexSha256: hash(await readFile(join(checkout, "web-dist/index.html"))), ...(candidateArchiveSha256 ? { candidateArchiveSha256 } : {}), archiveInstalledByThisRun: false };
  browser = await chromium.launch({ channel: "chrome", headless: true });
  for (const viewport of viewports) {
    const view = await createViewer(viewport, extension);
    await verify(view);
    report.runs.find(item => item.viewport.name === view.name).commands = view.sent;
    assert.deepEqual(view.protocolErrors, [], `${view.name}: no projection protocol errors`);
    await view.context.close();
    await view.fixture.close();
  }
  assert.deepEqual(report.pageErrors, [], "no uncaught browser errors");
  assert.deepEqual(report.externalRequests, [], "no remote browser resources or provider requests");
  report.checkCoverage = viewports.map(view => ({ viewport: view.name, expected: 9, observed: report.checks.filter(item => item.id.startsWith(`${view.name}-`)).length }));
  assert.equal(report.checks.length, report.expectedChecks, "all four viewports execute nine checks (36 total)");
  assert.ok(report.checkCoverage.every(item => item.observed === item.expected), "each viewport executes all nine checks");
  report.status = report.checks.some(item => item.status === "failed") ? "failed" : "passed";
  if (report.status === "failed") process.exitCode = 1;
} catch (error) {
  report.status = "failed"; report.error = redact(error.stack ?? error); process.exitCode = 1;
  console.error(report.error);
  for (const view of viewers) if (!view.page.isClosed()) await shot(view, `${view.name}-fatal-failure`).catch(() => {});
} finally {
  if (previousExtension === undefined) delete process.env.PI_M0_EXTENSION; else process.env.PI_M0_EXTENSION = previousExtension;
  for (const view of viewers) await view.context.close().catch(() => {});
  try { await browser?.close(); report.browserClosed = true; } catch (error) { report.browserClosed = false; report.browserCloseError = redact(error); }
  for (const fixture of fixtures) {
    const rpcPids = [...new Set((await fixture.events().catch(() => [])).filter(event => event.event === "m3_session" && event.mode === "rpc").map(event => event.pid))];
    const cleanup = { temporaryHome: fixture.directory, rpcPids, hostStopped: false, allRpcStopped: false, temporaryHomeRemoved: false };
    try { await fixture.close(); cleanup.hostStopped = fixture.proc.exitCode !== null; } catch (error) { cleanup.hostError = redact(error); }
    for (const pid of rpcPids) await waitFor(() => !alive(pid), `fixture RPC ${pid} stopped`, 10_000).catch(() => {});
    cleanup.allRpcStopped = rpcPids.every(pid => !alive(pid));
    try { await fixture.remove(); cleanup.temporaryHomeRemoved = await stat(fixture.directory).then(() => false, error => { if (error.code === "ENOENT") return true; throw error; }); } catch (error) { cleanup.removeError = redact(error); }
    report.cleanup.push(cleanup);
    if (!cleanup.hostStopped || !cleanup.allRpcStopped || !cleanup.temporaryHomeRemoved) { report.status = "failed"; process.exitCode = 1; }
  }
  report.finishedAt = new Date().toISOString();
  if (outputValidated) {
    await mkdir(out, { recursive: true });
    await writeFile(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(join(out, "report.html"), htmlReport());
    console.log(`${report.status.toUpperCase()} — ${report.checks.filter(item => item.status === "passed").length}/${report.checks.length} checks; report: ${join(out, "report.json")}`);
  }
}
