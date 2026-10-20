#!/usr/bin/env node
/**
 * Generates the application icon.
 *
 * The icon is *generated*, not committed: the repository is source code only, and
 * a 50 KB binary that can be reproduced from forty lines is not source. Both
 * packaging paths call this, so the app still ships with a real icon.
 *
 *   node scripts/make-icon.mjs [--out build-resources]
 *
 * Produces:
 *   icon.png    1024x1024, used directly by the Windows installer build and as
 *               the input electron-builder converts for macOS
 *   icon.icns   macOS only, assembled with the system `iconutil` when available
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

const run = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Canvas size; 1024 is the largest size iconutil accepts. */
const SIZE = 1024;
const BACKGROUND = [17, 24, 39];      // matches the UI background
const ACCENT = [74, 222, 128];        // the green used for bounding boxes

/* ------------------------------------------------------------------ drawing */

/** True inside a rounded rectangle inset by `margin` with corner radius `radius`. */
function insideRoundedRect(x, y, margin, radius) {
  const x0 = margin;
  const y0 = margin;
  const x1 = SIZE - 1 - margin;
  const y1 = SIZE - 1 - margin;
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;

  // Only the four corners need the circle test.
  const nearLeft = x < x0 + radius;
  const nearRight = x > x1 - radius;
  const nearTop = y < y0 + radius;
  const nearBottom = y > y1 - radius;
  if (!((nearLeft || nearRight) && (nearTop || nearBottom))) return true;

  const cx = nearLeft ? x0 + radius : x1 - radius;
  const cy = nearTop ? y0 + radius : y1 - radius;
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

/** Paints a rectangle outline (or a filled one) into an RGBA pixel buffer. */
function paintRect(pixels, x0, y0, x1, y1, thickness, colour, filled = false) {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const edge =
        x < x0 + thickness || x >= x1 - thickness || y < y0 + thickness || y >= y1 - thickness;
      if (!filled && !edge) continue;
      const at = (y * SIZE + x) * 4;
      pixels[at] = colour[0];
      pixels[at + 1] = colour[1];
      pixels[at + 2] = colour[2];
      pixels[at + 3] = 255;
    }
  }
}

/** Builds the RGBA image: a dark rounded square with a bounding-box motif. */
function renderPixels() {
  const pixels = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      if (!insideRoundedRect(x, y, 40, 180)) continue; // transparent outside
      const at = (y * SIZE + x) * 4;
      pixels[at] = BACKGROUND[0];
      pixels[at + 1] = BACKGROUND[1];
      pixels[at + 2] = BACKGROUND[2];
      pixels[at + 3] = 255;
    }
  }
  paintRect(pixels, 250, 300, 780, 730, 34, ACCENT);          // the RoI outline
  paintRect(pixels, 370, 430, 560, 560, 0, ACCENT, true);      // a filled inner box
  return pixels;
}

/* --------------------------------------------------------------- PNG writing */

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header[8] = 8;  // bit depth
  header[9] = 6;  // truecolour with alpha

  // Each scanline is prefixed with filter type 0 (none).
  const stride = SIZE * 4;
  const raw = Buffer.alloc((stride + 1) * SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -------------------------------------------------------------------- main */

async function main() {
  const outIndex = process.argv.indexOf('--out');
  const outDir = path.resolve(outIndex >= 0 ? (process.argv[outIndex + 1] ?? '.') : path.join(projectRoot, 'build-resources'));
  await fs.mkdir(outDir, { recursive: true });

  const pixels = renderPixels();
  const pngPath = path.join(outDir, 'icon.png');
  await fs.writeFile(pngPath, encodePng(pixels));
  process.stdout.write(`icon: ${path.relative(process.cwd(), pngPath)}\n`);

  /*
   * macOS gets a real .icns assembled from the PNG. On other platforms there is
   * no iconutil, and electron-builder converts icon.png itself when building for
   * macOS, so this is an optimisation rather than a requirement.
   */
  if (process.platform === 'darwin') {
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'yolo-icon-'));
    try {
      const iconset = path.join(work, 'icon.iconset');
      await fs.mkdir(iconset, { recursive: true });
      const sizes = [
        [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'],
        [32, 'icon_32x32.png'], [64, 'icon_32x32@2x.png'],
        [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
        [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
        [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png'],
      ];
      for (const [size, name] of sizes) {
        await run('sips', ['-z', String(size), String(size), pngPath, '--out', path.join(iconset, name)]);
      }
      const icnsPath = path.join(outDir, 'icon.icns');
      await run('iconutil', ['-c', 'icns', iconset, '-o', icnsPath]);
      process.stdout.write(`icon: ${path.relative(process.cwd(), icnsPath)}\n`);
    } catch (error) {
      process.stdout.write(
        `icon: could not build .icns (${error instanceof Error ? error.message.split('\n')[0] : String(error)}); ` +
          'electron-builder will convert icon.png\n',
      );
    } finally {
      await fs.rm(work, { recursive: true, force: true });
    }
  }
  return 0;
}

main().then(
  (code) => {
    if (code !== 0) process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`make-icon failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
