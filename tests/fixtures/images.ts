/** Small, structurally valid image files for validation tests. The PNG is fully decodable. */
import { crc32, deflateSync } from "node:zlib";

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
/** An RGB PNG filled with one color; `noise` makes it hard to compress (for size tests). */
export function png(width: number, height: number, color = [200, 80, 40], noise = false): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2; header[10] = 0; header[11] = 0; header[12] = 0;
  const row = 1 + width * 3;
  const raw = Buffer.alloc(row * height);
  let seed = 1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * row + 1 + x * 3;
    for (let c = 0; c < 3; c++) {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      raw[offset + c] = noise ? seed >>> 24 : color[c]!;
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
/** JPEG structure with a frame header; not decodable image data. */
export function jpegHeader(width: number, height: number): Buffer {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "binary"), sof, Buffer.from([0xff, 0xd9])]);
}
/** Lossless WebP header with the given size. */
export function webpHeader(width: number, height: number): Buffer {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  const data = Buffer.alloc(10);
  data[0] = 0x2f;
  data.writeUInt32LE(bits >>> 0, 1);
  const vp8l = Buffer.concat([Buffer.from("VP8L"), Buffer.from([data.length, 0, 0, 0]), data]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(4 + vp8l.length);
  return Buffer.concat([Buffer.from("RIFF"), size, Buffer.from("WEBP"), vp8l]);
}
