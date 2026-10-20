import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';

import { DatasetHost, NoDatasetError } from '../src/server/dataset.ts';
import { startServer } from '../src/server/server.ts';

/** Minimal valid PNG so indexing and image reads exercise the real path. */
function makePng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const crc32 = (buffer: Buffer): number => {
    let crc = 0xffffffff;
    for (const byte of buffer) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc(width * height * 4))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Two independent datasets, to prove switching actually switches. */
async function makeDatasets() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yolo-dataset-'));

  const first = path.join(root, 'first');
  await fs.mkdir(path.join(first, 'images'), { recursive: true });
  await fs.writeFile(path.join(first, 'images', 'one.png'), makePng(30, 20));
  await fs.writeFile(path.join(first, 'obj.names'), 'left\nright\n');

  const second = path.join(root, 'second');
  await fs.mkdir(path.join(second, 'images'), { recursive: true });
  await fs.writeFile(path.join(second, 'images', 'two.png'), makePng(40, 30));
  await fs.writeFile(path.join(second, 'images', 'three.png'), makePng(10, 10));
  await fs.writeFile(path.join(second, 'obj.names'), 'nodule\n');

  return {
    first: { imagesDir: path.join(first, 'images'), classesFile: path.join(first, 'obj.names') },
    second: { imagesDir: path.join(second, 'images'), classesFile: path.join(second, 'obj.names') },
    firstImages: path.join(first, 'images'),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

test('an empty host refuses to hand out a workspace', () => {
  const host = new DatasetHost();
  assert.equal(host.isOpen, false);
  assert.equal(host.info, null);
  assert.throws(() => host.workspace, NoDatasetError);
});

test('a host can open a dataset and then swap to another', async () => {
  const datasets = await makeDatasets();
  try {
    const host = new DatasetHost();

    const first = await host.open(datasets.first);
    assert.equal(first.imageCount, 1, 'the first dataset has one image');
    assert.deepEqual(first.classNames, ['left', 'right']);
    assert.equal(host.isOpen, true);

    const second = await host.open(datasets.second);
    assert.equal(second.imageCount, 2, 'the second dataset has two images');
    assert.deepEqual(second.classNames, ['nodule']);
    assert.equal(second.imagesDir, datasets.second.imagesDir);

    // The swap must be visible through the workspace, not just the summary.
    const snapshot = await host.workspace.getSnapshot();
    assert.deepEqual(
      snapshot.images.map((image) => image.id),
      ['three.png', 'two.png'],
    );
  } finally {
    await datasets.cleanup();
  }
});

test('opening a bad folder fails without disturbing the open dataset', async () => {
  const datasets = await makeDatasets();
  try {
    const host = new DatasetHost();
    await host.open(datasets.first);

    await assert.rejects(
      host.open({ imagesDir: path.join(datasets.firstImages, 'nope'), classesFile: datasets.first.classesFile }),
      /does not exist/,
    );

    // The previously open dataset is still intact: a failed swap must not leave
    // the app pointing at nothing.
    assert.equal(host.isOpen, true);
    assert.equal(host.info?.imageCount, 1);
    assert.equal(host.workspace.imagesRoot, datasets.first.imagesDir);
  } finally {
    await datasets.cleanup();
  }
});

test('a folder with no images is rejected rather than opened empty', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yolo-empty-'));
  try {
    await fs.mkdir(path.join(root, 'images'), { recursive: true });
    await fs.writeFile(path.join(root, 'obj.names'), 'a\n');

    const host = new DatasetHost();
    await assert.rejects(
      host.open({ imagesDir: path.join(root, 'images'), classesFile: path.join(root, 'obj.names') }),
      /no images found/,
    );
    assert.equal(host.isOpen, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the API serves a dataset chosen after startup', async () => {
  const datasets = await makeDatasets();
  const host = new DatasetHost(); // starts with nothing, like the desktop app
  const server = await startServer({ workspace: host, host: '127.0.0.1', port: 0, log: () => {} });

  try {
    // Before choosing: the endpoints say so instead of failing obscurely.
    const before = await fetch(`${server.origin}/api/dataset`);
    assert.equal(before.status, 200);
    assert.equal(await before.json(), null, 'no dataset yet');

    const refused = await fetch(`${server.origin}/api/images`);
    assert.equal(refused.status, 503, 'asking for images without a dataset is not a server fault');

    // Start the server with nothing, then open a dataset through the API.
    const open = await fetch(`${server.origin}/api/dataset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(datasets.first),
    });
    assert.equal(open.status, 200);
    const opened = await open.json();
    assert.equal(opened.ok, true);
    assert.equal(opened.dataset.imageCount, 1);

    const images = await (await fetch(`${server.origin}/api/images`)).json();
    assert.deepEqual(images.classNames, ['left', 'right']);
    assert.deepEqual(images.images.map((image: { id: string }) => image.id), ['one.png']);

    // And swap to the other dataset while the server keeps running.
    const swap = await fetch(`${server.origin}/api/dataset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(datasets.second),
    });
    assert.equal(swap.status, 200);

    const after = await (await fetch(`${server.origin}/api/images`)).json();
    assert.deepEqual(after.classNames, ['nodule']);
    assert.deepEqual(
      after.images.map((image: { id: string }) => image.id),
      ['three.png', 'two.png'],
      'the swap is visible immediately',
    );
  } finally {
    await server.close();
    await datasets.cleanup();
  }
});

test('the dataset endpoint validates its input', async () => {
  const host = new DatasetHost();
  const server = await startServer({ workspace: host, host: '127.0.0.1', port: 0, log: () => {} });
  try {
    const missing = await fetch(`${server.origin}/api/dataset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imagesDir: '/tmp/x' }),
    });
    assert.equal(missing.status, 400);
    assert.match(await missing.text(), /classesFile/);

    const badLimit = await fetch(`${server.origin}/api/dataset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imagesDir: '/tmp/x', classesFile: '/tmp/y', limit: -1 }),
    });
    assert.equal(badLimit.status, 400);
    assert.match(await badLimit.text(), /limit/);
  } finally {
    await server.close();
  }
});

test('every write is persisted atomically to the image label file', async () => {
  /*
   * The annotator's promise is that each image's .txt is written automatically.
   * This exercises the storage contract the UI relies on: a PUT replaces the
   * file, the bytes are exactly the darknet format, and reading it back through
   * a fresh Workspace (as a restart would) sees the same boxes.
   */
  const datasets = await makeDatasets();
  try {
    const host = new DatasetHost();
    await host.open(datasets.first);
    const workspace = host.workspace;

    const target = datasets.firstImages + '/one.png';
    const annotationPath = target.replace(/\.png$/, '.txt');

    await workspace.writeAnnotation('one.png', [{ classId: 1, x: 0.5, y: 0.4, w: 0.25, h: 0.2 }]);
    const written = await fs.readFile(annotationPath, 'utf8');
    assert.equal(written, '1 0.500000 0.400000 0.250000 0.200000\n');

    // A second write replaces, never appends.
    await workspace.writeAnnotation('one.png', [
      { classId: 0, x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
      { classId: 1, x: 0.9, y: 0.9, w: 0.05, h: 0.05 },
    ]);
    const replaced = await fs.readFile(annotationPath, 'utf8');
    assert.equal(replaced.trim().split('\n').length, 2, 'the file is replaced, not appended to');

    // A fresh host (what a restart amounts to) reads the saved boxes back.
    const reopened = new DatasetHost();
    await reopened.open(datasets.first);
    const reloaded = await reopened.workspace.readAnnotation('one.png');
    assert.deepEqual(
      reloaded.boxes,
      [
        { classId: 0, x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
        { classId: 1, x: 0.9, y: 0.9, w: 0.05, h: 0.05 },
      ],
      'the boxes must survive a reopen',
    );

    // Deleting every box leaves an empty file, not a stale one.
    await workspace.writeAnnotation('one.png', []);
    assert.equal(await fs.readFile(annotationPath, 'utf8'), '');
  } finally {
    await datasets.cleanup();
  }
});
