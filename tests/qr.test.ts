import assert from "node:assert/strict";
import test from "node:test";
import jsQR from "jsqr";
import { qrLines, qrWidth } from "../src/extension/qr.ts";

/** Rebuilds the module matrix from half-block characters and decodes it like a phone camera would. */
function decode(lines: string[]): string | undefined {
  const rows: boolean[][] = [];
  for (const line of lines) {
    const cells = [...line.replace(/\x1b\[[0-9;]*m/g, "")];
    rows.push(cells.map((cell) => cell === "█" || cell === "▀"), cells.map((cell) => cell === "█" || cell === "▄"));
  }
  const scale = 6;
  const width = rows[0]!.length * scale;
  const height = rows.length * scale;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const value = rows[Math.floor(y / scale)]![Math.floor(x / scale)] ? 0 : 255;
    pixels.set([value, value, value, 255], (y * width + x) * 4);
  }
  return jsQR(pixels, width, height)?.data;
}

test("the terminal QR code decodes to the exact external link", () => {
  const url = `https://pane.example.test:8443/#t=${"A1b2_-".repeat(7)}x`;
  const lines = qrLines(url);
  assert.equal(decode(lines), url);
  assert.ok(lines.length <= 25, "fits a normal terminal height");
  assert.equal([...lines[0]!.replace(/\x1b\[[0-9;]*m/g, "")].length, qrWidth(url));
});
