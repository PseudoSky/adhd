/**
 * catalog.spec.ts — direct unit tests for `projectHasKnownPath`
 * (`write/catalog.ts`), the single shared precondition both write paths gate
 * the `citation_requires_sha` policy on (DEBT 2b1d8a22).
 *
 * These are deliberately value-level tests: the predicate is a pure function
 * over a resolved project row, so no store and no verb are involved. What
 * matters is its exact boundary — `typeof path === 'string' && path.length > 0`
 * — because a project on the wrong side of it either loses the policy's
 * hard-fail (accepted-but-unverifiable citations) or gains one it should not
 * (a path-less project can never verify, so the gate has nothing to reject).
 */
import { describe, expect, it } from 'vitest';
import { defaultCitationAllowedExternalRoots } from './citation-path.js';
import {
  projectHasKnownPath,
  resolveProjectPolicy,
  type IResolvedProjectRow,
} from './catalog.js';

function project(
  metadata: Record<string, unknown> | undefined
): IResolvedProjectRow {
  return { rowid: 1, uid: 'uid-1', name: 'p', metadata };
}

describe('projectHasKnownPath — the shared citation-verification precondition', () => {
  it('true for a non-empty string path — the only case verification is possible in', () => {
    expect(projectHasKnownPath(project({ path: '/repo' }))).toBe(true);
  });

  it('false when metadata itself is undefined', () => {
    expect(projectHasKnownPath(project(undefined))).toBe(false);
  });

  it('false when metadata is present but has no path key', () => {
    expect(projectHasKnownPath(project({ other: '/repo' }))).toBe(false);
  });

  it('false for the empty string — the length boundary itself', () => {
    expect(projectHasKnownPath(project({ path: '' }))).toBe(false);
  });

  it('false for every non-string path (number / null / object / boolean)', () => {
    expect(projectHasKnownPath(project({ path: 42 }))).toBe(false);
    expect(projectHasKnownPath(project({ path: null }))).toBe(false);
    expect(projectHasKnownPath(project({ path: { href: '/repo' } }))).toBe(
      false
    );
    expect(projectHasKnownPath(project({ path: true }))).toBe(false);
  });

  it('true for a whitespace-only string — the literal `length > 0` contract, NOT a trim', () => {
    // Pinned deliberately: the predicate is a non-empty-STRING check, not a
    // path-validity check. Treating whitespace as "known" is the SAFE side —
    // it keeps the sha gate armed (a bogus root resolves no file, so the
    // citation still hard-fails) instead of silently waiving it. A trim here
    // would move a caller-data defect into a policy bypass.
    expect(projectHasKnownPath(project({ path: '   ' }))).toBe(true);
  });

  it('narrows `metadata.path` to `string` for the caller (the type-level half of the contract)', () => {
    const p = project({ path: '/repo' });
    if (!projectHasKnownPath(p)) {
      throw new Error('expected the predicate to report a known path');
    }
    // This compiles ONLY because the predicate narrows `metadata.path` from
    // `unknown` to `string` — the narrowing both `computeCitationSha` call
    // sites depend on. `satisfies` pins the type with no runtime cast; the
    // `.length` read is the runtime half of the same guarantee.
    const path = p.metadata.path satisfies string;
    expect(path.length).toBeGreaterThan(0);
  });
});

describe('resolveProjectPolicy — citationAllowedExternalRoots is validated, never spread from a malformed value (BUG 62059b57 follow-up)', () => {
  it('preserves an explicitly valid string[] — including an explicit [] that disables the carve-out', () => {
    expect(
      resolveProjectPolicy(
        project({ policy: { citationAllowedExternalRoots: ['/a', '/b'] } })
      ).citationAllowedExternalRoots
    ).toEqual(['/a', '/b']);
    expect(
      resolveProjectPolicy(
        project({ policy: { citationAllowedExternalRoots: [] } })
      ).citationAllowedExternalRoots
    ).toEqual([]);
  });

  it('falls back to the narrow runtime default when the field is a bare string (never char-spread)', () => {
    // `'abc'` spread would be `['a','b','c']` — assert the DEFAULT, which is
    // what proves the value was validated and replaced.
    expect(
      resolveProjectPolicy(
        project({ policy: { citationAllowedExternalRoots: '/etc' } })
      ).citationAllowedExternalRoots
    ).toEqual(defaultCitationAllowedExternalRoots());
  });

  it('falls back to the default when the field is a non-array object', () => {
    expect(
      resolveProjectPolicy(
        project({ policy: { citationAllowedExternalRoots: { 0: '/etc' } } })
      ).citationAllowedExternalRoots
    ).toEqual(defaultCitationAllowedExternalRoots());
  });

  it('falls back to the default when ANY element is not a string', () => {
    expect(
      resolveProjectPolicy(
        project({ policy: { citationAllowedExternalRoots: ['/ok', 42] } })
      ).citationAllowedExternalRoots
    ).toEqual(defaultCitationAllowedExternalRoots());
  });

  it('defaults (lazily) when no policy object is present at all', () => {
    expect(
      resolveProjectPolicy(project({ path: '/repo' }))
        .citationAllowedExternalRoots
    ).toEqual(defaultCitationAllowedExternalRoots());
  });
});
