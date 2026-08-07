/**
 * Real end-to-end proof that the generic `--use`-driven extract-stage
 * composition (`orchestrator.ts`'s `buildDescriptor()` -> `extractSource()`,
 * shared by every `--type` target via `orchestrateGenerate`) actually
 * benefits a target OTHER than `ir-cache`/`cli-output` — not something
 * special-cased for the plugin's own `--type`.
 *
 * `api-fastify` is chosen because it's a real, already-registered `--type`
 * target (`entrypoint/apigen-cli/src/index.ts`'s `plugins['api-fastify']`)
 * with no extra runtime dependency (unlike `py-flask`/`py-grpc`, which spawn
 * python3) and produces real generated files, so a HIT/MISS distinction is
 * meaningful (a target that produced nothing wouldn't prove much).
 *
 * Spawns the BUILT bin (never imports/reaches inside it), same pattern as
 * `ir-cache-plugin-registration.spec.ts`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const BUILT_BIN = path.join(
  REPO_ROOT,
  'entrypoint',
  'apigen-cli',
  'dist',
  'index.js'
);
const ALPHA_SRC = path.join(__dirname, '..', 'fixtures', 'alpha.ts');

function runCli(args: string[]): string {
  return execFileSync(process.execPath, [BUILT_BIN, ...args], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

let tmpDirs: string[] = [];
function mkTmpDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'apigen-ir-cache-cross-target-')
  );
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe('ir-cache — cross-target proof (api-fastify, not ir-cache/cli-output itself)', () => {
  it('`--type api-fastify --use ir-cache` run 1 MISSes and writes both the fastify output AND a cache entry; run 2 HITs (no re-extraction)', () => {
    expect(
      fs.existsSync(BUILT_BIN),
      `built bin missing — run "nx build apigen-cli" first: ${BUILT_BIN}`
    ).toBe(true);

    const outDir = mkTmpDir();
    const cacheDir = mkTmpDir();
    const cacheFile = path.join(cacheDir, 'cross-target.ir.json');

    const args = [
      'generate',
      '--source',
      ALPHA_SRC,
      '--type',
      'api-fastify',
      '--out-dir',
      outDir,
      '--namespace',
      'alpha',
      '--use',
      'ir-cache',
      '--opt',
      `cache=${cacheFile}`,
    ];

    // Run 1: real extraction (MISS) — the fastify target's own real output
    // AND a real ir-cache entry both get produced.
    runCli(args);

    const fastifyFiles = fs.readdirSync(outDir);
    expect(fastifyFiles.length).toBeGreaterThan(0);
    expect(fs.existsSync(cacheFile)).toBe(true);

    const entryAfterRun1 = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as {
      operations: Array<{ id: string }>;
      staleness?: unknown;
    };
    expect(entryAfterRun1.operations).toHaveLength(1);
    expect(entryAfterRun1.operations[0]?.id).toContain('get-user');
    // First write into an empty single-file cache has no staleness snapshot
    // to compare against yet, so it's a MISS -> write with a fresh snapshot.
    expect(entryAfterRun1.staleness).toBeDefined();
    const mtimeAfterRun1 = fs.statSync(cacheFile).mtimeMs;

    // Run 2: identical input, different (fresh) out-dir so the fastify
    // target's own file-write doesn't short-circuit anything — isolates the
    // proof to the extract-stage cache specifically. Cache file mtime must
    // be UNCHANGED: the fast gate stat()-matches and the terminal extractor
    // never runs a second time.
    const outDir2 = mkTmpDir();
    runCli([
      'generate',
      '--source',
      ALPHA_SRC,
      '--type',
      'api-fastify',
      '--out-dir',
      outDir2,
      '--namespace',
      'alpha',
      '--use',
      'ir-cache',
      '--opt',
      `cache=${cacheFile}`,
    ]);

    expect(fs.readdirSync(outDir2).length).toBeGreaterThan(0);
    expect(fs.statSync(cacheFile).mtimeMs).toBe(mtimeAfterRun1);
  });
});
