/**
 * required.ts — the required-targets / required-files REGISTRY, as plain
 * data. This module intentionally contains no runner wiring (no nx
 * execution, no shell-out) — that's the nx adapter's (`PKG-WS-NX-ADAPTER`)
 * job. This file only answers "what is required", never "how to run it".
 */

/**
 * Nx targets every package in the workspace must define, regardless of
 * tags.
 */
export const REQUIRED_TARGETS = ['build', 'lint', 'test', 'typecheck', 'demo', 'verify'] as const;

export type RequiredTarget = (typeof REQUIRED_TARGETS)[number];

/**
 * Tags that additionally require an `nx-release-publish` target — a package
 * that is actually published to npm must have a working publish target.
 */
const PUBLISH_GATING_TAGS = ['access:public', 'publish:npm'];

/**
 * Returns the full list of required target names for a project, given its
 * Nx tags. `nx-release-publish` is appended only when the project carries
 * one of the publish-gating tags (`access:public` / `publish:npm`).
 */
export function requiredTargetsFor(tags: string[]): string[] {
  const targets: string[] = [...REQUIRED_TARGETS];
  if (tags.some((t) => PUBLISH_GATING_TAGS.includes(t))) {
    targets.push('nx-release-publish');
  }
  return targets;
}

/**
 * Files every package in the workspace must have, regardless of tags.
 */
export const REQUIRED_FILES = ['README.md', 'CLAUDE.md', 'DEMO.md', 'CHANGELOG.md', 'PLAYBOOK.md'] as const;

export type RequiredFile = (typeof REQUIRED_FILES)[number];

/**
 * A required file's section requirement:
 *  - `{ kind: 'marker', marker }` — the file must contain this exact
 *    substring (e.g. a Markdown heading).
 *  - `{ kind: 'non-empty' }` — the file's trimmed content must be
 *    non-empty; the section itself is freeform (`PLAYBOOK.md`'s
 *    pre/post-merge steps).
 *  - `{ kind: 'none' }` — no section requirement beyond the file existing
 *    (`DEMO.md`).
 */
export type SectionRequirement = { kind: 'marker'; marker: string } | { kind: 'non-empty' } | { kind: 'none' };

/**
 * Required-section requirement per required file.
 */
export const REQUIRED_FILE_SECTION_MARKERS: Record<RequiredFile, SectionRequirement> = {
  'README.md': { kind: 'marker', marker: '## Public API' },
  'CHANGELOG.md': { kind: 'marker', marker: '## Unreleased' },
  'CLAUDE.md': { kind: 'marker', marker: '## Invariants' },
  'DEMO.md': { kind: 'none' },
  'PLAYBOOK.md': { kind: 'non-empty' },
};

/**
 * Currently every required file applies to every project regardless of
 * tags — this function exists (mirroring {@link requiredTargetsFor}'s
 * shape) so callers have one consistent seam if/when a tag-gated file
 * requirement is introduced later.
 */
export function requiredFilesFor(_tags: string[]): string[] {
  return [...REQUIRED_FILES];
}
