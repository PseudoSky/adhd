/**
 * Contract of a freshly scaffolded package's test layout (docs/standards/testing.md, "Test file layout").
 *
 * guards: the generator emits a starter spec under src/lib, a vite include other than UNIT_FILE_INCLUDES, or a
 *   tsconfig.spec.json that does not reach test/, so every new package starts out violating check-test-layout.
 * failure mode: a scaffolded package fails L1/L5/L6 on its first commit, or its starter spec is never collected.
 * tier: S (in-memory Nx Tree; no process spawned, nothing sleeps). Fidelity gap: none at tier S.
 * cites: docs/standards/testing.md "Test file layout"; tools/nx-plugins/test/executors/wiring/check-test-layout.mjs.
 * red: 2026-10-23, generator.ts with the relocateScaffoldSpec call commented out: `nx run workspace-codegen-nx:test`
 *   exit 1, 2 failed | 57 passed (the two starter-spec placement assertions); restored with git restore.
 * risk map (standard): a scaffold that silently drifts from the layout (high); an over-strict scaffold assertion (low).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { type Tree, readJson, updateJson } from '@nx/devkit';
import baseGenerator from '../../../../src/generators/base/generator';

process.env.NX_SKIP_FORMAT = 'true';

const ROOT = 'packages/billing/billing-base-widget';

describe('scaffolded package follows the test layout standard', () => {
  let tree: Tree;

  beforeEach(async () => {
    tree = createTreeWithEmptyWorkspace();
    updateJson(tree, 'package.json', (json) => ({
      ...json,
      packageManager: 'pnpm@8.15.9',
      devDependencies: { ...json.devDependencies, typescript: '~6.0.3' },
    }));
    await baseGenerator(tree, { name: 'widget', group: 'billing', nxLayer: 'logic', platform: 'node' });
  });

  it('places the starter spec under test/unit and none under src/', () => {
    expect(tree.exists(`${ROOT}/test/unit/lib/billing-base-widget.spec.ts`)).toBe(true);
    expect(tree.exists(`${ROOT}/src/lib/billing-base-widget.spec.ts`)).toBe(false);
  });

  it('points the starter spec at the source file it covers', () => {
    const body = tree.read(`${ROOT}/test/unit/lib/billing-base-widget.spec.ts`, 'utf-8');
    expect(body).toContain("from '../../../src/lib/billing-base-widget'");
  });

  it('wires the unit lane through UNIT_FILE_INCLUDES', () => {
    const vite = tree.read(`${ROOT}/vite.config.mts`, 'utf-8');
    expect(vite).toContain('UNIT_FILE_INCLUDES');
    expect(vite).toContain('include: UNIT_FILE_INCLUDES');
  });

  it('type-checks all of test/ (fixtures and golden data included) in tsconfig.spec.json', () => {
    const spec = readJson(tree, `${ROOT}/tsconfig.spec.json`);
    expect(spec.include).toEqual(expect.arrayContaining(['test/**/*.ts', 'test/**/*.tsx']));
    expect(spec.exclude ?? []).not.toContain('test/fixtures/**');
    expect(readJson(tree, `${ROOT}/tsconfig.lib.json`).exclude).toContain('test/**');
  });
});
