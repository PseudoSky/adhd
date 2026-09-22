#!/usr/bin/env node
/**
 * Negative-control driver for the `browser-cjs-umd-repair` state.
 *
 * WHY THIS EXISTS. `packages/ui-react/ui-react-base-hooks` is `platform:browser`
 * and was deliberately NOT wired into the node CJS shim — its bundle never runs
 * under Node, where `require`/`__filename` exist. Under vite 8 that left both
 * `dist/index.js` (the package's `main` / `exports.require` entry) and
 * `dist/index.umd.js` carrying Rolldown's empty-import-meta token, so
 * `useFileDownload`'s worker path (`new URL('./worker.ts', …)`) throws
 * `TypeError: Invalid URL`. The guard for that state asserts the token's ABSENCE
 * from both browser bundles; this driver proves that assertion can go red.
 *
 * MECHANISM-AGNOSTIC BY DESIGN. The browser-appropriate fix is unresolved at
 * authoring time (the node shim is not a valid answer — its `require`/
 * `__filename` do not exist in a browser chunk, so wiring it in trades
 * `undefined` for `ReferenceError`). This control therefore perturbs only the
 * token the guard measures, not any particular repair strategy.
 *
 * WHAT IT TOUCHES. Only the gitignored build artifacts, never a tracked source
 * file. Each file is backed up beside itself before mutation and put back by
 * `restore`, which the audit harness runs in a `finally` block.
 *
 * USAGE
 *   node scripts/neg-control-browser-bundle.mjs mutate  <dist-file> [<dist-file> …]
 *   node scripts/neg-control-browser-bundle.mjs restore <dist-file> [<dist-file> …]
 *
 * EXIT CONTRACT. `mutate` exits non-zero and writes NOTHING when any target file
 * is absent, so a missing build can never masquerade as a proven control.
 */

import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

/** The exact token Rolldown emits for `import.meta.url` in a browser-platform CJS chunk. */
const EMPTY_IMPORT_META_URL = '{}.url';

/**
 * Appended as a live statement so the token is really present in the bundle, not
 * merely in a comment. The parentheses are load-bearing: a bare `{}.url` at
 * statement position parses as an empty block followed by `.url`, which is a
 * syntax error — the injection must stay a valid expression.
 */
const INJECTED_STATEMENT =
  `\n/* psm-negative-control */ globalThis.__psmEmptyImportMetaUrl = (${EMPTY_IMPORT_META_URL});\n`;

const [, , action, ...targets] = process.argv;

if (!action || targets.length === 0) {
  process.stderr.write(
    'usage: neg-control-browser-bundle.mjs <mutate|restore> <dist-file> [<dist-file> …]\n'
  );
  process.exit(2);
}

if (action === 'mutate') {
  const missing = targets.filter((t) => !existsSync(t));
  if (missing.length > 0) {
    process.stderr.write(
      `neg-control: build artifact(s) absent — ${missing.join(', ')}; build before running the control\n`
    );
    process.exit(1);
  }
  for (const dist of targets) {
    const original = readFileSync(dist, 'utf8');
    if (original.includes(EMPTY_IMPORT_META_URL)) {
      process.stderr.write(
        `neg-control: ${dist} ALREADY contains ${EMPTY_IMPORT_META_URL} — the guard is red before the control ran, so this control proves nothing\n`
      );
      process.exit(1);
    }
    copyFileSync(dist, `${dist}.psm-neg-bak`);
    writeFileSync(dist, original + INJECTED_STATEMENT);
    process.stdout.write(`neg-control: injected ${EMPTY_IMPORT_META_URL} into ${dist}\n`);
  }
  process.exit(0);
}

if (action === 'restore') {
  for (const dist of targets) {
    const backup = `${dist}.psm-neg-bak`;
    if (existsSync(backup)) {
      renameSync(backup, dist);
      process.stdout.write(`neg-control: restored ${dist}\n`);
    } else {
      process.stdout.write(`neg-control: nothing to restore for ${dist}\n`);
    }
  }
  process.exit(0);
}

process.stderr.write(`neg-control: unknown action "${action}"\n`);
process.exit(2);
