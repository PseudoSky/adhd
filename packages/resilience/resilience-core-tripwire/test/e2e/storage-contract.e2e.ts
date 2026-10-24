/**
 * guards: createFileStorage breaks the TripwireStorage contract on a real filesystem (real hard link, fsync, rename, exclusive open)
 * tier: P
 * gap: real link, fsync, rename and exclusive-open semantics cannot be observed at tier S because the unit lane forbids real disk and its memory fs only models them; this run uses a fresh os.tmpdir() mkdtemp on the local disk, so network filesystems, other platforms' link semantics and a crash between write and rename stay unobserved
 * cites: ticket 8468f7b1; [tripwire-core.31] TW38.
 * plan: resolve-findings
 * teeth: red: nx run resilience-core-tripwire:e2e --skip-nx-cache -> exit 1; with createFileStorage.createLockIfAbsent answering true after every attempt (mutation in src/lib/storage.ts), 'createLockIfAbsent creates once; the first content wins' fails on the real directory
 * Ticket 8468f7b1 - the same contract cases as test/unit/storage-contract.spec.ts (shared through
 * test/helpers/storage-contract.ts), run on createFileStorage over a real mkdtemp directory with the
 * node filesystem. Only os.tmpdir() is written, never the home directory.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileStorage, createNodeFs } from '../../src/index';
import { defineStorageContract } from '../helpers/storage-contract';

defineStorageContract([
  ['createFileStorage(mkdtemp)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tripwire-contract-'));
    const auditPath = join(dir, 'audit.log');
    return {
      storage: createFileStorage({
        stateDir: dir,
        auditPath,
        maxAuditBytes: 100_000,
        fs: createNodeFs(),
        clock: () => Date.now(),
      }),
      readAudit: async () => {
        try {
          return (await readFile(auditPath, 'utf8')).split('\n').filter(Boolean);
        } catch {
          return [];
        }
      },
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  }],
]);
