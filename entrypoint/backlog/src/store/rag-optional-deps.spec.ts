/**
 * Guard: the optional RAG packages MUST stay declared in `package.json`.
 *
 * WHY THIS TEST EXISTS (it has already caught a real, silent, feature-killing
 * regression twice in one session):
 *
 * `semantic-search.ts` loads `@adhd/sox-vector-store` and
 * `@adhd/sox-embedding-provider` through `loadOptional()`, which routes the
 * module specifier through a `const` so that NEITHER TypeScript NOR the
 * bundler resolves it statically (that indirection is load-bearing — see the
 * doc comment on `loadOptional`). The unavoidable consequence is that **no
 * static analyzer can see these dependencies**: `@nx/dependency-checks` finds
 * zero references, and `nx run backlog:sync-deps` therefore rewrites
 * `optionalDependencies` back to `{}`.
 *
 * Nothing else catches that. In-repo tests — including the full
 * `rag-e2e.spec.ts` real-model suite — resolve `@adhd/sox-*` through tsconfig
 * path aliases, so they stay green whether or not `package.json` declares the
 * dependency at all. The failure only appears for a consumer who installs the
 * published tarball: the packages are never fetched, `loadOptional` throws
 * MODULE_NOT_FOUND, `bootstrapSemanticBackend` reports "not installed", and
 * every semantic input answers `rag_not_configured` forever. A completely
 * dead feature, with 650+ green tests.
 *
 * So the manifest itself is the thing under test.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = join(HERE, '..', '..');
const REPO_ROOT = join(PKG_DIR, '..', '..');

interface IManifest {
  readonly name: string;
  readonly optionalDependencies?: Record<string, string>;
}

const manifest = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as IManifest;

/**
 * Every specifier this package actually hands to `loadOptional()`, read out of
 * the source rather than hardcoded — so adding a third optional package is
 * caught by this test too, instead of quietly shipping undeclared.
 */
function loadOptionalSpecifiers(): string[] {
  const source = readFileSync(join(HERE, 'semantic-search.ts'), 'utf8');
  const found = new Set<string>();
  for (const m of source.matchAll(/loadOptional<[^>]*>\(\s*'([^']+)'\s*\)/g)) {
    found.add(m[1]);
  }
  return [...found].sort();
}

describe('RAG optional dependencies are declared in the shipped manifest', () => {
  it('finds the loadOptional() call sites at all (guards the guard)', () => {
    // If a refactor renames loadOptional or changes its call shape, the regex
    // above would silently match nothing and every assertion below would pass
    // vacuously. Fail loudly instead.
    expect(loadOptionalSpecifiers().length).toBeGreaterThan(0);
  });

  it('declares every loadOptional() specifier in optionalDependencies', () => {
    const declared = manifest.optionalDependencies ?? {};
    expect(
      Object.keys(declared).length,
      'optionalDependencies is empty — `nx run backlog:sync-deps` strips it because ' +
        'loadOptional() hides the specifiers from static analysis. Re-add them by hand.',
    ).toBeGreaterThan(0);

    for (const specifier of loadOptionalSpecifiers()) {
      expect(
        declared[specifier],
        `${specifier} is loaded at runtime by semantic-search.ts but is NOT in ` +
          `optionalDependencies — a consumer installing the published tarball would ` +
          `never receive it and RAG would be permanently dead for them.`,
      ).toBeTruthy();
    }
  });

  it('keeps package.json and pnpm-lock.yaml in agreement on the ranges', () => {
    // A declared-but-unlocked range means the next install resolves something
    // nobody verified; a locked-but-undeclared one is the regression above,
    // caught from the other direction.
    const lock = parseYaml(readFileSync(join(REPO_ROOT, 'pnpm-lock.yaml'), 'utf8')) as {
      importers?: Record<string, { optionalDependencies?: Record<string, { specifier?: string }> }>;
      entrypoint?: unknown;
    };
    // pnpm v6 lockfiles nest importers under `importers:`; the flat form used
    // by this repo puts each workspace path at the top level.
    const importer =
      lock.importers?.['entrypoint/backlog'] ??
      (lock as unknown as Record<string, { optionalDependencies?: Record<string, { specifier?: string }> }>)[
        'entrypoint/backlog'
      ];
    expect(importer, 'no entrypoint/backlog importer entry in pnpm-lock.yaml').toBeTruthy();

    const locked = importer?.optionalDependencies ?? {};
    const declared = manifest.optionalDependencies ?? {};

    for (const [name, range] of Object.entries(declared)) {
      expect(locked[name]?.specifier, `${name} declared in package.json but absent from the lockfile`).toBe(range);
    }

    // The reverse direction is the one that actually catches a sync-deps wipe:
    // the lockfile still remembers the dependency long after package.json has
    // been rewritten to `{}`, so a one-way check would pass vacuously on
    // exactly the regression this file exists to prevent.
    for (const [name, entry] of Object.entries(locked)) {
      expect(
        declared[name],
        `${name} is locked for entrypoint/backlog but no longer declared in package.json — ` +
          `optionalDependencies was almost certainly wiped by \`nx run backlog:sync-deps\`. ` +
          `Re-add it as "${entry?.specifier}".`,
      ).toBe(entry?.specifier);
    }
  });
});
