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

async function verifyEntry(distDir, { kind, mode, file }, existenceOnly) {
  const abs = resolvePath(distDir, file);
  if (!existsSync(abs)) {
    return { ok: false, kind, file: abs, error: new Error('file declared in package.json but missing from dist — build did not produce it') };
  }
  if (existenceOnly) {
    // CLI/server entry: present in dist, but must not be executed here (see main()).
    return { ok: true, kind, file: abs, existenceOnly: true };
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

  // BUG-007 FIX: publish-from-DIST model — the workspace ships each package
  // from its BUILT `{projectRoot}/dist` directory, whose `package.json` is a
  // separately RESOLVED, REBASED manifest (`dist-manifest` / `generate-
  // manifest.js`'s `writeDistManifest`: entry paths rewritten dist-root-
  // relative, internal `@adhd/*` ranges resolved to concrete versions). A
  // real consumer's `node_modules/<pkg>` IS that dist directory — they never
  // see the SOURCE root's package.json at all. The gate existed to prove the
  // SHIPPED artifact loads; reading the source manifest here (as this used
  // to) resolves main/module/exports/bin against the WRONG root and the
  // WRONG (unrebased) paths — it happened to often still find the right file
  // only because the source manifest's paths are literally `./dist/...` and
  // get joined against the source root, coincidentally landing on the same
  // absolute file the correctly-rebased dist manifest would resolve from
  // its OWN root. That coincidence silently stops working the moment the
  // DIST manifest disagrees with the source manifest (a bad rebase, a wrong
  // `exports`/`bin` entry stamped by `dist-manifest`) — exactly the class of
  // defect this gate is supposed to catch. Fixed: read `{dist}/package.json`
  // and resolve every entry relative to `dist`, matching exactly what an
  // installed consumer's `require`/`import` resolution sees.
  const pkgRoot = join(workspaceRoot, projectRoot);
  const builtDir = join(pkgRoot, 'dist');
  if (!existsSync(builtDir)) {
    console.error(
      `verify-dist-load: no built output at ${builtDir} — did 'build' run? (this target must dependsOn:["build"])`
    );
    process.exit(2);
  }
  const pkgJsonPath = join(builtDir, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    console.error(
      `verify-dist-load: no ${pkgJsonPath} — the dist directory exists but has no rebased manifest. Did ` +
      `'dist-manifest' (generate-manifest.js's writeDistManifest) run? (this target must dependsOn a step ` +
      `that materializes dist/package.json — a missing dist manifest is a real publish defect, never a ` +
      `silent skip.)`
    );
    process.exit(2);
  }

  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
  const hasBin =
    pkg.bin != null && (typeof pkg.bin === 'string' || Object.keys(pkg.bin).length > 0);
  const libEntries = collectEntries(pkg);
  const binFiles = !hasBin ? [] : typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin);
  const entries = [...libEntries, ...binFiles.map((file) => ({ kind: 'bin', mode: 'exists', file }))];
  if (entries.length === 0) {
    console.error(
      `verify-dist-load: ${pkgJsonPath} declares no main/module/exports/bin entry point to verify.`
    );
    process.exit(2);
  }

  // A CLI/server entry executes on load (commander `.parse()`, a server
  // bootstrap), so it can't be require()'d here — running it against verify's
  // own argv is meaningless and can hang a long-lived server. For any package
  // that ships a `bin`, verify every declared entry EXISTS in the built dist
  // (a missing entry = a broken publish); its load-time behaviour is proven by
  // the package's own default-running e2e/demo tests (repo live-testing rule).
  // Pure LIBRARIES (no bin) are fully load-verified — that is where silent
  // bundling breakage (e.g. a Node builtin stubbed to `undefined`) hides.
  const existenceOnly = hasBin;

  let failures = 0;
  for (const entry of entries) {
    // Entries come from the DIST manifest and are already dist-root-relative
    // (e.g. "./index.js", not the source manifest's "./dist/index.js") — so
    // they resolve against `builtDir`, exactly as a real consumer's
    // `node_modules/<pkg>` resolution would (dist IS the package root once
    // published).
    const result = await verifyEntry(builtDir, entry, existenceOnly || entry.mode === 'exists');
    if (result.ok) {
      console.log(
        `✓ verify-dist-load: ${result.kind} (${result.file}) ${result.existenceOnly ? 'present (CLI/server entry — not executed)' : 'loaded cleanly'}`
      );
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
