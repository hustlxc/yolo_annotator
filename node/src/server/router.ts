/**
 * A tiny HTTP router.
 *
 * Node's built-in `http` module is enough for this application, but matching
 * URL patterns by hand gets noisy fast. This router supports the only feature
 * the API needs: `:name` path parameters, plus a 405 when a path exists but the
 * method does not.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

export type RouteParams = Record<string, string>;

export type RouteContext = {
  req: IncomingMessage;
  res: ServerResponse;
  params: RouteParams;
  /** Text captured by a trailing `*` in the route pattern. */
  wildcard: string;
  /** Parsed `?key=value` query string. */
  query: URLSearchParams;
  /** Request path without the query string. */
  pathname: string;
  /** Resolves when the request body has been read (bounded by `maxBodyBytes`). */
  readBody: () => Promise<string>;
  /** Same as `readBody`, already parsed as JSON. */
  readJson: () => Promise<unknown>;
  /** Absolute filesystem path the request was matched against. */
  url: URL;
};

/** Thrown by handlers to send a specific status code with a message. */
export class HttpError extends Error {
  readonly status: number;
  readonly details: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown): HttpError =>
  new HttpError(400, message, details);
export const notFound = (message: string): HttpError => new HttpError(404, message);
export const methodNotAllowed = (message: string): HttpError => new HttpError(405, message);
export const payloadTooLarge = (message: string): HttpError => new HttpError(413, message);
/** The request needs a dataset, but none has been opened yet. */
export const noDataset = (message: string): HttpError => new HttpError(503, message);

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD';
type Handler = (context: RouteContext) => Promise<void> | void;

type Route = {
  method: Method;
  segments: string[];
  handler: Handler;
};

/** Result of matching a route pattern against a request path. */
type MatchResult = { params: RouteParams; wildcard: string };

export type RouterOptions = {
  /** Maximum accepted request body, in bytes. */
  maxBodyBytes?: number;
};

const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

export class Router {
  readonly #routes: Route[] = [];
  readonly #maxBodyBytes: number;

  constructor(options: RouterOptions = {}) {
    this.#maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  }

  get(path: string, handler: Handler): this {
    return this.#add('GET', path, handler);
  }

  head(path: string, handler: Handler): this {
    return this.#add('HEAD', path, handler);
  }

  post(path: string, handler: Handler): this {
    return this.#add('POST', path, handler);
  }

  put(path: string, handler: Handler): this {
    return this.#add('PUT', path, handler);
  }

  delete(path: string, handler: Handler): this {
    return this.#add('DELETE', path, handler);
  }

  #add(method: Method, path: string, handler: Handler): this {
    if (!path.startsWith('/')) throw new Error(`route path must start with "/": ${path}`);
    this.#routes.push({ method, segments: splitPath(path), handler });
    return this;
  }

  /** Finds and runs the handler for a request. Throws `HttpError` on 404/405. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    const actual = splitPath(pathname);
    const method = (req.method ?? 'GET').toUpperCase();
    let pathMatched = false;

    for (const route of this.#routes) {
      const match = matchSegments(route.segments, actual);
      if (match === null) continue;
      pathMatched = true;
      if (route.method !== method) continue;

      const context: RouteContext = {
        req,
        res,
        params: match.params,
        wildcard: match.wildcard,
        query: url.searchParams,
        pathname,
        url,
        readBody: () => this.#readBody(req),
        readJson: async () => {
          const body = await this.#readBody(req);
          if (body.trim() === '') return {};
          try {
            return JSON.parse(body) as unknown;
          } catch (error) {
            throw badRequest(`invalid JSON body: ${error instanceof Error ? error.message : String(error)}`);
          }
        },
      };

      await route.handler(context);
      return;
    }

    if (pathMatched) throw methodNotAllowed(`${method} is not allowed on ${pathname}`);
    throw notFound(`no route for ${method} ${pathname}`);
  }

  #readBody(req: IncomingMessage): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const declared = Number(req.headers['content-length'] ?? Number.NaN);
      if (Number.isFinite(declared) && declared > this.#maxBodyBytes) {
        req.resume();
        reject(payloadTooLarge(`request body exceeds ${this.#maxBodyBytes} bytes`));
        return;
      }

      const chunks: Buffer[] = [];
      let size = 0;

      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > this.#maxBodyBytes) {
          reject(payloadTooLarge(`request body exceeds ${this.#maxBodyBytes} bytes`));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', (error) => reject(error));
    });
  }
}

function splitPath(value: string): string[] {
  return value.split('/').filter((segment) => segment !== '');
}

/**
 * Matches a route pattern against a request path.
 *
 * `:name` captures exactly one segment. A trailing `*` captures the remainder
 * (which may contain slashes) and is exposed as `context.wildcard`; it always
 * matches at least one character.
 */
function matchSegments(pattern: readonly string[], actual: readonly string[]): MatchResult | null {
  const params: RouteParams = {};
  const hasWildcard = pattern.length > 0 && pattern[pattern.length - 1] === '*';
  const fixedLength = hasWildcard ? pattern.length - 1 : pattern.length;

  if (hasWildcard) {
    if (actual.length <= fixedLength) return null;
  } else if (pattern.length !== actual.length) {
    return null;
  }

  for (let index = 0; index < fixedLength; index += 1) {
    const expected = pattern[index] as string;
    const received = actual[index] as string;
    if (expected.startsWith(':')) {
      if (received === '') return null;
      params[expected.slice(1)] = received;
      continue;
    }
    if (expected !== received) return null;
  }

  const wildcard = hasWildcard ? actual.slice(fixedLength).join('/') : '';
  return { params, wildcard };
}
