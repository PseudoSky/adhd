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
 *
 * Isolation: `APIGEN_IR_CACHE_DIR` points at a fresh throwaway dir and the
 * bin runs with a throwaway `cwd`, so nothing touches the real cache root or
 * the real machine's backlog graph.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = join(HERE, '..', 'dist', 'index.js');
const CLIENT_DTS = join(HERE, '..', 'dist', 'client.d.ts');

/** Spawns the REAL built `backlog` bin with a throwaway cache dir. */
function runHelp(cacheDir: string, cwd: string): { status: number | null } {
  const r = spawnSync(process.execPath, [DIST_INDEX, '--help'], {
    cwd,
    env: { ...process.env, APIGEN_IR_CACHE_DIR: cacheDir },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: r.status };
}

function entryFiles(cacheDir: string): string[] {
  return readdirSync(cacheDir).filter((f) => f.endsWith('.json'));
}

function entryMtimeMs(cacheDir: string, files: string[]): number {
  return statSync(join(cacheDir, files[0])).mtimeMs;
}

describe('FEAT-002 — extract-stage IR cache on the REAL backlog hot path', () => {
  let cacheDir: string;
  let cwd: string;

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it('--help run 1 MISSes and writes one entry; run 2 HITs (no re-extraction); mtime-touch still HITs (content-addressed key)', () => {
    cacheDir = mkdtempSync(join(tmpdir(), 'apigen-ir-cache-backlog-'));
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
    expect(runHelp(cacheDir, cwd).status).toBe(0);
    let files = entryFiles(cacheDir);
    expect(files.length).toBe(1);
    const mtimeAfterRun1 = entryMtimeMs(cacheDir, files);

    // Run 2: identical input — cache HIT. The entry's mtime is unchanged,
    // which is only possible if no `put` happened: the terminal extractor
    // never ran. (A MISS would overwrite the same key file and bump its mtime.)
    expect(runHelp(cacheDir, cwd).status).toBe(0);
    files = entryFiles(cacheDir);
    expect(files.length).toBe(1);
    expect(entryMtimeMs(cacheDir, files)).toBe(mtimeAfterRun1);

    // Touch ONLY the mtime of the built source artifact (content byte-identical).
    const st = statSync(CLIENT_DTS);
    utimesSync(
      CLIENT_DTS,
      new Date(st.atime.getTime() + 60_000),
      new Date(st.mtime.getTime() + 60_000)
    );

    // Run 3: still a HIT — the key is content-addressed (sha256 of the source
    // and its transitive imports), NOT mtime-based. A mtime-keyed cache would
    // MISS here, produce a new key, and add a second entry.
    expect(runHelp(cacheDir, cwd).status).toBe(0);
    files = entryFiles(cacheDir);
    expect(files.length).toBe(1);
    expect(entryMtimeMs(cacheDir, files)).toBe(mtimeAfterRun1);
  });
});
