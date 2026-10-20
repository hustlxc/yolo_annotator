import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import { sep } from 'node:path';
import path from 'node:path';
import test from 'node:test';

import {
  annotationPathForImage,
  assertUsableClassNames,
  discoverImages,
  isImageFile,
  mimeForPath,
  parseClassNames,
  sidecarPathForImage,
  toWirePath,
} from '../src/shared/paths.ts';

/**
 * Creates a throwaway directory tree. Keys ending in `/` with a `null` value are
 * directories; every other key is a file whose content is the given string.
 */
async function makeTree(spec: Record<string, string | null>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yolo-annotator-'));
  for (const [name, content] of Object.entries(spec)) {
    const target = path.join(root, name);
    if (content === null) {
      await fs.mkdir(target, { recursive: true });
    } else {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    }
  }
  return root;
}

test('isImageFile accepts the documented extensions case-insensitively', () => {
  for (const name of ['a.jpg', 'a.JPEG', 'a.Png', 'a.bmp', 'a.webp', 'a.TIF', 'a.tiff']) {
    assert.equal(isImageFile(name), true, name);
  }
  for (const name of ['a.txt', 'a', '.jpg', 'a.jpg.txt', 'notes.md']) {
    assert.equal(isImageFile(name), false, name);
  }
});

test('annotationPathForImage swaps only the final extension', () => {
  assert.equal(annotationPathForImage('/data/img/a.jpg'), '/data/img/a.txt');
  assert.equal(annotationPathForImage('/data/img/a.b.c.png'), '/data/img/a.b.c.txt');
  assert.equal(annotationPathForImage('a.jpeg'), 'a.txt');
});

test('sidecarPathForImage appends a suffix before the extension is dropped', () => {
  assert.equal(sidecarPathForImage('/data/a.jpg', '.original.txt'), '/data/a.original.txt');
});

test('toWirePath converts host separators to forward slashes', () => {
  assert.equal(toWirePath('sub/dir/a.jpg'), 'sub/dir/a.jpg');
  assert.equal(toWirePath('sub\\dir\\a.jpg'), 'sub/dir/a.jpg', 'Windows separators become slashes');
  assert.equal(toWirePath(`sub${sep}dir${sep}a.jpg`), 'sub/dir/a.jpg');
  assert.equal(toWirePath('./a.jpg'), 'a.jpg');
});

test('parseClassNames ignores blanks, comments and a BOM', () => {
  const result = parseClassNames('\uFEFF# comment\nleft\n\n  right  \n\n');
  assert.deepEqual(result.names, ['left', 'right']);
  assert.deepEqual(result.duplicates, []);
});

test('parseClassNames handles CRLF and reports duplicates', () => {
  const result = parseClassNames('cat\r\ndog\r\ncat\r\n');
  assert.deepEqual(result.names, ['cat', 'dog']);
  assert.deepEqual(result.duplicates, [{ name: 'cat', first: 0, repeated: 2 }]);
});

test('assertUsableClassNames rejects an empty list', () => {
  assert.throws(() => assertUsableClassNames(parseClassNames('\n#only a comment\n'), 'obj.names'), /no class names/);
  assert.deepEqual(assertUsableClassNames(parseClassNames('a\n'), 'x'), ['a']);
});

test('mimeForPath covers the supported image formats', () => {
  assert.equal(mimeForPath('a.jpg'), 'image/jpeg');
  assert.equal(mimeForPath('a.JPEG'), 'image/jpeg');
  assert.equal(mimeForPath('a.png'), 'image/png');
  assert.equal(mimeForPath('a.webp'), 'image/webp');
  assert.equal(mimeForPath('a.unknown'), 'application/octet-stream');
});

test('discoverImages scans recursively, skips non-images and dotfiles', async () => {
  const root = await makeTree({
    'b.jpg': '',
    'a.png': '',
    'notes.txt': '',
    '.DS_Store': '',
    'sub/': null,
    'sub/c.jpeg': '',
    'sub/nested/': null,
    'sub/nested/d.bmp': '',
    'sub/empty/': null,
  });

  const result = discoverImages(root, {});
  assert.deepEqual(
    result.files.map((file) => file.slice(root.length + 1).split(sep).join('/')),
    ['a.png', 'b.jpg', 'sub/c.jpeg', 'sub/nested/d.bmp'],
    'sorted deterministically, recursively, images only',
  );
  assert.deepEqual(
    result.groups.map((group) => [group.relativePath, group.imageCount]),
    [['', 2], ['sub', 1], ['sub/nested', 1]],
  );
  assert.deepEqual(result.warnings, []);
});

test('discoverImages can filter by group and respect the limit', async () => {
  const root = await makeTree({
    'a.jpg': '',
    'sub/': null,
    'sub/b.jpg': '',
    'sub/c.jpg': '',
  });

  const filtered = discoverImages(root, { groups: ['sub'] });
  assert.deepEqual(
    filtered.files.map((file) => file.slice(root.length + 1).split(sep).join('/')),
    ['sub/b.jpg', 'sub/c.jpg'],
  );

  const limited = discoverImages(root, { limit: 2 });
  assert.equal(limited.files.length, 2);
  assert.match(limited.warnings.join(' '), /stopped after 2 images/);

  const flat = discoverImages(root, { recursive: false });
  assert.deepEqual(
    flat.files.map((file) => file.slice(root.length + 1).split(sep).join('/')),
    ['a.jpg'],
  );
});
