#!/usr/bin/env node
/**
 * spawn-isolation-gate.mjs — the static/parsing guard for the HOME-redirect
 * isolation invariant (`src/test/helpers/spawn-isolated-bin.ts`).
 *
 * WHY. A spec that spawns the REAL built `dist/index.js` as a child process
 * must never let that child read the machine's real `~/.adhd` (that is the
 * config-isolation leak the two canonical helpers fix: `spawn-isolated-bin.ts`
 * via a `HOME` redirect + `ADHD_BACKLOG_SCOPE=project`, and
 * `spawn-backlog-bin.ts` via `--namespace sandbox`). The invariant held only
 * because every site remembered to route through a helper; before the guard a
 * dropped redirect at any one site silently reopened the production store and
 * no test noticed.
 *
 * This gate is the DURABILITY half of that guard: a NEW spec/e2e file that
 * writes `spawn(process.execPath, [DIST_INDEX, …])` (or `spawnSync`) without
 * importing either helper has silently reintroduced the leak. It scans BOTH
 * suites — the resource-consuming suites were extracted out of the default
 * `test` target into sibling `*.e2e.ts` files, so a guard that only looked at
 * `*.spec.ts` would scan an empty set (teeth with no teeth).
 *
 * Sites that isolate by a DIFFERENT, deliberate mechanism use a different
 * spawn shape (fixtures, `workerData`, an explicit `HOME`) and are not matched:
 * the `--sandbox`/`ADHD_ROOT` probe in `cli.spec.ts`, the `mcp-stdio-entry.js`
 * fixture in `server.mcp.spec.ts`, and the worker-thread store specs that pass
 * a path as `workerData` rather than through `env`.
 *
 * This is a static/parsing guard, not a spawner: it reads files and regexes
 * them — it never spawns a child or loads a model, so it belongs in the
 * default `test` lane (wired into the `vocabulary-gate` Nx target's commands,
 * which `test.dependsOn` pulls into every `nx affected -t test`), not the
 * resource `e2e` lane.
 *
 * Run: node tools/gate/spawn-isolation-gate.mjs   (exit 0 clean, 1 dirty)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const PKG = new URL('../..', import.meta.url).pathname;
const ROOT = join(PKG, 'src');

/** A direct spawn of the real built bin that must be routed through a helper. */
const SPAWNS_DIST_INDEX =
  /(?:spawn|spawnSync)\s*\(\s*process\.execPath\s*,\s*\[\s*DIST_INDEX/;
/** Either canonical isolation helper, imported by any specifier shape. */
const IMPORTS_HELPER =
  /from\s+['"][^'"]*(?:spawn-isolated-bin|spawn-backlog-bin)(?:\.js)?['"]/;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.spec.ts') || entry.endsWith('.e2e.ts'))
      out.push(full);
  }
  return out;
}

const files = walk(ROOT);
const offenders = [];

for (const file of files) {
  const contents = readFileSync(file, 'utf8');
  if (SPAWNS_DIST_INDEX.test(contents) && !IMPORTS_HELPER.test(contents)) {
    offenders.push(relative(PKG, file));
  }
}

if (offenders.length === 0) {
  console.log(
    `spawn-isolation-gate: CLEAN — ${files.length} spec/e2e file(s) scanned; every \`spawn(process.execPath, [DIST_INDEX, …])\` site imports an isolation helper (spawn-isolated-bin or spawn-backlog-bin):\n`
  );
  process.exit(0);
}

console.log(
  `spawn-isolation-gate: DIRTY — ${offenders.length} spec/e2e file(s) spawn the real built bin by \`process.execPath [DIST_INDEX, …]\` without importing an isolation helper:\n`
);
for (const file of offenders) console.log(`  ${file}`);
console.log(
  `\n  fix: import buildIsolatedEnv/isolatedSpawnOptions/runIsolatedBin from src/test/helpers/spawn-isolated-bin.js (HOME redirect) or spawn-backlog-bin.js (--namespace sandbox), OR isolate by a different, deliberate mechanism (a fixture, workerData, an explicit HOME) whose spawn shape this gate does not match.\n`
);
process.exit(1);
