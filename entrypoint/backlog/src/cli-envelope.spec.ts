/**
 * cli-envelope.spec.ts — the OUTCOME ENVELOPE at the real consumer seam.
 *
 * Every assertion spawns the REAL BUILT `dist/index.js` as a child process
 * (AGENTS.md §7 "drive the real, BUILT consumer path, never an in-process
 * bypass"), against a throwaway `ADHD_BACKLOG_DATABASE_PATH` and a `HOME`
 * redirected into the same throwaway root — never the machine's real backlog
 * graph and never its real `~/.adhd/backlog/production/config.yaml` (the
 * global config layer is read regardless of `ADHD_BACKLOG_SCOPE`, so pinning
 * the DB path alone still left the machine's global config visible).
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runIsolatedBin } from './test/helpers/spawn-isolated-bin.js';

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
  return runIsolatedBin(DIST_INDEX, args, tmpRoot, {
    // The ONLY var that redirects the store. `BACKLOG_DB_PATH` is NOT honored
    // — using it silently writes to the real global graph.
    extraEnv: { ADHD_BACKLOG_DATABASE_PATH: dbPath },
  });
}

function runJson(args: string[]): { run: Run; body: Record<string, unknown> } {
  const run = runBin(args);
  const line = run.stdout.trim().split('\n').filter(Boolean).pop() ?? '';
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(line) as Record<string, unknown>;
  } catch {
    throw new Error(
      `non-JSON stdout for ${args.join(' ')}: ${run.stdout}\n${run.stderr}`
    );
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
      item: {
        family: 'BUG',
        title: 'envelope seam item',
        body: 'b',
        repo: REPO,
      },
      by: 'cli-envelope.spec',
      duplicateAction: 'file',
    }),
  ]);
  expect(run.status, `seed create failed: ${run.stderr}`).toBe(0);
  expect(body['ok']).toBe(true);
});

// The `beforeAll` temp root (and its `envelope.db`) is SHARED by every test
// in this file — the seed is written once and each test is read-only against
// it — so it must be removed ONCE at the end. A per-test `afterEach` would
// delete the seed out from under the following tests; the old suite-level
// `afterEach` was a no-op and leaked this root instead (PR #10 review finding
// `40d9da12`).
afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe('outcome envelope over the real CLI mount', () => {
  it('a successful create returns its data, not a bare {ok:true}', () => {
    const { run, body } = runJson([
      'create',
      '--input',
      JSON.stringify({
        item: { family: 'BUG', title: 'second item', body: 'b', repo: REPO },
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
    const { run, body } = runJson([
      'query',
      '--input',
      JSON.stringify({ view: 'list', limit: 2 }),
    ]);
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
    const { run } = runJson([
      'query',
      '--input',
      JSON.stringify({ view: 'list', limit: 1 }),
    ]);
    expect(run.status).toBe(0);
  });

  it('an unknown command exits 4', () => {
    const run = runBin(['no-such-command']);
    expect(run.status).toBe(4);
  });
});

// ── BUG-BACKLOG-RECONCILE-REPO-EMPTY-REPORT-001 / BUG-APIGEN-RUNMODE-
// DISCRIMINATOR-DEREF-001 ──────────────────────────────────────────────────
//
// `backlog_admin`'s `IAdminResult` is a DISCRIMINATED union tagged by
// `action`, with a `discriminator.mapping` naming each branch by `$ref`. But
// `server.ts`'s `dereferenceSchema` (required so run-mode dispatch can work
// at all — `apigen-base-logical`'s transcoder throws on any unresolved `$ref`)
// inlines every `$ref` before the schema reaches the transcoder, so no branch
// carries a `$ref` any more and the mapping-based match silently no-ops.
// Falling through to structural scoring then ties every branch sharing the
// same property NAMES (`action`, `report`) — which is EVERY action here
// except `export`/`render`/`version` — and the tie-break ("earliest declared
// branch") always won as `doctor` (`oneOf[0]`), so every OTHER `{action,
// report}`-shaped action's real report was silently re-encoded as `{}`.
//
// This block proves the fix at the real MOUNT boundary (the built CLI
// subprocess) — never in-process, which cannot see this class of bug at all
// (`v2/admin.spec.ts`'s in-process `reconcile_repo` test passed throughout).
describe('backlog_admin tagged report union over the real CLI mount (BUG-BACKLOG-RECONCILE-REPO-EMPTY-REPORT-001)', () => {
  const RECONCILE_REPO = 'reconcile-spec-legacy-repo';

  beforeAll(() => {
    const { run, body } = runJson([
      'create',
      '--input',
      JSON.stringify({
        item: {
          family: 'BUG',
          title: 'reconcile seed item',
          body: 'b',
          repo: RECONCILE_REPO,
        },
        by: 'cli-envelope.spec',
      }),
    ]);
    expect(run.status, `reconcile seed create failed: ${run.stderr}`).toBe(0);
    expect(body['ok']).toBe(true);
  });

  it("reconcile_repo's report carries fromRepo/toRepo/dryRun/plan — not {}", () => {
    const { run, body } = runJson([
      'admin',
      '--input',
      JSON.stringify({
        action: 'reconcile_repo',
        params: { from: RECONCILE_REPO, to: REPO },
      }),
    ]);
    expect(run.status).toBe(0);
    expect(body['ok']).toBe(true);
    const data = body['data'] as Record<string, unknown> | undefined;
    expect(data?.['action']).toBe('reconcile_repo');
    const report = data?.['report'] as Record<string, unknown> | undefined;
    // The whole defect: `report` used to arrive as `{}`.
    expect(
      report,
      'reconcile_repo report was collapsed to {} by the mount'
    ).toBeDefined();
    expect(report?.['fromRepo']).toBe(RECONCILE_REPO);
    expect(report?.['toRepo']).toBe(REPO);
    expect(report?.['dryRun']).toBe(true);
    const plan = report?.['plan'] as Record<string, unknown> | undefined;
    expect(
      plan,
      'reconcile_repo report.plan was dropped by the mount'
    ).toBeDefined();
    expect(plan?.['fromRepo']).toBe(RECONCILE_REPO);
    expect(plan?.['toRepo']).toBe(REPO);
    expect(Array.isArray(plan?.['items'])).toBe(true);
    expect((plan?.['items'] as unknown[]).length).toBeGreaterThan(0);
  });

  it('a sibling action with the SAME {action,report} shape (prune) is also no longer collapsed', () => {
    // Proves the fix is general (fixes the discriminator, not a backlog-
    // specific reconcile_repo special-case) — `prune` shares `doctor`'s exact
    // property names and was silently re-encoded as `doctor`'s report too.
    const { run, body } = runJson([
      'admin',
      '--input',
      JSON.stringify({ action: 'prune', params: {} }),
    ]);
    expect(run.status).toBe(0);
    const data = body['data'] as Record<string, unknown> | undefined;
    expect(data?.['action']).toBe('prune');
    const report = data?.['report'] as Record<string, unknown> | undefined;
    expect(
      report,
      'prune report was collapsed to {} by the mount'
    ).toBeDefined();
    // `IPruneReport` has no `scannedItems`/`checks` (doctor's fields) — a
    // report silently re-encoded as doctor's would come back as `{}` since
    // prune's actual value has none of doctor's declared property names.
    expect(report?.['dryRun']).toBe(true);
    expect(Array.isArray(report?.['candidates'])).toBe(true);
  });

  it("doctor's own report (branch 0 — the accidental tie-break winner) is unaffected", () => {
    const { run, body } = runJson([
      'admin',
      '--input',
      JSON.stringify({ action: 'doctor', params: {} }),
    ]);
    expect(run.status).toBe(0);
    const data = body['data'] as Record<string, unknown> | undefined;
    expect(data?.['action']).toBe('doctor');
    const report = data?.['report'] as Record<string, unknown> | undefined;
    expect(typeof report?.['scannedItems']).toBe('number');
    expect(Array.isArray(report?.['checks'])).toBe(true);
  });
});
