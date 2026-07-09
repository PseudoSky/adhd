import { describe, expect, it } from 'vitest';
import { mergeFieldDefinitions } from '../field-merge';

describe('mergeFieldDefinitions', () => {
  it('returns an empty map when all three scopes are empty', () => {
    expect(mergeFieldDefinitions({}, {}, {})).toEqual({});
  });

  it('returns an empty map when all three scopes are omitted', () => {
    expect(mergeFieldDefinitions()).toEqual({});
  });

  it('project overrides global overrides system for the same key', () => {
    const merged = mergeFieldDefinitions(
      { 'log.level': { type: 'string', default: 'system-default' } },
      { 'log.level': { type: 'string', default: 'global-default' } },
      { 'log.level': { type: 'string', default: 'project-default' } },
    );
    expect(merged['log.level'].default).toBe('project-default');
    expect(merged['log.level'].sourceScope).toBe('project');
  });

  it('default from project overrides default from global when system is absent', () => {
    const merged = mergeFieldDefinitions(
      {},
      { 'transport.kind': { type: 'string', default: 'stdio' } },
      { 'transport.kind': { type: 'string', default: 'sse' } },
    );
    expect(merged['transport.kind'].default).toBe('sse');
  });

  it('inherits validation keywords from lower scopes when a higher scope only overrides default', () => {
    const merged = mergeFieldDefinitions(
      { 'server.maxDepth': { type: 'integer', default: 5, minimum: 1, maximum: 100 } },
      {},
      { 'server.maxDepth': { type: 'integer', default: 10 } },
    );
    expect(merged['server.maxDepth'].default).toBe(10);
    expect(merged['server.maxDepth'].minimum).toBe(1);
    expect(merged['server.maxDepth'].maximum).toBe(100);
    expect(merged['server.maxDepth'].sourceScope).toBe('project');
  });

  it('a field declared only at global scope keeps global sourceScope and default effective scope', () => {
    const merged = mergeFieldDefinitions({}, { 'log.format': { type: 'string', default: 'json' } }, {});
    expect(merged['log.format'].sourceScope).toBe('global');
    expect(merged['log.format'].scope).toBe('global');
  });

  it('a field declared only at system scope keeps system sourceScope and default effective scope', () => {
    const merged = mergeFieldDefinitions({ 'queue.concurrency': { type: 'integer', default: 5 } }, {}, {});
    expect(merged['queue.concurrency'].sourceScope).toBe('system');
    expect(merged['queue.concurrency'].scope).toBe('system');
  });

  it('an explicit field-level scope override wins over sourceScope for the effective scope', () => {
    const merged = mergeFieldDefinitions(
      {},
      {},
      { 'shared.setting': { type: 'string', default: 'x', scope: 'global' } },
    );
    expect(merged['shared.setting'].sourceScope).toBe('project');
    expect(merged['shared.setting'].scope).toBe('global');
  });

  it('preserves an explicit env override across scopes (project does not clobber it if it does not redeclare env)', () => {
    const merged = mergeFieldDefinitions(
      {},
      { 'providers.openai.secret': { type: 'string', default: '', env: 'OPENAI_API_KEY' } },
      { 'providers.openai.secret': { type: 'string', default: 'proj-default' } },
    );
    expect(merged['providers.openai.secret'].env).toBe('OPENAI_API_KEY');
    expect(merged['providers.openai.secret'].default).toBe('proj-default');
  });

  it('uses "" as the env sentinel when no scope declares an explicit env override', () => {
    const merged = mergeFieldDefinitions({}, {}, { 'db.path': { type: 'string', default: '/tmp/db' } });
    expect(merged['db.path'].env).toBe('');
  });

  it('carries through secret and noEnv flags', () => {
    const merged = mergeFieldDefinitions(
      {},
      {},
      { 'providers.anthropic.secret': { type: 'string', default: '', secret: true, noEnv: false } },
    );
    expect(merged['providers.anthropic.secret'].secret).toBe(true);
    expect(merged['providers.anthropic.secret'].noEnv).toBe(false);
  });

  it('carries through enum/pattern/minLength/maxLength/items keywords', () => {
    const merged = mergeFieldDefinitions(
      {
        'log.level': {
          type: 'string',
          default: 'info',
          enum: ['debug', 'info', 'warn', 'error'],
          pattern: '^[a-z]+$',
          minLength: 3,
          maxLength: 10,
        },
      },
      {},
      {},
    );
    expect(merged['log.level'].enum).toEqual(['debug', 'info', 'warn', 'error']);
    expect(merged['log.level'].pattern).toBe('^[a-z]+$');
    expect(merged['log.level'].minLength).toBe(3);
    expect(merged['log.level'].maxLength).toBe(10);
  });

  it('carries through items for array-typed fields', () => {
    const merged = mergeFieldDefinitions({}, {}, { 'server.allowedAgents': { type: 'array', default: [], items: { type: 'string' } } });
    expect(merged['server.allowedAgents'].items).toEqual({ type: 'string' });
  });

  it('throws when a field has no "type" defined in any scope', () => {
    expect(() =>
      // @ts-expect-error — intentionally missing `type` to exercise the runtime guard
      mergeFieldDefinitions({}, {}, { 'bad.field': { default: 'x' } }),
    ).toThrow(/no "type" defined/);
  });

  it('merges disjoint keys from all three scopes into one flat map', () => {
    const merged = mergeFieldDefinitions(
      { 'log.level': { type: 'string', default: 'info' } },
      { 'log.format': { type: 'string', default: 'json' } },
      { 'db.path': { type: 'string', default: '/tmp/db' } },
    );
    expect(Object.keys(merged).sort()).toEqual(['db.path', 'log.format', 'log.level']);
  });
});
