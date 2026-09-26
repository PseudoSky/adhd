/**
 * ir-cache.integration.e2e.ts — FEAT-002's real-hot-path proof for the extract-
 * stage IR cache, updated for the BAKE-AT-BUILD design (Revision 3).
 *
 * Revision 3 changes the default: `--help` now reads the baked
 * `dist/api.ir.json` and never consults the runtime cache at all. So the cache
 * assertions here are driven with the artifact FORCED AWAY (renamed for the
 * duration of the assertions, restored in a `finally`) — the runtime cache's
 * role is now the FALLBACK, and that is exactly what these tests exercise. A
 * separate case proves the default: with the artifact present, `--help`
 * creates NO cache file.
 *
 * What is proven, with the repo's verification bar (deterministic, no sleeps,
 * real components), all against the REAL BUILT `dist/index.js`:
 *  1. Artifact present → `--help` writes no runtime cache.
 *  2. Forced fallback, run 1 MISSes and writes one entry; run 2 HITs (mtime
 *     unchanged ⇒ no `put` ⇒ the terminal extractor never ran).
 *  3. After touching ONLY the built `api.d.ts`'s MTIME (content unchanged), a
 *     third fallback run still HITs — the key is content-addressed.
 *  4. After editing the built `api.d.ts`'s ACTUAL CONTENT (restored after), a
 *     fourth fallback run MISSes and overwrites the entry.
 *  5. `APIGEN_IR_CACHE_ENABLED=0` disables the RUNTIME CACHE (forced fallback
 *     proves it, since the env var governs only that layer now).
 *
 * Isolation: `APIGEN_IR_CACHE_FILE` points at a fresh throwaway file and the
 * bin runs with a throwaway `cwd`/HOME, so nothing touches the real cache root
 * or the real machine's backlog graph. Any `dist/` file mutated/renamed is
 * restored in a `finally`.
 */
import { describe, expect, it, afterEach } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runIsolatedBin } from './test/helpers/spawn-isolated-bin.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = join(HERE, '..', 'dist', 'index.js');
const API_DTS = join(HERE, '..', 'dist', 'api.d.ts');
const API_IR = join(HERE, '..', 'dist', 'api.ir.json');

/** Spawns the REAL built `backlog` bin with a throwaway cache file/cwd. */
function runHelp(
  cacheFile: string,
  cwd: string,
  extraEnv: Record<string, string> = {}
): { status: number | null } {
  const r = runIsolatedBin(DIST_INDEX, ['--help'], cwd, {
    extraEnv: { APIGEN_IR_CACHE_FILE: cacheFile, ...extraEnv },
    timeoutMs: 120_000,
  });
  return { status: r.status };
}

/** Rename `api.ir.json` away, run `fn` (the fallback path), always restore. */
function withForcedFallback<T>(fn: () => T): T {
  const backup = `${API_IR}.integration-backup`;
  renameSync(API_IR, backup);
  try {
    return fn();
  } finally {
    renameSync(backup, API_IR);
  }
}

function assertBuilt(): void {
  for (const p of [DIST_INDEX, API_DTS, API_IR]) {
    expect(
      (() => {
        try {
          return statSync(p).isFile();
        } catch {
          return false;
        }
      })(),
      `built artifact missing — run "nx build backlog" first: ${p}`
    ).toBe(true);
  }
}

describe('FEAT-002 — extract-stage IR cache on the REAL backlog hot path', () => {
  let cacheFile: string;
  let cwd: string;

  afterEach(() => {
    rmSync(dirname(cacheFile), { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  function freshPaths(tag: string): void {
    const cacheDir = mkdtempSync(join(tmpdir(), `apigen-ir-cache-backlog-${tag}-`));
    cacheFile = join(cacheDir, 'backlog-client.ir.json');
    cwd = mkdtempSync(join(tmpdir(), `apigen-ir-cache-cwd-${tag}-`));
  }

  it('with the baked artifact present, `--help` writes NO runtime cache entry', () => {
    assertBuilt();
    freshPaths('baked');
    expect(runHelp(cacheFile, cwd).status).toBe(0);
    expect(existsSync(cacheFile)).toBe(false);
  });

  it('forced fallback: run 1 MISSes + writes one entry; run 2 HITs; mtime-touch still HITs; content change MISSes', () => {
    assertBuilt();
    freshPaths('fallback');

    withForcedFallback(() => {
      // Run 1: extraction MISS — the invoker's single ExtractCall writes one entry.
      expect(runHelp(cacheFile, cwd).status).toBe(0);
      expect(existsSync(cacheFile)).toBe(true);
      const mtimeAfterRun1 = statSync(cacheFile).mtimeMs;

      // Run 2: identical input — cache HIT. The entry's mtime is unchanged,
      // which is only possible if no `put` happened.
      expect(runHelp(cacheFile, cwd).status).toBe(0);
      expect(statSync(cacheFile).mtimeMs).toBe(mtimeAfterRun1);

      // Touch ONLY the mtime of the built source artifact (content identical).
      const st = statSync(API_DTS);
      utimesSync(
        API_DTS,
        new Date(st.atime.getTime() + 60_000),
        new Date(st.mtime.getTime() + 60_000)
      );

      // Run 3: still a HIT — the SLOW GATE recomputes the full content key,
      // finds it unchanged, and returns the cached operations.
      expect(runHelp(cacheFile, cwd).status).toBe(0);
      expect(existsSync(cacheFile)).toBe(true);

      // Run 4: EDIT the built source artifact's REAL CONTENT → SLOW GATE
      // rehash differs → MISS → the entry is overwritten (mtime changes).
      const originalApiDts = readFileSync(API_DTS, 'utf8');
      const mtimeBeforeRun4 = statSync(cacheFile).mtimeMs;
      try {
        writeFileSync(
          API_DTS,
          `${originalApiDts}\n// FEAT-002 content-invalidation probe\n`
        );
        expect(runHelp(cacheFile, cwd).status).toBe(0);
        expect(statSync(cacheFile).mtimeMs).not.toBe(mtimeBeforeRun4);
      } finally {
        writeFileSync(API_DTS, originalApiDts);
      }
    });
  });

  it('APIGEN_IR_CACHE_ENABLED=0 disables the runtime cache (forced fallback)', () => {
    assertBuilt();
    freshPaths('disabled');
    withForcedFallback(() => {
      expect(
        runHelp(cacheFile, cwd, { APIGEN_IR_CACHE_ENABLED: '0' }).status
      ).toBe(0);
      expect(existsSync(cacheFile)).toBe(false);

      // A second run also succeeds — real extraction every time.
      expect(
        runHelp(cacheFile, cwd, { APIGEN_IR_CACHE_ENABLED: '0' }).status
      ).toBe(0);
      expect(existsSync(cacheFile)).toBe(false);
    });
  });
});
