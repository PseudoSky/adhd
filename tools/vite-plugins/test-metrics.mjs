import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of the vitest reporter that records test metrics (tools/nx-plugins/test/metrics). */
export const TEST_METRICS_REPORTER = join(dirname(fileURLToPath(import.meta.url)), '../nx-plugins/test/metrics/vitest-reporter.mjs');

/**
 * The vite `config` hook that attaches the test-metrics reporter to a vitest project (G5 and G7 history).
 *
 * Vite merges a plugin's `config` result into the user config and CONCATENATES arrays, so returning
 * `{ test: { reporters: [reporter] } }` appends to a project's own list (`['default']` becomes `['default', reporter]`).
 * A project that sets no `reporters` would lose vitest's default reporter if only the metrics reporter were returned,
 * so `'default'` is added in that case. Only configs with a `test` block are touched (vite builds and storybook have
 * none), and `ADHD_TEST_METRICS=0` turns the hook off. A `--reporter` flag on the command line still replaces the list.
 *
 * @param {{ test?: { reporters?: unknown } }} userConfig the config as seen by the hook
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ test: { reporters: unknown[] } } | undefined}
 */
export function testMetricsConfig(userConfig, env = process.env) {
  if (env.ADHD_TEST_METRICS === '0' || !userConfig || userConfig.test === undefined) return undefined;
  const reporters = userConfig.test.reporters;
  return { test: { reporters: reporters === undefined ? ['default', TEST_METRICS_REPORTER] : [TEST_METRICS_REPORTER] } };
}
