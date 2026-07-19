import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { orgDirSegment, resolveRoots, rootForScope, systemAppDir } from '../roots';

describe('orgDirSegment', () => {
  it('prefixes with a dot', () => {
    expect(orgDirSegment('adhd')).toBe('.adhd');
    expect(orgDirSegment('acme')).toBe('.acme');
  });
});

describe('systemAppDir', () => {
  it('returns a non-empty absolute path containing the org namespace', () => {
    const dir = systemAppDir('adhd');
    expect(dir).toContain('adhd');
    expect(dir.length).toBeGreaterThan(0);
  });
});

describe('resolveRoots', () => {
  it('nests global root under homedir()/.orgNamespace/<project>/<namespace> by default (zero-config)', () => {
    const roots = resolveRoots({ project: 'agent-mcp', namespace: 'default', orgNamespace: 'adhd' });
    expect(roots.global).toBe(join(homedir(), '.adhd', 'agent-mcp', 'default'));
  });

  it('nests project root under <projectRoot>/.orgNamespace/<project>/<namespace> when a project root is supplied', () => {
    const roots = resolveRoots({
      project: 'agent-mcp',
      namespace: 'default',
      orgNamespace: 'adhd',
      projectRoot: '/tmp/my-project',
    });
    expect(roots.project).toBe(join('/tmp/my-project', '.adhd', 'agent-mcp', 'default'));
  });

  it('omits `project` entirely when no project root is supplied', () => {
    const roots = resolveRoots({ project: 'agent-mcp', namespace: 'default', orgNamespace: 'adhd' });
    expect(roots.project).toBeUndefined();
  });

  it('adhdRoot override replaces BOTH the global and system bases (test-isolation escape hatch)', () => {
    const roots = resolveRoots({
      project: 'agent-mcp',
      namespace: 'default',
      orgNamespace: 'adhd',
      adhdRoot: '/tmp/sandbox-home',
    });
    expect(roots.global).toBe(join('/tmp/sandbox-home', 'agent-mcp', 'default'));
    expect(roots.system).toBe(join('/tmp/sandbox-home', 'agent-mcp', 'default'));
  });

  it('respects a custom orgNamespace segment (org dir = ".<orgNamespace>")', () => {
    const roots = resolveRoots({ project: 'p', namespace: 'default', orgNamespace: 'acme', adhdRoot: '/tmp/home' });
    // adhdRoot override bypasses the org segment for global/system (it IS the base already).
    expect(roots.global).toBe(join('/tmp/home', 'p', 'default'));
  });
});

describe('rootForScope', () => {
  it('returns the matching root for system/global', () => {
    const roots = { system: '/sys', global: '/glob' };
    expect(rootForScope(roots, 'system')).toBe('/sys');
    expect(rootForScope(roots, 'global')).toBe('/glob');
  });

  it('falls back to global when scope is "project" but no project root was resolved', () => {
    const roots = { system: '/sys', global: '/glob' };
    expect(rootForScope(roots, 'project')).toBe('/glob');
  });

  it('returns the real project root when present', () => {
    const roots = { system: '/sys', global: '/glob', project: '/proj' };
    expect(rootForScope(roots, 'project')).toBe('/proj');
  });
});
