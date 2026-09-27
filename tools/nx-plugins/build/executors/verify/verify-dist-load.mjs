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
 * BUG-BUILD-VERIFY-DIST-LOAD-BIN-SKIPS-LIB (this file, 2026-09-26): the gate
 * previously short-circuited with `existenceOnly = hasBin` — for ANY package
 * declaring a `bin`, EVERY declared entry (including the LIBRARY entry) was
 * only checked for on-disk presence and NEVER loaded. So a package that ships
 * a CLI could pass `nx run <pkg>:verify-dist-load` while `require('@adhd/<pkg>')`
 * threw on load — the exact defect this gate exists to catch, silently
 * disabled for every bin-bearing package (backlog, agent-mcp, dispatch-cli,
 * apigen-cli, decompile-cli). The fix: LIBRARY entries (main/module/exports)
 * are ALWAYS actually loaded, bin or not. A bin FILE remains existence-only
 * (executing an arbitrary CLI against verify's own argv is meaningless and a
 * long-lived server would hang), but the `bin` no longer suppresses the
 * library load — even when the same file is both (agent-mcp/backlog: main ===
 * bin), it is loaded through the main/module entry and existence-checked
 * through the bin entry.
 *
 * THE LOAD IS OUT-OF-PROCESS (timeout-bounded). A direct in-process
 * `import()`/`require()` of a package entry is unsafe here: an entry may keep
 * the event loop alive (open server, DB handle, stdio transport), which would
 * hang THIS verifier — a gate that hangs is not a gate. So each library entry
 * is loaded by a short-lived CHILD (`node --input-type=module -e …`) that
 * imports the entry and `process.exit(0)`s on success. The child inherits no
 * verifier state; its stderr is surfaced verbatim on failure. A child that
 * exits non-zero is a load error; a child that never finishes within the
 * timeout is ALSO a failure (an entry that hangs on load is a real defect — a
 * consumer's `require()`/`import()` would hang identically). The child is
 * killed with SIGKILL so the verifier itself can never hang.
 *
 * Usage: node verify-dist-load.mjs <projectRoot-relative-to-workspace-root>
 * Exit 0  — every declared entry point verified (libraries loaded; bin files present).
 * Exit 1  — at least one entry point threw on load, or hung (a real regression).
 * Exit 2  — usage/setup error (no built dist, no loadable entry declared).
 *
 * Env: VERIFY_DIST_LOAD_TIMEOUT_MS overrides the per-entry load timeout
 *      (default 15000ms). Tests set it low; production uses the default.
 */

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Locate the workspace root by walking up to nx.json — robust to where this
// script lives (it moved from scripts/ into tools/nx-plugins/build/executors/).
const findRoot = (d) => { while (d !== dirname(d)) { if (existsSync(join(d, 'nx.json'))) return d; d = dirname(d); } return d; };
const workspaceRoot = findRoot(__dirname);

// Per-entry load timeout. A library entry that never finishes evaluating is a
// load defect, so a timeout is a FAILURE, never a skip (see the header).
const PROBE_TIMEOUT_MS = Number.parseInt(process.env.VERIFY_DIST_LOAD_TIMEOUT_MS ?? '', 10) || 15000;

// The out-of-process load probe. Loads one entry exactly as its package.json
// field is consumed (`require` for a CJS entry, `import` for an ESM entry),
// force-exits 0 on success (so an entry that leaves the event loop alive does
// not hang the probe), and writes the real error to stderr + exits 1 on throw.
// The `try`/`catch` around top-level `await` keeps the stack intact; an
// import that never settles simply never reaches `process.exit`, and the
// parent's timeout (SIGKILL) converts that into a loud failure.
const PROBE_SOURCE = `
const mode = process.env.VDL_MODE;
const entryAbs = process.env.VDL_ENTRY_ABS;
const entryUrl = process.env.VDL_ENTRY_URL;
try {
  if (mode === 'import') {
    await import(entryUrl);
  } else {
    const { createRequire } = await import('node:module');
    createRequire(entryAbs)(entryAbs);
  }
} catch (error) {
  process.stderr.write('verify-dist-load: entry threw on load\\n' + ((error && error.stack) || String(error)) + '\\n');
  process.exit(1);
}
process.exit(0);
`;

/**
 * Load `entryAbs` in a short-lived child process and report whether it loaded
 * without throwing (or hanging). Never throws, never hangs, never swallows the
 * child's own error — returns a discriminated `{ ok, error? }`.
 */
function probeLoadInSubprocess(entryAbs, mode) {
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE_SOURCE], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    env: {
      ...process.env,
      VDL_MODE: mode,
      VDL_ENTRY_ABS: entryAbs,
      VDL_ENTRY_URL: pathToFileURL(entryAbs).href,
    },
  });

  if (res.error && (res.error.code === 'ETIMEDOUT' || res.signal === 'SIGKILL')) {
    return {
      ok: false,
      error: new Error(
        `entry never finished loading within ${PROBE_TIMEOUT_MS}ms and was killed — an entry that hangs on ` +
          `require()/import() is a load defect: a real consumer's import would hang the same way.`
      ),
    };
  }
  if (res.error) return { ok: false, error: res.error };
  if (res.status !== 0) {
    const stderr = (res.stderr || '').trim();
    const stdout = (res.stdout || '').trim();
    const detail =
      stderr ||
      stdout ||
      `probe exited with status ${res.status}${res.signal ? ` (signal ${res.signal})` : ''}`;
    return { ok: false, error: new Error(detail) };
  }
  return { ok: true };
}

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

async function verifyEntry(distDir, { kind, mode, file, load }) {
  const abs = resolvePath(distDir, file);
  if (!existsSync(abs)) {
    return { ok: false, kind, file: abs, error: new Error('file declared in package.json but missing from dist — build did not produce it') };
  }
  if (!load) {
    // A bin FILE that is not also a library entry: present in dist, but must
    // not be executed here — running an arbitrary CLI against verify's own
    // argv is meaningless, and a long-lived server would hang the verifier.
    return { ok: true, kind, file: abs, existenceOnly: true };
  }
  const probed = probeLoadInSubprocess(abs, mode);
  return probed.ok
    ? { ok: true, kind, file: abs }
    : { ok: false, kind, file: abs, error: probed.error };
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
  // Library entries are ALWAYS loaded (the bug fix above); bin FILES are
  // existence-checked. When a file is both (main === bin), it appears twice on
  // purpose: loaded through its library entry, existence-checked through bin.
  const entries = [
    ...libEntries.map((e) => ({ ...e, load: true })),
    ...binFiles.map((file) => ({ kind: 'bin', mode: 'exists', file, load: false })),
  ];
  if (entries.length === 0) {
    console.error(
      `verify-dist-load: ${pkgJsonPath} declares no main/module/exports/bin entry point to verify.`
    );
    process.exit(2);
  }

  let failures = 0;
  for (const entry of entries) {
    // Entries come from the DIST manifest and are already dist-root-relative
    // (e.g. "./index.js", not the source manifest's "./dist/index.js") — so
    // they resolve against `builtDir`, exactly as a real consumer's
    // `node_modules/<pkg>` resolution would (dist IS the package root once
    // published).
    const result = await verifyEntry(builtDir, entry);
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
    `\nverify-dist-load: all ${entries.length} entry point(s) verified for ${projectRoot}.`
  );
}

main();
