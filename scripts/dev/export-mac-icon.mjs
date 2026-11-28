#!/usr/bin/env node
// Exports the macOS app icon from design/brand/mark.svg: design/brand/icon.iconset/ (16 to
// 1024 px) and, on macOS, design/brand/icon.icns built from it with `iconutil`.
//
// macOS draws every Dock and Finder icon on a 1024 canvas whose rounded square is 824 px wide
// with a transparent margin of 100 px (room for the shadow). A square that fills the canvas
// shows larger than its neighbours in the Dock, so this icon keeps that grid. design/brand/
// icon.svg stays full-bleed for Windows, where the .ico has no such margin. The artwork is
// icon.svg's, scaled by 824 / 1024 about the centre: a white square with corner radius
// 224 × 824 / 1024 and the mark at 1.28 × 824 / 1024, plus a soft shadow below.
//
// Like export-tray-icons.mjs this rasterizes directly (the mark is axis-aligned polygons, the
// square an analytic rounded rectangle), so no image library is needed. `--check` compares
// the iconset (and, on macOS, the .icns) with the committed files instead of writing them.
//
// Usage: node scripts/dev/export-mac-icon.mjs [--check]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

import { repoRoot } from '../lib/repo.mjs';
import { chunk, parseMark } from './export-tray-icons.mjs';

const BRAND = path.join(repoRoot, 'design', 'brand');
const ICONSET = path.join(BRAND, 'icon.iconset');

/** Geometry on the 1024 canvas. */
const CANVAS = 1024;
const SHRINK = 824 / 1024;
const BODY = { x: 100, y: 100, size: 824, radius: 224 * SHRINK };
/** The mark's scale and offset (icon.svg draws it at 1.28 on the full canvas). */
const MARK_SCALE = 1.28 * SHRINK;
const MARK_OFFSET = (CANVAS * (1 - SHRINK)) / 2;
/** The shadow: offset down, Gaussian blur and opacity, on the 1024 canvas. */
const SHADOW = { dy: 10, sigma: 10, opacity: 0.3 };

/** The iconset's files: name and pixel size. */
export const ICONSET_FILES = /** @type {const} */ ([
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
]);

/**
 * Whether (x, y) on the 1024 canvas is inside the rounded square.
 * @param {number} x
 * @param {number} y
 */
function inBody(x, y) {
  const { x: left, y: top, size, radius } = BODY;
  if (x < left || y < top || x > left + size || y > top + size) return false;
  const cx = Math.min(Math.max(x, left + radius), left + size - radius);
  const cy = Math.min(Math.max(y, top + radius), top + size - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

/**
 * @param {{ x: number, y: number }[]} polygon
 * @param {number} px
 * @param {number} py
 */
function crossings(polygon, px, py) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (a === undefined || b === undefined) continue;
    if (a.y > py !== b.y > py && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Coverage (0–1) of the rounded square and of the mark for each pixel of a `size` icon.
 * @param {{ x: number, y: number }[][][]} mark
 * @param {number} size
 */
function coverage(mark, size) {
  const samples = size >= 256 ? 4 : 8;
  const unit = CANVAS / size;
  const points = mark.flat(2);
  const markMin = MARK_OFFSET + Math.min(...points.map((p) => p.x)) * MARK_SCALE;
  const markMax = MARK_OFFSET + Math.max(...points.map((p) => p.x)) * MARK_SCALE;
  const markTop = MARK_OFFSET + Math.min(...points.map((p) => p.y)) * MARK_SCALE;
  const markBottom = MARK_OFFSET + Math.max(...points.map((p) => p.y)) * MARK_SCALE;
  const body = new Float32Array(size * size);
  const glyph = new Float32Array(size * size);
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      let bodyHits = 0;
      let glyphHits = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const x = (col + (sx + 0.5) / samples) * unit;
          const y = (row + (sy + 0.5) / samples) * unit;
          if (!inBody(x, y)) continue;
          bodyHits += 1;
          if (x < markMin || x > markMax || y < markTop || y > markBottom) continue;
          const mx = (x - MARK_OFFSET) / MARK_SCALE;
          const my = (y - MARK_OFFSET) / MARK_SCALE;
          if (mark.some((polygons) => polygons.filter((p) => crossings(p, mx, my)).length % 2)) {
            glyphHits += 1;
          }
        }
      }
      body[row * size + col] = bodyHits / samples ** 2;
      glyph[row * size + col] = glyphHits / samples ** 2;
    }
  }
  return { body, glyph };
}

/**
 * The body's alpha blurred, shifted down and faded: the shadow under the square.
 * @param {Float32Array} body
 * @param {number} size
 */
function shadow(body, size) {
  const scale = size / CANVAS;
  const sigma = SHADOW.sigma * scale;
  const radius = Math.ceil(sigma * 3);
  const kernel = Array.from({ length: 2 * radius + 1 }, (_, i) =>
    Math.exp(-((i - radius) ** 2) / (2 * sigma * sigma)),
  );
  const total = kernel.reduce((sum, k) => sum + k, 0);
  const weights = kernel.map((k) => k / total);
  /** @param {Float32Array} from @param {boolean} vertical */
  const pass = (from, vertical) => {
    const to = new Float32Array(size * size);
    for (let row = 0; row < size; row += 1) {
      for (let col = 0; col < size; col += 1) {
        let sum = 0;
        for (let k = -radius; k <= radius; k += 1) {
          const r = vertical ? row + k : row;
          const c = vertical ? col : col + k;
          if (r < 0 || c < 0 || r >= size || c >= size) continue;
          sum += (from[r * size + c] ?? 0) * (weights[k + radius] ?? 0);
        }
        to[row * size + col] = sum;
      }
    }
    return to;
  };
  const blurred = sigma < 0.5 ? body : pass(pass(body, false), true);
  const dy = Math.round(SHADOW.dy * scale);
  const out = new Float32Array(size * size);
  for (let row = dy; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      out[row * size + col] = (blurred[(row - dy) * size + col] ?? 0) * SHADOW.opacity;
    }
  }
  return out;
}

/**
 * One iconset image: shadow (black), square (white), mark (black), composited.
 * @param {{ x: number, y: number }[][][]} mark
 * @param {number} size
 */
export function macIcon(mark, size) {
  const { body, glyph } = coverage(mark, size);
  const under = shadow(body, size);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let row = 0; row < size; row += 1) {
    const base = row * (size * 4 + 1);
    for (let col = 0; col < size; col += 1) {
      const i = row * size + col;
      const b = body[i] ?? 0;
      const g = glyph[i] ?? 0;
      // Premultiplied "over": black shadow, then the white square, then the black mark.
      let alpha = under[i] ?? 0;
      let light = 0;
      light = b + light * (1 - b);
      alpha = b + alpha * (1 - b);
      light = light * (1 - g);
      alpha = g + alpha * (1 - g);
      const gray = alpha > 0 ? Math.round((light / alpha) * 255) : 0;
      const at = base + 1 + col * 4;
      raw[at] = gray;
      raw[at + 1] = gray;
      raw[at + 2] = gray;
      raw[at + 3] = Math.round(alpha * 255);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The iconset's files, by name. */
export function iconsetFiles() {
  const mark = parseMark(readFileSync(path.join(BRAND, 'mark.svg'), 'utf8'));
  /** @type {Map<number, Buffer>} */
  const bySize = new Map();
  return new Map(
    ICONSET_FILES.map(([name, size]) => {
      let data = bySize.get(size);
      if (data === undefined) {
        data = macIcon(mark, size);
        bySize.set(size, data);
      }
      return [name, data];
    }),
  );
}

/**
 * `iconutil -c icns` of `iconset` into `output`; false when iconutil is missing (not macOS).
 * @param {string} iconset
 * @param {string} output
 */
function iconutil(iconset, output) {
  if (process.platform !== 'darwin') return false;
  const result = spawnSync('iconutil', ['-c', 'icns', iconset, '-o', output], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (result.status !== 0) throw new Error(`iconutil failed (${String(result.status)})`);
  return true;
}

function main() {
  const check = process.argv.includes('--check');
  const files = iconsetFiles();
  let stale = 0;
  if (check) {
    for (const [name, data] of files) {
      let current = Buffer.alloc(0);
      try {
        current = readFileSync(path.join(ICONSET, name));
      } catch {
        // Missing: reported below.
      }
      if (!current.equals(data)) {
        console.error(`icon.iconset/${name} differs from mark.svg's export`);
        stale += 1;
      }
    }
    const scratch = mkdtempSync(path.join(tmpdir(), 'piarc-icns-'));
    try {
      const icns = path.join(scratch, 'icon.icns');
      if (iconutil(ICONSET, icns)) {
        if (!readFileSync(icns).equals(readFileSync(path.join(BRAND, 'icon.icns')))) {
          console.error('icon.icns differs from icon.iconset/');
          stale += 1;
        }
      } else {
        console.log('icon.icns not checked: iconutil runs only on macOS');
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  } else {
    for (const [name, data] of files) {
      writeFileSync(path.join(ICONSET, name), data);
      console.log(`wrote design/brand/icon.iconset/${name} (${String(data.length)} bytes)`);
    }
    if (iconutil(ICONSET, path.join(BRAND, 'icon.icns'))) {
      console.log('wrote design/brand/icon.icns');
    } else {
      console.log('icon.icns not written: iconutil runs only on macOS; run this there');
    }
  }
  if (stale > 0) process.exit(1);
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.join(repoRoot, 'scripts', 'dev', 'export-mac-icon.mjs')
) {
  main();
}
