/**
 * C8 AC4 — the CLI help renders namespaced verbs and one-token verbs as
 * DISTINCT, labelled sections (a renderer that lists both forms identically
 * fails this).
 *
 * The renderer (`formatUsage`) is shared by every apigen CLI host, so the test
 * constructs the two route shapes directly from their `OpPlan`s: a MOUNT
 * plugin's synthetic op (`plan.isMount === true`, e.g. `batch action`) and the
 * host package's own source ops (`plan.isMount === false`, e.g. `backlog get`).
 * It asserts the section headings are present AND that each command lands
 * under the correct heading — the negative control is a renderer that emits
 * one undifferentiated list, where `batch action` is not bracketed by the
 * namespaced heading.
 */
import { describe, expect, it } from 'vitest';
import type { OpPlan } from '@adhd/apigen-engine-runtime';
import { formatUsage, type CliRoute } from '../lib/run';

function route(cliPath: string[], isMount: boolean): CliRoute {
  return {
    plan: { cli: { path: cliPath }, isMount, params: [] } as unknown as OpPlan,
    dispatch: async () => ({}) as never,
  };
}

const HELP = formatUsage(
  new Map<string, CliRoute>([
    ['backlog get', route(['backlog', 'get'], false)],
    ['backlog query', route(['backlog', 'query'], false)],
    ['batch action', route(['batch', 'action'], true)],
  ])
);

describe('C8 AC4 — CLI help distinguishes namespaced verbs from one-token verbs', () => {
  it('names BOTH sections and the calling convention', () => {
    expect(HELP).toContain(
      'Namespaced verbs (namespace + verb, per-field flags):'
    );
    expect(HELP).toContain('Verbs (one-token, --input JSON envelope):');
    expect(HELP).toContain('--input');
  });

  it('lists the mount op under the namespaced heading and the one-token verbs under theirs', () => {
    const namespacedAt = HELP.indexOf('Namespaced verbs');
    const verbsAt = HELP.indexOf('Verbs (one-token');
    expect(namespacedAt).toBeGreaterThanOrEqual(0);
    expect(verbsAt).toBeGreaterThan(namespacedAt);

    const batchAt = HELP.indexOf('batch action');
    expect(batchAt).toBeGreaterThan(namespacedAt);
    expect(batchAt).toBeLessThan(verbsAt);

    const getAt = HELP.indexOf('backlog get');
    expect(getAt).toBeGreaterThan(verbsAt);
  });
});
