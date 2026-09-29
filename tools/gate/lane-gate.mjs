#!/usr/bin/env node
/**
 * lane-gate — the SINGLE canonical source of the push/CI gate's affected targets.
 *
 * WHY THIS EXISTS. The gate's target list must be identical in every file that
 * runs it (`.githooks/pre-push` and BOTH CI workflows). It is not a local
 * detail of any one of them: if a file stops naming a target, that lane drops
 * out of the gate silently — the exact failure mode that motivated this module.
 *
 * The concrete incident: 2026-09-28 (backlog-e2e-cache-separation) `e2e` was
 * removed from `entrypoint/backlog`'s `test.dependsOn` so the resource-heavy
 * lane no longer ran uncached on every `nx affected -t test`. That decoupling is
 * correct, but it moved the burden of reaching `e2e` onto the gate files
 * themselves — and a gate file left naming only `test` would let a broken heavy
 * lane ship green (or, worse, get published). The list was then hard-coded
 * independently in three places.
 *
 * This module removes that duplication. Every gate file derives its targets
 * from here, and `tools/nx-plugins/test/executors/wiring/check-lane-reachability.mjs`
 * (invoked by the pre-push hook and both CI workflows) fails the build if any
 * gate file stops invoking every target listed in `GATE_TARGETS`.
 *
 * USAGE (shell — the pre-push hook):
 *   flags=$(node "$repo_root/tools/gate/lane-gate.mjs")   # -> "--target=test --target=e2e"
 *   npx nx affected $flags --base="$base" --head="$head"
 *
 * USAGE (JS):
 *   import { GATE_TARGETS, gateFlags, affectedArgv } from '.../tools/gate/lane-gate.mjs';
 *
 * Do NOT add a global `nx.json` `targetDefaults.e2e` as an alternative to this
 * mechanism: `targetDefaults` is keyed by target NAME only (no project filter),
 * so it cannot be scoped away from the @nx/cypress plugin's reserved `e2e`
 * target name (see PUBLISHING.md). Reachability is an explicit gate concern.
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** The targets the push/CI gate runs, in order. The one list. */
export const GATE_TARGETS = ['test', 'e2e'];

/** `['--target=test', '--target=e2e']` — for shell interpolation into `nx affected`. */
export function gateFlags() {
  return GATE_TARGETS.map((t) => `--target=${t}`);
}

/**
 * Compose an `nx affected` argv: `['affected', '--target=test', '--target=e2e',
 * '--base=…'?, '--head=…'?, ...extra]`. `base`/`head` are omitted when falsy
 * (a repo-default / new-branch push may have neither).
 */
export function affectedArgv({ base, head, extra = [] } = {}) {
  const argv = ['affected', ...gateFlags()];
  if (base) argv.push(`--base=${base}`);
  if (head) argv.push(`--head=${head}`);
  argv.push(...extra);
  return argv;
}

// CLI: print the gate flags space-separated, for shell consumption.
// Guarded so importing this module (e.g. from the checker or a test) never
// prints or exits.
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.stdout.write(gateFlags().join(' '));
}
