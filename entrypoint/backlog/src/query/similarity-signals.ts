/**
 * similarity-signals.ts — the PURE multi-signal comparator the C9
 * cross-project similarity guard is built on (C9 spec, `similarity-signals.ts`
 * row). No store access, no I/O: two independent signals over plain values, so
 * the guard is unit-testable in isolation and the scan (`write/similarity-scan.ts`)
 * stays a thin composition of this plus the raw vector channel.
 *
 * Why a SECOND signal at all (AC7): cosine alone is never sufficient
 * cross-project. Two boilerplate filings from unrelated repos can sit at high
 * cosine while sharing no real intent — the title-token Jaccard and the
 * structural (citation / component-path) overlap are the independent evidence
 * that keeps such a pair advisory-invisible.
 */

/** The plain, store-free view of one item a signal comparison needs. */
export interface ISignalItem {
  title: string;
  body?: string;
  /**
   * Tokens drawn from the item's citations — `file`/`symbol`/`errorText`/
   * `blastRadius`. Callers pass whatever citation strings they have; this
   * module tokenizes them.
   */
  citationTokens?: readonly string[];
  /** The owning component's `meta.path` (repo-relative), when known. */
  componentPath?: string;
}

/**
 * Tokens too common to carry similarity signal. Kept deliberately small and
 * English-centric: an over-broad stop list would erase genuine short titles,
 * and a missed stop word only makes the overlap signal slightly more
 * permissive, never less safe (the cosine threshold still gates).
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'from',
  'has',
  'have',
  'in',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'was',
  'were',
  'will',
  'with',
]);

/**
 * Lowercase, split on every non-alphanumeric run, and drop stop words — the
 * token stream {@link titleTokenOverlap} and {@link sharedStructuralSignal}
 * both compare over, so the two signals can never disagree on what a "token"
 * is.
 */
export function normalizeTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t));
}

/**
 * Jaccard overlap of two title token SETS: `|A∩B| / |A∪B|`, in `[0,1]`.
 * Two empty (or all-stop-word) titles have no overlap to speak of and score
 * `0`, never `1` — "nothing in common" must not read as "identical".
 */
export function titleTokenOverlap(a: string, b: string): number {
  const ta = new Set(normalizeTokens(a));
  const tb = new Set(normalizeTokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const token of ta) if (tb.has(token)) intersection += 1;
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Normalize a repo-relative path for prefix comparison: forward slashes, lowercased, trimmed of a trailing slash. */
function normalizePath(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  const normalized = path.trim().replace(/\\/g, '/').toLowerCase();
  if (normalized.length === 0) return undefined;
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

/**
 * The second independent signal for a cross-project candidate: does the pair
 * share a citation token (`file`/`symbol`/`errorText`/`blastRadius`) OR do
 * their component paths nest (one is a path-prefix of the other — e.g.
 * `packages/agent` and `packages/agent/agent-engine-compiler`)? Either is
 * structural evidence of a real shared locus, independent of the cosine.
 */
export function sharedStructuralSignal(
  a: ISignalItem,
  b: ISignalItem
): boolean {
  const aTokens = new Set(
    (a.citationTokens ?? []).flatMap((t) => normalizeTokens(t))
  );
  const bTokens = new Set(
    (b.citationTokens ?? []).flatMap((t) => normalizeTokens(t))
  );
  for (const token of aTokens) if (bTokens.has(token)) return true;

  const aPath = normalizePath(a.componentPath);
  const bPath = normalizePath(b.componentPath);
  if (aPath && bPath) {
    // Compare on a segment boundary so `packages/agent` does not match
    // `packages/agentic` — a raw string prefix would.
    if (
      aPath === bPath ||
      aPath.startsWith(`${bPath}/`) ||
      bPath.startsWith(`${aPath}/`)
    ) {
      return true;
    }
  }
  return false;
}
