import { describe, expect, it } from 'vitest';
import { trackProvenance } from '../provenance';
import { mergeFieldDefinitions } from '../field-merge';
import { resolveConfig } from '../config-resolver';

describe('trackProvenance', () => {
  it('maps an env-derived resolution to { source: "project.env", scope, env }', () => {
    const provenance = trackProvenance({
      'db.path': { source: 'project.env', scope: 'project', env: 'ADHD_TEST_DB_PATH' },
    });
    expect(provenance['db.path']).toEqual({ source: 'project.env', scope: 'project', env: 'ADHD_TEST_DB_PATH' });
  });

  it('maps a default-derived resolution to { source: "project.default", scope } with no env', () => {
    const provenance = trackProvenance({ 'db.path': { source: 'project.default', scope: 'project' } });
    expect(provenance['db.path']).toEqual({ source: 'project.default', scope: 'project' });
    expect(provenance['db.path'].env).toBeUndefined();
  });

  it('maps a store-derived resolution to { source: "project.set", scope }', () => {
    const provenance = trackProvenance({ 'providers.openai.secret': { source: 'project.set', scope: 'project' } });
    expect(provenance['providers.openai.secret']).toEqual({ source: 'project.set', scope: 'project' });
  });

  it('drops a stray env value on a non-env-derived source (defensive stripping)', () => {
    const provenance = trackProvenance({
      // A caller should never construct this, but trackProvenance defends against it anyway.
      'db.path': { source: 'project.default', scope: 'project', env: 'SHOULD_BE_DROPPED' },
    });
    expect(provenance['db.path']).toEqual({ source: 'project.default', scope: 'project' });
  });

  it('keeps env for "project.override" sources', () => {
    const provenance = trackProvenance({
      'providers.openai.secret': { source: 'project.override', scope: 'project', env: 'OPENAI_API_KEY' },
    });
    expect(provenance['providers.openai.secret']).toEqual({
      source: 'project.override',
      scope: 'project',
      env: 'OPENAI_API_KEY',
    });
  });

  it('handles system.default and global.env/global.default sources', () => {
    const provenance = trackProvenance({
      'log.level': { source: 'system.default', scope: 'system' },
      'transport.kind': { source: 'global.env', scope: 'global', env: 'ADHD_TEST_TRANSPORT_KIND' },
      'log.format': { source: 'global.default', scope: 'global' },
    });
    expect(provenance['log.level']).toEqual({ source: 'system.default', scope: 'system' });
    expect(provenance['transport.kind']).toEqual({
      source: 'global.env',
      scope: 'global',
      env: 'ADHD_TEST_TRANSPORT_KIND',
    });
    expect(provenance['log.format']).toEqual({ source: 'global.default', scope: 'global' });
  });

  it('returns {} for an empty input map', () => {
    expect(trackProvenance({})).toEqual({});
  });

  it('composes end-to-end with resolveConfig output', () => {
    const fields = mergeFieldDefinitions(
      { 'log.level': { type: 'string', default: 'info' } },
      {},
      { 'db.path': { type: 'string', default: '/default/db' } },
    );
    const { resolved } = resolveConfig(fields, {
      prefix: 'ADHD_TEST',
      processEnv: { ADHD_TEST_DB_PATH: '/env/db' },
    });
    const provenance = trackProvenance(resolved);
    expect(provenance['log.level']).toEqual({ source: 'system.default', scope: 'system' });
    expect(provenance['db.path']).toEqual({ source: 'project.env', scope: 'project', env: 'ADHD_TEST_DB_PATH' });
  });
});
