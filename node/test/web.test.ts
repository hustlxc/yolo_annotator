import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { encodeRevision as serverEncodeRevision } from '../src/server/server.ts';
import { formatAnnotationText, validateBoxes } from '../src/shared/yolo.ts';

const run = promisify(execFile);
const webRoot = path.resolve(import.meta.dirname, '..', 'web');

/**
 * The browser UI is plain JavaScript served as-is: there is no bundler and no
 * linter, so a stray TypeScript annotation would only fail at runtime in the
 * browser. These checks catch that during `npm test`.
 */
test('web/app.js parses as plain JavaScript', async () => {
  const file = path.join(webRoot, 'app.js');
  const source = await fs.readFile(file, 'utf8');
  assert.ok(source.length > 0);

  await assert.doesNotReject(
    run(process.execPath, ['--check', file]),
    'app.js must be valid ES module syntax (no TypeScript annotations)',
  );
});

test('the UI files reference each other consistently', async () => {
  const html = await fs.readFile(path.join(webRoot, 'index.html'), 'utf8');
  const routes = ['/app.css', '/app.js', '/favicon.svg'];
  for (const route of routes) {
    assert.ok(html.includes(route), `index.html should reference ${route}`);
    await fs.access(path.join(webRoot, route.slice(1)));
  }

  // The server injects the bootstrap placeholder; the page must consume it.
  assert.match(html, /__YOLO_BOOTSTRAP__/, 'the bootstrap placeholder must be present');
  assert.match(html, /window\.__YOLO__\s*=/, 'the page must expose the bootstrap object');
});

test('every element id used by the client exists in the markup', async () => {
  const html = await fs.readFile(path.join(webRoot, 'index.html'), 'utf8');
  const script = await fs.readFile(path.join(webRoot, 'app.js'), 'utf8');

  const declared = new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
  const used = new Set(
    [...script.matchAll(/getElementById\('([^']+)'\)/g)].map((match) => match[1]),
  );

  const missing = [...used].filter((id) => !declared.has(id));
  assert.deepEqual(missing, [], `app.js references unknown element ids: ${missing.join(', ')}`);
});

/**
 * Extracts a top-level function from `web/app.js` by name and evaluates it.
 *
 * This lets a test exercise the *real* client implementation rather than a copy
 * of it, which is the only way to catch drift between the two languages.
 */
async function loadClientFunction(name: string): Promise<(...args: unknown[]) => unknown> {
  const source = await fs.readFile(path.join(webRoot, 'app.js'), 'utf8');
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `web/app.js should define ${name}()`);

  // Walk braces to find the end of the function body.
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        end = index + 1;
        break;
      }
    }
  }
  assert.notEqual(end, -1, `could not find the end of ${name}()`);

  const declaration = source.slice(start, end);
  const factory = new Function(`"use strict"; ${declaration}; return ${name};`);
  return factory() as (...args: unknown[]) => unknown;
}

test('the client predicts the server label-file bytes exactly', async () => {
  /*
   * `serializeBoxes` is what the client believes it just wrote, and it becomes
   * the revision token for the *next* save. If it ever disagreed with the
   * server by a single byte, every subsequent save of a file would report a
   * phantom "changed on disk" conflict — so this invariant is load-bearing, not
   * cosmetic.
   */
  const serializeBoxes = await loadClientFunction('serializeBoxes');

  const cases: Array<Array<{ classId: number; x: number; y: number; w: number; h: number }>> = [
    [],
    [{ classId: 0, x: 0.5, y: 0.5, w: 0.2, h: 0.2 }],
    [{ classId: 12, x: 1 / 3, y: 2 / 3, w: 1, h: 1 }],
    [{ classId: 0, x: 0.1234565, y: 0.9999999, w: 0.0000001, h: 0.5 }],
    [
      { classId: 0, x: 0, y: 0, w: 1, h: 1 },
      { classId: 1, x: 0.25, y: 0.75, w: 0.5, h: 0.25 },
    ],
    [{ classId: 0, x: 0.30000000000000004, y: 0.7, w: 0.15, h: 0.05 }],
  ];

  for (const boxes of cases) {
    const client = serializeBoxes(boxes);
    const server = formatAnnotationText(validateBoxes(boxes, 100));
    assert.equal(client, server, `mismatch for ${JSON.stringify(boxes)}`);
  }
});

test('the client and server encoders produce the same revision token', async () => {
  const encodeRevision = await loadClientFunction('encodeRevision');
  // TextEncoder/btoa are browser globals; Node has both, so the real
  // implementation can run unchanged.
  for (const raw of ['', '\n', '0 0.500000 0.500000 0.500000 0.500000\n', 'ünïcode ✓\n']) {
    assert.equal(encodeRevision(raw), serverEncodeRevision(raw), `mismatch for ${JSON.stringify(raw)}`);
  }
});

test('every element the client looks up is declared in the markup', async () => {
  /*
   * Regression guard for a bug that shipped a binary which opened no window:
   * `showSetup()` wrote to `el.setupHint`, but `setupHint` was never added to
   * the element map, so the picker threw at startup, the app never reached
   * `ready-to-show`, and double-clicking appeared to do nothing at all.
   *
   * The existing id check only covered direct `getElementById(...)` calls, which
   * is exactly why this slipped through.
   */
  const markup = await fs.readFile(path.join(webRoot, 'index.html'), 'utf8');
  const script = await fs.readFile(path.join(webRoot, 'app.js'), 'utf8');

  const declared = new Set([...markup.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));

  // Every `el.someName` the script references must exist as a property of `el`.
  const referenced = new Set([...script.matchAll(/\bel\.([A-Za-z][A-Za-z0-9]*)/g)].map((m) => m[1] as string));

  const block = /\nconst el = \{([\s\S]*?)\n\};/.exec(script);
  assert.ok(block, 'could not find the `el` element map in web/app.js');
  const defined = new Set(
    [...(block[1] as string).matchAll(/^\s*([A-Za-z][A-Za-z0-9]*)\s*:/gm)].map((m) => m[1] as string),
  );

  const missing = [...referenced].filter((name) => !defined.has(name));
  assert.deepEqual(missing, [], `web/app.js uses el.${missing.join(', el.')} which is never defined`);

  // And each defined entry must point at an id that exists in the markup.
  const ids = [...(block[1] as string).matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1] as string);
  const unknownIds = ids.filter((id) => !declared.has(id));
  assert.deepEqual(unknownIds, [], `the element map references unknown ids: ${unknownIds.join(', ')}`);
});

test('the client asks the shell to flush pending edits before the window closes', async () => {
  /*
   * Regression guard for lost annotations: the desktop shell used to close the
   * window immediately, while the save is debounced by 150 ms, so a box drawn
   * just before closing was silently dropped. `beforeunload` cannot fix it (the
   * save is async and the window is already going away), so the page registers a
   * flush handler the shell awaits.
   */
  const script = await fs.readFile(path.join(webRoot, 'app.js'), 'utf8');

  assert.match(script, /desktop\?\.onFlushRequest/, 'the page must register a flush handler');
  assert.match(script, /await saveNow\(\)/, 'the flush handler must wait for the save to finish');

  const preload = await fs.readFile(path.join(import.meta.dirname, '..', 'src', 'desktop', 'preload.cjs'), 'utf8');
  assert.match(preload, /onFlushRequest/, 'the preload must expose onFlushRequest');
  assert.match(preload, /ipcRenderer\.send\('app:flushed'/, 'the page must acknowledge the flush');

  const main = await fs.readFile(path.join(import.meta.dirname, '..', 'src', 'desktop', 'main.cjs'), 'utf8');
  assert.match(main, /event\.preventDefault\(\)/, 'the close must be intercepted');
  assert.match(main, /app:flush/, 'the shell must ask the page to flush');
  assert.match(main, /allowClose = true/, 'the window must be closed after flushing');
});
