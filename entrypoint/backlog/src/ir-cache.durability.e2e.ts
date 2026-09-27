/**
 * ir-cache.durability.e2e.ts — the REAL-PROCESS teeth for the awaited/durable
 * write contract (design doc Revision 3). Drives the built `dist/index.js` on
 * its FALLBACK path (the baked artifact is renamed away for the duration) and
 * SIGKILLs the child on its FIRST stdout byte, then asserts the runtime cache
 * file is nonetheless a complete, valid entry.
 *
 * WHY that is the right observable: the MISS write is now AWAITED, so by the
 * time the CLI can print anything to stdout, the cache entry has been
 * fsync'd and renamed into place. Before the fix (fire-and-forget), the
 * process could be killed with the write still in flight and lose it. The
 * deterministic, non-timing teeth live in the plugin's unit spec
 * (`ir-cache-layer.spec.ts` — a latched `rename`); this is the end-to-end
 * corroboration through the real binary.
 *
 * A second run against the same cache MUST be a HIT — the entry's mtime is
 * unchanged, which is only possible if no `put` happened (the terminal
 * extractor never ran).
 *
 * ISOLATION (2026-09-26): this suite runs the REAL built bin from a PRIVATE
 * copy of `dist/` (`createIsolatedDist`, under the gitignored `tmp/`), so the
 * `api.ir.json` it renames away is its OWN. It previously renamed the SHARED
 * in-tree `entrypoint/backlog/dist/api.ir.json`; a concurrent `vite build`
 * (`emptyOutDir: true`) or nx directory-output cache restore deletes the whole
 * `dist/` dir, which could remove the renamed-away backup between the rename
 * and the `finally` restore and make the restore throw `ENOENT` — the red-gate
 * defect this closes. The copy is a faithful stand-in because
 * `backlogDistDir()` resolves the artifact from the RUNNING module's own
 * directory. The temp cache/cwd and the private copy are removed afterwards,
 * and nothing under `~/.adhd` is touched (isolated HOME).
 */
import { describe, expect, it, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isolatedSpawnOptions,
  runIsolatedBin,
} from './test/helpers/spawn-isolated-bin.js';
import {
  createIsolatedDist,
  type IsolatedDist,
} from './test/helpers/isolated-dist.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHARED_DIST = join(HERE, '..', 'dist');
const SHARED_INDEX = join(SHARED_DIST, 'index.js');
const SHARED_API_DTS = join(SHARED_DIST, 'api.d.ts');
const SHARED_API_IR = join(SHARED_DIST, 'api.ir.json');

let root: string;
let cacheDir: string;
let iso: IsolatedDist | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
  iso?.cleanup();
  iso = undefined;
});

describe('IR-cache durability — a SIGKILL right after stdout still leaves a valid entry', () => {
  it('never loses the MISS write: the entry is complete and durable, and a respawn HITs', async () => {
    // Fail loudly if the built dist is missing — never silently skip.
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

    // Run against a PRIVATE copy of the built dist — never the shared in-tree
    // output that sibling suites read and a concurrent build may wipe.
    iso = createIsolatedDist(SHARED_DIST, 'durability');
    const DIST_INDEX = iso.indexPath;
    const API_IR = iso.apiIrPath;

    root = mkdtempSync(join(tmpdir(), 'backlog-ircache-durability-'));
    cacheDir = mkdtempSync(join(tmpdir(), 'backlog-ircache-durability-cache-'));
    const cacheFile = join(cacheDir, 'backlog-client.ir.json');

    // Force the FALLBACK path so the runtime cache is actually exercised.
    const backup = `${API_IR}.durability-backup`;
    renameSync(API_IR, backup);
    try {
      // `get --help` (a PER-VERB help), NOT a bare top-level `--help`: the
      // top-level form prints its "Special commands" banner BEFORE
      // `buildBacklogApigenPackage` runs, so its first stdout byte precedes the
      // extraction. A per-verb help emits nothing until after the package is
      // built (and the MISS write completed), so the first stdout byte is the
      // right post-write kill point.
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [DIST_INDEX, 'get', '--help'], {
          ...isolatedSpawnOptions(root, { APIGEN_IR_CACHE_FILE: cacheFile }),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let killed = false;
        child.stdout.on('data', () => {
          if (!killed) {
            killed = true;
            // SIGKILL — no cleanup handlers, no graceful drain.
            child.kill('SIGKILL');
          }
        });
        child.on('error', reject);
        child.on('exit', () => resolve());
      });

      // The awaited write must have completed before stdout existed.
      expect(existsSync(cacheFile)).toBe(true);
      const entry = JSON.parse(readFileSync(cacheFile, 'utf8')) as {
        formatVersion: number;
        extractorVersion: string;
        operations: unknown[];
      };
      expect(entry.formatVersion).toBeGreaterThan(0);
      expect(typeof entry.extractorVersion).toBe('string');
      expect(entry.operations.length).toBeGreaterThan(0);
      const mtimeAfterKill = statSync(cacheFile).mtimeMs;

      // Respawn → the same source is a HIT: no `put`, so the mtime is intact.
      const r = runIsolatedBin(DIST_INDEX, ['get', '--help'], root, {
        extraEnv: { APIGEN_IR_CACHE_FILE: cacheFile },
        timeoutMs: 120_000,
      });
      expect(r.status, r.stderr).toBe(0);
      expect(statSync(cacheFile).mtimeMs).toBe(mtimeAfterKill);
    } finally {
      renameSync(backup, API_IR);
    }
  }, 180_000);
});
