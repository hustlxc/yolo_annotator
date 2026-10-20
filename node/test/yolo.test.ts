import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatAnnotationText,
  formatYoloLine,
  parseAnnotationText,
  pixelToYolo,
  roundCoordinate,
  validateBoxes,
  yoloToPixel,
} from '../src/shared/yolo.ts';

const size = { width: 1000, height: 500 };

test('pixelToYolo converts a centred box to normalised centre/width/height', () => {
  const box = pixelToYolo({ classId: 3, x1: 100, y1: 50, x2: 300, y2: 150 }, size);
  assert.deepEqual(box, { classId: 3, x: 0.2, y: 0.2, w: 0.2, h: 0.2 });
});

test('pixelToYolo normalises an inverted drag and clamps to the image', () => {
  const inverted = pixelToYolo({ classId: 0, x1: 300, y1: 150, x2: 100, y2: 50 }, size);
  assert.deepEqual(inverted, { classId: 0, x: 0.2, y: 0.2, w: 0.2, h: 0.2 });

  const clamped = pixelToYolo({ classId: 1, x1: -50, y1: -20, x2: 5000, y2: 900 }, size);
  assert.deepEqual(clamped, { classId: 1, x: 0.5, y: 0.5, w: 1, h: 1 });
});

test('pixelToYolo rejects a degenerate image size', () => {
  assert.throws(() => pixelToYolo({ classId: 0, x1: 0, y1: 0, x2: 1, y2: 1 }, { width: 0, height: 10 }), /positive/);
});

test('yoloToPixel is the inverse of pixelToYolo for whole-pixel boxes', () => {
  const original = { classId: 2, x1: 120, y1: 40, x2: 320, y2: 190 };
  const roundTripped = yoloToPixel(pixelToYolo(original, size), size);
  assert.deepEqual(roundTripped, original);
});

test('yoloToPixel clamps out-of-range boxes into the image', () => {
  const pixel = yoloToPixel({ classId: 0, x: 0.5, y: 0.5, w: 4, h: 4 }, size);
  assert.deepEqual(pixel, { classId: 0, x1: 0, y1: 0, x2: 1000, y2: 500 });
});

test('roundCoordinate normalises -0 and rounds to six decimals', () => {
  assert.equal(Object.is(roundCoordinate(-0), 0), true);
  assert.equal(roundCoordinate(0.1234564999), 0.123456);
  assert.equal(roundCoordinate(0.12345651), 0.123457);
});

test('formatYoloLine keeps the darknet layout and precision', () => {
  assert.equal(
    formatYoloLine({ classId: 0, x: 0.2, y: 0.3, w: 0.25, h: 0.5 }),
    '0 0.200000 0.300000 0.250000 0.500000',
  );
  // The original C++ tool used stream default precision; six decimals is the
  // darknet convention and lossless enough for any real image size.
  assert.equal(
    formatYoloLine({ classId: 12, x: 1 / 3, y: 2 / 3, w: 1, h: 1 }),
    '12 0.333333 0.666667 1.000000 1.000000',
  );
});

test('formatAnnotationText ends each line with a newline; empty stays empty', () => {
  assert.equal(formatAnnotationText([]), '');
  const text = formatAnnotationText([
    { classId: 0, x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
    { classId: 1, x: 0.5, y: 0.5, w: 0.2, h: 0.2 },
  ]);
  assert.equal(text.split('\n').filter((line) => line !== '').length, 2);
  assert.ok(text.endsWith('\n'));
});

test('parseAnnotationText accepts legacy variations', () => {
  const text = [
    '# a comment',
    '',
    '0 0.5 0.5 0.2 0.2',
    '1\t0.25 0.25 0.5 0.5 0.99', // tab separated plus a trailing confidence
    '  2   0.1 0.1 0.05 0.05  ',
  ].join('\r\n');

  const parsed = parseAnnotationText(text, 3);
  assert.equal(parsed.boxes.length, 3);
  assert.deepEqual(parsed.warnings, []);
  assert.deepEqual(parsed.boxes[1], { classId: 1, x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
});

test('parseAnnotationText reports bad lines without throwing', () => {
  const text = [
    '0 0.5 0.5', // too few columns
    'x 0.5 0.5 0.2 0.2', // non-numeric class
    '0 0.5 0.5 0 0.2', // zero width
    '0 1.5 0.5 0.2 0.2', // centre outside the image
    '9 0.5 0.5 0.2 0.2', // class out of range
  ].join('\n');

  const parsed = parseAnnotationText(text, 3);
  assert.deepEqual(parsed.boxes, []);
  assert.equal(parsed.warnings.length, 5);
  assert.deepEqual(parsed.warnings.map((warning) => warning.line), [1, 2, 3, 4, 5]);
});

test('parseAnnotationText does not police class ids when no count is given', () => {
  const parsed = parseAnnotationText('42 0.5 0.5 0.2 0.2');
  assert.equal(parsed.boxes.length, 1);
  assert.deepEqual(parsed.warnings, []);
});

test('parse → format is stable (idempotent round trip)', () => {
  const source = '0 0.200000 0.300000 0.250000 0.500000\n1 0.100000 0.100000 0.050000 0.050000\n';
  const once = formatAnnotationText(parseAnnotationText(source, 2).boxes);
  assert.equal(once, source);
  assert.equal(formatAnnotationText(parseAnnotationText(once, 2).boxes), source);
});

test('validateBoxes accepts good payloads and rejects bad ones', () => {
  const good = validateBoxes([{ classId: 1, x: 0.5, y: 0.5, w: 0.2, h: 0.2 }], 3);
  assert.deepEqual(good, [{ classId: 1, x: 0.5, y: 0.5, w: 0.2, h: 0.2 }]);

  assert.throws(() => validateBoxes('nope', 3), /must be an array/);
  assert.throws(() => validateBoxes([null], 3), /must be an object/);
  assert.throws(() => validateBoxes([{ classId: 5, x: 0.5, y: 0.5, w: 0.1, h: 0.1 }], 3), /classId/);
  assert.throws(() => validateBoxes([{ classId: -1, x: 0.5, y: 0.5, w: 0.1, h: 0.1 }], 3), /classId/);
  assert.throws(() => validateBoxes([{ classId: 0, x: 0.5, y: 0.5, w: 0, h: 0.1 }], 3), /positive/);
  assert.throws(() => validateBoxes([{ classId: 0, x: Number.NaN, y: 0.5, w: 0.1, h: 0.1 }], 3), /finite/);
  assert.throws(() => validateBoxes([{ classId: 0, x: 2, y: 0.5, w: 0.1, h: 0.1 }], 3), /centre/);
});

test('validateBoxes clamps tiny floating point drift at the borders', () => {
  const boxes = validateBoxes([{ classId: 0, x: 1.0000001, y: -0.0000001, w: 1, h: 1 }], 1);
  assert.deepEqual(boxes, [{ classId: 0, x: 1, y: 0, w: 1, h: 1 }]);
});
