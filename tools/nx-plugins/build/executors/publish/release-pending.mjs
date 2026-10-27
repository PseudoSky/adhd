#!/usr/bin/env node
// pnpm release:pending [--json] — exact list of projects needing publish; fs + git only (no nx, build, tests).
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { computePending } = require('../../lib/release-pending.js');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const t0 = process.hrtime.bigint();
const pending = computePending({ workspaceRoot: root });
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify({ count: pending.length, elapsedMs: Math.round(ms), projects: pending }, null, 2)}\n`);
} else {
  for (const p of pending) console.log(`${p.name}@${p.version}\t${p.reasons.join(',')}`);
  console.error(`release:pending — ${pending.length} project(s) need publish (${(ms / 1000).toFixed(2)}s)`);
}
