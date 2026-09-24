/// <reference types='vitest' />
import * as path from 'path';
import { defineConfig, mergeConfig, type UserConfig } from 'vitest/config';
import {
  projectCacheDir,
  projectCoverage,
} from '../../packages/workspace/workspace-base-vite-paths/src/index';
import baseConfig from './vite.config';

const repoRoot = path.resolve(__dirname, '../..');

/**
 * The on-demand E2E lane for `@adhd/backlog`.
 *
 * Imported ONLY by the `e2e` target in `project.json` (`nx run backlog:e2e` /
 * `nx run-many -t e2e`). It collects the 33 `src/**\/*.e2e.ts` suites that were
 * extracted out of the default `test` target — every spawn-a-subprocess /
 * load-the-real-fastembed-model / CPU-or-memory-hog suite — whose cheap
 * `*.spec.ts` stubs stay in the default lane (each stub's header carries a
 * `Resource lane:` tag naming why it was separated).
 *
 * It is the project's own `vite.config.ts` with EXACTLY three overrides:
 * `test.include` narrowed to `*.e2e.ts`, a DISTINCT Vite `cacheDir`, a DISTINCT
 * `test.cache.dir`, and a DISTINCT coverage `reportsDirectory` — so the `test`
 * and `e2e` lanes can never cross-read each other's cache or coverage output.
 *
 * REACHABILITY GUARD: this target is deliberately unreachable from `affected`
 * and from a bare `nx run backlog:test`. `e2e` appears in NO target's
 * `dependsOn` and is absent from `nx.json` `targetDefaults`, so only an
 * explicit invocation runs it. Never add it to `test.dependsOn`.
 *
 * TARGET NAME (backlog-e2e-separation review): the lane KEEPS the name `e2e`
 * for repo-wide consistency with the 12 sibling apigen packages that name the
 * identical resource lane `e2e` across 5 branches; renaming only backlog would
 * split one concept into two names. This is also the name `nx.json`'s
 * @nx/cypress/plugin reserves (`targetName: "e2e"`) — a LATENT collision
 * accepted and documented: no cypress project exists today, and a global
 * `nx.json` `targetDefaults.e2e` must NEVER be added, because `targetDefaults`
 * is keyed by target name only (no project filter) and so cannot be scoped to
 * this project; every default here lives inline in `project.json` instead.
 *
 * LANE SELECTION — why there is no `BACKLOG_E2E_LANE` env var here:
 * the `Resource lane:` tags (proc|embed|cpu|mem|disk|io) live in the sibling
 * `*.spec.ts` STUB doc-comments, NOT in any test NAME, so vitest's
 * `--testNamePattern` cannot select them; and narrowing `include` by lane would
 * need a lane->file map that either duplicates those 33 tags or scrapes stub
 * prose — exactly the kind of machinery that rots silently, so it is
 * deliberately not built. Run a chosen subset through the executor's own
 * `testFiles` filter instead, e.g.
 *
 *   nx run backlog:e2e --testFiles=src/store/vocabulary-guard.e2e.ts
 *   npx vitest run --config entrypoint/backlog/vitest.e2e.config.ts \
 *     src/store/vocabulary-guard.e2e.ts
 *
 * ...or derive the file list for a lane from the stubs in the shell:
 *
 *   nx run backlog:e2e --testFiles="$(rg -l 'Resource lane: cpu' \
 *     -g '*.spec.ts' entrypoint/backlog/src | sed 's/\.spec\.ts$/.e2e.ts/')"
 */
const e2eConfig = mergeConfig(
  baseConfig,
  defineConfig({
    // Distinct from the default lane's `…/node_modules/.vite/entrypoint/backlog`.
    cacheDir: `${projectCacheDir(__dirname)}-e2e`,
    test: {
      include: ['src/**/*.e2e.ts'],
      // Distinct from the default lane's shared `…/node_modules/.vitest`.
      cache: { dir: path.join(repoRoot, 'node_modules/.vitest-e2e') },
      // Distinct from the default lane's `…/coverage/entrypoint/backlog`.
      coverage: { reportsDirectory: `${projectCoverage(__dirname)}-e2e` },
    },
  })
) as UserConfig;

// Vite's `mergeConfig` CONCATENATES arrays
// (`mergeConfigRecursively`: `[...existing, ...value]` — verified against
// node_modules/vite), so the base config's `include: ['src/**/*.spec.ts']`
// would survive the merge and this lane would ALSO collect every default-lane
// spec. Force a REPLACE of the single array we override.
(e2eConfig.test as { include: string[] }).include = ['src/**/*.e2e.ts'];

export default e2eConfig;
