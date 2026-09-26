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
 * The renamed artifact is restored in a `finally`; the temp cache/cwd are
 * removed afterwards. Nothing under `~/.adhd` is touched (isolated HOME).
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

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = join(HERE, '..', 'dist', 'index.js');
const API_DTS = join(HERE, '..', 'dist', 'api.d.ts');
const API_IR = join(HERE, '..', 'dist', 'api.ir.json');

let root: string;
let cacheDir: string;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
});

describe('IR-cache durability — a SIGKILL right after stdout still leaves a valid entry', () => {
  it('never loses the MISS write: the entry is complete and durable, and a respawn HITs', async () => {
    // Fail loudly if the built dist is missing — never silently skip.
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
