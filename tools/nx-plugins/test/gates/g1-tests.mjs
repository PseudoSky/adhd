#!/usr/bin/env node
/**
 * G1 — the required tests pass (595965cc T30). One command for every stage that runs G1:
 *   - default (stages C, D): the affected set, `nx affected` over the gate targets of
 *     `tools/gate/lane-gate.mjs` (the single list), against GATE_BASE (default origin/main);
 *   - GATE_FULL=1 (stages E, G): every project, so an affected-selection escape cannot hide
 *     (STRATEGY §7.1 stage E).
 * Exit status is nx's. No `--skip-nx-cache`: a cache hit counts for G1 (STRATEGY §7.2).
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { realpathSync as realpathForEntry } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { GATE_TARGETS } from '../../../gate/lane-gate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');

export function g1Argv(env = process.env) {
  const targets = GATE_TARGETS.map((t) => `--target=${t}`);
  if (env.GATE_FULL === '1') return ['nx', 'run-many', ...targets];
  return ['nx', 'affected', ...targets, `--base=${env.GATE_BASE || 'origin/main'}`];
}

if ((() => { try { return realpathForEntry(process.argv[1]) === realpathForEntry(fileURLToPath(import.meta.url)); } catch { return process.argv[1] === fileURLToPath(import.meta.url); } })()) {
  const r = spawnSync('npx', g1Argv(), { cwd: root, stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
