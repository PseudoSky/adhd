import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readPackageMeta, validatePackageMeta, type PackageMeta } from './metadata';
import type { WorkspaceTaxonomy } from './taxonomy';

// vitest's cwd is THIS PROJECT's own root, not the repo root — walk up to
// the repo root so fixtures land under the repo's one canonical `tmp/`
// root, per AGENTS.md's ephemeral-artifact convention.
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURES_ROOT = join(REPO_ROOT, 'tmp', 'workspace-base-standard', 'fixtures', 'metadata');

const TAXONOMY: WorkspaceTaxonomy = {
  scope: '@adhd',
  groups: { workspace: { description: 'workspace tooling' } },
  kinds: { base: { class: 'foundation', description: 'base tier' } },
  platforms: { shared: { description: 'shared' } },
  layers: { shared: { description: 'shared' } },
  defaults: {},
};

describe('readPackageMeta', () => {
  afterEach(() => {
    if (existsSync(FIXTURES_ROOT)) {
      rmSync(FIXTURES_ROOT, { recursive: true });
    }
  });

  it('returns null when .adhd/meta.json does not exist', () => {
    const dir = join(FIXTURES_ROOT, 'no-meta');
    mkdirSync(dir, { recursive: true });
    expect(readPackageMeta(dir)).toBeNull();
  });

  it('reads a real .adhd/meta.json file from disk', () => {
    const dir = join(FIXTURES_ROOT, 'with-meta');
    mkdirSync(join(dir, '.adhd'), { recursive: true });
    const meta: PackageMeta = {
      group: 'workspace',
      kind: 'base',
      concerns: ['standards enforcement'],
      invariants: ['pure filesystem reads'],
      entrypoints: ['src/index.ts'],
    };
    writeFileSync(join(dir, '.adhd', 'meta.json'), JSON.stringify(meta, null, 2));

    expect(readPackageMeta(dir)).toEqual(meta);
  });

  it('throws on malformed JSON rather than silently returning null', () => {
    const dir = join(FIXTURES_ROOT, 'malformed');
    mkdirSync(join(dir, '.adhd'), { recursive: true });
    writeFileSync(join(dir, '.adhd', 'meta.json'), '{ bad json');
    expect(() => readPackageMeta(dir)).toThrow(/not valid JSON/);
  });
});

describe('validatePackageMeta', () => {
  it('returns no errors for a group/kind that exist in the taxonomy', () => {
    const meta: PackageMeta = {
      group: 'workspace',
      kind: 'base',
      concerns: [],
      invariants: [],
      entrypoints: [],
    };
    expect(validatePackageMeta(meta, TAXONOMY)).toEqual([]);
  });

  it('errors on an unknown group', () => {
    const meta: PackageMeta = {
      group: 'not-a-real-group',
      kind: 'base',
      concerns: [],
      invariants: [],
      entrypoints: [],
    };
    const errors = validatePackageMeta(meta, TAXONOMY);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('not-a-real-group');
  });

  it('errors on an unknown kind', () => {
    const meta: PackageMeta = {
      group: 'workspace',
      kind: 'not-a-real-kind',
      concerns: [],
      invariants: [],
      entrypoints: [],
    };
    const errors = validatePackageMeta(meta, TAXONOMY);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('not-a-real-kind');
  });

  it('reports both group and kind errors together', () => {
    const meta: PackageMeta = {
      group: 'nope',
      kind: 'nope',
      concerns: [],
      invariants: [],
      entrypoints: [],
    };
    expect(validatePackageMeta(meta, TAXONOMY)).toHaveLength(2);
  });
});
