/**
 * generator.spec.ts — first real test for workspace-codegen-nx.
 *
 * WHY THIS EXISTS: `nx test workspace-codegen-nx` exited 1 with
 * "No test files found" — the project declares a `test` target but shipped zero
 * tests. The tempting fix is `passWithNoTests: true`; that is a silent skip, and
 * this repo's testing protocol forbids it ("a test that doesn't run is not a
 * safety net; it's a comment"). So: drive the real generator instead.
 *
 * The generator writes through `@nx/devkit`'s virtual `Tree`, so this exercises
 * the ACTUAL generator against an in-memory workspace — no mocks of the unit under
 * test, no filesystem, no cleanup, and fully deterministic.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { type Tree, readJson, updateJson } from '@nx/devkit';
import typesGenerator from './generator';

// Nx 23's generator init ensures the formatter package through the package
// manager; inside the vitest worker `pnpm --ignore-workspace --version` is not
// resolvable. The generator already passes `skipFormat`, so opting out of the
// formatter install here keeps the test focused on the scaffold it asserts.
process.env.NX_SKIP_FORMAT = 'true';

describe('types generator', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
    // Nx 23's `@nx/js:init` asserts the workspace's declared `typescript` is
    // >= 5.8.0; seed a supported version so the assertion reflects a real
    // workspace rather than the bare empty-tree fixture.
    updateJson(tree, 'package.json', (json) => ({
      ...json,
      packageManager: 'pnpm@8.15.9',
      devDependencies: { ...json.devDependencies, typescript: '~6.0.3' },
    }));
  });

  it('scaffolds packages/<group>/<group>-base-types with a project.json', async () => {
    await typesGenerator(tree, { group: 'billing' });

    const root = 'packages/billing/billing-base-types';
    expect(tree.exists(`${root}/project.json`)).toBe(true);
    expect(tree.exists(`${root}/package.json`)).toBe(true);
  });

  it('re-tags the scaffolded project as pkg-kind:types / pkg-class:types', async () => {
    await typesGenerator(tree, { group: 'billing' });

    const projectJson = readJson(tree, 'packages/billing/billing-base-types/project.json');
    const tags: string[] = projectJson.tags ?? [];

    // The generator delegates to the 'base' scaffold, then overrides these two tags.
    // If that override regresses, the package ships mis-classified.
    expect(tags).toContain('pkg-kind:types');
    expect(tags).toContain('pkg-class:types');
    expect(tags).not.toContain('pkg-kind:base');
    expect(tags).not.toContain('pkg-class:base');
  });

  it('honours an explicit name, replacing the default "types" segment', async () => {
    await typesGenerator(tree, { group: 'billing', name: 'contracts' });

    expect(tree.exists('packages/billing/billing-base-contracts/project.json')).toBe(true);
    expect(tree.exists('packages/billing/billing-base-types/project.json')).toBe(false);
  });

  it('is platform:shared — a types package must never be node- or browser-only', async () => {
    await typesGenerator(tree, { group: 'billing' });

    const projectJson = readJson(tree, 'packages/billing/billing-base-types/project.json');
    const tags: string[] = projectJson.tags ?? [];
    expect(tags).toContain('platform:shared');
  });
});
