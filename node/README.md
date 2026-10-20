# YOLO Annotator (Node.js / TypeScript)

A cross-platform reimplementation of the OpenCV C++ `yolo_annotator` in this
repository. Same job, same keyboard shortcuts, same `obj.names` +
`image.jpg` → `image.txt` layout — but the drawing surface is a browser canvas
and the process is plain Node.js.

Nothing to compile, nothing to cross-compile, and **no runtime dependencies**:
Node's built-in type stripping runs the TypeScript sources directly.

```bash
cd node
npm start -- ../images ../obj.names
```

The terminal prints a URL such as `http://127.0.0.1:7860/`, opens your default
browser, and the annotator is ready.

<!-- Screenshot placeholder: docs/screenshot.png -->

## Why this version

| | C++ / OpenCV (`../main.cpp`) | This TypeScript version |
| --- | --- | --- |
| Build | CMake or g++ **plus** a working OpenCV install per platform | `node src/server/main.ts` — no compiler, no OpenCV |
| Windows | needs the OpenCV prebuilt binaries + `PATH` wrangling | install Node once |
| UI | native HighGUI window | browser canvas (any modern browser) |
| Unusable desktop / SSH | cannot run | runs as a server; forward the port |
| Zoom & pan | resizes the window only | real zoom, pan, snapping, undo |
| Existing labels | rewritten in place | rewritten in place + optional `.original.txt` backup |
| Big folders | whole directory in memory | recursive index, groups, lazy image loading |

The label format is unchanged, so datasets stay compatible in both directions:

```
<class-id> <x-centre> <y-centre> <width> <height>   # all normalised to 0..1
```

## Desktop app

The recommended way to use this is the **desktop application**: a real window with
its own icon, no browser and no terminal involved.

```bash
cd node
npm run package:desktop        # macOS .dmg + Windows installer -> ../dist-desktop/
npm run desktop                # or just run it from source
```

On first launch it asks for your images folder and classes file with native
dialogs, remembers the choice, and lets you change it later from **Choose
dataset…** in the toolbar. See [PACKAGING.md](PACKAGING.md).

There is also a lighter browser-based build (bundled Node runtime, no Electron):

```bash
npm run package                # -> dist/
```

- **macOS**: `YOLO-Annotator-2.0.0.pkg` or `YOLO-Annotator-2.0.0.dmg`
- **Windows**: `YOLO-Annotator-BROWSER-Setup-2.0.0.exe`, plus a portable zip

> The desktop and browser builds used to share a Windows filename, which made it
> easy to install the wrong one. The desktop installer is
> `YOLO Annotator Setup 2.0.0.exe` (in `dist-desktop/`); the browser one now has
> `BROWSER` in its name.

**On first launch the app asks** which folder holds your images and where your
classes file is, using real native dialogs — nothing has to be arranged in
advance. It remembers the choice, so later launches go straight to the
annotator. `~/Documents/YOLO Annotator` is created as an obvious place to put
images. See [PACKAGING.md](PACKAGING.md) for details, caveats about unsigned
builds, and why a single-file executable was not used.

## Requirements

- **Node.js ≥ 22.18** (Node 24 recommended) — the server runs `.ts` files direct.
- A modern browser: Chrome/Edge 90+, Firefox 90+, Safari 15+.
- Dev-only packages (`typescript`, `@types/node`) are needed just for
  `npm run typecheck`; `npm install` is optional for running the annotator.

## Install

```bash
cd node
npm install          # optional: only for typechecking
```

## Usage

```bash
# Positional form is identical to the original binary
node src/server/main.ts <images-directory> <classes-file> [options]

# …or through the package scripts
npm start -- ../images ../obj.names
```

An `obj.names` file is one class name per line; blank lines and lines starting
with `#` are ignored, and a UTF-8 BOM is tolerated.

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `-p, --port <n>` | `7860` | Port to listen on (`0` = pick any free port) |
| `--host <addr>` | `127.0.0.1` | Interface to bind. Use `0.0.0.0` to reach it from another machine |
| `--no-auto-port` | off | Fail when the port is taken instead of trying the next one |
| `--no-open` | off | Do not launch a browser |
| `--limit <n>` | `50000` | Safety cap on how many images are indexed |
| `-h, --help` | | Print usage |
| `-V, --version` | | Print the version |

Environment variables `YOLO_ANNOTATOR_PORT` and `YOLO_ANNOTATOR_HOST` are read
as fallbacks; explicit flags win.

### Examples

```bash
# Normal use
node src/server/main.ts ../images ../obj.names

# Remote box: bind all interfaces, do not try to open a browser there
node src/server/main.ts /data/photos /data/obj.names --host 0.0.0.0 --port 9000 --no-open
```

## Keyboard and mouse

| Input | Action |
| --- | --- |
| drag | draw a box with the active class — at **any** zoom level |
| drag a box | move that box |
| Space + drag, Alt + drag, middle-drag | pan the view |
| `h` or the ✋ toolbar button | pan mode: drag anywhere to move the view (`Esc` leaves it) |
| click a box | select it (handles + sidebar highlight) |
| click empty space | deselect |
| double-click a box | adopt that box's class |
| `n` / `p` | next / previous image |
| `c` / `C` | next / previous class |
| `1` … `9` | select class N |
| `d` | delete the last box |
| `Delete` / `Backspace` | delete the selected box |
| arrow keys | nudge the selected box (`Shift` = 10 px, `Alt` = resize) |
| `Ctrl`/`Cmd` + `Z` | undo (100 steps) |
| `s` | save now (every edit saves automatically after 150 ms) |
| `+` / `-` | zoom in / out |
| `0` or the percentage button | fit the image to the window |
| wheel | zoom around the cursor; `Shift` + wheel scrolls the view |
| `j` | jump to an image by number or file-name fragment |
| `?` | shortcut panel |
| `Esc` | leave pan mode, or save and quit |

The image is **fitted to the window when it loads**, so nothing is clipped before
you touch anything. Zooming in necessarily pushes part of the image outside the
viewport; use Space-drag (or turn on pan mode) to reach it. Panning is clamped so
the image can never be pushed completely out of sight, and `0` returns to the
fitted view at any time.

Dragging always draws, at every zoom level. Panning is never *inferred* from the
zoom level — a cursor that offers a crosshair and then pans instead is worse than
an extra modifier key, especially when the zoomed-in view is where precise boxes
are drawn.

The URL hash tracks the current image (`#sub/cat.jpg`), so a reload, a bookmark
or a pasted link reopens exactly that file.

## Automatic saving

**Every edit is written to disk without a save action.** For each image
`images/sub/cat.jpg` the annotator keeps `images/sub/cat.txt` in sync:

| Action | When the file is written |
| --- | --- |
| draw a box | ~150 ms after the drag ends |
| move, relabel, nudge a box | ~150 ms after the edit |
| delete a box | ~150 ms after the edit |
| undo | ~150 ms after the undo |
| navigate to another image | before the next image loads |
| press <kbd>Esc</kbd> / **Quit** | immediately, before the server stops |
| close the window (Cmd+W / ✕) | immediately, before the window closes |

Each image has its own file, and only the edited one is touched — navigating
never rewrites a neighbour's labels.

Two details make this reliable rather than best-effort:

- **Writes are atomic.** The server writes a temporary file and renames it into
  place, so an interrupted save cannot leave a half-written label file.
- **Closing the window waits for the write.** The debounce means an edit can be
  pending when the window goes away, so the desktop shell intercepts the close,
  asks the page to flush, and only closes once the file is on disk. Without this
  a box drawn in the last ~150 ms was silently lost.

## What gets written

For every image `images/sub/cat.jpg` the annotator writes `images/sub/cat.txt`
next to it:

```
0 0.489583 0.362847 0.126042 0.208333
1 0.750000 0.250000 0.200000 0.100000
```

Details that matter:

- Coordinates are normalised against the **image's own** pixel size, so zoom does
  not affect the data.
- Boxes are clamped into the image; an inverted drag is normalised.
- Writes are **atomic** (temp file + `rename`), so an interrupted save cannot
  leave a half-written label file.
- Empty box list ⇒ the label file is truncated to zero bytes, exactly like
  deleting every box in the original tool.
- Parsing is lenient: `\r\n`, tabs, trailing confidence columns, `#` comments and
  blank lines are all accepted. Unusable lines are reported in the sidebar
  instead of silently disappearing.
- `PUT /api/annotations/:id` accepts `{"backup": true}` to keep the previous file
  as `cat.original.txt`.

### Concurrent writes are detected, not silently applied

Saving replaces the whole label file. If the same folder is open in two browser
tabs, or a sync client rewrites a file, a naive save would discard the other
writer's annotations with no warning.

Instead, `GET /api/annotations/:id` returns the file's exact contents as `raw`,
and the client sends a revision token derived from it in the `X-Label-Revision`
header on every save. The server refuses the write with **409** when the file no
longer matches and returns the current contents, and the page asks which version
wins:

```
This label file changed on disk
  on disk now: 3 box(es), 96 bytes · in this page: 5 box(es).
  [ Use the file on disk ]  [ Overwrite with mine ]
```

The dialog cannot be dismissed with <kbd>Esc</kbd> and suppresses the other
shortcuts while it is open, so the decision cannot be lost by accident.

Two details are load-bearing:

- **The token is base64, not the raw text.** HTTP header values cannot contain
  newlines and have trailing whitespace stripped, so a label file — which always
  ends in `\n` — can never round-trip as a header value. Base64 is reversible, so
  the comparison stays byte-exact.
- **The client predicts the bytes it just wrote.** After a successful save the
  page adopts the serialisation it believes it wrote as its next revision. If
  that prediction ever disagreed with the server by one byte, every subsequent
  save of that file would report a phantom conflict. `test/web.test.ts`
  extracts the client's own `serializeBoxes()` from `web/app.js` and asserts it
  matches the server's output, so the two cannot drift.

Image rendering is also deliberate: at 100% zoom and above the canvas draws with
**interpolation disabled**, so judging where an edge falls in a medical image is
a matter of reading pixels rather than guessing at a blurred average. Below 100%
high-quality smoothing is used so the downscaled preview does not alias.

## Project layout

```
node/
├── bin/yolo-annotator.mjs     launcher for `npm link` / npx
├── scripts/
│   ├── browser-probe.mjs      headless-Chrome end-to-end probe (manual)
│   └── build-standalone.mjs   packages the installable macOS/Windows apps
├── packaging/installer.iss    Inno Setup script for the Windows installer
├── src/
│   ├── server/
│   │   ├── main.ts            CLI entry point
│   │   ├── args.ts            argv + environment parsing
│   │   ├── server.ts          routes, static files, graceful shutdown
│   │   ├── router.ts          small HTTP router (params + wildcard)
│   │   ├── static.ts          allow-listed UI assets
│   │   └── workspace.ts       all filesystem access, index, atomic writes
│   └── shared/
│       ├── paths.ts           wire-path rules, image discovery, obj.names
│       ├── yolo.ts            box maths + label (de)serialisation
│       └── image-size.ts      header-only dimension sniffing
├── web/                       the UI (plain HTML/CSS/ES modules)
└── test/                      node:test suites
```

## HTTP API

The UI is a client of the same API, so anything the annotator does can be
scripted. All ids are POSIX-style paths relative to the images root.

| Method & path | Purpose |
| --- | --- |
| `GET /api/images` | classes, groups, warnings and every indexed image |
| `GET /api/image/<id>` | raw image bytes (`ETag` / `Last-Modified` aware) |
| `GET /api/annotations/<id>` | parsed boxes plus per-line warnings and the `raw` revision |
| `PUT /api/annotations/<id>` | replace the label file: `{"boxes":[…]}`; send `X-Label-Revision` to enable conflict detection, or `{"backup":true}` to keep a `.original.txt` |
| `GET /api/summary` | per-group progress counters |
| `POST /api/reindex` | rescan the folder after adding or removing images |
| `POST /api/shutdown` | stop the server (requires `x-shutdown-token`) |

```bash
curl -s localhost:7860/api/annotations/cat.jpg
curl -s -X PUT localhost:7860/api/annotations/cat.jpg \
  -H 'Content-Type: application/json' \
  -d '{"boxes":[{"classId":0,"x":0.5,"y":0.5,"w":0.2,"h":0.2}]}'
```

A `409` response carries `{"error": "...", "details": {"current": "<file text>",
"revision": "<base64>"}}` so a script can reconcile the same way the UI does.

## Security model

The server is a local tool, so the defaults are deliberately conservative:

- It binds to `127.0.0.1` unless you explicitly pass `--host`.
- Every image id is re-resolved against the images root and re-validated with
  `path.relative`; `..`, absolute paths and symlink escapes are rejected. The
  test suite covers traversal attempts against both the read and the write path.
- `POST /api/shutdown` requires a per-run random token injected into the page
  (compared in constant time), so another site open in your browser cannot kill
  the annotator with a cross-origin form post.
- No external network access, no telemetry, no CDN assets.
- `--host 0.0.0.0` exposes read *and* write access to your network. There is no
  authentication, so only do that on a trusted network. Concurrent writers are
  detected rather than clobbered, but that is accidental-corruption protection,
  not access control.

## Development

```bash
npm run typecheck     # tsc --noEmit over src/ and test/
npm test              # node:test — 59 unit and HTTP integration tests
npm run check         # both
```

The integration tests start a real server on an ephemeral port and talk to it
over `fetch`, including path-traversal, shutdown-token and conflict-detection
cases. `test/web.test.ts` also cross-checks the client against the server: it
extracts real functions out of `web/app.js` and evaluates them, which is what
keeps the two languages' serialisation from drifting apart. That file is plain
JavaScript served as-is, so a stray type annotation fails `npm test` rather than
the browser.

`scripts/browser-probe.mjs` drives the real UI in headless Chrome over the
DevTools Protocol — it draws boxes with synthetic mouse events and asserts the
resulting YOLO file, then exercises the shortcuts, navigation, zoom sampling and
both sides of the conflict dialog:

```bash
node src/server/main.ts ../images ../obj.names --port 7871 --no-open &
node scripts/browser-probe.mjs http://127.0.0.1:7871/
```

Set `CHROME_PATH` when Chrome is not at the default macOS location. This probe is
not part of `npm test` because it needs a browser, but it is the only thing that
covers the canvas interaction and the conflict resolution end to end.

### Design notes

- **Boxes are stored in image space** and only transformed at paint time, so
  annotation data never depends on window size or zoom.
- **Repaints are coalesced into one animation frame.** Pointer events can fire
  faster than the display refreshes; painting on each one wastes most of the work
  and makes large images feel heavy. A resize repaints synchronously instead, so
  the cleared canvas is never shown.
- **"Fitted" is a mode, not a one-off action.** A resize while in fitted mode
  recomputes the scale, so an image that used to fit cannot silently become
  clipped. Startup depends on this: the initial scale is 1, so a wrong initial
  flag would draw a 960×922 image into a 583px-tall stage before the user
  touched anything.
- **Panning is never inferred from the zoom level.** An earlier revision made a
  plain left-drag pan once the image overflowed the window, to avoid a hidden
  modifier. That was a mistake: it broke drawing exactly where precision matters,
  and the crosshair cursor lied about what the mouse would do. Drawing is now
  unconditional; panning needs Space, the ✋ toggle, or a secondary button.
- **Server-side type stripping** (Node ≥ 22.18) means one source of truth: the
  `.ts` files that run are the `.ts` files that are type-checked.
- **The UI has no build step.** `web/app.js` is plain ES modules.
- **All filesystem writes funnel through `Workspace`**, which is what makes the
  traversal guarantees auditable in one place.
- **Conflicts are resolved outside the save chain.** Awaiting a replacement save
  from inside `save.promise` would make the new write wait on the chain that is
  waiting on it, so the forced write is started rather than awaited.

## Differences from the original you may notice

- **Saving is automatic.** The C++ tool also saved on every box change, so this
  matches; there is additionally an explicit `s`.
- **Escape stops the server** instead of closing a window, and the page then says
  so. Use `Ctrl+C` in the terminal if the browser is gone.
- **`j` opens a dialog** instead of reading from stdin, because a browser page
  cannot read the terminal. It accepts a number or a file-name fragment.
- **Boxes are clamped** to the image and must be at least ~2 CSS pixels, versus
  the fixed 5-pixel minimum of the original.
