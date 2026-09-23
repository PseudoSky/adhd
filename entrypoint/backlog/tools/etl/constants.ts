/**
 * constants.ts — closed vocabularies the ETL seeds up front (SPEC.md §8.6
 * step 2), copied verbatim from `src/model.ts`'s `BacklogStatus` union /
 * `TERMINAL_STATUSES` and `src/store/query.ts`'s `PRIORITY_RANK`. This is
 * documentation-derived, read-only reference data — copying a closed,
 * frozen TypeScript union's literal values is not "reading the old store
 * through in-tree code" (no old-store module is imported or executed); it is
 * the same kind of citation SPEC.md itself makes throughout §8 (e.g.
 * "model.ts:56-68").
 */

/** `src/model.ts`'s full `BacklogStatus` union, verbatim. */
export const ALL_STATUSES: readonly string[] = [
  'OPEN', 'IN_PROGRESS', 'PARTIAL', 'OUTSTANDING', 'DEFERRED', 'BLOCKED', 'MIXED', 'UNKNOWN',
  'FIXED', 'RESOLVED', 'DONE', 'SHIPPED', 'VERIFIED', 'REMOVED',
  'MITIGATED',
  'SUPERSEDED', 'INVALID', 'DUPLICATE', 'WONTFIX',
] as const;

/** `src/model.ts`'s `TERMINAL_STATUSES`, verbatim (union of done + workaround + dismissed). */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'FIXED', 'RESOLVED', 'DONE', 'SHIPPED', 'VERIFIED', 'REMOVED',
  'MITIGATED',
  'SUPERSEDED', 'INVALID', 'DUPLICATE', 'WONTFIX',
]);

/** `src/store/query.ts`'s `PRIORITY_RANK`, verbatim — reused so every pre-existing sort-by-urgency comparator ports unchanged (SPEC.md §8.1). */
export const PRIORITY_RANK: Readonly<Record<string, number>> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

export const ALL_PRIORITIES: readonly string[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;

/** The one project this ETL can verify a real filesystem path for (SPEC.md §8.4/§8.5). */
export const ADHD_PROJECT_NAME = 'adhd';
export const ADHD_PROJECT_PATH = '/Users/nix/dev/node/adhd';
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
