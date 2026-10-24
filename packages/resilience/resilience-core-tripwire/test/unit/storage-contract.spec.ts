/**
 * guards: a storage backend breaks the shared TripwireStorage contract
 * tier: S
 * cites: ticket 8468f7b1; [tripwire-core.31] TW38.
 * Ticket 8468f7b1 - the TripwireStorage contract suite, run identically on
 * createMemoryStorage, createFileStorage over the memory fs (with and
 * without hard-link support, covering the open-wx fallback of the
 * create-if-absent link). Memory fs only: tier S never touches the disk.
 * Criteria: [tripwire-core.31] TW38.
 */
import {
  createFileStorage,
  createMemoryFs,
  createMemoryStorage,
  isTripwireError,
  type TripwireStorage,
} from '../../src/index';

interface Harness {
  storage: TripwireStorage;
  readAudit(): Promise<string[]>;
  cleanup(): Promise<void>;
}

const factories: Array<[string, () => Promise<Harness>]> = [
  ['createMemoryStorage', async () => {
    const s = createMemoryStorage();
    return {
      storage: s,
      readAudit: async () => [...s.auditLines],
      cleanup: async () => undefined,
    };
  }],
  ['createFileStorage(memory fs)', async () => {
    const mfs = createMemoryFs();
    return {
      storage: createFileStorage({
        stateDir: '/s',
        auditPath: '/s/audit.log',
        maxAuditBytes: 100_000,
        fs: mfs,
        clock: () => 0,
      }),
      readAudit: async () =>
        (mfs.readText('/s/audit.log') ?? '').split('\n').filter(Boolean),
      cleanup: async () => undefined,
    };
  }],
  ['createFileStorage(memory fs that rejects link)', async () => {
    const mfs = createMemoryFs({ linkSupported: false });
    return {
      storage: createFileStorage({
        stateDir: '/s',
        auditPath: '/s/audit.log',
        maxAuditBytes: 100_000,
        fs: mfs,
        clock: () => 0,
      }),
      readAudit: async () =>
        (mfs.readText('/s/audit.log') ?? '').split('\n').filter(Boolean),
      cleanup: async () => undefined,
    };
  }],
];

describe.each(factories)('[tripwire-core.31] TW38 contract: %s', (_n, make) => {
  let h: Harness;
  beforeEach(async () => {
    h = await make();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('starts empty: absent lock, no keys, zero count, no marker', async () => {
    expect(await h.storage.readLock('k')).toBe('absent');
    expect(await h.storage.listKeys()).toEqual([]);
    expect(await h.storage.blocked('k')).toEqual({ count: 0 });
    expect(await h.storage.takeClearedMarker('k')).toBeNull();
    expect(await h.storage.removeLock('k')).toEqual({ tombstone: null });
  });

  it('createLockIfAbsent creates once; the first content wins', async () => {
    expect(await h.storage.createLockIfAbsent('k', '{"n":1}')).toBe(true);
    expect(await h.storage.createLockIfAbsent('k', '{"n":2}')).toBe(false);
    const l = await h.storage.readLock('k');
    expect(l).toMatchObject({ raw: '{"n":1}' });
    expect(typeof (l as { mtimeMs: number }).mtimeMs).toBe('number');
  });

  it('incrementBlocked counts exactly and never creates the lock', async () => {
    await h.storage.incrementBlocked('k');
    expect(await h.storage.readLock('k')).toBe('absent');
    await h.storage.createLockIfAbsent('k', '{}');
    // a stale count left by a racing gate is discarded on create
    expect((await h.storage.blocked('k')).count).toBe(0);
    for (let i = 0; i < 5; i += 1) await h.storage.incrementBlocked('k');
    const b = await h.storage.blocked('k');
    expect(b.count).toBe(5);
    expect(typeof b.lastAt).toBe('number');
    expect(await h.storage.readLock('k')).toMatchObject({ raw: '{}' });
  });

  it('removeLock tombstones once and resets the count', async () => {
    await h.storage.createLockIfAbsent('k', '{}');
    await h.storage.incrementBlocked('k');
    const first = await h.storage.removeLock('k');
    expect(typeof first.tombstone).toBe('string');
    expect(await h.storage.removeLock('k')).toEqual({ tombstone: null });
    expect(await h.storage.readLock('k')).toBe('absent');
    expect((await h.storage.blocked('k')).count).toBe(0);
    expect(await h.storage.createLockIfAbsent('k', '{"again":1}')).toBe(true);
  });

  it('the cleared marker is consumed exactly once', async () => {
    await h.storage.writeClearedMarker('k', '{"m":1}');
    await h.storage.writeClearedMarker('k', '{"m":2}');
    expect(await h.storage.takeClearedMarker('k')).toBe('{"m":2}');
    expect(await h.storage.takeClearedMarker('k')).toBeNull();
  });

  it('block counts are scoped to the generation of the live lock',
    async () => {
      const g1 = 'a'.repeat(24);
      const g2 = 'b'.repeat(24);
      await h.storage.createLockIfAbsent('k', JSON.stringify({ generation: g1 }));
      for (let i = 0; i < 3; i += 1) await h.storage.incrementBlocked('k', g1);
      // a block for another (dead) generation is discarded
      await h.storage.incrementBlocked('k', g2);
      await h.storage.incrementBlocked('k');
      expect((await h.storage.blocked('k', g1)).count).toBe(3);
      expect((await h.storage.blocked('k', g2)).count).toBe(0);
      expect((await h.storage.blocked('k')).count).toBe(0);
      await h.storage.removeLock('k');
      expect((await h.storage.blocked('k', g1)).count).toBe(0);
      // a late block for the removed generation leaves nothing behind
      await h.storage.incrementBlocked('k', g1);
      await h.storage.createLockIfAbsent('k', JSON.stringify({ generation: g2 }));
      expect((await h.storage.blocked('k', g1)).count).toBe(0);
      expect((await h.storage.blocked('k', g2)).count).toBe(0);
    });

  it('an invalid generation in the lock content is treated as none',
    async () => {
      await h.storage.createLockIfAbsent('k', JSON.stringify({
        generation: '../../src/etc/passwd',
      }));
      await h.storage.incrementBlocked('k');
      expect((await h.storage.blocked('k')).count).toBe(1);
      await h.storage.removeLock('k');
      expect((await h.storage.blocked('k')).count).toBe(0);
    });

  it('peek reads the marker; take with expected consumes only that one',
    async () => {
      expect(await h.storage.peekClearedMarker('k')).toBeNull();
      await h.storage.writeClearedMarker('k', '{"m":1}');
      expect(await h.storage.peekClearedMarker('k')).toBe('{"m":1}');
      expect(await h.storage.peekClearedMarker('k')).toBe('{"m":1}');
      // a newer marker is never consumed in place of the expected one
      expect(await h.storage.takeClearedMarker('k', '{"m":0}')).toBeNull();
      expect(await h.storage.peekClearedMarker('k')).toBe('{"m":1}');
      expect(await h.storage.takeClearedMarker('k', '{"m":1}')).toBe('{"m":1}');
      expect(await h.storage.peekClearedMarker('k')).toBeNull();
      expect(await h.storage.takeClearedMarker('k', '{"m":1}')).toBeNull();
    });

  it('listKeys lists locked keys only, sorted', async () => {
    await h.storage.createLockIfAbsent('b', '{}');
    await h.storage.createLockIfAbsent('a', '{}');
    await h.storage.incrementBlocked('c');
    await h.storage.writeClearedMarker('d', '{}');
    expect(await h.storage.listKeys()).toEqual(['a', 'b']);
  });

  it('appendAudit appends whole lines in order', async () => {
    await h.storage.appendAudit('{"i":1}\n');
    await h.storage.appendAudit('{"i":2}');
    expect(await h.readAudit()).toEqual(['{"i":1}', '{"i":2}']);
  });

  it('rejects invalid keys with TRIPWIRE_INVALID_KEY', async () => {
    for (const k of ['../../lib/x', 'a/b', '.k', '']) {
      const err = await h.storage.readLock(k).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(isTripwireError(err)).toBe(true);
    }
  });
});

describe('[tripwire-core.31] TW38 create-if-absent uses link', () => {
  it('links a fsynced unique tmp into place when links work', async () => {
    const mfs = createMemoryFs();
    const s = createFileStorage({
      stateDir: '/s',
      auditPath: '/s/audit.log',
      maxAuditBytes: 100_000,
      fs: mfs,
      clock: () => 0,
    });
    await s.createLockIfAbsent('k', '{}');
    const seq = mfs.ops
      .filter((o) => o.path.includes('k.lock') && o.op !== 'stat')
      .map((o) => o.op);
    // read-only probes (stat) are not part of the write protocol
    expect(seq).toEqual([
      'openExclusive',
      'write',
      'sync',
      'close',
      'link',
      'unlink',
    ]);
  });

  it('falls back to open wx when link is rejected', async () => {
    const mfs = createMemoryFs({ linkSupported: false });
    const s = createFileStorage({
      stateDir: '/s',
      auditPath: '/s/audit.log',
      maxAuditBytes: 100_000,
      fs: mfs,
      clock: () => 0,
    });
    expect(await s.createLockIfAbsent('k', '{"x":1}')).toBe(true);
    expect(await s.createLockIfAbsent('k', '{"x":2}')).toBe(false);
    expect(mfs.readText('/s/tripwire/k.lock')).toBe('{"x":1}');
    const opened = mfs.ops
      .filter((o) => o.op === 'openExclusive')
      .map((o) => o.path);
    expect(opened).toContain('/s/tripwire/k.lock');
    expect(mfs.files().filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});
