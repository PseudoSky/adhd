/**
 * paging-wire.e2e.ts — `query`'s pagination contract AT THE WIRE, driven
 * through the REAL BUILT `dist/index.js` as a child process.
 *
 * ## Why this exists alongside `paging.spec.ts`
 *
 * `paging.spec.ts` proves the same contract by calling `queryIssues`
 * in-process, and it was green throughout the entire period in which paging
 * was unreachable for every actual consumer. That is the whole point of this
 * file: the defect lived below the function, in the mount.
 *
 * `IIssueQueryResult`'s `view:'list'` member was written inline as
 * `({ view: 'list' } & IIssuePage)`. The schema extractor that derives every
 * mount's response shape cannot express a TypeScript intersection, so it
 * emitted a bare `{}` for that branch. The runtime encodes each response
 * against the derived schema, and with `{}` in the union the list branch was
 * projected onto a sibling member whose only properties are `view` and
 * `items` — so `hasMore` and `nextCursor` were deleted from every CLI, MCP
 * and HTTP response. The in-process return value was correct the entire
 * time; a caller could never page, because the cursor never reached them.
 *
 * An in-process assertion structurally cannot catch that class of defect.
 * This file therefore never imports the package — it spawns the built bin
 * and reads the bytes a real consumer reads.
 *
 * ## What has teeth here
 *
 * The load-bearing assertions are the PRESENCE of `hasMore` on a terminal
 * page (its value is `false`, the exact case that vanished) and the
 * round-trip of `nextCursor` back in as `after` producing the next page. A
 * test that only asserted on `items` would stay green against the broken
 * encode — `items` survived it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runIsolatedBin } from '../test/helpers/spawn-isolated-bin.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = join(HERE, '..', '..', 'dist', 'index.js');

const PROJECT_NAME = 'paging-wire-project';
/** Deliberately not a multiple of PAGE_SIZE, so the final page is short. */
const ISSUE_COUNT = 7;
const PAGE_SIZE = 3;

let tmpRoot: string;
let dbPath: string;
/** Insertion order of the uids this suite created, oldest first. */
const created: string[] = [];

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawns the REAL built bin. Never imported — an import resolves to source
 * and skips the mount, which is precisely the layer under test.
 */
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

/** Reads the `data` object off a success envelope, failing loudly on an error arm. */
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

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'backlog-paging-wire-'));
  dbPath = join(tmpRoot, 'paging-wire.db');

  okData([
    'upsert-project',
    '--input',
    JSON.stringify({ name: PROJECT_NAME, by: 'paging-wire.spec' }),
  ]);

  for (let i = 0; i < ISSUE_COUNT; i++) {
    const n = String(i).padStart(2, '0');
    const data = okData([
      'create',
      '--input',
      JSON.stringify({
        title: `paging wire issue ${n}`,
        body: `distinct body ${n} for the paging wire suite`,
        project: PROJECT_NAME,
        by: 'paging-wire.spec',
        // These issues are near-identical by construction, which is exactly
        // what the duplicate gate is built to suppress. `force` states that
        // the collision is intended here — it is not a workaround, it is the
        // documented way to file a deliberate sibling.
        duplicateAction: 'force',
      }),
    ]);
    created.push(data['uid'] as string);
  }
  expect(created).toHaveLength(ISSUE_COUNT);
}, 180_000);

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('query pagination at the wire (real built bin)', () => {
  it('a terminal page ENCODES hasMore:false — the field is present, not omitted', () => {
    const data = okData([
      'query',
      '--input',
      JSON.stringify({ view: 'list', limit: 100 }),
    ]);

    // The regression this file exists for: `hasMore` is a required boolean on
    // `IIssuePage`, and it vanished from the encoded response entirely. Assert
    // PRESENCE first — `data['hasMore'] === false` would also be satisfied by
    // `undefined` under a loose comparison, and the whole defect was an absent
    // key, so the key check is the one with teeth.
    expect(Object.keys(data)).toContain('hasMore');
    expect(data['hasMore']).toBe(false);
    // A terminal page carries no cursor at all.
    expect(Object.keys(data)).not.toContain('nextCursor');
    expect((data['items'] as unknown[]).length).toBe(ISSUE_COUNT);
  });

  it('a non-terminal page ENCODES hasMore:true and a usable nextCursor', () => {
    const data = okData([
      'query',
      '--input',
      JSON.stringify({ view: 'list', limit: PAGE_SIZE }),
    ]);

    expect(Object.keys(data)).toContain('hasMore');
    expect(data['hasMore']).toBe(true);
    expect(typeof data['nextCursor']).toBe('string');
    expect((data['nextCursor'] as string).length).toBeGreaterThan(0);
    expect((data['items'] as unknown[]).length).toBe(PAGE_SIZE);
  });

  it('feeding nextCursor back as after walks every issue exactly once, in insertion order', () => {
    const collected: string[] = [];
    let after: string | undefined;
    let pages = 0;

    for (;;) {
      const input: Record<string, unknown> = { view: 'list', limit: PAGE_SIZE };
      if (after !== undefined) input['after'] = after;
      const data = okData(['query', '--input', JSON.stringify(input)]);
      pages++;

      const items = data['items'] as Array<Record<string, unknown>>;
      // A page that reports more to come must be exactly full. The page-count
      // check below passes on an off-by-one that returns short pages and then
      // a full final one; this does not.
      if (data['hasMore'] === true) expect(items).toHaveLength(PAGE_SIZE);
      else expect(items.length).toBeLessThanOrEqual(PAGE_SIZE);

      for (const item of items) collected.push(item['uid'] as string);

      if (data['hasMore'] !== true) {
        expect(Object.keys(data)).not.toContain('nextCursor');
        break;
      }
      after = data['nextCursor'] as string;
      expect(typeof after).toBe('string');

      // Bounded: a cursor that never advances must fail loudly, never hang.
      if (pages > ISSUE_COUNT) {
        throw new Error(
          `paging did not terminate after ${pages} pages — the cursor is not advancing`
        );
      }
    }

    // No gap.
    expect(new Set(collected)).toEqual(new Set(created));
    // No duplicate — a repeat would inflate the array past ISSUE_COUNT while
    // leaving the set the same size.
    expect(collected).toHaveLength(ISSUE_COUNT);
    // Pages were genuinely PAGE_SIZE-sized, so `after` was actually honored
    // rather than silently ignored (which would return everything in one page).
    expect(pages).toBe(Math.ceil(ISSUE_COUNT / PAGE_SIZE));
    // Default ordering is insertion order, all the way through the mount.
    expect(collected).toEqual(created);
  }, 120_000);
});
