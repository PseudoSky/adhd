/**
 * Ticket 8468f7b1 - file storage write protocol over the memory fs:
 * unique tmp names and complete-or-absent reads at every interleaving
 * point, and 0600 files / 0700 directories.
 * Criteria: [tripwire-core.2] TW2, [tripwire-core.6] TW6.
 */
import { createFileStorage, createMemoryFs, type MemoryFs } from '../../index';
import { exploreExhaustive, exploreRandom } from '../support/explore';
import { makeEnv, processView, STATE_DIR } from '../support/harness';

const LOCK = `${STATE_DIR}/tripwire/k.lock`;
const MARKER = `${STATE_DIR}/tripwire/k.cleared`;

function storageOn(mfs: MemoryFs) {
  return createFileStorage({
    stateDir: STATE_DIR,
    auditPath: `${STATE_DIR}/audit.log`,
    maxAuditBytes: 100_000,
    fs: processView(mfs),
    clock: () => 0,
  });
}

/** Every observed state of `path` is absent or complete JSON. */
function watchComplete(mfs: MemoryFs, paths: string[]): string[] {
  const problems: string[] = [];
  mfs.observe(() => {
    for (const p of paths) {
      const t = mfs.readText(p);
      if (t === undefined) continue;
      try {
        JSON.parse(t);
      } catch {
        problems.push(`${p}: partial content ${JSON.stringify(t)}`);
      }
    }
  });
  return problems;
}

describe('[tripwire-core.2] TW2 unique .tmp names, complete-or-ENOENT', () => {
  it('tmp names carry pid plus random and are never reused', async () => {
    const mfs = createMemoryFs();
    const s = storageOn(mfs);
    await s.createLockIfAbsent('k', '{"a":1}');
    await s.writeClearedMarker('k', '{"b":1}');
    await s.writeClearedMarker('k', '{"b":2}');
    const tmps = mfs.ops
      .filter((o) => o.op === 'openExclusive')
      .map((o) => o.path);
    expect(tmps).toHaveLength(3);
    for (const t of tmps) {
      expect(t).toMatch(new RegExp(`\\.${process.pid}\\.[0-9a-f]{12}\\.tmp$`));
    }
    expect(new Set(tmps).size).toBe(3);
    // no tmp is left behind
    expect(mfs.files().filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('interleaved writers never share a tmp name; readers see whole JSON',
    async () => {
      const allTmps = new Set<string>();
      const run = async (
        pick: Parameters<MemoryFs['schedule']>[1],
      ): Promise<void> => {
        const mfs = createMemoryFs();
        const problems = watchComplete(mfs, [LOCK, MARKER]);
        const a = storageOn(mfs);
        const b = storageOn(mfs);
        const results = await mfs.schedule<unknown>([
          () => a.createLockIfAbsent('k', JSON.stringify({ by: 'a' })),
          () => b.createLockIfAbsent('k', JSON.stringify({ by: 'b' })),
          () => a.writeClearedMarker('k', JSON.stringify({ m: 'a' })),
          () => b.writeClearedMarker('k', JSON.stringify({ m: 'b' })),
        ], pick);
        mfs.observe(undefined);
        expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
        const created = results
          .slice(0, 2)
          .map((r) => (r as PromiseFulfilledResult<unknown>).value);
        expect(created.filter((c) => c === true)).toHaveLength(1);
        expect(problems).toEqual([]);
        const tmps = mfs.ops
          .filter((o) => o.op === 'openExclusive')
          .map((o) => o.path);
        expect(new Set(tmps).size).toBe(tmps.length);
        for (const t of tmps) {
          expect(allTmps.has(t)).toBe(false);
          allTmps.add(t);
        }
        const winner = JSON.parse(mfs.readText(LOCK) as string);
        expect(['a', 'b']).toContain(winner.by);
      };
      const res = await exploreExhaustive(run, 150);
      expect(res.runs).toBeGreaterThan(1);
      await exploreRandom(run, 60);
    });

  it('the open(wx) fallback is also never observed partial', async () => {
    await exploreRandom(async (pick) => {
      const mfs = createMemoryFs({ linkSupported: false });
      const a = storageOn(mfs);
      const b = storageOn(mfs);
      const seen: string[] = [];
      mfs.observe(() => {
        const t = mfs.readText(LOCK);
        if (t !== undefined) seen.push(t);
      });
      await mfs.schedule([
        () => a.createLockIfAbsent('k', '{"by":"a"}'),
        () => b.createLockIfAbsent('k', '{"by":"b"}'),
      ], pick);
      mfs.observe(undefined);
      // an empty file can be observed here: the tripwire reads it as
      // `unreadable` (tripped), never as clear
      for (const t of seen) expect(['', '{"by":"a"}', '{"by":"b"}']).toContain(t);
      expect(['{"by":"a"}', '{"by":"b"}']).toContain(mfs.readText(LOCK));
    }, 40);
  });
});

describe('[tripwire-core.6] TW6 files 0o600 and directories 0o700', () => {
  it('lock, sidecar, marker and audit files are 0o600; dirs 0o700', async () => {
    const env = makeEnv({ clearPolicy: 'open' });
    await env.tw.trip('k', {
      reason: 'x',
      context: {},
    });
    await env.tw.gate('k');
    expect(env.mfs.modeOf(env.lockPath('k'))).toBe(0o600);
    const gen = JSON.parse(env.mfs.readText(env.lockPath('k')) as string)
      .generation as string;
    expect(env.mfs.modeOf(env.blockedPath('k', gen))).toBe(0o600);
    expect(env.mfs.modeOf(env.auditPath)).toBe(0o600);
    expect(env.mfs.modeOf(STATE_DIR)).toBe(0o700);
    expect(env.mfs.modeOf(`${STATE_DIR}/tripwire`)).toBe(0o700);
    await env.tw.clear('k', { method: 'mcp-clear' });
    expect(env.mfs.modeOf(env.markerPath('k'))).toBe(0o600);
  });

  it('pre-existing 0o755 directories and a 0o644 audit are tightened', async () => {
    const env = makeEnv();
    env.mfs.makeDir(`${STATE_DIR}/tripwire`, 0o755);
    env.mfs.writeText(env.auditPath, '{"legacy":true}\n', 0o644);
    expect(env.mfs.modeOf(STATE_DIR)).toBe(0o755);
    await env.tw.trip('k', {
      reason: 'x',
      context: {},
    });
    expect(env.mfs.modeOf(STATE_DIR)).toBe(0o700);
    expect(env.mfs.modeOf(`${STATE_DIR}/tripwire`)).toBe(0o700);
    expect(env.mfs.modeOf(env.auditPath)).toBe(0o600);
    expect(env.mfs.readText(env.auditPath)).toMatch(/^\{"legacy":true\}\n/);
  });

  it('an auditPath directory elsewhere is created 0o700', async () => {
    const env = makeEnv({ auditPath: '/var/log/tw/audit.log' });
    await env.tw.trip('k', {
      reason: 'x',
      context: {},
    });
    expect(env.mfs.modeOf('/var/log/tw')).toBe(0o700);
    expect(env.mfs.modeOf('/var/log/tw/audit.log')).toBe(0o600);
  });
});
