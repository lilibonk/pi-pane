#!/usr/bin/env node
// Renders docs/preview.png (README and gallery preview) from the built web assets with a fixed transcript.
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, crc32 } from "node:zlib";
import { chromium } from "playwright";
import { Hub } from "../dist/extension/hub.js";
import { COMMANDS } from "../dist/protocol/index.js";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(process.argv[2] ?? join(project, "docs/preview.png"));

/** A small diagram-like PNG: a gradient with a few bars, standing in for a pasted screenshot. */
function screenshotPng(width, height) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  const bars = [0.35, 0.62, 0.48, 0.85, 0.7];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (width * 3 + 1) + 1 + x * 3;
    let color = [30 + (x / width) * 30, 34 + (y / height) * 20, 48 + (x / width) * 40];
    const bar = Math.floor((x - 40) / ((width - 80) / bars.length));
    const inBar = x > 40 && x < width - 40 && (x - 40) % ((width - 80) / bars.length) > 14 && bar >= 0 && bar < bars.length;
    if (inBar && y > height - 30 - bars[bar] * (height - 70) && y < height - 30) color = bar === 3 ? [224, 108, 117] : [97, 175, 239];
    raw.set(color.map(Math.round), offset);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const image = screenshotPng(420, 180);
const patch = "--- a/src/chart.ts\n+++ b/src/chart.ts\n@@ -12,7 +12,7 @@ export function bars(values: number[]) {\n   const max = Math.max(...values);\n   return values.map((value) => ({\n-    height: value / max,\n+    height: max ? value / max : 0,\n     highlight: value === max,\n   }));\n }\n";
const reply = [
  "第四根柱子被高亮，是因为它是最大值；问题在于 **全部为 0** 时 `max` 为 0，除法得到 `NaN`。", "",
  "已修复并补充了测试：", "",
  "```ts", "expect(bars([0, 0])).toEqual([{ height: 0, highlight: true }, { height: 0, highlight: true }]);", "```",
].join("\n");
const messages = [
  { id: "entry:u1", entryId: "u1", role: "user", status: "complete", content: [
    { type: "text", text: "截图里第四根柱子为什么是红色？数据全为 0 时图表还会崩。" },
    { type: "image", mimeType: "image/png", bytes: image.length, width: 420, height: 180 },
  ] },
  { id: "entry:a1", entryId: "a1", role: "assistant", status: "complete", content: [
    { type: "thinking", text: "先看 bars() 的实现，再处理 max 为 0 的情况。", durationMs: 1420, timingStatus: "complete" },
    { type: "toolCall", id: "t-edit", name: "edit", arguments: { path: "src/chart.ts", edits: [{ oldText: "value / max", newText: "max ? value / max : 0" }] } },
    { type: "toolCall", id: "t-bash", name: "bash", arguments: { command: "npm test -- chart" } },
  ] },
  { id: "entry:r1", entryId: "r1", role: "toolResult", toolCallId: "t-edit", toolName: "edit", status: "complete", content: [{ type: "text", text: "Successfully replaced 1 block." }, { type: "diff", text: patch }] },
  { id: "entry:r2", entryId: "r2", role: "toolResult", toolCallId: "t-bash", toolName: "bash", status: "complete", content: [{ type: "text", text: "✓ chart › bars handles all-zero data (3 ms)\n✓ chart › highlights the maximum (1 ms)\n\nTests: 2 passed" }] },
  { id: "entry:a2", entryId: "a2", role: "assistant", status: "complete", content: [{ type: "text", text: reply }] },
];
const model = { provider: "anthropic", id: "claude", name: "Claude", images: true };
const bridge = {
  sessionId: "preview", branchRevision: 0, isCurrent: () => true, setObserver: () => {}, flush: () => {},
  dispatch: () => { throw new Error("preview is read-only"); },
  snapshot: () => structuredClone({
    session: { id: "preview", name: "图表修复", cwd: "~/work/dashboard", leafId: "a2", branchRevision: 0, messages, olderCursor: null },
    state: { idle: true, running: false, compacting: false, hasPendingMessages: false, thinking: "medium", tools: [], uiPrompts: [], model, models: [model] },
    theme: {}, caps: { commands: COMMANDS, images: true, promptReceipt: "rpc", queueView: "boolean", extensionDialogs: true, workbench: true, host: true, history: "paged", content: "paged" },
  }),
  imagePage: (messageId, index) => ({ messageId, index, mimeType: "image/png", data: image.toString("base64") }),
};
const hub = new Hub({ port: 0, webRoot: join(project, "web-dist") });
let browser;
try {
  await hub.start();
  hub.bindBridge(bridge);
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, deviceScaleFactor: 2 });
  await page.goto(hub.url);
  await page.getByText("已连接", { exact: true }).waitFor();
  await page.locator("[data-image-status=ready]").waitFor();
  await page.locator(".tool-card .diff").first().waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: output });
  console.log(`Preview: ${output}`);
} finally {
  await browser?.close();
  await hub.close();
}
