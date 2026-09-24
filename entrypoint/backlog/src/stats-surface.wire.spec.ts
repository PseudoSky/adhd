/**
 * stats-surface.wire.spec.ts — SPEC.md §5's three stats/rollup reads AT THE
 * WIRE, driven through the REAL BUILT `dist/index.js` as a child process —
 * mirroring `query/registry-wire.spec.ts` / `query/paging-wire.spec.ts`'s
 * pattern (see those files' own headers for why an in-process assertion
 * cannot catch this defect class).
 *
 * ## Why this file exists at all, given `stats.ts` is already fully tested
 *
 * `query/views/stats.spec.ts` (real store, differential assertions, negative
 * controls) was green for the ENTIRE period `priorityMatrix`/`partOfRollup`/
 * `openCurve` were unreachable by every actual consumer: `src/api.ts` never
 * imported them, so no transport (CLI, MCP, HTTP) could reach any of the
 * three. That is the exact defect class `registry-wire.spec.ts` documents for
 * the registry views and `paging-wire.spec.ts` documents for
 * `hasMore`/`nextCursor`: the implementation was correct in-process the whole
 * time; the MOUNT was the gap. So the load-bearing assertions here are
 * PRESENCE/`typeof` checks on the FULL result shape (`rows` is an array,
 * `unassigned` is a number, `points[0].existed` exists), not just value
 * comparisons — an absent or wrong-typed key is exactly the shape this defect
 * class takes.
 *
 * The three ops are mounted as `backlog priority-matrix` / `part-of-rollup` /
 * `open-curve` (`BACKLOG_VERBS`, `server.ts`) and `backlog_priority_matrix` /
 * `backlog_part_of_rollup` / `backlog_open_curve` on MCP — this file drives the
 * CLI spelling through the built bin, the same way a caller does.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runIsolatedBin } from './test/helpers/spawn-isolated-bin.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = join(HERE, '..', 'dist', 'index.js');

const PROJECT = 'stats-surface-wire-project';

let tmpRoot: string;
let dbPath: string;

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Spawns the REAL built bin. Never imported — an import resolves to source and skips the mount under test. */
function runBin(args: string[]): Run {
  // `runIsolatedBin` owns the `ADHD_BACKLOG_SCOPE=project` + `HOME=<root>`
  // redirect pair (see test/helpers/spawn-isolated-bin.ts); the explicit DB
  // path is the ONLY var that redirects the store.
  return runIsolatedBin(DIST_INDEX, args, tmpRoot, {
    extraEnv: { ADHD_BACKLOG_DATABASE_PATH: dbPath },
  });
}

function runJson(args: string[]): { run: Run; body: Record<string, unknown> } {
  const run = runBin(args);
  const line = run.stdout.trim().split('\n').filter(Boolean).pop() ?? '';
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(line) as Record<string, unknown>;
  } catch {
    throw new Error(
      `non-JSON stdout for ${args.join(' ')}: ${run.stdout}\n${run.stderr}`
    );
  }
  return { run, body };
}

/** Runs a verb, asserting exit 0 + `ok:true`, returning the `data` object. */
function okData(args: string[]): Record<string, unknown> {
  const { run, body } = runJson(args);
  expect(
    run.status,
    `${args.join(' ')} exited ${String(run.status)}: ${run.stderr}`
  ).toBe(0);
  expect(
    body['ok'],
    `${args.join(' ')} returned an error arm: ${JSON.stringify(body)}`
  ).toBe(true);
  return body['data'] as Record<string, unknown>;
}

let rootUid: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'backlog-stats-wire-'));
  dbPath = join(tmpRoot, 'stats-surface-wire.db');

  // A project must exist before `create` (SPEC.md §3: `create`'s `project` is
  // resolve-only). `upsert-project` also mints the reserved `(root)` component.
  okData([
    'upsert-project',
    '--input',
    JSON.stringify({
      name: PROJECT,
      path: '/repo/stats-surface-wire',
      by: 'stats-surface.wire.spec',
    }),
  ]);

  // Root carries a priority (so `priority-matrix` has a real, non-empty row to
  // encode — the strongest shape check) and stays open.
  const root = okData([
    'create',
    '--input',
    JSON.stringify({
      title: 'stats-wire root (HIGH, open)',
      body: 'root of the part_of rollup',
      project: PROJECT,
      priority: 'HIGH',
      by: 'stats-surface.wire.spec',
      duplicateAction: 'force',
    }),
  ]);
  rootUid = root['uid'] as string;

  // Child carries NO priority (so `priority-matrix`'s `unassigned` is a real,
  // non-zero number) and is a `part_of` descendant of root.
  const child = okData([
    'create',
    '--input',
    JSON.stringify({
      title: 'stats-wire child (open)',
      body: 'transitive descendant of the root',
      project: PROJECT,
      by: 'stats-surface.wire.spec',
      duplicateAction: 'force',
    }),
  ]);
  const childUid = child['uid'] as string;

  // `part_of` is `issue → issue`: the edge is child → parent, so the rollup's
  // incoming-`part_of` walk from root finds the child.
  okData([
    'relate',
    '--input',
    JSON.stringify({
      sourceUid: childUid,
      targetUid: rootUid,
      rel: 'part_of',
      action: 'add',
      by: 'stats-surface.wire.spec',
    }),
  ]);
}, 180_000);

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('SPEC.md §5 stats reads at the wire (real built bin)', () => {
  it('backlog priority-matrix: default-OPEN scope, matrix shape survives encoding', () => {
    const { run, body } = runJson(['priority-matrix', '--input', '{}']);

    // Exit 0 + the success arm — the two things a shell branches on.
    expect(
      run.status,
      `priority-matrix exited ${String(run.status)}: ${run.stderr}`
    ).toBe(0);
    expect(body['ok']).toBe(true);

    const data = body['data'] as Record<string, unknown>;
    // Presence/type checks first (the absent-key defect class).
    expect(data['statusScope']).toBe('open');
    expect(Array.isArray(data['rows'])).toBe(true);
    expect(typeof data['unassigned']).toBe('number');

    // Teeth: the seeded root (HIGH, open) is counted, and the priority-less
    // child is the one unassigned item — so a matrix that encoded to an empty
    // shell would fail here, not pass on `Array.isArray([])` alone.
    const rows = data['rows'] as Array<Record<string, unknown>>;
    const high = rows.find((r) => r['priority'] === 'HIGH');
    expect(high?.['count']).toBe(1);
    expect(data['unassigned']).toBe(1);
  });

  it('backlog part-of-rollup: rooted at the uid, transitive child counted once, open+closed === total', () => {
    const data = okData([
      'part-of-rollup',
      '--input',
      JSON.stringify({ uid: rootUid }),
    ]);

    expect(data['uid']).toBe(rootUid);
    expect(data['childrenTotal']).toBe(1);
    const open = data['childrenOpen'] as number;
    const closed = data['childrenClosed'] as number;
    expect(typeof open).toBe('number');
    expect(typeof closed).toBe('number');
    expect(open + closed).toBe(data['childrenTotal']);
    // The fresh child is open, so it is the actionable half.
    expect(open).toBe(1);
    expect(Array.isArray(data['childrenOpenUids'])).toBe(true);
  });

  it('backlog open-curve: a pre-existence instant reports zero existing issues', () => {
    const data = okData([
      'open-curve',
      '--input',
      JSON.stringify({ at: ['2020-01-01T00:00:00.000Z'] }),
    ]);

    expect(Array.isArray(data['points'])).toBe(true);
    const points = data['points'] as Array<Record<string, unknown>>;
    expect(points).toHaveLength(1);
    // The seeded issues were minted "now" (2026), so at 2020-01-01 nothing
    // existed — the exact `validAt` existence semantics, not a current count.
    expect(points[0]?.['existed']).toBe(0);
    expect(points[0]?.['open']).toBe(0);
    expect(points[0]?.['closed']).toBe(0);
  });
});
