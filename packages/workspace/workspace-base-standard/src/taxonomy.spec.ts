/**
 * taxonomy.spec.ts — proves `readTaxonomy` against the REAL
 * `.adhd/workspace.json` in this repo (the actual consumer-visible file,
 * not a synthetic mock) as well as a synthetic tmp/ fixture for the new
 * `boundaries` field and error paths.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readTaxonomy } from './taxonomy';

// vitest's cwd is THIS PROJECT's own root (packages/workspace/
// workspace-base-standard), not the repo root — walk up from this file's
// directory (src/) to the repo root, both to find the REAL
// .adhd/workspace.json and so synthetic fixtures land under the repo's one
// canonical `tmp/` root, per AGENTS.md's ephemeral-artifact convention.
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURES_ROOT = join(REPO_ROOT, 'tmp', 'workspace-base-standard', 'fixtures', 'taxonomy');

describe('readTaxonomy', () => {
  afterEach(() => {
    if (existsSync(FIXTURES_ROOT)) {
      rmSync(FIXTURES_ROOT, { recursive: true });
    }
  });

  it('reads the REAL repo .adhd/workspace.json and exposes the known groups/kinds/platforms/layers', () => {
    const taxonomy = readTaxonomy(REPO_ROOT);

    expect(taxonomy.scope).toBe('@adhd');
    expect(taxonomy.groups).toHaveProperty('workspace');
    expect(taxonomy.kinds).toHaveProperty('base');
    expect(taxonomy.platforms).toHaveProperty('shared');
    expect(taxonomy.layers).toHaveProperty('shared');
  });

  it('reads an optional `boundaries.depConstraints` field when present', () => {
    const dir = join(FIXTURES_ROOT, 'with-boundaries');
    mkdirSync(join(dir, '.adhd'), { recursive: true });
    writeFileSync(
      join(dir, '.adhd', 'workspace.json'),
      JSON.stringify({
        scope: '@adhd',
        groups: { foo: { description: 'foo group' } },
        kinds: { base: { class: 'foundation', description: 'base' } },
        platforms: { shared: { description: 'shared' } },
        layers: { shared: { description: 'shared' } },
        defaults: {},
        boundaries: {
          depConstraints: [{ sourceTag: 'pkg-kind:base', onlyDependOnLibsWithTags: ['pkg-kind:base'] }],
        },
      })
    );

    const taxonomy = readTaxonomy(dir);
    expect(taxonomy.boundaries?.depConstraints).toEqual([
      { sourceTag: 'pkg-kind:base', onlyDependOnLibsWithTags: ['pkg-kind:base'] },
    ]);
  });

  it('has no boundaries field when absent (optional, backward compatible)', () => {
    const dir = join(FIXTURES_ROOT, 'no-boundaries');
    mkdirSync(join(dir, '.adhd'), { recursive: true });
    writeFileSync(
      join(dir, '.adhd', 'workspace.json'),
      JSON.stringify({
        scope: '@adhd',
        groups: {},
        kinds: {},
        platforms: {},
        layers: {},
        defaults: {},
      })
    );

    const taxonomy = readTaxonomy(dir);
    expect(taxonomy.boundaries).toBeUndefined();
  });

  it('throws when .adhd/workspace.json is missing', () => {
    const dir = join(FIXTURES_ROOT, 'missing');
    mkdirSync(dir, { recursive: true });
    expect(() => readTaxonomy(dir)).toThrow(/not found/);
  });

  it('throws when .adhd/workspace.json is malformed JSON', () => {
    const dir = join(FIXTURES_ROOT, 'malformed');
    mkdirSync(join(dir, '.adhd'), { recursive: true });
    writeFileSync(join(dir, '.adhd', 'workspace.json'), '{ not valid json');
    expect(() => readTaxonomy(dir)).toThrow(/not valid JSON/);
  });
});
