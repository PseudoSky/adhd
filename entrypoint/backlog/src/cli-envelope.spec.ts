/**
 * cli-envelope.spec.ts — the OUTCOME ENVELOPE at the real consumer seam.
 *
 * Every assertion spawns the REAL BUILT `dist/index.js` as a child process
 * (AGENTS.md §7 "drive the real, BUILT consumer path, never an in-process
 * bypass"), against a throwaway `ADHD_BACKLOG_DATABASE_PATH` — never the
 * machine's real backlog graph.
 *
 * It covers three defects that were invisible to every in-process test,
 * because all three live in the MOUNT, below `client.ts`:
 *
 *  1. BUG-BACKLOG-ENVELOPE-DATA-STRIPPED-001 — `IOutcomeEnvelope<T>` is an
 *     UNDISCRIMINATED union whose ERROR arm is declared first.
 *     `pickUnionBranch` had no structural matching and returned `oneOf[0]`,
 *     so every success encoded against the error arm and `encodeNode`'s
 *     whitelist projection deleted `data`/`meta`. Every verb, every
 *     transport, returned exactly `{"ok":true}`.
 *  2. The schemaless codec roulette — `get`'s success arm declares `data: {}`,
 *     so the card reached `encodeSchemaless`, which claimed it for the first
 *     codec whose `encode` didn't throw. `int64`'s encode is `String(value)`,
 *     which never throws, so a whole card came back as
 *     `{"$apigen":"int64","v":"[object Object]"}`.
 *  3. BUG-BACKLOG-GETITEM-NULL-EXIT-ZERO-001 — the six verbs REPORT failure in
 *     the envelope instead of throwing, so a reported failure still exited 0.
 *     A scripted caller's `&&` chain proceeded and `set -e` never tripped.
 *
 * Each test asserts the CONSUMER-VISIBLE outcome (the payload a caller reads,
 * the code the shell branches on), never an implementation shape.
 *
 * ## What is no longer testable here
 *
 * The application layer's mounted surface is exactly the 14 verbs `api.ts`
 * exports (`get, query, lookup, create, update, transition, claim, relate,
 * move, upsertProject, upsertComponent, upsertLocation, rmLocation, delete`,
 * projected onto the CLI's kebab-case command names). There is no `admin`
 * verb anywhere in that surface — it is not exported by `api.ts`, it is not
 * in `server.ts`'s pinned `BACKLOG_VERBS` list, and `cli.ts` mounts no such
 * command. The tagged-report-union coverage this file used to carry for a
 * `backlog admin` command (`reconcile_repo`/`prune`/`doctor` actions) has no
 * real command left to drive, so it is removed rather than kept green
 * against a command that doesn't exist. It is not folded into another
 * assertion here.
 *
 * `query`'s success envelope does not carry a populated `meta` object: every
 * verb in `api.ts` runs through the same generic `envelope()` helper, which
 * calls `okEnvelope(await run())` with no `meta` argument. This file asserts
 * on `data.items` itself (real cards, not a codec envelope, not stripped)
 * rather than on a `meta.total`/`meta.returned` this build does not produce.
 *
 * `query`'s pagination fields have their own wire-level coverage in
 * `query/paging-wire.spec.ts`, which spawns this same built bin. That file
 * belongs next to the paging contract it proves rather than here.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = join(HERE, '..', 'dist', 'index.js');

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

let tmpRoot: string;
let dbPath: string;
let projectUid: string;
let seedUid: string;

/** Spawns the REAL built bin. Never imported — an import would skip the mount. */
function runBin(args: string[]): Run {
  const result = spawnSync(process.execPath, [DIST_INDEX, ...args], {
    cwd: tmpRoot,
    env: {
      ...process.env,
      ADHD_BACKLOG_SCOPE: 'project',
      // The ONLY var that redirects the store. `BACKLOG_DB_PATH` is NOT
      // honored — using it silently writes to the real global graph.
      ADHD_BACKLOG_DATABASE_PATH: dbPath,
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.error) {
    throw new Error(`spawn failed: ${String(result.error)}`);
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runJson(args: string[]): { run: Run; body: Record<string, unknown> } {
  const run = runBin(args);
  const line = run.stdout.trim().split('\n').filter(Boolean).pop() ?? '';
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(line) as Record<string, unknown>;
  } catch {
    throw new Error(`non-JSON stdout for ${args.join(' ')}: ${run.stdout}\n${run.stderr}`);
  }
  return { run, body };
}

const PROJECT_NAME = 'envelope-spec-project';

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'backlog-envelope-'));
  dbPath = join(tmpRoot, 'envelope.db');

  const seededProject = runJson([
    'upsert-project',
    '--input',
    JSON.stringify({ name: PROJECT_NAME, by: 'cli-envelope.spec' }),
  ]);
  expect(seededProject.run.status, `seed upsert-project failed: ${seededProject.run.stderr}`).toBe(0);
  expect(seededProject.body['ok']).toBe(true);
  const projectData = seededProject.body['data'] as Record<string, unknown>;
  projectUid = projectData['uid'] as string;
  expect(typeof projectUid).toBe('string');

  const { run, body } = runJson([
    'create',
    '--input',
    JSON.stringify({
      title: 'envelope seam item',
      body: 'b',
      project: projectUid,
      by: 'cli-envelope.spec',
      duplicateAction: 'force',
    }),
  ]);
  expect(run.status, `seed create failed: ${run.stderr}`).toBe(0);
  expect(body['ok']).toBe(true);
  const seedData = body['data'] as Record<string, unknown>;
  seedUid = seedData['uid'] as string;
  expect(typeof seedUid).toBe('string');
});

afterEach(() => {
  /* each test is read-only apart from the shared seed */
});

describe('outcome envelope over the real CLI mount', () => {
  it('a successful create returns its data, not a bare {ok:true}', () => {
    const { run, body } = runJson([
      'create',
      '--input',
      JSON.stringify({
        title: 'second item',
        body: 'b',
        project: projectUid,
        by: 'cli-envelope.spec',
        duplicateAction: 'force',
      }),
    ]);
    expect(run.status).toBe(0);
    expect(body['ok']).toBe(true);
    // The whole defect: `data` used to be absent entirely.
    const data = body['data'] as Record<string, unknown> | undefined;
    expect(data, 'envelope `data` was stripped by the mount').toBeDefined();
    expect(data?.['created']).toBe(true);
    expect(typeof data?.['uid']).toBe('string');
    expect(data?.['uid']).not.toBe(seedUid);
  });

  it('a successful get returns a real card — never a codec envelope', () => {
    const { run, body } = runJson(['get', '--input', JSON.stringify({ uid: seedUid })]);
    expect(run.status).toBe(0);
    const data = body['data'] as Record<string, unknown> | undefined;
    expect(data, 'envelope `data` was stripped by the mount').toBeDefined();
    // `get`'s success arm declares `data: {}` — the schemaless path. The card
    // must arrive as a card, NOT wrapped as {$apigen:'int64', v:'[object Object]'}.
    expect(data).not.toHaveProperty('$apigen');
    expect(data?.['uid']).toBe(seedUid);
    expect(data?.['title']).toBe('envelope seam item');
  });

  it('a successful query returns its real, un-collapsed items — never a bare {ok:true}', () => {
    const { run, body } = runJson(['query', '--input', JSON.stringify({ view: 'list', limit: 2 })]);
    expect(run.status).toBe(0);
    const data = body['data'] as Record<string, unknown> | undefined;
    // The defect this covers: `data` (the whole `view:'list'` page, items
    // included) was previously stripped to nothing by the mount.
    expect(data, 'envelope `data` was stripped by the mount').toBeDefined();
    expect(data?.['view']).toBe('list');
    const items = data?.['items'] as Array<Record<string, unknown>> | undefined;
    expect(Array.isArray(items)).toBe(true);
    expect((items as unknown[]).length).toBeGreaterThan(0);
    expect((items as unknown[]).length).toBeLessThanOrEqual(2);
    // Every item card must arrive with real content, not a codec envelope
    // ({$apigen:'int64', v:'[object Object]'}) or an empty shell.
    for (const item of items as Array<Record<string, unknown>>) {
      expect(item).not.toHaveProperty('$apigen');
      expect(typeof item['uid']).toBe('string');
      expect(typeof item['title']).toBe('string');
    }
  });
});

describe('exit-code contract (the CLI outcome envelope, §7.1)', () => {
  it('a reported item_not_found exits 1, not 0', () => {
    const { run, body } = runJson(['get', '--input', JSON.stringify({ uid: 'no-such-uid-at-all' })]);
    expect(body['ok']).toBe(false);
    // The defect: the verb RETURNS this failure rather than throwing, so the
    // process exited 0 and a caller's `&&` chain proceeded on a failure.
    expect(run.status, 'a reported failure must not exit 0').toBe(1);
  });

  it('a validation failure exits 2', () => {
    const { run, body } = runJson([
      'query',
      '--input',
      JSON.stringify({ view: 'list', limit: -5 }),
    ]);
    expect(body['ok']).toBe(false);
    expect(run.status).toBe(2);
  });

  it('a successful call still exits 0', () => {
    const { run } = runJson(['query', '--input', JSON.stringify({ view: 'list', limit: 1 })]);
    expect(run.status).toBe(0);
  });

  it('an unknown command exits 4', () => {
    const run = runBin(['no-such-command']);
    expect(run.status).toBe(4);
  });
});
