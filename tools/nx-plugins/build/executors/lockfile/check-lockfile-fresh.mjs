#!/usr/bin/env node
/**
 * check-lockfile-fresh — gate: `pnpm-lock.yaml` must match every package.json
 * (backlog 4f26493e AC2).
 *
 * Runs the non-mutating `pnpm install --frozen-lockfile --lockfile-only`
 * (~0.4s; writes nothing). Exit 0 = fresh; exit 1 = stale (names the offending
 * package.json and each drifted specifier, lockfile vs package.json) or pnpm
 * could not run. Wired as `nx run @adhd/source:check-lockfile-fresh`, invoked by
 * `.githooks/pre-push` and both CI workflows BEFORE the lanes.
 *
 * Usage: node tools/nx-plugins/build/executors/lockfile/check-lockfile-fresh.mjs [--root <dir>]
 */
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { checkLockfile } = require('../../lib/lockfile-sync.js');

const here = dirname(fileURLToPath(import.meta.url));
const argRoot = process.argv.indexOf('--root');
const root = argRoot > -1 ? resolve(process.argv[argRoot + 1]) : join(here, '..', '..', '..', '..', '..');

const result = checkLockfile({ cwd: root });
if (result.ok) {
  console.error('check-lockfile-fresh: OK — pnpm-lock.yaml matches every package.json.');
  process.exit(0);
}
console.error(`check-lockfile-fresh: FAIL — ${result.message}`);
process.exit(1);
