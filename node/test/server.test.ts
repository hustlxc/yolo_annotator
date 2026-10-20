import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';

import { encodeRevision, REVISION_HEADER, startServer, type StartedServer } from '../src/server/server.ts';
import { Workspace } from '../src/server/workspace.ts';

/** Minimal valid PNG so image reads exercise the real code path. */
function makePng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    return Buffer.concat([length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc(width * height * 4))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

type Fixture = {
  root: string;
  imagesDir: string;
  classesFile: string;
  cleanup: () => Promise<void>;
};

/** Creates images/{a.png, b.png, sub/c.png}, one pre-labelled file and obj.names. */
async function makeFixture(): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yolo-annotator-server-'));
  const imagesDir = path.join(root, 'images');
  await fs.mkdir(path.join(imagesDir, 'sub'), { recursive: true });

  await fs.writeFile(path.join(imagesDir, 'a.png'), makePng(40, 20));
  await fs.writeFile(path.join(imagesDir, 'b.png'), makePng(10, 10));
  await fs.writeFile(path.join(imagesDir, 'sub', 'c.png'), makePng(8, 8));
  await fs.writeFile(path.join(imagesDir, 'notes.txt'), 'ignored');
  await fs.writeFile(path.join(imagesDir, 'a.txt'), '0 0.500000 0.500000 0.500000 0.500000\n');

  const classesFile = path.join(root, 'obj.names');
  await fs.writeFile(classesFile, 'left\nright\n');

  return {
    root,
    imagesDir,
    classesFile,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

async function withServer(
  run: (context: { server: StartedServer; workspace: Workspace; fixture: Fixture }) => Promise<void>,
): Promise<void> {
  const fixture = await makeFixture();
  const workspace = await Workspace.open(fixture.imagesDir, fixture.classesFile);
  const server = await startServer({
    workspace,
    host: '127.0.0.1',
    port: 0, // let the OS pick a free port
    log: () => {},
  });

  try {
    await run({ server, workspace, fixture });
  } finally {
    await server.close();
    await fixture.cleanup();
  }
}

test('GET /api/images returns the catalog with groups and classes', async () => {
  await withServer(async ({ server }) => {
    const response = await fetch(`${server.origin}/api/images`);
    assert.equal(response.status, 200);
    const payload = await response.json();

    assert.deepEqual(payload.classNames, ['left', 'right']);
    assert.equal(payload.images.length, 3);
    assert.deepEqual(
      payload.images.map((image: { id: string }) => image.id),
      ['a.png', 'b.png', 'sub/c.png'],
      'sorted, POSIX-style ids',
    );
    assert.deepEqual(
      payload.images.map((image: { group: string }) => image.group),
      ['', '', 'sub'],
    );

    const first = payload.images[0];
    assert.equal(first.width, 40);
    assert.equal(first.height, 20);
    assert.equal(first.hasAnnotation, true);
    assert.equal(first.boxCount, 1);
    assert.deepEqual(
      payload.groups.map((group: { relativePath: string; imageCount: number }) => [group.relativePath, group.imageCount]),
      [['', 2], ['sub', 1]],
    );
  });
});

test('GET /api/image streams bytes with the right content type and ETag', async () => {
  await withServer(async ({ server }) => {
    const response = await fetch(`${server.origin}/api/image/a.png`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    const body = Buffer.from(await response.arrayBuffer());
    assert.equal(body.length, Number(response.headers.get('content-length')));
    assert.deepEqual([...body.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);

    const cached = await fetch(`${server.origin}/api/image/a.png`, {
      headers: { 'if-none-match': response.headers.get('etag') ?? '' },
    });
    assert.equal(cached.status, 304);

    const nested = await fetch(`${server.origin}/api/image/sub/c.png`);
    assert.equal(nested.status, 200, 'nested ids work through the wildcard route');
  });
});

test('PUT /api/annotations writes a darknet label file and GET reads it back', async () => {
  await withServer(async ({ server, fixture }) => {
    const boxes = [
      { classId: 1, x: 0.25, y: 0.5, w: 0.5, h: 0.5 },
      { classId: 0, x: 0.75, y: 0.5, w: 0.25, h: 0.25 },
    ];

    const put = await fetch(`${server.origin}/api/annotations/b.png`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ boxes }),
    });
    assert.equal(put.status, 200);
    const saved = await put.json();
    assert.equal(saved.ok, true);
    assert.equal(saved.result.boxes, 2);
    assert.equal(saved.result.updatedExisting, false);

    const onDisk = await fs.readFile(path.join(fixture.imagesDir, 'b.txt'), 'utf8');
    assert.equal(onDisk, '1 0.250000 0.500000 0.500000 0.500000\n0 0.750000 0.500000 0.250000 0.250000\n');

    const get = await fetch(`${server.origin}/api/annotations/b.png`);
    assert.equal(get.status, 200);
    const payload = await get.json();
    assert.deepEqual(payload.boxes, boxes);
    assert.deepEqual(payload.warnings, []);
    assert.equal(payload.width, 10);
  });
});

test('the revision header refuses to overwrite a label file that changed on disk', async () => {
  await withServer(async ({ server, fixture }) => {
    const labelPath = path.join(fixture.imagesDir, 'a.txt');

    // The client loads the file and remembers its exact contents.
    const loaded = await (await fetch(`${server.origin}/api/annotations/a.png`)).json();
    assert.equal(loaded.raw, '0 0.500000 0.500000 0.500000 0.500000\n');
    const revision: string = encodeRevision(loaded.raw);

    // Another tab (or a sync client) rewrites it.
    const otherVersion = '1 0.250000 0.250000 0.100000 0.100000\n';
    await fs.writeFile(labelPath, otherVersion);

    // Our save must be rejected, and must report what is on disk now.
    const conflict = await fetch(`${server.origin}/api/annotations/a.png`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', [REVISION_HEADER]: revision },
      body: JSON.stringify({ boxes: [{ classId: 0, x: 0.9, y: 0.9, w: 0.05, h: 0.05 }] }),
    });
    assert.equal(conflict.status, 409);
    const payload = await conflict.json();
    assert.match(payload.error, /changed on disk/);
    assert.equal(payload.details.current, otherVersion, 'the current disk contents are returned');
    assert.equal(payload.details.revision, encodeRevision(otherVersion), 'and its revision token');
    assert.equal(await fs.readFile(labelPath, 'utf8'), otherVersion, 'the other version survives');

    // Choosing "overwrite" simply omits the revision header.
    const overwrite = await fetch(`${server.origin}/api/annotations/a.png`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ boxes: [{ classId: 0, x: 0.9, y: 0.9, w: 0.05, h: 0.05 }] }),
    });
    assert.equal(overwrite.status, 200);
  });
});

test('a matching revision is accepted, including for a missing label file', async () => {
  await withServer(async ({ server }) => {
    const loaded = await (await fetch(`${server.origin}/api/annotations/a.png`)).json();
    const accepted = await fetch(`${server.origin}/api/annotations/a.png`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', [REVISION_HEADER]: encodeRevision(loaded.raw) },
      body: JSON.stringify({ boxes: [{ classId: 1, x: 0.5, y: 0.5, w: 0.5, h: 0.5 }] }),
    });
    assert.equal(accepted.status, 200);

    // No label file yet: `raw` is "", and creating the file must still work.
    const missing = await (await fetch(`${server.origin}/api/annotations/b.png`)).json();
    assert.equal(missing.raw, '');
    const created = await fetch(`${server.origin}/api/annotations/b.png`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', [REVISION_HEADER]: encodeRevision('') },
      body: JSON.stringify({ boxes: [{ classId: 0, x: 0.5, y: 0.5, w: 0.1, h: 0.1 }] }),
    });
    assert.equal(created.status, 200);
  });
});

test('consecutive saves by the same client do not raise a false conflict', async () => {
  await withServer(async ({ server }) => {
    const first = await fetch(`${server.origin}/api/annotations/b.png`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ boxes: [{ classId: 0, x: 0.3, y: 0.3, w: 0.2, h: 0.2 }] }),
    });
    assert.equal(first.status, 200);

    // The client re-reads (or derives) the revision it just wrote, then edits.
    const written = await (await fetch(`${server.origin}/api/annotations/b.png`)).json();
    const second = await fetch(`${server.origin}/api/annotations/b.png`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', [REVISION_HEADER]: encodeRevision(written.raw) },
      body: JSON.stringify({
        boxes: [
          { classId: 0, x: 0.3, y: 0.3, w: 0.2, h: 0.2 },
          { classId: 1, x: 0.7, y: 0.7, w: 0.1, h: 0.1 },
        ],
      }),
    });
    assert.equal(second.status, 200, 'our own previous revision is not a conflict');
  });
});

test('revision tokens survive the exact byte shape of a label file', async () => {
  await withServer(async ({ server }) => {
    // Every label file ends with "\n". Sent as a raw HTTP header that newline
    // would be stripped by the runtime, which is why the token is base64.
    const loaded = await (await fetch(`${server.origin}/api/annotations/a.png`)).json();
    assert.ok(loaded.raw.endsWith('\n'));
    const token = encodeRevision(loaded.raw);
    assert.ok(!token.includes('\n'), 'the token must be header-safe');
    assert.equal(Buffer.from(token, 'base64').toString('utf8'), loaded.raw);

    const response = await fetch(`${server.origin}/api/annotations/a.png`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', [REVISION_HEADER]: token },
      body: JSON.stringify({ boxes: [{ classId: 0, x: 0.5, y: 0.5, w: 0.5, h: 0.5 }] }),
    });
    assert.equal(response.status, 200, 'a trailing newline must not break the comparison');
  });
});

test('saving an empty box list truncates the label file', async () => {
  await withServer(async ({ server, fixture }) => {
    const response = await fetch(`${server.origin}/api/annotations/a.png`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ boxes: [] }),
    });
    assert.equal(response.status, 200);
    assert.equal(await fs.readFile(path.join(fixture.imagesDir, 'a.txt'), 'utf8'), '');

    const payload = await (await fetch(`${server.origin}/api/annotations/a.png`)).json();
    assert.deepEqual(payload.boxes, []);
  });
});

test('backup:true preserves the previous label file as .original.txt', async () => {
  await withServer(async ({ server, fixture }) => {
    const before = await fs.readFile(path.join(fixture.imagesDir, 'a.txt'), 'utf8');
    const response = await fetch(`${server.origin}/api/annotations/a.png`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ boxes: [{ classId: 1, x: 0.5, y: 0.5, w: 0.2, h: 0.2 }], backup: true }),
    });
    assert.equal(response.status, 200);

    assert.equal(
      await fs.readFile(path.join(fixture.imagesDir, 'a.original.txt'), 'utf8'),
      before,
      'the previous revision is kept verbatim',
    );
    assert.match(await fs.readFile(path.join(fixture.imagesDir, 'a.txt'), 'utf8'), /^1 /);

    // The sidecar must not be picked up as an image or as a label file.
    const payload = await (await fetch(`${server.origin}/api/images`)).json();
    assert.equal(payload.images.length, 3);
    assert.deepEqual(
      payload.images.map((image: { id: string }) => image.id),
      ['a.png', 'b.png', 'sub/c.png'],
    );
  });
});

test('the API rejects malformed boxes with 400 and unknown ids with 404', async () => {
  await withServer(async ({ server }) => {
    const badBoxes = await fetch(`${server.origin}/api/annotations/a.png`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ boxes: [{ classId: 9, x: 0.5, y: 0.5, w: 0.1, h: 0.1 }] }),
    });
    assert.equal(badBoxes.status, 400);

    const notAnObject = await fetch(`${server.origin}/api/annotations/a.png`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([1, 2, 3]),
    });
    assert.equal(notAnObject.status, 400);

    const missing = await fetch(`${server.origin}/api/annotations/nope.png`);
    assert.equal(missing.status, 404);

    const badMethod = await fetch(`${server.origin}/api/shutdown`, { method: 'GET' });
    assert.equal(badMethod.status, 405);
  });
});

test('path traversal attempts never escape the images directory', async () => {
  await withServer(async ({ server, fixture }) => {
    const outside = path.join(fixture.root, 'secret.txt');
    await fs.writeFile(outside, 'top secret');

    for (const attempt of [
      '/api/image/..%2Fsecret.txt',
      '/api/image/%2E%2E%2Fsecret.txt',
      '/api/image/..%2F..%2Fetc%2Fpasswd',
      '/api/annotations/..%2Fsecret.txt',
    ]) {
      const response = await fetch(`${server.origin}${attempt}`);
      assert.ok(response.status === 404 || response.status === 400, `${attempt} -> ${response.status}`);
      const body = await response.text();
      assert.ok(!body.includes('top secret'), `${attempt} must not leak file contents`);
    }

    // A write outside the root must fail too, and must not touch the target.
    const write = await fetch(`${server.origin}/api/annotations/..%2Fsecret.txt`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ boxes: [] }),
    });
    assert.ok(write.status === 404 || write.status === 400);
    assert.equal(await fs.readFile(outside, 'utf8'), 'top secret');
  });
});

test('shutdown requires the per-run token', async () => {
  await withServer(async ({ server }) => {
    const forbidden = await fetch(`${server.origin}/api/shutdown`, { method: 'POST', body: '{}' });
    assert.equal(forbidden.status, 403);

    const wrong = await fetch(`${server.origin}/api/shutdown`, {
      method: 'POST',
      headers: { 'x-shutdown-token': 'nope' },
      body: '{}',
    });
    assert.equal(wrong.status, 403);

    const accepted = await fetch(`${server.origin}/api/shutdown`, {
      method: 'POST',
      headers: { 'x-shutdown-token': server.shutdownToken },
      body: '{}',
    });
    assert.equal(accepted.status, 200);
  });
});

test('the UI document is served with the bootstrap token injected', async () => {
  await withServer(async ({ server }) => {
    const response = await fetch(server.url);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    const html = await response.text();
    assert.ok(html.includes(server.shutdownToken), 'the shutdown token reaches the page');
    assert.ok(!html.includes('__YOLO_BOOTSTRAP__'), 'the placeholder is replaced');
  });
});

test('static assets and summary endpoints are reachable', async () => {
  await withServer(async ({ server }) => {
    for (const route of ['/app.js', '/app.css', '/favicon.svg']) {
      const response = await fetch(`${server.origin}${route}`);
      assert.equal(response.status, 200, route);
      assert.ok((await response.text()).length > 0, route);
    }

    const summary = await (await fetch(`${server.origin}/api/summary`)).json();
    assert.equal(summary.totals.images, 3);
    assert.equal(summary.totals.annotated, 1);
    assert.equal(summary.totals.boxes, 1);

    const unknown = await fetch(`${server.origin}/definitely-not-here`);
    assert.equal(unknown.status, 404);
  });
});

test('reindexing picks up images added while the server is running', async () => {
  await withServer(async ({ server, fixture }) => {
    await fs.writeFile(path.join(fixture.imagesDir, 'late.png'), makePng(6, 6));

    const before = await (await fetch(`${server.origin}/api/images`)).json();
    assert.equal(before.images.length, 3);

    const reindex = await fetch(`${server.origin}/api/reindex`, { method: 'POST' });
    assert.equal(reindex.status, 200);
    const result = await reindex.json();
    assert.equal(result.images, 4);

    const after = await (await fetch(`${server.origin}/api/images`)).json();
    assert.deepEqual(
      after.images.map((image: { id: string }) => image.id),
      ['a.png', 'b.png', 'late.png', 'sub/c.png'],
    );
  });
});

test('Workspace.open reports missing inputs with actionable messages', async () => {
  const fixture = await makeFixture();
  try {
    await assert.rejects(
      Workspace.open(path.join(fixture.root, 'nope'), fixture.classesFile),
      /images directory does not exist/,
    );
    await assert.rejects(
      Workspace.open(fixture.imagesDir, path.join(fixture.root, 'nope.names')),
      /cannot read classes file/,
    );

    await fs.writeFile(path.join(fixture.root, 'empty.names'), '\n# nothing here\n');
    await assert.rejects(Workspace.open(fixture.imagesDir, path.join(fixture.root, 'empty.names')), /no class names/);
  } finally {
    await fixture.cleanup();
  }
});
