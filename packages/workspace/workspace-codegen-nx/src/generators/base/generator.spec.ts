/**
 * generator.spec.ts — proves the `base` generator's build-executor
 * enforcement (INVESTIGATION-BUILD-TOOL-001 generator-enforcement item).
 *
 * WHY THIS EXISTS: 10 `@nx/vite:build` `platform:node`/`platform:shared`
 * apigen packages shipped broken `verify-dist-load`-failing dist bundles
 * (`ReferenceError: __filename is not defined in ES module scope`) because
 * their `vite.config.ts` bundled real npm dependencies (ts-morph,
 * typescript) instead of externalizing them — see BACKLOG.md
 * INVESTIGATION-BUILD-TOOL-001 / BUG-BUILD-VITE-EXTERNAL-BUNDLING-001. The
 * fix (`tools/vite-plugins/externalize.mjs`'s `externalizeRealDeps`) only prevents
 * a RECURRENCE if newly-scaffolded packages get it automatically. This test
 * drives the actual `base` generator (the same codepath every tier
 * delegates through — see `shared/generator.ts`) against a real in-memory
 * Tree and asserts the generated `vite.config.ts` on disk-equivalent content
 * actually wires the externalization call — not just that the generator
 * "ran without throwing".
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { type Tree, updateJson } from '@nx/devkit';
import baseGenerator from './generator';

// Nx 23's generator init ensures the formatter package through the package
// manager; inside the vitest worker `pnpm --ignore-workspace --version` is not
// resolvable. The generator already passes `skipFormat`, so opting out of the
// formatter install here keeps the test focused on the scaffold it asserts.
process.env.NX_SKIP_FORMAT = 'true';

describe('base generator — vite external-deps enforcement', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
    // Nx 23's `@nx/js:init` asserts the workspace's declared `typescript` is
    // >= 5.8.0. The empty-workspace seed declares none, but the generator's
    // `@nx/js:library` call resolves the range from the (empty) tree — seed a
    // supported version so the assertion reflects a real workspace.
    updateJson(tree, 'package.json', (json) => ({
      ...json,
      packageManager: 'pnpm@8.15.9',
      devDependencies: { ...json.devDependencies, typescript: '~6.0.3' },
    }));
  });

  it('platform:node — wires externalizeRealDeps(__dirname) into rollupOptions.external', async () => {
    await baseGenerator(tree, {
      name: 'widget',
      group: 'billing',
      nxLayer: 'logic',
      platform: 'node',
    });

    const viteConfig = tree.read(
      'packages/billing/billing-base-widget/vite.config.mts',
      'utf-8'
    );
    expect(viteConfig).toContain(
      "import { externalizeRealDeps } from '../../../tools/vite-plugins/externalize.mjs';"
    );
    expect(viteConfig).toContain('external: externalizeRealDeps(__dirname)');
    // The bug this closes: a bare `external: []` bundles every real npm dep.
    expect(viteConfig).not.toMatch(/external:\s*\[\]/);
    // BUG-BUILD-002: Vite 8/Rolldown lowers `import.meta.url` to `{}.url` in a
    // browser-platform CJS chunk; the shared shim must be wired automatically.
    expect(viteConfig).toContain(
      "import { importMetaUrlCjs } from '../../../tools/vite-plugins/import-meta-url-cjs.mjs';"
    );
    expect(viteConfig).toContain('importMetaUrlCjs()');
  });

  it('platform:shared — also wires externalizeRealDeps (apigen-core-client\'s tier)', async () => {
    await baseGenerator(tree, {
      name: 'widget',
      group: 'billing',
      nxLayer: 'shared',
      platform: 'shared',
    });

    const viteConfig = tree.read(
      'packages/billing/billing-base-widget/vite.config.mts',
      'utf-8'
    );
    expect(viteConfig).toContain('external: externalizeRealDeps(__dirname)');
  });

  it('platform:browser — leaves external: [] alone (consumed by an app bundler, not Node)', async () => {
    await baseGenerator(tree, {
      name: 'widget',
      group: 'billing',
      nxLayer: 'ui-primitives',
      platform: 'browser',
    });

    const viteConfig = tree.read(
      'packages/billing/billing-base-widget/vite.config.mts',
      'utf-8'
    );
    expect(viteConfig).not.toContain('externalizeRealDeps');
    expect(viteConfig).toMatch(/external:\s*\[\]/);
    // BUG-BUILD-002: a browser package's CJS output is never run under Node, so
    // `require('node:url')`/`__filename` are not defined there — do not wire it.
    expect(viteConfig).not.toContain('importMetaUrlCjs');
  });

  it('wires the centralized test-time source-resolution plugin into the generated config', async () => {
    await baseGenerator(tree, {
      name: 'widget',
      group: 'billing',
      nxLayer: 'logic',
      platform: 'node',
    });

    const viteConfig = tree.read(
      'packages/billing/billing-base-widget/vite.config.mts',
      'utf-8'
    );
    // The helper is imported, not duplicated inline.
    expect(viteConfig).toContain(
      "import { nxViteTsPathsPre } from '../../../tools/vite-plugins/source-resolution.mjs';"
    );
    // It is invoked, and sits immediately after the normal-order plugin so it
    // lands in `plugins: []` ahead of vite:resolve. The template emits the array
    // inline (`plugins: [importMetaUrlCjs(), nxViteTsPaths(), nxViteTsPathsPre(), …]`),
    // so accept any whitespace between the two calls, not a literal newline.
    expect(viteConfig).toContain('nxViteTsPathsPre()');
    expect(viteConfig).toMatch(/nxViteTsPaths\(\),\s*nxViteTsPathsPre\(\),/);
  });

  it('wires the source-resolution plugin for platform:browser too (tests still import @adhd/*)', async () => {
    await baseGenerator(tree, {
      name: 'widget',
      group: 'billing',
      nxLayer: 'ui-primitives',
      platform: 'browser',
    });

    const viteConfig = tree.read(
      'packages/billing/billing-base-widget/vite.config.mts',
      'utf-8'
    );
    expect(viteConfig).toContain('nxViteTsPathsPre()');
  });

  it('emits the BUG-062 caution note (so a project author adding a real-Node child-process test sees the opt-out path)', async () => {
    await baseGenerator(tree, {
      name: 'widget',
      group: 'billing',
      nxLayer: 'logic',
      platform: 'node',
    });

    const viteConfig = tree.read(
      'packages/billing/billing-base-widget/vite.config.mts',
      'utf-8'
    );
    // The note is what tells a future author to DELETE the pre-ordered plugin
    // when their tests spawn a real-Node child (BUG-062) — it must actually be
    // present, not merely described in the generator source.
    expect(viteConfig).toContain('NOTE (test resolution)');
    // ...and it must not itself defeat the idempotency guards it warns about.
    expect(viteConfig.match(/source-resolution\.mjs/g)?.length).toBe(1);
    expect(viteConfig.match(/nxViteTsPathsPre\(\)/g)?.length).toBe(1);
  });
});
