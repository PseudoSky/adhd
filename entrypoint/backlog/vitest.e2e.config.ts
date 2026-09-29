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
 * `nx run-many -t e2e`). It collects the resource-heavy `src/**\/*.e2e.ts`
 * suites that were extracted out of the default `test` target — every spawn-a-subprocess /
 * load-the-real-fastembed-model / CPU-or-memory-hog suite — whose cheap
 * `*.spec.ts` stubs stay in the default lane (each stub's header carries a
 * `Resource lane:` tag naming why it was separated).
 *
 * It is the project's own `vite.config.ts` with EXACTLY three overrides:
 * `test.include` narrowed to `*.e2e.ts`, a DISTINCT Vite `cacheDir`, a DISTINCT
 * `test.cache.dir`, and a DISTINCT coverage `reportsDirectory` — so the `test`
 * and `e2e` lanes can never cross-read each other's cache or coverage output.
 *
 * REACHABILITY (RE-WIRED 2026-09-28, backlog-e2e-cache-separation): this lane
 * is reached AT THE GATE, not through `test.dependsOn` — it was removed from
 * there so the heavy lane stops running uncached on every `nx affected -t test`.
 * The gate's target list is canonicalised in `tools/gate/lane-gate.mjs`
 * (`GATE_TARGETS = ['test','e2e']`); `.githooks/pre-push` and both CI workflows
 * derive their `nx affected` targets from it, and `publish` reaches it via the
 * conditional in `tools/nx-plugins/build/plugin.js`. It USED to be deliberately
 * unreachable — `e2e` appeared in no target's `dependsOn` — which made the
 * `.e2e.ts` suites dead config and let e2e regressions report green. The
 * separation that matters (resource-heavy suites, distinct cache/coverage, own
 * config, `cache: true`) is unchanged; do not remove `e2e` from
 * `GATE_TARGETS`.
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
 * need a lane->file map that either duplicates those tags or scrapes stub
 * prose — exactly the kind of machinery that rots silently, so it is
 * deliberately not built. Run a chosen subset with vitest's POSITIONAL file
 * filter (there is NO `--testFiles` flag — passing it errors `CACError: Unknown
 * option \`--testFiles\``; an earlier version of this comment documented a
 * `nx run backlog:e2e --testFiles=…` form that never worked):
 *
 *   npx vitest run --config entrypoint/backlog/vitest.e2e.config.ts \
 *     src/store/vocabulary-guard.e2e.ts
 *
 * ...or derive the file list for a lane from the stubs in the shell:
 *
 *   npx vitest run --config entrypoint/backlog/vitest.e2e.config.ts \
 *     $(rg -l 'Resource lane: cpu' -g '*.spec.ts' entrypoint/backlog/src \
 *       | sed 's/\.spec\.ts$/.e2e.ts/')
 *
 * SERIAL EXECUTION IS LOAD-BEARING: these suites mutate shared on-disk state
 * (`dist/api.ir.json`, `dist/api.d.ts`, the built bin), so running them
 * concurrently races and flakes the whole lane. The base config's
 * `fileParallelism: false` was not sufficient on Vitest 4's fork pool;
 * `maxWorkers: 1` (set in THIS config's `test` block below) pins one worker
 * and makes the lane deterministic.
 */
const e2eConfig = mergeConfig(
  baseConfig,
  defineConfig({
    // Distinct from the default lane's `…/node_modules/.vite/entrypoint/backlog`.
    cacheDir: `${projectCacheDir(__dirname)}-e2e`,
    test: {
      include: ['src/**/*.e2e.ts'],
      // SERIAL, and only this lane: the base config's `fileParallelism: false`
      // is not honoured across Vitest 4's fork pool, so these suites were
      // running CONCURRENTLY and racing on shared on-disk state (dist/api.ir.json,
      // dist/api.d.ts, the built bin). `maxWorkers: 1` pins one worker and makes
      // the lane deterministic (measured: flaky -> 271/271 green). Scoped to
      // THIS config on purpose — forcing it onto the default spec lane exposed
      // an unrelated latent spec-isolation leak, so the default lane keeps its
      // own concurrency.
      maxWorkers: 1,
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
