#!/usr/bin/env node
/**
 * Builds installable, self-contained apps for macOS and Windows.
 *
 * Approach: the official Node runtime is bundled next to the application
 * sources, plus a small launcher that opens the UI in a Chromium app window.
 * Nothing has to be installed on the target machine.
 *
 * A true single-file executable was tried first via Node's SEA support and
 * abandoned: the blob-injected binary segfaults on Apple Silicon with both
 * Node 24 and Node 22 (postject patching is not compatible), and it could not
 * be signed usefully.
 *
 * Usage
 *   node scripts/build-standalone.mjs [--target mac|win|all] [--out <dir>]
 *                                     [--no-download] [--no-zip]
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const APP_VERSION = '2.0.0';
const NODE_VERSION = '24.19.0';
/** Must match src/server/args.ts; used by the launcher's already-running check. */
const DEFAULT_PORT = 7860;
/** Also the .dmg volume label; a collision here makes hdiutil fail. */
const VOLUME_NAME = 'YOLO Annotator';

/** Only these ship; tests, tooling and the build scripts do not. */
const INCLUDED_PATHS = ['src', 'web', 'package.json', 'README.md'];

/** The main script, relative to the app root, used by every launcher. */
const MAIN = 'src/server/main.ts';

const HELP = `Build standalone, installable YOLO Annotator apps.

Usage
  node scripts/build-standalone.mjs [options]

Options
  --target <mac|win|all>   Which apps to build           (default: all)
  --out <directory>        Output directory              (default: ./dist)
  --no-download            Reuse a cached runtime in <out>/.cache
  --no-zip                 Skip the ZIP archives
  -h, --help               Show this message

Outputs (in <out>)
  mac  YOLO-Annotator-<v>.pkg  double-click installer, app goes to /Applications
       YOLO-Annotator-<v>.dmg  drag-to-Applications disk image
       YOLO Annotator.app      the bundle itself, also usable directly
  win  YOLO-Annotator-Setup-<v>.exe  double-click installer (NSIS)
       YOLO-Annotator-<v>-windows-x64.zip  portable folder

The Windows installer is compiled with NSIS, which runs on macOS, so no Windows
machine is required to produce all of these. Install it with: brew install makensis
`;

/* ------------------------------------------------------------------ args */

function parseArgs(argv) {
  const options = { target: 'all', out: path.join(projectRoot, 'dist'), download: true, zip: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--target') options.target = argv[++index] ?? '';
    else if (arg === '--out') options.out = path.resolve(argv[++index] ?? '');
    else if (arg === '--no-download') options.download = false;
    else if (arg === '--no-zip') options.zip = false;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!['mac', 'win', 'all'].includes(options.target)) {
    throw new Error(`--target must be mac, win or all (received "${options.target}")`);
  }
  return options;
}

/* --------------------------------------------------------------- runtime */

function runtimeAsset(target) {
  return target === 'mac'
    ? `node-v${NODE_VERSION}-darwin-arm64.tar.gz`
    : `node-v${NODE_VERSION}-win-x64.zip`;
}

function firstLine(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n').find((line) => line.trim() !== '') ?? text;
}

/**
 * Makes a staged tree readable by whoever installs it.
 *
 * This is not cosmetic. `fs.cp` preserves the source mode, and this repository's
 * files are `-rw-------`, so an app built without this step ships files that the
 * installing user cannot read. Node then fails with "Cannot find module" for a
 * file that is plainly present, the launcher swallows the error, and
 * double-clicking the app does nothing at all.
 *
 * Directories become 0755; files become 0644, except anything that already had
 * an execute bit, which becomes 0755 (the bundled `node`, the launchers).
 */
async function normalizeModes(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await fs.chmod(target, 0o755);
      await normalizeModes(target);
      continue;
    }
    if (!entry.isFile()) continue; // leave symlinks alone
    const stat = await fs.stat(target);
    const executable = (stat.mode & 0o111) !== 0;
    await fs.chmod(target, executable ? 0o755 : 0o644);
  }
  await fs.chmod(root, 0o755);
}

/**
 * Removes a directory, repairing permissions first.
 *
 * A previous build can leave files the current user cannot read (that is the
 * bug `normalizeModes` fixes), and `fs.rm` then fails with EACCES on a path it
 * cannot descend. Making the tree writable first turns that into a clean start
 * rather than a confusing partial build.
 */
async function removeTree(target) {
  try {
    await run('chmod', ['-R', 'u+rwX', target]).catch(() => undefined);
  } catch {
    // chmod is best effort; fs.rm may still succeed.
  }
  await fs.rm(target, { recursive: true, force: true, maxRetries: 3 });
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** Downloads (once) and extracts the official runtime for `target`. */
async function prepareRuntime(target, out, allowDownload) {
  const asset = runtimeAsset(target);
  const cache = path.join(out, '.cache');
  await fs.mkdir(cache, { recursive: true });
  const archive = path.join(cache, asset);

  if (!(await exists(archive))) {
    if (!allowDownload) throw new Error(`--no-download given but ${archive} is missing`);
    const url = `https://nodejs.org/dist/v${NODE_VERSION}/${asset}`;
    process.stdout.write(`  downloading ${url}\n`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`download failed: ${response.status}`);
    await fs.writeFile(archive, Buffer.from(await response.arrayBuffer()));
  }

  const extractDir = path.join(cache, `x-${target}`);
  await fs.rm(extractDir, { recursive: true, force: true });
  await fs.mkdir(extractDir, { recursive: true });
  if (asset.endsWith('.tar.gz')) await run('tar', ['-xzf', archive, '-C', extractDir]);
  else await run('unzip', ['-q', archive, '-d', extractDir]);

  const entries = await fs.readdir(extractDir);
  const root = entries.find((name) => name.startsWith('node-v'));
  if (root === undefined) throw new Error(`unexpected archive layout for ${asset}`);
  return path.join(extractDir, root);
}

/** Copies the application sources into `destination`. */
async function copySources(destination) {
  for (const relative of INCLUDED_PATHS) {
    const source = path.join(projectRoot, relative);
    if (!(await exists(source))) continue;
    await fs.cp(source, path.join(destination, relative), { recursive: true });
  }
  await fs.mkdir(path.join(destination, 'images'), { recursive: true });
  await fs.writeFile(path.join(destination, 'obj.names'), 'class-0\nclass-1\n', 'utf8');
}

/* -------------------------------------------------------------- launchers */

const PACKAGING = path.join(projectRoot, 'packaging');

/**
 * Reads a launcher template and substitutes build-time values.
 *
 * The launchers are real shell/cmd files on disk rather than strings embedded
 * here: they can be syntax-checked (`sh -n`) and read without decoding JS
 * escapes, which is exactly the class of bug that made an earlier revision of
 * this script fail on `${VAR:-default}` and `\\(`.
 */
async function renderTemplate(file, replacements) {
  const source = path.join(PACKAGING, file);
  // The repo may hold these as 0600; make sure the generated artifacts are not.
  await fs.chmod(source, 0o644).catch(() => undefined);
  let text = await fs.readFile(source, 'utf8');
  for (const [token, value] of Object.entries(replacements)) {
    text = text.split(token).join(value);
  }
  return text;
}

/* --------------------------------------------------------------------- mac */

const MAC_BUNDLE_ID = 'org.yoloannotator.app';

function infoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>YOLO Annotator</string>
  <key>CFBundleDisplayName</key><string>YOLO Annotator</string>
  <key>CFBundleExecutable</key><string>yolo-annotator</string>
  <key>CFBundleIdentifier</key><string>${MAC_BUNDLE_ID}</string>
  <key>CFBundleVersion</key><string>${APP_VERSION}</string>
  <key>CFBundleShortVersionString</key><string>${APP_VERSION}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSUIElement</key><false/>
</dict>
</plist>
`;
}

async function buildMac(out) {
  const appName = 'YOLO Annotator.app';
  const bundle = path.join(out, appName);
  process.stdout.write(`\nBuilding ${appName}\n`);
  await removeTree(bundle);

  const contents = path.join(bundle, 'Contents');
  const macos = path.join(contents, 'MacOS');
  const resources = path.join(contents, 'Resources');
  await fs.mkdir(macos, { recursive: true });
  await fs.mkdir(resources, { recursive: true });

  const runtime = await prepareRuntime('mac', out, true);
  process.stdout.write('  copying the Node runtime\n');
  await fs.mkdir(path.join(resources, 'node'), { recursive: true });
  await fs.cp(path.join(runtime, 'bin'), path.join(resources, 'node', 'bin'), { recursive: true });
  await fs.chmod(path.join(resources, 'node', 'bin', 'node'), 0o755);

  process.stdout.write('  copying the application\n');
  const appDir = path.join(resources, 'app');
  await fs.mkdir(appDir, { recursive: true });
  await copySources(appDir);

  const launcherBody = await renderTemplate('launcher-macos.sh', {
    '@MAIN@': MAIN,
    '@DEFAULT_PORT@': String(DEFAULT_PORT),
  });
  const launcher = path.join(macos, 'yolo-annotator');
  await fs.writeFile(launcher, launcherBody, 'utf8');
  await fs.chmod(launcher, 0o755);

  await fs.writeFile(path.join(contents, 'Info.plist'), infoPlist(), 'utf8');

  // Must happen before signing: a signature covers file metadata, and an
  // unreadable payload is what made the first build silently fail to launch.
  process.stdout.write('  normalizing permissions\n');
  await normalizeModes(bundle);

  process.stdout.write('  signing (ad-hoc)\n');
  // Ad-hoc signing keeps Gatekeeper quiet about a modified bundle. It is not a
  // Developer ID signature, so first launch still needs right-click > Open.
  await run('codesign', ['--force', '--deep', '--sign', '-', bundle]).catch(() => undefined);

  /*
   * Click-installable artifacts, in order of convenience for the user:
   *   .pkg  double-click, follow the installer, app lands in /Applications
   *   .dmg  double-click, drag the app onto the Applications shortcut
   *   .zip  fallback for environments where hdiutil cannot mount a volume
   */
  const artifacts = [];
  const dmg = await buildDmg(out, bundle, appName);
  if (dmg !== null) artifacts.push(dmg);

  const pkg = await buildPkg(out, bundle);
  if (pkg !== null) artifacts.push(pkg);

  if (artifacts.length === 0) {
    const zip = path.join(out, `YOLO-Annotator-${APP_VERSION}-macos.zip`);
    await fs.rm(zip, { force: true });
    await run('zip', ['-q', '-r', '-X', '-y', path.basename(zip), appName], { cwd: out });
    artifacts.push(zip);
  }

  for (const artifact of artifacts) {
    const size = (await fs.stat(artifact)).size;
    process.stdout.write(`  -> ${path.basename(artifact)} (${(size / 1048576).toFixed(1)} MB)\n`);
  }
  return { bundle, artifacts };
}

/** Builds a drag-to-Applications disk image, or null when hdiutil cannot mount. */
async function buildDmg(out, bundle, appName) {
  const stage = path.join(out, '.dmg-stage');
  const dmg = path.join(out, `YOLO-Annotator-${APP_VERSION}.dmg`);
  await fs.rm(stage, { recursive: true, force: true });
  await fs.rm(dmg, { force: true });
  await fs.mkdir(stage, { recursive: true });

  // The layout users expect: the app beside a shortcut to /Applications.
  await fs.cp(bundle, path.join(stage, appName), { recursive: true });
  await fs.symlink('/Applications', path.join(stage, 'Applications'));

  process.stdout.write('  building the .dmg\n');
  const createImage = () =>
    run('hdiutil', [
      'create', '-volname', VOLUME_NAME,
      '-srcfolder', stage, '-ov', '-format', 'UDZO', dmg,
    ]);

  try {
    try {
      await createImage();
    } catch (first) {
      /*
       * hdiutil reports "no space left on device" (a misleading message) when a
       * volume of the same name is already attached, which happens if an earlier
       * run was interrupted between attach and detach. Clear it and try once
       * more before giving up.
       */
      const detail = String(first?.stderr ?? '') + String(first?.stdout ?? '');
      if (/no space left|already (mounted|exists)|resource busy/i.test(detail)) {
        process.stdout.write('  clearing a stale YOLO Annotator volume and retrying\n');
        await run('hdiutil', ['detach', `/Volumes/${VOLUME_NAME}`, '-force']).catch(() => undefined);
        await run('hdiutil', ['detach', `/Volumes/${VOLUME_NAME} 1`, '-force']).catch(() => undefined);
        await fs.rm(dmg, { force: true });
        await createImage();
      } else {
        throw first;
      }
    }
  } catch (error) {
    // hdiutil reports the reason on stderr, which execFile does not surface in
    // the Error message. Print it, otherwise this failure is undiagnosable.
    const detail = [error?.stderr, error?.stdout]
      .map((value) => (value === undefined ? '' : String(value).trim()))
      .filter((value) => value !== '')
      .join(' | ');
    process.stdout.write(`  dmg unavailable (${firstLine(error)})${detail === '' ? '' : `\n    ${detail}`}\n`);
    await fs.rm(stage, { recursive: true, force: true });
    return null;
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
  return dmg;
}

/** Builds a double-click installer package that installs into /Applications. */
async function buildPkg(out, bundle) {
  const pkg = path.join(out, `YOLO-Annotator-${APP_VERSION}.pkg`);
  await fs.rm(pkg, { force: true });

  const payload = path.join(out, '.pkg-payload');
  const scripts = path.join(out, '.pkg-scripts');
  await fs.rm(payload, { recursive: true, force: true });
  await fs.rm(scripts, { recursive: true, force: true });
  await fs.mkdir(path.join(payload, 'Applications'), { recursive: true });
  await fs.mkdir(scripts, { recursive: true });
  await fs.cp(bundle, path.join(payload, 'Applications', path.basename(bundle)), { recursive: true });

  // A postinstall script runs as root; it must not launch a GUI app. It only
  // prepares the per-user data folder and prints what to do next.
  const postinstall = path.join(scripts, 'postinstall');
  await fs.writeFile(
    postinstall,
    `#!/bin/sh
# Runs as root after the app is copied. Creates the data folder for the
# installing user so the first launch has somewhere to put images.
set -e
TARGET_USER="\${USER:-}"
if [ -n "$TARGET_USER" ] && [ "$TARGET_USER" != "root" ]; then
  HOME_DIR=$(dscl . -read "/Users/$TARGET_USER" NFSHomeDirectory 2>/dev/null | awk '{print $2}')
else
  HOME_DIR=""
fi
if [ -n "$HOME_DIR" ] && [ -d "$HOME_DIR" ]; then
  DATA="$HOME_DIR/Documents/YOLO Annotator"
  mkdir -p "$DATA/images" 2>/dev/null || true
  if [ ! -f "$DATA/obj.names" ]; then
    printf 'class-0\\nclass-1\\n' > "$DATA/obj.names" 2>/dev/null || true
  fi
  chown -R "$TARGET_USER" "$DATA" 2>/dev/null || true
fi
exit 0
`,
    'utf8',
  );
  await fs.chmod(postinstall, 0o755);

  process.stdout.write('  building the .pkg\n');
  const componentPlist = path.join(out, '.pkg-components.plist');
  try {
    await run('pkgbuild', [
      '--root', payload,
      '--identifier', MAC_BUNDLE_ID,
      '--version', APP_VERSION,
      '--scripts', scripts,
      '--install-location', '/',
      pkg,
    ]);
  } catch (error) {
    process.stdout.write(`  pkg unavailable (${firstLine(error)})\n`);
    return null;
  } finally {
    await fs.rm(payload, { recursive: true, force: true });
    await fs.rm(scripts, { recursive: true, force: true });
    await fs.rm(componentPlist, { force: true });
  }
  return pkg;
}

/* --------------------------------------------------------------------- win */

async function buildWindows(out) {
  const folderName = 'yolo-annotator';
  const folder = path.join(out, folderName);
  process.stdout.write(`\nBuilding ${folderName} (portable + installer payload)\n`);
  await removeTree(folder);
  await fs.mkdir(path.join(folder, 'node'), { recursive: true });

  const runtime = await prepareRuntime('win', out, true);
  process.stdout.write('  copying the Node runtime\n');
  await fs.copyFile(path.join(runtime, 'node.exe'), path.join(folder, 'node', 'node.exe'));

  process.stdout.write('  copying the application\n');
  await copySources(folder);
  // The .cmd does the work; the .vbs wrapper lets shortcuts launch it with no
  // console window, which is what makes it feel like an installed app.
  await fs.copyFile(
    path.join(PACKAGING, 'launcher-windows.cmd'),
    path.join(folder, 'yolo-annotator.cmd'),
  );
  await fs.copyFile(
    path.join(PACKAGING, 'launcher-windows-hidden.vbs'),
    path.join(folder, 'yolo-annotator-hidden.vbs'),
  );
  await fs.copyFile(
    path.join(PACKAGING, 'launcher-windows-reset.vbs'),
    path.join(folder, 'yolo-annotator-reset.vbs'),
  );
  await fs.writeFile(
    path.join(folder, 'README.txt'),
    [
      'YOLO Annotator — portable Windows build',
      '',
      'Double-click  yolo-annotator.cmd  to start.',
      'Your images and obj.names live in  %USERPROFILE%\\Documents\\YOLO Annotator.',
      'Pass explicit paths to use another folder:',
      '  yolo-annotator.cmd D:\\photos D:\\obj.names',
      '',
    ].join('\r\n'),
    'utf8',
  );

  // A real installer, compiled with NSIS. NSIS runs on macOS, which is why it
  // was chosen over Inno Setup: the .exe can be built without a Windows machine.
  const installer = await buildWindowsInstaller(out, folder);
  if (installer !== null) {
    const size = (await fs.stat(installer)).size;
    process.stdout.write(`  -> ${path.basename(installer)} (${(size / 1048576).toFixed(1)} MB)\n`);
  }

  await normalizeModes(folder);

  const zip = path.join(out, `YOLO-Annotator-${APP_VERSION}-windows-x64.zip`);
  await fs.rm(zip, { force: true });
  process.stdout.write('  zipping the portable folder\n');
  await run('zip', ['-q', '-r', '-X', path.basename(zip), folderName], { cwd: out });
  const size = (await fs.stat(zip)).size;
  process.stdout.write(`  -> ${path.basename(zip)} (${(size / 1048576).toFixed(1)} MB)\n`);
  return folder;
}

/**
 * Compiles the NSIS installer. Returns null when `makensis` is unavailable, so
 * a machine without it still produces the portable folder.
 */
async function buildWindowsInstaller(out, payloadFolder) {
  // Named for what it is: this build opens the UI in a browser, unlike the
  // Electron desktop app. The two must never share a filename.
  const target = path.join(out, `YOLO-Annotator-BROWSER-Setup-${APP_VERSION}.exe`);
  await fs.rm(target, { force: true });
  process.stdout.write('  compiling the Windows installer (makensis)\n');
  try {
    await run('makensis', [
      `-DVERSION=${APP_VERSION}`,
      `-DSRCDIR=${payloadFolder}`,
      `-DOUTDIR=${out}`,
      path.join(PACKAGING, 'installer.nsi'),
    ]);
  } catch (error) {
    const message = firstLine(error);
    if (message.includes('ENOENT')) {
      process.stdout.write(
        '  makensis not found; skipping the installer.\n' +
          '  Install it with:  brew install makensis\n',
      );
    } else {
      process.stdout.write(`  installer build failed: ${message}\n`);
    }
    return null;
  }
  return (await exists(target)) ? target : null;
}

/* -------------------------------------------------------------------- main */

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const targets = options.target === 'all' ? ['mac', 'win'] : [options.target];
  await fs.mkdir(options.out, { recursive: true });
  process.stdout.write(`Building ${targets.join(' + ')} into ${path.relative(process.cwd(), options.out)}\n`);

  for (const target of targets) {
    if (target === 'mac') await buildMac(options.out);
    else await buildWindows(options.out);
  }

  process.stdout.write(`\nDone. Artifacts in ${path.relative(process.cwd(), options.out)}\n`);
  return 0;
}

main().then(
  (code) => {
    if (code !== 0) process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`build failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
