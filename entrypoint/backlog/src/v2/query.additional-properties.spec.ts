/**
 * End-to-end regression test for BUG-BACKLOG-QUERY-001.
 *
 * Root cause was upstream in `@adhd/apigen-core-client`'s Path-2 schema
 * fallback (`schema-builders/morph-walk.ts`'s `walkType`), NOT in this
 * package's own `backlogQuery`/`assertKnownQueryKeys` logic (which was
 * already correct but unreachable — the offending key had already been
 * silently stripped by apigen's decode layer before `backlogQuery` ever ran).
 * See `packages/apigen/apigen-core-client/src/test/additional-properties.spec.ts`
 * for the schema-level regression proof; this file proves the fix at the
 * ACTUAL consumer seam — the real, built `backlog` CLI bin, spawned as a
 * genuine child process (per AGENTS.md "Proving an MCP server/CLI works —
 * drive the real tools, never a bypass"; mirrors `cli.spec.ts`'s `runBin()`
 * pattern).
 *
 * Before the fix: `backlog query --input '{"grep":"x"}'` (mis-nested — the
 * correct shape is `{"filter":{"grep":"x"}}`) silently accepted the unknown
 * top-level `grep` key, dropped it during decode, and returned `ok:true`
 * with the ENTIRE unfiltered result set — masquerading as a successful,
 * scoped search.
 *
 * After the fix: the same call now fails validation (`ok:false`,
 * `invalid_argument`, exit code 2) BEFORE `backlogQuery` is ever invoked,
 * naming the offending `grep` key. The correctly-nested `filter.grep`/
 * `filter.repo` forms are asserted to keep working and to genuinely scope
 * results — the actual, no-longer-masked positive behavior BUG-BACKLOG-
 * QUERY-001 was filed against.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createItem } from '../ops-v1.js';
import { buildBacklogEnv } from '../env.js';
import {
  openGraphBacklogStore,
  closeGraphBacklogStore,
} from '../store/graph-backlog-store.js';
import { runIsolatedBin } from '../test/helpers/spawn-isolated-bin.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = join(HERE, '..', '..', 'dist', 'index.js');

interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Spawns the REAL built `backlog` bin as a genuine child process. Never imported. */
function runBin(args: string[], cwd: string): SpawnResult {
  // `runIsolatedBin` owns the `ADHD_BACKLOG_SCOPE=project` + `HOME=<root>`
  // redirect pair (see test/helpers/spawn-isolated-bin.ts).
  return runIsolatedBin(DIST_INDEX, args, cwd);
}

describe('BUG-BACKLOG-QUERY-001: mis-nested top-level query keys are rejected, not silently dropped', () => {
  let adhdRoot: string;

  afterEach(() => {
    if (adhdRoot) rmSync(adhdRoot, { recursive: true, force: true });
  });

  it('a mis-nested top-level "grep" key is now REJECTED with invalid_argument (exit 2), not silently ignored', async () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-query-addlprops-'));
    const repo = 'PseudoSky/query-addlprops-test';

    const seedEnv = buildBacklogEnv({
      scope: 'project',
      cwd: adhdRoot,
      adhdRoot,
    });
    seedEnv.ensureDirs();
    const seedStore = await openGraphBacklogStore(seedEnv.files.db);
    await createItem(
      { store: seedStore, env: seedEnv },
      {
        family: 'BUG-ADDLPROPS',
        title: 'unrelated seeded item',
        body: 'x',
        repo,
      }
    );
    await closeGraphBacklogStore(seedStore);

    // Deliberately mis-nested: `grep` belongs under `filter`, not top-level.
    const res = runBin(
      ['query', '--input', JSON.stringify({ grep: 'reconcile_repo' })],
      adhdRoot
    );

    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(
      2
    );
    const lastLine = res.stderr.trim().split('\n').pop() ?? '';
    const body = JSON.parse(lastLine) as { code: string; message: string };
    expect(body.code).toBe('invalid_argument');
    // AJV's `additionalProperties: false` violation message doesn't name the
    // offending key by default — it flags the containing object
    // (`/data/input must NOT have additional properties`). What matters for
    // this regression is that the call is REJECTED at all, closing the hole
    // where the "grep" key used to be silently dropped and ignored.
    expect(body.message).toContain('must NOT have additional properties');
  });

  it('a correctly-nested "filter.repo" query still works and genuinely scopes results (the intended positive behavior)', async () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-query-addlprops-scoped-'));
    const matchRepo = 'PseudoSky/query-addlprops-match';
    const otherRepo = 'PseudoSky/query-addlprops-other';

    const seedEnv = buildBacklogEnv({
      scope: 'project',
      cwd: adhdRoot,
      adhdRoot,
    });
    seedEnv.ensureDirs();
    const seedStore = await openGraphBacklogStore(seedEnv.files.db);
    const seeded = await createItem(
      { store: seedStore, env: seedEnv },
      {
        family: 'BUG-ADDLPROPS',
        title: 'matching item',
        body: 'x',
        repo: matchRepo,
      }
    );
    await createItem(
      { store: seedStore, env: seedEnv },
      {
        family: 'BUG-ADDLPROPS',
        title: 'non-matching item',
        body: 'x',
        repo: otherRepo,
      }
    );
    await closeGraphBacklogStore(seedStore);

    const res = runBin(
      ['query', '--input', JSON.stringify({ filter: { repo: matchRepo } })],
      adhdRoot
    );

    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(
      0
    );
    const body = JSON.parse(res.stdout.trim()) as {
      ok: boolean;
      data: { items: Array<{ humanId: string; repo?: string }> };
    };
    expect(body.ok).toBe(true);
    const humanIds = body.data.items.map((i) => i.humanId);
    expect(humanIds).toContain(seeded.item.humanId);
    // Teeth: genuinely scoped — the other-repo item must NOT be present.
    expect(
      body.data.items.every((i) => i.repo === matchRepo || i.repo === undefined)
    ).toBe(true);
    expect(body.data.items.length).toBe(1);
  });
});
