/**
 * test-layout.spec.ts — a freshly scaffolded package conforms to the test
 * layout standard (docs/standards/testing.md, "Test file layout").
 *
 * Failure mode guarded: the generator emits specs under `src/lib/` and a vite
 * `include` of the old globs, so every new package starts out violating
 * `check-test-layout.mjs` (L1, L5, L6) and a test discovery gap goes unseen.
 * Tier: S. Cites: docs/standards/testing.md layout rules L1-L6.
 * Red run: with `relocateScaffoldSpec` and the `UNIT_FILE_INCLUDES` patch
 * removed, all four assertions below failed (spec found under src/lib, vite
 * config lacked UNIT_FILE_INCLUDES, tsconfig.spec.json lacked `test/**`).
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
