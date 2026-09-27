/**
 * revision.ts — the issue content-revision counter (DESIGN §2 Primitive 1/4).
 *
 * One revision counter, one name: `subject.revision` (Primitive 2) and
 * `source_revision` (Primitive 4) are the SAME quantity — a monotonic counter
 * on the issue's own `meta.revision`, bumped on every mutating write. A check
 * or a verdict is stale relative to this one counter, so it must be read
 * through one function rather than each consumer re-deriving it.
 *
 * This module is pure (no store, no I/O): it reads only the `meta` blob a
 * caller already has in hand. `C6`'s verdict layer owns the bump sites
 * (`create-issue` seeds `revision: 0`; `update`/`transition`/`claim`/`relate`/
 * `move` set `nextRevision(priorMeta)`); `attest`/`recheck` deliberately do
 * NOT bump, because they never touch the subject.
 *
 * A never-mutated issue (no `meta.revision` at all, e.g. every issue created
 * before the counter existed) reads as `0`, so the pre-counter corpus is
 * consistent without a backfill.
 */

/**
 * The monotonic revision of an issue's content — `0` for a never-mutated
 * issue. A non-finite or non-numeric stored value (a malformed `meta` blob)
 * degrades to `0` rather than propagating `NaN` into a comparison.
 */
export function readRevision(meta: Record<string, unknown> | undefined): number {
  const raw = meta?.['revision'];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
}

/** `readRevision(meta) + 1` — the revision a mutating write stamps onto its node. */
export function nextRevision(
  meta: Record<string, unknown> | undefined
): number {
  return readRevision(meta) + 1;
}
