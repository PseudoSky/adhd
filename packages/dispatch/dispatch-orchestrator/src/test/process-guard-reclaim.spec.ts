/**
 * guards: a stale-lock reclaimer deletes a competitor's live lock, a half-published lock is stolen, or release removes a lock that is not its own
 * tier: S
 * cites: 0b80a7b5 AC2
 *
 * process-guard-reclaim.spec.ts — stale-lock reclaim, atomic publish and
 * owner-checked release of `acquireDispatchLock`.
 *
 * Failure mode: a reclaimer that read a stale lock blind-deletes the lock a
 * competitor re-acquired in between (two live holders for one dag, silent loss of
 * the observation record); a lock published empty/partial is read as stale and
 * stolen; a release removes a lock that is no longer its own.
 * Tier: S (real fs under <repo>/tmp, injected `isAlive`/`pid`, the exported
 *   `onStaleRead` seam; no process is spawned, nothing touches a network).
 * Item: 0b80a7b5 (slice D1-D3), criterion AC2, plus the review-correction
 *   behaviours of b0f8fda7 (atomic publish, EEXIST-on-restore, heldBySelf,
 *   pid+token release).
 * Red run: pending — authored under a no-run hold. Expected against the base
 *   (21ba12b3) process-guard.ts: AC2 tests fail on `onStaleRead` never being
 *   called / `acquireDispatchLock` not throwing DuplicateDispatchError (the base
 *   `rmSync`s the competitor's lock); the publish test fails on "no hard-link
 *   publish observed"; the heldBySelf tests fail on `heldBySelf` undefined; the
 *   same-pid release test fails because the base release compares pid only.
 *   The third-process-in-window tests (defect: the reclaimer deleted the displaced
 *   live competitor's lock when restoreAside hit EEXIST) fail against the
 *   pre-fix guard on `expected [] to have length 1` (the side copy is gone) and
 *   on `displacedPid` undefined; the cleanup-masking test fails because the
 *   unguarded `rmSync(aside)` in `finally` replaces the DuplicateDispatchError.
 *   Run record: `red: pending (user hold)` — no test was run when this was written.
 * Tag: regression:0b80a7b5-reclaim-eexist-displaced-lock
 *
 * Concurrency is injected through latches (the `onStaleRead` callback and a
 * `linkSync` hook), never through sleeps.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as nodeFs from 'node:fs';
import { join, resolve } from 'node:path';

// Pass-through wrapper: only `linkSync` and `rmSync` are observable (and `rmSync` may be made to fail), every other fs call is real.
const hooks = vi.hoisted(() => ({
  link: null as null | ((src: string, dst: string) => void),
  rm: null as null | ((path: string) => void),
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    linkSync: (src: string, dst: string) => {
      hooks.link?.(src, dst);
      return actual.linkSync(src, dst);
    },
    rmSync: (path: Parameters<typeof actual.rmSync>[0], options?: Parameters<typeof actual.rmSync>[1]) => {
      hooks.rm?.(String(path));
      return actual.rmSync(path, options);
    },
  };
});

import { acquireDispatchLock, DuplicateDispatchError } from '../lib/process-guard.js';

const TMP_ROOT = resolve(__dirname, '../../../../../tmp/dispatch-orchestrator/process-guard-reclaim');
const STALE_PID = 111_111;
const ME = 200_000;
const COMPETITOR = 300_000;
const THIRD = 400_000;
const alive = (...pids: number[]) => (pid: number) => pids.includes(pid);

let dir: string;
let n = 0;
beforeEach(() => {
  dir = join(TMP_ROOT, `case-${n++}`);
  nodeFs.rmSync(dir, { recursive: true, force: true });
  nodeFs.mkdirSync(dir, { recursive: true });
});
afterEach(() => {
  hooks.link = null;
  hooks.rm = null;
  nodeFs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

const body = (pid: number, token = 'tok') => JSON.stringify({ identity: 'dag', pid, token });
const leftovers = (lockName: string) => nodeFs.readdirSync(dir).filter((f) => f !== lockName);

describe('0b80a7b5 AC2 stale-lock reclaim never deletes a competitor lock', () => {
  it('0b80a7b5 AC2: a competitor that re-acquires inside the reclaimer stale-read window keeps its lock; the reclaimer gets DuplicateDispatchError', () => {
    const lock = join(dir, 'dag.lock');
    nodeFs.writeFileSync(lock, body(STALE_PID));
    const competitorBody = body(COMPETITOR, 'competitor');
    let staleReads = 0;

    let thrown: unknown;
    try {
      acquireDispatchLock(lock, 'dag', {
        pid: ME,
        isAlive: alive(COMPETITOR),
        onStaleRead: () => {
          staleReads++;
          // The competitor reclaims the same stale lock and takes it, inside the window.
          nodeFs.rmSync(lock);
          nodeFs.writeFileSync(lock, competitorBody, { flag: 'wx' });
        },
      });
    } catch (err) {
      thrown = err;
    }

    expect(staleReads, 'onStaleRead must fire exactly once when a stale lock is read').toBe(1);
    expect(thrown).toBeInstanceOf(DuplicateDispatchError);
    expect((thrown as DuplicateDispatchError).holderPid).toBe(COMPETITOR);
    expect((thrown as DuplicateDispatchError).heldBySelf).toBe(false);
    // The consumer-visible outcome: the competitor's lock survives byte-for-byte.
    expect(nodeFs.readFileSync(lock, 'utf8')).toBe(competitorBody);
    expect(leftovers('dag.lock')).toEqual([]);
  });

  it('0b80a7b5 AC2 NEGATIVE CONTROL: with no competitor the stale lock is reclaimed and acquired, leaving no side files', () => {
    const lock = join(dir, 'dag.lock');
    nodeFs.writeFileSync(lock, body(STALE_PID));
    let staleReads = 0;
    const handle = acquireDispatchLock(lock, 'dag', { pid: ME, isAlive: alive(), onStaleRead: () => staleReads++ });
    expect(staleReads).toBe(1);
    expect(JSON.parse(nodeFs.readFileSync(lock, 'utf8')).pid).toBe(ME);
    expect(leftovers('dag.lock')).toEqual([]);
    handle.release();
    expect(nodeFs.existsSync(lock)).toBe(false);
  });

  /** Drive the EEXIST-on-restore window: a competitor re-acquires inside the stale-read window, then a third process wins the path before the reclaimer restores the moved-aside lock. */
  function runThirdProcessWindow(opts: { competitorPid: number; thirdPid: number; live: number[] }) {
    const lock = join(dir, 'dag.lock');
    nodeFs.writeFileSync(lock, body(STALE_PID));
    const competitorBody = body(opts.competitorPid, 'competitor');
    const thirdBody = body(opts.thirdPid, 'third');
    let raced = false;
    hooks.link = (src, dst) => {
      // Only the reclaimer's restore of the moved-aside competitor lock.
      if (!raced && dst === lock && src.includes('.reclaim.')) {
        raced = true;
        nodeFs.writeFileSync(lock, thirdBody, { flag: 'wx' }); // the third process wins the path
      }
    };
    let thrown: unknown;
    try {
      acquireDispatchLock(lock, 'dag', {
        pid: ME,
        isAlive: alive(...opts.live),
        onStaleRead: () => {
          nodeFs.rmSync(lock);
          nodeFs.writeFileSync(lock, competitorBody, { flag: 'wx' });
        },
      });
    } catch (err) {
      thrown = err;
    }
    expect(raced, 'the restore hard-link must have been attempted').toBe(true);
    const side = leftovers('dag.lock');
    return { lock, thirdBody, competitorBody, thrown, side };
  }

  it('0b80a7b5 AC2: a third process taking the lock in the rename window (EEXIST on restore) is refused naming the path holder AND the displaced live competitor, and the competitor lock file is retained byte-for-byte', () => {
    const { lock, thirdBody, competitorBody, thrown, side } = runThirdProcessWindow({
      competitorPid: COMPETITOR,
      thirdPid: THIRD,
      live: [COMPETITOR, THIRD],
    });

    expect(thrown).toBeInstanceOf(DuplicateDispatchError);
    const dup = thrown as DuplicateDispatchError;
    expect(dup.holderPid).toBe(THIRD);
    expect(dup.displacedPid, 'the displaced live competitor must be named').toBe(COMPETITOR);
    expect(dup.message).toContain(`pid ${THIRD}`);
    expect(dup.message).toContain(`pid ${COMPETITOR}`);
    expect(nodeFs.readFileSync(lock, 'utf8')).toBe(thirdBody);
    // The displaced live owner's lock is NOT silently discarded: exactly one side
    // file survives and it is the competitor's lock, untouched.
    expect(side).toHaveLength(1);
    expect(side[0]).toMatch(/^dag\.lock\.reclaim\./);
    expect(nodeFs.readFileSync(join(dir, side[0]), 'utf8')).toBe(competitorBody);
  });

  it('0b80a7b5 AC2: when the path holder that won the window is itself dead, the displaced LIVE competitor is the one named and its lock file is retained', () => {
    const { lock, thirdBody, competitorBody, thrown, side } = runThirdProcessWindow({
      competitorPid: COMPETITOR,
      thirdPid: THIRD,
      live: [COMPETITOR], // THIRD is dead
    });

    expect(thrown).toBeInstanceOf(DuplicateDispatchError);
    expect((thrown as DuplicateDispatchError).holderPid).toBe(COMPETITOR);
    expect(nodeFs.readFileSync(lock, 'utf8')).toBe(thirdBody); // stale path holder left for the next reclaim
    expect(side).toHaveLength(1);
    expect(nodeFs.readFileSync(join(dir, side[0]), 'utf8')).toBe(competitorBody);
  });

  it('0b80a7b5 AC2 NEGATIVE CONTROL: when the displaced competitor is provably dead its side copy is discarded and the live path holder alone is named', () => {
    const { lock, thirdBody, thrown, side } = runThirdProcessWindow({
      competitorPid: COMPETITOR,
      thirdPid: THIRD,
      live: [THIRD], // COMPETITOR is dead
    });

    expect(thrown).toBeInstanceOf(DuplicateDispatchError);
    expect((thrown as DuplicateDispatchError).holderPid).toBe(THIRD);
    expect((thrown as DuplicateDispatchError).displacedPid).toBeUndefined();
    expect(nodeFs.readFileSync(lock, 'utf8')).toBe(thirdBody);
    expect(side).toEqual([]);
  });

  it('0b80a7b5 AC2: a failure while discarding the side copy never masks the DuplicateDispatchError', () => {
    hooks.rm = (path) => {
      if (path.includes('.reclaim.')) throw Object.assign(new Error('EIO: injected cleanup failure'), { code: 'EIO' });
    };
    const { thrown } = runThirdProcessWindow({ competitorPid: COMPETITOR, thirdPid: THIRD, live: [THIRD] });

    expect(thrown, 'the primary refusal must survive a failing best-effort cleanup').toBeInstanceOf(DuplicateDispatchError);
    expect((thrown as DuplicateDispatchError).holderPid).toBe(THIRD);
  });
});

describe('0b80a7b5 atomic lock publish (b0f8fda7)', () => {
  it('0b80a7b5 AC2: the lock appears at its path only with its complete body — published by hard link from a fully written temp file, never created empty', () => {
    const lock = join(dir, 'dag.lock');
    const seen: { existedBefore: boolean; srcBody: string }[] = [];
    hooks.link = (src, dst) => {
      if (dst !== lock) return;
      seen.push({ existedBefore: nodeFs.existsSync(lock), srcBody: nodeFs.readFileSync(src, 'utf8') });
    };

    const handle = acquireDispatchLock(lock, 'dag', { pid: ME, isAlive: alive() });

    expect(seen, 'publish must go through a hard link of a pre-written file').toHaveLength(1);
    expect(seen[0].existedBefore).toBe(false);
    const parsed = JSON.parse(seen[0].srcBody) as { pid: number; identity: string; token: string };
    expect(parsed.pid).toBe(ME);
    expect(parsed.identity).toBe('dag');
    expect(parsed.token).toMatch(/\S/);
    expect(nodeFs.readFileSync(lock, 'utf8')).toBe(seen[0].srcBody);
    expect(leftovers('dag.lock')).toEqual([]); // the temp file is gone
    handle.release();
  });

  it.each([
    ['empty', ''],
    ['truncated JSON', '{"identity":"dag","pi'],
    ['JSON without a numeric pid', JSON.stringify({ identity: 'dag' })],
  ])('0b80a7b5 AC2: a corrupt lock body (%s) is treated as stale and reclaimed', (_label, corrupt) => {
    const lock = join(dir, 'dag.lock');
    nodeFs.writeFileSync(lock, corrupt);
    const handle = acquireDispatchLock(lock, 'dag', { pid: ME, isAlive: alive(ME) });
    expect(JSON.parse(nodeFs.readFileSync(lock, 'utf8')).pid).toBe(ME);
    expect(leftovers('dag.lock')).toEqual([]);
    handle.release();
  });
});

describe('0b80a7b5 DuplicateDispatchError.heldBySelf (b0f8fda7)', () => {
  it('0b80a7b5 AC2: re-acquiring a lock this process already holds is refused with heldBySelf and a nested-acquisition message', () => {
    const lock = join(dir, 'dag.lock');
    const first = acquireDispatchLock(lock, 'dag', { pid: ME, isAlive: alive(ME) });
    let thrown: unknown;
    try {
      acquireDispatchLock(lock, 'dag', { pid: ME, isAlive: alive(ME) });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DuplicateDispatchError);
    const dup = thrown as DuplicateDispatchError;
    expect(dup.heldBySelf).toBe(true);
    expect(dup.holderPid).toBe(ME);
    expect(dup.message).toMatch(/already held by this process/);
    expect(dup.message).toMatch(/nested acquisition/);
    first.release();
  });

  it('0b80a7b5 AC2 NEGATIVE CONTROL: a live holder that is another process is a plain duplicate, heldBySelf false', () => {
    const lock = join(dir, 'dag.lock');
    nodeFs.writeFileSync(lock, body(COMPETITOR));
    let thrown: unknown;
    try {
      acquireDispatchLock(lock, 'dag', { pid: ME, isAlive: alive(COMPETITOR) });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DuplicateDispatchError);
    expect((thrown as DuplicateDispatchError).heldBySelf).toBe(false);
    expect((thrown as DuplicateDispatchError).message).toMatch(/refusing a duplicate submission/);
    expect((thrown as DuplicateDispatchError).message).not.toMatch(/nested acquisition/);
  });
});

describe('0b80a7b5 release compares the pid+token body (b0f8fda7)', () => {
  it('0b80a7b5 AC2: a handle whose lock was reclaimed by another holder with the SAME pid but a different token does not remove it', () => {
    const lock = join(dir, 'dag.lock');
    const a = acquireDispatchLock(lock, 'dag', { pid: ME, isAlive: alive() });
    nodeFs.rmSync(lock); // A's lock is reclaimed out from under it
    const b = acquireDispatchLock(lock, 'dag', { pid: ME, isAlive: alive() });
    const bBody = nodeFs.readFileSync(lock, 'utf8');

    a.release();

    expect(nodeFs.existsSync(lock), "A's release removed B's lock").toBe(true);
    expect(nodeFs.readFileSync(lock, 'utf8')).toBe(bBody); // content untouched
    expect(leftovers('dag.lock')).toEqual([]); // no .release.* side file left behind
    b.release();
    expect(nodeFs.existsSync(lock)).toBe(false);
  });

  it('0b80a7b5 AC2: a handle whose lock now belongs to a DIFFERENT pid never removes it — the owner/token check, not the idempotence flag, is what protects', () => {
    const lock = join(dir, 'dag.lock');
    const a = acquireDispatchLock(lock, 'dag', { pid: ME, isAlive: alive() });
    nodeFs.rmSync(lock); // A's lock is reclaimed out from under it (A never released: its flag is still unset)
    const b = acquireDispatchLock(lock, 'dag', { pid: COMPETITOR, isAlive: alive() });
    const bBody = nodeFs.readFileSync(lock, 'utf8');

    a.release(); // first call on A: only the body comparison can spare B's lock

    expect(nodeFs.readFileSync(lock, 'utf8'), "A's release touched B's lock").toBe(bBody);
    expect(leftovers('dag.lock')).toEqual([]);
    b.release();
    expect(nodeFs.existsSync(lock)).toBe(false);
  });

  it('0b80a7b5 AC2: release is idempotent — a repeated release neither throws nor removes a lock re-acquired afterwards', () => {
    const lock = join(dir, 'dag.lock');
    const a = acquireDispatchLock(lock, 'dag', { pid: ME, isAlive: alive() });
    a.release();
    a.release();
    expect(nodeFs.existsSync(lock)).toBe(false);
    const b = acquireDispatchLock(lock, 'dag', { pid: ME, isAlive: alive() });
    const bBody = nodeFs.readFileSync(lock, 'utf8');
    a.release();
    expect(nodeFs.readFileSync(lock, 'utf8')).toBe(bBody);
    b.release();
    expect(nodeFs.existsSync(lock)).toBe(false);
  });
});
