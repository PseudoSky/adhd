/**
 * Shared TripwireStorage contract cases (ticket 8468f7b1, [tripwire-core.31] TW38). The same cases run on
 * every backend: the tier S unit spec supplies the in-memory ones, the tier P e2e spec a real directory.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isTripwireError, type TripwireStorage } from '../../src/index';

export interface Harness {
  storage: TripwireStorage;
  readAudit(): Promise<string[]>;
  cleanup(): Promise<void>;
}

export type HarnessFactory = [name: string, make: () => Promise<Harness>];

/** Register the contract suite for each factory (call at module top level of a spec). */
export function defineStorageContract(factories: HarnessFactory[]): void {
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
}
