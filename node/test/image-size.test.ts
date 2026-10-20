import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';

import { imageSizeFromHeader } from '../src/shared/image-size.ts';

/** Builds a minimal but structurally valid PNG with the requested dimensions. */
function makePng(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  const ihdr = chunk('IHDR', header);
  const idat = chunk('IDAT', zlib.deflateSync(Buffer.alloc(width * height * 4)));
  return Buffer.concat([signature, ihdr, idat, chunk('IEND', Buffer.alloc(0))]);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Minimal baseline JPEG with a single SOF0 frame header. */
function makeJpeg(width: number, height: number): Buffer {
  const sof = Buffer.from([
    0xff, 0xc0,
    0x00, 0x11, // segment length 17
    0x08, // sample precision
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, // components
    0x01, 0x22, 0x00,
    0x02, 0x11, 0x01,
    0x03, 0x11, 0x01,
  ]);
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00,
    0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, sos, Buffer.from([0xff, 0xd9])]);
}

test('reads PNG dimensions from a real generated file', () => {
  assert.deepEqual(imageSizeFromHeader(makePng(640, 480)), { width: 640, height: 480 });
  assert.deepEqual(imageSizeFromHeader(makePng(1, 1)), { width: 1, height: 1 });
});

test('reads JPEG dimensions from a synthetic frame header', () => {
  assert.deepEqual(imageSizeFromHeader(makeJpeg(1920, 1080)), { width: 1920, height: 1080 });
});

test('reads BMP, GIF and WebP container dimensions', () => {
  const bmp = Buffer.alloc(54);
  bmp.write('BM', 0, 'ascii');
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14); // BITMAPINFOHEADER
  bmp.writeInt32LE(800, 18);
  bmp.writeInt32LE(-600, 22); // top-down bitmaps use a negative height
  assert.deepEqual(imageSizeFromHeader(bmp), { width: 800, height: 600 });

  const gif = Buffer.alloc(13);
  gif.write('GIF89a', 0, 'ascii');
  gif.writeUInt16LE(320, 6);
  gif.writeUInt16LE(200, 8);
  assert.deepEqual(imageSizeFromHeader(gif), { width: 320, height: 200 });

  const webp = Buffer.alloc(30);
  webp.write('RIFF', 0, 'ascii');
  webp.writeUInt32LE(22, 4);
  webp.write('WEBP', 8, 'ascii');
  webp.write('VP8X', 12, 'ascii');
  webp.writeUInt32LE(10, 16);
  webp[24] = 0xff; // 256 - 1
  webp[25] = 0x03;
  webp[26] = 0x00;
  webp[27] = 0xff;
  webp[28] = 0x01;
  webp[29] = 0x00;
  assert.deepEqual(imageSizeFromHeader(webp), { width: 1024, height: 512 });
});

test('returns null for unsupported or truncated data instead of throwing', () => {
  assert.equal(imageSizeFromHeader(Buffer.from('not an image at all')), null);
  assert.equal(imageSizeFromHeader(Buffer.alloc(0)), null);
  assert.equal(imageSizeFromHeader(makePng(4, 4).subarray(0, 12)), null, 'truncated PNG header');
  assert.equal(imageSizeFromHeader(Buffer.from([0xff, 0xd8, 0xff, 0xc0])), null, 'truncated JPEG');
});

test('sniffs the dimensions of the repository sample images', async () => {
  const imagesDir = path.resolve(import.meta.dirname, '..', '..', 'images');
  let entries: string[];
  try {
    entries = await fs.readdir(imagesDir);
  } catch {
    return; // sample images are optional
  }

  const jpegs = entries.filter((name) => name.toLowerCase().endsWith('.jpg'));
  if (jpegs.length === 0) return;

  for (const name of jpegs) {
    const buffer = await fs.readFile(path.join(imagesDir, name));
    const size = imageSizeFromHeader(buffer);
    assert.ok(size !== null, `${name} should be recognised as a JPEG`);
    assert.ok(size.width > 0 && size.height > 0, `${name} should have positive dimensions`);
  }
});
