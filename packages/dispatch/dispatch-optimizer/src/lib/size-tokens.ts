/**
 * size-tokens.ts — shared file-size → token-count helpers for snapshot.ts and optimize.ts.
 *
 * Internal to the package; not part of the public @adhd/dispatch-optimizer surface.
 * Exists to avoid duplicating the same batched-lookup + bytes→tokens logic in both
 * snapshot.ts and optimize.ts (both need it; neither owns it).
 *
 * PURE: no fs/path/node imports. All file-size knowledge is injected via
 * IOptimizerDeps.fileSizes and resolved with graceful degradation to 0.
 */
import type { IOptimizerDeps } from '@adhd/dispatch-spec';

/** §C3 — chars per token by file type (for si_bytes → tokens conversion). */
const CHARS_PER_TOKEN: Record<string, number> = {
  prose: 5.5,
  md: 5.5,
  ts: 6.3,
  tsx: 6.3,
  py: 6.3,
  default: 4.0,
};

/**
 * Convert file bytes to an approximate token count.
 * Source: SCOPE.md §C3 — byte-count is the right proxy (r>0.98, arxiv 2511.08066).
 */
export function siBytesAsTokens(bytes: number, filePath?: string): number {
  if (bytes <= 0) return 0;
  const ext = filePath ? (filePath.split('.').pop()?.toLowerCase() ?? '') : '';
  const cpt = CHARS_PER_TOKEN[ext] ?? CHARS_PER_TOKEN['default'] ?? 4.0;
  return Math.ceil(bytes / cpt);
}

/**
 * Batch-resolve file sizes via the injected deps.fileSizes callback.
 *
 * Graceful degradation: returns an empty map (every lookup then resolves to 0
 * via `map.get(path) ?? 0` at the call site) when deps.fileSizes is undefined,
 * the path list is empty, or the callback itself throws.
 */
export function lookupFileSizes(
  paths: string[],
  deps: IOptimizerDeps
): Map<string, number> {
  if (paths.length === 0 || deps.fileSizes === undefined) return new Map();
  try {
    return deps.fileSizes(paths);
  } catch {
    return new Map();
  }
}
