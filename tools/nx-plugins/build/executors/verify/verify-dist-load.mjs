#!/usr/bin/env node
/**
 * scripts/verify-dist-load.mjs
 *
 * Backs the `verify-dist-load` target (tools/nx-plugins/verify-dist-load/
 * plugin.js). Loads a project's REAL BUILT ARTIFACT under dist/ the way an
 * actual consumer would — `require()` for a CJS entry, dynamic `import()`
 * for an ESM entry — and asserts it does not throw.
 *
 * WHY THIS EXISTS: `nx build`/`nx test` passing is NOT proof a published
 * package works. Verified independently in this repo (devops-engineer
 * dep-sync session, see BACKLOG): `apigen-plugin-api-express` builds clean
 * (`nx build` exit 0) and tests green (`nx test` — 25/25, exit 0), but
 * BOTH its built entries crash on load:
 *   - `require(dist/index.js)`  -> TypeError: Cannot read properties of
 *     undefined (reading 'map') — a Node builtin (`http`) got wrongly
 *     bundled as a `__vite-browser-external` stub.
 *   - `import(dist/index.mjs)`  -> same underlying error.
 * `nx test` never catches this because Vite/Vitest resolves `@adhd/*` (and
 * even Node builtins in dev/test mode) straight to source — the production
 * Rollup bundling path that actually breaks is never exercised by `test`.
 * This script closes exactly that gap: it is the one place in the repo
 * that actually `require()`/`import()`s a `dist/` artifact.
 *
 * Usage: node verify-dist-load.mjs <projectRoot-relative-to-workspace-root>
 * Exit 0  — every declared entry point loaded without throwing.
 * Exit 1  — at least one entry point threw on load (a real regression).
 * Exit 2  — usage/setup error (no built dist, no loadable entry declared).
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Locate the workspace root by walking up to nx.json — robust to where this
// script lives (it moved from scripts/ into tools/nx-plugins/build/executors/).
const findRoot = (d) => { while (d !== dirname(d)) { if (existsSync(join(d, 'nx.json'))) return d; d = dirname(d); } return d; };
const workspaceRoot = findRoot(__dirname);

function collectEntries(pkg) {
  // Ordered, deduped list of { kind, mode, file } to verify. `mode`
  // decides require() vs import() — matching how each field is actually
  // consumed by real Node/bundler consumers (Node itself never reads the
  // bundler-only `module` field, but this repo's packages advertise it as
  // a real ESM artifact, so we verify it loads regardless of who reads it).
  const seen = new Set();
  const entries = [];
  const add = (kind, mode, file) => {
    if (!file || typeof file !== 'string') return;
    const key = `${mode}:${file}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind, mode, file });
  };

  if (pkg.exports) {
    const rootExport =
      typeof pkg.exports === 'string' ? pkg.exports : pkg.exports['.'];
    if (typeof rootExport === 'string') {
      add('exports["."]', pkg.type === 'module' ? 'import' : 'require', rootExport);
    } else if (rootExport && typeof rootExport === 'object') {
      add('exports["."].require', 'require', rootExport.require);
      add('exports["."].import', 'import', rootExport.import);
      add('exports["."].default', pkg.type === 'module' ? 'import' : 'require', rootExport.default);
    }
  }
  add('main', pkg.type === 'module' ? 'import' : 'require', pkg.main);
  add('module', 'import', pkg.module);

  return entries;
}

async function verifyEntry(distDir, { kind, mode, file }) {
  const abs = resolvePath(distDir, file);
  if (!existsSync(abs)) {
    return { ok: false, kind, file: abs, error: new Error('file declared in package.json but missing from dist — build did not produce it') };
  }
  try {
    if (mode === 'import') {
      await import(pathToFileURL(abs).href);
    } else {
      const require = createRequire(import.meta.url);
      require(abs);
    }
    return { ok: true, kind, file: abs };
  } catch (error) {
    return { ok: false, kind, file: abs, error };
  }
}

async function main() {
  const projectRoot = process.argv[2];
  if (!projectRoot) {
    console.error('Usage: verify-dist-load.mjs <projectRoot>');
    process.exit(2);
  }

  const distDir = join(workspaceRoot, 'dist', projectRoot);
  const pkgJsonPath = join(distDir, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    console.error(
      `verify-dist-load: no built package.json at ${pkgJsonPath} — did 'build' run? (this target must dependsOn:["build"])`
    );
    process.exit(2);
  }

  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
  const entries = collectEntries(pkg);
  if (entries.length === 0) {
    console.error(
      `verify-dist-load: ${pkgJsonPath} declares no main/module/exports entry point to verify.`
    );
    process.exit(2);
  }

  let failures = 0;
  for (const entry of entries) {
    const result = await verifyEntry(distDir, entry);
    if (result.ok) {
      console.log(`✓ verify-dist-load: ${result.kind} (${result.file}) loaded cleanly`);
    } else {
      failures++;
      console.error(`✖ verify-dist-load: ${result.kind} (${result.file}) threw on load:`);
      console.error(`  ${result.error.stack || result.error.message}`);
    }
  }

  if (failures > 0) {
    console.error(
      `\nverify-dist-load: ${failures}/${entries.length} entry point(s) failed to load for ${projectRoot}.`
    );
    process.exit(1);
  }

  console.log(
    `\nverify-dist-load: all ${entries.length} entry point(s) loaded cleanly for ${projectRoot}.`
  );
}

main();
