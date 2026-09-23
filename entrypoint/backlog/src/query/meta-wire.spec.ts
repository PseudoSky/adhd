/**
 * meta-wire.spec.ts — `query`'s `meta` contract AT THE WIRE, driven through
 * the REAL BUILT `dist/index.js` as a child process.
 *
 * ## Why this exists alongside `meta.spec.ts`
 *
 * `envelope.ts`'s `IOutcomeSuccess.meta` sits on the SAME generic envelope
 * shape family that `paging-wire.spec.ts` exists because of: `IIssueListResult`
 * had to be declared as an `interface extends IIssuePage` rather than an
 * inline intersection, because the schema extractor that derives every
 * mount's response shape cannot express a TypeScript intersection and
 * silently emitted `{}` for that union member — which deleted `hasMore`/
 * `nextCursor` from every encoded response while the in-process return value
 * stayed correct throughout. `meta` is exactly as exposed to that same class
 * of defect: an in-process assertion on `queryIssuesWithMeta`'s return value
 * cannot prove the field survives the mount's schema-derived encoder. This
 * file never imports the package — it spawns the built bin and reads the
 * bytes a real consumer reads.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runIsolatedBin } from '../test/helpers/spawn-isolated-bin.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = join(HERE, '..', '..', 'dist', 'index.js');

const PROJECT_NAME = 'meta-wire-project';
const ISSUE_COUNT = 6;

let tmpRoot: string;
let dbPath: string;

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Spawns the REAL built bin — never imported, which would resolve to source and skip the mount under test. */
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

/** Returns the WHOLE envelope body — `meta` sits beside `data`, so a helper that only returns `data` (like `paging-wire.spec.ts`'s `okData`) cannot see it. */
function okEnvelopeBody(args: string[]): Record<string, unknown> {
  const { run, body } = runJson(args);
  expect(
    run.status,
    `${args.join(' ')} exited ${String(run.status)}: ${run.stderr}`
  ).toBe(0);
  expect(
    body['ok'],
    `${args.join(' ')} returned an error arm: ${JSON.stringify(body)}`
  ).toBe(true);
  return body;
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'backlog-meta-wire-'));
  dbPath = join(tmpRoot, 'meta-wire.db');

  const projectBody = okEnvelopeBody([
    'upsert-project',
    '--input',
    JSON.stringify({ name: PROJECT_NAME, by: 'meta-wire.spec' }),
  ]);
  expect(projectBody['ok']).toBe(true);

  for (let i = 0; i < ISSUE_COUNT; i++) {
    const n = String(i).padStart(2, '0');
    okEnvelopeBody([
      'create',
      '--input',
      JSON.stringify({
        title: `meta wire issue ${n}`,
        body: `distinct body ${n} for the meta wire suite`,
        project: PROJECT_NAME,
        by: 'meta-wire.spec',
        duplicateAction: 'force',
      }),
    ]);
  }
}, 180_000);

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('query meta at the wire (real built bin)', () => {
  it('a list-shaped read ENCODES meta as a sibling of data, with every field present', () => {
    const body = okEnvelopeBody([
      'query',
      '--input',
      JSON.stringify({ view: 'list', limit: ISSUE_COUNT - 2 }),
    ]);

    // Presence FIRST, one key at a time — the whole defect class this file
    // exists for is an ABSENT key (the response encoder deletes a field it
    // cannot express against the derived schema; that is exactly how
    // `hasMore`/`nextCursor` were silently dropped for the entire pagination
    // outage `paging-wire.spec.ts` documents). A value comparison alone
    // (`body.meta.total === N`) passes on `undefined` read loosely and would
    // have stayed green through that exact outage — so every assertion below
    // checks `Object.keys(...)` BEFORE it ever reads a value.
    expect(Object.keys(body)).toContain('meta');
    const meta = body['meta'] as Record<string, unknown>;
    const metaKeys = Object.keys(meta);
    expect(metaKeys).toContain('total');
    expect(metaKeys).toContain('returned');
    expect(metaKeys).toContain('limit');
    // Not clamped by anything other than the caller's own limit here — the
    // key itself must be ABSENT (`meta?: IQueryEnvelopeMeta`'s `truncated` is
    // optional and never emitted as `truncated: undefined`), not merely
    // read as `undefined`.
    expect(metaKeys).not.toContain('truncated');

    expect(meta['total']).toBe(ISSUE_COUNT);
    expect(meta['returned']).toBe(ISSUE_COUNT - 2);
    expect(meta['limit']).toBe(ISSUE_COUNT - 2);
  });

  it('meta.offset key is present and correct when the caller pages by offset', () => {
    const body = okEnvelopeBody([
      'query',
      '--input',
      JSON.stringify({ view: 'list', limit: 2, offset: 3 }),
    ]);

    expect(Object.keys(body)).toContain('meta');
    const meta = body['meta'] as Record<string, unknown>;
    const metaKeys = Object.keys(meta);
    expect(metaKeys).toContain('offset');
    expect(meta['offset']).toBe(3);
    expect(meta['total']).toBe(ISSUE_COUNT);
    expect(meta['returned']).toBe(2);
  });

  it('a non-list-shaped view (view:"graph") ENCODES no meta key at all', () => {
    const body = okEnvelopeBody([
      'query',
      '--input',
      JSON.stringify({ view: 'graph' }),
    ]);
    expect(Object.keys(body)).not.toContain('meta');
  });
});
