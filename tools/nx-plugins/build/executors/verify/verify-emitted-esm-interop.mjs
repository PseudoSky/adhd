#!/usr/bin/env node
/**
 * verify-emitted-esm-interop.mjs
 *
 * Backs `environment-cli`'s explicit `verify-dist-load` target (see
 * entrypoint/environment-cli/project.json). It is the coverage equivalent of
 * the shared `@adhd/nx-build:verify` executor
 * (tools/nx-plugins/build/executors/verify/verify-dist-load.mjs) for a package
 * the shared mechanism deliberately does NOT cover:
 *
 *   - environment-cli is `"private": true`, so the build plugin's
 *     `isPublishable` gate (tools/nx-plugins/build/plugin.js:18 ->
 *     tools/nx-plugins/build/detect-target.js:55-73) never attaches the
 *     publish-oriented `verify-dist-load` target to it at all; and
 *   - its build is a raw `tsc` (`module: esnext`) that emits ESM directly and
 *     declares no dist `main`/`module`/`exports`/`bin` entry, so even a
 *     hand-attached shared executor would exit 2 with "declares no
 *     main/module/exports/bin entry point to verify".
 *
 * WHAT IT CATCHES. `tsc` emits a NAMED import (or re-export) from a bare
 * package specifier verbatim into the built ESM. When that package's ROOT entry
 * is CommonJS-only (no `import` condition in `exports`, and cjs-module-lexer
 * cannot derive the names — e.g. `yaml@1.10.3`), Node's ESM linker throws
 * `SyntaxError: Named export '<name>' not found` the moment the emitted file is
 * imported. That is the 788c57a5 / b8db4e3c class: `nx build` and `nx test`
 * both pass (vitest resolves straight to SOURCE), and nothing in the repo ever
 * loads the emitted artifact until a consumer does.
 *
 * HOW IT WORKS (link-only; the project's own module bodies never execute). For
 * each emitted `.js`/`.mjs` under `dist/` it extracts the STATIC BARE-specifier
 * import/re-export statements, writes a probe module beside the emitted file
 * containing exactly those statements (so Node resolves them from the identical
 * `node_modules` chain the real file would use), and `import()`s the probe. The
 * probe links the same dependency graph; anything failing to LINK fails here.
 *
 * RELATIVE specifiers are deliberately EXCLUDED: an extensionless relative
 * import (`export * from './api'`) is a separate, tracked loadability defect
 * (backlog 7ef20999) and would otherwise mask the interop class this gate
 * exists for.
 *
 * A candidate is CONFIRMED BY A REAL `import()`, never inferred by classifying
 * a package.json — so a package whose named exports cjs-module-lexer DOES
 * detect (e.g. `express`) is correctly not flagged.
 *
 * Usage: node verify-emitted-esm-interop.mjs <projectRoot-relative-to-root>
 * Exit 0 — every emitted ESM bare-specifier import/re-export linked cleanly.
 * Exit 1 — at least one failed to link (a real defect in the emitted ESM).
 * Exit 2 — usage/setup error (no built dist, or no emitted ESM modules).
 */

import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Locate the workspace root by walking up to nx.json — mirrors
// verify-dist-load.mjs's own root discovery, robust to this script's location.
const findRoot = (d) => {
  while (d !== dirname(d)) {
    if (existsSync(join(d, 'nx.json'))) return d;
    d = dirname(d);
  }
  return d;
};
const workspaceRoot = findRoot(__dirname);

// `tsc` prints each import/export declaration on ONE line, so a per-line match
// is exact for its output and cannot swallow code across a template literal.
const FROM_RE = /^[ \t]*((?:import|export)\b[^\n]*?\bfrom[ \t]*['"]([^'"]+)['"])/gm;
const SIDE_EFFECT_RE = /^[ \t]*(import[ \t]*['"]([^'"]+)['"])/gm;

/** A bare package specifier — not relative, not absolute, not a `node:`/`data:` URL. */
function isBare(spec) {
  return !spec.startsWith('.') && !spec.startsWith('/') && !spec.includes(':');
}

function walkModules(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkModules(full, out);
    else if (/\.(mjs|js)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Static bare-specifier import/re-export statements in one emitted module. */
function extractBareStatements(source) {
  const statements = new Set();
  for (const m of source.matchAll(FROM_RE)) if (isBare(m[2])) statements.add(m[1].trim());
  for (const m of source.matchAll(SIDE_EFFECT_RE)) if (isBare(m[2])) statements.add(m[1].trim());
  return [...statements];
}

async function main() {
  const projectRoot = process.argv[2];
  if (!projectRoot) {
    console.error('Usage: verify-emitted-esm-interop.mjs <projectRoot>');
    process.exit(2);
  }
  const builtDir = join(workspaceRoot, projectRoot, 'dist');
  if (!existsSync(builtDir)) {
    console.error(
      `verify-esm-interop: no built output at ${builtDir} — did 'build' run? (this target must dependsOn:["build"])`,
    );
    process.exit(2);
  }
  const files = walkModules(builtDir);
  if (files.length === 0) {
    console.error(`verify-esm-interop: no emitted .js/.mjs modules under ${builtDir}.`);
    process.exit(2);
  }

  let checked = 0;
  let failures = 0;
  const probes = [];
  try {
    for (const file of files) {
      const statements = extractBareStatements(readFileSync(file, 'utf8'));
      if (statements.length === 0) continue;

      // Probe beside the emitted file so bare specifiers resolve from the same
      // node_modules chain the real file uses. Removed in the finally below.
      const probe = join(dirname(file), `.verify-esm-interop-${process.pid}-${checked}.mjs`);
      probes.push(probe);
      writeFileSync(probe, statements.join('\n') + '\n', 'utf8');
      checked++;

      try {
        await import(pathToFileURL(probe).href);
      } catch (error) {
        failures++;
        console.error(`✖ verify-esm-interop: ${relative(workspaceRoot, file)} fails to link its bare imports:`);
        for (const s of statements) console.error(`    ${s}`);
        console.error(`  -> ${error.name}: ${error.message}`);
      }
    }
  } finally {
    for (const probe of probes) {
      try {
        rmSync(probe, { force: true });
      } catch {
        /* best effort — a stray probe is regenerated away by the next build */
      }
    }
  }

  if (failures > 0) {
    console.error(`\nverify-esm-interop: ${failures}/${checked} emitted module(s) failed to link for ${projectRoot}.`);
    process.exit(1);
  }
  console.log(`verify-esm-interop: all ${checked} emitted module(s) with bare imports linked cleanly for ${projectRoot}.`);
}

main();
