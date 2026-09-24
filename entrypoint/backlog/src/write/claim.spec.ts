/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `claim.e2e.ts`.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer spawns
 * subprocesses or loads the real fastembed embedding model. This file spawns
 * nothing and embeds nothing; it exists so the future MOCKED unit-test version
 * of this suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real
 * case in `claim.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess or a real model.
 */
import { describe, it } from 'vitest';

describe("mocked: claim", () => {
  it.todo("mocked: claim on an unclaimed issue: writes {claimedBy, claimedAt}, returns status:\"claimed\"");
  it.todo("mocked: claim by the SAME claimant again: status:\"held\", claimedAt bumps (idempotent re-claim)");
  it.todo("mocked: claim by a DIFFERENT agent while not stale and no force: throws ClaimHeldError(heldBy, heldSince)");
  it.todo("mocked: claim by a DIFFERENT agent with force:true overrides a non-stale claim: status:\"reclaimed-stale\", previousClaimant set");
  it.todo("mocked: claim by a DIFFERENT agent once the lease is genuinely stale (project_policy.claim_stale_after_min): status:\"reclaimed-stale\", no force needed");
  it.todo("mocked: release by the claimant: clears both fields, status:\"released\"");
  it.todo("mocked: release by a non-claimant, or on an unclaimed issue: status:\"release-noop\", no write, wasClaimedBy echoes the prior value");
  it.todo("mocked: renew by the claimant: bumps claimedAt, status:\"renewed\"");
  it.todo("mocked: renew by a non-claimant: throws ClaimHeldError, never mutates");
  it.todo("mocked: renew on an unclaimed issue: throws ClaimHeldError (SPEC.md §6.3.5 assigns this to the same outcome as \"held by someone else\")");
  it.todo("mocked: IssueNotFoundError for a uid that does not resolve to a live issue");
  it.todo("mocked: IssueNotFoundError for a uid whose issue has already been soft-deleted (never re-claimable)");
  it.todo("mocked: InvalidArgumentError on missing/blank uid, by, or an out-of-vocabulary action");
  it.todo("mocked: every real write emits exactly one audit row, in order; release-noop emits none (SPEC.md §4a)");
  it.todo("mocked: claiming a terminal-status issue throws IssueTerminalError and writes nothing");
  it.todo("mocked: release/renew on a now-terminal issue still succeed (cleanup is not a new claim attempt)");
  it.todo("mocked: CONTROL (immediate — the only mode used in production): two real processes claim the SAME uid at the same instant — exactly one wins, the other gets a non-retryable ClaimHeldError");
  it.todo("mocked: NEGATIVE CONTROL: ADHD_BACKLOG_UNSAFE_TX_MODE=deferred strips the BEGIN IMMEDIATE RESERVED-lock guarantee — proves the CONTROL case above is exercising that guarantee, not passing for an unrelated reason");
});
