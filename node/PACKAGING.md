# Packaging

Two kinds of build are produced, and they solve different problems.

| | Desktop app (recommended) | Browser app |
| --- | --- | --- |
| Command | `npm run package:desktop` | `npm run package` |
| Output folder | `dist-desktop/` | `node/dist/` |
| macOS file | `YOLO Annotator-2.0.0.dmg` | `YOLO-Annotator-2.0.0.pkg` |
| Windows file | **`YOLO Annotator Setup 2.0.0.exe`** | **`YOLO-Annotator-BROWSER-Setup-2.0.0.exe`** |
| Result | a real native window, app icon, in Applications / Start Menu | starts a server and opens your browser |
| Size | ~122 MB (.dmg), ~106 MB (installer) | ~43 MB (.pkg), ~22 MB (installer) |
| Needs a browser | **no** | yes |
| Dataset switching | native folder/file dialogs inside the app | picker inside the page |

> **The two Windows installers are different programs.** The desktop one opens
> its own window; the `-BROWSER-` one starts the server and hands the UI to your
> browser. They were once both named `YOLO-Annotator-Setup-*.exe`, which made the
> wrong build easy to install by accident; the names are now unambiguous.

**Use the desktop build** unless you specifically want the lighter, browser-based
one. Both share the same server and the same canvas UI.

## The desktop app

A normal desktop application: double-click to open, and a window appears — no
browser, no address bar, no terminal.

```bash
cd node
npm run package:desktop:mac     # .dmg + .zip  -> dist-desktop/
npm run package:desktop:win     # NSIS installer + portable .exe
npm run package:desktop         # both (Windows builds work on macOS)
npm run desktop                 # run it from source, no packaging
```

On first launch it shows a **Choose your dataset** card with two native pickers —
one for the images folder, one for the classes file. Nothing has to be arranged
in advance, and the choice is remembered. **Choose dataset…** in the toolbar
reopens the dialog at any time, and swapping folders takes effect immediately
without restarting.

### How it works

Electron hosts the same HTTP server, bound to a random loopback port, and the
window is its only client. That way the canvas UI is unchanged and still runs in
a browser if you want it to; the desktop shell adds exactly two things a web page
cannot do — read a filesystem path, and draw its own window.

The server gained `GET/POST /api/dataset` for this, because the command-line tool
opens one dataset for the process lifetime while the desktop app must be able to
change it. A swap builds a complete new index and only then becomes visible, so a
request during a swap sees either the old dataset or the new one, never a
half-built one.

### Packaging notes

electron-builder is driven by `scripts/build-desktop.mjs`, which stages a
conventional app layout first. That staging step is not incidental: pointing
electron-builder at paths outside its app root silently produced an `app.asar`
containing only `package.json`, and a relative `directories.app` resolved against
a parent workspace. The generated config bakes in absolute paths.

`--disable-gpu` and `--no-sandbox` are deliberately **not** set, and the app is
ad-hoc signed (`codesign --force --deep --sign -`) after building: macOS refuses
to launch an Electron bundle whose signature does not match its resources, and
the failure looks like "the app opens nothing at all" rather than an error.

### `asar` is disabled on purpose

`asar: false` ships the app as plain files inside `resources/app/`. That is not
laziness: the `@electron/asar` installed here (3.4.1) **corrupts every packed
file** — it stores offsets inflated by the header size, so reading any file back
out of the archive returns the wrong bytes. The symptom is that the packaged app
cannot find its own `package.json`, and on Windows it never opens a window at
all. It was verified by packing a two-file test app and reading both files back.

Shipping a few files uncompressed costs nothing at this size and makes the
installed bundle inspectable.

### Verifying a Windows build without Windows

`7z` can unpack the NSIS installer and its payload, which is enough to prove what
will be installed:

```bash
7z x -o/tmp/exe "dist-desktop/YOLO Annotator Setup 2.0.0.exe"
7z x -o/tmp/pay /tmp/exe/'$PLUGINSDIR'/app-64.7z
ls /tmp/pay/resources/app            # main.cjs, preload.cjs, package.json, src, web
node -e "JSON.parse(require('fs').readFileSync('/tmp/pay/resources/app/package.json'))"
```

A correct payload has a parseable `package.json` whose `main` is `main.cjs`, a
`main.cjs` containing `BrowserWindow`, and **no** `.vbs`/`.cmd` launchers.

---

# Browser-app packaging

Produces a self-contained app for macOS and Windows. Nothing needs to be
installed on the target machine — the official Node runtime ships inside the app.

```bash
cd node
npm run package          # both
npm run package:mac
npm run package:win
```

Output lands in `node/dist/`.

## What you get

| Platform | Artifact | How the user installs it |
| --- | --- | --- |
| macOS | `YOLO-Annotator-2.0.0.pkg` | **Double-click**, follow the installer — app lands in /Applications |
| macOS | `YOLO-Annotator-2.0.0.dmg` | **Double-click**, drag the app onto the Applications shortcut |
| macOS | `YOLO Annotator.app` | The bundle itself: drag to Applications |
| Windows | `YOLO-Annotator-Setup-2.0.0.exe` | **Double-click**, follow the installer — wizard, Start Menu and desktop shortcuts |
| Windows | `YOLO-Annotator-2.0.0-windows-x64.zip` | Portable: unzip, run `yolo-annotator.cmd` |

Typical sizes: 43 MB (.dmg), 37 MB (.pkg), 22 MB (Windows installer), 33 MB
(portable zip). The bulk is the Node runtime.

**Both installers are click-to-install**: double-clicking starts a normal
installer, no terminal involved. After installing, the app appears in
Launchpad / the Start Menu, and double-clicking *it* starts the annotator and
opens the UI.

## How the user picks a dataset

The app does **not** require folders to be arranged in advance. On launch it
resolves the dataset in this order:

1. **A remembered choice.** After the first successful selection it starts
   straight away, with no questions.
2. **The conventional folder**, if it already contains images:
   `~/Documents/YOLO Annotator` (macOS) or
   `%USERPROFILE%\Documents\YOLO Annotator` (Windows).
3. **A picker.** Otherwise it opens real OS dialogs — "Select the folder that
   contains your images", then "Select your classes file" — and remembers the
   answer.

This is why the launchers exist at all: a web page cannot hand a filesystem path
to the server, so only native code can present a folder picker. The chosen paths
are passed to the server as its two positional arguments, exactly as on the
command line.

The selection is stored at:

- macOS: `~/Library/Application Support/YOLO Annotator/dataset.conf`
- Windows: `%LOCALAPPDATA%\YOLO Annotator\dataset.conf`

A remembered path that has since been moved or deleted is detected and the
picker is shown again, rather than failing.

### Choosing a different folder

A double-clicked `.app` cannot be given command-line arguments, so "forget the
dataset" is expressed as a sentinel file that the launcher consumes on start:

- **Windows**: there is a second Start Menu shortcut,
  *YOLO Annotator (choose folder)*, which writes the sentinel and relaunches.
- **macOS**: the folder-missing dialog offers *Choose another folder*, or run
  the executable directly with `--reset`:

```bash
"/Applications/YOLO Annotator.app/Contents/MacOS/yolo-annotator" --reset
```

### Data folder

`~/Documents/YOLO Annotator` is still created on first run, so there is an
obvious place to drop images. Override where the app looks with
`YOLO_ANNOTATOR_DATA`, or pass explicit paths to bypass the pickers entirely:

```bash
"/Applications/YOLO Annotator.app/Contents/MacOS/yolo-annotator" /path/to/photos /path/to/obj.names
```

## Gatekeeper and SmartScreen

The artifacts are **not signed with a paid certificate**, so both platforms warn
on first launch:

- **macOS**: right-click the app → **Open** → confirm. Once only. (The build
  ad-hoc signs the bundle, which is what keeps it from being reported as damaged.)
  To remove the warning entirely you need an Apple Developer ID and
  `codesign --deep --force --options runtime --sign "Developer ID Application: …"`
  plus `xcrun notarytool submit`.
- **Windows**: SmartScreen shows "Windows protected your PC" → **More info** →
  **Run anyway**. Removing this needs an EV code-signing certificate.

## How it is built, and why

Each app is a folder containing:

```
YOLO Annotator.app/Contents/
├── MacOS/yolo-annotator          launcher: resolves its own path, sets the data dir, execs node
├── Info.plist
└── Resources/
    ├── node/bin/node             the official Node runtime (~120 MB)
    └── app/                      src/, web/, package.json, README
```

`scripts/build-standalone.mjs` downloads the runtime from `nodejs.org` (cached in
`dist/.cache`, so repeat builds are offline), copies it in, and writes the
launcher. `--no-download` forbids network access.

### The launchers

Double-clicking the installed app must "just work", which needs more than
`exec node`:

1. It resolves the dataset (remembered → conventional → picker), creating
   `~/Documents/YOLO Annotator` as an obvious place for images.
2. It starts the server on **port 0** — the OS picks a free port — so launching a
   second copy can never fail with "port in use".
3. Because the port is dynamic, the launcher cannot guess the URL. The server
   therefore supports `--print-url`, which prints exactly one line,
   `URL=http://127.0.0.1:PORT/`, and nothing else. The launcher reads that,
   opens the browser, and waits, so quitting the app stops the server.
4. On Windows the Start Menu/desktop shortcuts point at a small `.vbs` wrapper,
   because invoking a `.cmd` directly flashes a console window.

### Why not a single executable file?

Node's SEA (`--experimental-sea-config` + `postject`) was tried first and
abandoned: **the blob-injected binary segfaults on Apple Silicon**, with both
Node 24.19 and Node 22.20, whether or not the required
`allow-unsigned-executable-memory` entitlement is applied. The unpatched copy of
the same binary runs fine, so it is the injection, not the runtime. There is no
maintained alternative injector.

Bundling the runtime instead is boring and reliable: no binary patching, no
entitlement juggling, and the same layout works on both platforms.

### The Windows installer

`packaging/installer.nsi` is an **NSIS** script, compiled by `makensis`.
NSIS was chosen over Inno Setup specifically because it **runs on macOS**, so a
Windows machine is not needed to produce the `.exe`:

```bash
brew install makensis
npm run package:win
```

If `makensis` is missing the build still produces the portable folder and says
so, rather than failing.

[`.github/workflows/release.yml`](.github/workflows/release.yml) builds all four
artifacts on both runners and attaches them to a GitHub release. Push a tag
(`git tag v2.0.0 && git push origin v2.0.0`) or run the workflow manually.

## Verify a build

```bash
# macOS: run the packaged launcher exactly as Finder would
YOLO_ANNOTATOR_DATA=/tmp/demo "/path/to/YOLO Annotator.app/Contents/MacOS/yolo-annotator"
# then open the printed URL
```

A packaged build is only proven by exercising the UI in it, not by the file
existing. `scripts/browser-probe.mjs` can drive it:

```bash
node scripts/browser-probe.mjs http://127.0.0.1:7860/
```

## Known limitations

- **Apple Silicon only** for the macOS build. For Intel or a universal binary,
  set a `darwin-x64` runtime in the matrix and `lipo` the two together.
- **Windows x64 only** (no arm64 build), and the installer is 32-bit PE header
  with a 64-bit payload — standard for NSIS and runs on all x64 Windows.
- The macOS `.dmg` needs `hdiutil`, which mounts a volume. In a restricted
  sandbox or CI container that forbids this, the build prints the reason and
  continues with the `.pkg`, which installs the same way. A "no space left on
  device" message from `hdiutil` usually means a stale volume of the same name is
  attached; the build detaches it and retries once.
- No auto-update. Reinstall to upgrade.
- Neither installer is notarised, so Gatekeeper/SmartScreen warn on first run.
