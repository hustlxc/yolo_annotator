#!/usr/bin/env node
/**
 * Thin launcher used by `bin` / `npm link` / `npx`.
 *
 * Node strips the TypeScript types in `src/server/main.ts` at load time, so no
 * compile step is required. This shim only forwards arguments and exit codes.
 */

import { spawn } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../src/server/main.ts', import.meta.url));

const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on('error', (error) => {
  process.stderr.write(`yolo-annotator: cannot start ${entry}: ${error.message}\n`);
  process.exit(1);
});
