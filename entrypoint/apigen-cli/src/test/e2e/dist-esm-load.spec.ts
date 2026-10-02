// Acceptance test for the apigen-cli ESM artifact load (release gate blocker).
//
// package.json declares `"module": "./dist/index.mjs"`, so any ESM consumer
// (and the bundler-mode `import()` path) evaluates `dist/index.mjs`. When a
// workspace plugin pulled a real npm dep into the bundled graph and the
// hand-rolled `rollupOptions.external` list was not updated, Rolldown inlined
// that dep's CJS `require("node:perf_hooks")` and rewrote it to its `__require`
// shim, which THROWS at module evaluation in an ESM context:
//
//   Error: Calling `require` for "node:perf_hooks" in an environment that
//   doesn't expose the `require` function.
//   See https://rolldown.rs/in-depth/bundling-cjs#require-external-modules
//
// The defect is created by the BUNDLER, not the source: a source-level unit
// test passes while the built artifact throws on load. This spec therefore runs
// the REAL built dist/index.mjs as a real `node` ESM child — the exact consumer
// path that was broken.
//
// Teeth: pre-fix the child exits non-zero and prints the Rolldown require
// error; post-fix it loads clean. Reverting the externalization turns it red.

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const DIST_ESM = path.join(REPO_ROOT, 'entrypoint', 'apigen-cli', 'dist', 'index.mjs');

const ESM_URL = pathToFileURL(DIST_ESM).href;

describe('apigen-cli built ESM artifact', () => {
  it('loads under a bare import() with no Rolldown CJS-require shim crash', () => {
    expect(
      existsSync(DIST_ESM),
      `built ESM entry missing at ${DIST_ESM} (the test target must depend on build)`
    ).toBe(true);

    // `node --input-type=module -e "import(url)"`: a bare module load, no argv[1],
    // so the bin guard at src/index.ts does not fire and ONLY load is exercised.
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `import(${JSON.stringify(ESM_URL)})`],
      { encoding: 'utf8' }
    );

    expect(result.error).toBeUndefined();
    expect(
      result.status,
      `import(${ESM_URL}) exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    ).toBe(0);
    expect(result.stderr).not.toContain('node:perf_hooks');
    expect(result.stderr).not.toContain("doesn't expose the `require` function");
  });
});
