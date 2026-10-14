#!/usr/bin/env node
/**
 * pre-push-flags — the targets the LOCAL pre-push hook runs.
 *
 * pre-push runs the canonical gate (`tools/gate/lane-gate.mjs`) MINUS the lanes in
 * `PRE_PUSH_EXCLUDED`. `e2e` is excluded locally (too heavy per push); CI
 * (`pull-request.yml`, `ci.yml`) consumes `lane-gate.mjs` directly and still runs
 * every lane. `check-lane-reachability.mjs` rule 5 enforces this contract.
 *
 * Shell: `flags=$(node "$repo_root/.githooks/lib/pre-push-flags.mjs")` -> "--target=test"
 */
import { fileURLToPath } from 'node:url';
import { realpathSync as realpathForEntry } from 'node:fs';
import { resolve } from 'node:path';
import { GATE_TARGETS } from '../../tools/gate/lane-gate.mjs';

/** Gate lanes the local pre-push hook deliberately does not run. */
export const PRE_PUSH_EXCLUDED = ['e2e'];

/** GATE_TARGETS minus PRE_PUSH_EXCLUDED, in gate order. */
export function prePushTargets() {
  return GATE_TARGETS.filter((t) => !PRE_PUSH_EXCLUDED.includes(t));
}

/** `['--target=test']` — for shell interpolation into `nx affected`. */
export function prePushFlags() {
  return prePushTargets().map((t) => `--target=${t}`);
}

const invokedDirectly =
  (() => { try { return realpathForEntry(process.argv[1]) === realpathForEntry(fileURLToPath(import.meta.url)); } catch { return process.argv[1] === fileURLToPath(import.meta.url); } })();
if (invokedDirectly) {
  process.stdout.write(prePushFlags().join(' '));
}
