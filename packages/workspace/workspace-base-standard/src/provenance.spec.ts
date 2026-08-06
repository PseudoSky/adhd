import { describe, expect, it } from 'vitest';
import {
  parseChangelogProvenanceNote,
  parseCommitTrailers,
  renderChangelogProvenanceNote,
  resolveAuthorIdentity,
  type ProvenanceTrailer,
} from './provenance';

describe('provenance — commit trailers <-> CHANGELOG note round-trip', () => {
  it('round-trips a full commit message through parse -> render -> parse and deep-equals the original', () => {
    const commitMessage = [
      'feat(workspace-base-standard): add provenance module',
      '',
      'Some body text describing the change in more detail.',
      '',
      'Work-Item: backlog:FEAT-PROVENANCE-001',
      'Dispatcher: plan-orchestrator',
      'Author: typescript-pro:v1',
      'Model: claude/opus',
    ].join('\n');

    const parsed = parseCommitTrailers(commitMessage);
    expect(parsed).not.toBeNull();

    const note = renderChangelogProvenanceNote(parsed as ProvenanceTrailer);
    expect(note).toBe(
      '‹work:backlog:FEAT-PROVENANCE-001 · dispatcher:plan-orchestrator · author:typescript-pro:v1 · model:claude/opus›'
    );

    const reparsed = parseChangelogProvenanceNote(note);
    expect(reparsed).toEqual(parsed);
  });

  it('returns null when Work-Item is absent', () => {
    const commitMessage = 'fix: something\n\nAuthor: typescript-pro:v1\n';
    expect(parseCommitTrailers(commitMessage)).toBeNull();
  });

  it('returns null when Author is absent', () => {
    const commitMessage = 'fix: something\n\nWork-Item: backlog:FOO-001\n';
    expect(parseCommitTrailers(commitMessage)).toBeNull();
  });

  it('returns null when Work-Item does not match the required prefix pattern', () => {
    const commitMessage = 'fix: something\n\nWork-Item: nonsense\nAuthor: a\n';
    expect(parseCommitTrailers(commitMessage)).toBeNull();
  });

  it('accepts the bare "oneoff" work-item form', () => {
    const commitMessage = 'chore: quick fix\n\nWork-Item: oneoff\nAuthor: human:jdoe\n';
    const parsed = parseCommitTrailers(commitMessage);
    expect(parsed).toEqual({ workItem: 'oneoff', author: 'human:jdoe' });
  });

  it('omits optional fields from the rendered note using their sentinel values, and parses them back out as undefined', () => {
    const trailer: ProvenanceTrailer = { workItem: 'plan:agent-registry', author: 'human:jdoe' };
    const note = renderChangelogProvenanceNote(trailer);
    expect(note).toBe('‹work:plan:agent-registry · dispatcher:unknown · author:human:jdoe · model:n/a›');

    const reparsed = parseChangelogProvenanceNote(note);
    expect(reparsed).toEqual(trailer);
    expect(reparsed?.dispatcher).toBeUndefined();
    expect(reparsed?.model).toBeUndefined();
  });

  it('parseChangelogProvenanceNote returns null for a line with no provenance note', () => {
    expect(parseChangelogProvenanceNote('- Just a normal changelog bullet.')).toBeNull();
  });

  it('parses trailers only from the LAST blank-line-delimited block (ignores a false match in the body)', () => {
    const commitMessage = [
      'feat: something',
      '',
      'Work-Item: backlog:SHOULD-NOT-BE-USED',
      'Author: should-not-be-used',
      '',
      'Work-Item: backlog:REAL-001',
      'Author: real-author',
    ].join('\n');

    const parsed = parseCommitTrailers(commitMessage);
    expect(parsed).toEqual({ workItem: 'backlog:REAL-001', author: 'real-author' });
  });
});

describe('resolveAuthorIdentity — pure resolution, no process/env/fs access', () => {
  it('prefers envAgentName when set, using specFrontmatter version if present', () => {
    const identity = resolveAuthorIdentity({
      envAgentName: 'typescript-pro',
      specFrontmatter: { name: 'typescript-pro', version: '2.1.0' },
      gitAuthorName: 'Jane Doe',
    });
    expect(identity).toEqual({ kind: 'agent', name: 'typescript-pro', version: '2.1.0' });
  });

  it('falls back to "unknown" version when envAgentName is set but no frontmatter', () => {
    const identity = resolveAuthorIdentity({
      envAgentName: 'typescript-pro',
      gitAuthorName: 'Jane Doe',
    });
    expect(identity).toEqual({ kind: 'agent', name: 'typescript-pro', version: 'unknown' });
  });

  it('uses specFrontmatter when envAgentName is absent', () => {
    const identity = resolveAuthorIdentity({
      specFrontmatter: { name: 'plan-orchestrator', version: '1.0.0' },
      gitAuthorName: 'Jane Doe',
    });
    expect(identity).toEqual({ kind: 'agent', name: 'plan-orchestrator', version: '1.0.0' });
  });

  it('falls back to human/gitAuthorName when both agent sources are absent', () => {
    const identity = resolveAuthorIdentity({ gitAuthorName: 'Jane Doe' });
    expect(identity).toEqual({ kind: 'human', name: 'Jane Doe' });
  });
});
