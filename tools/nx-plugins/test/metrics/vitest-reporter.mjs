/**
 * vitest-reporter — persists one record per test (and one per run) to the test-metrics store.
 *
 * Attached to every vitest project by `tools/vite-plugins/test-metrics.mjs`, through the plugin every config already
 * installs (`nxViteTsPathsPre`); it runs beside the `default` reporter and changes none of its output.
 *
 * It never changes a run: every hook is wrapped, a write failure is a warning, and results are harvested once in
 * `onTestRunEnd` (via `allTests()`, so skipped and todo tests are included). A cached nx task executes nothing, so it
 * produces no records; that is correct, a cache hit is not an execution (STRATEGY section 7.2).
 *
 * Opt out with ADHD_TEST_METRICS=0.
 */
import { performance } from 'node:perf_hooks';
import { beginRun, nearestProjectName, REPO_ROOT, relFile, runRecord, testRecord } from './context.mjs';
import { appendRecords, storePath } from './store.mjs';
import { resolveTier } from './tiers.mjs';

const OUTCOME = { passed: 'pass', failed: 'fail', skipped: 'skip', pending: 'skip' };

/** Map a vitest TestCase to its outcome: `todo` is a skipped test whose mode is todo. */
export function outcomeOf(testCase) {
  const state = testCase.result().state;
  if (state === 'skipped' && testCase.options?.mode === 'todo') return 'todo';
  return OUTCOME[state] ?? 'skip';
}

export default class TestMetricsReporter {
  /**
   * @param {{ env?: NodeJS.ProcessEnv, store?: string, append?: typeof appendRecords, root?: string, begin?: typeof beginRun, tierOf?: typeof resolveTier, warn?: (m: string) => void }} [opts] injectable for tests
   */
  constructor(opts = {}) {
    this.env = opts.env ?? process.env;
    this.append = opts.append ?? appendRecords;
    this.root = opts.root ?? REPO_ROOT;
    this.begin = opts.begin ?? beginRun;
    this.tierOf = opts.tierOf ?? resolveTier;
    this.warn = opts.warn ?? ((m) => console.warn(m));
    this.storeFile = opts.store ?? storePath(this.env);
    this.runPromise = null;
    this.early = null;
    this.t0 = 0;
    this.hookMs = 0;
  }

  disabled() {
    return this.env.ADHD_TEST_METRICS === '0';
  }

  /** vitest calls this before it collects any test: start the (asynchronous) git lookups as early as possible. */
  onInit() {
    if (this.disabled()) return;
    try {
      this.early = this.begin({ env: this.env, runner: 'vitest' });
      this.early.catch(() => {});
    } catch {
      this.early = null;
    }
  }

  onTestRunStart() {
    if (this.disabled()) return;
    const h0 = performance.now();
    try {
      this.t0 = performance.now();
      // not awaited: the git lookups overlap the test run and are read in onTestRunEnd
      this.runPromise = this.early ?? this.begin({ env: this.env, runner: 'vitest' });
      this.early = null;
      this.runPromise.catch(() => {});
    } catch (err) {
      this.warn(`test-metrics: run start failed: ${err?.message ?? err}`);
    }
    this.hookMs = performance.now() - h0;
  }

  async onTestRunEnd(testModules) {
    if (this.disabled()) return;
    const h0 = performance.now();
    try {
      if (this.runPromise === null) this.onTestRunStart();
      const wallMs = performance.now() - this.t0;
      const run = await this.runPromise;
      const records = [];
      const projects = new Set();
      const tierByFile = new Map();
      for (const mod of testModules) {
        for (const tc of mod.children.allTests()) {
          const abs = mod.moduleId;
          if (!tierByFile.has(abs)) tierByFile.set(abs, this.tierOf(abs));
          const project = tc.project?.name || mod.project?.name || nearestProjectName(abs, this.root);
          projects.add(project);
          const diag = tc.diagnostic();
          records.push(
            testRecord(run, {
              project,
              file: relFile(abs, this.root),
              name: tc.fullName,
              ...tierByFile.get(abs),
              outcome: outcomeOf(tc),
              durationMs: diag?.duration ?? 0,
              retryCount: diag?.retryCount ?? 0,
            }),
          );
        }
      }
      this.hookMs += performance.now() - h0;
      const project = projects.size === 1 ? [...projects][0] : [...projects].join(',');
      records.push(runRecord(run, { project, wallMs, tests: records.length, reporterMs: this.hookMs }));
      await this.append(this.storeFile, records, { warn: this.warn });
    } catch (err) {
      this.warn(`test-metrics: could not record this run: ${err?.message ?? err}`);
    }
  }
}
