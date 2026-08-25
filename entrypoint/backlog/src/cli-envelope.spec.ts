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
 *  1. BUG-BACKLOG-V2-ENVELOPE-DATA-STRIPPED-001 — `IOutcomeEnvelope<T>` is an
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
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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

const REPO = 'envelope-spec-repo';

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'backlog-envelope-'));
  dbPath = join(tmpRoot, 'envelope.db');
  const { run, body } = runJson([
    'create',
    '--input',
    JSON.stringify({
      input: { family: 'BUG', title: 'envelope seam item', body: 'b', repo: REPO },
      by: 'cli-envelope.spec',
      duplicateAction: 'file',
    }),
  ]);
  expect(run.status, `seed create failed: ${run.stderr}`).toBe(0);
  expect(body['ok']).toBe(true);
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
        input: { family: 'BUG', title: 'second item', body: 'b', repo: REPO },
        by: 'cli-envelope.spec',
        duplicateAction: 'file',
      }),
    ]);
    expect(run.status).toBe(0);
    expect(body['ok']).toBe(true);
    // The whole defect: `data` used to be absent entirely.
    const data = body['data'] as Record<string, unknown> | undefined;
    expect(data, 'envelope `data` was stripped by the mount').toBeDefined();
    expect(data?.['humanId']).toBe('BUG-002');
  });

  it('a successful get returns a real card — never a codec envelope', () => {
    const { run, body } = runJson([
      'get',
      '--input',
      JSON.stringify({ humanId: 'BUG-001', repo: REPO }),
    ]);
    expect(run.status).toBe(0);
    const data = body['data'] as Record<string, unknown> | undefined;
    expect(data, 'envelope `data` was stripped by the mount').toBeDefined();
    // `get`'s success arm declares `data: {}` — the schemaless path. The card
    // must arrive as a card, NOT wrapped as {$apigen:'int64', v:'[object Object]'}.
    expect(data).not.toHaveProperty('$apigen');
    expect(data?.['humanId']).toBe('BUG-001');
    expect(data?.['title']).toBe('envelope seam item');
  });

  it('a successful query carries its pagination meta', () => {
    const { run, body } = runJson(['query', '--input', JSON.stringify({ view: 'list', limit: 2 })]);
    expect(run.status).toBe(0);
    // `meta` is declared only on the success arm, so it was stripped too.
    const meta = body['meta'] as Record<string, unknown> | undefined;
    expect(meta, 'envelope `meta` was stripped by the mount').toBeDefined();
    expect(typeof meta?.['total']).toBe('number');
    expect(typeof meta?.['returned']).toBe('number');
  });
});

describe('exit-code contract (INTERFACE_v2 §7.1)', () => {
  it('a reported item_not_found exits 1, not 0', () => {
    const { run, body } = runJson([
      'get',
      '--input',
      JSON.stringify({ humanId: 'BUG-99999', repo: REPO }),
    ]);
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
