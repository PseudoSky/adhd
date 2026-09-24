/**
 * gate.e2e.ts — RESOURCE-CONSUMING (lane: proc) conformance-gate tests.
 *
 * The live matrix — a real Python subprocess (`runPythonMatrix`) + a real JVM
 * (`mvn`/`java` via `runJavaMatrix`) over the shared logical-type vectors — is
 * executed by exactly ONE path: this project's `conformance` nx target
 * (`nx run apigen-engine-conformance:conformance`), which runs `src/lib/gate.ts`'s
 * `main()` and writes a durable JSON report to
 * `tmp/apigen-engine-conformance/conformance-report.json`.
 *
 * RECONCILIATION (do not duplicate the live matrix): this lane does NOT
 * re-invoke `runConformanceMatrix`. The `e2e` target `dependsOn` the
 * `conformance` target, so the report is fresh; the assertions below READ that
 * report and verify the same properties the old `runConformanceMatrix`
 * integration block checked (TS/Python/Java hosts conformant, Java ran a live
 * codec matrix — not manifest-only — and all three hosts were discovered).
 *
 * The one live call this lane makes is the `runJavaMatrix` negative-control
 * proof: a single-vector diagnostic that proves the Java matrix runner is not
 * vacuous. `main()` does not perform it, so it is not duplicated anywhere.
 *
 * The pure-logic assertions (checkSupportedIds, runTsMatrix, constructSeedTs,
 * checkInvariantTs, host discovery) stayed in `gate.spec.ts` in the default
 * lane; they spawn nothing and bind nothing.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { CANONICAL_IDS, runJavaMatrix } from '../lib/gate';

import { logicalTypeVectors } from '../lib/vectors';
import type { LogicalTypeVector } from '../lib/vectors';

const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const REPORT_PATH = path.join(
  WORKSPACE_ROOT,
  'tmp',
  'apigen-engine-conformance',
  'conformance-report.json'
);

/** Shape of the durable report `gate.ts`'s `main()` writes. */
interface ConformanceReport {
  readonly passed: boolean;
  readonly generatedAt: string;
  readonly hosts: ReadonlyArray<{
    readonly host: string;
    readonly passed: boolean;
    readonly logicalTypeVersion: string;
    readonly supportedIds: readonly string[];
    readonly vectorsPassed: number;
    readonly vectorsFailed: number;
    readonly failures: ReadonlyArray<{
      readonly vectorId: string;
      readonly phase: string;
      readonly error?: string;
    }>;
  }>;
}

/**
 * Read the report produced by the single live-matrix execution (the
 * `conformance` target). Fails LOUDLY if it is absent rather than skipping —
 * a missing report means the gate never ran, which is not a pass.
 */
function readReport(): ConformanceReport {
  if (!fs.existsSync(REPORT_PATH)) {
    throw new Error(
      `conformance report not found at ${REPORT_PATH}. This lane asserts ` +
        `against the SINGLE live-matrix run performed by the \`conformance\` ` +
        `target (it does not re-execute the matrix). Run ` +
        `\`nx run apigen-engine-conformance:e2e\` (which dependsOn ` +
        `\`conformance\`) or \`nx run apigen-engine-conformance:conformance\` first.`
    );
  }
  return JSON.parse(fs.readFileSync(REPORT_PATH, 'utf-8')) as ConformanceReport;
}

// ---------------------------------------------------------------------------
// runJavaMatrix — REAL JVM subprocess (ApigenConformanceMatrix), no mock.
// The one unique live call this lane makes: a single-vector diagnostic that
// proves the Java matrix runner's negative-control phase is non-vacuous. The
// full Java matrix is already covered by the `conformance` target report below.
// ---------------------------------------------------------------------------

describe('runJavaMatrix — live JVM subprocess (real ApigenConformanceMatrix)', () => {
  it(
    '[TEETH] negative control genuinely fails when a vector wire is corrupted (proves runJavaMatrix is not vacuous)',
    () => {
      // A vector set where the negativeControl mutation is a NO-OP relative
      // to the real logical type (mutating to the exact same wire value) —
      // if runJavaMatrix's negative-control phase were vacuous (always
      // "pass"), this would still show green. It must NOT.
      const base = logicalTypeVectors[0];
      if (!base) throw new Error('expected at least one conformance vector');
      const vacuousVector: LogicalTypeVector = {
        ...base,
        negativeControl: { mutate: 'wire', to: base.wire },
      };
      const results = runJavaMatrix([vacuousVector], WORKSPACE_ROOT);
      const ncResult = results.find((r) => r.phase === 'negative-control');
      expect(ncResult).toBeDefined();
      if (!ncResult) throw new Error('expected a negative-control result');
      expect(
        ncResult.pass,
        'runJavaMatrix must flag a no-op negativeControl mutation as a FAILING (vacuous) check'
      ).toBe(false);
    },
    120_000
  );
});

// ---------------------------------------------------------------------------
// The FULL live matrix — asserted against the durable report the SINGLE live
// execution (`nx run apigen-engine-conformance:conformance`) wrote, never by
// re-running it here.
// ---------------------------------------------------------------------------

describe('conformance report — the single live-matrix execution (TS + Python + Java)', () => {
  it('[TS-pass] the TS host ran conformant (report host "ts" passed, zero failures)', () => {
    const report = readReport();
    const ts = report.hosts.find((h) => h.host === 'ts');
    expect(ts).toBeDefined();
    if (!ts) throw new Error('expected a ts host in the report');
    expect(ts.failures).toHaveLength(0);
    expect(ts.passed).toBe(true);
  });

  it('[Python-pass] the Python host ran conformant (report host "python" passed, zero failures)', () => {
    const report = readReport();
    const py = report.hosts.find((h) => h.host === 'python');
    expect(py).toBeDefined();
    if (!py) throw new Error('expected a python host in the report');
    expect(py.failures).toHaveLength(0);
    expect(py.passed).toBe(true);
  });

  it(
    '[Java-pass] the Java host ran a LIVE codec matrix conformant (passed, and >1 result — not manifest-only)',
    () => {
      const report = readReport();
      const java = report.hosts.find((h) => h.host === 'java');
      expect(java).toBeDefined();
      if (!java) throw new Error('expected a java host in the report');
      expect(java.failures).toHaveLength(0);
      expect(java.passed).toBe(true);
      // Prove it's a LIVE runner, not the manifest-only supportedIds-only
      // check: more than just the single 'supported-ids' result must be
      // present (manifest-only hosts have exactly 1 result).
      expect(java.vectorsPassed + java.vectorsFailed).toBeGreaterThan(1);
    }
  );

  it('[coverage] TS, Python, and Java hosts are all present in the report', () => {
    const report = readReport();
    const hosts = report.hosts.map((h) => h.host);
    expect(hosts).toContain('ts');
    expect(hosts).toContain('python');
    expect(hosts).toContain('java');
    // The gate must also be globally green.
    expect(report.passed).toBe(true);
  });

  it('[canonical-ids] every canonical id has at least one shared vector', () => {
    const coveredTypes = new Set(logicalTypeVectors.map((v) => v.logicalType));
    for (const id of CANONICAL_IDS) {
      expect(coveredTypes.has(id), `no vector exercises "${id}"`).toBe(true);
    }
  });
});
