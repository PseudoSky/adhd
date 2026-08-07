/**
 * managed-region.ts — marker engine for idempotent upgrade re-application.
 *
 * Marker format: HTML-comment-style, matching the convention already
 * implicit in the repo's own generator comments:
 *
 * ```
 * <!-- @workspace:managed:start id="<id>" -->
 * ...managed body...
 * <!-- @workspace:managed:end id="<id>" -->
 * ```
 *
 * A "managed region" lets a generator/upgrader re-stamp a specific span of a
 * hand-maintained file (e.g. a section of `README.md`) on every run without
 * clobbering the surrounding hand-written content.
 */

function startMarker(markerId: string): string {
  return `<!-- @workspace:managed:start id="${markerId}" -->`;
}

function endMarker(markerId: string): string {
  return `<!-- @workspace:managed:end id="${markerId}" -->`;
}

/**
 * Builds a `RegExp` matching the full managed region (both markers and
 * everything between them, non-greedy) for a given marker id.
 */
function regionRegExp(markerId: string): RegExp {
  const start = escapeRegExp(startMarker(markerId));
  const end = escapeRegExp(endMarker(markerId));
  return new RegExp(`${start}[\\s\\S]*?${end}`);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Returns `true` if `content` already contains a managed region for
 * `markerId`.
 */
export function hasManagedRegion(content: string, markerId: string): boolean {
  return regionRegExp(markerId).test(content);
}

/**
 * Applies (inserts or replaces) a managed region identified by `markerId`.
 *
 * - If the markers are absent, the region (start marker + `newBody` + end
 *   marker) is appended at the end of the file (with a leading blank line
 *   separator if `content` is non-empty and doesn't already end in a
 *   newline).
 * - If the markers are present, only the content strictly between them is
 *   replaced with `newBody` — everything outside the marker span (before
 *   the start marker and after the end marker) is left untouched,
 *   byte-for-byte.
 */
export function applyManagedRegion(content: string, markerId: string, newBody: string): string {
  const region = `${startMarker(markerId)}\n${newBody}\n${endMarker(markerId)}`;

  if (hasManagedRegion(content, markerId)) {
    return content.replace(regionRegExp(markerId), region);
  }

  if (content.length === 0) {
    return `${region}\n`;
  }

  const separator = content.endsWith('\n') ? '\n' : '\n\n';
  return `${content}${separator}${region}\n`;
}
