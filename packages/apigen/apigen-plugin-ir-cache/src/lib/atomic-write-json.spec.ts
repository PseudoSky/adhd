// atomic-write-json.spec.ts — behavioral proof for the atomic write fix
// (FEAT-002 Revision 2, R2.3). Proves BOTH the happy path (rename() is
// actually used, not a plain writeFile) and the failure path (the temp file
// is cleaned up, the original error propagates, and the target path is left
// untouched — never a half-written file).

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { atomicWriteJson } from './atomic-write-json';

// `node:fs/promises`'s exports are non-configurable in this runtime, so a
// direct `vi.spyOn(fsPromises, 'rename' | 'writeFile' | 'unlink')` throws
// ("Cannot redefine property"). `vi.mock` with `importOriginal` is the
// standard Vitest workaround for Node built-ins: it swaps in a REAL
// passthrough (every function still does its real work by default) wrapped
// in `vi.fn` so call counts/args are observable, and individual tests can
// still `mockRejectedValueOnce` to simulate a failure.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: vi.fn(actual.rename),
    writeFile: vi.fn(actual.writeFile),
    unlink: vi.fn(actual.unlink),
  };
});

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-ir-cache-atomic-spec-'));
});

afterEach(() => {
  vi.mocked(fsPromises.rename).mockClear();
  vi.mocked(fsPromises.writeFile).mockClear();
  vi.mocked(fsPromises.unlink).mockClear();
});

describe('atomicWriteJson', () => {
  it('writes via a temp file + rename(), not a direct writeFile to the target path', async () => {
    const target = path.join(dir, 'entry.json');
    const renameSpy = vi.mocked(fsPromises.rename);
    const writeFileSpy = vi.mocked(fsPromises.writeFile);

    await atomicWriteJson(target, { hello: 'world' });

    expect(renameSpy).toHaveBeenCalledTimes(1);
    const [tmpArg, destArg] = renameSpy.mock.calls[0] as [string, string];
    expect(destArg).toBe(target);
    expect(tmpArg).not.toBe(target);
    expect(tmpArg.startsWith(target)).toBe(true); // `${path}.${pid}.${uuid}.tmp`

    // writeFile targets the TEMP path, never the real target directly.
    expect(writeFileSpy).toHaveBeenCalledTimes(1);
    expect(writeFileSpy.mock.calls[0]?.[0]).toBe(tmpArg);

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

  it('on a mid-write failure, cleans up the temp file, propagates the real error, and leaves no target file behind', async () => {
    const target = path.join(dir, 'entry.json');
    const boom = new Error('disk full (simulated)');
    const writeFileSpy = vi.mocked(fsPromises.writeFile).mockRejectedValueOnce(boom);
    const unlinkSpy = vi.mocked(fsPromises.unlink);

    await expect(atomicWriteJson(target, { hello: 'world' })).rejects.toThrow(boom);

    expect(writeFileSpy).toHaveBeenCalledTimes(1);
    const tmpArg = writeFileSpy.mock.calls[0]?.[0] as string;

    // Best-effort cleanup was attempted for the exact temp path that failed.
    expect(unlinkSpy).toHaveBeenCalledWith(tmpArg);
    // No target file was ever created — the failure never reached rename().
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(tmpArg)).toBe(false);
  });

  it('a failing best-effort unlink never masks the real write error', async () => {
    const target = path.join(dir, 'entry.json');
    const boom = new Error('disk full (simulated)');
    vi.mocked(fsPromises.writeFile).mockRejectedValueOnce(boom);
    vi.mocked(fsPromises.unlink).mockRejectedValueOnce(new Error('unlink also failed'));

    await expect(atomicWriteJson(target, { hello: 'world' })).rejects.toThrow(boom);
  });

  it('creates the parent directory if missing', async () => {
    const target = path.join(dir, 'nested', 'deeper', 'entry.json');
    await atomicWriteJson(target, { ok: true });
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ ok: true });
  });
});
