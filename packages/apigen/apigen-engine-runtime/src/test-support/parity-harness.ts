/**
 * parity-harness — shared golden-fixture parity harness ([def:parity-gate]).
 *
 * The machinery every transport migration's parity gate is built on
 * (`docs/plan/apigen-serve-core/contexts/_shared.md`):
 *
 *   1. `captureGolden(driver, fixtures)` — BEFORE migrating, drive the
 *      CURRENT live server/CLI through its REAL consumer protocol
 *      ([def:real-consumer-protocol]) and record the result per fixture. The
 *      caller commits the resulting snapshot as
 *      `<plugin>/src/test/golden/<transport>.snapshot.json`.
 *   2. `assertParity(committed, recapture)` — AFTER migrating, re-capture
 *      through the adapter-based server (same driver contract) and assert
 *      deep-equality vs the committed snapshot ([inv:byte-identical]).
 *   3. `proveNegativeControl(runner, patchPath)` — prove the gate can
 *      actually fail: apply a one-line regression patch, assert the parity
 *      suite goes RED, revert it, assert GREEN ([inv:negative-control]). A
 *      parity suite that has never been shown to fail is not a gate
 *      (AGENTS.md §7 pt 2).
 *
 * This module drives transports the way a real consumer does — `fetch`, a
 * real `@modelcontextprotocol/sdk` client, a spawned child process, an
 * HTTP/gRPC client — NEVER through plugin internals (AGENTS.md §7). It is
 * deliberately independent of the new serve-core primitives
 * (`op-plan.ts`/`dispatch-for-plan.ts`/etc.): it captures CURRENT
 * (pre-migration) behavior, so importing the new primitives here would
 * defeat the point of an independent-of-the-refactor parity check.
 */

import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

// ---------------------------------------------------------------------------
// Fixtures + driver contract
// ---------------------------------------------------------------------------

/**
 * One golden-fixture case. `name` is the stable key under which its result
 * lands in the snapshot — it must be unique within a fixture list so a
 * snapshot round-trips through `JSON.stringify`/parse without collisions.
 *
 * The proposal's fixture classes (safe/scalar GET-hoist, unsafe/mutating
 * scalar, session/envelope, `streaming:true`, `--use` mount, plus one
 * validation-failure and one domain `ApiError` per class) are just
 * `GoldenFixture` values a transport migration's own spec constructs; this
 * harness has no opinion on fixture shape beyond "has a stable name".
 */
export interface GoldenFixture<TInput = unknown> {
  /** Stable snapshot key. Must be unique within one fixture list. */
  readonly name: string;
  /** Whatever the driver needs to make the call (request shape is driver-defined). */
  readonly input: TInput;
}

/**
 * Drives one fixture through a REAL consumer protocol
 * ([def:real-consumer-protocol]) and returns whatever that protocol yielded
 * (parsed JSON body, tool-call result, stdout+exit-code, …). Implementations
 * live in each transport's own spec — this harness only orchestrates calls
 * through the interface, never reaches into transport/plugin internals.
 */
export interface ParityDriver<TInput = unknown, TOutput = unknown> {
  invoke(fixture: GoldenFixture<TInput>): Promise<TOutput>;
}

/** A captured (or committed) golden snapshot: fixture name -> captured result. */
export type GoldenSnapshot<TOutput = unknown> = Record<string, TOutput>;

// ---------------------------------------------------------------------------
// Step 1/2 — captureGolden
// ---------------------------------------------------------------------------

/**
 * Drives `driver` over every fixture, in order, and records each result
 * keyed by `fixture.name`. Used BOTH to capture the pre-migration golden
 * snapshot (commit the result) and to re-capture post-migration (feed the
 * result to {@link assertParity}).
 *
 * Fails loudly — never silently — on the two shapes that would make a
 * "parity" claim meaningless: an empty fixture list (nothing was proven) and
 * a duplicate fixture name (a later result would silently clobber an
 * earlier one in the snapshot object).
 */
export async function captureGolden<TInput = unknown, TOutput = unknown>(
  driver: ParityDriver<TInput, TOutput>,
  fixtures: readonly GoldenFixture<TInput>[]
): Promise<GoldenSnapshot<TOutput>> {
  if (fixtures.length === 0) {
    throw new Error(
      'captureGolden: fixtures[] is empty — a capture over zero fixtures proves nothing about parity.'
    );
  }

  const snapshot: GoldenSnapshot<TOutput> = {};
  const seen = new Set<string>();
  for (const fixture of fixtures) {
    if (seen.has(fixture.name)) {
      throw new Error(
        `captureGolden: duplicate fixture name "${fixture.name}" — fixture names are the snapshot's keys and must be unique.`
      );
    }
    seen.add(fixture.name);
    // Sequential, not `Promise.all` — fixtures may share transport state
    // (sessions, `--use` mount ordering) that a real consumer would also
    // observe serially; deterministic one-at-a-time capture is intentional.
    snapshot[fixture.name] = await driver.invoke(fixture);
  }
  return snapshot;
}

// ---------------------------------------------------------------------------
// Step 2 — assertParity
// ---------------------------------------------------------------------------

/** Thrown by {@link assertParity} when a recapture diverges from the committed snapshot. */
export class ParityMismatchError extends Error {
  /** Fixture names that diverged (missing, unexpectedly added, or value-mismatched). */
  readonly fixtureNames: readonly string[];

  constructor(message: string, fixtureNames: readonly string[]) {
    super(message);
    this.name = 'ParityMismatchError';
    this.fixtureNames = fixtureNames;
  }
}

/**
 * Asserts `recapture` deep-equals `committed`, fixture-by-fixture
 * ([inv:byte-identical]). Uses `node:util`'s `isDeepStrictEqual` — strict
 * structural equality (type-sensitive, own-enumerable-key-sensitive: e.g.
 * `{a: undefined}` is NOT equal to `{}`) so a silent `undefined`⇄absent or
 * `"1"`⇄`1` drift is caught, not coerced away.
 *
 * Reports every divergence in one error (missing fixtures, unexpectedly
 * added fixtures, and per-fixture value mismatches) rather than failing on
 * the first one, so a broken migration's full blast radius is visible from
 * a single test failure.
 */
export function assertParity<TOutput = unknown>(
  committed: GoldenSnapshot<TOutput>,
  recapture: GoldenSnapshot<TOutput>
): void {
  const committedNames = Object.keys(committed).sort();
  const recaptureNames = new Set(Object.keys(recapture));

  const missing = committedNames.filter((name) => !recaptureNames.has(name));
  const added = [...recaptureNames]
    .filter((name) => !Object.prototype.hasOwnProperty.call(committed, name))
    .sort();
  const mismatched = committedNames.filter(
    (name) =>
      recaptureNames.has(name) &&
      !isDeepStrictEqual(committed[name], recapture[name])
  );

  if (missing.length === 0 && added.length === 0 && mismatched.length === 0) {
    return;
  }

  const lines: string[] = [];
  if (missing.length > 0) {
    lines.push(`missing from recapture: ${missing.join(', ')}`);
  }
  if (added.length > 0) {
    lines.push(`unexpected extra fixture(s) in recapture: ${added.join(', ')}`);
  }
  for (const name of mismatched) {
    lines.push(
      `fixture "${name}" diverged:\n` +
        `  committed:  ${JSON.stringify(committed[name])}\n` +
        `  recapture:  ${JSON.stringify(recapture[name])}`
    );
  }

  const fixtureNames = [...missing, ...added, ...mismatched];
  throw new ParityMismatchError(
    `assertParity: parity broken for ${fixtureNames.length} fixture(s):\n${lines.join('\n')}`,
    fixtureNames
  );
}

// ---------------------------------------------------------------------------
// Step 3 — proveNegativeControl
// ---------------------------------------------------------------------------

/** Options for {@link proveNegativeControl}. */
export interface NegativeControlOptions {
  /**
   * Working directory `git apply` runs in — the repository root the
   * committed `patchPath` is expressed relative to. Defaults to
   * `process.cwd()`.
   */
  cwd?: string;
}

/**
 * Proves a parity suite is an actual gate, not dead weight
 * ([inv:negative-control], AGENTS.md §7 pt 2): applies `patchPath` (a
 * one-line regression, `git apply`), asserts `runner()` now REJECTS (goes
 * RED), reverts the patch (`git apply -R`) even if the RED assertion itself
 * fails, then asserts `runner()` resolves again (goes GREEN).
 *
 * `runner` is whatever re-proves parity for the migration under test —
 * typically "recapture via the driver, then `assertParity` against the
 * committed snapshot". It must REJECT (throw / return a rejected promise) to
 * signal RED and resolve to signal GREEN.
 *
 * Throws if the patch fails to turn the suite RED (the gate would not have
 * caught the regression) — this is the one case `proveNegativeControl`
 * itself must fail loudly on, independent of whatever `runner` does. Repo
 * rule: never `git stash` / `git reset --hard` — patch apply/revert is the
 * only mutation performed, and it is always undone in a `finally`.
 */
export async function proveNegativeControl(
  runner: () => void | Promise<void>,
  patchPath: string,
  opts: NegativeControlOptions = {}
): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();

  applyPatch(patchPath, cwd);
  try {
    let wentRed = false;
    try {
      await runner();
    } catch {
      wentRed = true;
    }
    if (!wentRed) {
      throw new Error(
        `proveNegativeControl: the parity suite stayed GREEN after applying "${patchPath}" — ` +
          '[inv:negative-control] requires the regression to turn it RED. A gate that never fails is not a gate.'
      );
    }
  } finally {
    revertPatch(patchPath, cwd);
  }

  // Reverted — the suite must be GREEN again. A rejection here is a genuine
  // failure (the patch or the harness itself is broken) and propagates.
  await runner();
}

function applyPatch(patchPath: string, cwd: string): void {
  execFileSync('git', ['apply', patchPath], { cwd, stdio: 'pipe' });
}

function revertPatch(patchPath: string, cwd: string): void {
  execFileSync('git', ['apply', '-R', patchPath], { cwd, stdio: 'pipe' });
}
