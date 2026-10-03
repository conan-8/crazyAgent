#!/usr/bin/env node
// Generates the extension's toolbar/manifest icons: the side panel's Orb —
// the conic ember field, the top-left highlight, the bottom-right shade —
// frozen into a glowing orange circle, rasterized per size with 4x4
// supersampling and written out as PNG with a minimal built-in encoder
// (no image deps). Deterministic: rerun to regenerate identical bytes.
// Usage: node scripts/make-icons.mjs
import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "extension", "icons");
const SIZES = [16, 32, 48, 128];

// The panel palette (styles.css :root) — the icon IS the orb.
const C1 = [0xe8, 0x26, 0x3b]; // --c1
const C2 = [0xff, 0x4d, 0x2e]; // --c2
const C3 = [0xff, 0x7a, 0x2f]; // --c3
const C4 = [0xff, 0xb5, 0x47]; // --c4
const DEEP = [0xb3, 0x12, 0x2e]; // the conic's deep-red stop
const GLOW = [0xff, 0x6b, 0x2c]; // --accent
const HILITE = [255, 255, 255];
const SHADE = [60, 0, 0];

/** conic-gradient(from 0deg, c1, c2, c4, c3, #b3122e, c1) — north start, CW. */
const CONIC_STOPS = [
  [0.0, C1],
  [0.2, C2],
  [0.4, C4],
  [0.6, C3],
  [0.8, DEEP],
  [1.0, C1],
];

function conic(t) {
  for (let i = 1; i < CONIC_STOPS.length; i++) {
    const [p1, c1] = CONIC_STOPS[i];
    if (t <= p1) {
      const [p0, c0] = CONIC_STOPS[i - 1];
      const u = (t - p0) / (p1 - p0);
      return [
        c0[0] + (c1[0] - c0[0]) * u,
        c0[1] + (c1[1] - c0[1]) * u,
        c0[2] + (c1[2] - c0[2]) * u,
      ];
    }
  }
  return C1;
}

/** "over"-composite `src` at alpha `a` onto opaque `dst`. */
function over(dst, src, a) {
  return [
    dst[0] * (1 - a) + src[0] * a,
    dst[1] * (1 - a) + src[1] * a,
    dst[2] * (1 - a) + src[2] * a,
  ];
}

/** One supersample: returns premultiplied [r,g,b,a]. */
function sample(px, py, size, r, margin) {
  const c = size / 2;
  const dx = px - c;
  const dy = py - c;
  const d = Math.hypot(dx, dy);
  if (d <= r) {
    // Frozen conic ember field: north = 0deg, clockwise (CSS conic-gradient).
    let t = Math.atan2(dx, -dy) / (2 * Math.PI);
    if (t < 0) t += 1;
    let col = conic(t);
    // Bottom-right shade (orb ::after, second radial).
    const dShade = Math.hypot(px - 0.75 * size, py - 0.85 * size);
    const aShade = 0.35 * Math.max(0, 1 - dShade / (0.55 * size));
    if (aShade > 0) col = over(col, SHADE, aShade);
    // Top-left highlight (orb ::after, first radial).
    const dHi = Math.hypot(px - 0.28 * size, py - 0.22 * size);
    const aHi = 0.55 * Math.max(0, 1 - dHi / (0.45 * size));
    if (aHi > 0) col = over(col, HILITE, aHi);
    // Inner hairline: inset 0 0 0 1px rgba(255,255,255,.14), scaled.
    const rimW = Math.max(1, size / 16);
    if (r - d < rimW) col = over(col, HILITE, 0.14 * ((rimW - (r - d)) / rimW));
    return [col[0], col[1], col[2], 1];
  }
  if (d <= r + margin) {
    // Outer glow: orange halo decaying away from the rim.
    const u = (d - r) / margin;
    const a = 0.55 * Math.pow(1 - u, 1.8);
    return [GLOW[0] * a, GLOW[1] * a, GLOW[2] * a, a];
  }
  return [0, 0, 0, 0];
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
            margin,
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
