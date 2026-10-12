#!/usr/bin/env node
// Generates the extension's toolbar/manifest icons: the send button's glossy
// half-sphere, frozen into a full-bleed ball — radial body, specular hotspot,
// warm bottom rim — rasterized per size with 4x4 supersampling and written out
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

// --accent, straight out of styles.css :root.
const ACCENT = [0xe3, 0x52, 0x1b];

/** The send button's radial body: colour by distance from the light, which
 *  sits at 50%/30% like the CSS `circle at 50% 30%`. */
const RAMP = [
  [0.0, [0xff, 0x8a, 0x52]],
  [0.46, ACCENT],
  [0.82, [0xa6, 0x3c, 0x11]],
  [1.0, [0x8a, 0x2f, 0x0b]],
];

/** "over"-composite `src` at alpha `a` onto opaque `dst`. */
function over(dst, src, a) {
  return [
    dst[0] * (1 - a) + src[0] * a,
    dst[1] * (1 - a) + src[1] * a,
    dst[2] * (1 - a) + src[2] * a,
  ];
}

function rampColor(t) {
  if (t <= 0) return RAMP[0][1];
  for (let i = 1; i < RAMP.length; i++) {
    if (t <= RAMP[i][0]) {
      const [p0, c0] = RAMP[i - 1];
      const [p1, c1] = RAMP[i];
      const u = (t - p0) / (p1 - p0);
      return [c0[0] + (c1[0] - c0[0]) * u, c0[1] + (c1[1] - c0[1]) * u, c0[2] + (c1[2] - c0[2]) * u];
    }
  }
  return RAMP[RAMP.length - 1][1];
}

/** One supersample: returns premultiplied [r,g,b,a]. */
function sample(px, py, size, r) {
  const c = size / 2;
  const d = Math.hypot(px - c, py - c);
  if (d > r) return [0, 0, 0, 0];
  // Light centre and the farthest-corner distance that ends the CSS gradient.
  const lx = c;
  const ly = size * 0.3;
  const span = size * 0.86;
  let col = rampColor(Math.hypot(px - lx, py - ly) / span);
  // Specular hotspot: a soft white ellipse off-centre top-left, rotated like
  // the button's ::before, fading to nothing at its edge.
  const ex = px - size * 0.36;
  const ey = py - size * 0.235;
  const cos = Math.cos(-0.38);
  const sin = Math.sin(-0.38);
  const rx = (ex * cos - ey * sin) / (size * 0.19);
  const ry = (ex * sin + ey * cos) / (size * 0.11);
  const e = Math.hypot(rx, ry);
  if (e < 1) col = over(col, [255, 255, 255], 0.95 * Math.pow(1 - e, 1.3));
  // Warm rim bounce along the bottom limb (the button's inset rim light).
  const b = 1 - Math.hypot(px - c, py - size * 0.9) / (size * 0.3);
  if (b > 0) col = over(col, [255, 150, 100], 0.3 * b * b);
  return [col[0], col[1], col[2], 1];
}

function rasterize(size) {
  const r = size / 2; // full-bleed ball: touches every edge midpoint
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
