import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveDirs, resolveFiles } from '../dirs';
import type { Roots } from '../roots';

const roots: Roots = { system: '/sys', global: '/glob', project: '/proj' };

describe('resolveDirs', () => {
  it('a kind:"data" dir defaults to shared (no per-instance suffix)', () => {
    const resolved = resolveDirs({ data: { kind: 'data' } }, { roots, activeScope: 'global', instanceId: 'inst-1', namespace: 'default' });
    expect(resolved.data.share).toBe('shared');
    expect(resolved.data.path).toBe(join('/glob', 'data'));
  });

  it('a kind:"logs" dir defaults to per-instance and is suffixed with instanceId', () => {
    const resolved = resolveDirs({ logs: { kind: 'logs' } }, { roots, activeScope: 'global', instanceId: 'inst-1', namespace: 'default' });
    expect(resolved.logs.share).toBe('per-instance');
    expect(resolved.logs.path).toBe(join('/glob', 'logs', 'inst-1'));
  });

  it('two different instanceIds produce two distinct per-instance paths for the same dir kind', () => {
    const a = resolveDirs({ logs: { kind: 'logs' } }, { roots, activeScope: 'global', instanceId: 'inst-A', namespace: 'default' });
    const b = resolveDirs({ logs: { kind: 'logs' } }, { roots, activeScope: 'global', instanceId: 'inst-B', namespace: 'default' });
    expect(a.logs.path).not.toBe(b.logs.path);
  });

  it('an explicit share overrides the kind default', () => {
    const resolved = resolveDirs(
      { data: { kind: 'data', share: 'per-instance' } },
      { roots, activeScope: 'global', instanceId: 'inst-1', namespace: 'default' },
    );
    expect(resolved.data.path).toBe(join('/glob', 'data', 'inst-1'));
  });

  it('a per-dir scope override changes the root used, independent of the active scope', () => {
    const resolved = resolveDirs(
      { data: { kind: 'data', scope: 'project' } },
      { roots, activeScope: 'global', instanceId: 'inst-1', namespace: 'default' },
    );
    expect(resolved.data.path).toBe(join('/proj', 'data'));
    expect(resolved.data.scope).toBe('project');
  });

  it('an explicit path interpolates ${HOME}/${PROJECT_ROOT}/${NAMESPACE}', () => {
    const resolved = resolveDirs(
      { custom: { kind: 'data', path: '${PROJECT_ROOT}/custom/${NAMESPACE}' } },
      { roots, activeScope: 'global', instanceId: 'inst-1', namespace: 'prod', projectRoot: '/my/project' },
    );
    expect(resolved.custom.path).toBe('/my/project/custom/prod');
  });

  it('the empty dirs spec resolves to an empty record', () => {
    expect(resolveDirs(undefined, { roots, activeScope: 'global', instanceId: 'inst-1', namespace: 'default' })).toEqual({});
  });
});

describe('resolveFiles', () => {
  it('joins the file name onto its parent directory path', () => {
    const dirs = resolveDirs({ data: { kind: 'data' } }, { roots, activeScope: 'global', instanceId: 'inst-1', namespace: 'default' });
    const files = resolveFiles({ db: { in: 'data', name: 'app.sqlite' } }, dirs);
    expect(files.db.path).toBe(join('/glob', 'data', 'app.sqlite'));
    expect(files.db.share).toBe('shared');
  });

  it('throws when `in` references an undeclared dirs key', () => {
    expect(() => resolveFiles({ db: { in: 'nonexistent', name: 'app.sqlite' } }, {})).toThrow(/unknown dirs key/);
  });
});
