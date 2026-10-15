/**
 * node-test-reporter — the `node --test` counterpart of vitest-reporter: same record shape, same store.
 *
 * Wired next to the spec reporter in the `test:build-tools` lane (root package.json):
 *   node --test --test-reporter=spec --test-reporter-destination=stdout \
 *     --test-reporter=./tools/nx-plugins/test/metrics/node-test-reporter.mjs --test-reporter-destination=stdout ...
 * It yields nothing, so the spec output is unchanged. Suites are not recorded (a suite is not a test); a test's full name
 * is its ancestors' names joined with ' > '. It never throws: a write failure is a warning.
 */
import { performance } from 'node:perf_hooks';
import { beginRun, nearestProjectName, REPO_ROOT, relFile, runRecord, testRecord } from './context.mjs';
import { appendRecords, storePath } from './store.mjs';
import { resolveTier } from './tiers.mjs';

/** The outcome of a `test:pass`/`test:fail` event's data. */
export function outcomeOfEvent(type, data) {
  if (data.todo !== undefined && data.todo !== false) return 'todo';
  if (data.skip !== undefined && data.skip !== false) return 'skip';
  return type === 'test:fail' ? 'fail' : 'pass';
}

/**
 * Consume a node:test event stream and return the records it describes.
 * @param {AsyncIterable<{ type: string, data: any }>} source
 * @param {object|Promise<object>} runOrPromise the run context from beginRun, or the promise of it
 */
export async function collectFromEvents(source, runOrPromise, { root = REPO_ROOT, tierOf = resolveTier, projectOf = nearestProjectName } = {}) {
  const stacks = new Map(); // file -> names by nesting level
  const entries = [];
  const projects = new Set();
  const tierByFile = new Map();
  for await (const { type, data } of source) {
    if (type === 'test:start' && data?.file) {
      const stack = stacks.get(data.file) ?? [];
      stack[data.nesting] = data.name;
      stack.length = data.nesting + 1;
      stacks.set(data.file, stack);
    } else if ((type === 'test:pass' || type === 'test:fail') && data?.file && data.details?.type !== 'suite') {
      const names = [...(stacks.get(data.file) ?? [])];
      names[data.nesting] = data.name;
      const fullName = names.slice(0, data.nesting + 1).filter(Boolean).join(' > ');
      if (!tierByFile.has(data.file)) tierByFile.set(data.file, tierOf(data.file));
      const project = projectOf(data.file, root);
      projects.add(project);
      entries.push({
        project,
        file: relFile(data.file, root),
        name: fullName,
        ...tierByFile.get(data.file),
        outcome: outcomeOfEvent(type, data),
        durationMs: data.details?.duration_ms ?? 0,
        retryCount: 0,
      });
    }
  }
  const run = await runOrPromise; // awaited only now: the git lookups overlapped the whole run
  return { records: entries.map((e) => testRecord(run, e)), projects, run };
}

/** node:test custom reporter (default export). */
export default async function* testMetricsReporter(source, opts = {}) {
  const env = opts.env ?? process.env;
  if (env.ADHD_TEST_METRICS === '0') {
    for await (const _ of source); // drain: the stream must be consumed
    return;
  }
  const h0 = performance.now();
  try {
    const runPromise = (opts.begin ?? beginRun)({ env, runner: 'node-test' });
    runPromise.catch(() => {});
    const t0 = performance.now();
    const { records, projects, run } = await collectFromEvents(source, runPromise, opts);
    const wallMs = performance.now() - t0;
    const project = [...projects].join(',') || '(none)';
    records.push(runRecord(run, { project, wallMs, tests: records.length, reporterMs: performance.now() - h0 - wallMs }));
    await (opts.append ?? appendRecords)(opts.store ?? storePath(env), records, { warn: opts.warn });
  } catch (err) {
    console.warn(`test-metrics: could not record this run: ${err?.message ?? err}`);
  }
}
