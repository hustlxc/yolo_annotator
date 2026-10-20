/**
 * `yolo-annotator` entry point.
 *
 * Starts a local HTTP server that serves the annotation UI and the JSON API,
 * optionally opens the default browser, and shuts itself down when the user
 * presses Escape inside the page (mirroring the original OpenCV program, whose
 * Escape key closed the window and ended the process).
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { APP_VERSION, DEFAULT_LIMIT, helpText, parseCli } from './args.ts';
import { startServer } from './server.ts';
import { DatasetHost } from './dataset.ts';
import { Workspace, describeError } from './workspace.ts';

const QUIT_GRACE_MS = 2_000;

/**
 * Finds the dataset to annotate when no paths were given.
 *
 * The packaged app is meant to be double-clicked, so it looks for an `images`
 * folder and an `obj.names` file next to the executable and then in the current
 * directory — in that order, because the launcher sets the working directory to
 * that same folder, and a `cd` elsewhere should still find the app's own data.
 */
export function discoverDefaults(executableDirectory: string): { imagesDir: string; classesFile: string } {
  const roots = [executableDirectory, process.cwd()];
  const seen = new Set<string>();
  let imagesDir = '';
  let classesFile = '';

  for (const root of roots) {
    if (seen.has(root)) continue;
    seen.add(root);

    if (imagesDir === '') {
      for (const candidate of ['images', 'Image', 'JPEGImages']) {
        const full = path.join(root, candidate);
        if (isDirectory(full)) {
          imagesDir = full;
          break;
        }
      }
    }
    if (classesFile === '') {
      for (const candidate of ['obj.names', 'classes.txt', 'classes.names', 'labels.txt']) {
        const full = path.join(root, candidate);
        if (isFile(full)) {
          classesFile = full;
          break;
        }
      }
    }
  }

  return { imagesDir, classesFile };
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/** Explains what to do when the auto-discovery came up empty. */
function missingInputsMessage(missing: string, executableDirectory: string): string {
  const localImages = path.join(process.cwd(), 'images');
  const localClasses = path.join(process.cwd(), 'obj.names');
  return [
    `could not find the ${missing}.`,
    '',
    'Pass the paths explicitly:',
    '  yolo-annotator <images-directory> <classes-file>',
    '',
    'Or place them for automatic discovery, in either of:',
    `  ${localImages}`,
    `  ${localClasses}`,
    `  ${path.join(executableDirectory, 'images')}`,
    `  ${path.join(executableDirectory, 'obj.names')}`,
    '',
    'Run with --help for all options.',
  ].join('\n');
}

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseCli(argv);

  if (!parsed.ok) {
    process.stderr.write(`yolo-annotator: ${parsed.error}\n\n`);
    if (parsed.showHelp) process.stderr.write(helpText());
    return 2;
  }

  const options = parsed.options;
  if (options.help) {
    process.stdout.write(helpText());
    return 0;
  }
  if (options.version) {
    process.stdout.write(`${APP_VERSION}\n`);
    return 0;
  }

  // The bundled runtime puts the executable at the root of the app folder.
  const executableDirectory = path.dirname(process.execPath);
  let imagesDir = options.imagesDir;
  let classesFile = options.classesFile;

  // --limit from the CLI, otherwise the default cap.
  const limit = options.limit ?? DEFAULT_LIMIT;
  // `--print-url` is meant to be the only output, so it silences the rest.
  const quiet = options.quiet || options.printUrl;

  /*
   * `--no-dataset` starts an empty server: the desktop app opens this way and
   * then supplies a folder and classes file through `/api/dataset`, after the
   * user has chosen them in a native dialog.
   */
  let dataset: DatasetHost;
  if (options.noDataset) {
    dataset = new DatasetHost();
  } else {
    if (imagesDir === '' || classesFile === '') {
      const discovered = discoverDefaults(executableDirectory);
      if (imagesDir === '') imagesDir = discovered.imagesDir;
      if (classesFile === '') classesFile = discovered.classesFile;

      if (imagesDir === '' || classesFile === '') {
        const missing = [
          imagesDir === '' ? 'images folder' : '',
          classesFile === '' ? 'classes file (obj.names)' : '',
        ]
          .filter((part) => part !== '')
          .join(' or the ');
        process.stderr.write(`yolo-annotator: ${missingInputsMessage(missing, executableDirectory)}\n`);
        return 1;
      }
    }

    let workspace: Workspace;
    try {
      workspace = await Workspace.open(imagesDir, classesFile, limit);
    } catch (error) {
      process.stderr.write(`yolo-annotator: ${describeError(error)}\n`);
      return 1;
    }

    const snapshot = await workspace.getSnapshot();
    if (snapshot.images.length === 0) {
      process.stderr.write(
        `yolo-annotator: no images found in ${imagesDir}\n` +
          'Supported extensions: .jpg .jpeg .png .bmp .webp .tif .tiff\n' +
          'Copy your images into that folder, list your classes in ' +
          `${classesFile}, then start the annotator again.\n`,
      );
      return 1;
    }
    dataset = new DatasetHost(workspace);
  }

  let resolveDone: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  let started;
  try {
    started = await startServer({
      workspace: dataset,
      host: options.host,
      port: options.port,
      autoPort: options.autoPort,
      // The banner would be the only output a desktop launcher ever produced,
      // and it has nowhere to show it.
      log: quiet ? () => {} : undefined,
      onShutdown: () => {
        // Give the HTTP response time to flush before the process exits.
        setTimeout(() => resolveDone?.(), 50);
      },
    });
  } catch (error) {
    process.stderr.write(`yolo-annotator: ${describeError(error)}\n`);
    return 1;
  }

  if (options.printUrl) {
    /*
     * Machine-readable handshake for desktop launchers. The port may have been
     * chosen by the OS, so the only way the launcher can find the UI is if the
     * server announces it. Printed with an explicit newline and flushed so a
     * `sed`/`grep` in the launcher sees it immediately.
     */
    process.stdout.write(`URL=${started.url}\n`);
  } else if (!options.quiet) {
    const info = dataset.info;
    printBanner(
      dataset.workspace,
      started.url,
      info?.imageCount ?? 0,
      info?.groupCount ?? 0,
    );
  }

  if (options.open) {
    void openBrowser(started.url).catch((error) => {
      process.stdout.write(`Could not open a browser automatically (${describeError(error)}).\n`);
    });
  }

  const finish = async (): Promise<void> => {
    try {
      await Promise.race([
        started.close(),
        new Promise((resolve) => setTimeout(resolve, QUIT_GRACE_MS)),
      ]);
    } catch {
      // The server is going away regardless; nothing useful to report.
    }
    if (!quiet) process.stdout.write('\nAll annotations saved. Goodbye.\n');
    process.exit(0);
  };

  process.on('SIGINT', () => void finish());
  process.on('SIGTERM', () => void finish());

  await done;
  await finish();
  return 0;
}

function printBanner(workspace: Workspace, url: string, imageCount: number, groupCount: number): void {
  const lines = [
    '',
    `  YOLO Annotator ${APP_VERSION}`,
    `  images   ${workspace.imagesRoot}  (${imageCount} image(s), ${groupCount} group(s))`,
    `  classes  ${workspace.classesFile}  (${workspace.classNames.length}: ${workspace.classNames.slice(0, 6).join(', ')}${workspace.classNames.length > 6 ? ', …' : ''})`,
    '',
    `  open     ${url}`,
    '',
    '  Keys: n/p navigate · c class · d delete · Ctrl+Z undo · Esc quit',
    '  Press Ctrl+C in this terminal to stop the server.',
    '',
  ];

  for (const warning of workspace.warnings.slice(0, 5)) {
    lines.push(`  warning: ${warning}`);
  }
  if (workspace.warnings.length > 5) {
    lines.push(`  … and ${workspace.warnings.length - 5} more warning(s)`);
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}

/**
 * Opens the URL in the default browser using the platform's own launcher.
 * Never uses a shell, so URLs with `&` or spaces cannot be reinterpreted.
 */
export function openBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const platform = process.platform;
    let command: string;
    let args: string[];

    if (platform === 'darwin') {
      command = 'open';
      args = [url];
    } else if (platform === 'win32') {
      // `start` is a cmd builtin; the empty string is the window title.
      command = 'cmd';
      args = ['/c', 'start', '', url];
    } else {
      command = 'xdg-open';
      args = [url];
    }

    const child = spawn(command, args, {
      stdio: 'ignore',
      detached: true,
      windowsVerbatimArguments: false,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/**
 * Detects whether this file is the process entry point.
 *
 * Without this guard, merely *importing* `main.ts` (which the packaging tests
 * do) would start the annotator as a side effect. Paths are compared after
 * resolution rather than by string equality, because `process.argv[1]` can carry
 * percent-encoding or a differently-spelled but equivalent path.
 */
/**
 * Detects whether this file is the process entry point.
 *
 * Without this guard, merely *importing* `main.ts` (which the packaging tests
 * do) would start the annotator as a side effect.
 *
 * Symlinks are resolved before comparing. This is not pedantry: macOS `.app`
 * bundles and `/tmp` (which is a symlink to `/private/tmp`) both make
 * `process.argv[1]` and `import.meta.url` differ by a symlink, and a plain
 * `path.resolve` comparison then reports "not the entry point". The app would
 * load, silently do nothing, and exit 0 — which is exactly how the packaged
 * macOS build failed the first time it was run.
 */
export function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined || entry === '') return true; // REPL or --eval: treat as entry

  const modulePath = fileURLToPath(import.meta.url);
  if (path.resolve(entry) === path.resolve(modulePath)) return true;

  // Fall back to resolving symlinks, tolerating a path that no longer exists.
  const real = (target: string): string => {
    try {
      return fs.realpathSync.native(target);
    } catch {
      try {
        return fs.realpathSync(target);
      } catch {
        return path.resolve(target);
      }
    }
  };
  return real(entry) === real(modulePath);
}

if (isEntryPoint()) {
  main(process.argv.slice(2))
    .then((code) => {
      if (code !== 0) process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`yolo-annotator: unexpected failure: ${describeError(error)}\n`);
      process.exitCode = 1;
    });
}
