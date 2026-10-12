#!/usr/bin/env node
// Generates the extension's toolbar/manifest icons: a flat disc in the panel's
// one accent orange, rasterized per size with 4x4 supersampling and written out
// as PNG with a minimal built-in encoder (no image deps). Deterministic: rerun
// to regenerate identical bytes.
// Usage: node scripts/make-icons.mjs
import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "extension", "icons");
const SIZES = [16, 32, 48, 128];

// --accent, straight out of styles.css :root. The mark is a flat disc: no
// gradient, no highlight, no shade, no glow.
const ACCENT = [0xff, 0x6a, 0x00];

/** One supersample: returns premultiplied [r,g,b,a]. */
function sample(px, py, size, r) {
  const c = size / 2;
  return Math.hypot(px - c, py - c) <= r
    ? [ACCENT[0], ACCENT[1], ACCENT[2], 1]
    : [0, 0, 0, 0];
}

function rasterize(size) {
  const margin = Math.max(1.25, size * 0.1);
  const r = size / 2 - margin;
  const buf = Buffer.alloc(size * size * 4);
  const SS = 4; // 4x4 supersamples per pixel
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sa = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [pr, pg, pb, pa] = sample(
            x + (sx + 0.5) / SS,
            y + (sy + 0.5) / SS,
            size,
            r,
          );
          sr += pr * pa;
          sg += pg * pa;
          sb += pb * pa;
          sa += pa;
        }
      }
      const n = SS * SS;
      const a = sa / n;
      const o = (y * size + x) * 4;
      // sr/sg/sb accumulated premultiplied; un-premultiply by the alpha sum.
      buf[o] = sa > 0 ? Math.min(255, Math.round(sr / sa)) : 0;
      buf[o + 1] = sa > 0 ? Math.min(255, Math.round(sg / sa)) : 0;
      buf[o + 2] = sa > 0 ? Math.min(255, Math.round(sb / sa)) : 0;
      buf[o + 3] = Math.round(a * 255);
    }
  }
  return buf;
}

// ---------------- minimal PNG encoder ----------------

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------- go ----------------

await mkdir(outDir, { recursive: true });
for (const size of SIZES) {
  const png = encodePng(size, rasterize(size));
  const file = path.join(outDir, `icon-${size}.png`);
  await writeFile(file, png);
  console.log(`[icons] ${path.relative(root, file)} (${png.length} bytes)`);
}
