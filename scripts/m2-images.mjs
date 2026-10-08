#!/usr/bin/env node
// A9: images in a real pi TUI and system Chrome. Upload validation (browser and extension), paste/drop/picker,
// delivery to the provider, lazy history images with a bounded browser cache, oversized history images, reload.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { tsImport } from "tsx/esm/api";
import { openClient, startFixture, textOf, waitFor } from "./m0-smoke.mjs";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportDir = resolve(process.env.PI_M2_REPORT_DIR ?? join(project, "build-artifacts/m2/images"));
await mkdir(reportDir, { recursive: true });
const { png, webpHeader } = await tsImport("../tests/fixtures/images.ts", import.meta.url);
const CACHE_LIMIT = 48 * 1024 * 1024;
const HISTORY = { count: 160, side: 400 };
const report = {
  scope: "A9: prompt images and history images through a real pi TUI and system Chrome",
  realTui: true, realModelCalls: 0, browser: "system Chrome via Playwright, headless, 1280×900", checks: [], status: "running",
};
const redact = value => value.replace(/#t=[A-Za-z0-9_-]+/g, "#t=[REDACTED]").replace(/pi-pane\.bearer\.[A-Za-z0-9_-]+/g, "pi-pane.bearer.[REDACTED]");
const check = async (name, action) => {
  const started = Date.now();
  try {
    const details = await action();
    report.checks.push({ name, status: "passed", durationMs: Date.now() - started, ...(details ? { details } : {}) });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.checks.push({ name, status: "failed", durationMs: Date.now() - started, error: redact(String(error?.stack ?? error)) });
    console.log(`FAIL ${name}: ${redact(String(error))}`);
    throw error;
  }
};

let fixture, browser, page, client;
const errors = [];
try {
  fixture = await startFixture({ extraExtensions: [join(project, "tests/fixtures/image-history.ts")] });
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", error => errors.push(String(error)));
  const trace = [];
  page.on("websocket", socket => {
    const summarize = (direction, payload) => {
      if (typeof payload !== "string" || payload.length > 200_000 && !payload.includes('"image_page"')) return;
      try { const frame = JSON.parse(payload.length > 2000 ? payload.slice(0, 300) + "}" : payload); if (["image_page", "error", "snapshot", "session_reset", "switching"].includes(frame.t)) trace.push([direction, frame.t, frame.reqId, frame.messageId, frame.index, frame.error?.code]); }
      catch { if (payload.includes('"image_page"') || payload.includes('"snapshot"')) trace.push([direction, payload.slice(0, 120)]); }
    };
    socket.on("framesent", frame => summarize("out", frame.payload));
    socket.on("framereceived", frame => summarize("in", frame.payload));
  });
  await page.goto(fixture.url);
  await page.getByText("已连接", { exact: true }).waitFor();
  const attachments = () => page.locator(".attachment").count();
  const attachmentError = () => page.locator(".attachment-error").textContent().catch(() => "");
  const clearAttachments = async () => {
    // The count updates on the next animation frame; wait for it before the next click.
    for (let count = await attachments(); count > 0; count--) {
      await page.locator(".attachment button").first().click();
      await waitFor(async () => await attachments() === count - 1, "attachment removed");
    }
  };

  // Real encoder output from Chrome's canvas: decodable PNG/JPEG/WebP files.
  const encoded = await page.evaluate(async () => {
    const canvas = Object.assign(document.createElement("canvas"), { width: 320, height: 200 });
    const context = canvas.getContext("2d");
    const gradient = context.createLinearGradient(0, 0, 320, 200);
    gradient.addColorStop(0, "#e06c75"); gradient.addColorStop(1, "#61afef");
    context.fillStyle = gradient; context.fillRect(0, 0, 320, 200);
    context.fillStyle = "#fff"; context.font = "32px sans-serif"; context.fillText("pi-pane M2", 60, 110);
    const out = {};
    for (const type of ["image/png", "image/jpeg", "image/webp"]) {
      const blob = await new Promise(done => canvas.toBlob(done, type, 0.9));
      out[type] = [...new Uint8Array(await blob.arrayBuffer())];
    }
    return out;
  });
  const file = (type) => Buffer.from(encoded[type]);

  await check("PNG, JPEG and WebP attached by paste, drop and picker reach pi as three images", async () => {
    await page.evaluate(([pngBytes, webpBytes]) => {
      const textarea = document.querySelector("textarea");
      const pasted = new DataTransfer();
      pasted.items.add(new File([new Uint8Array(pngBytes)], "pasted.png", { type: "image/png" }));
      textarea.dispatchEvent(new ClipboardEvent("paste", { clipboardData: pasted, bubbles: true, cancelable: true }));
      const dropped = new DataTransfer();
      dropped.items.add(new File([new Uint8Array(webpBytes)], "dropped.webp", { type: "image/webp" }));
      const composer = document.querySelector(".composer");
      composer.dispatchEvent(new DragEvent("dragover", { dataTransfer: dropped, bubbles: true, cancelable: true }));
      composer.dispatchEvent(new DragEvent("drop", { dataTransfer: dropped, bubbles: true, cancelable: true }));
    }, [encoded["image/png"], encoded["image/webp"]]);
    await waitFor(async () => await attachments() === 2, "pasted and dropped attachments");
    await page.locator("input[type=file]").setInputFiles({ name: "picked.jpg", mimeType: "image/jpeg", buffer: file("image/jpeg") });
    await waitFor(async () => await attachments() === 3, "picked attachment");
    await page.getByRole("textbox", { name: "消息" }).fill("M2_IMAGES");
    await page.getByRole("button", { name: /^(发送 ↗|请求 followUp ↗)$/ }).click();
    const call = await fixture.waitEvent("provider_call", 0, event => event.input === "M2_IMAGES");
    assert.equal(call.images.length, 3, "the provider receives all three images");
    assert.equal(await attachments(), 0, "attachments are cleared after sending");
    const message = page.locator(".message-user").filter({ hasText: "M2_IMAGES" });
    try { await waitFor(async () => await message.locator("[data-image-status=ready] img").count() === 3, "user message images load in the browser", 20_000); }
    catch (error) { report.trace = trace.slice(-40); throw error; }
    const sizes = await message.locator("img").evaluateAll(images => images.map(image => [image.naturalWidth, image.naturalHeight]));
    assert.ok(sizes.every(([width, height]) => width > 0 && height > 0), "loaded images decode");
    return { providerImages: call.images, rendered: sizes };
  });

  await check("damaged, oversized, mislabeled, over-pixel and unsupported images fail before upload", async () => {
    const cases = [
      [{ name: "truncated.png", mimeType: "image/png", buffer: file("image/png").subarray(0, 60) }, "已损坏"],
      [{ name: "big.png", mimeType: "image/png", buffer: png(1400, 1400, undefined, true) }, "超过 5 MiB"],
      [{ name: "fake.jpg", mimeType: "image/jpeg", buffer: file("image/png") }, "已损坏或格式与扩展名不符"],
      [{ name: "huge.webp", mimeType: "image/webp", buffer: webpHeader(5000, 4001) }, "超过 2,000 万像素"],
      [{ name: "anim.gif", mimeType: "image/gif", buffer: Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;") }, "仅支持 PNG、JPEG、WebP"],
      [{ name: "undecodable.png", mimeType: "image/png", buffer: Buffer.concat([file("image/png").subarray(0, 33), png(4, 4).subarray(33)]) }, "无法解码"],
    ];
    const seen = [];
    for (const [input, expected] of cases) {
      await page.locator("input[type=file]").setInputFiles(input);
      await waitFor(async () => (await attachmentError()).includes(expected), `${input.name}: ${expected}`);
      assert.equal(await attachments(), 0, `${input.name} is not attached`);
      seen.push({ file: input.name, message: await attachmentError() });
    }
    const valid = { name: "ok.png", mimeType: "image/png", buffer: file("image/png") };
    await page.locator("input[type=file]").setInputFiles([valid, valid, valid, valid, valid]);
    await waitFor(async () => await attachments() === 4 && (await attachmentError()).includes("最多附加 4 张"), "fifth image refused");
    await clearAttachments();
    return seen;
  });

  await check("the extension independently rejects invalid images sent over WebSocket; pi is not called", async () => {
    client = await openClient(fixture.url);
    const before = await fixture.eventCount("provider_call");
    const pngData = file("image/png").toString("base64");
    const cases = [
      [[{ mimeType: "image/jpeg", data: pngData }], "invalid_image"],
      [[{ mimeType: "image/png", data: file("image/png").subarray(0, 60).toString("base64") }], "invalid_image"],
      [[{ mimeType: "image/png", data: "not base64" }], "invalid_image"],
      [Array(5).fill({ mimeType: "image/png", data: pngData }), "invalid_image"],
      [[{ mimeType: "image/webp", data: webpHeader(5000, 4001).toString("base64") }], "image_too_large"],
      [[png(1400, 1400, undefined, true)].map(buffer => ({ mimeType: "image/png", data: buffer.toString("base64") })), "image_too_large"],
    ];
    const codes = [];
    for (const [images, code] of cases) {
      const { ack } = await client.command("prompt", { text: "M2_BAD_IMAGE", images });
      assert.equal(ack.status, "rejected"); assert.equal(ack.error?.code, code);
      codes.push(ack.error.code);
    }
    await new Promise(done => setTimeout(done, 500));
    assert.equal(await fixture.eventCount("provider_call"), before, "rejected images never reach the provider");
    return { codes };
  });

  await check(`${HISTORY.count} history images: metadata-only snapshot, lazy loading, cache within 48 MiB`, async () => {
    fixture.command(`/m2-image-history ${HISTORY.count} ${HISTORY.side}`);
    const added = await fixture.waitEvent("image_history_added", 0);
    await waitFor(() => client.snapshot?.session.messages.filter(message => textOf(message).startsWith("IMAGE ")).length === HISTORY.count, "history projected", 60_000);
    const frames = [];
    page.on("websocket", socket => socket.on("framereceived", frame => frames.push(typeof frame.payload === "string" ? frame.payload.length : frame.payload.byteLength)));
    await page.reload();
    await page.getByText("已连接", { exact: true }).waitFor();
    await waitFor(async () => await page.locator(".image-block").count() >= HISTORY.count, "image placeholders rendered");
    const ready = new Set();
    let maxCache = 0;
    const sample = async () => {
      const state = await page.evaluate(() => ({
        ready: [...document.querySelectorAll("[data-image-status=ready]")].map(element => element.dataset.imageKey),
        cache: Number(document.documentElement.dataset.imageCacheBytes ?? 0),
      }));
      for (const key of state.ready) ready.add(key);
      maxCache = Math.max(maxCache, state.cache);
      return state;
    };
    await new Promise(done => setTimeout(done, 1500));
    const initial = (await sample()).ready.length;
    const snapshotBytes = frames.reduce((sum, size) => sum + size, 0);
    assert.ok(initial < 20, `only nearby images load at first (${initial})`);
    // Scroll from the newest to the oldest message, letting visible images load.
    const timeline = page.locator(".timeline");
    let steps = 0;
    for (; steps < 600; steps++) {
      const top = await timeline.evaluate(element => { element.scrollTop = Math.max(0, element.scrollTop - element.clientHeight * 0.8); return element.scrollTop; });
      // Intersection callbacks and effects run after layout; then wait for the reads they started.
      await new Promise(done => setTimeout(done, 120));
      await waitFor(async () => {
        const loading = await page.locator("[data-image-status=loading]").count();
        await sample();
        return loading === 0;
      }, "visible images settle", 20_000);
      if (top === 0) break;
    }
    const historyKeys = await page.locator(".image-block").evaluateAll(elements => elements.map(element => element.dataset.imageKey));
    const missing = historyKeys.filter(key => !ready.has(key));
    // The first (prompt) message's three images were loaded earlier on this page; all history images must have loaded once.
    assert.ok(missing.length <= 3, `every history image loaded while scrolling (missing ${missing.length} of ${historyKeys.length} after ${steps} steps; positions ${missing.map(key => historyKeys.indexOf(key))})`);
    assert.ok(maxCache <= CACHE_LIMIT, `cache stayed within 48 MiB (max ${maxCache})`);
    assert.ok(added.bytes > CACHE_LIMIT, "the dataset is larger than the cache, so eviction was exercised");
    const largestFrame = Math.max(...frames);
    return { images: added.count, datasetBytes: added.bytes, initialLoaded: initial, loadedWhileScrolling: ready.size,
      maxCacheBytes: maxCache, framesBeforeScrolling: { bytes: snapshotBytes }, largestFrameChars: largestFrame };
  });

  await check("an image above the transfer limit fails explicitly; reload restores lazily loaded images", async () => {
    fixture.command(`/m2-image-history 1 1450`);
    const added = await fixture.waitEvent("image_history_added", 1);
    assert.ok(added.bytes > 5 * 1024 * 1024);
    await page.locator(".timeline").evaluate(element => { element.scrollTop = element.scrollHeight; });
    const last = page.locator(".image-block").last();
    await waitFor(async () => (await last.getAttribute("data-image-status")) === "error", "oversized image error", 20_000);
    assert.match(await last.textContent(), /超过浏览器传输上限/);
    await page.reload();
    await page.getByText("已连接", { exact: true }).waitFor();
    // The newest (oversized) image fails again; the images above it load again on demand.
    await waitFor(async () => await page.locator("[data-image-status=ready]").count() >= 1 &&
      await page.locator(".image-block").last().getAttribute("data-image-status") === "error", "images load again after reload", 20_000)
      .catch(async error => { report.statuses = await page.locator(".image-block").evaluateAll(elements => elements.slice(-6).map(element => [element.dataset.imageStatus, Math.round(element.getBoundingClientRect().top), element.textContent])); report.trace = trace.slice(-20); throw error; });
    assert.deepEqual(errors, []);
    return { oversizedBytes: added.bytes };
  });
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = redact(String(error?.stack ?? error));
  process.exitCode = 1;
} finally {
  await client?.close().catch(() => {});
  await browser?.close();
  if (fixture) { await fixture.close(); await fixture.remove(); }
  report.pageErrors = errors.map(redact);
  report.finishedAt = new Date().toISOString();
  await writeFile(join(reportDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report: ${join(reportDir, "report.json")}`);
}
