/**
 * Path, glob and class-name helpers.
 *
 * Every path that crosses the wire is POSIX-style and *relative to the images
 * root*. That keeps the HTTP API identical on Windows, macOS and Linux and
 * makes it impossible for a client to reach outside the annotated folder.
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';

/** Image extensions supported by the annotator (compared lower-cased). */
export const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.bmp', '.webp', '.tif', '.tiff'] as const;

type Extension = (typeof IMAGE_EXTENSIONS)[number];

/** Path separator used by the wire format, regardless of the host OS. */
export const WIRE_SEPARATOR = '/';

/**
 * Normalises an arbitrary path to the POSIX-style wire format.
 * Backslashes are normalised too, so a path produced on Windows keeps working
 * when the same dataset is opened on macOS or Linux.
 */
export function toWirePath(value: string): string {
  return value
    .split(path.sep)
    .join(WIRE_SEPARATOR)
    .replace(/\\/g, WIRE_SEPARATOR)
    .replace(/^\.\//, '');
}

/** Converts a POSIX-style wire path to a host path. */
export function fromWirePath(value: string): string {
  return value.split(WIRE_SEPARATOR).join(path.sep);
}

/** Groups are the directories (relative to the images root) that hold images. */
export type Group = { name: string; relativePath: string; imageCount: number };

export function isImageFile(fileName: string): boolean {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return false;
  return (IMAGE_EXTENSIONS as readonly string[]).includes(fileName.slice(dot).toLowerCase());
}

const MIME_TYPES: Record<string, string> = {
  // Images
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jpe': 'image/jpeg',
  '.png': 'image/png',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  // Browser assets served by the built-in static handler
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.map': 'application/json',
  '.txt': 'text/plain',
  '.ico': 'image/x-icon',
};

/** Content type for a path, falling back to `application/octet-stream`. */
export function mimeForPath(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  const extension = dot < 0 ? '' : filePath.slice(dot).toLowerCase();
  return MIME_TYPES[extension] ?? 'application/octet-stream';
}

/** Content type for an image path; always image-ish for known extensions. */
export const imageMimeForPath = mimeForPath;

/** Returns the on-disk annotation (`label`) path that belongs to an image. */
export function annotationPathForImage(imagePath: string): string {
  const parsed = path.parse(imagePath);
  return path.join(parsed.dir, `${parsed.name}.txt`);
}

/** Sibling path of an image, used for e.g. `<name>.original.txt`. */
export function sidecarPathForImage(imagePath: string, suffix: string): string {
  const parsed = path.parse(imagePath);
  return path.join(parsed.dir, `${parsed.name}${suffix}`);
}

export type DiscoveredImages = {
  /** Absolute image paths, recursively found and deterministically sorted. */
  files: string[];
  /** Directories (relative to the images root) that contain at least one image. */
  groups: Group[];
  /** Files/directories skipped because their permissions denied reading. */
  warnings: string[];
};

export type DiscoverOptions = {
  /** Group names the caller asked for; empty/undefined means "every group". */
  groups?: readonly string[];
  /** Keep scanning sub-directories. Defaults to true. */
  recursive?: boolean;
  /** Hard stop after this many images, to protect against enormous trees. */
  limit?: number;
};

const DEFAULT_LIMIT = 50_000;

/**
 * Finds images below `imagesRoot` and reports which groups hold them.
 *
 * Groups are `''` (images directly in the root) or the POSIX-style relative
 * directory path. A deterministic, case-insensitive, separator-insensitive
 * sort keeps byte-identical ordering across platforms; the raw code-unit sort
 * is used as the tie-breaker so the result is a total order.
 */
export function discoverImages(imagesRoot: string, options: DiscoverOptions = {}): DiscoveredImages {
  const { groups, recursive = true, limit = DEFAULT_LIMIT } = options;
  const warnings: string[] = [];
  const files: string[] = [];
  const groupCounts = new Map<string, number>();
  const wanted = groups && groups.length > 0 ? new Set(groups.map(normaliseGroupName)) : undefined;

  const scan = (absoluteDir: string, relativeDir: string): void => {
    let entries;
    try {
      entries = readdirSync(absoluteDir, { withFileTypes: true });
    } catch (error) {
      warnings.push(`cannot read ${relativeDir === '' ? '.' : relativeDir}: ${describeError(error)}`);
      return;
    }

    // Never let iteration order of the filesystem leak into our output.
    entries.sort((a, b) => compareStrings(a.name, b.name));

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // skip dotfiles and .DS_Store noise
      const childAbsolute = path.join(absoluteDir, entry.name);
      const childRelative = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;

      if (entry.isDirectory()) {
        if (!recursive) continue;
        if (wanted && !wanted.has(childRelative) && !hasWantedPrefix(childRelative, wanted)) continue;
        if (files.length >= limit) return;
        scan(childAbsolute, childRelative);
        continue;
      }

      // Symlinks to images are fine; broken ones are ignored silently.
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (!isImageFile(entry.name)) continue;

      const groupName = relativeDir;
      if (wanted && !wanted.has(groupName)) continue;

      files.push(childAbsolute);
      groupCounts.set(groupName, (groupCounts.get(groupName) ?? 0) + 1);
      if (files.length >= limit) {
        warnings.push(`stopped after ${limit} images; use --limit to raise the cap`);
        return;
      }
    }
  };

  scan(imagesRoot, '');

  files.sort(compareImagePaths);

  const discoveredGroups: Group[] = [...groupCounts.entries()]
    .map(([name, imageCount]) => ({
      name: name === '' ? '.' : name,
      relativePath: name,
      imageCount,
    }))
    .sort((a, b) => compareStrings(a.relativePath, b.relativePath));

  return { files, groups: discoveredGroups, warnings };
}

/** Case-insensitive, separator-insensitive comparison that stays total. */
function compareImagePaths(a: string, b: string): number {
  const left = a.toLowerCase().split(path.sep).join('/');
  const right = b.toLowerCase().split(path.sep).join('/');
  if (left !== right) return left < right ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function hasWantedPrefix(relativeDir: string, wanted: ReadonlySet<string>): boolean {
  for (const name of wanted) {
    if (name.startsWith(`${relativeDir}/`)) return true;
  }
  return false;
}

function normaliseGroupName(name: string): string {
  const trimmed = name.trim().replace(/^\.\/+/, '').replace(/\/+$/, '');
  return trimmed === '.' ? '' : trimmed;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type ClassParseResult = {
  names: string[];
  /** Duplicate index -> first index seen, for user-facing warnings. */
  duplicates: Array<{ name: string; first: number; repeated: number }>;
};

/**
 * Parses an `obj.names`-style class list: one name per line, `#` comments and
 * blank lines ignored, a UTF-8 BOM tolerated, duplicates reported once.
 */
export function parseClassNames(content: string): ClassParseResult {
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const names: string[] = [];
  const firstIndex = new Map<string, number>();
  const duplicates: Array<{ name: string; first: number; repeated: number }> = [];

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const existing = firstIndex.get(line);
    if (existing !== undefined) {
      duplicates.push({ name: line, first: existing, repeated: names.length });
      continue;
    }
    firstIndex.set(line, names.length);
    names.push(line);
  }

  return { names, duplicates };
}

/** Class names must never be empty, otherwise nothing can be labelled. */
export function assertUsableClassNames(result: ClassParseResult, source: string): string[] {
  if (result.names.length === 0) {
    throw new Error(`no class names found in ${source}`);
  }
  return result.names;
}
