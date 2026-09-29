/**
 * CLI help rendering — the shared `formatUsage(routes)` used by every apigen
 * host. Two contracts are pinned here:
 *
 *  1. C8 AC4 — namespaced verbs (a `--use` mount's synthetic op,
 *     `plan.isMount === true`, e.g. `batch action`) and one-token verbs (the
 *     host's own source ops, e.g. `backlog get`) render as DISTINCT, labelled
 *     sections. A renderer that lists both forms identically fails this.
 *  2. Help truthfulness — a command line advertises EXACTLY the flags its
 *     `plan.cliFlags` declares, and the heading/footer make no blanket
 *     "per-field flags are also accepted" claim. The old unconditional footer
 *     was false for every one-token verb whose schema decomposes to a single
 *     `--input '<json>'` envelope (the whole `backlog` CLI): `get --uid X` is
 *     rejected with `Unknown option: --uid. Available: --input`.
 *
 * The routes are constructed directly from their `OpPlan`s — a mount op, a
 * backlog-style verb whose only flag is `--input`, an extracted verb that
 * decomposes into real per-field flags, and a verb with no flags at all.
 */
import { describe, expect, it } from 'vitest';
import type { OpPlan, OpPlanCliFlag } from '@adhd/apigen-engine-runtime';
import { formatUsage, type CliRoute } from '../lib/run';

/** One domain flag, kebab-keyed by its argv name (mirrors `OpPlan.cliFlags`). */
function domainFlag(camelKey: string): OpPlanCliFlag {
  return { camelKey, kind: 'domain', valueKind: 'string' };
}

function flagMap(entries: Record<string, OpPlanCliFlag>): Map<string, OpPlanCliFlag> {
  return new Map(Object.entries(entries));
}

function route(
  cliPath: string[],
  isMount: boolean,
  cliFlags: Map<string, OpPlanCliFlag> = new Map()
): CliRoute {
  return {
    plan: {
      cli: { path: cliPath },
      isMount,
      params: [],
      cliFlags,
    } as unknown as OpPlan,
    dispatch: async () => ({}) as never,
  };
}

// A backlog-style one-token verb: its schema decomposes to the single
// `--input '<json>'` envelope flag (matches the real @adhd/backlog CLI —
// `get --uid X` → "Unknown option: --uid. Available: --input").
const INPUT_ONLY = flagMap({ input: domainFlag('input') });

const HELP = formatUsage(
  new Map<string, CliRoute>([
    ['backlog get', route(['backlog', 'get'], false, INPUT_ONLY)],
    ['backlog query', route(['backlog', 'query'], false, INPUT_ONLY)],
    ['batch action', route(['batch', 'action'], true, INPUT_ONLY)],
  ])
);

describe('C8 AC4 — CLI help distinguishes namespaced verbs from one-token verbs', () => {
  it('names BOTH sections and the calling convention', () => {
    expect(HELP).toContain('Namespaced verbs (namespace + verb):');
    expect(HELP).toContain('Verbs (one-token):');
    // The declared flag itself is advertised on each route's line.
    expect(HELP).toContain('[--input]');
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

describe('help advertises only the flags a route actually declares', () => {
  it('does NOT claim per-field flags are accepted for the --input-only verbs', () => {
    // The exact false claim the unconditional footer used to print, next to a
    // verb (`get`) that rejects every per-field spelling.
    expect(HELP).not.toContain('per-field flags are also accepted');
    expect(HELP).not.toContain("run `<verb> --help` for a verb's own flags");
    // And it advertises exactly the one flag those routes declare, nothing more.
    expect(HELP).toContain('backlog get  [--input]');
    expect(HELP).not.toContain('--uid');
    expect(HELP).not.toContain('--view');
    expect(HELP).not.toContain('--title');
  });

  it('DOES advertise the declared flags of a route that has them (kebab spelling, aliases excluded)', () => {
    const withFlags = formatUsage(
      new Map<string, CliRoute>([
        [
          'harness get-item',
          route(
            ['harness', 'get-item'],
            false,
            flagMap({
              id: domainFlag('id'),
              'include-archived': domainFlag('includeArchived'),
              // The camelCase alias is accepted on input but must never be
              // advertised (BUG-BACKLOG-CLI-FLAG-CASE-MISMATCH-001).
              includeArchived: {
                ...domainFlag('includeArchived'),
                aliasOf: 'include-archived',
              },
            })
          ),
        ],
      ])
    );
    expect(withFlags).toContain(
      'harness get-item  [--id, --include-archived]'
    );
    expect(withFlags).not.toContain('--includeArchived');
  });

  it('marks a route that declares no flags as taking no options', () => {
    const none = formatUsage(
      new Map<string, CliRoute>([
        [
          'harness embedding-status',
          route(['harness', 'embedding-status'], false),
        ],
      ])
    );
    expect(none).toContain('harness embedding-status  (no flags)');
    expect(none).not.toContain('per-field flags');
    expect(none).not.toContain('[--');
  });
});
