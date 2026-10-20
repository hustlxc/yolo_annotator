/**
 * The annotation workspace: everything that touches the filesystem.
 *
 * All user-supplied paths arrive as POSIX-style, workspace-relative strings
 * ("sub/dir/photo.jpg"). Every one of them is resolved against the images root
 * and re-validated with `path.relative`, which rejects both `..` traversal and
 * absolute-path injection on every platform.
 */

import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { imageSizeFromHeader } from '../shared/image-size.ts';
import {
  annotationPathForImage,
  assertUsableClassNames,
  discoverImages,
  fromWirePath,
  imageMimeForPath,
  isImageFile,
  parseClassNames,
  sidecarPathForImage,
  toWirePath,
  type ClassParseResult,
  type Group,
} from '../shared/paths.ts';
import { formatAnnotationText, parseAnnotationText, type AnnotationWarning, type YoloBox } from '../shared/yolo.ts';

/** How many header bytes are read when sniffing image dimensions. */
const HEADER_BYTES = 64 * 1024;

export type ImageEntry = {
  /** POSIX-style path relative to the images root. Stable client-side id. */
  id: string;
  /** File name including the extension. */
  fileName: string;
  /** POSIX-style folder relative to the images root; `''` for the root itself. */
  group: string;
  /** Human readable group label (`.`) for root-level images. */
  groupLabel: string;
  /** Absolute host path, for display only. */
  absolutePath: string;
  /** Image dimensions from the header, when they could be determined. */
  width: number | null;
  height: number | null;
  /** True when a label file exists for this image (even if it is empty). */
  hasAnnotation: boolean;
  /** Number of boxes in the label file, or 0. */
  boxCount: number;
};

export type WorkspaceSnapshot = {
  imagesRoot: string;
  classesFile: string;
  classNames: string[];
  groups: Group[];
  images: ImageEntry[];
  warnings: string[];
  limits: { maxImages: number };
};

export type AnnotationPayload = {
  imageId: string;
  absolutePath: string;
  width: number | null;
  height: number | null;
  boxes: YoloBox[];
  warnings: AnnotationWarning[];
  raw: string;
};

export type SaveResult = {
  imageId: string;
  bytesWritten: number;
  boxes: number;
  annotationPath: string;
  /** True when the image had a label file before this save. */
  updatedExisting: boolean;
  savedAt: string;
};

export type ImageResponse = {
  body: Buffer;
  contentType: string;
  size: number;
  /** Value for the `Last-Modified` header. */
  lastModified: Date;
  etag: string;
};

export class Workspace {
  readonly imagesRoot: string;
  readonly classesFile: string;
  readonly classNames: string[];
  readonly #classResult: ClassParseResult;
  readonly #limit: number;
  readonly #index = new Map<string, ImageEntry>();
  #groups: Group[] = [];
  #warnings: string[] = [];
  #snapshot: WorkspaceSnapshot | null = null;

  private constructor(
    imagesRoot: string,
    classesFile: string,
    classResult: ClassParseResult,
    limit: number,
  ) {
    this.imagesRoot = imagesRoot;
    this.classesFile = classesFile;
    this.#classResult = classResult;
    this.classNames = classResult.names;
    this.#limit = limit;
  }

  /**
   * Validates the two CLI paths and builds the initial index.
   * Throws with an actionable message when something is unusable.
   */
  static async open(imagesRoot: string, classesFile: string, limit = 50_000): Promise<Workspace> {
    const resolvedRoot = path.resolve(imagesRoot);
    const resolvedClasses = path.resolve(classesFile);

    const rootStat = await statOrNull(resolvedRoot);
    if (rootStat === null) throw new Error(`images directory does not exist: ${resolvedRoot}`);
    if (!rootStat.isDirectory()) throw new Error(`images path is not a directory: ${resolvedRoot}`);

    // Detect a classes file that is actually a directory early; the read below
    // would otherwise fail with a less helpful EISDIR message.
    const classesStat = await statOrNull(resolvedClasses);
    if (classesStat !== null && classesStat.isDirectory()) {
      throw new Error(`classes path is a directory, not a file: ${resolvedClasses}`);
    }

    let raw: string;
    try {
      raw = await fs.readFile(resolvedClasses, 'utf8');
    } catch (error) {
      throw new Error(`cannot read classes file ${resolvedClasses}: ${describeError(error)}`);
    }

    const classResult = parseClassNames(raw);
    assertUsableClassNames(classResult, resolvedClasses);

    const workspace = new Workspace(resolvedRoot, resolvedClasses, classResult, limit);
    await workspace.reindex();
    return workspace;
  }

  get warnings(): readonly string[] {
    return this.#warnings;
  }

  get duplicateClasses(): ClassParseResult['duplicates'] {
    return this.#classResult.duplicates;
  }

  /** Rescans the images directory and rebuilds the catalog. */
  async reindex(): Promise<WorkspaceSnapshot> {
    const discovered = discoverImages(this.imagesRoot, { limit: this.#limit });
    const warnings = [...discovered.warnings];

    for (const duplicate of this.#classResult.duplicates) {
      warnings.push(
        `class "${duplicate.name}" appears twice in ${this.classesFile} (lines ${duplicate.first + 1} and ${duplicate.repeated + 1}); the first is used`,
      );
    }

    const entries: ImageEntry[] = [];
    for (const absolutePath of discovered.files) {
      const relative = path.relative(this.imagesRoot, absolutePath);
      const id = toWirePath(relative);
      const group = id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '';
      const entry: ImageEntry = {
        id,
        fileName: path.basename(absolutePath),
        group,
        groupLabel: group === '' ? '.' : group,
        absolutePath,
        width: null,
        height: null,
        hasAnnotation: false,
        boxCount: 0,
      };
      entries.push(entry);
      this.#index.set(id, entry);
    }

    // Dimensions and label statistics are gathered concurrently; each failure is
    // recorded once instead of aborting the whole index.
    const concurrency = 12;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < entries.length) {
        const entry = entries[cursor];
        cursor += 1;
        if (entry === undefined) continue;
        await this.#enrich(entry, warnings);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));

    this.#groups = discovered.groups;
    this.#warnings = warnings;
    this.#snapshot = {
      imagesRoot: this.imagesRoot,
      classesFile: this.classesFile,
      classNames: this.classNames,
      groups: this.#groups,
      images: entries,
      warnings,
      limits: { maxImages: this.#limit },
    };
    return this.#snapshot;
  }

  async #enrich(entry: ImageEntry, warnings: string[]): Promise<void> {
    try {
      const handle = await fs.open(entry.absolutePath, 'r');
      try {
        const buffer = Buffer.alloc(HEADER_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0);
        const size = imageSizeFromHeader(buffer.subarray(0, bytesRead));
        if (size !== null) {
          entry.width = size.width;
          entry.height = size.height;
        }
      } finally {
        await handle.close();
      }
    } catch (error) {
      warnings.push(`cannot read ${entry.id}: ${describeError(error)}`);
    }

    const annotationPath = annotationPathForImage(entry.absolutePath);
    try {
      const text = await fs.readFile(annotationPath, 'utf8');
      entry.hasAnnotation = true;
      entry.boxCount = parseAnnotationText(text, this.classNames.length).boxes.length;
    } catch {
      // No label file yet: that is the normal case for a fresh dataset.
    }
  }

  /** The cached catalog, or a fresh scan when no snapshot exists yet. */
  async getSnapshot(): Promise<WorkspaceSnapshot> {
    return this.#snapshot ?? this.reindex();
  }

  /** Looks up an image by its wire id; throws when unknown or unsafe. */
  resolveImage(rawId: string): ImageEntry {
    const id = rawId.replace(/\\/g, '/').replace(/^\/+/, '');
    const entry = this.#index.get(id);
    if (entry === undefined) {
      throw new Error(`unknown image: ${rawId}`);
    }
    return entry;
  }

  /**
   * Resolves an image that may or may not be indexed yet, with traversal
   * protection. Used by the read-path so a stale client can still fetch a file.
   */
  resolveUnindexedImage(rawId: string): string {
    const id = rawId.replace(/\\/g, '/');
    if (id.includes('\0')) throw new Error('invalid image id');
    if (!isImageFile(id)) throw new Error(`unsupported image type: ${rawId}`);

    const absolute = path.resolve(this.imagesRoot, fromWirePath(id));
    const relative = path.relative(this.imagesRoot, absolute);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`image id escapes the images directory: ${rawId}`);
    }
    return absolute;
  }

  /** Reads a label file (or returns empty boxes when it does not exist). */
  async readAnnotation(imageId: string): Promise<AnnotationPayload> {
    const entry = this.resolveImage(imageId);
    const annotationPath = annotationPathForImage(entry.absolutePath);

    let raw = '';
    try {
      raw = await fs.readFile(annotationPath, 'utf8');
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    const parsed = parseAnnotationText(raw, this.classNames.length);
    return {
      imageId: entry.id,
      absolutePath: entry.absolutePath,
      width: entry.width,
      height: entry.height,
      boxes: parsed.boxes,
      warnings: parsed.warnings,
      raw,
    };
  }

  /**
   * Writes a label file atomically (temp file + rename) so an interrupted save
   * can never leave a half-written annotation behind.
   */
  async writeAnnotation(imageId: string, boxes: readonly YoloBox[], options: { backup?: boolean } = {}): Promise<SaveResult> {
    const entry = this.resolveImage(imageId);
    const annotationPath = annotationPathForImage(entry.absolutePath);
    const existing = await fs.readFile(annotationPath, 'utf8').catch(() => null);
    const contents = formatAnnotationText(boxes);

    if (options.backup === true && existing !== null && existing !== contents) {
      // Sidecar path: `cat.jpg` -> `cat.original.txt`, which the image
      // extension filter already ignores when indexing.
      await fs.writeFile(sidecarPathForImage(entry.absolutePath, '.original.txt'), existing, 'utf8');
    }

    const tempPath = `${annotationPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, contents, 'utf8');
    try {
      await fs.rename(tempPath, annotationPath);
    } catch (error) {
      await fs.rm(tempPath, { force: true });
      throw error;
    }

    entry.hasAnnotation = contents !== '';
    entry.boxCount = boxes.length;

    return {
      imageId: entry.id,
      bytesWritten: Buffer.byteLength(contents, 'utf8'),
      boxes: boxes.length,
      annotationPath,
      updatedExisting: existing !== null,
      savedAt: new Date().toISOString(),
    };
  }

  /** Streams an image to the client together with its serving metadata. */
  async readImage(rawId: string): Promise<ImageResponse> {
    let absolute: string;
    try {
      absolute = this.resolveImage(rawId).absolutePath;
    } catch {
      absolute = this.resolveUnindexedImage(rawId);
    }

    const stat = await fs.stat(absolute);
    if (!stat.isFile()) throw new Error(`not a file: ${absolute}`);

    return {
      body: await fs.readFile(absolute),
      contentType: imageMimeForPath(absolute),
      size: stat.size,
      lastModified: stat.mtime,
      etag: `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`,
    };
  }

  /** Group list plus per-group progress, used by the sidebar. */
  async summarize(): Promise<{
    groups: Array<Group & { annotated: number; boxes: number }>;
    totals: { images: number; annotated: number; boxes: number };
  }> {
    const snapshot = await this.getSnapshot();
    const byGroup = new Map<string, { annotated: number; boxes: number }>();

    let annotated = 0;
    let boxes = 0;
    for (const image of snapshot.images) {
      const bucket = byGroup.get(image.group) ?? { annotated: 0, boxes: 0 };
      if (image.hasAnnotation) {
        bucket.annotated += 1;
        annotated += 1;
      }
      bucket.boxes += image.boxCount;
      boxes += image.boxCount;
      byGroup.set(image.group, bucket);
    }

    return {
      groups: snapshot.groups.map((group) => ({
        ...group,
        annotated: byGroup.get(group.relativePath)?.annotated ?? 0,
        boxes: byGroup.get(group.relativePath)?.boxes ?? 0,
      })),
      totals: { images: snapshot.images.length, annotated, boxes },
    };
  }
}

async function statOrNull(target: string): Promise<Awaited<ReturnType<typeof fs.stat>> | null> {
  try {
    return await fs.stat(target);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ((error as NodeJS.ErrnoException).code === 'ENOENT' ||
      (error as NodeJS.ErrnoException).code === 'ENOTDIR')
  );
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === undefined ? error.message : `${error.message} [${code}]`;
  }
  return String(error);
}

/** Exported for tests: verifies a path stays inside the images root. */
export function isInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export const workspaceFsConstants = fsConstants;
