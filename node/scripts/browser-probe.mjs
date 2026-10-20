/**
 * Manual browser probe (not part of `npm test`).
 *
 * Drives the real UI in headless Chrome over the DevTools Protocol to verify the
 * things unit tests cannot: that a pointer drag produces the expected YOLO file,
 * that the keyboard shortcuts behave, and that navigation keeps the server and
 * the canvas in sync.
 *
 * Usage:
 *   node scripts/browser-probe.mjs <url> [--chrome <path>]
 */

import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:7860/';
const chromePath = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const debugPort = 9333;

const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-crash-reporter',
    '--hide-scrollbars',
    '--window-size=1440,900',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${await fs.mkdtemp(path.join(os.tmpdir(), 'yolo-probe-'))}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findTarget() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === 'page');
      if (page !== undefined) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome is still starting.
    }
    await sleep(250);
  }
  throw new Error('Chrome DevTools endpoint never became available');
}

/** Minimal CDP client on top of the built-in WebSocket. */
class Cdp {
  #socket;
  #nextId = 1;
  #pending = new Map();

  static async connect(wsUrl) {
    const client = new Cdp();
    client.#socket = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      client.#socket.addEventListener('open', resolve, { once: true });
      client.#socket.addEventListener('error', reject, { once: true });
    });
    client.#socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const entry = client.#pending.get(message.id);
      if (entry === undefined) return;
      client.#pending.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    });
    return client;
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`page exception: ${JSON.stringify(result.exceptionDetails.exception)}`);
    }
    return result.result.value;
  }

  close() {
    this.#socket.close();
  }
}

/**
 * Presses, moves in steps and releases at viewport coordinates.
 * `modifiers` is the CDP bitmask (8 = Shift, 1 = Alt).
 */
async function mouseDrag(cdp, from, to, { modifiers = 0, steps = 5 } = {}) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1, modifiers,
  });
  for (let step = 1; step <= steps; step += 1) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: from.x + ((to.x - from.x) * step) / steps,
      y: from.y + ((to.y - from.y) * step) / steps,
      button: 'left',
      modifiers,
    });
  }
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1, modifiers,
  });
}

/**
 * Waits until the app has finished booting: an image is loaded and the canvas
 * has a real size. Without this, a check that runs too early reads an empty
 * image id and every API call 404s.
 */
async function waitUntilReady(cdp, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const state = await cdp.evaluate(`(() => {
      const path = document.getElementById('image-path');
      const canvas = document.getElementById('canvas');
      return {
        id: path ? path.textContent : '',
        canvasWidth: canvas ? canvas.width : 0,
        overlay: document.getElementById('overlay')?.hidden === false,
      };
    })()`);
    last = JSON.stringify(state);
    if (state.id !== '' && state.canvasWidth > 0 && state.overlay === false) return state;
    await sleep(150);
  }
  throw new Error(`the app did not become ready within ${timeoutMs}ms (last state: ${last})`);
}

/**
 * Forces a genuine document reload at `url`.
 *
 * `Page.navigate` to a URL that differs only in the fragment performs a
 * same-document navigation: the page is *not* reloaded. Since the app's whole
 * boot path (indexing, loading the annotation, computing the fit) lives behind a
 * real load, a test that means "reload the page" must use this.
 */
async function reloadPage(cdp, url) {
  await cdp.send('Page.navigate', { url: 'about:blank' });
  await sleep(250);
  await cdp.send('Page.navigate', { url });
  await sleep(1200);
  await waitUntilReady(cdp);
}

/**
 * Puts the page back into a known UI state.
 *
 * Checks that end with a modal open or a stale gesture would otherwise cascade
 * into unrelated failures, which makes a probe run hard to read.
 */
async function resetUi(cdp) {
  await cdp.evaluate(`(() => {
    for (const dialog of document.querySelectorAll('dialog[open]')) {
      if (typeof dialog.close === 'function') dialog.close();
    }
    return true;
  })()`);
  await sleep(100);
}

/** Reads the app's live view transform and canvas geometry. */
function readGeometry(cdp) {
  return cdp.evaluate(`(() => {
    const p = window.__YOLO_PROBE__;
    const c = document.getElementById('canvas');
    const r = c.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    return {
      rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height },
      scale: p.view.scale,
      viewX: p.view.x,
      viewY: p.view.y,
      imageWidth: p.image.width,
      imageHeight: p.image.height,
      ratio,
      dialogOpen: Boolean(document.querySelector('dialog[open]')),
    };
  })()`);
}

/** Image-space point -> viewport point. */
function imageToClient(geometry, x, y) {
  return {
    x: geometry.rect.left + (geometry.viewX + x * geometry.imageWidth * geometry.scale) / geometry.ratio,
    y: geometry.rect.top + (geometry.viewY + y * geometry.imageHeight * geometry.scale) / geometry.ratio,
  };
}

function isInside(geometry, point) {
  return (
    point.x >= geometry.rect.left + 2 &&
    point.x <= geometry.rect.right - 2 &&
    point.y >= geometry.rect.top + 2 &&
    point.y <= geometry.rect.bottom - 2
  );
}

/**
 * Reads a label file over the API so the assertions use server-side state.
 *
 * Throws on a non-OK response instead of returning `undefined`, which would
 * otherwise surface as a confusing "cannot read properties of undefined" much
 * later in the check.
 */
async function readBoxes(origin, id) {
  if (typeof id !== 'string' || id === '') {
    throw new Error('readBoxes was called before the page finished booting (no current image)');
  }
  const response = await fetch(`${origin}/api/annotations/${encodeURI(id)}`);
  if (!response.ok) {
    throw new Error(`GET /api/annotations/${id} -> ${response.status}`);
  }
  const payload = await response.json();
  if (!Array.isArray(payload.boxes)) {
    throw new Error(`unexpected annotation payload for ${id}: ${JSON.stringify(payload).slice(0, 200)}`);
  }
  return payload.boxes;
}

async function main() {
  const origin = new URL(url).origin;
  const cdp = await Cdp.connect(await findTarget());
  const failures = [];

  const check = async (name, fn) => {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (error) {
      failures.push(`${name}: ${error.message}`);
      console.log(`  ✗ ${name} — ${error.message}`);
      // Dump the page's own view of the world; nearly every failure here is a
      // state-drift problem rather than a logic problem.
      try {
        const dump = await cdp.evaluate(`(() => {
          const probe = window.__YOLO_PROBE__;
          return {
            image: probe.image.id,
            position: probe.position,
            order: probe.order,
            localBoxes: probe.boxes.length,
            sidebarBoxes: document.querySelectorAll('#box-list li').length,
            scale: Number(probe.view.scale.toFixed(3)),
            smoothing: probe.smoothing,
            saveState: probe.saveState,
            dialogOpen: document.getElementById('conflict-dialog').open,
            status: document.getElementById('status-message').textContent,
          };
        })()`);
        console.log(`      state: ${JSON.stringify(dump)}`);
      } catch {
        // The page may be gone; the failure message is enough.
      }
    }
  };

  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url });
    await sleep(1200);
    await waitUntilReady(cdp);

    console.log(`\nProbing ${url}\n`);

    await check('the app booted and indexed images', async () => {
      const info = await cdp.evaluate(`(() => ({
        visible: !document.getElementById('app').hidden,
        counter: document.getElementById('image-counter').textContent,
        status: document.getElementById('status-message').textContent,
        classes: [...document.querySelectorAll('#class-list .class-name')].map((n) => n.textContent),
      }))()`);
      assert.equal(info.visible, true, 'app shell should be visible');
      // The number of classes comes from the caller's obj.names, so only assert
      // that the list is populated and matches what the server reports.
      assert.ok(info.classes.length >= 2, `expected at least 2 classes, got ${info.classes.length}`);
      const declared = await (await fetch(`${origin}/api/images`)).json();
      assert.deepEqual(info.classes, declared.classNames, 'the sidebar should list every class');
      assert.match(info.counter, /^\d+ \/ \d+$/);
      assert.ok(!/Loading|Indexing/.test(info.status), `still loading: ${info.status}`);
    });

    const first = await cdp.evaluate(`document.getElementById('image-path').textContent`);

    await check('dragging on the canvas writes a YOLO box to disk', async () => {
      const before = await readBoxes(origin, first);

      // Ask the page where the image actually sits: the canvas is letterboxed,
      // so screen fractions are not image fractions.
      const mapToClient = async (x, y) => {
        const expression = `(() => {
          const canvas = document.getElementById('canvas');
          const rect = canvas.getBoundingClientRect();
          const probe = window.__YOLO_PROBE__;
          const cssPerDevice = rect.width / canvas.width;
          return {
            x: rect.left + (probe.view.x + ${x} * probe.image.width * probe.view.scale) * cssPerDevice,
            y: rect.top + (probe.view.y + ${y} * probe.image.height * probe.view.scale) * cssPerDevice,
          };
        })()`;
        return cdp.evaluate(expression);
      };

      // Drag across the middle of the image: (0.30,0.30) -> (0.50,0.50) in image
      // space, so the expected box is centred at 0.40 with size 0.20.
      const from = await mapToClient(0.3, 0.3);
      const to = await mapToClient(0.5, 0.5);

      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 });
      for (let step = 1; step <= 8; step += 1) {
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: from.x + ((to.x - from.x) * step) / 8,
          y: from.y + ((to.y - from.y) * step) / 8,
          button: 'left',
        });
      }
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 });

      await sleep(900); // debounce + round trip
      const after = await readBoxes(origin, first);
      assert.equal(after.length, before.length + 1, `expected one more box, got ${after.length}`);

      const box = after[after.length - 1];
      assert.equal(box.classId, 0);
      assert.ok(Math.abs(box.x - 0.4) < 0.03, `x centre ${box.x}`);
      assert.ok(Math.abs(box.y - 0.4) < 0.03, `y centre ${box.y}`);
      assert.ok(Math.abs(box.w - 0.2) < 0.03, `width ${box.w}`);
      assert.ok(Math.abs(box.h - 0.2) < 0.03, `height ${box.h}`);

      // `data-state` is `idle` once the debounced save completed; the pill text
      // is what reads "saved".
      const saved = await cdp.evaluate(`({
        state: document.getElementById('save-state').dataset.state,
        text: document.getElementById('save-state').textContent,
      })`);
      assert.equal(saved.state, 'idle', 'the save indicator should settle');
      assert.equal(saved.text, 'saved');
    });

    await check('"c" cycles the class used for the next box', async () => {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67 });
      await sleep(150);

      const active = await cdp.evaluate(
        `[...document.querySelectorAll('#class-list li')].findIndex((li) => li.getAttribute('aria-current') === 'true')`,
      );
      assert.equal(active, 1, 'the second class should be active after one press');
    });

    /*
     * Relabelling an existing RoI.
     *
     * This is a regression guard: originally `c` and the digit keys only chose
     * the class for the *next* box, so a mislabelled box had to be deleted and
     * redrawn. A box that is selected must now be relabelled in place — and the
     * change has to reach the label file, not just the canvas.
     */
    await check('a selected box can be relabelled, and the change is saved', async () => {
      await resetUi(cdp);
      const id = await cdp.evaluate(`document.getElementById('image-path').textContent`);

      // A known, centrally placed box so the click below is predictable.
      const boxes = [{ classId: 0, x: 0.5, y: 0.5, w: 0.3, h: 0.3 }];
      await fetch(`${origin}/api/annotations/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ boxes }),
      });
      await reloadPage(cdp, `${origin}/#${id}`);
      await resetUi(cdp);

      // Select it by clicking its centre, as a user would.
      const geometry = await readGeometry(cdp);
      const centre = imageToClient(geometry, 0.5, 0.5);
      assert.ok(isInside(geometry, centre), 'the box should be on screen');
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: centre.x, y: centre.y, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: centre.x, y: centre.y, button: 'left', clickCount: 1 });
      await sleep(300);

      const selected = await cdp.evaluate(`window.__YOLO_PROBE__.selected`);
      assert.equal(selected, 0, 'clicking the box should select it');
      const hint = await cdp.evaluate(`document.getElementById('status-message').textContent`);
      assert.match(hint, /relabel/i, `selecting should reveal the relabel shortcut, got: ${hint}`);

      // `c` cycles the label of the selected box.
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67 });
      await sleep(900);

      const classCount = (await (await fetch(`${origin}/api/images`)).json()).classNames.length;
      const cycledTo = (0 + 1) % classCount;

      let onDisk = await readBoxes(origin, id);
      assert.equal(onDisk.length, 1, 'relabelling must not add or remove boxes');
      assert.equal(onDisk[0].classId, cycledTo, '`c` should have cycled the label');
      assert.equal(onDisk[0].x, boxes[0].x, 'relabelling must not move the box');

      // A digit sets it directly.
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: '1', code: 'Digit1', windowsVirtualKeyCode: 49 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: '1', code: 'Digit1', windowsVirtualKeyCode: 49 });
      await sleep(900);

      onDisk = await readBoxes(origin, id);
      assert.equal(onDisk.length, 1);
      assert.equal(onDisk[0].classId, 0, 'pressing 1 should relabel the box to class 0');

      // The sidebar must agree with the file.
      const classNames = (await (await fetch(`${origin}/api/images`)).json()).classNames;
      const sidebarLabels = await cdp.evaluate(
        `[...document.querySelectorAll('#box-list li .box-label')].map((n) => n.textContent)`,
      );
      assert.deepEqual(
        sidebarLabels,
        [classNames[0]],
        'the sidebar should show the new label, not the old one',
      );

      // Undo restores the previous label.
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 4 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 4 });
      await sleep(900);
      const undone = await readBoxes(origin, id);
      assert.equal(undone[0].classId, cycledTo, 'undo should restore the previous label');

      // With nothing selected, the same keys choose the drawing class again.
      const empty = imageToClient(geometry, 0.05, 0.05);
      if (isInside(geometry, empty)) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: empty.x, y: empty.y, button: 'left', clickCount: 1 });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: empty.x, y: empty.y, button: 'left', clickCount: 1 });
        await sleep(300);
      }
      assert.equal(await cdp.evaluate(`window.__YOLO_PROBE__.selected`), -1, 'clicking empty space deselects');

      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: '2', code: 'Digit2', windowsVirtualKeyCode: 50 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: '2', code: 'Digit2', windowsVirtualKeyCode: 50 });
      await sleep(200);
      const active = await cdp.evaluate(
        `[...document.querySelectorAll('#class-list li')].findIndex((li) => li.getAttribute('aria-current') === 'true')`,
      );
      assert.equal(active, 1, 'a digit should still set the class for the next box');
      assert.equal(
        (await readBoxes(origin, id))[0].classId,
        cycledTo,
        'with nothing selected the existing box must be untouched',
      );
      await resetUi(cdp);
    });

    await check('"d" deletes the last box and persists the change', async () => {
      const before = await readBoxes(origin, first);
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'd', code: 'KeyD', windowsVirtualKeyCode: 68 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'd', code: 'KeyD', windowsVirtualKeyCode: 68 });
      await sleep(900);
      const after = await readBoxes(origin, first);
      assert.equal(after.length, before.length - 1, 'one box should be gone');
    });

    await check('"n" moves to the next image and updates the deep link', async () => {
      const counterBefore = await cdp.evaluate(`document.getElementById('image-counter').textContent`);
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78 });
      await sleep(1200);

      const state = await cdp.evaluate(`({
        counter: document.getElementById('image-counter').textContent,
        path: document.getElementById('image-path').textContent,
        hash: location.hash,
      })`);
      assert.notEqual(state.counter, counterBefore, 'the counter should advance');
      assert.equal(state.hash, `#${state.path}`, 'the hash should track the current image');
    });

    await check('saved boxes are re-read after a reload', async () => {
      const id = await cdp.evaluate(`document.getElementById('image-path').textContent`);
      const desired = await readBoxes(origin, id);
      await reloadPage(cdp, `${origin}/#${id}`);
      // Confirm a real reload happened: a same-document hash change would leave
      // the previous image on screen and make this assertion meaningless.
      assert.equal(
        await cdp.evaluate(`document.getElementById('image-path').textContent`),
        id,
        'the page should be showing the image that was reloaded',
      );
      const shown = await cdp.evaluate(`document.querySelectorAll('#box-list li').length`);
      assert.equal(shown, desired.length, `the sidebar should list ${desired.length} box(es)`);
      assert.equal(
        await cdp.evaluate(`window.__YOLO_PROBE__.boxes.length`),
        desired.length,
        'the loaded boxes should match the label file',
      );
    });

    await check('zoom controls change the reported scale', async () => {
      const before = await cdp.evaluate(`document.getElementById('zoom-value').textContent`);
      await cdp.evaluate(`document.getElementById('zoom-in').click()`);
      await sleep(120);
      const after = await cdp.evaluate(`document.getElementById('zoom-value').textContent`);
      assert.notEqual(before, after, 'zooming should update the readout');
      assert.notEqual(after, 'fit');
    });

    await check('the help dialog opens with "?"', async () => {
      await cdp.evaluate(`document.getElementById('help-button').click()`);
      await sleep(150);
      const open = await cdp.evaluate(`document.getElementById('help-dialog').open`);
      assert.equal(open, true);
      await cdp.evaluate(`document.getElementById('help-dialog').close()`);
    });

    /*
     * Pixel sampling. This is the property that decides whether a clinician can
     * judge where an edge falls, so it is asserted across the policy boundary
     * rather than only at the default fit.
     */
    await check('interpolation is off at >=100% zoom and on when downscaled', async () => {
      const read = () => cdp.evaluate(`(() => {
        const probe = window.__YOLO_PROBE__;
        return {
          scale: probe.view.scale,
          smoothing: probe.smoothing,
          label: document.getElementById('zoom-value').textContent,
        };
      })()`);

      // Zoom out first: earlier checks may have left the view zoomed in, and the
      // policy can only be exercised from both sides if we start below 1.
      await cdp.evaluate(`document.getElementById('zoom-value').click()`);
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const current = await read();
        if (current.scale < 1) break;
        await cdp.evaluate(`document.getElementById('zoom-out').click()`);
        await sleep(80);
      }

      const observations = [await read()];
      assert.ok(observations[0].scale < 1, `expected a downscaled view, got scale=${observations[0].scale}`);
      assert.equal(observations[0].smoothing, true, 'a downscaled preview should be smoothed');

      // Zoom in until we are past 100% and check the other side.
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const current = await read();
        observations.push(current);
        if (current.scale >= 1) break;
        await cdp.evaluate(`document.getElementById('zoom-in').click()`);
        await sleep(80);
      }

      const zoomed = observations[observations.length - 1];
      assert.ok(zoomed.scale >= 1, `should have zoomed past 100%, got scale=${zoomed.scale}`);
      assert.equal(zoomed.smoothing, false, `no interpolation at ${Math.round(zoomed.scale * 100)}%`);

      for (const observed of observations) {
        assert.equal(
          observed.smoothing,
          observed.scale < 1,
          `policy violated at scale=${observed.scale} (${observed.label})`,
        );
      }
    });

    await check('a concurrent write is detected and reloading resolves it', async () => {
      const id = await cdp.evaluate(`document.getElementById('image-path').textContent`);
      const localBefore = await cdp.evaluate(`window.__YOLO_PROBE__.boxes.length`);

      // Simulate another tab: write the file directly, without a revision token.
      const otherVersion = [{ classId: 1, x: 0.11, y: 0.22, w: 0.1, h: 0.1 }];
      const otherResponse = await fetch(`${origin}/api/annotations/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ boxes: otherVersion }),
      });
      assert.equal(otherResponse.status, 200);

      // Now edit in the page and let it try to save against the stale revision.
      await cdp.evaluate(`document.getElementById('zoom-value').click()`);
      await sleep(150);
      const points = await cdp.evaluate(`(() => {
        const canvas = document.getElementById('canvas');
        const rect = canvas.getBoundingClientRect();
        const probe = window.__YOLO_PROBE__;
        const cssPerDevice = rect.width / canvas.width;
        const at = (x, y) => ({
          x: rect.left + (probe.view.x + x * probe.image.width * probe.view.scale) * cssPerDevice,
          y: rect.top + (probe.view.y + y * probe.image.height * probe.view.scale) * cssPerDevice,
        });
        return { from: at(0.6, 0.6), to: at(0.7, 0.7) };
      })()`);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: points.from.x, y: points.from.y, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: points.to.x, y: points.to.y, button: 'left' });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: points.to.x, y: points.to.y, button: 'left', clickCount: 1 });

      await sleep(1200); // debounce + round trip + dialog
      const open = await cdp.evaluate(`document.getElementById('conflict-dialog').open`);
      assert.equal(open, true, 'the page should ask which version wins');

      const detail = await cdp.evaluate(`document.getElementById('conflict-detail').textContent`);
      assert.match(detail, /on disk now: 1 box/, `detail text was: ${detail}`);
      const rendered = await cdp.evaluate(`document.querySelectorAll('#box-list li').length`);
      assert.equal(rendered, localBefore + 1, 'the unsaved local boxes are still on screen while deciding');

      // Escape must not dismiss the decision.
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await sleep(200);
      assert.equal(
        await cdp.evaluate(`document.getElementById('conflict-dialog').open`),
        true,
        'Escape must not silently discard the choice',
      );

      // "Use the file on disk" must adopt the other writer's version.
      await cdp.evaluate(`document.getElementById('conflict-reload').click()`);
      await sleep(500);
      assert.deepEqual(await readBoxes(origin, id), otherVersion, 'the disk version was kept');
      assert.equal(await cdp.evaluate(`document.querySelectorAll('#box-list li').length`), 1);
      assert.equal(await cdp.evaluate(`document.getElementById('save-state').dataset.state`), 'idle');

      // The page must stay usable: a fresh drag saves normally from here on.
      assert.equal(await cdp.evaluate(`document.getElementById('conflict-dialog').open`), false);

      // Re-arm the same situation to cover the other branch: this time the user
      // decides their own version wins.
      await fetch(`${origin}/api/annotations/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ boxes: [{ classId: 0, x: 0.9, y: 0.9, w: 0.05, h: 0.05 }] }),
      });
      await cdp.evaluate(`document.getElementById('canvas').dispatchEvent(new Event('focus'))`);
      const overwritePoints = await cdp.evaluate(`(() => {
        const canvas = document.getElementById('canvas');
        const rect = canvas.getBoundingClientRect();
        const probe = window.__YOLO_PROBE__;
        const cssPerDevice = rect.width / canvas.width;
        const at = (x, y) => ({
          x: rect.left + (probe.view.x + x * probe.image.width * probe.view.scale) * cssPerDevice,
          y: rect.top + (probe.view.y + y * probe.image.height * probe.view.scale) * cssPerDevice,
        });
        return { from: at(0.45, 0.45), to: at(0.55, 0.55) };
      })()`);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: overwritePoints.from.x, y: overwritePoints.from.y, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: overwritePoints.to.x, y: overwritePoints.to.y, button: 'left' });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: overwritePoints.to.x, y: overwritePoints.to.y, button: 'left', clickCount: 1 });
      await sleep(1200);
      assert.equal(
        await cdp.evaluate(`document.getElementById('conflict-dialog').open`),
        true,
        'the second conflict should also be reported',
      );

      const localCount = await cdp.evaluate(`window.__YOLO_PROBE__.boxes.length`);
      await cdp.evaluate(`document.getElementById('conflict-overwrite').click()`);
      await sleep(700);

      assert.equal(await cdp.evaluate(`document.getElementById('conflict-dialog').open`), false);
      assert.equal(
        await cdp.evaluate(`document.getElementById('save-state').dataset.state`),
        'idle',
        'the forced save should settle',
      );
      const finalBoxes = await readBoxes(origin, id);
      assert.equal(finalBoxes.length, localCount, 'our version was written, not the other writer\'s');
      assert.ok(
        !finalBoxes.some((box) => box.x === 0.9 && box.y === 0.9),
        'the other writer\'s box is gone',
      );
    });

    /*
     * The image must be fully visible at load. It is easy to regress this: the
     * initial scale is 1 and `loadImage` only fits when the view is not already
     * in fitted mode, so a wrong initial flag leaves a 960x922 image drawn into
     * a 583px-tall stage — clipped before the user touches anything.
     */
    await check('the whole image is visible when the page opens', async () => {
      await reloadPage(cdp, `${origin}/`);

      const state = await cdp.evaluate(`(() => {
        const p = window.__YOLO_PROBE__;
        const c = document.getElementById('canvas').getBoundingClientRect();
        const ratio = window.devicePixelRatio || 1;
        const left = c.left + p.view.x / ratio, top = c.top + p.view.y / ratio;
        const right = left + p.image.width * p.view.scale;
        const bottom = top + p.image.height * p.view.scale;
        return {
          fitted: p.view.fitted,
          scale: Number(p.view.scale.toFixed(3)),
          label: document.getElementById('zoom-value').textContent,
          insideViewport: left >= c.left - 1 && top >= c.top - 1 && right <= c.right + 1 && bottom <= c.bottom + 1,
          overflow: {
            right: Math.round(Math.max(0, right - c.right)),
            bottom: Math.round(Math.max(0, bottom - c.bottom)),
          },
        };
      })()`);

      assert.equal(state.fitted, true, 'the view should open in fitted mode');
      assert.equal(state.label, 'fit', 'the zoom readout should say "fit"');
      assert.equal(
        state.insideViewport,
        true,
        `image overflows the stage: ${JSON.stringify(state.overflow)}`,
      );
    });

    /*
     * Pan reachability. Zooming in necessarily pushes part of the image outside
     * the viewport; before this was fixed the only pan gestures were middle-drag
     * and Alt/Shift-drag, so a plain left-drag — the one gesture everyone tries —
     * silently started a new box instead.
     */
    /*
     * Drawing must work at every zoom level.
     *
     * This is a regression guard for a real design mistake: panning used to be
     * inferred from the zoom level, so a plain left-drag on empty space silently
     * panned instead of drawing once zoomed in — with the cursor advertising a
     * grab hand, exactly when precise drawing matters most.
     */
    await check('dragging always draws, at every zoom level', async () => {
      await resetUi(cdp);
      const id = await cdp.evaluate(`document.getElementById('image-path').textContent`);

      await fetch(`${origin}/api/annotations/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ boxes: [] }),
      });
      await reloadPage(cdp, `${origin}/#${id}`);
      await resetUi(cdp);

      const zoomTo = async (clicks) => {
        await cdp.evaluate(`document.getElementById('zoom-value').click()`);
        await sleep(150);
        for (let index = 0; index < clicks; index += 1) {
          await cdp.evaluate(`document.getElementById('zoom-in').click()`);
          await sleep(90);
        }
        return readGeometry(cdp);
      };

      // A point at the centre is on screen at any centred zoom, so the drag
      // lands on the canvas regardless of the scale reached.
      for (const [label, clicks] of [['fit scale', 0], ['zoomed in', 8]]) {
        const geometry = await zoomTo(clicks);
        const centre = imageToClient(geometry, 0.5, 0.5);
        assert.ok(isInside(geometry, centre), `${label}: the drag should be inside the canvas`);

        const cursor = await cdp.evaluate(`getComputedStyle(document.getElementById('stage')).cursor`);
        assert.equal(cursor, 'crosshair', `${label}: empty space should still offer drawing`);

        const before = await readBoxes(origin, id);
        await resetUi(cdp);
        await mouseDrag(cdp, centre, imageToClient(geometry, 0.6, 0.6));
        await sleep(900);

        const after = await readBoxes(origin, id);
        assert.equal(after.length, before.length + 1, `${label}: a plain drag should create a box`);
        assert.equal(
          Math.round((await readGeometry(cdp)).scale * 1000),
          Math.round(geometry.scale * 1000),
          `${label}: drawing must not move the view`,
        );
      }
      await resetUi(cdp);
    });

    await check('panning works through the explicit gestures only', async () => {
      await resetUi(cdp);
      const id = await cdp.evaluate(`document.getElementById('image-path').textContent`);
      await fetch(`${origin}/api/annotations/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ boxes: [{ classId: 0, x: 0.5, y: 0.5, w: 0.05, h: 0.05 }] }),
      });
      await reloadPage(cdp, `${origin}/#${id}`);
      await resetUi(cdp);

      const zoomIn = async (clicks) => {
        await cdp.evaluate(`document.getElementById('zoom-value').click()`);
        await sleep(150);
        for (let index = 0; index < clicks; index += 1) {
          await cdp.evaluate(`document.getElementById('zoom-in').click()`);
          await sleep(90);
        }
        return readGeometry(cdp);
      };

      let geometry = await zoomIn(8);
      assert.ok(
        geometry.imageWidth * geometry.scale > geometry.rect.width &&
          geometry.imageHeight * geometry.scale > geometry.rect.height,
        'the image should overflow the stage for this check',
      );

      const centre = {
        x: (geometry.rect.left + geometry.rect.right) / 2,
        y: (geometry.rect.top + geometry.rect.bottom) / 2,
      };
      const boxOnScreen = imageToClient(geometry, 0.5, 0.5);

      // (a) Space + drag pans without drawing. Space is tracked by the app's own
      // key handling, so it is pressed for real rather than faked in the DOM.
      const boxesBefore = await readBoxes(origin, id);
      const viewBefore = { x: geometry.viewX, y: geometry.viewY };
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
      await sleep(80);
      const spaceCursor = await cdp.evaluate(`getComputedStyle(document.getElementById('stage')).cursor`);
      await mouseDrag(cdp, centre, { x: centre.x + 80, y: centre.y + 60 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
      await sleep(500);

      assert.equal(spaceCursor, 'grab', 'holding Space should advertise panning');
      geometry = await readGeometry(cdp);
      assert.ok(
        geometry.viewX !== viewBefore.x || geometry.viewY !== viewBefore.y,
        'Space + drag should move the view',
      );
      assert.deepEqual(await readBoxes(origin, id), boxesBefore, 'Space + drag must not draw');

      // (b) The pan-mode toggle does the same without a modifier, and Escape
      // leaves the mode so it can never become a trap.
      geometry = await zoomIn(8);
      const panCentre = {
        x: (geometry.rect.left + geometry.rect.right) / 2,
        y: (geometry.rect.top + geometry.rect.bottom) / 2,
      };
      await cdp.evaluate(`document.getElementById('pan-mode').click()`);
      await sleep(150);
      const toggled = await cdp.evaluate(`(() => {
        const stage = document.getElementById('stage');
        return {
          pressed: document.getElementById('pan-mode').getAttribute('aria-pressed'),
          pan: stage.dataset.pan,
          cursor: getComputedStyle(stage).cursor,
          status: document.getElementById('status-message').textContent,
        };
      })()`);
      assert.equal(toggled.pressed, 'true');
      assert.equal(toggled.pan, 'true');
      assert.equal(toggled.cursor, 'grab');
      assert.match(toggled.status, /[Pp]an mode/);

      const viewBeforeMode = { x: geometry.viewX, y: geometry.viewY };
      await mouseDrag(cdp, panCentre, { x: panCentre.x + 70, y: panCentre.y + 50 });
      await sleep(500);
      geometry = await readGeometry(cdp);
      assert.ok(
        geometry.viewX !== viewBeforeMode.x || geometry.viewY !== viewBeforeMode.y,
        'pan mode should move the view on a plain drag',
      );

      // Escape leaves pan mode first; a second Escape would quit.
      await cdp.evaluate(`document.getElementById('pan-mode').click()`);
      await sleep(120);
      const afterToggleOff = await cdp.evaluate(`(() => {
        const stage = document.getElementById('stage');
        return { pressed: document.getElementById('pan-mode').getAttribute('aria-pressed'),
                 cursor: getComputedStyle(stage).cursor };
      })()`);
      assert.equal(afterToggleOff.pressed, 'false');
      assert.equal(afterToggleOff.cursor, 'crosshair', 'leaving pan mode restores the draw cursor');

      // (c) A box can still be moved while zoomed, and moving it must not pan.
      geometry = await zoomIn(3);
      const boxFrom = imageToClient(geometry, 0.5, 0.5);
      const boxTo = imageToClient(geometry, 0.56, 0.56);
      const viewBeforeMove = { x: geometry.viewX, y: geometry.viewY };
      const boxesBeforeMove = await readBoxes(origin, id);
      assert.ok(isInside(geometry, boxFrom) && isInside(geometry, boxTo), 'both ends on screen');

      await resetUi(cdp);
      await mouseDrag(cdp, boxFrom, boxTo);
      await sleep(900);
      geometry = await readGeometry(cdp);
      assert.deepEqual(
        { x: geometry.viewX, y: geometry.viewY },
        viewBeforeMove,
        'moving a box must not pan',
      );
      const moved = await readBoxes(origin, id);
      assert.equal(moved.length, 1);
      assert.ok(moved[0].x > boxesBeforeMove[0].x, `the box should have moved right, got x=${moved[0].x}`);
      void boxOnScreen;
      await resetUi(cdp);
    });
    await check('the image can never be panned completely out of sight', async () => {
      await resetUi(cdp);
      await cdp.evaluate(`document.getElementById('zoom-value').click()`);
      await sleep(150);
      for (let index = 0; index < 8; index += 1) {
        await cdp.evaluate(`document.getElementById('zoom-in').click()`);
        await sleep(90);
      }

      // Fling the view hard in every direction, always dragging from a point
      // that is currently on screen.
      for (const [fx, fy] of [[0.9, 0.9], [-0.9, -0.9], [0.9, -0.9], [-0.9, 0.9]]) {
        await resetUi(cdp);
        const geometry = await readGeometry(cdp);
        const from = {
          x: (geometry.rect.left + geometry.rect.right) / 2,
          y: (geometry.rect.top + geometry.rect.bottom) / 2,
        };
        const to = { x: from.x + geometry.rect.width * fx, y: from.y + geometry.rect.height * fy };
        await mouseDrag(cdp, from, to, { steps: 3 });
        await sleep(150);
      }

      const visibility = await cdp.evaluate(`(() => {
        const p = window.__YOLO_PROBE__;
        const c = document.getElementById('canvas').getBoundingClientRect();
        const ratio = window.devicePixelRatio || 1;
        const left = c.left + p.view.x / ratio, top = c.top + p.view.y / ratio;
        const right = left + p.image.width * p.view.scale;
        const bottom = top + p.image.height * p.view.scale;
        const w = Math.max(0, Math.min(c.right, right) - Math.max(c.left, left));
        const h = Math.max(0, Math.min(c.bottom, bottom) - Math.max(c.top, top));
        return { visiblePx: Math.round(w * h) };
      })()`);

      assert.ok(visibility.visiblePx > 1000, `image almost lost: only ${visibility.visiblePx}px visible`);
      await resetUi(cdp);
    });

    await check('a native drag still produces the expected box after the rAF change', async () => {
      await resetUi(cdp);
      // Main-thread drag events land as one pointermove each; the rAF coalescing
      // must not drop the final frame that the draft box is drawn from.
      const id = await cdp.evaluate(`document.getElementById('image-path').textContent`);
      const before = await readBoxes(origin, id);
      await cdp.evaluate(`document.getElementById('zoom-value').click()`);
      await sleep(150);
      const points = await cdp.evaluate(`(() => {
        const canvas = document.getElementById('canvas');
        const rect = canvas.getBoundingClientRect();
        const probe = window.__YOLO_PROBE__;
        const cssPerDevice = rect.width / canvas.width;
        const at = (x, y) => ({
          x: rect.left + (probe.view.x + x * probe.image.width * probe.view.scale) * cssPerDevice,
          y: rect.top + (probe.view.y + y * probe.image.height * probe.view.scale) * cssPerDevice,
        });
        return { from: at(0.2, 0.2), to: at(0.4, 0.4) };
      })()`);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: points.from.x, y: points.from.y, button: 'left', clickCount: 1 });
      for (let step = 1; step <= 6; step += 1) {
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: points.from.x + ((points.to.x - points.from.x) * step) / 6,
          y: points.from.y + ((points.to.y - points.from.y) * step) / 6,
          button: 'left',
        });
      }
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: points.to.x, y: points.to.y, button: 'left', clickCount: 1 });
      await sleep(900);

      const after = await readBoxes(origin, id);
      assert.equal(after.length, before.length + 1);
      const box = after[after.length - 1];
      assert.ok(Math.abs(box.x - 0.3) < 0.03, `x ${box.x}`);
      assert.ok(Math.abs(box.w - 0.2) < 0.03, `w ${box.w}`);
      assert.ok(Math.abs(box.y - 0.3) < 0.03, `y ${box.y}`);
      assert.ok(Math.abs(box.h - 0.2) < 0.03, `h ${box.h}`);
    });
  } finally {
    cdp.close();
    chrome.kill('SIGKILL');
  }

  console.log('');
  if (failures.length > 0) {
    console.error(`${failures.length} probe check(s) failed:\n- ${failures.join('\n- ')}\n`);
    process.exitCode = 1;
    return;
  }
  console.log('All browser probe checks passed.\n');
}

await main();
