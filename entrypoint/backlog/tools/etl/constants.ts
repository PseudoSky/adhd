/**
 * constants.ts — closed vocabularies the ETL seeds up front (SPEC.md §8.6
 * step 2). This is documentation-derived, read-only reference data: the
 * status/priority token sets below are the ETL's own copy of the closed
 * vocabulary (no old-store module is imported or executed), the same kind of
 * citation SPEC.md itself makes throughout §8.
 *
 * STATUS SPELLING — canonical is LOWERCASE. The written store's `status`
 * catalog is canonical lowercase: the shipped write path mints lowercase
 * literals (`create-issue.ts` defaults to `'open'`) and catalog identity is
 * exact-case, so the mint refuses a name that differs from a live row only by
 * letter case. The frozen source corpus spells statuses UPPERCASE, so every
 * status token the ETL seeds, mints, or persists is folded through
 * {@link canonicalStatusName} to the ONE canonical lowercase spelling.
 *
 * PRIORITY SPELLING — canonical is UPPERCASE, left as-is below.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The full status vocabulary, in its canonical (lowercase) spelling. The
 * member SET is the same as the source union — only letter case is
 * normalized (`open` ↔ `OPEN`), never the meaning.
 */
export const ALL_STATUSES: readonly string[] = [
  'open', 'in_progress', 'partial', 'outstanding', 'deferred', 'blocked', 'mixed', 'unknown',
  'fixed', 'resolved', 'done', 'shipped', 'verified', 'removed',
  'mitigated',
  'superseded', 'invalid', 'duplicate', 'wontfix',
] as const;

/**
 * The ETL's own terminal-status set (the states that mean the item is closed),
 * canonical lowercase. Membership is the same eleven names as before —
 * deliberately NOT the six-name reserved-terminal set the write layer seeds
 * from (`RESERVED_TERMINAL_STATUS_NAMES`, `src/write/catalog.ts`); that
 * divergence is a separate, tracked decision and is not changed here.
 */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'fixed', 'resolved', 'done', 'shipped', 'verified', 'removed',
  'mitigated',
  'superseded', 'invalid', 'duplicate', 'wontfix',
]);

/**
 * Fold a raw status token to its canonical catalog spelling (lowercase) — the
 * ONE place status case is normalized, so no call site mints or compares a
 * status in any other case. Idempotent for an already-canonical name; the
 * frozen corpus's UPPERCASE spellings (`OPEN`, `FIXED`, …) fold to `open`,
 * `fixed`, …. Never used for priority names (canonical UPPERCASE).
 */
export function canonicalStatusName(raw: string): string {
  return raw.toLowerCase();
}

/** `src/store/query.ts`'s `PRIORITY_RANK`, verbatim — reused so every pre-existing sort-by-urgency comparator ports unchanged (SPEC.md §8.1). */
export const PRIORITY_RANK: Readonly<Record<string, number>> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

export const ALL_PRIORITIES: readonly string[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;

/** The one project this ETL can verify a real filesystem path for (SPEC.md §8.4/§8.5). */
export const ADHD_PROJECT_NAME = 'adhd';
/** Repo root, derived from this file's location (`entrypoint/backlog/tools/etl/` → 4 levels up) so it is correct in any checkout, never a baked machine path. */
export const ADHD_PROJECT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
export const ADHD_PROJECT_REPO_URL = 'git@github.com:PseudoSky/adhd.git';

/** SPEC.md §8.4 — both forms collapse onto the single `"adhd"` project row. */
const ADHD_REPO_ALIASES: ReadonlySet<string> = new Set(['adhd', 'PseudoSky/adhd']);

/** SPEC.md §8.4 repo-key normalization: `adhd`/`PseudoSky/adhd` → one project, `"adhd"`; every other distinct repo string is its own project, 1:1, never merged and never dropped. */
export function normalizeProjectName(repo: string): string {
  return ADHD_REPO_ALIASES.has(repo) ? ADHD_PROJECT_NAME : repo;
}

/** The fixed, non-hex sentinel a citation's `sha` takes when it cannot be verified (SPEC.md §8.5). */
export const UNVERIFIED_SHA = 'unverified';

/**
 * Sentinel `target` for a source citation that carries no `file` at all — a
 * genuine, empirically-observed source-data anomaly (the frozen corpus
 * contains one: item rowid 474, `PseudoSky/adhd::BUG-APIGEN-CLI-ROOT-ONEOF-
 * UNSUPPORTED-001`, whose sole citation is a bare `{}`). SPEC.md §8.2 never
 * anticipates a `Citation` with no `file` — this is disclosed here (and
 * counted in the ETL run report's `citationsMalformed`) rather than either
 * crashing the whole item (the citation SHA computation ran BEFORE this
 * guard existed and threw `ERR_INVALID_ARG_TYPE` on exactly this row — a
 * real bug this ETL found and fixed) or silently inventing a plausible-
 * looking fake path.
 */
export const MISSING_CITATION_FILE = '(missing-file)';

/** The audit action every import audit node carries (task contract). */
export const IMPORTED_ACTION = 'imported';
/** The actor recorded on every import audit node (SPEC.md §8.2a). */
export const ETL_ACTOR = 'etl';
