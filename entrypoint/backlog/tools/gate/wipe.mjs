#!/usr/bin/env node
/**
 * wipe.mjs — the checker `deletion-manifest.txt`'s header promises.
 *
 * The manifest is the single reviewable source of truth for the hard cutover.
 * `wipe-paths.txt` is a DERIVED artifact (the argument to
 * `git rm --pathspec-from-file`); it is regenerated here rather than
 * hand-maintained, because a manifest and a path list that drift apart is
 * exactly how a PRESERVE file gets deleted anyway — the manifest review passes
 * while the stale path list is what `git rm` actually reads.
 *
 * Modes:
 *   --check  verify the manifest is internally consistent and matches disk.
 *            Exits non-zero with a work list on any violation. Mutates nothing.
 *   --emit   run --check, then rewrite wipe-paths.txt from the manifest.
 *
 * This NEVER removes a file. Deletion is `git rm --pathspec-from-file`, run
 * deliberately by an operator, so the removal is staged and reviewable.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { globSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(GATE, '..', '..');
const MANIFEST = join(GATE, 'deletion-manifest.txt');
const PATHS = join(GATE, 'wipe-paths.txt');

const mode = process.argv.includes('--emit') ? 'emit' : 'check';
const lines = readFileSync(MANIFEST, 'utf8').split('\n');

const preserve = new Set();
const doomed = new Set();
// Tracked separately: a DELETE_GLOB sweeping up a PRESERVE path is EXPECTED and
// resolved in PRESERVE's favour (the manifest header's whole point -- src/store/
// is not deleted wholesale). An explicit `DELETE <path>` naming a PRESERVE path
// is a genuine contradiction: two lines stating opposite intent for one file.
const explicitlyDoomed = new Set();
for (const raw of lines) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  if (line.startsWith('PRESERVE ')) preserve.add(`src/${line.slice(9).trim()}`);
  else if (line.startsWith('DELETE_GLOB ')) {
    for (const hit of globSync(`src/${line.slice(12).trim()}`, { cwd: PKG })) doomed.add(hit.split('\\').join('/'));
  } else if (line.startsWith('DELETE ')) {
    const p = `src/${line.slice(7).trim()}`;
    doomed.add(p);
    explicitlyDoomed.add(p);
  }
}

const errors = [];

// 1. An explicit DELETE naming a PRESERVE path is contradictory intent.
for (const p of preserve) {
  if (explicitlyDoomed.has(p)) {
    errors.push(`CONTRADICTION: ${p} is named by both a PRESERVE and an explicit DELETE line`);
  }
}
// PRESERVE wins over a DELETE_GLOB that swept it up — that is the glob's whole point.
for (const p of preserve) doomed.delete(p);

// 2. Every PRESERVE path must still exist. A stale PRESERVE means the file was
//    already deleted and the manifest's protection is silently doing nothing.
for (const p of [...preserve].sort()) {
  if (!existsSync(join(PKG, p))) errors.push(`MISSING PRESERVE: ${p} does not exist on disk`);
}
// 3. Every DELETE path must still exist, or the manifest is stale.
for (const p of [...doomed].sort()) {
  if (!existsSync(join(PKG, p))) errors.push(`MISSING DELETE: ${p} does not exist on disk`);
}

// 4. THE LOAD-BEARING CHECK: no surviving file may import a doomed one.
//    This is the check whose absence let graph-backlog-store.ts (the store
//    factory api.ts opens through) sit in the DELETE set with seven survivor
//    importers. An import edge from a survivor into the doomed set means the
//    wipe produces a tree that cannot compile.
const allTs = globSync('src/**/*.ts', { cwd: PKG }).map((p) => p.split('\\').join('/'));
const survivors = allTs.filter((p) => !doomed.has(p));
const IMPORT = /from\s+'(\.[^']+)'/g;
const dangling = [];
for (const s of survivors) {
  const text = readFileSync(join(PKG, s), 'utf8');
  for (const m of text.matchAll(IMPORT)) {
    const target = resolve(dirname(join(PKG, s)), m[1]).replace(/\.js$/, '.ts');
    const rel = target.slice(PKG.length + 1).split('\\').join('/');
    if (doomed.has(rel)) dangling.push(`${s}  ->  ${rel}`);
  }
}
if (dangling.length) {
  errors.push(
    `DANGLING IMPORTS (${dangling.length}): a survivor imports a doomed module. ` +
      `The wipe would leave a tree that cannot compile:\n` +
      dangling.map((d) => `      ${d}`).join('\n')
  );
}

console.log(`manifest: ${preserve.size} PRESERVE, ${doomed.size} DELETE, ${survivors.length} survivors`);

if (errors.length) {
  console.error(`\n✗ wipe --check FAILED (${errors.length} violation${errors.length === 1 ? '' : 's'}):\n`);
  for (const e of errors) console.error(`  • ${e}`);
  console.error('\nResolve every violation above before running the wipe.');
  process.exit(1);
}

console.log('✓ wipe --check clean: no intersection, no stale path, no dangling import.');

if (mode === 'emit') {
  const sorted = [...doomed].sort();
  writeFileSync(PATHS, sorted.join('\n') + '\n');
  console.log(`✓ regenerated wipe-paths.txt (${sorted.length} paths) from the manifest.`);
}
