/**
 * YOLO Annotator — browser client.
 *
 * Plain ES modules, no build step, no dependencies. Loaded with
 * `<script type="module">`, which gives us strict mode and deferred execution.
 *
 * Coordinate systems used throughout:
 *   image space  — pixels of the source image, the only place boxes are stored
 *   device space — canvas pixels, i.e. image space scaled by `view.scale`
 *   screen space — CSS pixels relative to the stage, used for mouse events
 *
 * Boxes are *always* stored in image space. The view transform is applied at
 * draw time only, which keeps annotation data independent of zoom and of the
 * window size, and matches what gets written to the YOLO label file.
 */

/* ------------------------------------------------------------------ setup */

const bootstrap = window.__YOLO__ ?? {};
const SHUTDOWN_TOKEN = bootstrap.shutdownToken ?? '';
const API_ROOT = '/api';

const el = {
  app: document.getElementById('app'),
  canvas: document.getElementById('canvas'),
  stage: document.getElementById('stage'),
  imagePath: document.getElementById('image-path'),
  imageCounter: document.getElementById('image-counter'),
  imageSize: document.getElementById('image-size'),
  saveState: document.getElementById('save-state'),
  classList: document.getElementById('class-list'),
  classesSource: document.getElementById('classes-source'),
  groupList: document.getElementById('group-list'),
  boxList: document.getElementById('box-list'),
  boxesEmpty: document.getElementById('boxes-empty'),
  progressFill: document.getElementById('progress-fill'),
  progressText: document.getElementById('progress-text'),
  warningList: document.getElementById('warning-list'),
  statusMessage: document.getElementById('status-message'),
  zoomValue: document.getElementById('zoom-value'),
  overlay: document.getElementById('overlay'),
  overlayText: document.getElementById('overlay-text'),
  jumpDialog: document.getElementById('jump-dialog'),
  jumpInput: document.getElementById('jump-input'),
  jumpHint: document.getElementById('jump-hint'),
  helpDialog: document.getElementById('help-dialog'),
  panModeButton: document.getElementById('pan-mode'),
  datasetButton: document.getElementById('dataset-button'),
  setup: document.getElementById('setup'),
  setupTitle: document.getElementById('setup-title'),
  setupHint: document.getElementById('setup-hint'),
  setupImages: document.getElementById('setup-images'),
  setupClasses: document.getElementById('setup-classes'),
  setupError: document.getElementById('setup-error'),
  setupPickImages: document.getElementById('setup-pick-images'),
  setupPickClasses: document.getElementById('setup-pick-classes'),
  setupOpen: document.getElementById('setup-open'),
  conflictDialog: document.getElementById('conflict-dialog'),
  conflictMessage: document.getElementById('conflict-message'),
  conflictDetail: document.getElementById('conflict-detail'),
  conflictOverwrite: document.getElementById('conflict-overwrite'),
  conflictReload: document.getElementById('conflict-reload'),
};

const ctx = el.canvas.getContext('2d');

/** Class colours follow a deterministic golden-angle hue walk. */
function classColor(index) {
  const hue = (index * 137.508) % 360;
  return {
    stroke: `hsl(${hue.toFixed(1)} 85% 62%)`,
    fill: `hsl(${hue.toFixed(1)} 85% 62% / 0.14)`,
    label: `hsl(${hue.toFixed(1)} 85% 62% / 0.9)`,
    labelText: `hsl(${hue.toFixed(1)} 90% 12%)`,
  };
}

const state = {
  classesFile: '',
  imagesRoot: '',
  classNames: [],
  groups: [],
  /** Every discovered image, in the server's deterministic order. */
  allImages: [],
  /** Indices into `allImages` that pass the active group filter. */
  order: [],
  position: 0,
  /** Active group filter: '' means "all groups". */
  activeGroup: '',
  current: null,
  boxes: [],
  /** Exact label-file text last read from (or written to) disk, or null. */
  raw: null,
  selected: -1,
  currentClass: 0,
  history: [],
  rev: 0,
  /** Bumped on every edit; used to cancel superseded saves. */
  dirty: false,
  /** Set while a save conflict is waiting for the user's decision. */
  conflict: null,
  /** Problems found while parsing the *current* label file. */
  warnings: [],
  /** Problems reported by the server while indexing (bad files, duplicates). */
  serverWarnings: [],
};

const save = { status: 'idle', timer: null, promise: Promise.resolve(), detached: null };

/*
 * `fitted: false` means "the user has taken manual control of zoom/pan".
 * It must start false so that the first image is fitted to the window: the
 * initial scale of 1 would draw a 960px image into a 583px-tall stage and clip
 * most of it before the user ever touched the zoom controls.
 */
const view = { scale: 1, x: 0, y: 0, fitted: false };
/** Breathing room left around the image by "fit to window", in CSS pixels. */
const FIT_PADDING = 32;
const pointer = { mode: 'idle', startScreen: null, startImage: null };
const drag = { current: null, active: false, startImage: null };
/** Space is the conventional "pan" modifier; tracked so the cursor can react. */
let spaceHeld = false;
/** Sticky pan mode (the ✋ toggle / `p`), for trackpads. */
let panMode = false;
const imageCache = new Map();
let imageLoading = null;

/* -------------------------------------------------------------- utilities */

const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);

function basename(id) {
  const cut = id.lastIndexOf('/');
  return cut < 0 ? id : id.slice(cut + 1);
}

function setStatus(message, kind = '') {
  el.statusMessage.textContent = message;
  if (kind === '') el.statusMessage.removeAttribute('data-kind');
  else el.statusMessage.dataset.kind = kind;
}

function setSaveState(status) {
  save.status = status;
  el.saveState.dataset.state = status;
  el.saveState.textContent =
    status === 'saving' ? 'saving…' : status === 'error' ? 'save failed' : status === 'dirty' ? 'unsaved' : 'saved';
}

/** An API failure that keeps the HTTP status and any structured details. */
class ApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

async function api(path, options = {}) {
  const response = await fetch(`${API_ROOT}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  });
  const text = await response.text();
  let payload = null;
  if (text.trim() !== '') {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: text };
    }
  }
  if (!response.ok) {
    throw new ApiError(
      (payload && payload.error) || `${response.status} ${response.statusText}`,
      response.status,
      payload && payload.details,
    );
  }
  return payload;
}

/* --------------------------------------------------------------- load path */

function preload(id) {
  if (imageCache.has(id)) return Promise.resolve(imageCache.get(id));
  return new Promise((resolve) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      imageCache.set(id, image);
      // Keep memory bounded on large datasets.
      if (imageCache.size > 12) {
        const oldest = imageCache.keys().next().value;
        if (oldest !== undefined && oldest !== id) imageCache.delete(oldest);
      }
      resolve(image);
    };
    image.onerror = () => resolve(null);
    image.src = `${API_ROOT}/image/${id}`;
  });
}

async function loadImage(entry, direction = 0) {
  imageLoading = entry.id;
  state.current = entry;
  state.boxes = [];
  state.selected = -1;
  state.history = [];
  showOverlay(`Loading ${basename(entry.id)}…`);

  const [image, annotation] = await Promise.all([
    preload(entry.id),
    api(`/annotations/${entry.id}`).catch((error) => ({ boxes: [], warnings: [], error: error.message })),
  ]);

  // A newer navigation may have started while we were waiting.
  if (imageLoading !== entry.id) return;

  if (image === null) {
    hideOverlay();
    setStatus(`Could not decode ${entry.id}`, 'error');
    return;
  }

  entry.width = entry.width ?? image.naturalWidth;
  entry.height = entry.height ?? image.naturalHeight;
  state.boxes = (annotation.boxes ?? []).map((box) => ({ ...box }));
  state.warnings = annotation.warnings ?? [];
  /*
   * Remember exactly what is on disk right now. This is the optimistic-lock
   * token: the next save sends it back and the server refuses the write if the
   * file no longer matches, which is what stops a second tab (or a file sync
   * client) from silently discarding somebody's annotations.
   */
  state.raw = typeof annotation.raw === 'string' ? annotation.raw : null;
  state.rev = 0;
  state.dirty = false;
  setSaveState('idle');
  hideOverlay();

  if (!view.fitted) fitView();
  resetCanvas();
  draw();  renderSidebar();
  renderPath();
  renderCounter();
  focusCanvas();

  // Warm the neighbours so `n`/`p` feel instantaneous.
  const upcoming = state.order[state.position + direction] ?? state.order[state.position + 1];
  if (upcoming !== undefined) void preload(state.allImages[upcoming].id);

  if (state.warnings.length > 0) {
    setStatus(`${state.warnings.length} line(s) in the label file were skipped`, 'warn');
  }
}

/* ------------------------------------------------------------- navigation */

function currentImage() {
  const index = state.order[state.position];
  return index === undefined ? null : state.allImages[index];
}

function go(offset) {
  if (state.order.length === 0) return;
  const next = state.position + offset;
  if (next < 0 || next >= state.order.length) {
    setStatus(offset > 0 ? 'Last image' : 'First image');
    return;
  }
  void saveNow().then(() => {
    state.position = next;
    const entry = currentImage();
    if (entry !== null) void loadImage(entry, offset > 0 ? 1 : -1);
  });
}

function jumpTo(predicate, label) {
  const found = state.order.find((index) => predicate(state.allImages[index]));
  if (found === undefined) {
    setStatus(`No image matching "${label}"`, 'warn');
    return;
  }
  void saveNow().then(() => {
    state.position = state.order.indexOf(found);
    void loadImage(state.allImages[found], 1);
  });
}

function setGroupFilter(group) {
  state.activeGroup = group;
  state.order = state.allImages
    .map((image, index) => ({ image, index }))
    .filter(({ image }) => group === '' || image.group === group)
    .map(({ index }) => index);

  const currentId = state.current?.id;
  const positionOfCurrent = currentId === undefined ? -1 : state.order.findIndex((i) => state.allImages[i].id === currentId);
  state.position = positionOfCurrent >= 0 ? positionOfCurrent : 0;
  renderGroups();
  renderCounter();

  if (positionOfCurrent < 0 && state.order.length > 0) {
    void saveNow().then(() => loadImage(state.allImages[state.order[0]], 0));
  }
}

/**
 * Deep link: `#<image-id>` or `#i=<index>` selects the opening image. This makes
 * a session resumable and lets other tools point the annotator at one file.
 */
function applyHash() {
  const raw = decodeURIComponent(window.location.hash.replace(/^#/, '')).trim();
  if (raw === '') return null;

  const asIndex = /^(i=)?(\d+)$/.exec(raw);
  if (asIndex !== null) {
    const wanted = Number(asIndex[2]);
    // 1-based like the on-screen counter, unless written as `i=0`.
    const position = asIndex[1] === 'i=' ? wanted + 1 : wanted;
    if (position >= 1 && position <= state.order.length) return position - 1;
    return null;
  }

  const needle = raw.toLowerCase();
  const position = state.order.findIndex((index) => state.allImages[index].id.toLowerCase().includes(needle));
  return position >= 0 ? position : null;
}

/* --------------------------------------------------------------- conflicts */

/**
 * Opens the conflict dialog and resolves with `'overwrite'` or `'reload'`.
 *
 * The dialog is deliberately not dismissible with Escape: stopping on an
 * unexplained "file changed" is exactly the silence this feature exists to
 * remove, so the user has to pick a side explicitly.
 */
function askConflict({ id, localCount, diskCount, diskRaw }) {
  el.conflictMessage.textContent =
    `${id} was changed on disk after this page loaded it — most likely by another ` +
    'browser tab or a file sync client. Choose which version to keep:';
  el.conflictDetail.textContent =
    `on disk now: ${diskCount} box(es), ${diskRaw.length} bytes · ` +
    `in this page: ${localCount} box(es).`;

  state.conflict = { id };
  el.conflictDialog.showModal();

  return new Promise((resolve) => {
    const finish = (choice) => {
      el.conflictOverwrite.removeEventListener('click', onOverwrite);
      el.conflictReload.removeEventListener('click', onReload);
      el.conflictDialog.removeEventListener('cancel', onCancel);
      if (el.conflictDialog.open) el.conflictDialog.close();
      state.conflict = null;
      resolve(choice);
    };
    const onOverwrite = () => finish('overwrite');
    const onReload = () => finish('reload');
    const onCancel = (event) => {
      event.preventDefault(); // keep Escape from dismissing the decision
    };

    el.conflictOverwrite.addEventListener('click', onOverwrite);
    el.conflictReload.addEventListener('click', onReload);
    el.conflictDialog.addEventListener('cancel', onCancel);
  });
}

/* ------------------------------------------------------------------ saving */

function scheduleSave() {
  setSaveState('saving');
  if (save.timer !== null) clearTimeout(save.timer);
  save.timer = setTimeout(() => {
    save.timer = null;
    void saveNow();
  }, 150);
}

/** Encodes label text the way the server's revision token expects (base64/UTF-8). */
function encodeRevision(raw) {
  if (raw === '') return '';
  const bytes = new TextEncoder().encode(raw);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Reproduces the server's label-file serialisation so that after a successful
 * write this tab knows the file's exact new contents. Without this, our own
 * previous write would look like "somebody else changed the file" on the next
 * save and raise a false conflict.
 */
function serializeBoxes(boxes) {
  if (boxes.length === 0) return '';
  const rows = boxes.map((box) => {
    const parts = [box.x, box.y, box.w, box.h].map((value) => {
      const rounded = Math.round(value * 1e6) / 1e6;
      return (Object.is(rounded, -0) ? 0 : rounded).toFixed(6);
    });
    return [Math.trunc(box.classId), ...parts].join(' ');
  });
  return `${rows.join('\n')}\n`;
}

/**
 * Serialises saves: at most one PUT in flight, newest edit wins.
 *
 * A 409 means the file changed underneath us. The returned promise does not
 * settle until the user has chosen a resolution, so callers that navigate after
 * saving (which is all of them) cannot race past an unresolved conflict.
 */
function saveNow({ force = false } = {}) {
  if (save.timer !== null) {
    clearTimeout(save.timer);
    save.timer = null;
  }
  /*
   * While a conflict is awaiting the user's decision, keep the edit flagged as
   * dirty instead of queueing a write that must fail: the revision this page
   * holds is still the stale one until the conflict is resolved.
   */
  if (state.conflict !== null && !force) {
    state.dirty = true;
    return save.promise;
  }
  if (!state.dirty || state.current === null) return save.promise;

  const id = state.current.id;
  const boxes = state.boxes.map((box) => ({ ...box }));
  const revision = ++state.rev;
  // A base64 token, not the raw text: HTTP header values cannot contain the
  // newlines that every label file ends with.
  const expectedRevision = force ? undefined : encodeRevision(state.raw ?? '');
  state.dirty = false;
  setSaveState('saving');

  save.promise = save.promise
    .catch(() => undefined)
    .then(async () => {
      try {
        await api(`/annotations/${id}`, {
          method: 'PUT',
          headers: expectedRevision === undefined ? {} : { 'X-Label-Revision': expectedRevision },
          body: JSON.stringify({ boxes }),
        });
        // Adopt the server's revision so our next write is not a conflict.
        state.raw = serializeBoxes(boxes);
        if (revision === state.rev) setSaveState('idle');
        // Only report on the image the user is actually looking at: a save that
        // completes after navigating away must not claim to be about the new one.
        if (state.current !== null && state.current.id === id) {
          setStatus(`Saved ${boxes.length} box(es) to ${basename(id).replace(/\.[^.]+$/, '')}.txt`, 'ok');
        }
        refreshIndexEntry(id);
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          await handleConflict(id, boxes, error);
          return;
        }
        if (revision === state.rev) {
          state.dirty = true;
          setSaveState('error');
        }
        setStatus(`Save failed: ${error.message}`, 'error');
      }
    });

  return save.promise;
}

/**
 * A concurrent write was detected. Ask the user which version wins.
 *
 * Resolving the conflict *must not* await a new save: this function runs inside
 * the current `save.promise` chain, so awaiting `saveNow()` here would make the
 * new write wait on the chain that is waiting on it — a promise cycle that
 * leaves the save indicator stuck on "saving" forever. The forced write is
 * therefore started, not awaited.
 */
async function handleConflict(id, localBoxes, error) {
  const diskRaw = typeof error.details?.current === 'string' ? error.details.current : '';
  setSaveState('error');

  const choice = await askConflict({
    id,
    localCount: localBoxes.length,
    diskCount: countBoxLines(diskRaw),
    diskRaw,
  });

  if (choice === 'overwrite') {
    /*
     * Clear the conflict *before* queueing the write: `saveNow` refuses to write
     * while a conflict is pending. `force` is still needed because the guard
     * would otherwise match the revision we are adopting.
     */
    state.conflict = null;
    state.raw = diskRaw;
    state.dirty = true;
    setStatus('Saving your version…', 'warn');
    save.detached = saveNow({ force: true });
    return;
  }

  // Reload the disk version and discard the local edit.
  state.conflict = null;
  state.raw = diskRaw;
  state.dirty = false;
  if (state.current !== null && state.current.id === id) {
    const parsed = parseLabelText(diskRaw);
    state.boxes = parsed.boxes;
    state.selected = -1;
    state.history = [];
    state.warnings = [];
    setSaveState('idle');
    draw();
    renderBoxes();
    renderProgress();
    renderWarnings();
    setStatus(`Reloaded ${basename(id)} from disk (${parsed.boxes.length} box(es))`, 'warn');
  }
}

/** Counts non-empty, non-comment lines without validating them. */
function countBoxLines(raw) {
  return raw.split(/\r\n|\r|\n/).filter((line) => {
    const trimmed = line.trim();
    return trimmed !== '' && !trimmed.startsWith('#');
  }).length;
}

/**
 * Updates the cached catalog entry after a write so the sidebar's per-group
 * progress counters reflect the save without a full server reindex.
 */
function refreshIndexEntry(id) {
  const entry = state.allImages.find((candidate) => candidate.id === id);
  if (entry === undefined) return;
  entry.hasAnnotation = state.boxes.length > 0;
  entry.boxCount = state.boxes.length;
  renderGroups();
  renderProgress();
}

/**
 * Best-effort client-side parse of label text, mirroring the server rules.
 * Only used when reloading after a conflict; the server remains authoritative
 * for the normal load path.
 */
function parseLabelText(raw) {
  const boxes = [];
  for (const line of raw.split(/\r\n|\r|\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 5) continue;
    const classId = Number(parts[0]);
    const [x, y, w, h] = [Number(parts[1]), Number(parts[2]), Number(parts[3]), Number(parts[4])];
    if (!Number.isInteger(classId) || classId < 0 || classId >= state.classNames.length) continue;
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;
    if (x < 0 || x > 1 || y < 0 || y > 1) continue;
    boxes.push({ classId, x, y, w, h });
  }
  return { boxes };
}

/** Mutates the box list, records undo history and schedules a save. */
function commit(mutate, { quiet = false } = {}) {
  state.history.push(state.boxes.map((box) => ({ ...box })));
  if (state.history.length > 100) state.history.shift();
  mutate();
  state.dirty = true;
  scheduleSave();
  draw();
  renderBoxes();
  renderProgress();
  if (!quiet) setStatus(`${state.boxes.length} box(es) on ${basename(state.current?.id ?? '')}`);
}

function undo() {
  const previous = state.history.pop();
  if (previous === undefined) {
    setStatus('Nothing to undo');
    return;
  }
  state.boxes = previous;
  state.selected = -1;
  state.dirty = true;
  scheduleSave();
  draw();
  renderBoxes();
  renderProgress();
  setStatus('Undone');
}

/**
 * Sticky pan mode. Exists because Space-drag is awkward on a trackpad, and
 * because a discoverable button beats a hidden modifier. The mode is always
 * visible in the toolbar, and `Escape` returns to drawing.
 */
function setPanMode(enabled) {
  panMode = enabled;
  el.stage.dataset.pan = enabled ? 'true' : 'false';
  el.panModeButton.setAttribute('aria-pressed', String(enabled));
  setStatus(
    enabled
      ? 'Pan mode: drag anywhere to move the view. Press p or Escape to draw again.'
      : 'Draw mode: drag on the image to create a box.',
  );
}

function togglePanMode() {
  setPanMode(!panMode);
}

/**
 * Picks the active class, and relabels the selected box when there is one.
 *
 * Relabelling is the reason this is not just "remember a number": a box that was
 * drawn with the wrong class would otherwise have to be deleted and redrawn.
 * Since the class is remembered either way, the next box also uses it — which is
 * what you want after fixing a run of mislabelled boxes.
 */
/**
 * Describes the selected box and, importantly, how to relabel it. Without this
 * hint the relabel shortcuts are invisible: nothing on screen suggests that `c`
 * or a digit does anything to an existing box.
 */
function selectionHint(index) {
  const box = state.boxes[index];
  if (box === undefined) return '';
  const name = state.classNames[box.classId] ?? `#${box.classId}`;
  const rect = boxGeometry(box);
  return (
    `Box ${index + 1}/${state.boxes.length} · "${name}" · ` +
    `${Math.round(rect.width)}×${Math.round(rect.height)} px · ` +
    'press c or a number to relabel it'
  );
}

function setClass(index) {
  if (index < 0 || index >= state.classNames.length) return;
  state.currentClass = index;

  const box = state.selected >= 0 ? state.boxes[state.selected] : undefined;
  if (box === undefined) {
    renderClasses();
    draw();
    setStatus(`Class: ${state.classNames[index]} — drag to draw a box`);
    return;
  }

  if (box.classId === index) {
    renderClasses();
    setStatus(`Box ${state.selected + 1} is already "${state.classNames[index]}"`);
    return;
  }

  const previous = state.classNames[box.classId] ?? `#${box.classId}`;
  commit(() => {
    box.classId = index;
  }, { quiet: true });
  renderClasses();
  setStatus(
    `Relabelled box ${state.selected + 1}: "${previous}" → "${state.classNames[index]}"`,
  );
}

function cycleClass(delta) {
  const count = state.classNames.length;
  if (count === 0) return;
  // With a box selected, cycling relabels it; `cycleClass` itself only decides
  // which class comes next.
  setClass((state.currentClass + delta + count) % count);
}

function deleteSelected() {
  if (state.selected < 0) {
    setStatus('No box selected');
    return;
  }
  const label = state.classNames[state.boxes[state.selected].classId] ?? '?';
  commit(() => {
    state.boxes.splice(state.selected, 1);
    state.selected = -1;
  });
  setStatus(`Deleted ${label} box`);
}

function deleteLast() {
  if (state.boxes.length === 0) {
    setStatus('No boxes to delete');
    return;
  }
  commit(() => {
    state.boxes.pop();
    state.selected = -1;
  });
  setStatus('Deleted last box');
}

/* -------------------------------------------------------------- rendering */

function deviceRatio() {
  return window.devicePixelRatio || 1;
}

function fitView() {
  const entry = state.current;
  if (entry === null) return;
  const width = entry.width || 1;
  const height = entry.height || 1;
  const stage = el.stage.getBoundingClientRect();
  const scale = Math.min(
    (stage.width - FIT_PADDING) / width,
    (stage.height - FIT_PADDING) / height,
  );
  view.scale = clamp(scale, 0.02, 40);
  view.fitted = true;
  centerView();
}

function centerView() {
  const entry = state.current;
  if (entry === null) return;
  const stage = el.stage.getBoundingClientRect();
  const ratio = deviceRatio();
  view.x = ((stage.width - entry.width * view.scale) / 2) * ratio;
  view.y = ((stage.height - entry.height * view.scale) / 2) * ratio;
}

/**
 * Re-establishes the view after the canvas size changed.
 *
 * "Fitted" is a mode, not a one-off action: a window resize with an image in
 * fitted mode has to recompute the scale, otherwise the image that used to fit
 * is suddenly clipped — the exact failure this mode exists to prevent.
 */
function refitView() {
  if (state.current === null) return;
  if (view.fitted) fitView();
  else centerView();
}

function setZoom(nextScale, anchorDevice) {
  const entry = state.current;
  if (entry === null) return;
  const scale = clamp(nextScale, 0.02, 40);
  if (anchorDevice) {
    const imageX = (anchorDevice.x - view.x) / view.scale;
    const imageY = (anchorDevice.y - view.y) / view.scale;
    view.scale = scale;
    view.x = anchorDevice.x - imageX * scale;
    view.y = anchorDevice.y - imageY * scale;
  } else {
    view.scale = scale;
    centerView();
  }
  view.fitted = false;
  clampView();
  draw();
}

function zoomBy(factor) {
  setZoom(view.scale * factor, { x: el.canvas.width / 2, y: el.canvas.height / 2 });
}

/** Resizes the backing store to the stage and clears it. */
function resetCanvas() {
  cancelDraw();
  const ratio = deviceRatio();
  const stage = el.stage.getBoundingClientRect();
  el.canvas.width = Math.max(1, Math.round(stage.width * ratio));
  el.canvas.height = Math.max(1, Math.round(stage.height * ratio));
  el.canvas.style.width = `${stage.width}px`;
  el.canvas.style.height = `${stage.height}px`;
}

let drawHandle = 0;

/**
 * Schedules a repaint for the next animation frame.
 *
 * Pointer events can fire well above the display refresh rate, so painting on
 * every one of them wastes most of the work and makes large images feel heavy.
 * Coalescing means at most one repaint per frame, always of the *latest* state.
 */
function draw() {
  if (drawHandle !== 0) return;
  drawHandle = requestAnimationFrame(() => {
    drawHandle = 0;
    paint();
  });
}

/** Repaints synchronously; use when the frame must be correct immediately. */
function flushDraw() {
  cancelDraw();
  paint();
}

function cancelDraw() {
  if (drawHandle !== 0) {
    cancelAnimationFrame(drawHandle);
    drawHandle = 0;
  }
}

function paint() {
  const entry = state.current;
  const canvasWidth = el.canvas.width;
  const canvasHeight = el.canvas.height;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  if (entry === null) return;

  const image = imageCache.get(entry.id);

  /*
   * Sampling policy. At or above 100% the image must never be interpolated:
   * a clinician judging where a vessel wall or lesion edge falls needs to see
   * the actual pixels, not a blurred average of them. Below 100% we keep
   * high-quality smoothing so the downscaled preview does not alias.
   */
  ctx.imageSmoothingEnabled = view.scale < 1;
  if ('imageSmoothingQuality' in ctx) {
    ctx.imageSmoothingQuality = 'high';
  }

    ctx.save();
    ctx.translate(view.x, view.y);
    ctx.scale(view.scale, view.scale);

    if (image) ctx.drawImage(image, 0, 0);
    else {
      ctx.fillStyle = 'rgba(255,255,255,0.04)';
      ctx.fillRect(0, 0, entry.width || 1, entry.height || 1);
    }

    // The stroke width is divided by the scale so lines stay 2 CSS px on screen.
    const lineWidth = 2 / view.scale;
    state.boxes.forEach((box, index) => drawBox(box, index === state.selected, lineWidth));
    if (drag.current) drawDraftBox(drag.current, lineWidth);
    ctx.restore();

    lastZoomLabel = null;
    renderZoomValue();
}

/**
 * Whether the image is currently drawn with interpolation.
 * Exposed so the end-to-end probe can assert the renderer's real decision
 * instead of a copy of the rule.
 */
function isImageSmoothed() {
  return ctx.imageSmoothingEnabled;
}

function boxGeometry(box) {
  const x = (box.x - box.w / 2) * (state.current?.width || 1);
  const y = (box.y - box.h / 2) * (state.current?.height || 1);
  return {
    x,
    y,
    width: box.w * (state.current?.width || 1),
    height: box.h * (state.current?.height || 1),
  };
}

function drawBox(box, selected, lineWidth) {
  const rect = boxGeometry(box);
  const color = classColor(box.classId);

  ctx.fillStyle = selected ? 'hsl(0 0% 100% / 0.18)' : color.fill;
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);

  ctx.strokeStyle = selected ? '#ffffff' : color.stroke;
  ctx.lineWidth = selected ? lineWidth * 1.6 : lineWidth;
  ctx.setLineDash(selected ? [6 / view.scale, 4 / view.scale] : []);
  ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
  ctx.setLineDash([]);

  const label = state.classNames[box.classId] ?? `#${box.classId}`;
  const fontSize = Math.max(11 / view.scale, 9);
  ctx.font = `600 ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
  const metrics = ctx.measureText(label);
  const padX = 4 / view.scale;
  const padY = 3 / view.scale;
  const labelHeight = fontSize + padY * 2;
  const above = rect.y - labelHeight >= 0;
  const labelY = above ? rect.y - labelHeight : rect.y;

  ctx.fillStyle = selected ? '#ffffff' : color.label;
  ctx.fillRect(rect.x, labelY, metrics.width + padX * 2, labelHeight);
  ctx.fillStyle = selected ? '#111827' : color.labelText;
  ctx.textBaseline = 'top';
  ctx.fillText(label, rect.x + padX, labelY + padY);

  if (selected) {
    const handle = 4 / view.scale;
    ctx.fillStyle = '#ffffff';
    for (const [hx, hy] of [
      [rect.x, rect.y],
      [rect.x + rect.width, rect.y],
      [rect.x, rect.y + rect.height],
      [rect.x + rect.width, rect.y + rect.height],
    ]) {
      ctx.fillRect(hx - handle / 2, hy - handle / 2, handle, handle);
    }
  }
}

function drawDraftBox(box, lineWidth) {
  const rect = boxGeometry(box);
  const color = classColor(box.classId);
  ctx.fillStyle = color.fill;
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = lineWidth;
  ctx.setLineDash([6 / view.scale, 4 / view.scale]);
  ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
  ctx.setLineDash([]);
}

/* ------------------------------------------------------------- hit testing */

function screenToImage(clientX, clientY) {
  const rect = el.canvas.getBoundingClientRect();
  const ratio = deviceRatio();
  const deviceX = (clientX - rect.left) * ratio;
  const deviceY = (clientY - rect.top) * ratio;
  return {
    x: (deviceX - view.x) / view.scale,
    y: (deviceY - view.y) / view.scale,
  };
}

/** Index of the smallest box containing the point, or -1. */
function hitTest(point) {
  let best = -1;
  let bestArea = Number.POSITIVE_INFINITY;
  state.boxes.forEach((box, index) => {
    const rect = boxGeometry(box);
    if (
      point.x >= rect.x &&
      point.x <= rect.x + rect.width &&
      point.y >= rect.y &&
      point.y <= rect.y + rect.height
    ) {
      const area = rect.width * rect.height;
      if (area < bestArea) {
        bestArea = area;
        best = index;
      }
    }
  });
  return best;
}

/* --------------------------------------------------------------- pointers */

/**
 * Keeps the image reachable.
 *
 * The image may extend past the viewport — that is what zooming in means — but
 * it must never be possible to push it completely out of sight and be left
 * staring at an empty stage with no idea which way to pan back. When the image
 * is larger than the stage we keep its centre on screen; when it is smaller we
 * keep it inside the stage so panning a zoomed-out view does not fling it away.
 */
function clampView() {
  const entry = state.current;
  if (entry === null) return;
  const stage = el.stage.getBoundingClientRect();
  if (stage.width === 0 || stage.height === 0) return;

  /*
   * `view` is in device pixels while `view.scale` maps image pixels to device
   * pixels, so comparing `entry.width * view.scale` against `stage.width * dpr`
   * makes the two comparable. Everything below stays in device pixels; the CSS
   * size is only used through that product.
   */
  const ratio = deviceRatio();
  const canvasWidth = stage.width * ratio;
  const canvasHeight = stage.height * ratio;
  const scaledWidth = entry.width * view.scale;
  const scaledHeight = entry.height * view.scale;
  /** How much of the image must remain on screen, in device pixels. */
  const minVisible = 48 * ratio;

  if (scaledWidth <= canvasWidth) {
    // Smaller than the viewport: keep it fully inside.
    view.x = clamp(view.x, 0, canvasWidth - scaledWidth);
  } else {
    view.x = clamp(view.x, canvasWidth - minVisible - scaledWidth, minVisible);
  }

  if (scaledHeight <= canvasHeight) {
    view.y = clamp(view.y, 0, canvasHeight - scaledHeight);
  } else {
    view.y = clamp(view.y, canvasHeight - minVisible - scaledHeight, minVisible);
  }

  // Drop any fractional drift so repeated pans do not creep.
  const clampedX = Math.round(view.x);
  const clampedY = Math.round(view.y);
  view.x = clampedX;
  view.y = clampedY;
}

/** Starts a pan gesture (space-drag, middle-drag, Alt/Shift-drag). */
function beginPan(event) {
  pointer.mode = 'pan';
  pointer.startScreen = { x: event.clientX, y: event.clientY };
  pointer.startImage = { x: view.x, y: view.y };
  el.stage.dataset.panning = 'true';
  el.canvas.setPointerCapture(event.pointerId);
  event.preventDefault();
}

function onPointerDown(event) {
  /*
   * Panning is always explicit: Space (or the toggle) for a plain drag, Alt for
   * a secondary modifier, middle/right for a mouse. It is deliberately *not*
   * inferred from the zoom level — taking over a plain left-drag when zoomed in
   * means the crosshair lies about what the mouse does exactly when precise
   * drawing matters most.
   */
  if (spaceHeld || panMode || event.altKey || event.button === 1 || event.button === 2) {
    beginPan(event);
    return;
  }
  if (event.button !== 0) return;

  focusCanvas();
  const point = screenToImage(event.clientX, event.clientY);
  const hit = hitTest(point);

  if (hit >= 0) {
    state.selected = hit;
    drag.active = true;
    drag.startImage = point;
    pointer.mode = 'move';
    el.canvas.setPointerCapture(event.pointerId);
    draw();
    renderBoxes();
    setStatus(selectionHint(hit));
    return;
  }

  drag.active = true;
  drag.startImage = point;
  pointer.mode = 'draw';
  el.canvas.setPointerCapture(event.pointerId);
  const entry = state.current;
  drag.current = {
    classId: state.currentClass,
    x: clamp(point.x / (entry.width || 1), 0, 1),
    y: clamp(point.y / (entry.height || 1), 0, 1),
    w: 0,
    h: 0,
  };
}

/** True when the view is larger than the fitted size, i.e. panning is useful. */
function onPointerMove(event) {
  const point = screenToImage(event.clientX, event.clientY);

  // Hover feedback only; kept out of the paint path so it never forces a draw.
  if (pointer.mode === 'idle') {
    if (hitTest(point) >= 0) el.stage.dataset.over = 'true';
    else delete el.stage.dataset.over;
  }

  if (pointer.mode === 'pan') {
    const ratio = deviceRatio();
    view.x = pointer.startImage.x + (event.clientX - pointer.startScreen.x) * ratio;
    view.y = pointer.startImage.y + (event.clientY - pointer.startScreen.y) * ratio;
    view.fitted = false;
    clampView();
    draw();
    return;
  }

  if (pointer.mode === 'draw' && drag.current !== null) {
    const entry = state.current;
    const width = entry.width || 1;
    const height = entry.height || 1;
    const startX = clamp(drag.startImage.x / width, 0, 1);
    const startY = clamp(drag.startImage.y / height, 0, 1);
    const endX = clamp(point.x / width, 0, 1);
    const endY = clamp(point.y / height, 0, 1);
    drag.current = {
      classId: state.currentClass,
      x: (startX + endX) / 2,
      y: (startY + endY) / 2,
      w: Math.abs(endX - startX),
      h: Math.abs(endY - startY),
    };
    draw();
    return;
  }

  if (pointer.mode === 'move' && state.selected >= 0) {
    const entry = state.current;
    const dx = (point.x - drag.startImage.x) / (entry.width || 1);
    const dy = (point.y - drag.startImage.y) / (entry.height || 1);
    drag.startImage = point;
    const box = state.boxes[state.selected];
    box.x = clamp(box.x + dx, box.w / 2, 1 - box.w / 2);
    box.y = clamp(box.y + dy, box.h / 2, 1 - box.h / 2);
    state.dirty = true;
    draw();
  }
}

function onPointerUp(event) {
  if (pointer.mode === 'pan') {
    pointer.mode = 'idle';
    delete el.stage.dataset.panning;
    return;
  }

  if (pointer.mode === 'move') {
    pointer.mode = 'idle';
    drag.active = false;
    scheduleSave();
    return;
  }

  if (pointer.mode !== 'draw') return;
  pointer.mode = 'idle';
  drag.active = false;

  const entry = state.current;
  const draft = drag.current;
  drag.current = null;
  if (draft === null) return;

  // A click without a meaningful drag clears the selection instead of adding a
  // degenerate box (the original tool required >5 px, we require ~2 CSS px).
  const minimumW = 2 / view.scale / (entry.width || 1);
  const minimumH = 2 / view.scale / (entry.height || 1);
  if (draft.w < minimumW || draft.h < minimumH) {
    state.selected = -1;
    draw();
    renderBoxes();
    setStatus('Click a box to select it, or drag to draw a new one');
    return;
  }

  commit(() => {
    state.boxes.push(draft);
    state.selected = state.boxes.length - 1;
  });
  setStatus(`${state.classNames[draft.classId]} box added (${state.boxes.length} total)`);
}

function onPointerLeave() {
  if (pointer.mode === 'idle') delete el.stage.dataset.over;
}

function onWheel(event) {
  event.preventDefault();
  const ratio = deviceRatio();
  const rect = el.canvas.getBoundingClientRect();

  // Shift + wheel scrolls the view instead of zooming, so a clipped image can be
  // reached without knowing about the drag-to-pan modifiers.
  if (event.shiftKey && !spaceHeld) {
    const deltaX = event.deltaX || event.deltaY;
    const deltaY = event.deltaY;
    view.x -= deltaX * ratio;
    view.y -= deltaY * ratio;
    view.fitted = false;
    clampView();
    draw();
    return;
  }

  const anchor = {
    x: (event.clientX - rect.left) * ratio,
    y: (event.clientY - rect.top) * ratio,
  };
  setZoom(view.scale * Math.exp(-event.deltaY * 0.0015), anchor);
}

function onDoubleClick(event) {
  const point = screenToImage(event.clientX, event.clientY);
  const hit = hitTest(point);
  if (hit < 0) {
    fitView();
    draw();
    return;
  }
  // Double-clicking a box makes its class the active one.
  setClass(state.boxes[hit].classId);
}

/* ------------------------------------------------------------------ zoom UI */

/** Last label written to the DOM, so repaints do not touch it needlessly. */
let lastZoomLabel;

function renderZoomValue() {
  const label = view.fitted ? 'fit' : `${Math.round(view.scale * 100)}%`;
  if (label === lastZoomLabel) return;
  lastZoomLabel = label;
  el.zoomValue.textContent = label;
}

/* ------------------------------------------------------------------ sidebar */

function renderClasses() {
  el.classList.replaceChildren();
  state.classNames.forEach((name, index) => {
    const item = document.createElement('li');
    item.setAttribute('aria-current', String(index === state.currentClass));
    item.title = `Press ${index + 1 <= 9 ? index + 1 : '—'} for ${name}`;

    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = classColor(index).stroke;

    const badge = document.createElement('span');
    badge.className = 'class-index';
    badge.textContent = String(index);

    const label = document.createElement('span');
    label.className = 'class-name';
    label.textContent = name;

    const count = document.createElement('span');
    count.className = 'class-count';
    const used = state.boxes.filter((box) => box.classId === index).length;
    count.textContent = used > 0 ? String(used) : '';

    item.append(swatch, badge, label, count);
    item.addEventListener('click', () => setClass(index));
    el.classList.append(item);
  });
  el.classesSource.textContent = state.classesFile;
}

function renderGroups() {
  el.groupList.replaceChildren();

  const makeItem = (label, value, count, annotated) => {
    const item = document.createElement('li');
    item.setAttribute('aria-current', String(value === state.activeGroup));
    const name = document.createElement('span');
    name.className = 'group-name';
    name.textContent = label;
    const badge = document.createElement('span');
    badge.className = 'group-count';
    badge.textContent = `${annotated}/${count}`;
    badge.dataset.complete = String(count > 0 && annotated === count);
    item.append(name, badge);
    item.addEventListener('click', () => setGroupFilter(value));
    return item;
  };

  const totals = state.allImages.reduce(
    (acc, image) => {
      acc.count += 1;
      if (image.hasAnnotation) acc.annotated += 1;
      return acc;
    },
    { count: 0, annotated: 0 },
  );
  el.groupList.append(makeItem('All images', '', totals.count, totals.annotated));

  for (const group of state.groups) {
    const images = state.allImages.filter((image) => image.group === group.relativePath);
    const annotated = images.filter((image) => image.hasAnnotation).length;
    el.groupList.append(makeItem(group.name, group.relativePath, images.length, annotated));
  }
}

function renderBoxes() {
  el.boxList.replaceChildren();
  el.boxesEmpty.hidden = state.boxes.length > 0;

  state.boxes.forEach((box, index) => {
    const rect = boxGeometry(box);
    const item = document.createElement('li');
    item.setAttribute('aria-current', String(index === state.selected));

    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = classColor(box.classId).stroke;

    const label = document.createElement('span');
    label.className = 'box-label';
    label.textContent = state.classNames[box.classId] ?? `#${box.classId}`;

    const dims = document.createElement('span');
    dims.className = 'box-dims';
    dims.textContent = `${Math.round(rect.width)}×${Math.round(rect.height)}`;

    item.append(swatch, label, dims);
    item.title =
      'Click to select this box. With a box selected, c or a number key changes its label.';
    item.addEventListener('click', () => {
      state.selected = state.selected === index ? -1 : index;
      draw();
      renderBoxes();
      setStatus(
        state.selected === -1
          ? 'Selection cleared'
          : selectionHint(state.selected),
      );
    });
    el.boxList.append(item);
  });
}

function renderProgress() {
  const annotated = state.allImages.filter((image) => image.hasAnnotation).length;
  const total = state.allImages.length;
  const percent = total === 0 ? 0 : Math.round((annotated / total) * 100);
  el.progressFill.style.width = `${percent}%`;
  const boxes = state.allImages.reduce((sum, image) => sum + image.boxCount, 0);
  el.progressText.textContent = `${annotated}/${total} labelled · ${boxes} boxes · ${percent}%`;
}

function renderWarnings() {
  el.warningList.replaceChildren();

  const messages = [
    ...state.serverWarnings.map((message) => `indexing: ${message}`),
    ...state.warnings.map((warning) => `label line ${warning.line}: ${warning.reason}`),
  ];

  for (const message of messages) {
    const item = document.createElement('li');
    item.textContent = message;
    el.warningList.append(item);
  }
  el.warningList.hidden = messages.length === 0;
}

function renderPath() {
  const entry = state.current;
  if (entry === null) return;
  el.imagePath.textContent = entry.id;
  el.imagePath.title = entry.absolutePath;
  el.imageSize.textContent = entry.width && entry.height ? `${entry.width}×${entry.height}` : 'unknown size';
}

function renderCounter() {
  if (state.order.length === 0) {
    el.imageCounter.textContent = '0 / 0';
    return;
  }
  const position = state.position + 1;
  const suffix = state.activeGroup === '' ? '' : ` · ${state.activeGroup}`;
  el.imageCounter.textContent = `${position} / ${state.order.length}${suffix}`;
  el.imageCounter.title = state.current?.id ?? '';

  // Keep the deep link current so a reload (or a shared URL) lands on the same
  // image. `replaceState` avoids polluting the back button.
  if (state.current !== null) {
    try {
      window.history.replaceState(null, '', `#${state.current.id}`);
    } catch {
      // Some embedded viewers reject history changes; the app still works.
    }
  }
}

function renderSidebar() {
  renderClasses();
  renderGroups();
  renderBoxes();
  renderProgress();
  renderWarnings();
  renderPath();
  renderCounter();
}

/* ---------------------------------------------------------------- overlays */

function showOverlay(text) {
  el.overlayText.textContent = text;
  el.overlay.hidden = false;
}

function hideOverlay() {
  el.overlay.hidden = true;
}

function focusCanvas() {
  el.canvas.focus({ preventScroll: true });
}

/* --------------------------------------------------------------- dialogs */

function openJumpDialog() {
  const entry = state.current;
  const position = state.position + 1;
  el.jumpHint.textContent =
    `Number (1–${state.order.length}) or part of a file name. ` +
    `Current: ${entry ? entry.id : '—'} (${position}/${state.order.length}).`;
  el.jumpInput.value = '';
  el.jumpDialog.showModal();
  el.jumpInput.focus();
}

function applyJump() {
  const raw = el.jumpInput.value.trim();
  if (raw === '') return;
  const number = Number(raw);
  if (Number.isInteger(number) && number >= 1 && number <= state.order.length) {
    const target = state.order[number - 1];
    void saveNow().then(() => {
      state.position = number - 1;
      void loadImage(state.allImages[target], 1);
    });
    return;
  }
  const needle = raw.toLowerCase();
  jumpTo((image) => image.id.toLowerCase().includes(needle), raw);
}

/* ------------------------------------------------------------------ events */

function onKeyDown(event) {
  // Space is the pan modifier. It is tracked here rather than bound to the
  // canvas so that holding it works no matter where the focus sits.
  if (event.key === ' ' || event.code === 'Space') {
    if (!spaceHeld) {
      spaceHeld = true;
      el.stage.dataset.space = 'true';
    }
    event.preventDefault(); // stop the page scrolling
    return;
  }

  const target = event.target;
  const typing = target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
  if (typing) {
    if (event.key === 'Enter' && el.jumpDialog.open) {
      el.jumpDialog.close();
      applyJump();
    }
    return;
  }

  /*
   * The conflict dialog is modal: `showModal()` isolates the *pointer*, but key
   * events still reach this global listener, so Escape would call `quit()` and
   * stop the server with the conflict unresolved. Swallow the shortcuts until
   * the user has picked a side.
   */
  if (state.conflict !== null) {
    event.preventDefault();
    return;
  }

  if (event.ctrlKey || event.metaKey) {
    if (event.key.toLowerCase() === 'z') {
      event.preventDefault();
      undo();
    } else if (event.key.toLowerCase() === 's') {
      event.preventDefault();
      state.dirty = true;
      void saveNow();
    }
    return;
  }

  /*
   * Arrow keys do two different things depending on whether a box is selected:
   * nudging a selected box is the far more common action while annotating, and
   * panning has dedicated gestures (drag empty space / Space-drag / Alt-drag /
   * Shift-wheel). With nothing selected, arrows are free to mean "pan".
   */
  if (event.key.startsWith('Arrow')) {
    const handled = state.selected >= 0 ? nudgeSelected(event) : panByArrow(event);
    if (handled) event.preventDefault();
    return;
  }

  switch (event.key) {
    case 'n':
    case 'N':
      event.preventDefault();
      go(1);
      break;
    case 'p':
    case 'P':
      event.preventDefault();
      go(-1);
      break;
    case 'c':
      cycleClass(1);
      break;
    case 'C':
      cycleClass(-1);
      break;
    case 'd':
    case 'D':
      deleteLast();
      break;
    case 'Delete':
    case 'Backspace':
      deleteSelected();
      break;
    case 's':
    case 'S':
      state.dirty = true;
      void saveNow();
      break;
    case 'j':
    case 'J':
      openJumpDialog();
      break;
    case 'h':
    case 'H':
      togglePanMode();
      break;
    case '?':
      el.helpDialog.showModal();
      break;
    case 'Escape':
      // Escape leaves pan mode first, so the toggle is never a trap; a second
      // Escape then saves and quits as before.
      if (panMode) setPanMode(false);
      else void quit();
      break;
    case '+':
    case '=':
      zoomBy(1.25);
      break;
    case '-':
    case '_':
      zoomBy(0.8);
      break;
    case '0':
      fitView();
      draw();
      break;
    default:
      if (/^[1-9]$/.test(event.key)) setClass(Number(event.key) - 1);
      break;
  }
}

/** Arrow key with no selection: browse images. Returns true when handled. */
/** Arrow key with no selection: scroll the view. Returns true when handled. */
function panByArrow(event) {
  const ratio = deviceRatio();
  const step = (event.shiftKey ? 160 : 40) * ratio;
  if (event.key === 'ArrowLeft') view.x += step;
  else if (event.key === 'ArrowRight') view.x -= step;
  else if (event.key === 'ArrowUp') view.y += step;
  else if (event.key === 'ArrowDown') view.y -= step;
  else return false;

  view.fitted = false;
  clampView();
  draw();
  return true;
}

/** Arrow key with a selection: move (or Alt-resize) the selected box. */
function nudgeSelected(event) {
  const box = state.boxes[state.selected];
  const entry = state.current;
  if (box === undefined || entry === null) return false;

  const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
  const step = (event.shiftKey ? 10 : 1) / (horizontal ? entry.width || 1 : entry.height || 1);
  const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
  const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;

  if (event.altKey) {
    box.w = clamp(box.w + dx * 2, 0.001, 1);
    box.h = clamp(box.h + dy * 2, 0.001, 1);
  } else {
    box.x = clamp(box.x + dx, box.w / 2, 1 - box.w / 2);
    box.y = clamp(box.y + dy, box.h / 2, 1 - box.h / 2);
  }

  state.dirty = true;
  scheduleSave();
  draw();
  renderBoxes();
  return true;
}

async function quit() {
  showOverlay('Saving and shutting down…');
  state.dirty = true;
  try {
    await saveNow();
  } catch {
    // Reported through the status bar already.
  }

  try {
    await fetch(`${API_ROOT}/shutdown`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-shutdown-token': SHUTDOWN_TOKEN },
      body: '{}',
      keepalive: true,
    });
    el.overlayText.textContent = 'All annotations saved. The server has stopped — you can close this tab.';
    document.title = 'YOLO Annotator (stopped)';
  } catch (error) {
    el.overlayText.textContent = `Could not stop the server: ${error.message}. Press Ctrl+C in the terminal.`;
  }
}

/* ----------------------------------------------------------------- dataset */

/**
 * How the page can ask for a dataset.
 *
 * In the desktop app, Electron exposes `window.yolo` (see src/desktop). In a
 * plain browser there is no way to read a filesystem path — a web page cannot —
 * so the user types the two paths instead. Both paths end up in the same
 * `POST /api/dataset` call.
 */
const desktop = typeof window !== 'undefined' ? window.yolo ?? null : null;

/** Pending selection, held here until "Open dataset" is pressed. */
const pending = { imagesDir: '', classesFile: '' };

function showSetup({ title, hint } = {}) {
  el.setup.hidden = false;
  if (title !== undefined) el.setupTitle.textContent = title;
  if (hint !== undefined) el.setupHint.textContent = hint;
  renderPending();
}

function hideSetup() {
  el.setup.hidden = true;
  el.setupError.hidden = true;
}

function renderPending() {
  el.setupImages.textContent = pending.imagesDir === '' ? 'not chosen' : pending.imagesDir;
  el.setupClasses.textContent = pending.classesFile === '' ? 'not chosen' : pending.classesFile;
  el.setupOpen.disabled = pending.imagesDir === '' || pending.classesFile === '';
}

function setupError(message) {
  el.setupError.textContent = message;
  el.setupError.hidden = message === '';
}

/** Stores a classes file the user picked or typed, deriving the folder. */
function acceptClassesFile(filePath) {
  pending.classesFile = filePath;
  if (pending.imagesDir === '') {
    // The classes file usually sits beside the images, but guessing is worse
    // than asking: leave images unset and let the user choose.
    pending.imagesDir = '';
  }
  renderPending();
}

/** Asks the server to open a dataset, then reloads the page into it. */
async function openDataset(imagesDir, classesFile) {
  setupError('');
  el.setupOpen.disabled = true;
  try {
    await api('/dataset', {
      method: 'POST',
      body: JSON.stringify({ imagesDir, classesFile }),
    });
    // A full reload is the simplest correct way to forget the previous image,
    // boxes, history and caches, and to re-run boot() against the new dataset.
    window.location.reload();
  } catch (error) {
    setupError(error.message);
    el.setupOpen.disabled = false;
  }
}

/** The "choose" buttons: native dialogs in the desktop app, prompt() in a browser. */
async function chooseImagesFolder() {
  if (desktop?.chooseImagesFolder) {
    const chosen = await desktop.chooseImagesFolder();
    if (chosen !== null && chosen !== '') {
      pending.imagesDir = chosen;
      renderPending();
    }
    return;
  }
  const typed = window.prompt('Path to the images folder:', pending.imagesDir);
  if (typed !== null && typed.trim() !== '') {
    pending.imagesDir = typed.trim();
    renderPending();
  }
}

async function chooseClassesFile() {
  if (desktop?.chooseClassesFile) {
    const chosen = await desktop.chooseClassesFile();
    if (chosen !== null && chosen !== '') {
      acceptClassesFile(chosen);
    }
    return;
  }
  const typed = window.prompt('Path to the classes file (obj.names):', pending.classesFile);
  if (typed !== null && typed.trim() !== '') {
    acceptClassesFile(typed.trim());
  }
}

/** Opens the picker screen, pre-filled from the dataset currently loaded. */
function openDatasetPicker() {
  if (state.current !== null && state.imagesRoot !== '') {
    pending.imagesDir = state.imagesRoot;
  }
  if (state.classesFile !== '') {
    pending.classesFile = state.classesFile;
  }
  renderPending();
  showSetup({
    title: 'Choose a dataset',
    hint:
      'Pick the folder that holds your images, then your classes file ' +
      '(obj.names, one class name per line). The current dataset stays open ' +
      'until you confirm.',
  });
}

function wireDatasetEvents() {
  el.datasetButton.addEventListener('click', openDatasetPicker);
  el.setupPickImages.addEventListener('click', () => void chooseImagesFolder());
  el.setupPickClasses.addEventListener('click', () => void chooseClassesFile());
  el.setupOpen.addEventListener('click', () => {
    void openDataset(pending.imagesDir, pending.classesFile);
  });
}

/* -------------------------------------------------------------------- boot */

function onKeyUp(event) {
  if (event.key === ' ' || event.code === 'Space') {
    spaceHeld = false;
    delete el.stage.dataset.space;
  }
}

/**
 * Clears the space-pan state when the page loses focus. Without this, holding
 * Space and switching windows would leave the canvas stuck in pan mode.
 */
function releaseSpace() {
  if (!spaceHeld) return;
  spaceHeld = false;
  delete el.stage.dataset.space;
}

function wireEvents() {
  wireDatasetEvents();
  el.canvas.addEventListener('pointerdown', onPointerDown);
  el.canvas.addEventListener('pointermove', onPointerMove);
  el.canvas.addEventListener('pointerup', onPointerUp);
  el.canvas.addEventListener('pointercancel', onPointerUp);
  el.canvas.addEventListener('pointerleave', onPointerLeave);
  el.canvas.addEventListener('wheel', onWheel, { passive: false });
  el.canvas.addEventListener('dblclick', onDoubleClick);
  el.canvas.addEventListener('contextmenu', (event) => event.preventDefault());

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', releaseSpace);
  document.addEventListener('visibilitychange', releaseSpace);
  window.addEventListener('resize', () => {
    resetCanvas();
    refitView();
    // Resizing the backing store clears it, so repaint before yielding to the
    // compositor rather than showing an empty canvas for a frame.
    flushDraw();
  });
  window.addEventListener('beforeunload', () => {
    if (state.dirty) void saveNow();
  });

  /*
   * The desktop shell asks for this before it closes the window. `beforeunload`
   * cannot help there: the save is asynchronous and the window is already going
   * away, so an edit made in the last ~150 ms (before the debounce fires) was
   * silently lost. The shell now waits for this promise instead.
   */
  if (desktop?.onFlushRequest) {
    desktop.onFlushRequest(async () => {
      if (!state.dirty && save.timer === null) return { saved: false };
      state.dirty = true;
      await saveNow();
      return { saved: true };
    });
  }

  document.getElementById('zoom-in').addEventListener('click', () => zoomBy(1.25));
  document.getElementById('zoom-out').addEventListener('click', () => zoomBy(0.8));
  document.getElementById('zoom-value').addEventListener('click', () => {
    fitView();
    draw();
  });
  el.panModeButton.addEventListener('click', () => {
    togglePanMode();
    focusCanvas();
  });
  document.getElementById('jump-button').addEventListener('click', openJumpDialog);
  document.getElementById('help-button').addEventListener('click', () => el.helpDialog.showModal());
  document.getElementById('quit-button').addEventListener('click', () => void quit());
  document.getElementById('jump-confirm').addEventListener('click', (event) => {
    event.preventDefault();
    el.jumpDialog.close();
    applyJump();
  });
  document.getElementById('jump-cancel').addEventListener('click', () => el.jumpDialog.close());
}

async function boot() {
  wireEvents();
  installProbe();
  setStatus('Indexing images…');

  /*
   * A dataset has to be open before anything else makes sense. The desktop app
   * starts with none, so the first thing the user sees is the picker rather than
   * an empty canvas.
   */
  let datasetInfo = null;
  try {
    datasetInfo = await api('/dataset');
  } catch {
    datasetInfo = null;
  }

  if (datasetInfo === null) {
    el.app.hidden = false;
    hideOverlay();
    showSetup({
      title: 'Choose your dataset',
      hint:
        'Select the folder that holds your images, then your classes file ' +
        '(obj.names, one class name per line).',
    });
    setStatus('No dataset open — choose an images folder and a classes file.');
    return;
  }

  let payload;
  try {
    payload = await api('/images');
  } catch (error) {
    el.app.hidden = false;
    hideOverlay();
    showSetup({
      title: 'Choose your dataset',
      hint: `The current dataset could not be read: ${error.message}`,
    });
    setStatus('No dataset open — choose an images folder and a classes file.', 'warn');
    return;
  }

  state.classNames = payload.classNames ?? [];
  state.classesFile = payload.classesFile ?? '';
  state.imagesRoot = payload.imagesRoot ?? '';
  state.groups = payload.groups ?? [];
  state.allImages = payload.images ?? [];
  state.serverWarnings = payload.warnings ?? [];
  state.order = state.allImages.map((_, index) => index);
  state.position = 0;

  el.app.hidden = false;
  hideSetup();
  renderSidebar();

  if (state.allImages.length === 0) {
    showSetup({
      title: 'That folder has no images',
      hint:
        `No supported images were found in ${payload.imagesRoot}. ` +
        'Supported types: .jpg .jpeg .png .bmp .webp .tif .tiff.',
    });
    setStatus('No images found in the chosen folder.', 'warn');
    return;
  }

  const requested = applyHash();
  if (requested !== null) state.position = requested;

  await loadImage(state.allImages[state.order[state.position]], 1);
  renderWarnings();
  setStatus(
    `${state.allImages.length} image(s), ${state.classNames.length} class(es) — ready. ` +
      'Drag on the image to draw a box; press ? for shortcuts.',
    'ok',
  );
}

/**
 * Read-only introspection hook.
 *
 * It exposes the live view transform and the current document so that end-to-end
 * tests (and a curious user in the devtools console) can reason about what is on
 * screen without duplicating the canvas maths. It is intentionally not used by
 * the application itself.
 */
function installProbe() {
  Object.defineProperty(window, '__YOLO_PROBE__', {
    configurable: true,
    get() {
      const entry = state.current;
      const canvasRect = el.canvas.getBoundingClientRect();
      return {
        version: bootstrap.version ?? '',
        view: { scale: view.scale, x: view.x, y: view.y, fitted: view.fitted },
        /** The renderer's live interpolation setting for the current frame. */
        smoothing: isImageSmoothed(),
        image: {
          id: entry?.id ?? null,
          width: entry?.width ?? null,
          height: entry?.height ?? null,
        },
        canvas: {
          width: el.canvas.width,
          height: el.canvas.height,
          cssWidth: canvasRect.width,
          cssHeight: canvasRect.height,
        },
        boxes: state.boxes.map((box) => ({ ...box })),
        selected: state.selected,
        position: state.position,
        order: state.order.length,
        currentClass: state.currentClass,
        saveState: save.status,
      };
    },
  });
}

void boot();
