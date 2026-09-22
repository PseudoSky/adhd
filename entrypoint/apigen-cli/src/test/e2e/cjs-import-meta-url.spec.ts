// Acceptance test for BUG-BUILD-002 — Vite 8/Rolldown drops `import.meta.url`
// in the CJS output of a `platform: 'browser'` library build (Vite's default),
// lowering it to the empty object `{}`. Every shipped CJS entry point that uses
// `import.meta.url` therefore breaks AT MODULE LOAD:
//
//   createRequire(import.meta.url)  ->  createRequire({}.url)   // ERR_INVALID_ARG_VALUE
//   import.meta.url === argv1Url    ->  {}.url === argv1Url     // bin guard never fires
//
// This MUST run against the BUILT dist artifact as a real `node` child process
// — that is the exact runtime path the bug lives in. Source-level unit tests
// pass while the built artifact is broken (the defect is created by the
// bundler), so an in-process import would prove nothing.
//
// Two independent observable outcomes are asserted, so the spec has teeth for
// BOTH failure modes: (1) the CJS module loads without throwing, and (2) when
// the built file is the real process entry point, the bin guard at
// src/index.ts:113 FIRES and commander's `parseAsync()` actually runs — a bare
// module load (guard not firing) would exit 0 with no help text, so the exit
// code alone is not enough; the consumer-visible help output is asserted too.

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const DIST_CJS = path.join(REPO_ROOT, 'entrypoint', 'apigen-cli', 'dist', 'index.js');
const DIST_ESM = path.join(REPO_ROOT, 'entrypoint', 'apigen-cli', 'dist', 'index.mjs');

// Matches the shim in either single- or double-quoted form (the CJS chunk is
// minified after the plugin's renderChunk hook runs, which normalizes quotes).
const CJS_SHIM_RE = /require\(['"]node:url['"]\)\.pathToFileURL\(__filename\)\.href/;

describe('BUG-BUILD-002: built apigen-cli CJS artifact', () => {
  it('loads under a bare require() — the createRequire(import.meta.url) shim is present', () => {
    expect(
      existsSync(DIST_CJS),
      `built CJS entry missing at ${DIST_CJS} (the test target must depend on build)`
    ).toBe(true);

    // `node -e require(...)`: argv[1] is absent, so the bin guard skips and this
    // exercises ONLY module-load. Pre-fix this throws ERR_INVALID_ARG_VALUE.
    const result = spawnSync(
      process.execPath,
      ['-e', `require(${JSON.stringify(DIST_CJS)})`],
      { encoding: 'utf8' }
    );

    expect(result.error).toBeUndefined();
    expect(result.status, `stderr:\n${result.stderr}`).toBe(0);
    expect(result.stderr).not.toContain('ERR_INVALID_ARG_VALUE');
  });

  it('runs as a real bin: the entry guard fires and commander parses --help', () => {
    const result = spawnSync(process.execPath, [DIST_CJS, '--help'], {
      encoding: 'utf8',
    });

    expect(result.error).toBeUndefined();
    // Exit code is the primary signal: the broken build throws at load (non-zero).
    expect(result.status, `stderr:\n${result.stderr}`).toBe(0);
    // ...and the consumer-visible outcome proves the guard fired + parseAsync ran.
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toMatch(/Usage:\s*apigen/);
    expect(output).toMatch(/generate/);
  });

  it('ships no Rolldown empty-import.meta artifact and no bare `{}.url` in the CJS bundle', () => {
    const code = readFileSync(DIST_CJS, 'utf8');
    expect(code).not.toContain('{}.url');
    expect(code).toMatch(CJS_SHIM_RE);
  });

  it('leaves the ESM bundle untouched: native import.meta.url, no CJS shim', () => {
    const code = readFileSync(DIST_ESM, 'utf8');
    expect(code).toContain('import.meta.url');
    expect(code).not.toMatch(CJS_SHIM_RE);
  });
});
