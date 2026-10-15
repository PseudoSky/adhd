#!/usr/bin/env node
/**
 * spawn-isolation-gate.mjs — the backlog package's default-lane caller of the
 * repo-wide spawn-isolation guard (backlog 0945d1b9, D2).
 *
 * The scan, its rules and its baseline live in
 * `tools/nx-plugins/test/executors/wiring/check-spawn-isolation.mjs`, which also
 * runs repo-wide as rule 9 of check-lane-reachability.mjs. This file only scopes
 * that scan to `entrypoint/backlog` so the `vocabulary-gate` Nx target keeps its
 * backlog-local failure output. A `spawn(process.execPath, …)` / `fork(module)` call in
 * a backlog spec or e2e file fails the gate unless that call itself uses
 * `spawn-isolated-bin` / `spawn-backlog-bin` or sets an explicit `HOME`; a file-level
 * import or a `HOME` key elsewhere in the file routes nothing. Sites that predate the
 * guard are ratcheted per file in the shared `spawn-isolation.baseline.json`.
 *
 * Run: node tools/gate/spawn-isolation-gate.mjs   (exit 0 clean, 1 dirty)
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectSpawnIsolationViolations } from '../../../../tools/nx-plugins/test/executors/wiring/check-spawn-isolation.mjs';

const PKG = fileURLToPath(new URL('../..', import.meta.url));
const WORKSPACE_ROOT = resolve(PKG, '../..');
const BACKLOG_ROOT = 'entrypoint/backlog';

const { violations, scanned } = collectSpawnIsolationViolations(WORKSPACE_ROOT, {
  roots: [BACKLOG_ROOT],
});

if (violations.length === 0) {
  console.log(
    `spawn-isolation-gate: CLEAN — ${scanned} backlog spec/e2e file(s) scanned; every node spawn site is routed (isolation helper or explicit HOME in the call) or within its baseline count.`,
  );
  process.exit(0);
}

console.log(`spawn-isolation-gate: DIRTY — ${violations.length} violation(s):\n`);
for (const v of violations) console.log(`  [${v.rule}] ${v.detail}`);
console.log(
  '\n  fix: import buildIsolatedEnv/isolatedSpawnOptions/runIsolatedBin from src/test/helpers/spawn-isolated-bin.js (HOME redirect) or spawn-backlog-bin.js (--namespace sandbox), OR set an explicit HOME in the child env of that spawn call.\n',
);
process.exit(1);
