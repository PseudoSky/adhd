/**
 * guards: a legal interleaving of racing tripwire operations violates the latch invariants
 * tier: S
 * cites: ticket 8468f7b1; [tripwire-core.11] TW11 (N interleaved gates give blockedCount === N), [tripwire-core.12] TW12 (a gate racing a clear never recreates the lock), [tripwire-core.29] TW36 (trip/trip, gate/gate, gate/clear, clear/clear, trip/clear and audit rotate/append hold the TW1, TW11, TW12 and TW20 invariants).
 * Ticket 8468f7b1 - the interleaving suite over the memory-fs scheduler.
 * Every fs operation of the racing tripwire instances is held and released
 * in an order chosen by the explorer (bounded exhaustive enumeration plus
 * seeded-random schedules), so each invariant is checked at every
 * interleaving point of the exact fs operations, not only at the ends.
 * Each racer is a distinct simulated process (own FsPort object, own
 * in-memory latch) over one shared memory disk.
 *
 * Criteria: [tripwire-core.11] TW11 (N interleaved gates give
 * blockedCount === N), [tripwire-core.12] TW12 (a gate racing a clear never
 * recreates the lock), [tripwire-core.29] TW36 (trip/trip, gate/gate,
 * gate/clear, clear/clear, trip/clear and audit rotate/append hold the
 * TW1, TW11, TW12 and TW20 invariants).
 */
import {
  createMemoryFs,
  createTripwire,
  type FsPort,
  type MemoryFs,
  type Tripwire,
} from '../../src/index';
import { createAuditLog, MIN_AUDIT_BYTES } from '../../src/lib/audit';
import type { FsOpRecord, SchedulePicker } from '../../src/lib/memory-fs';
import { exploreExhaustive, exploreRandom } from '../helpers/explore';
import {
  eventsOf,
  makeEnv,
  processView,
  STATE_DIR,
  type Env,
} from '../helpers/harness';

const SLOW = 120_000;
const enc = new TextEncoder();
const strict = new TextDecoder('utf-8', { fatal: true });

/** Settled value of a fulfilled result (fails the test on a rejection). */
function valueOf<T>(r: PromiseSettledResult<T>): T {
  if (r.status === 'rejected') throw r.reason;
  return r.value;
}

/** Index of the first op matching `pred` (or -1). */
function indexOfOp(
  ops: readonly FsOpRecord[],
  pred: (o: FsOpRecord) => boolean,
): number {
  return ops.findIndex(pred);
}

/** Every non-absent state of `path` observed after each op is whole JSON. */
function watchWholeJson(mfs: MemoryFs, path: string): string[] {
  const bad: string[] = [];
  mfs.observe(() => {
    const t = mfs.readText(path);
    if (t === undefined) return;
    try {
      JSON.parse(t);
    } catch {
      bad.push(t.slice(0, 40));
    }
  });
  return bad;
}

/** Leftover protocol temporaries (tmp, tombstone, stash, rotation). */
function leftovers(env: Env): string[] {
  return env.mfs.files().filter((f) => /\.(tmp|tomb|stash|rot|taken)$/.test(f));
}

/** Run a scenario exhaustively (bounded) and then under random seeds. */
async function explore(
  run: (pick: SchedulePicker) => Promise<void>,
  exhaustiveRuns: number,
  randomRuns: number,
): Promise<number> {
  const res = await exploreExhaustive(run, exhaustiveRuns);
  expect(res.runs).toBeGreaterThan(1);
  await exploreRandom(run, randomRuns);
  return res.runs + randomRuns;
}

describe('[tripwire-core.29] TW36 trip/trip: exactly one trip creates', () => {
  it('one created: true, the first record wins, one tripwire-retripped',
    async () => {
      let contested = 0;
      await explore(async (pick) => {
        const env = makeEnv();
        const a = env.otherProcess();
        const b = env.otherProcess();
        const bad = watchWholeJson(env.mfs, env.lockPath('k'));
        const results = await env.mfs.schedule([
          () => a.trip('k', {
            reason: 'captcha',
            context: { by: 'a' },
          }),
          () => b.trip('k', {
            reason: 'banned',
            context: { by: 'b' },
          }),
        ], pick);
        env.mfs.observe(undefined);
        const [ra, rb] = results.map(valueOf);
        expect([ra.created, rb.created].filter(Boolean)).toHaveLength(1);
        const winner = ra.created ? ra : rb;
        const loser = ra.created ? rb : ra;
        // the loser reports the winner's record, untouched
        expect(loser.record.reason).toBe(winner.record.reason);
        expect(loser.record.trippedAt).toBe(winner.record.trippedAt);
        expect(loser.record.context).toEqual(winner.record.context);
        const onDisk = JSON.parse(env.mfs.readText(env.lockPath('k')) as string);
        expect(onDisk.reason).toBe(winner.record.reason);
        expect(onDisk.context).toEqual(winner.record.context);
        expect(eventsOf(env, 'tripwire-fired')).toHaveLength(1);
        expect(eventsOf(env, 'tripwire-retripped')).toHaveLength(1);
        expect(bad).toEqual([]);
        expect(leftovers(env)).toEqual([]);
        const links = env.mfs.ops.filter((o) =>
          o.op === 'link' && o.path2 === env.lockPath('k'));
        if (links.length === 2) contested += 1;
      }, 200, 150);
      // the race itself was exercised: both trips reached the link
      expect(contested).toBeGreaterThan(0);
    }, SLOW);

  it('the open(wx) fallback (no hard links) also has exactly one winner',
    async () => {
      await exploreRandom(async (pick) => {
        const env = makeEnv({ linkSupported: false });
        const a = env.otherProcess();
        const b = env.otherProcess();
        const results = await env.mfs.schedule([
          () => a.trip('k', {
            reason: 'captcha',
            context: {},
          }),
          () => b.trip('k', {
            reason: 'banned',
            context: {},
          }),
        ], pick);
        const created = results.map(valueOf).map((r) => r.created);
        expect(created.filter(Boolean)).toHaveLength(1);
        expect(eventsOf(env, 'tripwire-fired')).toHaveLength(1);
        expect(leftovers(env)).toEqual([]);
      }, 150);
    }, SLOW);

  it('a gate counted while two trips race is never lost', async () => {
    let counted = 0;
    await explore(async (pick) => {
      const env = makeEnv();
      const a = env.otherProcess();
      const b = env.otherProcess();
      const c = env.otherProcess();
      const results = await env.mfs.schedule<unknown>([
        () => a.trip('k', {
          reason: 'captcha',
          context: {},
        }),
        () => b.trip('k', {
          reason: 'banned',
          context: {},
        }),
        // poll until closed (bounded), so the counted block can land at
        // every point of the two trips' create-if-absent sequences
        async () => {
          let g = await c.gate('k');
          for (let i = 0; i < 40 && g.open; i += 1) g = await c.gate('k');
          return g;
        },
      ], pick);
      const gate = valueOf(results[2]) as { open: boolean };
      const snap = await env.tw.read('k');
      expect(snap.status).toBe('tripped');
      // the gate counted exactly when it was closed, and the count stays
      expect(snap.record?.blockedCount).toBe(gate.open ? 0 : 1);
      if (!gate.open) counted += 1;
    }, 300, 400);
    expect(counted).toBeGreaterThan(0);
  }, SLOW);

  it('scripted worst case: the losing trip cannot erase a block counted on '
    + 'the winner\'s lock', async () => {
    const env = makeEnv();
    const tags: string[] = [];
    const lock = env.lockPath('k');
    const proc = (tag: string): Tripwire => createTripwire({
      namespace: 'test-ns',
      stateDir: STATE_DIR,
      actor: 'tester',
      clock: env.clock.fn,
      fs: taggedView(env.mfs, tag, tags),
    });
    const a = proc('A');
    const b = proc('B');
    const c = proc('C');
    // B checks the lock is absent, A then creates it, C counts a block on
    // A's lock, and only then does B continue its create-if-absent.
    const phases: Array<{ tag: string; until: (o: FsOpRecord) => boolean }> = [
      { tag: 'B', until: (o) => o.op === 'stat' && o.path === lock },
      { tag: 'A', until: (o) => o.op === 'link' && o.path2 === lock },
      { tag: 'C', until: (o) =>
        o.op === 'appendFile' && o.path.startsWith(env.blockedPath('k')) },
    ];
    const results = await env.mfs.schedule<unknown>([
      () => a.trip('k', {
        reason: 'captcha',
        context: {},
      }),
      () => b.trip('k', {
        reason: 'banned',
        context: {},
      }),
      async () => {
        let g = await c.gate('k');
        for (let i = 0; i < 40 && g.open; i += 1) g = await c.gate('k');
        return g;
      },
    ], phasedPicker(phases, tags));
    expect(phases).toEqual([]);
    const [ra, rb, rc] = results.map(valueOf) as [
      { created: boolean },
      { created: boolean },
      { open: boolean },
    ];
    expect(ra.created).toBe(true);
    expect(rb.created).toBe(false);
    expect(rc.open).toBe(false);
    expect((await env.tw.read('k')).record?.blockedCount).toBe(1);
    expect(leftovers(env)).toEqual([]);
  });

  it('a stale count of a dead lock never lands on the winner of a trip '
    + 'race (scripted and random)', async () => {
    const seedStale = (env: Env): void => {
      // a late block of a removed legacy lock and of a removed generation
      env.mfs.writeText(env.blockedPath('k'), '1', 0o600);
      env.mfs.writeText(env.blockedPath('k', 'f'.repeat(24)), '11', 0o600);
    };
    await exploreRandom(async (pick) => {
      const env = makeEnv();
      seedStale(env);
      const a = env.otherProcess();
      const b = env.otherProcess();
      const results = await env.mfs.schedule([
        () => a.trip('k', {
          reason: 'captcha',
          context: {},
        }),
        () => b.trip('k', {
          reason: 'banned',
          context: {},
        }),
      ], pick);
      expect(results.map(valueOf).filter((r) => r.created)).toHaveLength(1);
      expect((await env.tw.read('k')).record?.blockedCount).toBe(0);
      await env.tw.gate('k');
      expect((await env.tw.read('k')).record?.blockedCount).toBe(1);
    }, 150);
    // scripted: the loser runs its whole create before the winner links
    const env = makeEnv();
    seedStale(env);
    const tags: string[] = [];
    const lock = env.lockPath('k');
    const proc = (tag: string): Tripwire => createTripwire({
      namespace: 'test-ns',
      stateDir: STATE_DIR,
      actor: 'tester',
      clock: env.clock.fn,
      fs: taggedView(env.mfs, tag, tags),
    });
    const phases: Array<{ tag: string; until: (o: FsOpRecord) => boolean }> = [
      { tag: 'B', until: (o) => o.op === 'stat' && o.path === lock },
      { tag: 'A', until: (o) => o.op === 'link' && o.path2 === lock },
    ];
    await env.mfs.schedule([
      () => proc('A').trip('k', {
        reason: 'captcha',
        context: {},
      }),
      () => proc('B').trip('k', {
        reason: 'banned',
        context: {},
      }),
    ], phasedPicker(phases, tags));
    expect(phases).toEqual([]);
    expect((await env.tw.read('k')).record?.blockedCount).toBe(0);
  }, SLOW);

  it('[tripwire-core.29] TW17 under trip/trip: the lock that is written '
    + 'carries priorClear and the marker is consumed exactly once',
  async () => {
    let raced = 0;
    await explore(async (pick) => {
      const env = makeEnv({ clearPolicy: 'open' });
      await env.tw.trip('k', {
        reason: 'captcha',
        context: {},
      });
      await env.tw.clear('k', {
        method: 'mcp-clear',
        actor: 'op',
      });
      const marker = env.mfs.readText(env.markerPath('k'));
      expect(marker).toBeDefined();
      const a = env.otherProcess({ clearPolicy: 'open' });
      const b = env.otherProcess({ clearPolicy: 'open' });
      const opsBefore = env.mfs.ops.length;
      const results = await env.mfs.schedule([
        () => a.trip('k', {
          reason: 'banned',
          context: {},
        }),
        () => b.trip('k', {
          reason: 'rate_limited',
          context: {},
        }),
      ], pick);
      const outs = results.map(valueOf);
      const winner = outs.find((r) => r.created);
      const onDisk = JSON.parse(env.mfs.readText(env.lockPath('k')) as string);
      expect(onDisk.priorClear).toMatchObject({
        method: 'mcp-clear',
        actor: 'op',
      });
      expect(winner?.record.priorClear).toEqual(onDisk.priorClear);
      expect(env.mfs.exists(env.markerPath('k'))).toBe(false);
      expect(leftovers(env)).toEqual([]);
      const peeks = env.mfs.ops.slice(opsBefore).filter((o) =>
        o.op === 'readFile' && o.path === env.markerPath('k'));
      if (peeks.length === 2) raced += 1;
    }, 200, 200);
    // both trips read the marker before either consumed it
    expect(raced).toBeGreaterThan(0);
  }, SLOW);

  it('TW17: a clear racing in after the create keeps its newer marker',
    async () => {
      const env = makeEnv({ clearPolicy: 'open' });
      await env.tw.trip('k', {
        reason: 'captcha',
        context: {},
      });
      await env.tw.clear('k', { method: 'hitl-clear' });
      const tags: string[] = [];
      const lock = env.lockPath('k');
      const t = createTripwire({
        namespace: 'test-ns',
        stateDir: STATE_DIR,
        clearPolicy: 'open',
        actor: 'tester',
        clock: env.clock.fn,
        fs: taggedView(env.mfs, 'T', tags),
      });
      const c = createTripwire({
        namespace: 'test-ns',
        stateDir: STATE_DIR,
        clearPolicy: 'open',
        actor: 'tester',
        clock: env.clock.fn,
        fs: taggedView(env.mfs, 'C', tags),
      });
      // T creates its lock; C clears it (writing a newer marker) before
      // T consumes the marker it read
      const phases: Array<{ tag: string; until: (o: FsOpRecord) => boolean }> =
        [
          { tag: 'T', until: (o) => o.op === 'link' && o.path2 === lock },
          { tag: 'C', until: (o) => o.op === 'rename' &&
            o.path2 === env.markerPath('k') },
        ];
      env.clock.advance(5000);
      const results = await env.mfs.schedule<unknown>([
        () => t.trip('k', {
          reason: 'banned',
          context: {},
        }),
        () => c.clear('k', { method: 'mcp-clear' }),
      ], phasedPicker(phases, tags));
      expect(phases).toEqual([]);
      expect((valueOf(results[0]) as { created: boolean }).created).toBe(true);
      expect(valueOf(results[1])).toEqual({ cleared: true });
      // the newer marker (from the racing clear) survives for the next trip
      const left = JSON.parse(env.mfs.readText(env.markerPath('k')) as string);
      expect(left.method).toBe('mcp-clear');
      const next = await env.tw.trip('k', {
        reason: 'x',
        context: {},
      });
      expect(next.record.priorClear?.method).toBe('mcp-clear');
      expect(leftovers(env)).toEqual([]);
    });
});

/**
 * A distinct FsPort over `mfs` that records `tag` for every call, in call
 * order; the memory fs queues held operations in the same order, so
 * `tags[i]` names the owner of `pending[i]` (a picker must splice both).
 */
function taggedView(mfs: MemoryFs, tag: string, tags: string[]): FsPort {
  const v = processView(mfs);
  const t = <A extends unknown[], R>(f: (...a: A) => Promise<R>) =>
    (...a: A): Promise<R> => {
      tags.push(tag);
      return f(...a);
    };
  return {
    mkdir: t(v.mkdir),
    chmod: t(v.chmod),
    openExclusive: async (p, m) => {
      const h = await t(v.openExclusive)(p, m);
      return {
        write: t(h.write),
        sync: t(h.sync),
        close: t(h.close),
      };
    },
    appendFile: t(v.appendFile),
    link: t(v.link),
    rename: t(v.rename),
    unlink: t(v.unlink),
    readFile: t(v.readFile),
    stat: t(v.stat),
    readdir: t(v.readdir),
  };
}

describe('[tripwire-core.11] TW11 gate/gate: blockedCount === N exactly', () => {
  it('N interleaved gates from N processes lose no update', async () => {
    const N = 4;
    await explore(async (pick) => {
      const env = makeEnv();
      await env.tw.trip('k', {
        reason: 'captcha',
        context: {},
      });
      const lockBefore = env.mfs.readText(env.lockPath('k')) as string;
      const gen = JSON.parse(lockBefore).generation as string;
      const gates = Array.from({ length: N }, () => env.otherProcess());
      const results = await env.mfs.schedule(
        gates.map((g) => () => g.gate('k')),
        pick,
      );
      const outs = results.map(valueOf);
      expect(outs.every((g) => !g.open)).toBe(true);
      // the sidecar size is the count; the lock was never modified
      expect(env.mfs.readBytes(env.blockedPath('k', gen))?.length).toBe(N);
      expect(env.mfs.readText(env.lockPath('k'))).toBe(lockBefore);
      expect((await env.tw.read('k')).record?.blockedCount).toBe(N);
      const audited = eventsOf(env, 'tripwire-gate-blocked')
        .map((e) => e.blockedCount as number);
      expect(audited).toHaveLength(N);
      expect(Math.max(...audited)).toBe(N);
      for (const n of audited) {
        expect(n).toBeGreaterThanOrEqual(1);
        expect(n).toBeLessThanOrEqual(N);
      }
    }, 150, 150);
  }, SLOW);

  it('a legacy in-record blockedCount adds to the N interleaved blocks',
    async () => {
      await exploreRandom(async (pick) => {
        const env = makeEnv();
        env.mfs.writeText(env.lockPath('k'), JSON.stringify({
          reason: 'captcha',
          trippedAt: '2026-10-11T00:00:00.000Z',
          blockedCount: 7,
        }));
        const gates = [env.otherProcess(), env.otherProcess(),
          env.otherProcess()];
        await env.mfs.schedule(gates.map((g) => () => g.gate('k')), pick);
        expect((await env.tw.read('k')).record?.blockedCount).toBe(10);
      }, 80);
    }, SLOW);
});

describe('[tripwire-core.12] TW12 gate/clear: a block never recreates the lock',
  () => {
    it('after the clear the lock is absent; the next trip counts from 0',
      async () => {
        let lateAppend = 0;
        await explore(async (pick) => {
          const env = makeEnv({ clearPolicy: 'open' });
          await env.tw.trip('k', {
            reason: 'captcha',
            context: {},
          });
          const g = env.otherProcess({ clearPolicy: 'open' });
          const c = env.otherProcess({ clearPolicy: 'open' });
          const opsBefore = env.mfs.ops.length;
          const results = await env.mfs.schedule<unknown>([
            () => g.gate('k'),
            () => c.clear('k', { method: 'mcp-clear' }),
          ], pick);
          results.forEach(valueOf);
          expect(valueOf(results[1])).toEqual({ cleared: true });
          expect(env.mfs.exists(env.lockPath('k'))).toBe(false);
          expect((await env.tw.read('k')).status).toBe('clear');
          const raced = env.mfs.ops.slice(opsBefore);
          // the only mutation of the lock path is the clear's tombstone rename
          const lockWrites = raced.filter((o) =>
            (o.path === env.lockPath('k') || o.path2 === env.lockPath('k')) &&
            !['readFile', 'stat'].includes(o.op));
          expect(lockWrites.map((o) => o.op)).toEqual(['rename']);
          const rename = indexOfOp(raced, (o) =>
            o.op === 'rename' && o.path === env.lockPath('k'));
          const append = indexOfOp(raced, (o) =>
            o.op === 'appendFile' && o.path.startsWith(env.blockedPath('k')));
          if (append > rename) lateAppend += 1;
          // a stale count left by a late block never leaks into a new trip
          const next = await env.tw.trip('k', {
            reason: 'banned',
            context: {},
          });
          expect(next.created).toBe(true);
          expect((await env.tw.read('k')).record?.blockedCount).toBe(0);
          expect(leftovers(env)).toEqual([]);
          // a block that landed after the removal cleaned itself up: no
          // count file of the dead generation is left behind
          expect(env.mfs.files().filter((f) => f.includes('.blocked')))
            .toEqual([]);
        }, 200, 200);
        // the contested order (block counted after the lock was removed) ran
        expect(lateAppend).toBeGreaterThan(0);
      }, SLOW);
  });

describe('[tripwire-core.29] TW36 clear/clear and trip/clear', () => {
  it('clear/clear: exactly one clear wins and is audited once', async () => {
    await explore(async (pick) => {
      const env = makeEnv({ clearPolicy: 'open' });
      await env.tw.trip('k', {
        reason: 'captcha',
        context: {},
      });
      const a = env.otherProcess({ clearPolicy: 'open' });
      const b = env.otherProcess({ clearPolicy: 'open' });
      const results = await env.mfs.schedule([
        () => a.clear('k', { method: 'mcp-clear' }),
        () => b.clear('k', { method: 'hitl-clear' }),
      ], pick);
      const cleared = results.map(valueOf).map((r) => r.cleared);
      expect(cleared.filter(Boolean)).toHaveLength(1);
      expect(eventsOf(env, 'tripwire-cleared')).toHaveLength(1);
      expect(env.mfs.exists(env.lockPath('k'))).toBe(false);
      expect(env.mfs.exists(env.markerPath('k'))).toBe(true);
      expect(leftovers(env)).toEqual([]);
    }, 200, 150);
  }, SLOW);

  it('trip/clear: the lock is present exactly when the clear found nothing',
    async () => {
      let both = 0;
      await explore(async (pick) => {
        const env = makeEnv({ clearPolicy: 'open' });
        const t = env.otherProcess({ clearPolicy: 'open' });
        const c = env.otherProcess({ clearPolicy: 'open' });
        const bad = watchWholeJson(env.mfs, env.lockPath('k'));
        const results = await env.mfs.schedule<unknown>([
          () => t.trip('k', {
            reason: 'captcha',
            context: {},
          }),
          () => c.clear('k', { method: 'mcp-clear' }),
        ], pick);
        env.mfs.observe(undefined);
        const trip = valueOf(results[0]) as { created: boolean };
        const clear = valueOf(results[1]) as { cleared: boolean };
        expect(trip.created).toBe(true);
        expect(env.mfs.exists(env.lockPath('k'))).toBe(!clear.cleared);
        expect(eventsOf(env, 'tripwire-cleared'))
          .toHaveLength(clear.cleared ? 1 : 0);
        expect(bad).toEqual([]);
        expect(leftovers(env)).toEqual([]);
        if (clear.cleared) both += 1;
      }, 200, 200);
      expect(both).toBeGreaterThan(0);
    }, SLOW);

  it('trip/clear on a tripped key: a retrip never resurrects a cleared lock',
    async () => {
      await explore(async (pick) => {
        const env = makeEnv({ clearPolicy: 'open' });
        await env.tw.trip('k', {
          reason: 'captcha',
          context: {},
        });
        const t = env.otherProcess({ clearPolicy: 'open' });
        const c = env.otherProcess({ clearPolicy: 'open' });
        const results = await env.mfs.schedule<unknown>([
          () => t.trip('k', {
            reason: 'banned',
            context: {},
          }),
          () => c.clear('k', { method: 'mcp-clear' }),
        ], pick);
        const trip = valueOf(results[0]) as {
          created: boolean;
          record: { reason: string };
        };
        expect(valueOf(results[1])).toEqual({ cleared: true });
        // either the trip saw the old lock (retrip, then cleared) or it
        // created a fresh lock after the clear, carrying priorClear
        const lock = env.mfs.readText(env.lockPath('k'));
        if (trip.created) {
          expect(JSON.parse(lock as string).reason).toBe('banned');
        } else {
          expect(trip.record.reason).toBe('captcha');
          expect(lock).toBeUndefined();
        }
        expect(leftovers(env)).toEqual([]);
      }, 150, 150);
    }, SLOW);
});

describe('[tripwire-core.29] TW36 audit rotate/append (TW20 invariant)', () => {
  const AUDIT = '/logs/audit.log';
  const CAP = MIN_AUDIT_BYTES;

  function line(n: number, size = 900): string {
    const pad = '€😀ü'.repeat(Math.ceil(size / 9));
    return JSON.stringify({
      n,
      pad: pad.slice(0, Math.floor(size / 3)),
    }) + '\n';
  }

  function fillToCap(mfs: MemoryFs): number {
    let size = 0;
    let n = 0;
    let text = '';
    while (size + enc.encode(line(n + 1)).length <= CAP) {
      n += 1;
      text += line(n);
      size += enc.encode(line(n)).length;
    }
    mfs.writeText(AUDIT, text, 0o600);
    return n;
  }

  it('two writers rotating and appending lose no complete line', async () => {
    let seq = 0;
    const suffix = (): string => `r.${(seq += 1)}`;
    await explore(async (pick) => {
      const mfs = createMemoryFs();
      const last = fillToCap(mfs);
      const a = createAuditLog({
        path: AUDIT,
        maxAuditBytes: CAP,
        fs: processView(mfs),
        uniqueSuffix: suffix,
      });
      const b = createAuditLog({
        path: AUDIT,
        maxAuditBytes: CAP,
        fs: processView(mfs),
        uniqueSuffix: suffix,
      });
      const results = await mfs.schedule([
        async () => {
          await a.append(line(1001));
          await a.append(line(1002));
        },
        async () => {
          await b.append(line(2001, 300));
          await b.append(line(2002, 300));
        },
      ], pick);
      results.forEach(valueOf);
      const text = strict.decode(mfs.readBytes(AUDIT) as Uint8Array);
      expect(text.endsWith('\n')).toBe(true);
      const ns = text.split('\n').filter(Boolean)
        .map((l) => JSON.parse(l).n as number);
      for (const want of [1001, 1002, 2001, 2002]) {
        expect(ns.filter((x) => x === want)).toHaveLength(1);
      }
      // each writer's own lines stay in order
      expect(ns.indexOf(1001)).toBeLessThan(ns.indexOf(1002));
      expect(ns.indexOf(2001)).toBeLessThan(ns.indexOf(2002));
      // only the oldest lines were dropped: the kept old lines are the
      // newest contiguous run ending at the last pre-filled line
      const old = ns.filter((x) => x <= last);
      expect(old[old.length - 1]).toBe(last);
      for (let i = 1; i < old.length; i += 1) {
        expect(old[i]).toBe(old[i - 1] + 1);
      }
      expect(mfs.files()).toEqual([AUDIT]);
    }, 150, 150);
  }, SLOW);
});

/**
 * A picker that, phase by phase, runs only the operations of one tagged
 * process until the phase's `until` operation has been released; then it
 * releases operations in arrival order. Splices `tags` with the queue.
 */
function phasedPicker(
  phases: Array<{ tag: string; until: (o: FsOpRecord) => boolean }>,
  tags: string[],
): SchedulePicker {
  return (pending) => {
    let i = 0;
    const phase = phases[0];
    if (phase) {
      const j = tags.findIndex((t) => t === phase.tag);
      if (j >= 0) i = j;
      if (phase.until(pending[i])) phases.shift();
    }
    tags.splice(i, 1);
    return i;
  };
}
