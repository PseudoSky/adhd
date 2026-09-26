// atomic-write-json.spec.ts — behavioral proof for the atomic + DURABLE write
// helper (FEAT-002 Revision 2 R2.3; durability added by the bake-at-build work,
// design doc Revision 3). Proves the happy path (temp file -> fsync -> rename),
// the ORDERING that makes it durable (the temp handle is fsync'd BEFORE the
// rename publishes it; the parent dir fsync is attempted best-effort AFTER),
// and the failure path (temp file cleaned up, original error propagated, target
// never half-written).

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { atomicWriteJson } from './atomic-write-json';

// `node:fs/promises`'s exports are non-configurable in this runtime, so a
// direct `vi.spyOn(fsPromises, 'open' | 'rename' | 'unlink')` throws
// ("Cannot redefine property"). `vi.mock` with `importOriginal` is the standard
// Vitest workaround: a REAL passthrough (every function still does its real
// work by default) wrapped in `vi.fn` so calls are observable and individual
// tests can override behaviour. `hoisted.fs` captures the untampered module so a
// test can drive real I/O while the module under test goes through the spies.
// `vi.mock` factories are hoisted above imports, so a plain module-scope
// `let` is not yet initialised when the factory runs (`vi.hoisted` is the
// documented escape hatch). `hoisted.fs` captures the untampered module so a
// test can drive real I/O while the code under test goes through the spies.
const hoisted = vi.hoisted(() => ({
  fs: undefined as typeof import('node:fs/promises') | undefined,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  hoisted.fs = actual;
  return {
    ...actual,
    open: vi.fn(actual.open),
    rename: vi.fn(actual.rename),
    unlink: vi.fn(actual.unlink),
  };
});

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-ir-cache-atomic-spec-'));
});

afterEach(() => {
  // Restore real behaviour and reset call history for the next test.
  vi.mocked(fsPromises.open).mockImplementation(hoisted.fs!.open);
  vi.mocked(fsPromises.rename).mockImplementation(hoisted.fs!.rename);
  vi.mocked(fsPromises.unlink).mockImplementation(hoisted.fs!.unlink);
  vi.mocked(fsPromises.open).mockClear();
  vi.mocked(fsPromises.rename).mockClear();
  vi.mocked(fsPromises.unlink).mockClear();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('atomicWriteJson', () => {
  it('writes via a temp file + rename(), not a direct write to the target path', async () => {
    const target = path.join(dir, 'entry.json');
    const renameSpy = vi.mocked(fsPromises.rename);

    await atomicWriteJson(target, { hello: 'world' });

    expect(renameSpy).toHaveBeenCalledTimes(1);
    const [tmpArg, destArg] = renameSpy.mock.calls[0] as [string, string];
    expect(destArg).toBe(target);
    expect(tmpArg).not.toBe(target);
    expect(tmpArg.startsWith(target)).toBe(true); // `${path}.${pid}.${uuid}.tmp`

    // The temp file was opened for writing.
    const openSpy = vi.mocked(fsPromises.open);
    expect(openSpy).toHaveBeenCalled();
    expect(openSpy.mock.calls[0]?.[0]).toBe(tmpArg);

    // The final content on disk is the real target, fully written.
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ hello: 'world' });
    // No leftover temp file.
    expect(fs.existsSync(tmpArg)).toBe(false);
  });

  it('round-trips real content correctly', async () => {
    const target = path.join(dir, 'entry.json');
    const data = { a: 1, nested: { b: [1, 2, 3] } };
    await atomicWriteJson(target, data);
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(data);
  });

  it('fsyncs the temp handle BEFORE rename, then best-effort fsyncs the parent dir — the durability ordering', async () => {
    const target = path.join(dir, 'nested', 'entry.json');
    const events: string[] = [];

    // Wrap `open` so every returned handle records when its `sync()` runs, and
    // its path, giving a full ordering of file-fsync / dir-fsync vs. rename.
    vi.mocked(fsPromises.open).mockImplementation(async (p, flags) => {
      const handle = await hoisted.fs!.open(p as string, flags as string);
      vi.spyOn(handle, 'sync').mockImplementation(async () => {
        events.push(`sync:${String(p)}`);
      });
      return handle;
    });
    vi.mocked(fsPromises.rename).mockImplementation(async (from, to) => {
      events.push('rename');
      return hoisted.fs!.rename(from, to);
    });

    await atomicWriteJson(target, { ok: true });

    const tmp = `${target}.`; // temp path shares the target prefix
    const tmpSyncIndex = events.findIndex(
      (e) => e.startsWith('sync:') && e.startsWith(`sync:${tmp}`)
    );
    const renameIndex = events.indexOf('rename');
    const dirSyncIndex = events.indexOf(`sync:${path.dirname(target)}`);

    // Temp file fsync happened, and BEFORE the rename.
    expect(tmpSyncIndex).toBeGreaterThanOrEqual(0);
    expect(renameIndex).toBeGreaterThanOrEqual(0);
    expect(tmpSyncIndex).toBeLessThan(renameIndex);
    // Parent-directory fsync was attempted (best-effort) AFTER the rename.
    expect(dirSyncIndex).toBeGreaterThan(renameIndex);
  });

  it('a rename failure cleans up the temp file, propagates the real error, and leaves no target file behind', async () => {
    const target = path.join(dir, 'entry.json');
    const boom = new Error('rename failed (simulated)');
    vi.mocked(fsPromises.rename).mockRejectedValueOnce(boom);
    const unlinkSpy = vi.mocked(fsPromises.unlink);

    await expect(atomicWriteJson(target, { hello: 'world' })).rejects.toThrow(
      boom
    );

    const openSpy = vi.mocked(fsPromises.open);
    const tmpArg = openSpy.mock.calls[0]?.[0] as string;
    expect(tmpArg).not.toBe(target);

    // Best-effort cleanup was attempted for the exact temp path.
    expect(unlinkSpy).toHaveBeenCalledWith(tmpArg);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(tmpArg)).toBe(false);
  });

  it('a failing best-effort unlink never masks the real rename error', async () => {
    const target = path.join(dir, 'entry.json');
    const boom = new Error('rename failed (simulated)');
    vi.mocked(fsPromises.rename).mockRejectedValueOnce(boom);
    vi.mocked(fsPromises.unlink).mockRejectedValueOnce(
      new Error('unlink also failed')
    );

    await expect(atomicWriteJson(target, { hello: 'world' })).rejects.toThrow(
      boom
    );
  });

  it('an unsupported directory fsync (EPERM/ENOTSUP) is swallowed — the write still succeeds', async () => {
    const target = path.join(dir, 'entry.json');
    // Every open succeeds, but the DIRECTORY open (the second `open` call,
    // on the parent dir with flags 'r') is refused the way some filesystems
    // refuse to fsync a directory.
    const realOpen = hoisted.fs!.open;
    let call = 0;
    vi.mocked(fsPromises.open).mockImplementation(async (p, flags) => {
      call++;
      if (call === 2) {
        const err = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      return realOpen(p as string, flags as string);
    });

    await expect(atomicWriteJson(target, { ok: true })).resolves.toBeUndefined();
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ ok: true });
  });

  it('creates the parent directory if missing', async () => {
    const target = path.join(dir, 'nested', 'deeper', 'entry.json');
    await atomicWriteJson(target, { ok: true });
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ ok: true });
  });
});
