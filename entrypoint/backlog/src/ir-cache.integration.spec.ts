/**
 * ir-cache.integration.spec.ts — FEAT-002's real-hot-path proof: the extract-
 * stage IR cache wired into `entrypoint/backlog`'s ACTUAL BUG-019 call site
 * (`extractClientOperations()`), driven through the REAL BUILT `dist/index.js`
 * exactly like `cli.spec.ts` does (per AGENTS.md §7 — drive the built
 * consumer path, never an in-process bypass). This project's `test` target
 * already `dependsOn: ["build"]`, so `dist/index.js` + `dist/client.d.ts`
 * are always fresh.
 *
 * What is proven, with the repo's verification bar (deterministic, no sleeps,
 * real components):
 *  1. A real `backlog --help` run writes exactly ONE IR-cache entry — the
 *     single `extractClientOperations()` `ExtractCall` on the hot path.
 *  2. A SECOND identical run HITS: the entry file's mtime is unchanged, which
 *     can only mean no `put` happened — i.e. the terminal extractor never ran
 *     (a MISS would overwrite the entry and bump its mtime).
 *  3. After touching ONLY the built `client.d.ts`'s MTIME (content unchanged),
 *     a THIRD run still HITs — proving the cache key is content-addressed on
 *     the real path, not mtime-based. (This is the same teeth as the plugin's
 *     unit-level mtime test, asserted here against the shipped artifact.)
 *  4. After editing the built `client.d.ts`'s ACTUAL CONTENT (a real byte
 *     change, restored afterward), a FOURTH run MISSes and overwrites the
 *     entry (its mtime changes) — the real-content-change-invalidation proof
 *     on the actual built path, closing the gap where only mtime-invariance
 *     (never a genuine content change) had been proven end-to-end.
 *
 * Isolation: `APIGEN_IR_CACHE_FILE` points at a fresh throwaway file and the
 * bin runs with a throwaway `cwd`, so nothing touches the real cache root or
 * the real machine's backlog graph.
 *
 * Revision 2 (design doc R2.2/R2.3/R2.7, implementation spec R2-4/R2-5):
 * RUNTIME CACHE mode targets a single literal file (`APIGEN_IR_CACHE_FILE`),
 * not a directory of many content-addressed entries (`APIGEN_IR_CACHE_DIR`
 * is retired) — assertions switch from "exactly 1 entry in a directory" to
 * "the one cache file's mtime", same intent. A 4th run additionally proves
 * the `APIGEN_IR_CACHE_ENABLED=0` opt-out: the cache file is never created
 * at all when caching is disabled — real extraction, no cache involvement.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = join(HERE, '..', 'dist', 'index.js');
const CLIENT_DTS = join(HERE, '..', 'dist', 'client.d.ts');

/** Spawns the REAL built `backlog` bin with a throwaway cache file/cwd. */
function runHelp(
  cacheFile: string,
  cwd: string,
  extraEnv: Record<string, string> = {}
): { status: number | null } {
  const r = spawnSync(process.execPath, [DIST_INDEX, '--help'], {
    cwd,
    env: { ...process.env, APIGEN_IR_CACHE_FILE: cacheFile, ...extraEnv },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: r.status };
}

describe('FEAT-002 — extract-stage IR cache on the REAL backlog hot path', () => {
  let cacheFile: string;
  let cwd: string;

  afterEach(() => {
    rmSync(dirname(cacheFile), { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it('--help run 1 MISSes and writes one entry; run 2 HITs (no re-extraction); mtime-touch still HITs (content-addressed key)', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'apigen-ir-cache-backlog-'));
    cacheFile = join(cacheDir, 'backlog-client.ir.json');
    cwd = mkdtempSync(join(tmpdir(), 'apigen-ir-cache-cwd-'));

    // Fail loudly if the built artifact this test drives is missing (the
    // project's test target dependsOn build, but a missing dist must turn
    // this suite red, never silently skip — AGENTS.md §7).
    expect(DIST_INDEX, `built bin missing — run "nx build backlog" first: ${DIST_INDEX}`).toSatisfy(
      (p: string) => {
        try {
          return statSync(p).isFile();
        } catch {
          return false;
        }
      }
    );
    expect(CLIENT_DTS, `built client.d.ts missing — run "nx build backlog" first: ${CLIENT_DTS}`).toSatisfy(
      (p: string) => {
        try {
          return statSync(p).isFile();
        } catch {
          return false;
        }
      }
    );

    // Run 1: extraction MISS — the invoker's single ExtractCall writes one entry.
    expect(runHelp(cacheFile, cwd).status).toBe(0);
    expect(existsSync(cacheFile)).toBe(true);
    const mtimeAfterRun1 = statSync(cacheFile).mtimeMs;

    // Run 2: identical input — cache HIT. The entry's mtime is unchanged,
    // which is only possible if no `put` happened: the terminal extractor
    // never ran. (A MISS would overwrite the file and bump its mtime.)
    expect(runHelp(cacheFile, cwd).status).toBe(0);
    expect(statSync(cacheFile).mtimeMs).toBe(mtimeAfterRun1);

    // Touch ONLY the mtime of the built source artifact (content byte-identical).
    const st = statSync(CLIENT_DTS);
    utimesSync(
      CLIENT_DTS,
      new Date(st.atime.getTime() + 60_000),
      new Date(st.mtime.getTime() + 60_000)
    );

    // Run 3: still a HIT — the SLOW GATE recomputes the full content key
    // (sha256 of the source and its transitive imports), NOT mtime-based,
    // finds it unchanged, and returns the cached operations without
    // re-extracting. (Unlike run 2's FAST GATE, the slow-gate HIT DOES
    // fire-and-forget rewrite the entry's staleness snapshot so the NEXT
    // read is fast again — so the file's mtime may change here even though
    // this was a real HIT, not a MISS; the plugin's own unit-level
    // `ir-cache-layer.spec.ts` asserts the extractor-call-count teeth for
    // this exact distinction. This test's job is the real, built end-to-end
    // path: it must still succeed and the file must still exist.)
    expect(runHelp(cacheFile, cwd).status).toBe(0);
    expect(existsSync(cacheFile)).toBe(true);

    // Run 4: EDIT the built source artifact's REAL CONTENT (append a trailing
    // comment — harmless to the extracted type graph, but a genuine byte
    // change, not just an mtime touch) and prove real content-change
    // invalidation on the actual built path: the SLOW GATE's rehash now
    // differs from the cached snapshot, a MISS fires, and the cache entry is
    // overwritten (its mtime changes) — the counterpart to run 3's
    // mtime-invariance proof, closing the previously-flagged gap where only
    // "content unchanged, mtime touched" (never a genuine content change) was
    // exercised against the real built artifact.
    const originalClientDts = readFileSync(CLIENT_DTS, 'utf8');
    const mtimeBeforeRun4 = statSync(cacheFile).mtimeMs;
    try {
      writeFileSync(CLIENT_DTS, `${originalClientDts}\n// FEAT-002 content-invalidation probe\n`);
      expect(runHelp(cacheFile, cwd).status).toBe(0);
      expect(statSync(cacheFile).mtimeMs).not.toBe(mtimeBeforeRun4);
    } finally {
      // Restore the built artifact exactly — this test must not leave the
      // shared `dist/` output mutated for any other test/consumer.
      writeFileSync(CLIENT_DTS, originalClientDts);
    }
  });

  it('APIGEN_IR_CACHE_ENABLED=0 disables caching entirely — no cache file is ever created', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'apigen-ir-cache-backlog-disabled-'));
    cacheFile = join(cacheDir, 'backlog-client.ir.json');
    cwd = mkdtempSync(join(tmpdir(), 'apigen-ir-cache-cwd-disabled-'));

    expect(runHelp(cacheFile, cwd, { APIGEN_IR_CACHE_ENABLED: '0' }).status).toBe(0);
    expect(existsSync(cacheFile)).toBe(false);

    // A second run also succeeds — real extraction every time, no cache
    // involvement at all (the opt-out's behavioral proof).
    expect(runHelp(cacheFile, cwd, { APIGEN_IR_CACHE_ENABLED: '0' }).status).toBe(0);
    expect(existsSync(cacheFile)).toBe(false);
  });
});
