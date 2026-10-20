#!/usr/bin/env node
/**
 * Packages the Electron desktop app.
 *
 * Why a staging directory: electron-builder treats `directories.app` (or the
 * config's folder) as the application root, and paths that escape it with `../`
 * are not archived the way you would expect — the first attempt produced an
 * app.asar with no entry file. So the app is assembled in a staging folder with
 * a conventional layout and electron-builder is pointed at that.
 *
 * Staged layout:
 *   <stage>/package.json     electron-builder entry
 *   <stage>/main.cjs         Electron main process
 *   <stage>/preload.cjs      context bridge
 *   <stage>/src/**           the HTTP server and shared code (TypeScript)
 *   <stage>/web/**           the canvas UI
 *
 * Usage
 *   node scripts/build-desktop.mjs [--mac] [--win] [--dir] [--arch <a>]
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stagingRoot = path.join(projectRoot, '.desktop-stage');
const outputRoot = path.join(path.dirname(projectRoot), 'dist-desktop');

const HELP = `Package the Electron desktop app.

Usage
  node scripts/build-desktop.mjs [options]

Options
  --mac          Build the macOS app (.dmg + .zip)          default when on macOS
  --win          Build the Windows installer (.exe, portable)
  --dir          Unpacked directory only (fast; for testing)
  --arch <a>     Set both targets (arm64 | x64 | universal)
  --mac-arch <a> macOS architecture                        default: this Mac
  --win-arch <a> Windows architecture                      default: x64
  -h, --help     Show this message
`;

function parseArgs(argv) {
  const options = {
    mac: false,
    win: false,
    dir: false,
    // Independent defaults: a Windows build from an Apple Silicon Mac must be
    // x64, because that is what real Windows machines run.
    macArch: process.arch === 'x64' ? 'x64' : 'arm64',
    winArch: 'x64',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--mac') options.mac = true;
    else if (arg === '--win') options.win = true;
    else if (arg === '--dir') options.dir = true;
    else if (arg === '--arch') {
      const arch = argv[++i] ?? process.arch;
      options.macArch = arch;
      options.winArch = arch === 'universal' ? 'x64' : arch;
    }
    else if (arg === '--mac-arch') options.macArch = argv[++i] ?? options.macArch;
    else if (arg === '--win-arch') options.winArch = argv[++i] ?? options.winArch;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!options.mac && !options.win) {
    if (process.platform === 'darwin') options.mac = true;
    else if (process.platform === 'win32') options.win = true;
    else options.mac = true;
  }
  return options;
}

async function copyDir(from, to) {
  await fs.cp(from, to, { recursive: true });
}

/** Assembles the app into the staging folder. */
async function stage() {
  await fs.rm(stagingRoot, { recursive: true, force: true });
  await fs.mkdir(stagingRoot, { recursive: true });

  const desktop = path.join(projectRoot, 'src', 'desktop');
  await fs.copyFile(path.join(desktop, 'main.cjs'), path.join(stagingRoot, 'main.cjs'));
  await fs.copyFile(path.join(desktop, 'preload.cjs'), path.join(stagingRoot, 'preload.cjs'));

  await copyDir(path.join(projectRoot, 'src'), path.join(stagingRoot, 'src'));

  /*
   * The server sources are ESM while main.cjs is CommonJS. Without this, Node
   * reparses every .ts file to work out its module type and prints a
   * MODULE_TYPELESS_PACKAGE_JSON warning on each start. The marker has to be the
   * nearest package.json to those files, so it goes in src/, not the app root
   * (which must stay CommonJS for main.cjs).
   */
  await fs.writeFile(
    path.join(stagingRoot, 'src', 'package.json'),
    `${JSON.stringify({ type: 'module' }, null, 2)}\n`,
    'utf8',
  );
  await copyDir(path.join(projectRoot, 'web'), path.join(stagingRoot, 'web'));
  await fs.copyFile(path.join(projectRoot, 'README.md'), path.join(stagingRoot, 'README.md'));

  // The entry manifest electron-builder reads.
  const version = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8')).version;
  await fs.writeFile(
    path.join(stagingRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: 'yolo-annotator-desktop',
        // The product name shows in Start Menu / Applications and on the installer,
    // and must be distinguishable from the browser-based build ("… (browser)").
    productName: 'YOLO Annotator',
        version,
        description: 'Desktop YOLO bounding-box annotator',
        main: 'main.cjs',
        author: 'YOLO Annotator',
        license: 'MIT',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  // `node_modules` must exist (empty is fine): electron-builder treats a
  // package with dependencies as needing a dependency tree, and the server has
  // none. An empty folder keeps its traversal cheap and predictable.
  await fs.mkdir(path.join(stagingRoot, 'node_modules'), { recursive: true });

  return stagingRoot;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }

  process.stdout.write('Staging the desktop app\n');

  /*
   * The icon is generated rather than committed: the repository holds source
   * only, and a PNG/ICNS can be reproduced exactly from scripts/make-icon.mjs.
   */
  await run(process.execPath, [path.join(projectRoot, 'scripts', 'make-icon.mjs')], {
    cwd: projectRoot,
  }).catch((error) => {
    process.stdout.write(`  icon generation failed (${error instanceof Error ? error.message : String(error)}) — packaging will use Electron's default\n`);
  });

  await stage();

  /*
   * The architecture flag is applied per target. Relying on electron-builder's
   * default produced *both* arm64 and x64 Windows builds and a 206 MB installer
   * that installed the wrong one on most machines.
   */
  // The architecture lives in the generated config, because a `target: arch`
  // list there overrides these flags anyway.
  const args = [];
  if (options.mac) args.push('--mac');
  if (options.win) args.push('--win');
  if (options.dir) args.push('--dir');

  /*
   * `files` are passed on the command line as absolute paths. electron-builder
   * resolves relative `files` globs against its own detected app directory,
   * which in a nested project can be the parent workspace — the first attempt
   * produced an app.asar holding nothing but package.json.
   */
  const fileArgs = ['main.cjs', 'preload.cjs', 'src', 'web', 'README.md', 'package.json']
    .flatMap((entry) => ['--config.files', path.join(stagingRoot, entry)]);

  /*
   * The config is generated per build rather than kept as a static file.
   *
   * Two things made a static config impossible to get right:
   *   * `directories.app` and relative `files` globs are resolved against the
   *     config's own directory, and in a nested project that lands on a parent
   *     workspace — which silently produced an app.asar containing only
   *     package.json.
   *   * A `target: arch` list in the config *overrides* the command-line
   *     `--x64`/`--arm64` flags, so building for one platform produced both
   *     architectures (and a Windows installer twice the necessary size).
   * Both are now decided here and written into an absolute-path config.
   */
  const config = {
    appId: 'org.yoloannotator.desktop',
    // The product name shows in Start Menu / Applications and on the installer,
    // and must be distinguishable from the browser-based build ("… (browser)").
    productName: 'YOLO Annotator',
    copyright: 'YOLO Annotator',
    electronVersion: JSON.parse(
      await fs.readFile(path.join(projectRoot, 'node_modules', 'electron', 'package.json'), 'utf8'),
    ).version,
    npmRebuild: false,
    buildDependenciesFromSource: false,
    /*
     * Ship the app as plain files instead of packing it into app.asar.
     *
     * The @electron/asar installed here (3.4.1) writes file offsets that are
     * inflated by the header size, so every file read back out of an asar is
     * wrong. The symptom is severe and misleading: the packaged app cannot find
     * its own package.json entry point, so on Windows it never opens its window.
     * Verified by packing a two-file test app and reading both files back.
     *
     * Avoiding asar costs nothing here — the app is a few files — and makes the
     * installed bundle inspectable, which is a better trade than a corrupted
     * archive.
     */
    asar: false,
    directories: {
      output: outputRoot,
      buildResources: path.join(projectRoot, 'build-resources'),
      app: stagingRoot,
    },
    files: ['main.cjs', 'preload.cjs', 'src/**/*', 'web/**/*', 'README.md', 'package.json'],
  };

  if (options.mac) {
    config.mac = {
      icon: path.join(projectRoot, 'build-resources', 'icon.icns'),
      category: 'public.app-category.developer-tools',
      darkModeSupport: true,
      // Ad-hoc signing only: without a Developer ID certificate the app cannot
      // be notarised, so this is the strongest signature available.
      identity: null,
      target: [
        { target: 'dmg', arch: [options.macArch] },
        { target: 'zip', arch: [options.macArch] },
      ],
    };
    config.dmg = {
      title: 'YOLO Annotator',
      contents: [
        { x: 140, y: 200, type: 'file' },
        { x: 400, y: 200, type: 'link', path: '/Applications' },
      ],
    };
  }

  if (options.win) {
    config.win = {
      icon: path.join(projectRoot, 'build-resources', 'icon.png'),
      target: [
        { target: 'nsis', arch: [options.winArch] },
        { target: 'portable', arch: [options.winArch] },
      ],
    };
    config.nsis = {
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: 'YOLO Annotator',
    };
  }

  const configPath = path.join(stagingRoot, 'electron-builder.generated.json');
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  process.stdout.write(`Running electron-builder ${args.join(' ')}\n\n`);
  try {
    const { stdout } = await run(
      path.join(projectRoot, 'node_modules', '.bin', 'electron-builder'),
      [
        ...args,
        ...fileArgs,
        '--config',
        configPath,
      ],
      { cwd: stagingRoot, maxBuffer: 64 * 1024 * 1024 },
    );
    process.stdout.write(stdout);
  } catch (error) {
    process.stderr.write(`${error.stdout ?? ''}${error.stderr ?? ''}`);
    throw new Error('electron-builder failed');
  }

  process.stdout.write(`\nArtifacts in ${path.relative(process.cwd(), outputRoot)}\n`);
  return 0;
}

main().then(
  (code) => {
    if (code !== 0) process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`desktop build failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
