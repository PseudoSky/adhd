/**
 * typecheck-spec-wiring.spec.ts — a4c837a2.
 *
 * WHY THIS EXISTS: `@nx/js:library` emits `tsconfig.spec.json` but nothing
 * compiles it (nx.json's `production` namedInput excludes it), so every
 * freshly scaffolded package failed release GATE 0 / lane-reachability rule 6
 * ("tsconfig.spec.json with no compiling target"). The generator must emit the
 * `typecheck-spec` target, its ratchet baseline, and the `test.dependsOn`
 * entry for EVERY tier that scaffolds a spec tsconfig.
 *
 * These specs drive the real tier generators against a real in-memory Tree
 * (the way a consumer runs `nx g`), and AC2 materializes the generated tree to
 * a fixture workspace and runs the REAL rule-6 checker over it.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { type Tree, updateJson, readJson } from '@nx/devkit';
import * as fs from 'node:fs';
import * as path from 'node:path';
import baseGenerator from '../base/generator';
import coreGenerator from '../core/generator';
import engineGenerator from '../engine/generator';
import storeGenerator from '../store/generator';
import pluginGenerator from '../plugin/generator';
import generatorGenerator from '../generator/generator';
import queryGenerator from '../query/generator';
import typesGenerator from '../types/generator';
import entrypointGenerator from '../entrypoint/generator';
import { pathToFileURL } from 'node:url';

process.env.NX_SKIP_FORMAT = 'true';

const BASELINE_DIR = 'tools/nx-plugins/build/executors/typecheck-spec';
const REPO_TMP = path.resolve(__dirname, '../../../../../../tmp/workspace-codegen-nx');

type RunChecks = (args: {
  workspaceRoot: string;
  gateTargets: string[];
  baseline: { tsconfigSpecWithoutCompileTarget: string[] };
}) => Promise<{ violations: { rule: string; detail: string }[] }>;

/**
 * The real GATE 0 checker is a plain ESM tooling module outside any Nx
 * project, so it is loaded by file URL (a static relative import into tools/
 * is rejected by @nx/enforce-module-boundaries).
 */
async function loadRunChecks(): Promise<RunChecks> {
  const checker = path.resolve(
    __dirname,
    '../../../../../../tools/nx-plugins/test/executors/wiring/check-lane-reachability.mjs',
  );
  return (await import(pathToFileURL(checker).href)).runChecks as RunChecks;
}

interface ITierCase {
  tier: string;
  project: string;
  root: string;
  run: (tree: Tree) => Promise<void>;
}

const opts = { name: 'widget', group: 'billing', nxLayer: 'logic', platform: 'node' as const };
const TIERS: ITierCase[] = [
  { tier: 'base', project: 'billing-base-widget', root: 'packages/billing/billing-base-widget', run: (t) => baseGenerator(t, opts) },
  { tier: 'core', project: 'billing-core-widget', root: 'packages/billing/billing-core-widget', run: (t) => coreGenerator(t, opts) },
  { tier: 'engine', project: 'billing-engine-widget', root: 'packages/billing/billing-engine-widget', run: (t) => engineGenerator(t, opts) },
  { tier: 'store', project: 'billing-store-widget', root: 'packages/billing/billing-store-widget', run: (t) => storeGenerator(t, opts) },
  { tier: 'plugin', project: 'billing-plugin-widget', root: 'packages/billing/billing-plugin-widget', run: (t) => pluginGenerator(t, opts) },
  { tier: 'generator', project: 'billing-generator-widget', root: 'packages/billing/billing-generator-widget', run: (t) => generatorGenerator(t, opts) },
  { tier: 'query', project: 'billing-query-widget', root: 'packages/billing/billing-query-widget', run: (t) => queryGenerator(t, opts) },
  // `types` scaffolds through the `base` tier under the hood (group-base-<name>).
  { tier: 'types', project: 'billing-base-widget', root: 'packages/billing/billing-base-widget', run: (t) => typesGenerator(t, { name: 'widget', group: 'billing' }) },
];

function newTree(): Tree {
  const tree = createTreeWithEmptyWorkspace();
  updateJson(tree, 'package.json', (json) => ({
    ...json,
    packageManager: 'pnpm@8.15.9',
    devDependencies: { ...json.devDependencies, typescript: '~6.0.3' },
  }));
  return tree;
}

describe('a4c837a2 — every TS tier wires the spec-corpus compile gate', () => {
  let tree: Tree;
  beforeEach(() => {
    tree = newTree();
  });
  afterAll(() => {
    fs.rmSync(REPO_TMP, { recursive: true, force: true });
  });

  describe.each(TIERS)('$tier tier', ({ project, root, run }) => {
    it('a4c837a2 AC1: emits the typecheck-spec target over the package tsconfig.spec.json', async () => {
      await run(tree);
      expect(tree.exists(`${root}/tsconfig.spec.json`)).toBe(true);
      const target = readJson(tree, `${root}/project.json`).targets['typecheck-spec'];
      expect(target).toBeDefined();
      expect(target.executor).toBe('nx:run-commands');
      expect(target.cache).toBe(true);
      expect(target.options.command).toBe(
        `node ${BASELINE_DIR}/ratchet.mjs --tsconfig ${root}/tsconfig.spec.json --baseline ${BASELINE_DIR}/${project}.baseline.json`,
      );
    });

    it('a4c837a2 AC1: emits an empty ratchet baseline at the path the target names', async () => {
      await run(tree);
      const baselinePath = `${BASELINE_DIR}/${project}.baseline.json`;
      expect(tree.exists(baselinePath)).toBe(true);
      const baseline = readJson(tree, baselinePath);
      expect(baseline.total).toBe(0);
      expect(baseline.files).toEqual({});
    });

    it('a4c837a2 AC1: puts typecheck-spec in test.dependsOn alongside the workspace defaults', async () => {
      await run(tree);
      const test = readJson(tree, `${root}/project.json`).targets.test;
      expect(test.dependsOn).toEqual(['lint', '^build', 'typecheck-spec']);
    });

    it('a4c837a2 AC2: tsconfig.spec.json compiles vite.config clean (ESM module + allowJs), so the empty baseline is honest', async () => {
      await run(tree);
      const { compilerOptions } = readJson(tree, `${root}/tsconfig.spec.json`);
      expect(compilerOptions.module).toBe('esnext');
      expect(compilerOptions.moduleResolution).toBe('bundler');
      expect(compilerOptions.allowJs).toBe(true);
    });

    it('a4c837a2 AC2: a freshly generated package passes lane-reachability rule 6', async () => {
      await run(tree);
      const fixture = path.join(REPO_TMP, `rule6-${tier(root)}`);
      fs.rmSync(fixture, { recursive: true, force: true });
      for (const change of tree.listChanges()) {
        if (change.type !== 'CREATE' || change.content === null) continue;
        const dest = path.join(fixture, change.path);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, change.content);
      }
      const runChecks = await loadRunChecks();
      const { violations } = await runChecks({
        workspaceRoot: fixture,
        gateTargets: [],
        baseline: { tsconfigSpecWithoutCompileTarget: [] },
      });
      const rule6 = violations.filter((v) => v.rule.startsWith('6-'));
      expect(rule6).toEqual([]);
    });
  });

  it('a4c837a2 AC1: entrypoint scaffolds no tsconfig.spec.json, so no spec gate is emitted (rule 6 N/A)', async () => {
    await entrypointGenerator(tree, { name: 'widget-cli', nxLayer: 'entrypoints', platform: 'node' } as never);
    expect(tree.exists('entrypoint/widget-cli/tsconfig.spec.json')).toBe(false);
    const targets = readJson(tree, 'entrypoint/widget-cli/project.json').targets;
    expect(targets['typecheck-spec']).toBeUndefined();
  });
});

/** Unique fixture dir name per case (the `types` and `base` cases share a root). */
let seq = 0;
function tier(root: string): string {
  return `${path.basename(root)}-${seq++}`;
}
