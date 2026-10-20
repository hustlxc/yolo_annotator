import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

import { discoverDefaults, isEntryPoint } from '../src/server/main.ts';

const run = promisify(execFile);

const mainTs = fileURLToPath(new URL('../src/server/main.ts', import.meta.url));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------------------------------------------------------------- fixtures */

/**
 * Builds a throwaway directory tree. Keys ending in `/` are directories.
 *
 * Note: `node:test` runs the tests in a file concurrently, and `discoverDefaults`
 * reads the process-wide working directory. These tests therefore never call
 * `process.chdir`; a directory that must not be searched is simply left empty.
 */
async function makeTree(dir: string, spec: Record<string, string | null>): Promise<void> {
  for (const [name, content] of Object.entries(spec)) {
    const target = path.join(dir, name);
    if (content === null) {
      await fs.mkdir(target, { recursive: true });
    } else {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    }
  }
}

/** Creates an app folder containing `spec`, plus the enclosing temp root. */
async function makeApp(
  spec: Record<string, string | null>,
): Promise<{ root: string; app: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yolo-pkg-'));
  const app = path.join(root, 'app');
  await fs.mkdir(app, { recursive: true });
  await makeTree(app, spec);
  return { root, app, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

/** Minimal valid PNG so indexed images really decode. */
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

/* -------------------------------------------------------------- discovery */

test('importing main.ts must not start the server', () => {
  // The runner's argv[1] is the runner, not main.ts, so this module was imported
  // rather than executed. Without the entry-point guard that would have started
  // a server and printed the "could not find" message as an import side effect.
  assert.equal(isEntryPoint(), false);
});

test('discoverDefaults finds images/ and obj.names next to the executable', async () => {
  const { app, cleanup } = await makeApp({
    'images/': null,
    'obj.names': 'left\nright\n',
    'images/a.jpg': '',
  });
  try {
    const found = discoverDefaults(app);
    assert.equal(found.imagesDir, path.join(app, 'images'));
    assert.equal(found.classesFile, path.join(app, 'obj.names'));
  } finally {
    await cleanup();
  }
});

test('discoverDefaults accepts the common alternative file names', async () => {
  const { app, cleanup } = await makeApp({ 'JPEGImages/': null, 'classes.txt': 'cat\ndog\n' });
  try {
    const found = discoverDefaults(app);
    assert.equal(found.imagesDir, path.join(app, 'JPEGImages'));
    assert.equal(found.classesFile, path.join(app, 'classes.txt'));
  } finally {
    await cleanup();
  }
});

test('discoverDefaults reports nothing for an app folder with no data', async () => {
  const { app, cleanup } = await makeApp({ 'README.txt': 'nothing here' });
  try {
    const found = discoverDefaults(app);
    // Only assert about this fixture: the current directory is searched too, and
    // that is whatever the test runner was started in.
    assert.equal(found.imagesDir.includes(app), false, `unexpected find in ${app}: ${found.imagesDir}`);
    assert.equal(found.classesFile.includes(app), false, `unexpected find in ${app}: ${found.classesFile}`);
  } finally {
    await cleanup();
  }
});

test('a folder named obj.names is not mistaken for a classes file', async () => {
  const { app, cleanup } = await makeApp({ 'images/': null, 'obj.names/': null });
  try {
    const found = discoverDefaults(app);
    assert.equal(found.imagesDir, path.join(app, 'images'));
    assert.notEqual(
      found.classesFile,
      path.join(app, 'obj.names'),
      'a directory must not satisfy the classes-file lookup',
    );
  } finally {
    await cleanup();
  }
});

test('the executable directory is searched before the working directory', async () => {
  const { root, app, cleanup } = await makeApp({ 'images/': null, 'obj.names': 'from-app\n' });
  try {
    // A decoy in the working directory; the app folder must still win.
    await makeTree(root, { 'images/': null, 'obj.names': 'from-cwd\n' });

    const found = discoverDefaults(app);
    assert.equal(found.imagesDir, path.join(app, 'images'));
    assert.equal(found.classesFile, path.join(app, 'obj.names'));
    assert.equal(await fs.readFile(found.classesFile, 'utf8'), 'from-app\n');
  } finally {
    await cleanup();
  }
});

/* ---------------------------------------------------------- packaged runs */

test('running with no arguments annotates ./images using ./obj.names', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yolo-run-'));
  try {
    await makeTree(root, { 'images/': null, 'obj.names': 'left\nright\n' });
    await fs.writeFile(path.join(root, 'images', 'a.png'), makePng(20, 10));

    const child = spawnServer([], root);
    try {
      const url = await waitForUrl(child);
      const response = await fetch(`${url}/api/images`);
      const raw = await response.text();
      assert.equal(response.status, 200, `GET /api/images -> ${response.status}: ${raw.slice(0, 200)}`);

      const payload = JSON.parse(raw);
      assert.deepEqual(payload.classNames, ['left', 'right']);
      assert.deepEqual(
        payload.images.map((image: { id: string }) => image.id),
        ['a.png'],
        'the images folder should have been discovered automatically',
      );

      // Stop it the way the browser does, and confirm it exits cleanly.
      const html = await (await fetch(url)).text();
      const token = /"shutdownToken":"([a-f0-9]+)"/.exec(html)?.[1];
      assert.ok(token, 'the page should carry a shutdown token');
      await fetch(`${url}/api/shutdown`, {
        method: 'POST',
        headers: { 'x-shutdown-token': token as string },
        body: '{}',
      });

      const code = await Promise.race([
        new Promise<number>((resolve) => child.once('exit', (value) => resolve(value ?? 0))),
        sleep(8000).then(() => 'timeout' as const),
      ]);
      assert.equal(code, 0, 'the server should exit cleanly after a shutdown request');
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('running with no arguments explains how to supply the data', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yolo-run-'));
  try {
    // An empty folder: no images/, no obj.names, nothing to discover.
    const { code, stderr } = await collect(spawnServer([], root), 10_000);

    assert.equal(code, 1);
    assert.match(stderr, /could not find the images folder or the classes file/i);
    assert.match(stderr, /Pass the paths explicitly/, 'the message should show the CLI form');
    assert.match(stderr, /obj\.names/, 'the message should name the expected file');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('--help and --version work without any arguments', async () => {
  const help = await collect(spawnServer(['--help'], process.cwd()), 10_000);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage/);
  assert.match(help.stdout, /yolo-annotator \[<images-directory>\]/, 'paths are shown as optional');

  const version = await collect(spawnServer(['--version'], process.cwd()), 10_000);
  assert.equal(version.code, 0);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('explicit paths still win over discovery', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yolo-run-'));
  try {
    // A decoy dataset in the working directory, and the real one elsewhere.
    await makeTree(root, { 'images/': null, 'obj.names': 'decoy\n' });
    await fs.writeFile(path.join(root, 'images', 'decoy.png'), makePng(8, 8));

    const real = path.join(root, 'real');
    await makeTree(real, { 'images/': null, 'obj.names': 'actual-class\n' });
    await fs.writeFile(path.join(real, 'images', 'real.png'), makePng(12, 12));

    const child = spawnServer(
      [path.join(real, 'images'), path.join(real, 'obj.names'), '--port', '0'],
      root,
    );
    try {
      const url = await waitForUrl(child);
      const response = await fetch(`${url}/api/images`);
      const raw = await response.text();
      assert.equal(response.status, 200, `GET /api/images -> ${response.status}: ${raw.slice(0, 200)}`);

      const payload = JSON.parse(raw);
      assert.deepEqual(payload.classNames, ['actual-class']);
      assert.deepEqual(
        payload.images.map((image: { id: string }) => image.id),
        ['real.png'],
        'the explicit folder should win over discovery',
      );
      child.kill('SIGTERM');
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------------- helpers */

function spawnServer(args: readonly string[], cwd: string) {
  return spawn(process.execPath, [mainTs, ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Waits for the banner and returns its **origin**, without a trailing slash, so
 * callers can append `/api/...` without producing a `//` path.
 *
 * Two details matter. A real `http://` must be present before matching, because
 * chunks arrive arbitrarily split and a loose match on "open" bites the
 * `--no-open` half of a line. And the URL is re-parsed with `new URL` rather
 * than used raw, so its trailing slash cannot leak into callers.
 */
async function waitForUrl(child: ReturnType<typeof spawnServer>, timeoutMs = 20_000): Promise<string> {
  let buffer = '';
  const printed = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`server did not print a URL within ${timeoutMs}ms. Output so far:\n${buffer}`));
    }, timeoutMs);

    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString();
      if (buffer.includes('http://') && /^\s*open\s+https?:\/\//m.test(buffer)) {
        clearTimeout(timer);
        resolve(buffer);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early with code ${code}. Output:\n${buffer}`));
    });
  });

  const match = /^\s*open\s+(https?:\/\/[^\s]+)/m.exec(printed);
  assert.ok(match, `no banner URL found in:\n${printed}`);
  return new URL(match[1] as string).origin;
}

/**
 * Waits until the child prints a line matching `pattern`.
 *
 * `waitForUrl` looks for the human banner ("  open  http://..."), which
 * `--print-url` deliberately suppresses, so the machine-readable handshake needs
 * its own waiter.
 */
async function waitForLine(
  child: ReturnType<typeof spawnServer>,
  pattern: RegExp,
  timeoutMs = 15_000,
): Promise<{ line: string; output: string }> {
  let output = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`no line matched ${pattern} within ${timeoutMs}ms. Output so far:\n${output}`));
    }, timeoutMs);

    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      const line = output.split('\n').find((candidate) => pattern.test(candidate));
      if (line !== undefined) {
        clearTimeout(timer);
        resolve({ line: line.trim(), output });
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`child exited with ${code} before matching ${pattern}. Output:\n${output}`));
    });
  });
}

/** Runs a child to completion and captures its streams. */
async function collect(
  child: ReturnType<typeof spawnServer>,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const code = await Promise.race([
    new Promise<number>((resolve) => child.once('exit', (value) => resolve(value ?? 0))),
    sleep(timeoutMs).then(() => {
      child.kill('SIGKILL');
      return -1;
    }),
  ]);

  return { code, stdout, stderr };
}

test('isEntryPoint resolves symlinks, as macOS .app bundles and /tmp require', async () => {
  /*
   * Regression guard for a bug that made the packaged macOS build silently do
   * nothing: `/tmp` is a symlink to `/private/tmp`, and a `.app` bundle's
   * installed path may be a symlink too. Comparing `argv[1]` with
   * `import.meta.url` without resolving symlinks reported "not the entry
   * point", so the app exited 0 having started nothing.
   */
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yolo-symlink-'));
  try {
    const real = path.join(root, 'real');
    await fs.mkdir(real, { recursive: true });
    const linked = path.join(root, 'link');
    await fs.symlink(real, linked, 'dir');

    const script = path.join(linked, 'entry.mjs');
    await fs.writeFile(
      script,
      [
        `import { realpathSync } from 'node:fs';`,
        `import path from 'node:path';`,
        `import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';`,
        `const entry = process.argv[1];`,
        `const modulePath = fileURLToPath(import.meta.url);`,
        `const naive = path.resolve(entry) === path.resolve(modulePath);`,
        `const resolved = realpathSync.native(entry) === realpathSync.native(modulePath);`,
        `process.stdout.write(JSON.stringify({ naive, resolved }));`,
      ].join('\n'),
      'utf8',
    );

    // Run the script through the symlinked path, as an installed app would.
    const { stdout } = await run(process.execPath, [script]);
    const result = JSON.parse(stdout);

    assert.equal(result.naive, false, 'the naive comparison should fail through a symlink');
    assert.equal(result.resolved, true, 'resolving symlinks must recognise the entry point');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('--print-url announces the address and stays silent otherwise', async () => {
  /*
   * The desktop launchers depend on this handshake: they let the OS pick a free
   * port (so a second launch cannot fail), which means the only way the launcher
   * can learn where the UI is, is if the server prints it. Break this and the
   * packaged app opens a blank browser.
   */
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yolo-printurl-'));
  try {
    await makeTree(root, { 'images/': null, 'obj.names': 'a\nb\n' });
    await fs.writeFile(path.join(root, 'images', 'x.png'), makePng(16, 16));

    const child = spawnServer(['--port', '0', '--print-url'], root);
    try {
      const { line, output } = await waitForLine(child, /^URL=http:\/\/127\.0\.0\.1:\d+\/$/);
      // Exactly one machine-readable line, and nothing else.
      const lines = output.split('\n').filter((candidate) => candidate.trim() !== '');
      assert.equal(lines.length, 1, `expected one line, got:\n${output}`);
      assert.match(line, /^URL=http:\/\/127\.0\.0\.1:\d+\/$/);

      const url = line.slice('URL='.length);
      const response = await fetch(`${url}api/images`);
      assert.equal(response.status, 200, 'the announced URL must actually serve the API');

      const html = await (await fetch(url)).text();
      const token = /"shutdownToken":"([a-f0-9]+)"/.exec(html)?.[1];
      await fetch(`${url}api/shutdown`, {
        method: 'POST',
        headers: { 'x-shutdown-token': token as string },
        body: '{}',
      });
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        sleep(8000),
      ]);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
