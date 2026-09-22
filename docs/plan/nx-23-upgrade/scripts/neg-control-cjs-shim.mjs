#!/usr/bin/env node
/**
 * Negative-control driver for the `vite-cjs-import-meta-repair` state.
 *
 * WHY THIS EXISTS. The defect this state closes (`BUG-BUILD-002`) hid behind a
 * guard that only compared version strings: `package.json` declared `vite ^8.3.0`,
 * the guard read `^8.3.0`, the gate went green — and every shipped CommonJS
 * entrypoint died at module load because Rolldown had lowered `import.meta.url`
 * to the empty object `{}`. A guard is only worth its green if a red is reachable,
 * so this driver perturbs *exactly* the primitive the guard measures: the CJS
 * `import.meta.url` shim inside the built artifact.
 *
 * WHAT IT TOUCHES. Only the gitignored build artifact (`entrypoint/<pkg>/dist/
 * index.js`), never a tracked source file. The artifact is backed up beside
 * itself before mutation and put back by `restore`, which the audit harness runs
 * in a `finally` block — so a failing audit still restores.
 *
 * USAGE
 *   node scripts/neg-control-cjs-shim.mjs mutate  <dist-file>
 *   node scripts/neg-control-cjs-shim.mjs restore <dist-file>
 *
 * EXIT CONTRACT. `mutate` exits non-zero and writes NOTHING when the artifact is
 * absent or carries no shim site. That matters: the audit harness ignores the
 * mutate step's exit code, so a silent no-op mutation would make the positive
 * check fail for the wrong reason and the control would "pass" having proven
 * nothing. Failing loudly here is the only way the control stays honest — the
 * criterion that uses it therefore runs AFTER a criterion that builds the
 * artifact.
 */

import {
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';

/** Rollup's CJS `import.meta.url` shim — what the repo's sources were written against. */
const SHIM_RE = /require\((['"])node:url\1\)\.pathToFileURL\(__filename\)\.href/g;

/** The exact token Rolldown emits for `import.meta.url` in a browser-platform CJS chunk. */
const EMPTY_IMPORT_META_URL = '{}.url';

const [, , action, dist] = process.argv;

if (!action || !dist) {
  process.stderr.write('usage: neg-control-cjs-shim.mjs <mutate|restore> <dist-file>\n');
  process.exit(2);
}

const backup = `${dist}.psm-neg-bak`;

if (action === 'mutate') {
  if (!existsSync(dist)) {
    process.stderr.write(
      `neg-control: ${dist} does not exist — build the artifact before running the control\n`
    );
    process.exit(1);
  }
  const original = readFileSync(dist, 'utf8');
  const sites = (original.match(SHIM_RE) || []).length;
  const mutated = original.replace(SHIM_RE, EMPTY_IMPORT_META_URL);
  if (mutated === original) {
    process.stderr.write(
      `neg-control: no CJS import.meta.url shim site in ${dist} — the control cannot perturb its own primitive\n`
    );
    process.exit(1);
  }
  copyFileSync(dist, backup);
  writeFileSync(dist, mutated);
  process.stdout.write(
    `neg-control: mutated ${dist} (${sites} shim site(s) -> ${EMPTY_IMPORT_META_URL})\n`
  );
  process.exit(0);
}

if (action === 'restore') {
  if (existsSync(backup)) {
    renameSync(backup, dist);
    process.stdout.write(`neg-control: restored ${dist}\n`);
  } else {
    process.stdout.write(`neg-control: nothing to restore for ${dist}\n`);
  }
  process.exit(0);
}

process.stderr.write(`neg-control: unknown action "${action}"\n`);
process.exit(2);
