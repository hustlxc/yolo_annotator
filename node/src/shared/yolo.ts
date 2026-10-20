/**
 * YOLO annotation math and text (de)serialisation.
 *
 * The on-disk format is the classic darknet/YOLOv5 label file:
 *
 *     <class-id> <x-center> <y-center> <width> <height>
 *
 * with all four numbers normalised to 0..1 relative to the image size. This
 * module is deliberately free of any I/O so it can be unit-tested and reused by
 * both the CLI and the HTTP layer.
 */

/** A box in *pixel* coordinates: top-left origin, x1<x2, y1<y2. */
export type PixelBox = {
  classId: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

/** A box in the normalised YOLO representation. */
export type YoloBox = {
  classId: number;
  /** Centre X, normalised 0..1. */
  x: number;
  /** Centre Y, normalised 0..1. */
  y: number;
  /** Width, normalised 0..1. */
  w: number;
  /** Height, normalised 0..1. */
  h: number;
};

export type ImageSize = { width: number; height: number };

/** Number of decimals written per coordinate (darknet uses six). */
export const COORDINATE_PRECISION = 6;

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Rounds to `COORDINATE_PRECISION` decimals and normalises `-0` to `0`. */
export function roundCoordinate(value: number): number {
  const factor = 10 ** COORDINATE_PRECISION;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Converts a pixel box to the normalised YOLO representation.
 * Coordinates outside the image are clamped, so a box dragged past the edge
 * still produces a legal label.
 */
export function pixelToYolo(box: PixelBox, size: ImageSize): YoloBox {
  const { width, height } = size;
  if (!(width > 0) || !(height > 0)) {
    throw new Error('image size must be positive');
  }

  const x1 = clamp(Math.min(box.x1, box.x2), 0, width);
  const x2 = clamp(Math.max(box.x1, box.x2), 0, width);
  const y1 = clamp(Math.min(box.y1, box.y2), 0, height);
  const y2 = clamp(Math.max(box.y1, box.y2), 0, height);

  return {
    classId: Math.trunc(box.classId),
    x: (x1 + x2) / 2 / width,
    y: (y1 + y2) / 2 / height,
    w: (x2 - x1) / width,
    h: (y2 - y1) / height,
  };
}

/**
 * Converts a normalised YOLO box back to integer pixel coordinates.
 * The result is clamped to the image and always has x2 >= x1, y2 >= y1.
 */
export function yoloToPixel(box: YoloBox, size: ImageSize): PixelBox {
  const { width, height } = size;
  const x1 = Math.floor(clamp(box.x - box.w / 2, 0, 1) * width);
  const y1 = Math.floor(clamp(box.y - box.h / 2, 0, 1) * height);
  const x2 = Math.ceil(clamp(box.x + box.w / 2, 0, 1) * width);
  const y2 = Math.ceil(clamp(box.y + box.h / 2, 0, 1) * height);

  return {
    classId: Math.trunc(box.classId),
    x1: Math.min(x1, width),
    y1: Math.min(y1, height),
    x2: Math.min(x2, width),
    y2: Math.min(y2, height),
  };
}

/** Formats one box exactly like darknet would. */
export function formatYoloLine(box: YoloBox): string {
  const id = Math.trunc(box.classId);
  return [
    String(id),
    roundCoordinate(box.x).toFixed(COORDINATE_PRECISION),
    roundCoordinate(box.y).toFixed(COORDINATE_PRECISION),
    roundCoordinate(box.w).toFixed(COORDINATE_PRECISION),
    roundCoordinate(box.h).toFixed(COORDINATE_PRECISION),
  ].join(' ');
}

export type AnnotationWarning = { line: number; reason: string; text: string };

export type ParsedAnnotations = {
  boxes: YoloBox[];
  warnings: AnnotationWarning[];
};

/**
 * Parses label-file text.
 *
 * Lenient like darknet: extra columns (`confidence`) are ignored, blank lines
 * are skipped and `#` comments are allowed. Anything unusable is reported as a
 * warning rather than throwing, so one bad line never hides a whole file.
 */
export function parseAnnotationText(content: string, classCount?: number): ParsedAnnotations {
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const boxes: YoloBox[] = [];
  const warnings: AnnotationWarning[] = [];

  const lines = text.split(/\r\n|\r|\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    const lineNumber = index + 1;
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    const parts = line.split(/\s+/);
    if (parts.length < 5) {
      warnings.push({ line: lineNumber, reason: 'expected at least 5 columns', text: raw });
      continue;
    }

    const classId = Number(parts[0]);
    const x = Number(parts[1]);
    const y = Number(parts[2]);
    const w = Number(parts[3]);
    const h = Number(parts[4]);

    if (!Number.isInteger(classId) || classId < 0) {
      warnings.push({ line: lineNumber, reason: 'class id must be a non-negative integer', text: raw });
      continue;
    }
    if (classCount !== undefined && classId >= classCount) {
      warnings.push({
        line: lineNumber,
        reason: `class id ${classId} is outside the ${classCount} known classes`,
        text: raw,
      });
      continue;
    }
    if (![x, y, w, h].every((value) => Number.isFinite(value))) {
      warnings.push({ line: lineNumber, reason: 'coordinates must be finite numbers', text: raw });
      continue;
    }
    if (w <= 0 || h <= 0) {
      warnings.push({ line: lineNumber, reason: 'width and height must be greater than zero', text: raw });
      continue;
    }
    if (x < 0 || x > 1 || y < 0 || y > 1) {
      warnings.push({ line: lineNumber, reason: 'centre coordinates must be within 0..1', text: raw });
      continue;
    }

    boxes.push({ classId, x, y, w, h });
  }

  return { boxes, warnings };
}

/** Serialises boxes into label-file text; an empty list yields an empty file. */
export function formatAnnotationText(boxes: readonly YoloBox[]): string {
  if (boxes.length === 0) return '';
  return `${boxes.map(formatYoloLine).join('\n')}\n`;
}

/**
 * Validates untrusted box data coming from the browser.
 * Throws with a human-readable reason on the first offender.
 */
export function validateBoxes(input: unknown, classCount: number): YoloBox[] {
  if (!Array.isArray(input)) {
    throw new Error('"boxes" must be an array');
  }

  return input.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`boxes[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const classId = Number(record['classId']);
    const x = Number(record['x']);
    const y = Number(record['y']);
    const w = Number(record['w']);
    const h = Number(record['h']);

    if (!Number.isInteger(classId) || classId < 0 || classId >= classCount) {
      throw new Error(`boxes[${index}].classId must be an integer in 0..${classCount - 1}`);
    }
    if (![x, y, w, h].every((value) => Number.isFinite(value))) {
      throw new Error(`boxes[${index}] must have finite x, y, w, h`);
    }
    if (w <= 0 || h <= 0) {
      throw new Error(`boxes[${index}] must have positive w and h`);
    }
    if (x < -0.001 || x > 1.001 || y < -0.001 || y > 1.001) {
      throw new Error(`boxes[${index}] centre must be within the image`);
    }

    return {
      classId,
      x: clamp(x, 0, 1),
      y: clamp(y, 0, 1),
      w: clamp(w, 0, 1),
      h: clamp(h, 0, 1),
    };
  });
}
