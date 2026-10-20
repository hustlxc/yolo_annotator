/**
 * Command line interface.
 *
 * The original tool took exactly two arguments:
 *
 *     yolo_annotator <directory_path> <classes_file>
 *
 * That form still works, and everything else is optional.
 */

import path from 'node:path';
import { parseArgs } from 'node:util';

export const DEFAULT_PORT = 7860;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_LIMIT = 50_000;
export const MAX_PORT = 65535;
/** Kept in sync with package.json; single source for `--version` and the UI. */
export const APP_VERSION = '2.0.0';

export type CliOptions = {
  imagesDir: string;
  classesFile: string;
  port: number;
  host: string;
  /** Requested `port` may already be taken; scan upwards for a free one. */
  autoPort: boolean;
  /** Open the default browser once the server is listening. */
  open: boolean;
  /** Suppress the banner; used by desktop launchers that have no console. */
  quiet: boolean;
  /** Print only `URL=<address>` once listening, for launcher scripts to read. */
  printUrl: boolean;
  /** Start with no dataset; the desktop app supplies one via the picker. */
  noDataset: boolean;
  /** Maximum number of images to index. */
  limit: number;
  help: boolean;
  version: boolean;
};

export type ParsedCli = { ok: true; options: CliOptions } | { ok: false; error: string; showHelp: boolean };

const HELP = `yolo-annotator — draw YOLO bounding boxes in your browser

Usage
  yolo-annotator [<images-directory>] [<classes-file>] [options]
  node src/server/main.ts <images-directory> <classes-file> [options]

When the two path arguments are omitted, the annotator looks for \`images/\` and
\`obj.names\` next to the executable and then in the current directory. That is
what makes the packaged app double-clickable.

Options
  -p, --port <number>     Port to listen on              (default: ${DEFAULT_PORT})
      --host <address>    Address to bind                (default: ${DEFAULT_HOST})
      --no-auto-port      Fail instead of picking the next free port
      --no-open           Do not open a browser automatically
  -q, --quiet             Suppress the start-up banner (for desktop launchers)
      --print-url         Print only \`URL=<address>\` once listening, so a
                          launcher script can discover the port. Implies --quiet
      --no-dataset        Start without a dataset and wait for one to be chosen
                          (used by the desktop app, which supplies it via HTTP)
      --limit <number>    Maximum number of images to index (default: ${DEFAULT_LIMIT})
  -h, --help              Show this help and exit
  -V, --version           Show the version and exit

Arguments
  <images-directory>      Folder that holds the images. Sub-folders are scanned
                          recursively and shown as groups.
  <classes-file>          One class name per line (e.g. obj.names).
                          Blank lines and lines starting with '#' are ignored.

Keyboard shortcuts (inside the browser)
  n / p        next / previous image
  c / C        cycle to the next class
  1..9         jump directly to class N
  d            delete the last box
  Delete       delete the selected box
  Backspace    delete the selected box
  s            save now (changes are saved automatically anyway)
  h            toggle pan mode
  0            fit the image to the window
  Esc          leave pan mode, or save and quit (stops the server)
  ?            toggle the shortcut panel

Environment
  YOLO_ANNOTATOR_PORT     Same as --port
  YOLO_ANNOTATOR_HOST     Same as --host

Examples
  yolo-annotator                                  # use ./images and ./obj.names
  yolo-annotator ./photos ./obj.names
  yolo-annotator ./photos ./obj.names --port 8080 --no-open
`;

/** Reads a value from the environment, ignoring empty strings. */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

/** Returns a number, or an error string describing the problem. */
function parseInteger(value: string, source: string, min: number, max: number): number | string {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return `${source}: expected an integer between ${min} and ${max}, received "${value}"`;
  }
  return parsed;
}

/**
 * Parses argv (without the node/script prefix).
 * Returns a result object instead of throwing so `main` can print usage cleanly.
 */
export function parseCli(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): ParsedCli {
  const base: CliOptions = {
    imagesDir: '',
    classesFile: '',
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    autoPort: true,
    open: true,
    quiet: false,
    printUrl: false,
    noDataset: false,
    limit: DEFAULT_LIMIT,
    help: false,
    version: false,
  };

  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        port: { type: 'string', short: 'p' },
        host: { type: 'string' },
        // Node's `parseArgs` has no implicit `--no-*` handling, so the negated
        // switches are declared explicitly and resolved below.
        'auto-port': { type: 'boolean' },
        'no-auto-port': { type: 'boolean' },
        open: { type: 'boolean' },
        'no-open': { type: 'boolean' },
        quiet: { type: 'boolean', short: 'q' },
        'print-url': { type: 'boolean' },
        'no-dataset': { type: 'boolean' },
        limit: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'V' },
      },
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), showHelp: true };
  }

  const { values, positionals } = parsed;

  if (values.help === true) return { ok: true, options: { ...base, help: true } };
  if (values.version === true) return { ok: true, options: { ...base, version: true } };

  /*
   * Paths are optional so the packaged app can be double-clicked with no
   * arguments; `main` then discovers `images/` and `obj.names`. One path without
   * the other is still a mistake worth reporting.
   */
  if (positionals.length > 2) {
    return {
      ok: false,
      error: `expected at most 2 positional arguments, received ${positionals.length}`,
      showHelp: true,
    };
  }

  const imagesDir = positionals[0] === undefined ? '' : path.resolve(process.cwd(), positionals[0]);
  const classesFile = positionals[1] === undefined ? '' : path.resolve(process.cwd(), positionals[1]);

  const rawPort = values.port ?? envValue(env, 'YOLO_ANNOTATOR_PORT') ?? String(DEFAULT_PORT);
  const port = parseInteger(rawPort, 'port', 0, MAX_PORT);
  if (typeof port === 'string') return { ok: false, error: port, showHelp: false };

  const host = values.host ?? envValue(env, 'YOLO_ANNOTATOR_HOST') ?? DEFAULT_HOST;

  let limit = DEFAULT_LIMIT;
  if (values.limit !== undefined) {
    const parsedLimit = parseInteger(values.limit, 'limit', 1, Number.MAX_SAFE_INTEGER);
    if (typeof parsedLimit === 'string') return { ok: false, error: parsedLimit, showHelp: false };
    limit = parsedLimit;
  }

  return {
    ok: true,
    options: {
      ...base,
      imagesDir,
      classesFile,
      port,
      host,
      limit,
      // Both sides of each switch are accepted; naming the negated form is an
      // explicit request to turn the behaviour off.
      autoPort: values['no-auto-port'] !== true,
      open: values['no-open'] !== true,
      quiet: values.quiet === true,
      printUrl: values['print-url'] === true,
      noDataset: values['no-dataset'] === true,
    },
  };
}

export function helpText(): string {
  return HELP;
}
