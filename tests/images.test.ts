import assert from "node:assert/strict";
import test from "node:test";
import { base64Length, commandArgs, decodeBase64, inspectImage, LIMITS, ProtocolError, validateImages } from "../src/protocol/index.ts";
import { jpegHeader, png, webpHeader } from "./fixtures/images.ts";

const b64 = (bytes: Buffer) => bytes.toString("base64");

test("image structure, not the declared type, decides the format and size", () => {
  assert.deepEqual(inspectImage(png(3, 2)), { mimeType: "image/png", width: 3, height: 2 });
  assert.deepEqual(inspectImage(jpegHeader(640, 480)), { mimeType: "image/jpeg", width: 640, height: 480 });
  assert.deepEqual(inspectImage(webpHeader(1000, 700)), { mimeType: "image/webp", width: 1000, height: 700 });
  assert.equal(inspectImage(Buffer.from("GIF89a....................................")), null);
  // Truncated files fail a complete check but still have readable headers.
  const truncated = png(4, 4).subarray(0, 40);
  assert.equal(inspectImage(truncated), null);
  assert.equal(inspectImage(truncated, false)?.width, 4);
  const badCrc = png(4, 4);
  badCrc[29] ^= 0xff;
  assert.equal(inspectImage(badCrc), null);
  assert.equal(inspectImage(jpegHeader(10, 10).subarray(0, 12)), null);
});

test("base64 must be canonical and decodes in Node and browsers alike", () => {
  assert.equal(base64Length("aGVsbG8="), 5);
  for (const bad of ["aGVsbG8", "aGVs bG8=", "aGVsbG8==", "a===", "@@@@"]) assert.equal(base64Length(bad), -1);
  assert.equal(Buffer.from(decodeBase64("aGVsbG8gd29ybGQ=", 5)).toString(), "hello");
});

test("prompt images are bounded by count, type, bytes, structure and pixels", () => {
  const ok = { mimeType: "image/png", data: b64(png(8, 8)) };
  assert.equal(commandArgs("prompt", { text: "", images: [ok] }).images !== undefined, true);
  assert.equal(validateImages([ok, ok, ok, ok]).length, 4);
  const cases: Array<[unknown, RegExp]> = [
    [[ok, ok, ok, ok, ok], /at most 4/],
    [[{ mimeType: "image/gif", data: ok.data }], /PNG, JPEG and WebP/],
    [[{ mimeType: "image/png", data: "not base64!" }], /base64/],
    [[{ mimeType: "image/jpeg", data: ok.data }], /is image\/png, not image\/jpeg/],
    [[{ mimeType: "image/png", data: b64(png(4, 4).subarray(0, 40)) }], /damaged/],
    [[{ mimeType: "image/webp", data: b64(webpHeader(5000, 4001)) }], /20 million pixels/],
    [[{ mimeType: "image/png", data: ok.data, name: "x" }], /PNG, JPEG and WebP/],
    [[{ mimeType: "image/png", data: "A".repeat(Math.ceil(LIMITS.imageBytes / 3) * 4 + 4) }], /exceeds 5 MiB/],
  ];
  for (const [images, message] of cases) {
    assert.throws(() => commandArgs("prompt", { text: "x", images }), (error: unknown) => error instanceof ProtocolError && message.test(error.message), String(message));
  }
  const fourMiB = { mimeType: "image/png", data: b64(png(1300, 1300, undefined, true)) };
  assert.ok(base64Length(fourMiB.data) > 4 * 1024 * 1024);
  assert.throws(() => validateImages([fourMiB, fourMiB, fourMiB]), /10 MiB in total/);
});
