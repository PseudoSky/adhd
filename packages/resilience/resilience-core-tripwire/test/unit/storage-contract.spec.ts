/**
 * guards: a storage backend breaks the shared TripwireStorage contract
 * tier: S
 * cites: ticket 8468f7b1; [tripwire-core.31] TW38.
 * Ticket 8468f7b1 - the TripwireStorage contract suite, run identically on
 * createMemoryStorage, createFileStorage over the memory fs (with and
 * without hard-link support, covering the open-wx fallback of the
 * create-if-absent link). Memory fs only: tier S never touches the disk; the
 * real-directory run of the same cases is test/e2e/storage-contract.e2e.ts.
 * Criteria: [tripwire-core.31] TW38.
 */
import {
  createFileStorage,
  createMemoryFs,
  createMemoryStorage,
} from '../../src/index';
import { defineStorageContract, type HarnessFactory } from '../helpers/storage-contract';

const factories: HarnessFactory[] = [
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

defineStorageContract(factories);

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
