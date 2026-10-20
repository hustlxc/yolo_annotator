/**
 * Minimal, dependency-free image size sniffing.
 *
 * The annotator already ships the picture to the browser, so all this needs to
 * do is report width/height *before* the image decodes. It reads a small header
 * slice instead of the whole file, which matters for multi-megabyte photos.
 *
 * Supported: JPEG, PNG, GIF, BMP, WebP, TIFF.
 */

type Size = { width: number; height: number };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Start-of-frame markers that carry the real frame size. */
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function matchesSignature(buffer: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (buffer.length < offset + signature.length) return false;
  return signature.every((byte, index) => buffer[offset + index] === byte);
}

function readUInt16(view: DataView, offset: number, littleEndian: boolean): number {
  return view.getUint16(offset, littleEndian);
}

function parsePng(buffer: Uint8Array): Size | null {
  if (!matchesSignature(buffer, PNG_SIGNATURE)) return null;
  if (buffer.length < 24) return null;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function parseGif(buffer: Uint8Array): Size | null {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (buffer.length < 10) return null;
  if (!(matchesSignature(buffer, [0x47, 0x49, 0x46]))) return null;
  return { width: readUInt16(view, 6, true), height: readUInt16(view, 8, true) };
}

function parseBmp(buffer: Uint8Array): Size | null {
  if (!matchesSignature(buffer, [0x42, 0x4d])) return null;
  if (buffer.length < 26) return null;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const headerSize = view.getUint32(14, true);
  if (headerSize === 12) {
    // BITMAPCOREHEADER: 16-bit width/height.
    return { width: readUInt16(view, 18, true), height: readUInt16(view, 20, true) };
  }
  const width = view.getInt32(18, true);
  const height = Math.abs(view.getInt32(22, true));
  return { width, height };
}

function parseJpeg(buffer: Uint8Array): Size | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let offset = 2;

  while (offset + 3 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1; // resynchronise on padding/filler bytes
      continue;
    }
    const marker = buffer[offset + 1] as number;
    offset += 2;

    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9 || marker === 0xda) break; // end of header / start of scan
    if (offset + 2 > buffer.length) break;

    const segmentLength = view.getUint16(offset);
    if (segmentLength < 2) break;
    if (SOF_MARKERS.has(marker)) {
      if (offset + 7 > buffer.length) break;
      return { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) };
    }
    offset += segmentLength;
  }

  return null;
}

function parseWebp(buffer: Uint8Array): Size | null {
  if (buffer.length < 30) return null;
  if (!matchesSignature(buffer, [0x52, 0x49, 0x46, 0x46])) return null;
  if (!matchesSignature(buffer, [0x57, 0x45, 0x42, 0x50], 8)) return null;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const chunk = String.fromCharCode(buffer[12]!, buffer[13]!, buffer[14]!, buffer[15]!);

  if (chunk === 'VP8 ') {
    // Lossy: 3-byte start code then 14-bit dimensions.
    if (buffer.length < 30) return null;
    return {
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff,
    };
  }
  if (chunk === 'VP8L') {
    const bits = view.getUint32(21, true);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  if (chunk === 'VP8X') {
    return {
      width: (view.getUint8(24) | (view.getUint8(25) << 8) | (view.getUint8(26) << 16)) + 1,
      height: (view.getUint8(27) | (view.getUint8(28) << 8) | (view.getUint8(29) << 16)) + 1,
    };
  }
  return null;
}

function parseTiff(buffer: Uint8Array): Size | null {
  let littleEndian: boolean;
  if (matchesSignature(buffer, [0x49, 0x49, 0x2a, 0x00])) littleEndian = true;
  else if (matchesSignature(buffer, [0x4d, 0x4d, 0x00, 0x2a])) littleEndian = false;
  else return null;

  if (buffer.length < 8) return null;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const ifdOffset = view.getUint32(4, littleEndian);
  if (ifdOffset + 2 > buffer.length) return null;

  const entryCount = view.getUint16(ifdOffset, littleEndian);
  let width: number | null = null;
  let height: number | null = null;

  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = ifdOffset + 2 + index * 12;
    if (entryOffset + 12 > buffer.length) break;
    const tag = view.getUint16(entryOffset, littleEndian);
    if (tag !== 0x0100 && tag !== 0x0101) continue; // ImageWidth / ImageLength
    const type = view.getUint16(entryOffset + 2, littleEndian);
    const value = type === 3
      ? view.getUint16(entryOffset + 8, littleEndian)
      : view.getUint32(entryOffset + 8, littleEndian);
    if (tag === 0x0100) width = value;
    else height = value;
  }

  if (width === null || height === null) return null;
  return { width, height };
}

/**
 * Returns the pixel size of an image header slice, or `null` when the format is
 * unknown or the slice is truncated. Callers should treat `null` as "let the
 * browser decode it".
 */
export function imageSizeFromHeader(buffer: Uint8Array): Size | null {
  try {
    for (const parser of [parsePng, parseJpeg, parseBmp, parseGif, parseWebp, parseTiff]) {
      const size = parser(buffer);
      if (size !== null && size.width > 0 && size.height > 0) return size;
    }
  } catch {
    // A malformed header must never take the server down.
  }
  return null;
}
