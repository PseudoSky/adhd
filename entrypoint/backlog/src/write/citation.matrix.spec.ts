/**
 * citation.matrix.spec.ts — 050ea18f A-AC4 (S02.H45): a citation-verification
 * matrix over {in-root, out-of-root, worktree-only, non-file} never produces
 * REFUSAL-PLUS-OMISSION: for every cell the write is either refused (and the
 * graph is unchanged) XOR persisted (and the citation is readable back) — the
 * pathology is "report success without the citation" / "drop it silently".
 *
 * Negative control (run once, restored): making the gate refuse an out-of-root
 * target AFTER the issue was written (refusal-plus-omission) turns the
 * out-of-root / worktree-only cells red.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { buildBacklogEnv } from '../env.js';
import * as api from '../api.js';

describe('050ea18f A-AC4 — citation matrix never yields refusal-plus-omission', () => {
  let tmp: TmpStore;
  let ctx: api.BacklogCtx;
  let projectUid: string;
  let cells: Record<string, string>;

  async function counts(): Promise<{ citations: number; issues: number }> {
    const q = async (kind: string): Promise<number> =>
      Number(
        (
          await tmp.store.adapter.executeGet<{ c: number }>(
            'SELECT COUNT(*) AS c FROM node WHERE kind = ? AND t_invalid IS NULL',
            [kind]
          )
        )?.c
      );
    return { citations: await q('citation'), issues: await q('issue') };
  }

  beforeEach(async () => {
    tmp = await openTmpStore('citation-matrix');
    ctx = { store: tmp.store, env: buildBacklogEnv({ adhdRoot: tmp.dir }) };
    const repo = join(tmp.dir, 'repo');
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
    writeFileSync(join(repo, 'in-root.txt'), 'in\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'seed'], { cwd: repo });
    const wt = join(tmp.dir, 'wt');
    execFileSync('git', ['worktree', 'add', '-q', wt, '-b', 'wt'], { cwd: repo });
    writeFileSync(join(wt, 'wt-only.txt'), 'wt\n');
    const outside = join(tmp.dir, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'out.txt'), 'out\n');
    const fifo = join(tmp.dir, 'a-fifo');
    execFileSync('mkfifo', [fifo]);
    cells = {
      'in-root': join(repo, 'in-root.txt'),
      'out-of-root': join(outside, 'out.txt'),
      'worktree-only': join(wt, 'wt-only.txt'),
      'non-file': fifo,
    };
    const p = await api.upsertProject(ctx, { name: 'cite-matrix', path: repo, by: 'seed' });
    if (!p.ok) throw new Error(JSON.stringify(p));
    projectUid = (p.data as { uid: string }).uid;
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it.each(['in-root', 'out-of-root', 'worktree-only', 'non-file'])(
    '050ea18f A-AC4 — %s: refused XOR persisted, never refusal-plus-omission',
    async (cell) => {
      const before = await counts();
      const out = await api.create(ctx, {
        project: projectUid,
        title: `matrix ${cell}`,
        body: `matrix cell ${cell}`,
        by: 'filer',
        citations: [{ file: cells[cell]! }],
      });
      const after = await counts();
      if (out.ok) {
        // persisted: the issue AND exactly one citation exist and read back.
        expect(after).toEqual({ citations: before.citations + 1, issues: before.issues + 1 });
        const got = await api.get(ctx, { uid: (out.data as { uid: string }).uid, fields: ['citations'] });
        expect(got.ok && (got.data as { citations: unknown[] }).citations).toHaveLength(1);
      } else {
        // refused: nothing at all was written.
        expect(after).toEqual(before);
      }
      // Under the default policy every EXISTING target (file, out-of-root,
      // worktree-only, non-file) is persisted; none is refused.
      expect(out.ok, JSON.stringify(out)).toBe(true);
    }
  );
});
