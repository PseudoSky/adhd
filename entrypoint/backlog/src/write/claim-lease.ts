/**
 * claim-lease.ts — the ephemeral claim lease's read-side logic, shared by
 * every write verb that needs to know whether a live claim currently blocks
 * it. `claim.ts` (§6.3.5) is the only verb that MUTATES `claimedBy`/
 * `claimedAt`; this module only ever reads and interprets that pair, so
 * `transition.ts` (§6.3.5's own "a live claim by someone else blocks a
 * status change" rule) can enforce the SAME staleness semantics without
 * duplicating the age-math or silently drifting from it over time.
 */

/** Pulls the raw `claimedBy`/`claimedAt` pair off an issue's metadata, typed and undefined-safe. */
export function extractClaimMeta(metadata: Record<string, unknown> | undefined): {
  claimedBy: string | undefined;
  claimedAt: string | undefined;
} {
  const meta = metadata ?? {};
  return {
    claimedBy: typeof meta['claimedBy'] === 'string' ? (meta['claimedBy'] as string) : undefined,
    claimedAt: typeof meta['claimedAt'] === 'string' ? (meta['claimedAt'] as string) : undefined,
  };
}

/**
 * A missing `claimedAt` (should not happen alongside a real `claimedBy`, but
 * never trusted) is treated as infinitely old — the same fail-open choice
 * `claim.ts`'s own reclaim branch already makes.
 */
export function claimAgeMinutes(
  claimedAt: string | undefined,
  now: string
): number {
  return claimedAt !== undefined
    ? (Date.parse(now) - Date.parse(claimedAt)) / 60_000
    : Number.POSITIVE_INFINITY;
}

export function isClaimStale(
  claimedAt: string | undefined,
  now: string,
  staleAfterMin: number
): boolean {
  return claimAgeMinutes(claimedAt, now) >= staleAfterMin;
}
