#!/usr/bin/env node
/** Two real browser pages against one /web host. All mutations use the UI. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { chromium } from "playwright";
import { applyProjectionEvent } from "../dist/protocol/index.js";
import { startFixture, waitFor } from "./m0-smoke.mjs";

const out = resolve(process.env.PI_M31_CONCURRENCY_REPORT_DIR || process.env.PI_M31_REPORT_DIR || "build-artifacts/m3.1/concurrency");
await mkdir(out, { recursive: true });
const secrets = ["sk-m31-concurrency-busy-SYNTHETIC-only", "sk-m31-concurrency-veto-SYNTHETIC-only"];
const report = { startedAt: new Date().toISOString(), status: "running", scope: "M31 true two-page browser concurrency and pending credential recovery",
  browser: "System Google Chrome, headless Playwright", realTui: true, remoteProviderRequests: 0,
  isolation: "one fresh temporary HOME and agent directory; two independent browser contexts; PI_OFFLINE=1 and deterministic provider only",
  limits: ["API keys are synthetic and no external provider is contacted; this does not validate live API/OAuth credentials.",
    "The second page uses a mobile touch viewport, not physical phone hardware.",
    "All product mutations come from visible UI controls; WebSocket traffic is observed for evidence only.",
    "Owner isolation checks absence of the other page's secret controls and secret step frames; forged protocol answers are covered separately by m31-auth AUTH-02."],
  checks: [], screenshots: [], layouts: [], pageErrors: [], externalRequests: [], observations: [], cleanup: {} };
const redact = value => { let text = String(value).replace(/#t=[A-Za-z0-9_-]+/g, "#t=[REDACTED]").replace(/pi-pane\.bearer\.[A-Za-z0-9_-]+/g, "pi-pane.bearer.[REDACTED]"); for (const key of secrets) text = text.replaceAll(key, "[SYNTHETIC_KEY]"); return text; };
const hash = value => createHash("sha256").update(value).digest("hex");
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const composer = page => page.getByRole("textbox", { name: "消息", exact: true });
const loginDialog = page => page.locator('.dialog[aria-labelledby="account-dialog-title"]');
let browser, fixture, a, b;
const viewers = [];
async function check(id, name, fn) {
  const started = Date.now();
  try { const details = await fn(); report.checks.push({ id, name, status: "passed", durationMs: Date.now() - started, ...(details ? { details } : {}) }); console.log(`PASS ${id} ${name}`); }
  catch (error) { report.checks.push({ id, name, status: "failed", durationMs: Date.now() - started, error: redact(error.stack ?? error) }); throw error; }
}
async function shot(view, name) {
  await view.page.screenshot({ path: join(out, `${name}.png`), animations: "disabled" }); report.screenshots.push(`${name}.png`);
  const layout = await view.page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth,
    panels: [...document.querySelectorAll(".dialog, .settings-body, .composer, .workspace-sidebar")].filter(node => node.getClientRects().length && !node.closest('[inert], [aria-hidden="true"]')).map(node => ({ class: node.className, width: node.clientWidth, scrollWidth: node.scrollWidth })) }));
  report.layouts.push({ name, ...layout }); assert.ok(layout.documentWidth <= layout.width + 1, `${name}: no page overflow`);
  assert.deepEqual(layout.panels.filter(item => item.scrollWidth > item.width + 1), [], `${name}: no panel overflow`);
}
async function makeViewer(name, mobile) {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 720 }, isMobile: mobile, hasTouch: mobile });
  const page = await context.newPage(); page.setDefaultTimeout(15_000);
  const view = { name, context, page, frames: [], sent: [], snapshot: undefined };
  page.on("pageerror", error => report.pageErrors.push({ page: name, error: redact(error.stack ?? error) }));
  page.on("request", request => { const url = new URL(request.url()); if (url.protocol.startsWith("http") && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") report.externalRequests.push({ page: name, url: url.origin + url.pathname }); });
  page.on("websocket", socket => {
    socket.on("framesent", ({ payload }) => { try { const frame = JSON.parse(String(payload)); view.sent.push(frame.t === "account_answer" ? { ...frame, value: "[SYNTHETIC_KEY]" } : frame); } catch {} });
    socket.on("framereceived", ({ payload }) => { try { const frame = JSON.parse(String(payload)); view.frames.push(frame); if (frame.t === "snapshot") view.snapshot = frame; else if (frame.t === "session_reset") view.snapshot = undefined; else if (frame.t === "event" && view.snapshot) view.snapshot = { ...applyProjectionEvent(view.snapshot, frame.ev), seq: frame.seq }; } catch {} });
  });
  viewers.push(view); await page.goto(fixture.url); await composer(page).waitFor();
  await waitFor(() => view.snapshot?.state.idle, `${name} snapshot`); return view;
}
async function openSidebar(page) { const sidebar = page.locator(".workspace-sidebar"); if (await sidebar.getAttribute("aria-hidden") === "true") await page.getByRole("button", { name: "打开工作区与会话", exact: true }).click(); }
async function closeSidebar(page) { const close = page.getByRole("button", { name: "关闭会话侧栏", exact: true }); if (await close.isVisible()) await close.click(); }
async function settings(view, section = "账户") {
  const page = view.page;
  if (!await page.locator(".settings-dialog").isVisible()) { await openSidebar(page); await page.getByRole("button", { name: "设置", exact: true }).click(); }
  await page.getByRole("group", { name: "设置分类" }).getByRole("button", { name: section, exact: true }).click();
}
async function closeSettings(view) { if (await view.page.locator(".settings-dialog").isVisible()) { await view.page.keyboard.press("Escape"); await view.page.locator(".settings-dialog").waitFor({ state: "detached" }); } await closeSidebar(view.page); }
async function send(view, text) { await composer(view.page).fill(text); await composer(view.page).press("Control+Enter"); }
async function settled(view, text) {
  await waitFor(() => view.snapshot?.state.idle && view.snapshot.session.messages.some(message => message.role === "assistant" && JSON.stringify(message.content).includes(`M0_REPLY:${text}:`)), `${view.name} reply ${text}`, 30_000);
}
async function openDirectory(view, path) {
  const page = view.page; await openSidebar(page); await page.locator(".project-add-menu > summary").click();
  await page.getByRole("button", { name: "打开项目", exact: true }).click();
  await waitFor(async () => await page.locator(".directory-list").getAttribute("aria-busy") === "false", "directory picker initial listing");
  await page.getByLabel("文件夹的绝对路径", { exact: true }).fill(path); await page.getByRole("button", { name: "前往", exact: true }).click();
  await waitFor(async () => await page.locator(".directory-list").getAttribute("aria-busy") === "false" && await page.getByLabel("文件夹的绝对路径", { exact: true }).inputValue() === path, "directory target ready");
}
async function closeProjectDialog(view) { if (await view.page.locator('.dialog[aria-labelledby="project-dialog-title"]').isVisible()) { await view.page.keyboard.press("Escape"); await view.page.locator('.dialog[aria-labelledby="project-dialog-title"]').waitFor({ state: "detached" }); } await closeSidebar(view.page); }
async function beginLogin(view, providerId) {
  await settings(view); await view.page.getByRole("searchbox", { name: "查找服务商" }).fill(providerId);
  const row = view.page.locator(".account-item").filter({ has: view.page.locator(".account-identity > strong", { hasText: new RegExp(`^${providerId}$`, "i") }) });
  await row.getByRole("button", { name: "用 API key 登录", exact: true }).click(); await view.page.locator("#account-step-input").waitFor();
  assert.equal(await view.page.locator("#account-step-input").getAttribute("type"), "password");
  return waitFor(() => view.frames.filter(frame => frame.t === "account_state").at(-1)?.operation?.step, "secret step");
}
async function dismissLogin(view) { await loginDialog(view.page).getByRole("button", { name: "关闭", exact: true }).click(); await loginDialog(view.page).waitFor({ state: "detached" }); }
const operation = view => view.frames.filter(frame => frame.t === "account_state").at(-1)?.operation;
const accountView = view => view.frames.filter(frame => frame.t === "host_result" && frame.value?.providers && typeof frame.value.pendingApply === "boolean").at(-1)?.value;
const stored = async () => JSON.parse(await readFile(join(fixture.agentDir, "auth.json"), "utf8"));
const rpcEvents = async () => (await fixture.events()).filter((event, index, all) => event.event === "m31_concurrency_session" && event.mode === "rpc" && all.findIndex(item => item.event === "m31_concurrency_session" && item.mode === "rpc" && item.pid === event.pid) === index);
const pending = view => view.page.locator(".account-banner").filter({ hasText: "凭据已变更" });
async function accountReady(view, providerId) {
  await waitFor(() => { const value = accountView(view); return value && !value.pendingApply && value.providers.some(item => item.id === providerId && item.models > 0); }, `applied ${providerId}`);
  await pending(view).waitFor({ state: "detached" });
}

try {
  const extension = await realpath(resolve(process.env.PI_M0_EXTENSION || "src/extension/index.ts"));
  let root = dirname(extension); while (JSON.parse(await readFile(join(root, "package.json"), "utf8").catch(() => "{}" )).name !== "@lilibonk/pi-pane") { const parent = dirname(root); assert.notEqual(parent, root); root = parent; }
  report.artifact = { extension, selectedByEnvironment: !!process.env.PI_M0_EXTENSION, extensionSha256: hash(await readFile(extension)), webIndexSha256: hash(await readFile(join(root, "web-dist/index.html"))), tarballSha256: process.env.PI_M31_TARBALL_SHA256 ?? null };
  let projectB, projectC;
  fixture = await startFixture({ extraExtensions: ["tests/fixtures/m31-concurrency.ts"],
    prepareAgentDir: async (_agent, base) => { const canonical = await realpath(base); projectB = join(canonical, "concurrent-project-b"); projectC = join(canonical, "concurrent-project-c"); await mkdir(projectB); await mkdir(projectC); } });
  browser = await chromium.launch({ executablePath: process.env.PI_BROWSER_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  a = await makeViewer("desktop-a", false); b = await makeViewer("mobile-b", true);

  await check("CONC-01", "two independent real pages share one host and distinct leases", async () => {
    const leases = viewers.map(view => view.frames.find(frame => frame.t === "welcome")?.clientId);
    assert.ok(leases.every(Boolean)); assert.notEqual(leases[0], leases[1]); assert.equal(a.snapshot.session.id, b.snapshot.session.id);
    assert.deepEqual(await stored(), {}); await shot(a, "01-a-connected"); await shot(b, "01-b-connected"); return { leasesDistinct: true, sessionId: a.snapshot.session.id };
  });
  await check("CONC-02", "simultaneous project opens converge on one active child without orphan writers", async () => {
    await Promise.all([openDirectory(a, projectB), openDirectory(b, projectC)]);
    const starts = viewers.map(view => view.sent.length);
    await Promise.all([a.page.getByRole("button", { name: "打开此文件夹", exact: true }).click(), b.page.getByRole("button", { name: "打开此文件夹", exact: true }).click()]);
    await waitFor(() => a.snapshot?.session.cwd === b.snapshot?.session.cwd && [projectB, projectC].includes(a.snapshot?.session.cwd) && a.snapshot?.state.idle && b.snapshot?.state.idle, "project race converged", 40_000);
    const commands = viewers.flatMap((view, index) => view.sent.slice(starts[index]).filter(frame => frame.t === "host_command" && frame.command === "project_open").map(frame => ({ view, frame })));
    assert.equal(commands.length, 2, "both real pages submitted an open");
    const results = await Promise.all(commands.map(async ({ view, frame }) => {
      const ack = await waitFor(() => view.frames.find(item => item.t === "ack" && item.id === frame.id), "project ack");
      if (ack.status !== "dispatched") return { page: view.name, status: ack.status, code: ack.error?.code, path: frame.args.path };
      const result = await waitFor(() => view.frames.find(item => item.t === "command_result" && item.id === frame.id), "project result", 40_000);
      return { page: view.name, status: result.status, code: result.error?.code, path: frame.args.path };
    }));
    assert.ok(results.some(item => item.status === "completed"));
    await shot(a, "02-a-project-race"); await shot(b, "02-b-project-race");
    await Promise.all(viewers.map(closeProjectDialog));
    await waitFor(async () => (await rpcEvents()).filter(event => alive(event.pid)).length === 1, "one active project writer");
    assert.equal(a.snapshot.session.id, b.snapshot.session.id); return { results, selectedProject: a.snapshot.session.cwd, liveRpcChildren: 1 };
  });
  await check("CONC-03", "two settings editors contend from the same saved value and converge", async () => {
    await Promise.all(viewers.map(view => settings(view, "模型默认")));
    const control = view => view.page.getByLabel("默认思考强度", { exact: true });
    await Promise.all(viewers.map(view => control(view).waitFor()));
    const baseline = await control(a).inputValue(); assert.equal(baseline, await control(b).inputValue());
    const options = await control(a).locator("option").evaluateAll(items => items.map(item => item.value));
    const choices = ["low", "medium", "high", "off"].filter(value => value !== baseline && options.includes(value)); assert.ok(choices.length >= 2);
    await control(a).selectOption(choices[0]); await control(b).selectOption(choices[1]);
    const row = view => view.page.locator(".setting-row").filter({ has: control(view) });
    // Bring both controls into view before either click. Otherwise mobile auto-scroll can happen
    // after the other page has already saved and the live query has reset this page's draft.
    const saveButtons = viewers.map(view => row(view).getByRole("button", { name: "保存", exact: true }));
    await Promise.all(saveButtons.map(button => button.scrollIntoViewIfNeeded()));
    const boxes = await Promise.all(saveButtons.map(button => button.boundingBox())); assert.ok(boxes.every(Boolean));
    assert.ok((await Promise.all(saveButtons.map(button => button.isEnabled()))).every(Boolean));
    await Promise.all(viewers.map((view, index) => view.page.mouse.move(boxes[index].x + boxes[index].width / 2, boxes[index].y + boxes[index].height / 2)));
    await Promise.all(viewers.map(view => view.page.mouse.down()));
    const starts = viewers.map(view => view.sent.length);
    await Promise.all(viewers.map(view => view.page.mouse.up()));
    // Both clicks must be resolved before the commands are counted: a page has either sent its change, or the
    // other page's save reached it first and reset its draft (its save button is gone). Counting as soon as
    // one page had sent could miss the request that goes on to win.
    const dispatched = index => viewers[index].sent.slice(starts[index]).some(frame => frame.t === "host_command" && frame.command === "setting_set");
    await waitFor(async () => viewers.some((_, index) => dispatched(index))
      && (await Promise.all(saveButtons.map(async (button, index) => dispatched(index) || await button.count() === 0))).every(Boolean), "both setting clicks resolved");
    const commands = viewers.flatMap((view, index) => view.sent.slice(starts[index]).filter(frame => frame.t === "host_command" && frame.command === "setting_set").map(frame => ({ view, frame })));
    assert.ok(commands.length >= 1 && commands.length <= 2, "one or both simultaneous clicks dispatch before the live invalidation");
    if (commands.length === 2) assert.equal(commands[0].frame.args.expected, commands[1].frame.args.expected, "same optimistic baseline");
    const results = await Promise.all(commands.map(async ({ view, frame }) => {
      const ack = await waitFor(() => view.frames.find(item => item.t === "ack" && item.id === frame.id), "setting ack");
      const result = ack.status === "dispatched" ? await waitFor(() => view.frames.find(item => item.t === "command_result" && item.id === frame.id), "setting result") : ack;
      return { page: view.name, value: frame.args.value, status: result.status, code: result.error?.code };
    }));
    const successful = results.filter(item => item.status === "completed"); assert.equal(successful.length, 1, "only one change wins against the same baseline");
    const saved = JSON.parse(await readFile(join(fixture.agentDir, "settings.json"), "utf8")).defaultThinkingLevel; assert.equal(saved, successful[0].value);
    await waitFor(async () => await control(a).inputValue() === saved && await control(b).inputValue() === saved, "both setting controls converge");
    await shot(a, "03-a-settings-race"); await shot(b, "03-b-settings-race"); await Promise.all(viewers.map(closeSettings)); return { simultaneousUiClicks: 2, initialBaseline: baseline, chosenValues: choices.slice(0, 2), transmittedCommands: commands.length, resolution: commands.length === 2 ? "second request rejected against same saved baseline" : "live host update reset the other draft before its click dispatched", results, saved };
  });
  await check("CONC-04", "another page sees no secret step, can chat and run a native command, and can cancel the login", async () => {
    const step = await beginLogin(a, "openai"); const id = operation(a).id;
    await settings(b); await b.page.getByText("另一个页面正在登录", { exact: false }).waitFor();
    assert.equal(operation(b)?.owner, false); assert.equal(operation(b)?.id, id); assert.equal(operation(b)?.step, undefined); assert.equal(operation(b)?.notices, undefined);
    assert.equal(await b.page.locator("#account-step-input").count(), 0); assert.equal(await loginDialog(b.page).count(), 0); assert.equal(await b.page.getByRole("button", { name: "提交", exact: true }).count(), 0);
    await shot(a, "04-a-secret-owner"); await shot(b, "04-b-no-secret-control");
    await closeSettings(b); await send(b, "/m31-page-command"); await fixture.waitEvent("m31_concurrency_command");
    await send(b, "M31_OTHER_PAGE_LOGIN_PROMPT"); await settled(b, "M31_OTHER_PAGE_LOGIN_PROMPT"); assert.equal(operation(a)?.status, "running");
    await shot(b, "04-b-chat-during-login"); await settings(b); await b.page.getByRole("button", { name: "取消该登录", exact: true }).click();
    await waitFor(() => operation(a)?.id === id && operation(a)?.status === "cancelled", "cancelled by other page");
    assert.equal((await stored()).openai, undefined); await shot(a, "04-a-cancelled-remotely");
    await dismissLogin(a); await Promise.all(viewers.map(closeSettings)); return { stepKind: step.kind, ownerOnly: true, commandCompleted: true, promptCompleted: true, cancelledByOtherPage: true };
  });
  await check("CONC-05", "saving a synthetic key during a reply leaves pending without interrupting the reply", async () => {
    await beginLogin(a, "deepseek"); await a.page.locator("#account-step-input").fill(secrets[0]);
    const sessionId = b.snapshot.session.id; const childrenBefore = (await rpcEvents()).length;
    await send(b, "M0_SLOW_M31_CONCURRENT_BUSY"); await waitFor(() => b.snapshot?.state.running, "reply running");
    await a.page.getByRole("button", { name: "提交", exact: true }).click();
    await waitFor(() => operation(a)?.status === "saved", "saved during reply"); assert.equal(b.snapshot.state.running, true, "key was saved before reply finished");
    await dismissLogin(a); await pending(a).waitFor(); assert.equal((await stored()).deepseek.key, secrets[0]);
    await shot(a, "05-a-pending-while-replying"); await shot(b, "05-b-reply-uninterrupted");
    await settled(b, "M0_SLOW_M31_CONCURRENT_BUSY"); await fixture.waitEvent("provider_done", 0, event => event.input === "M0_SLOW_M31_CONCURRENT_BUSY");
    assert.equal((await fixture.events()).some(event => event.event === "provider_aborted" && event.input === "M0_SLOW_M31_CONCURRENT_BUSY"), false);
    assert.equal(accountView(a)?.pendingApply, true); assert.equal(b.snapshot.session.id, sessionId); assert.equal((await rpcEvents()).length, childrenBefore);
    const text = b.snapshot.session.messages.filter(message => message.role === "assistant").at(-1).content.filter(part => part.type === "text").map(part => part.text).join("");
    assert.equal(text, "M0_REPLY:M0_SLOW_M31_CONCURRENT_BUSY:" + "0123456789abcdef".repeat(30));
    await settings(b); await pending(b).waitFor(); await shot(b, "05-b-pending-after-complete");
    await b.page.getByRole("button", { name: "立即应用", exact: true }).click(); await Promise.all(viewers.map(view => accountReady(view, "deepseek")));
    assert.equal(b.snapshot.session.id, sessionId); assert.equal((await rpcEvents()).length, childrenBefore); await shot(b, "05-b-explicit-apply"); await Promise.all(viewers.map(closeSettings));
    return { savedDuringReply: true, completeReplyCharacters: text.length, sessionIdPreserved: true, rpcChildPreserved: true, explicitlyAppliedByOtherPage: true };
  });
  await check("CONC-06", "extension veto keeps saved credentials pending across refresh and across pages, then permits retry", async () => {
    await send(b, "/m31-veto-on"); await fixture.waitEvent("m31_concurrency_veto", 0, event => event.enabled);
    const sessionId = b.snapshot.session.id; const before = (await rpcEvents()).length;
    await beginLogin(a, "groq"); await a.page.locator("#account-step-input").fill(secrets[1]); await a.page.getByRole("button", { name: "提交", exact: true }).click();
    await waitFor(() => operation(a)?.status === "saved", "veto key saved"); await dismissLogin(a); await pending(a).waitFor();
    await waitFor(() => !!accountView(a)?.applyError, "veto apply error"); assert.equal((await stored()).groq.key, secrets[1]);
    assert.equal(accountView(a).pendingApply, true); assert.equal(accountView(a).providers.find(item => item.id === "groq").models, 0);
    await pending(a).getByText("有扩展拒绝了重新加载", { exact: false }).waitFor();
    assert.equal((await pending(a).textContent()).includes("pi 正在回复"), false, "veto is not described as a busy reply");
    const firstError = accountView(a).applyError; await shot(a, "06-a-veto-pending");
    await a.page.reload(); await composer(a.page).waitFor(); await a.page.locator(".dialog-backdrop").waitFor({ state: "detached" }); await settings(a); await pending(a).waitFor();
    await settings(b); await pending(b).waitFor(); assert.ok(accountView(a).applyError); assert.ok(accountView(b).applyError);
    for (const view of viewers) {
      await pending(view).getByText("有扩展拒绝了重新加载", { exact: false }).waitFor();
      assert.equal((await pending(view).textContent()).includes("pi 正在回复"), false, "correct account veto reason on both pages after refresh");
    }
    await shot(a, "06-a-veto-after-refresh"); await shot(b, "06-b-veto-visible");
    await settings(a, "会话行为");
    const settingsPending = a.page.locator(".setting-banner");
    await settingsPending.getByText("有扩展拒绝了重新加载", { exact: false }).waitFor();
    assert.equal((await settingsPending.textContent()).includes("pi 正在回复"), false, "settings use the same accurate veto reason");
    await shot(a, "06-a-settings-veto-reason"); await settings(a);
    await b.page.getByRole("button", { name: "立即应用", exact: true }).click();
    await b.page.getByRole("alert").filter({ hasText: "有扩展拒绝了重新加载" }).waitFor(); await shot(b, "06-b-veto-retry-rejected");
    assert.equal(b.snapshot.session.id, sessionId); assert.equal((await rpcEvents()).length, before);
    await closeSettings(b); await send(b, "/m31-veto-off"); await fixture.waitEvent("m31_concurrency_veto", 0, event => !event.enabled);
    await settings(b); await b.page.getByRole("button", { name: "立即应用", exact: true }).click(); await Promise.all(viewers.map(view => accountReady(view, "groq")));
    assert.equal(b.snapshot.session.id, sessionId); assert.equal((await rpcEvents()).length, before);
    await shot(a, "06-a-veto-retry-applied"); await shot(b, "06-b-veto-retry-applied");
    await Promise.all(viewers.map(closeSettings)); return { initialApplyError: firstError, pendingSurvivedRefresh: true, pendingVisibleOnOtherPage: true, retryWhileVetoedRejected: true, retryAfterVetoRemovedApplied: true, sessionIdPreserved: true };
  });
  await check("CONC-07", "synthetic secrets never appear in browser receipts, DOM, storage, terminal or session logs", async () => {
    const haystacks = { received: JSON.stringify(viewers.flatMap(view => view.frames)), terminal: fixture.terminal, stderr: fixture.processError, events: JSON.stringify(await fixture.events()) };
    for (const view of viewers) { haystacks[`${view.name}-dom`] = await view.page.content(); haystacks[`${view.name}-storage`] = await view.page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } })); }
    for (const file of await readdir(join(fixture.agentDir, "sessions"), { recursive: true })) if (file.endsWith(".jsonl")) haystacks[`session:${file}`] = await readFile(join(fixture.agentDir, "sessions", file), "utf8");
    for (const [where, value] of Object.entries(haystacks)) for (const secret of secrets) assert.equal(value.includes(secret), false, `secret absent from ${where}`);
    assert.equal((await stat(join(fixture.agentDir, "auth.json"))).mode & 0o777, 0o600); assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.externalRequests, []);
    assert.equal((await rpcEvents()).filter(event => alive(event.pid)).length, 1); return { checkedSurfaces: Object.keys(haystacks).length, liveRpcChildren: 1, realRemoteProviderRequests: 0 };
  });
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.error = redact(error.stack ?? error); process.exitCode = 1; console.error(report.error);
  for (const view of viewers) await view.page.screenshot({ path: join(out, `failure-${view.name}.png`) }).catch(() => {});
} finally {
  if (fixture) {
    report.events = (await fixture.events().catch(() => [])).map(event => JSON.parse(redact(JSON.stringify(event))));
    report.commandEvidence = viewers.map(view => ({ page: view.name, commands: view.sent.filter(frame => frame.t === "host_command" || frame.t === "command"), errors: view.frames.filter(frame => frame.t === "account_error" || frame.t === "ack" && frame.status !== "dispatched" || frame.t === "command_result" && frame.status !== "completed") }));
    if (report.status !== "passed") report.diagnostics = { terminal: redact(fixture.terminal.slice(-6000)), stderr: redact(fixture.processError) };
  }
  for (const view of viewers) await view.context.close().catch(() => {}); await browser?.close().catch(() => {});
  if (fixture) {
    const pids = (await rpcEvents().catch(() => [])).map(event => event.pid); await fixture.close().catch(() => {});
    for (const pid of pids) await waitFor(() => !alive(pid), `RPC ${pid} cleanup`, 10_000).catch(() => {});
    report.cleanup = { rpcPids: pids, allRpcStopped: pids.every(pid => !alive(pid)), temporaryHome: fixture.directory };
    await fixture.remove(); report.cleanup.temporaryHomeRemoved = await stat(fixture.directory).then(() => false, () => true);
    if (!report.cleanup.allRpcStopped) { report.status = "failed"; process.exitCode = 1; }
  }
  report.finishedAt = new Date().toISOString(); await writeFile(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.status.toUpperCase()} — ${report.checks.filter(check => check.status === "passed").length}/${report.checks.length} checks; report: ${join(out, "report.json")}`);
}
