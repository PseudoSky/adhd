/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING self-test lives in
 * the sibling `parity-harness.e2e.ts`.
 *
 * Resource lane: proc — it drives the real HTTP transport against a live
 * `node:http` server (real network round-trips) and a real `git apply` /
 * `git apply -R` cycle against a live, disposable repository.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer lists
 * it. Both suites are currently `describe.skip`'d (CPU-THRASH-SKIP,
 * owner-requested) — those skip markers moved with the file, VERBATIM and NOT
 * un-skipped; the e2e lane is simply the correct, documented home for them
 * when the owner chooses to re-enable them (see
 * docs/backlog/grooming/test-perf-improvements.md recs #7, #8), so they are
 * not left in the default lane.
 *
 * The `it.todo` entries below inventory the moved cases (one per real case in
 * `parity-harness.e2e.ts`); they are the contract a mocked version must
 * satisfy without binding a port, calling `fetch`, or running `git`.
 */
import { describe, it } from 'vitest';

// CPU-THRASH-SKIP (owner-requested, 2026-09-23): real HTTP + real git apply.
describe('mocked: captureGolden + assertParity (real HTTP consumer protocol)', () => {
  it.todo(
    'mocked: drives the real HTTP transport and records a snapshot keyed by fixture name'
  );
  it.todo('mocked: rejects an empty fixture list — an empty capture proves nothing');
  it.todo(
    'mocked: rejects duplicate fixture names — they would silently clobber the snapshot key'
  );
  it.todo('mocked: assertParity passes silently for a byte-identical recapture');
  it.todo(
    'mocked: [inv:negative-control] assertParity REJECTS a mismatched recapture — teeth for the deep-equal check'
  );
  it.todo('mocked: reports a fixture missing from the recapture');
  it.todo('mocked: reports an unexpected extra fixture added in the recapture');
  it.todo(
    'mocked: [inv:byte-identical] distinguishes an explicit undefined value from an absent key'
  );
});

// CPU-THRASH-SKIP (owner-requested, 2026-09-23): real git apply / apply -R cycle.
describe('mocked: proveNegativeControl (real git apply / git apply -R cycle)', () => {
  it.todo(
    'mocked: applies the patch (drives the suite RED), reverts it (GREEN), and leaves the tree clean'
  );
  it.todo(
    'mocked: [inv:negative-control] proveNegativeControl ITSELF rejects a patch that fails to turn the suite RED'
  );
  it.todo(
    'mocked: propagates a post-revert GREEN-check failure instead of masking it as "no gate"'
  );
});
