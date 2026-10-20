/**
 * Holds the dataset the annotator is currently working on.
 *
 * The command-line tool opens one dataset and keeps it for the process lifetime.
 * The desktop app is different: the user can point it at a different images
 * folder at any time, so "the workspace" has to be swappable rather than fixed
 * when the server starts.
 *
 * Swapping is deliberately not concurrent with anything else: a swap builds a
 * completely new Workspace (which is what indexes the folder) and only then
 * becomes visible to request handlers. A request that arrives during a swap
 * therefore sees either the old dataset or the new one, never a half-built one.
 */

import { Workspace } from './workspace.ts';

export type DatasetInfo = {
  imagesDir: string;
  classesFile: string;
  classNames: string[];
  imageCount: number;
  annotatedCount: number;
  groupCount: number;
  openedAt: string;
};

export type DatasetRequest = {
  imagesDir: string;
  classesFile: string;
  /** Safety cap passed through to the index. */
  limit?: number;
};

/** Thrown when a request needs a dataset but none has been chosen yet. */
export class NoDatasetError extends Error {
  constructor() {
    super('no dataset is open yet');
    this.name = 'NoDatasetError';
  }
}

/**
 * Accepts either a ready workspace or a host, so callers that never swap
 * datasets (the CLI, the tests) can keep passing what they have.
 */
export function asDatasetHost(value: Workspace | DatasetHost): DatasetHost {
  return value instanceof DatasetHost ? value : new DatasetHost(value);
}

export class DatasetHost {
  #workspace: Workspace | null;
  #info: DatasetInfo | null = null;
  #swapping: Promise<DatasetInfo> | null = null;

  constructor(workspace: Workspace | null = null) {
    this.#workspace = workspace;
    if (workspace !== null) {
      // `startServer` is async, so the snapshot is filled in by `describe`.
      void this.describe().then((info) => {
        this.#info = info;
      });
    }
  }

  /** True when a dataset has been opened and some images were found. */
  get isOpen(): boolean {
    return this.#workspace !== null;
  }

  /**
   * The current workspace.
   * Throws `NoDatasetError` rather than returning null so callers cannot forget
   * to handle the "nothing open" case.
   */
  get workspace(): Workspace {
    if (this.#workspace === null) throw new NoDatasetError();
    return this.#workspace;
  }

  get info(): DatasetInfo | null {
    return this.#info;
  }

  async describe(): Promise<DatasetInfo> {
    const workspace = this.workspace;
    const snapshot = await workspace.getSnapshot();
    const annotatedCount = snapshot.images.filter((image) => image.hasAnnotation).length;
    const info: DatasetInfo = {
      imagesDir: workspace.imagesRoot,
      classesFile: workspace.classesFile,
      classNames: snapshot.classNames,
      imageCount: snapshot.images.length,
      annotatedCount,
      groupCount: snapshot.groups.length,
      openedAt: new Date().toISOString(),
    };
    this.#info = info;
    return info;
  }

  /**
   * Opens a different dataset. Returns the new description.
   *
   * Concurrent calls are collapsed onto one swap; the desktop app cannot easily
   * prevent a double-click on "Open", and building two indexes at once would be
   * both slow and confusing.
   */
  async open(request: DatasetRequest): Promise<DatasetInfo> {
    if (this.#swapping !== null) return this.#swapping;

    this.#swapping = (async () => {
      const workspace = await Workspace.open(
        request.imagesDir,
        request.classesFile,
        request.limit ?? 50_000,
      );
      const snapshot = await workspace.getSnapshot();
      if (snapshot.images.length === 0) {
        throw new Error(`no images found in ${workspace.imagesRoot}`);
      }
      // Only now does the swap become visible to request handlers.
      this.#workspace = workspace;
      return this.describe();
    })();

    try {
      return await this.#swapping;
    } finally {
      this.#swapping = null;
    }
  }

  /** Re-reads the current dataset's folder, e.g. after images were added. */
  async reindex(): Promise<DatasetInfo> {
    await this.workspace.reindex();
    return this.describe();
  }
}
