import { describe, expect, it } from 'vitest';

import { buildProvenanceEntry, trackProvenance } from '../provenance';

describe('buildProvenanceEntry', () => {
  it('carries env only when source is "env"', () => {
    expect(buildProvenanceEntry({ source: 'env', scope: 'global', env: 'ADHD_T_PORT' })).toEqual({
      source: 'env',
      scope: 'global',
      env: 'ADHD_T_PORT',
    });
  });

  it('strips a stray env value for any non-"env" source — defensive against stale env names', () => {
    expect(buildProvenanceEntry({ source: 'default', scope: 'global', env: 'SHOULD_BE_DROPPED' })).toEqual({
      source: 'default',
      scope: 'global',
    });
  });

  it('omits env entirely when absent', () => {
    expect(buildProvenanceEntry({ source: 'project', scope: 'project' })).toEqual({ source: 'project', scope: 'project' });
  });
});

describe('trackProvenance', () => {
  it('projects a flat map of resolution inputs to a flat map of provenance entries', () => {
    const result = trackProvenance({
      'a.port': { source: 'env', scope: 'global', env: 'ADHD_T_A_PORT' },
      'b.name': { source: 'default', scope: 'global' },
    });
    expect(result).toEqual({
      'a.port': { source: 'env', scope: 'global', env: 'ADHD_T_A_PORT' },
      'b.name': { source: 'default', scope: 'global' },
    });
  });
});
