/**
 * process-guard-publish-fallback.spec.ts — lock publication on filesystems that
 * cannot hard-link.
 *
 * Guards: lock publication failing with a raw fs error on filesystems without hard links; EEXIST semantics of the lock publish.
 * Failure mode: `publishLock` hard-links a temp file to the lock path and only
 * handles EEXIST; on a filesystem without hard links (some network mounts,
 * FAT/exFAT, WSL drvfs) `linkSync` throws ENOTSUP/EPERM/EXDEV/ENOSYS/EOPNOTSUPP
 * and every dispatch run dies with a raw fs error where the earlier exclusive
 * `wx` write worked. The fallback must publish through an exclusive `wx` write
 * and keep the duplicate-dispatch semantics (a second acquirer is refused).
 * Tier: S (real fs under <repo>/tmp; `linkSync` is the only faked call, injected
 *   through a node:fs mock; no process spawned, no network, no sleeps).
 * Gap statement: tier S suffices; a filesystem that lacks hard links is not
 *   available on the test host, so the error `linkSync` raises there is injected.
 * Cites: plan discovery-sweep-1014 blind-review B AC2 and AC3.
 * Red run (against the unfixed process-guard.ts, `npx vitest run
 *   src/test/process-guard-publish-fallback.spec.ts`, exit 1): 6 failed, 2 passed.
 *   The five code cases fail on the raw `Error: <code>: hard links are not
 *   supported` thrown out of `publishLock`; the pre-existing-holder case fails on
 *   `expected error to be instance of DuplicateDispatchError` (received the raw
 *   ENOTSUP). The EACCES case and the AC3 working-link case pass before and
 *   after, pinning that unrelated errors and the EEXIST path are unchanged.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import * as nodeFs from 'node:fs';
import { join, resolve } from 'node:path';

const hooks = vi.hoisted(() => ({
  link: null as null | ((src: string, dst: string) => void),
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    linkSync: (src: string, dst: string) => {
      hooks.link?.(src, dst);
      return actual.linkSync(src, dst);
    },
  };
});

import { acquireDispatchLock, DuplicateDispatchError } from '../../src/lib/process-guard.js';

const TMP_ROOT = resolve(__dirname, '../../../../../tmp/dispatch-orchestrator/process-guard-publish-fallback');
const ME = 200_000;
const OTHER = 300_000;
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
  nodeFs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

const failLinkWith = (code: string) => {
  hooks.link = () => {
    throw Object.assign(new Error(`${code}: hard links are not supported`), { code });
  };
};

describe('plan discovery-sweep-1014 blind-review B AC2: publish falls back to an exclusive wx write when hard links are unsupported', () => {
  for (const code of ['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV', 'ENOSYS']) {
    it(`plan discovery-sweep-1014 blind-review B AC2: linkSync throwing ${code} still publishes the lock, a second acquirer is refused, and no temp file is left`, () => {
      const lock = join(dir, 'dag.lock');
      failLinkWith(code);

      const held = acquireDispatchLock(lock, 'dag', { pid: ME, isAlive: alive(ME, OTHER) });

      const published = JSON.parse(nodeFs.readFileSync(lock, 'utf8')) as { pid: number; identity: string };
      expect(published.pid).toBe(ME);
      expect(published.identity).toBe('dag');
      expect(nodeFs.readdirSync(dir)).toEqual(['dag.lock']);

      let thrown: unknown;
      try {
        acquireDispatchLock(lock, 'dag', { pid: OTHER, isAlive: alive(ME, OTHER) });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(DuplicateDispatchError);
      expect((thrown as DuplicateDispatchError).holderPid).toBe(ME);
      expect(nodeFs.readdirSync(dir)).toEqual(['dag.lock']);

      held.release();
      expect(nodeFs.existsSync(lock)).toBe(false);
    });
  }

  it('plan discovery-sweep-1014 blind-review B AC2: when the lock already exists the fallback write loses with EEXIST semantics (holder kept intact)', () => {
    const lock = join(dir, 'dag.lock');
    const holderBody = JSON.stringify({ identity: 'dag', pid: OTHER, token: 'holder' });
    nodeFs.writeFileSync(lock, holderBody);
    failLinkWith('ENOTSUP');

    expect(() => acquireDispatchLock(lock, 'dag', { pid: ME, isAlive: alive(ME, OTHER) })).toThrow(DuplicateDispatchError);
    expect(nodeFs.readFileSync(lock, 'utf8')).toBe(holderBody);
    expect(nodeFs.readdirSync(dir)).toEqual(['dag.lock']);
  });

  it('plan discovery-sweep-1014 blind-review B AC2: an unrelated link failure (EACCES) is still thrown, not swallowed by the fallback', () => {
    const lock = join(dir, 'dag.lock');
    failLinkWith('EACCES');

    expect(() => acquireDispatchLock(lock, 'dag', { pid: ME, isAlive: alive(ME) })).toThrow(/EACCES/);
    expect(nodeFs.existsSync(lock)).toBe(false);
    expect(nodeFs.readdirSync(dir)).toEqual([]);
  });
});

describe('plan discovery-sweep-1014 blind-review B AC3: EEXIST via linkSync is unchanged', () => {
  it('plan discovery-sweep-1014 blind-review B AC3: with working hard links the publish uses linkSync once and a second acquirer is refused', () => {
    const lock = join(dir, 'dag.lock');
    let links = 0;
    hooks.link = () => {
      links++;
    };

    const held = acquireDispatchLock(lock, 'dag', { pid: ME, isAlive: alive(ME, OTHER) });
    expect(links).toBe(1);
    expect(() => acquireDispatchLock(lock, 'dag', { pid: OTHER, isAlive: alive(ME, OTHER) })).toThrow(DuplicateDispatchError);
    held.release();
    expect(nodeFs.existsSync(lock)).toBe(false);
  });
});
