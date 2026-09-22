/**
 * startup-lazy-load.spec.ts — S-20 / BUG-APIGEN-CORE-CLIENT-STARTUP-001.
 *
 * The startup fix replaced `extraction-session.ts`'s static value import of
 * `ts-morph` with a type-only import plus a memoized lazy `require` in
 * `getProjectCtor()`. The regression it prevents: a caller that only touches
 * the fs-only surface (e.g. `backlog --help`) must NOT pay the ~1-2s cost of
 * loading ts-morph / ts-json-schema-generator.
 *
 * A unit test inside vitest cannot observe this: by the time any spec runs,
 * vitest's own `require.cache` already holds every heavy dep, so "was it
 * imported by this module?" is unanswerable in-process. So the proof runs in
 * a FRESH child `node` process whose `Module._load` is monkey-patched to
 * THROW if a guarded specifier is requested (see `helpers/heavy-dep-probe.js`).
 *
 * Three claims, each with teeth:
 *   1. importing the module resolves neither heavy dep (guard armed);
 *   2. the non-lazy public surface works while the guard is still armed;
 *   3. the first real use of the lazy path DOES request + resolve ts-morph
 *      (the getter fires), in that same child, after the guard is disarmed.
 *
 * The two negative-control cases transpile a synthetic EAGER module (one per
 * guarded specifier) and assert the probe reports the guard trip — proving
 * the detector would go red if the lazy pattern were reverted. The manual
 * demonstration that the real test goes red when `extraction-session.ts`
 * re-introduces the eager import is recorded in the task report.
 *
 * Deterministic: no sleeps; a single bounded child spawn per case (60s cap).
 * Cleanup: the transpiled scratch lives under `tmp/apigen-core-client/` and
 * is removed in `afterAll`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

const HERE = __dirname;
const REPO_ROOT = path.resolve(HERE, '../../../../..');
const HELPERS_DIR = path.join(HERE, 'helpers');
const PROBE = path.join(HELPERS_DIR, 'heavy-dep-probe.js');
const DRIVER = path.join(HELPERS_DIR, 'startup-probe-driver.js');
const MODULE_UNDER_TEST = path.resolve(
  HERE,
  '..',
  'lib',
  'extraction-session.ts'
);

/** The heavy deps the startup fix must keep off the import path. */
const GUARDED_SPECIFIERS = ['ts-morph', 'ts-json-schema-generator'];

const TRANSPILE_OPTIONS: ts.CompilerOptions = {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022,
  esModuleInterop: true,
  skipLibCheck: true,
};

/** Transpile a TS source string to CJS the way the package's own build does. */
function toCommonJs(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: TRANSPILE_OPTIONS,
  }).outputText;
}

interface ProbeError {
  name: string;
  message: string;
  guardedSpecifier?: string;
}

interface ProbeReport {
  ok: boolean;
  phase: string;
  attemptsAfterImport?: string[];
  attemptsAfterNonLazy?: string[];
  attemptsAfterLazy?: string[];
  nonLazyResult?: { version: string; projectsBuiltAtCreation: number } | null;
  lazyResult?: { paths: string[] } | null;
  error?: ProbeError;
}

const RESULT_MARKER = '__PROBE_RESULT__';

function runProbe(opts: {
  target: string;
  fixture: string;
  stopAfterNonLazy?: boolean;
}): ProbeReport {
  const result = spawnSync(process.execPath, [PROBE], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      PROBE_TARGET: opts.target,
      PROBE_DRIVER: DRIVER,
      PROBE_GUARDED: JSON.stringify(GUARDED_SPECIFIERS),
      PROBE_FIXTURE: opts.fixture,
      PROBE_STOP_AFTER: opts.stopAfterNonLazy ? 'nonLazy' : '',
    },
  });

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const markerIndex = stdout.lastIndexOf(RESULT_MARKER);
  if (markerIndex === -1) {
    throw new Error(
      'heavy-dep-probe produced no result marker ' +
        `(status=${String(result.status)}, signal=${String(result.signal)}).\n` +
        `stdout:\n${stdout}\nstderr:\n${stderr}`
    );
  }
  const jsonLine = stdout
    .slice(markerIndex + RESULT_MARKER.length)
    .split('\n', 1)[0];
  return JSON.parse(jsonLine) as ProbeReport;
}

describe('S-20: extraction-session import is lazy w.r.t. heavy deps', () => {
  let scratchDir: string;
  let sessionCjsPath: string;
  let fixturePath: string;

  beforeAll(() => {
    const scratchParent = path.join(REPO_ROOT, 'tmp', 'apigen-core-client');
    fs.mkdirSync(scratchParent, { recursive: true });
    scratchDir = fs.mkdtempSync(
      path.join(scratchParent, 'startup-lazy-load-')
    );

    sessionCjsPath = path.join(scratchDir, 'extraction-session.cjs');
    fs.writeFileSync(
      sessionCjsPath,
      toCommonJs(fs.readFileSync(MODULE_UNDER_TEST, 'utf8'))
    );

    fixturePath = path.join(scratchDir, 'probe-entry.ts');
    fs.writeFileSync(
      fixturePath,
      "export function ping(): string { return 'pong' }\n"
    );
  });

  afterAll(() => {
    if (scratchDir) {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it('imports clean, runs the non-lazy surface armed, then resolves ts-morph on first lazy use', () => {
    const report = runProbe({
      target: sessionCjsPath,
      fixture: fixturePath,
    });

    expect(report.ok, JSON.stringify(report)).toBe(true);
    expect(report.phase).toBe('lazy');

    // (1) The import itself must not request either guarded specifier.
    expect(report.attemptsAfterImport).toEqual([]);

    // (2) The fs-only surface works with the guard still armed, and it really
    //     ran (a no-op driver cannot produce this version string).
    expect(report.attemptsAfterNonLazy).toEqual([]);
    expect(report.nonLazyResult).not.toBeNull();
    expect(typeof report.nonLazyResult?.version).toBe('string');
    expect(report.nonLazyResult?.version).not.toBe('nostat');

    // (3) First real use fires the getter: ts-morph is requested only now,
    //     and it resolves (the probe reports ok:true from the lazy phase).
    expect(report.attemptsAfterLazy).toContain('ts-morph');
    expect(report.attemptsAfterLazy).not.toContain(
      'ts-json-schema-generator'
    );
    expect(report.lazyResult?.paths?.length).toBeGreaterThan(0);
  });

  it('teeth: an eager static import of ts-morph trips the guard at import', () => {
    const eagerCjsPath = path.join(scratchDir, 'eager-ts-morph.cjs');
    fs.writeFileSync(
      eagerCjsPath,
      toCommonJs(
        "import { Project } from 'ts-morph';\n" +
          'export function make(): unknown { return new Project({}); }\n'
      )
    );

    const report = runProbe({
      target: eagerCjsPath,
      fixture: fixturePath,
    });

    expect(report.ok).toBe(false);
    expect(report.phase).toBe('import');
    expect(report.error?.name).toBe('GuardedDepRequestedError');
    expect(report.error?.guardedSpecifier).toBe('ts-morph');
  });

  it('teeth: an eager static import of ts-json-schema-generator trips the guard at import', () => {
    const eagerCjsPath = path.join(scratchDir, 'eager-tsjsg.cjs');
    fs.writeFileSync(
      eagerCjsPath,
      toCommonJs(
        "import { createGenerator } from 'ts-json-schema-generator';\n" +
          'export function make(): unknown { return createGenerator; }\n'
      )
    );

    const report = runProbe({
      target: eagerCjsPath,
      fixture: fixturePath,
    });

    expect(report.ok).toBe(false);
    expect(report.phase).toBe('import');
    expect(report.error?.guardedSpecifier).toBe(
      'ts-json-schema-generator'
    );
  });
});
