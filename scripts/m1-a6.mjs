#!/usr/bin/env node
// A6: reference dataset of 1,000 messages (≤1 MiB normalized text, no images) in a real pi TUI.
// 20 browser measurements of WS connection open → snapshot applied and rendered; P95 must be ≤ 1 s.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, platform, release, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startFixture, waitFor } from "./m0-smoke.mjs";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportDir = resolve(process.env.PI_M1_REPORT_DIR ?? join(project, "build-artifacts/m3/handoff/m1/a6"));
await mkdir(reportDir, { recursive: true });
const runs = Number(process.env.PI_M1_A6_RUNS ?? 20);
const MESSAGES = 1000;
const PAYLOAD = 900; // "HISTORY n\n" + 900 characters ≈ 0.91 MB normalized text in total
const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(p / 100 * sorted.length) - 1)]; };
const summary = values => ({ min: Math.min(...values), p50: percentile(values, 50), p95: percentile(values, 95), max: Math.max(...values) });

const report = {
  scope: "A6 reference dataset: WS open to snapshot applied and rendered in Chrome; /web-to-browser startup recorded separately",
  environment: { node: process.version, os: `${platform()} ${release()}`, arch: process.arch, cpuModel: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(),
    piVersion: JSON.parse(await readFile(join(project, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8")).version, browser: "system Chrome via Playwright, headless, 1280×900" },
  dataset: { messages: MESSAGES, charactersPerMessage: PAYLOAD + 12, images: 0 }, runs, threshold: { p95Ms: 1000 }, checks: [], status: "running",
};
let fixture;
let browser;
try {
  fixture = await startFixture({ extraExtensions: [join(project, "tests/fixtures/performance-provider.ts")], provider: "pi-pane-m0-perf", model: "deterministic",
    envOverrides: { PI_M0_PERF_OUTPUT_DIR: reportDir } });
  const before = await fixture.eventCount("perf_history_added");
  fixture.command(`/m0-perf-history ${MESSAGES} ${PAYLOAD}`);
  await fixture.waitEvent("perf_history_added", before);
  const inspectBefore = await fixture.eventCount("perf_inspect");
  fixture.command("/m0-perf-inspect");
  const inspection = await fixture.waitEvent("perf_inspect", inspectBefore);
  report.dataset.branchEntries = inspection.branchEntries;
  report.dataset.normalizedTextCharacters = MESSAGES * (PAYLOAD + `HISTORY ${MESSAGES - 1}\n`.length);
  assert.ok(report.dataset.normalizedTextCharacters <= 1024 * 1024, "dataset stays within 1 MiB of text");

  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  const measureLoad = async () => {
    await page.waitForFunction(() => performance.getEntriesByName("pi-pane:snapshot-rendered").length > 0, null, { timeout: 15_000 });
    return page.evaluate(() => {
      const open = performance.getEntriesByName("pi-pane:ws-open").at(-1);
      const rendered = performance.getEntriesByName("pi-pane:snapshot-rendered").at(-1);
      return { wsToRenderedMs: rendered.startTime - open.startTime, navigationToRenderedMs: rendered.startTime,
        renderedMessages: document.querySelectorAll(".message").length };
    });
  };
  // First load uses the /web link (token in the fragment); later loads reuse the tab's session lease.
  const samples = [];
  await page.goto(fixture.url);
  samples.push(await measureLoad());
  for (let index = 1; index < runs; index++) {
    await page.reload();
    samples.push(await measureLoad());
  }
  const ws = samples.map(sample => sample.wsToRenderedMs);
  const startup = samples.map(sample => sample.navigationToRenderedMs);
  report.samples = samples;
  report.wsToRendered = summary(ws);
  report.navigationToRendered = summary(startup);
  report.checks.push({ name: `P95 of ${runs} WS-open to snapshot-rendered measurements is within 1 s`, status: report.wsToRendered.p95 <= 1000 ? "passed" : "failed", p95Ms: report.wsToRendered.p95 });
  assert.ok(samples.every(sample => sample.renderedMessages >= 200), "every load renders the full snapshot window");

  // Informational: loading the remaining history page by page in the same browser.
  const started = Date.now();
  while (await page.getByRole("button", { name: "加载更早的消息" }).count()) {
    const count = await page.locator(".message").count();
    await page.getByRole("button", { name: "加载更早的消息" }).click();
    await waitFor(async () => await page.locator(".message").count() > count || !(await page.getByRole("button", { name: "加载更早的消息" }).count()), "older page rendered", 15_000);
  }
  report.fullHistoryInBrowser = { renderedMessages: await page.locator(".message").count(), pagingMs: Date.now() - started };
  assert.ok(report.fullHistoryInBrowser.renderedMessages >= MESSAGES, "the whole dataset is reachable in the browser");
  report.checks.push({ name: "the whole 1,000-message dataset is reachable through browser history paging", status: "passed", ...report.fullHistoryInBrowser });
  assert.deepEqual(errors, []);
  report.status = report.checks.every(check => check.status === "passed") ? "passed" : "failed";
  for (const check of report.checks) console.log(`${check.status === "passed" ? "PASS" : "FAIL"} ${check.name}`);
  console.log(`WS→rendered ms: ${JSON.stringify(report.wsToRendered)}; navigation→rendered ms: ${JSON.stringify(report.navigationToRendered)}`);
  if (report.status !== "passed") process.exitCode = 1;
} catch (error) {
  report.status = "failed";
  report.error = String(error?.stack ?? error).replace(/#t=[A-Za-z0-9_-]+/g, "#t=[REDACTED]");
  console.log(`FAIL ${report.error}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (fixture) { await fixture.close(); await fixture.remove(); }
  report.finishedAt = new Date().toISOString();
  await writeFile(join(reportDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report: ${join(reportDir, "report.json")}`);
}
