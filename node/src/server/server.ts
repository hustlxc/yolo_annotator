/**
 * HTTP server: static UI, small JSON API, graceful shutdown.
 *
 * Node's `http` module only, so the whole program installs in seconds and runs
 * identically on Windows, macOS and Linux.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { APP_VERSION, MAX_PORT } from './args.ts';
import { HttpError, Router, badRequest, methodNotAllowed, noDataset, notFound } from './router.ts';
import { isStaticRoute, readStaticAsset } from './static.ts';
import { DatasetHost, NoDatasetError, asDatasetHost, type DatasetInfo } from './dataset.ts';
import { Workspace, describeError } from './workspace.ts';
import { validateBoxes } from '../shared/yolo.ts';

export type ServerOptions = {
  /**
   * The dataset to open at startup. Accepts a host (the desktop app, which
   * swaps datasets) or a ready workspace (the command-line tool, and tests).
   */
  workspace: DatasetHost | Workspace
  host: string;
  port: number;
  /** Pick the next free port when the requested one is taken. */
  autoPort?: boolean;
  /** Called after a `/api/shutdown` request was accepted. */
  onShutdown?: () => void;
  /** Log sink; defaults to stdout. A no-op sink silences the launcher banner. */
  log?: (message: string) => void;
};

export type StartedServer = {
  server: http.Server;
  url: string;
  origin: string;
  host: string;
  port: number;
  shutdownToken: string;
  close: () => Promise<void>;
};

/** Placeholder in `index.html` that receives the per-run bootstrap object. */
const BOOT_MARKER = '__YOLO_BOOTSTRAP__';
/** Route the browser POSTs to when the user presses Escape. */
export const SHUTDOWN_HEADER = 'x-shutdown-token';
/** Request header carrying the base64 revision a client last read. */
export const REVISION_HEADER = 'x-label-revision';

/**
 * Encodes label-file text as an HTTP-safe revision token.
 * Base64 is reversible, so the server can compare bytes exactly.
 */
export function encodeRevision(raw: string): string {
  return Buffer.from(raw, 'utf8').toString('base64');
}

export async function startServer(options: ServerOptions): Promise<StartedServer> {
  const log = options.log ?? ((message: string) => process.stdout.write(`${message}\n`));
  const dataset = asDatasetHost(options.workspace);
  const shutdownToken = randomBytes(24).toString('hex');
  const bootstrap = {
    shutdownToken,
    version: APP_VERSION,
    // Zero when started with `--no-dataset`; the page then shows the picker.
    classCount: dataset.isOpen ? dataset.workspace.classNames.length : 0,
  };

  const router = buildRouter(dataset, {
    shutdownToken,
    onShutdown: options.onShutdown,
    log,
  });

  const server = http.createServer((req, res) => {
    void handleRequest(router, req, res, log, bootstrap);
  });

  // Keep-alive matters for image-heavy pages, but sockets should not linger.
  server.keepAliveTimeout = 10_000;
  server.headersTimeout = 20_000;

  const bound = await listen(server, options.host, options.port, options.autoPort !== false);  const address = server.address() as AddressInfo | null;
  const actualPort = address?.port ?? bound.port;
  const displayHost = bound.host === '0.0.0.0' || bound.host === '::' ? '127.0.0.1' : bound.host;
  const origin = `http://${formatHostForUrl(displayHost)}:${actualPort}`;

  return {
    server,
    url: `${origin}/`,
    origin,
    host: bound.host,
    port: actualPort,
    shutdownToken,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined || error === null ? resolve() : reject(error)));
        // `close()` alone waits for idle keep-alive sockets; force them shut.
        server.closeAllConnections();
      }),
  };
}

type RouterDeps = {
  shutdownToken: string;
  onShutdown?: (() => void) | undefined;
  log: (message: string) => void;
};

function buildRouter(dataset: DatasetHost, deps: RouterDeps): Router {
  const router = new Router({ maxBodyBytes: 4 * 1024 * 1024 });

  /** The full catalog: classes, groups and every indexed image. */
  /**
   * Dataset control. The desktop app uses these; the web UI reads
   * `/api/dataset` to decide whether to show the picker.
   */
  router.get('/api/dataset', async (context) => {
    sendJson(context.res, 200, dataset.info);
  });

  router.post('/api/dataset', async (context) => {
    const body = await readJsonObject(context.req, context.readBody);
    const imagesDir = body['imagesDir'];
    const classesFile = body['classesFile'];
    if (typeof imagesDir !== 'string' || imagesDir === '') {
      throw badRequest('"imagesDir" must be a non-empty string');
    }
    if (typeof classesFile !== 'string' || classesFile === '') {
      throw badRequest('"classesFile" must be a non-empty string');
    }
    const limit = body['limit'];
    if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0)) {
      throw badRequest('"limit" must be a positive integer when given');
    }

    try {
      const info = await dataset.open({
        imagesDir,
        classesFile,
        ...(typeof limit === 'number' ? { limit } : {}),
      });
      sendJson(context.res, 200, { ok: true, dataset: info });
    } catch (error) {
      // A bad folder is the user's input problem, not a server fault.
      throw badRequest(describeError(error));
    }
  });

  router.post('/api/dataset/reindex', async (context) => {
    try {
      sendJson(context.res, 200, { ok: true, dataset: await dataset.reindex() });
    } catch (error) {
      throw new HttpError(500, describeError(error));
    }
  });

  router.get('/api/images', async (context) => {
    const snapshot = await dataset.workspace.getSnapshot();
    const group = context.query.get('group');
    const images =
      group === null || group === ''
        ? snapshot.images
        : snapshot.images.filter((image) => image.group === group);

    sendJson(context.res, 200, {
      imagesRoot: snapshot.imagesRoot,
      classesFile: snapshot.classesFile,
      classNames: snapshot.classNames,
      groups: snapshot.groups,
      warnings: snapshot.warnings,
      limits: snapshot.limits,
      images,
    });
  });

  /**
   * Raw image bytes. The wildcard keeps nested groups working, e.g.
   * `/api/image/train/cats/a.jpg`.
   */
  router.get('/api/image/*', async (context) => {
    await serveImage(dataset.workspace, context.req, context.res, context.wildcard);
  });

  router.head('/api/image/*', async (context) => {
    await serveImage(dataset.workspace, context.req, context.res, context.wildcard);
  });

  router.get('/api/annotations/*', async (context) => {
    const id = context.wildcard;
    try {
      sendJson(context.res, 200, await dataset.workspace.readAnnotation(id));
    } catch (error) {
      throw notFound(`cannot read annotations for "${id}": ${describeError(error)}`);
    }
  });

  router.put('/api/annotations/*', async (context) => {
    const id = context.wildcard;
    const body = await readJsonObject(context.req, context.readBody);

    let boxes;
    try {
      boxes = validateBoxes(body['boxes'], dataset.workspace.classNames.length);
    } catch (error) {
      // Validation failures are the client's fault, not ours.
      throw badRequest(error instanceof Error ? error.message : String(error));
    }

    /*
     * Optimistic locking. A client that loaded the label file sends a revision
     * token (base64 of the exact file contents) in `X-Label-Revision`. If the
     * file no longer matches, somebody else wrote it in the meantime — another
     * tab, a sync client, or a colleague on a shared folder — and blindly
     * overwriting would silently destroy their work. The client is told what is
     * on disk and asked which version wins.
     *
     * Base64 rather than a raw `If-Match`: HTTP header values cannot contain
     * newlines and have trailing whitespace stripped, so a label file's exact
     * bytes (they always end in "\n") cannot survive as a header value.
     */
    const expectedRevision = headerValue(context.req.headers[REVISION_HEADER]);
    if (expectedRevision !== undefined) {
      let current: { raw: string } | null = null;
      try {
        current = await dataset.workspace.readAnnotation(id);
      } catch {
        current = null; // unreadable/unknown id: let the write path report it
      }
      if (current !== null && encodeRevision(current.raw) !== expectedRevision) {
        throw new HttpError(409, 'the label file changed on disk since it was loaded', {
          current: current.raw,
          revision: encodeRevision(current.raw),
        });
      }
    }

    try {
      // `backup: true` keeps the previous label file as `<name>.original.txt`
      // before overwriting it.
      const backup = body['backup'] === true;
      const result = await dataset.workspace.writeAnnotation(id, boxes, { backup });
      sendJson(context.res, 200, { ok: true, result, image: dataset.workspace.resolveImage(id) });
    } catch (error) {
      throw badRequest(`cannot save annotations for "${id}": ${describeError(error)}`);
    }
  });

  router.get('/api/summary', async (context) => {
    sendJson(context.res, 200, await dataset.workspace.summarize());
  });

  router.post('/api/reindex', async (context) => {
    const snapshot = await dataset.workspace.reindex();
    const summary = await dataset.workspace.summarize();
    sendJson(context.res, 200, {
      images: snapshot.images.length,
      groups: snapshot.groups.length,
      warnings: snapshot.warnings,
      totals: summary.totals,
    });
  });

  router.post('/api/shutdown', async (context) => {
    assertShutdownToken(context.req, deps.shutdownToken);
    sendJson(context.res, 200, { ok: true, message: 'shutting down' });
    deps.log('Shutdown requested from the browser.');
    deps.onShutdown?.();
  });

  return router;
}

/** Streams an image with ETag/Last-Modified handling for GET and HEAD. */
async function serveImage(
  workspace: Workspace,
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
): Promise<void> {
  let image;
  try {
    image = await workspace.readImage(id);
  } catch (error) {
    throw notFound(`cannot read image "${id}": ${describeError(error)}`);
  }

  if (req.headers['if-none-match'] === image.etag) {
    res.writeHead(304, { ETag: image.etag, 'Cache-Control': 'no-cache' });
    res.end();
    return;
  }

  res.writeHead(200, {
    'Content-Type': image.contentType,
    'Content-Length': String(image.size),
    'Last-Modified': image.lastModified.toUTCString(),
    ETag: image.etag,
    'Cache-Control': 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : image.body);
}

/** Normalises a possibly-repeated request header to a single string. */
function headerValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

/** Constant-time comparison of the shutdown token header. */
function assertShutdownToken(req: IncomingMessage, expected: string): void {
  const provided = req.headers[SHUTDOWN_HEADER];
  const value = Array.isArray(provided) ? provided[0] : provided;
  if (typeof value !== 'string') throw new HttpError(403, 'missing shutdown token');

  const left = Buffer.from(value);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new HttpError(403, 'invalid shutdown token');
  }
}

async function readJsonObject(
  req: IncomingMessage,
  readBody: () => Promise<string>,
): Promise<Record<string, unknown>> {
  void req;
  const text = await readBody();
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw badRequest(`invalid JSON body: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw badRequest('request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

type Bootstrap = { shutdownToken: string; version: string; classCount: number };

async function handleRequest(
  router: Router,
  req: IncomingMessage,
  res: ServerResponse,
  log: (message: string) => void,
  bootstrap: Bootstrap,
): Promise<void> {
  try {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);

    if (isStaticRoute(pathname)) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        throw methodNotAllowed(`${req.method} is not allowed on ${pathname}`);
      }
      const asset = await readStaticAsset(pathname);
      if (asset === null) throw notFound(`no asset for ${pathname}`);

      const isDocument = pathname === '/' || pathname.endsWith('.html');
      const body = isDocument ? injectBootstrap(asset.body, bootstrap) : asset.body;

      res.writeHead(200, {
        'Content-Type': asset.contentType,
        'Content-Length': String(body.byteLength),
        'Cache-Control': 'no-store',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }

    await router.handle(req, res);
  } catch (error) {
    sendError(res, error, log);
  }
}

/** Replaces the bootstrap placeholder so the page learns the shutdown token. */
function injectBootstrap(html: Buffer, bootstrap: Bootstrap): Buffer {
  const text = html.toString('utf8');
  if (!text.includes(BOOT_MARKER)) return html;
  return Buffer.from(text.replace(BOOT_MARKER, JSON.stringify(bootstrap)), 'utf8');
}

function formatHostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.byteLength),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res: ServerResponse, error: unknown, log: (message: string) => void): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }

  if (error instanceof NoDatasetError) {
    // Not a server fault: the caller simply has to choose a folder first.
    sendJson(res, 503, {
      error: 'no dataset is open yet — choose an images folder and a classes file',
    });
    return;
  }

  if (error instanceof HttpError) {
    if (error.status >= 500) log(`[error] ${error.message}`);
    sendJson(res, error.status, {
      error: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    });
    return;
  }

  const message = describeError(error);
  log(`[error] ${message}`);
  sendJson(res, 500, { error: message });
}

/** Binds the server, optionally walking upwards until a free port is found. */
function listen(
  server: http.Server,
  host: string,
  port: number,
  autoPort: boolean,
): Promise<{ host: string; port: number }> {
  return new Promise((resolve, reject) => {
    let candidate = port;
    let attempts = 0;

    const onError = (error: NodeJS.ErrnoException): void => {
      if (error.code === 'EADDRINUSE' && autoPort && attempts < 50 && candidate < MAX_PORT) {
        attempts += 1;
        candidate += 1;
        server.once('error', onError);
        server.listen(candidate, host);
        return;
      }
      reject(
        error.code === 'EADDRINUSE'
          ? new Error(`port ${candidate} is already in use (try --port)`)
          : error,
      );
    };

    server.once('error', onError);
    server.once('listening', () => {
      server.removeListener('error', onError);
      resolve({ host, port: candidate });
    });
    server.listen(port, host);
  });
}
