/**
 * membership-backfill-runner.e2e.ts — e54bd58b A-AC5: the migration RUNNER as a
 * process. Drives `tools/migrate/membership-backfill.ts` through `tsx` against a
 * legacy store (no `in_component` rows) and trusts the process exit codes:
 * dry-run 1 (pending), apply 0 with counts unchanged, re-run dry-run 0,
 * `--reverse <journal>` 0 restoring the pre-state, and the production guard
 * (exit 2 without `--allow-production-write`, 0 with it) against a fake HOME so
 * the real production store is never touched.
 *
 * Resource lane: spawns a child process per case.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openGraphBacklogStore, closeGraphBacklogStore } from './store/graph-backlog-store.js';
import { gitEnv } from './test/helpers/git-env.js';
import { e2eTestTimeoutMs, spawnTimeoutMs } from './test/helpers/spawn-timeout.js';
import { buildBacklogEnv } from './env.js';
import * as api from './api.js';
import type { IOutcomeEnvelope } from './envelope.js';

const PKG = resolve(__dirname, '..');
const TSX = resolve(PKG, '..', '..', 'node_modules', '.bin', 'tsx');
const RUNNER = join(PKG, 'tools', 'migrate', 'membership-backfill.ts');

function data<T>(r: IOutcomeEnvelope<T>): T {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.data;
}

function run(args: string[], cwd: string, home: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(TSX, [RUNNER, ...args], {
    cwd,
    env: gitEnv({ HOME: home }),
    encoding: 'utf8',
    timeout: spawnTimeoutMs(),
  });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** A legacy (pre-n:m) store at `dbPath`: 1 project, 1 component, 2 issues, no `in_component` rows. */
async function seedLegacyStore(dbPath: string, scratch: string): Promise<void> {
  const store = await openGraphBacklogStore(dbPath);
  try {
    const ctx: api.BacklogCtx = { store, env: buildBacklogEnv({ adhdRoot: scratch }) };
    const root = join(scratch, 'proj');
    mkdirSync(join(root, 'pkg'), { recursive: true });
    const project = data(await api.upsertProject(ctx, { name: 'proj', path: root, by: 's' })).uid;
    const comp = data(await api.upsertComponent(ctx, { project, name: 'pkg', by: 's' })).uid;
    data(await api.upsertLocation(ctx, { component: comp, locType: 'path', value: join(root, 'pkg'), by: 's' }));
    for (const t of ['one', 'two']) {
      data(await api.create(ctx, { project, component: comp, title: t, body: `${t} b`, by: 'f' } as never));
    }
    await store.adapter.executeRun("DELETE FROM edge WHERE rel = 'in_component'");
  } finally {
    await closeGraphBacklogStore(store);
  }
}

describe('e54bd58b A-AC5 membership-backfill runner exit codes', () => {
  let work: string;
  let home: string;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'membership-runner-work-'));
    home = mkdtempSync(join(tmpdir(), 'membership-runner-home-'));
  });
  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it(
    'e54bd58b A-AC5 dry-run 1, apply 0, re-run 0, reverse 0',
    async () => {
      const dbPath = join(work, 'legacy.db');
      await seedLegacyStore(dbPath, work);

      const dry = run([dbPath], work, home);
      expect(dry.status, dry.stdout + dry.stderr).toBe(1);
      expect(dry.stdout).toContain('pendingWrites=2');

      const apply = run([dbPath, '--apply'], work, home);
      expect(apply.status, apply.stdout + apply.stderr).toBe(0);
      expect(apply.stdout).toContain('REPLAN pendingWrites=0');

      const again = run([dbPath], work, home);
      expect(again.status, again.stdout + again.stderr).toBe(0);

      const journalDir = join(work, 'tmp', 'migrate');
      const journal = join(journalDir, readdirSync(journalDir).find((f) => f.endsWith('.journal.json'))!);
      expect(JSON.parse(readFileSync(journal, 'utf8')).created).toHaveLength(2);
      const rev = run([dbPath, '--reverse', journal], work, home);
      expect(rev.status, rev.stdout + rev.stderr).toBe(0);
      const afterRev = run([dbPath], work, home);
      expect(afterRev.status).toBe(1); // pending again: the reverse restored the legacy shape
    },
    e2eTestTimeoutMs(6)
  );

  it(
    'e54bd58b A-AC5 production guard: exit 2 and nothing written without --allow-production-write; 0 with it (fake HOME)',
    async () => {
      const prodDir = join(home, '.adhd', 'backlog', 'production');
      const prodDb = join(prodDir, 'backlog-v2.db');
      mkdirSync(prodDir, { recursive: true });
      await seedLegacyStore(prodDb, work);

      const refused = run([prodDb, '--apply'], work, home);
      expect(refused.status, refused.stdout + refused.stderr).toBe(2);
      expect(refused.stderr).toContain('REFUSED');
      expect(run([prodDb], work, home).status).toBe(1); // the refused apply wrote nothing

      const allowed = run([prodDb, '--apply', '--allow-production-write'], work, home);
      expect(allowed.status, allowed.stdout + allowed.stderr).toBe(0);
      expect(run([prodDb], work, home).status).toBe(0);
    },
    e2eTestTimeoutMs(6)
  );
});
