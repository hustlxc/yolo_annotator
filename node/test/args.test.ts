import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { DEFAULT_HOST, DEFAULT_PORT, parseCli } from '../src/server/args.ts';

/** Parses argv the way the original C++ tool accepted its two arguments. */
function parse(...argv: string[]) {
  const result = parseCli(argv, {});
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  return result.ok ? result.options : null;
}

function parseError(...argv: string[]) {
  const result = parseCli(argv, {});
  assert.equal(result.ok, false);
  return result.ok ? '' : result.error;
}

test('the two positional arguments are resolved against the working directory', () => {
  const options = parse('images', 'obj.names');
  assert.equal(options?.imagesDir, path.resolve('images'));
  assert.equal(options?.classesFile, path.resolve('obj.names'));
  assert.equal(options?.port, DEFAULT_PORT);
  assert.equal(options?.host, DEFAULT_HOST);
  assert.equal(options?.open, true);
  assert.equal(options?.autoPort, true);
});

test('--port/-p and --host are honoured', () => {
  assert.equal(parse('a', 'b', '--port', '8080')?.port, 8080);
  assert.equal(parse('a', 'b', '-p', '9000')?.port, 9000);
  assert.equal(parse('a', 'b', '--host', '0.0.0.0')?.host, '0.0.0.0');
});

test('--no-open and --no-auto-port are accepted (Node has no implicit negation)', () => {
  const options = parse('a', 'b', '--no-open', '--no-auto-port');
  assert.equal(options?.open, false);
  assert.equal(options?.autoPort, false);

  assert.equal(parse('a', 'b')?.open, true, 'opening stays the default');
  assert.equal(parse('a', 'b', '--open')?.open, true);
});

test('--limit is read from the flag and defaults otherwise', () => {
  assert.equal(parse('a', 'b')?.limit, 50_000);
  assert.equal(parse('a', 'b', '--limit', '25')?.limit, 25);
  assert.match(parseError('a', 'b', '--limit', '0'), /limit/);
});

test('invalid ports and unknown options produce errors, not exceptions', () => {
  assert.match(parseError('a', 'b', '--port', 'abc'), /port/);
  assert.match(parseError('a', 'b', '--port', '70000'), /port/);
  assert.match(parseError('a', 'b', '--port', '-1'), /port/);
  assert.match(parseError('a', 'b', '--nope'), /Unknown option/);
});

test('paths may be omitted so the packaged app can be double-clicked', () => {
  // Zero arguments is now valid: `main` discovers images/ and obj.names.
  const none = parse();
  assert.equal(none?.imagesDir, '');
  assert.equal(none?.classesFile, '');

  // One argument is also accepted, so discovery can supply the other.
  const one = parse('images');
  assert.equal(one?.imagesDir, path.resolve('images'));
  assert.equal(one?.classesFile, '');
});

test('too many positionals are still reported', () => {
  assert.match(parseError('a', 'b', 'c'), /expected at most 2 positional arguments/);
});

test('--help and --version short-circuit before positional validation', () => {
  const help = parseCli(['--help'], {});
  assert.equal(help.ok && help.options.help, true);
  const version = parseCli(['-V'], {});
  assert.equal(version.ok && version.options.version, true);
});

test('environment variables fill in port and host', () => {
  const result = parseCli(['a', 'b'], { YOLO_ANNOTATOR_PORT: '4123', YOLO_ANNOTATOR_HOST: '0.0.0.0' });
  assert.equal(result.ok && result.options.port, 4123);
  assert.equal(result.ok && result.options.host, '0.0.0.0');

  // An explicit flag wins over the environment.
  const overridden = parseCli(['a', 'b', '--port', '5000'], { YOLO_ANNOTATOR_PORT: '4123' });
  assert.equal(overridden.ok && overridden.options.port, 5000);

  // Blank values are ignored rather than parsed as 0.
  const blank = parseCli(['a', 'b'], { YOLO_ANNOTATOR_PORT: '   ' });
  assert.equal(blank.ok && blank.options.port, DEFAULT_PORT);
});

test('port 0 is allowed so the OS can pick a free port', () => {
  assert.equal(parse('a', 'b', '--port', '0')?.port, 0);
});

test('--quiet and --print-url are accepted and default to off', () => {
  assert.equal(parse('a', 'b')?.quiet, false);
  assert.equal(parse('a', 'b')?.printUrl, false);
  assert.equal(parse('a', 'b', '--quiet')?.quiet, true);
  assert.equal(parse('a', 'b', '-q')?.quiet, true);
  assert.equal(parse('a', 'b', '--print-url')?.printUrl, true);
});
