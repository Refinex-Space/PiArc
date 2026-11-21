#!/usr/bin/env node
// Exports the menu-bar and tray icons from design/brand/mark.svg (T35):
//
// - trayTemplate.png (16 px) and trayTemplate@2x.png (32 px): black with transparency, the
//   macOS template image (the system tints it for light and dark menu bars);
// - tray-light.ico (black glyph, for a light taskbar) and tray-dark.ico (white glyph, for a dark
//   one): Windows tray icons with PNG entries of 16, 20, 24, 32, 40 and 48 px.
//
// The mark is drawn with axis-aligned paths (M, H, V, Z), so this rasterizes it directly with
// 16 × 16 samples per pixel; no image library is needed. The glyph is scaled to the icon
// with a margin of 1/16 of its side. `--check` compares with the committed files instead of
// writing them.
//
// Usage: node scripts/dev/export-tray-icons.mjs [--check]
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

import { repoRoot } from '../lib/repo.mjs';

const BRAND = path.join(repoRoot, 'design', 'brand');
const SAMPLES = 16;

/**
 * The mark's paths: each a list of closed polygons (even-odd inside a path; the paths are
 * united).
 * @param {string} svg
 * @returns {{ x: number, y: number }[][][]}
 */
export function parseMark(svg) {
  const paths = [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1] ?? '');
  return paths.map((d) => {
    /** @type {{ x: number, y: number }[][]} */
    const polygons = [];
    /** @type {{ x: number, y: number }[]} */
    let current = [];
    let x = 0;
    let y = 0;
    const tokens = d.match(/[MHVZ]|-?\d*\.?\d+/g) ?? [];
    let command = '';
    for (const token of tokens) {
      if (/^[MHVZ]$/.test(token)) {
        command = token;
        if (command === 'Z') {
          polygons.push(current);
          current = [];
        }
        continue;
      }
      const value = Number(token);
      if (!Number.isFinite(value)) throw new Error(`unexpected path token ${token}`);
      if (command === 'M') {
        if (current.length === 0) {
          x = value;
          command = 'M2';
        }
        continue;
      }
      if (command === 'M2') {
        y = value;
        current.push({ x, y });
        command = '';
        continue;
      }
      if (command === 'H') x = value;
      else if (command === 'V') y = value;
      else throw new Error(`unsupported path command near ${token}`);
      current.push({ x, y });
    }
    if (current.length > 0) polygons.push(current);
    return polygons;
  });
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
 * Coverage (0–255) of each pixel of a `size` × `size` icon.
 * @param {{ x: number, y: number }[][][]} mark
 * @param {number} size
 */
export function rasterize(mark, size) {
  const points = mark.flat(2);
  const minX = Math.min(...points.map((p) => p.x));
  const maxX = Math.max(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  const maxY = Math.max(...points.map((p) => p.y));
  const margin = size / 16;
  const scale = (size - 2 * margin) / Math.max(maxX - minX, maxY - minY);
  const offsetX = (size - (maxX - minX) * scale) / 2;
  const offsetY = (size - (maxY - minY) * scale) / 2;
  const alpha = new Uint8Array(size * size);
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      let hits = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const px = minX + (col + (sx + 0.5) / SAMPLES - offsetX) / scale;
          const py = minY + (row + (sy + 0.5) / SAMPLES - offsetY) / scale;
          if (mark.some((polygons) => polygons.filter((p) => crossings(p, px, py)).length % 2)) {
            hits += 1;
          }
        }
      }
      alpha[row * size + col] = Math.round((hits * 255) / (SAMPLES * SAMPLES));
    }
  }
  return alpha;
}

/** @param {Buffer} data */
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * @param {string} type
 * @param {Buffer} data
 */
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * An RGBA PNG of one color with `alpha`.
 * @param {Uint8Array} alpha
 * @param {number} size
 * @param {number} gray 0 (black) or 255 (white)
 */
export function png(alpha, size, gray) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let row = 0; row < size; row += 1) {
    const base = row * (size * 4 + 1);
    for (let col = 0; col < size; col += 1) {
      const at = base + 1 + col * 4;
      raw[at] = gray;
      raw[at + 1] = gray;
      raw[at + 2] = gray;
      raw[at + 3] = alpha[row * size + col] ?? 0;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * An ICO file holding PNG images.
 * @param {{ size: number, data: Buffer }[]} images
 */
export function ico(images) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });
  return Buffer.concat([head, ...entries, ...images.map((i) => i.data)]);
}

/** The files to write, by name. */
export function trayIcons() {
  const mark = parseMark(readFileSync(path.join(BRAND, 'mark.svg'), 'utf8'));
  const sizes = new Map([16, 20, 24, 32, 40, 48].map((size) => [size, rasterize(mark, size)]));
  /** @param {number} size */
  const alpha = (size) => {
    const found = sizes.get(size);
    if (found === undefined) throw new Error(`no raster of ${String(size)} px`);
    return found;
  };
  /** @param {number} gray */
  const windows = (gray) =>
    ico([...sizes.keys()].map((size) => ({ size, data: png(alpha(size), size, gray) })));
  return new Map([
    ['trayTemplate.png', png(alpha(16), 16, 0)],
    ['trayTemplate@2x.png', png(alpha(32), 32, 0)],
    ['tray-light.ico', windows(0)],
    ['tray-dark.ico', windows(255)],
  ]);
}

function main() {
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const [name, data] of trayIcons()) {
    const file = path.join(BRAND, name);
    if (check) {
      let current = Buffer.alloc(0);
      try {
        current = readFileSync(file);
      } catch {
        // Missing: reported below.
      }
      if (!current.equals(data)) {
        console.error(`${name} differs from mark.svg's export`);
        stale += 1;
      }
    } else {
      writeFileSync(file, data);
      console.log(`wrote design/brand/${name} (${String(data.length)} bytes)`);
    }
  }
  if (stale > 0) process.exit(1);
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.join(repoRoot, 'scripts', 'dev', 'export-tray-icons.mjs')
) {
  main();
}
