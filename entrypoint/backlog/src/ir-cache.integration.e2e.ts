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
 * ISOLATION (2026-09-26): runs the REAL built bin from a PRIVATE copy of
 * `dist/` (`createIsolatedDist`, under the gitignored `tmp/`), so the
 * `api.ir.json` renamed away and the `api.d.ts` mtime-touched/edited are this
 * suite's OWN. It previously mutated the SHARED in-tree
 * `entrypoint/backlog/dist/`; a concurrent `vite build` (`emptyOutDir: true`)
 * or nx directory-output cache restore deletes the whole `dist/` dir, and while
 * this suite held the shared artifact renamed away every sibling read the same
 * output — the red-gate defect this closes. `APIGEN_IR_CACHE_FILE` still points
 * at a fresh throwaway file and the bin runs with a throwaway `cwd`/HOME, so
 * nothing touches the real cache root or the real machine's backlog graph. The
 * private copy is removed in `afterEach`.
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
import {
  createIsolatedDist,
  type IsolatedDist,
} from './test/helpers/isolated-dist.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHARED_DIST = join(HERE, '..', 'dist');
const SHARED_INDEX = join(SHARED_DIST, 'index.js');
const SHARED_API_DTS = join(SHARED_DIST, 'api.d.ts');
const SHARED_API_IR = join(SHARED_DIST, 'api.ir.json');

/** Spawns the REAL built `backlog` bin with a throwaway cache file/cwd. */
function runHelp(
  binPath: string,
  cacheFile: string,
  cwd: string,
  extraEnv: Record<string, string> = {}
): { status: number | null } {
  const r = runIsolatedBin(binPath, ['--help'], cwd, {
    extraEnv: { APIGEN_IR_CACHE_FILE: cacheFile, ...extraEnv },
    timeoutMs: 120_000,
  });
  return { status: r.status };
}

/**
 * Rename this suite's PRIVATE copy of `api.ir.json` away, run `fn` (the
 * fallback path), always restore.
 */
function withForcedFallback<T>(privateApiIr: string, fn: () => T): T {
  const backup = `${privateApiIr}.integration-backup`;
  renameSync(privateApiIr, backup);
  try {
    return fn();
  } finally {
    renameSync(backup, privateApiIr);
  }
}

function assertBuilt(): void {
  for (const p of [SHARED_INDEX, SHARED_API_DTS, SHARED_API_IR]) {
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
  let iso: IsolatedDist | undefined;

  afterEach(() => {
    rmSync(dirname(cacheFile), { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    iso?.cleanup();
    iso = undefined;
  });

  function freshPaths(tag: string): void {
    const cacheDir = mkdtempSync(join(tmpdir(), `apigen-ir-cache-backlog-${tag}-`));
    cacheFile = join(cacheDir, 'backlog-client.ir.json');
    cwd = mkdtempSync(join(tmpdir(), `apigen-ir-cache-cwd-${tag}-`));
    iso = createIsolatedDist(SHARED_DIST, `integration-${tag}`);
  }

  it('with the baked artifact present, `--help` writes NO runtime cache entry', () => {
    assertBuilt();
    freshPaths('baked');
    expect(runHelp(iso!.indexPath, cacheFile, cwd).status).toBe(0);
    expect(existsSync(cacheFile)).toBe(false);
  });

  it('forced fallback: run 1 MISSes + writes one entry; run 2 HITs; mtime-touch still HITs; content change MISSes', () => {
    assertBuilt();
    freshPaths('fallback');
    const binPath = iso!.indexPath;
    const privateApiDts = iso!.apiDtsPath;

    withForcedFallback(iso!.apiIrPath, () => {
      // Run 1: extraction MISS — the invoker's single ExtractCall writes one entry.
      expect(runHelp(binPath, cacheFile, cwd).status).toBe(0);
      expect(existsSync(cacheFile)).toBe(true);
      const mtimeAfterRun1 = statSync(cacheFile).mtimeMs;

      // Run 2: identical input — cache HIT. The entry's mtime is unchanged,
      // which is only possible if no `put` happened.
      expect(runHelp(binPath, cacheFile, cwd).status).toBe(0);
      expect(statSync(cacheFile).mtimeMs).toBe(mtimeAfterRun1);

      // Touch ONLY the mtime of the private built source artifact (content
      // identical).
      const st = statSync(privateApiDts);
      utimesSync(
        privateApiDts,
        new Date(st.atime.getTime() + 60_000),
        new Date(st.mtime.getTime() + 60_000)
      );

      // Run 3: still a HIT — the SLOW GATE recomputes the full content key,
      // finds it unchanged, and returns the cached operations.
      expect(runHelp(binPath, cacheFile, cwd).status).toBe(0);
      expect(existsSync(cacheFile)).toBe(true);

      // Run 4: EDIT the private built source artifact's REAL CONTENT → SLOW
      // GATE rehash differs → MISS → the entry is overwritten (mtime changes).
      const originalApiDts = readFileSync(privateApiDts, 'utf8');
      const mtimeBeforeRun4 = statSync(cacheFile).mtimeMs;
      try {
        writeFileSync(
          privateApiDts,
          `${originalApiDts}\n// FEAT-002 content-invalidation probe\n`
        );
        expect(runHelp(binPath, cacheFile, cwd).status).toBe(0);
        expect(statSync(cacheFile).mtimeMs).not.toBe(mtimeBeforeRun4);
      } finally {
        writeFileSync(privateApiDts, originalApiDts);
      }
    });
  });

  it('APIGEN_IR_CACHE_ENABLED=0 disables the runtime cache (forced fallback)', () => {
    assertBuilt();
    freshPaths('disabled');
    withForcedFallback(iso!.apiIrPath, () => {
      expect(
        runHelp(iso!.indexPath, cacheFile, cwd, { APIGEN_IR_CACHE_ENABLED: '0' })
          .status
      ).toBe(0);
      expect(existsSync(cacheFile)).toBe(false);

      // A second run also succeeds — real extraction every time.
      expect(
        runHelp(iso!.indexPath, cacheFile, cwd, { APIGEN_IR_CACHE_ENABLED: '0' })
          .status
      ).toBe(0);
      expect(existsSync(cacheFile)).toBe(false);
    });
  });
});
