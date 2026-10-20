/**
 * Static file serving for the browser UI.
 *
 * The UI is plain HTML/CSS/JavaScript with no build step, so the server simply
 * maps a small allow-list of routes to files inside `web/`. There is no way for
 * a request to reach any other file, which keeps the surface tiny.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { mimeForPath } from '../shared/paths.ts';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
/** `<project>/web`, resolved relative to this module so CWD does not matter. */
export const webRoot = path.resolve(moduleDirectory, '..', '..', 'web');

export type StaticAsset = {
  body: Buffer;
  contentType: string;
  etag: string;
};

/** URL path -> file inside `web/`. */
const ROUTES = new Map<string, string>([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/app.css', 'app.css'],
  ['/app.js', 'app.js'],
  ['/favicon.svg', 'favicon.svg'],
]);

export function isStaticRoute(pathname: string): boolean {
  return ROUTES.has(pathname);
}

/** Reads a static asset, or returns `null` when the route is unknown. */
export async function readStaticAsset(pathname: string): Promise<StaticAsset | null> {
  const relative = ROUTES.get(pathname);
  if (relative === undefined) return null;

  const absolute = path.join(webRoot, relative);
  const body = await fs.readFile(absolute);
  return {
    body,
    contentType: `${mimeForPath(relative)}${relative.endsWith('.html') ? '; charset=utf-8' : ''}`,
    etag: `"${body.byteLength.toString(16)}"`,
  };
}

/** Lists the served routes; handy for diagnostics and tests. */
export function staticRoutes(): string[] {
  return [...ROUTES.keys()];
}
