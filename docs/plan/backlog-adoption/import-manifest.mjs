#!/usr/bin/env node
// import-manifest.mjs — backlog-adoption MIGRATION.md Phase 1: idempotent
// import of every {sourcePath, filter} row in projection-manifest.json into
// the real global-scope store, via the REAL built `@adhd/backlog` CLI
// (`import-from-markdown`) — never an in-process import, same convention as
// parity-check.mjs and the rest of this migration.
//
// Idempotent: importFromMarkdown upserts by stable human id
// (createItemNode's idOverride existence check), so re-running this script
// against unchanged files must report created:0 for every row on the second
// pass. This script proves that itself when run with --prove-idempotent.
//
// Usage:
//   node docs/plan/backlog-adoption/import-manifest.mjs [--dry-run] [--only <sourcePath-substring>]
//   node docs/plan/backlog-adoption/import-manifest.mjs --prove-idempotent   (runs twice, asserts 2nd pass created==0 for every row)

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const CLI = join(REPO_ROOT, 'entrypoint/backlog/dist/index.js');
const MANIFEST = JSON.parse(readFileSync(join(HERE, 'projection-manifest.json'), 'utf8'));

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const proveIdempotent = args.includes('--prove-idempotent');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;

function runImport(entry) {
  const absPath = join(REPO_ROOT, entry.sourcePath);
  if (!existsSync(absPath)) {
    return { sourcePath: entry.sourcePath, skipped: true, reason: 'file-not-found' };
  }
  const input = {
    path: absPath,
    repo: MANIFEST.repo,
    sourcePath: entry.sourcePath,
    dryRun,
    ...('projectPath' in entry.filter ? { projectPath: entry.filter.projectPath } : {}),
    ...('plan' in entry.filter ? { plan: entry.filter.plan } : {}),
  };
  const out = execFileSync(
    'node',
    [CLI, 'import-from-markdown', '--input', JSON.stringify(input)],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  const lines = out.split('\n').filter((l) => l.trim());
  const result = JSON.parse(lines[lines.length - 1]);
  return { sourcePath: entry.sourcePath, ...result };
}

function runOnce(label) {
  console.log(`\n=== ${label} ===`);
  const rows = [];
  for (const entry of MANIFEST.entries) {
    if (only && !entry.sourcePath.includes(only)) continue;
    const r = runImport(entry);
    rows.push(r);
    if (r.skipped) {
      console.log(`[SKIP] ${r.sourcePath} (${r.reason})`);
    } else {
      const warn = r.malformedHeaders?.length ? ` MALFORMED=${r.malformedHeaders.length}` : '';
      const errs = r.errors?.length ? ` ERRORS=${r.errors.length}` : '';
      console.log(
        `[OK] ${r.sourcePath}  parsed=${r.parsed} created=${r.created} skippedDuplicates=${r.skippedDuplicates}${warn}${errs}`,
      );
    }
  }
  return rows;
}

if (proveIdempotent) {
  const first = runOnce('Pass 1 (seed)');
  const second = runOnce('Pass 2 (idempotency proof)');
  const nonZero = second.filter((r) => !r.skipped && r.created !== 0);
  console.log('\n=== Idempotency verdict ===');
  if (nonZero.length > 0) {
    console.error('FAIL — second pass created new nodes for:', nonZero.map((r) => r.sourcePath));
    process.exit(1);
  }
  console.log(`PASS — all ${second.filter((r) => !r.skipped).length} rows created:0 on re-run.`);
  console.log(
    `Pass-1 totals: parsed=${first.reduce((s, r) => s + (r.parsed ?? 0), 0)} created=${first.reduce((s, r) => s + (r.created ?? 0), 0)} skippedDuplicates=${first.reduce((s, r) => s + (r.skippedDuplicates ?? 0), 0)}`,
  );
} else {
  runOnce(dryRun ? 'Dry run' : 'Import');
}
