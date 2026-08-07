/**
 * Real end-to-end proof that `@adhd/apigen-plugin-ir-cache`'s exported
 * `irCachePlugin` is actually RESOLVABLE from the real `apigen-cli` binary
 * (`entrypoint/apigen-cli/dist/index.js`) — the gap the finding this test
 * closes describes: before this fix, neither `--type ir-cache` (ARTIFACT
 * mode, the `target` capability) nor `--use ir-cache` (RUNTIME CACHE mode,
 * the `extractLayer` capability) could resolve at all from the shipped CLI,
 * because the plugin was never registered into `index.ts`'s `--type`
 * `plugins` map or `run.ts`'s `BUILTIN_USE_PLUGINS`, and `apigen-cli`'s own
 * `package.json` didn't even depend on the package.
 *
 * This spawns the BUILT bin (never imports/reaches inside it) exactly the
 * way the design doc's own worked examples (R2.4, R2.6 item 4) invoke it:
 *
 *   apigen generate --type ir-cache --opt cache=artifact ...
 *   apigen generate --type <transport> --use ir-cache --opt cache=<file> ...
 *
 * and asserts on the REAL artifacts these commands are supposed to produce
 * (a `CachedExtractEntry`-shaped JSON file at the ARTIFACT-mode output path,
 * and a real RUNTIME-CACHE-mode cache file with a `staleness` snapshot) —
 * not just "the process exited 0". A negative control (git-stash-style
 * revert of the registration alone, verified manually during development —
 * `Unknown --type: ir-cache`) is what this spec would have caught on day
 * one; keeping it default-running (no env gate — nothing here calls a paid
 * third-party service, CLAUDE.md §7 "Live testing is mandatory") is what
 * keeps it caught.
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

/** Every `CachedExtractEntry` shape, per `ir-cache-layer.ts`. */
interface CachedExtractEntryLike {
  formatVersion: number;
  operations: Array<{ id: string }>;
  extractorVersion: string;
  createdAt: string;
  staleness?: {
    contentKey: string;
    source: { path: string; mtimeMs: number };
    deps: Array<{ path: string; mtimeMs: number }>;
  };
}

function runCli(args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync(process.execPath, [BUILT_BIN, ...args], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
}

let tmpDirs: string[] = [];
function mkTmpDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'apigen-ir-cache-registration-')
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

describe('ir-cache plugin registration — real built apigen-cli bin', () => {
  it('`apigen list-types` (--type registry) lists ir-cache', () => {
    const out = runCli(['list-types']);
    expect(out).toContain('ir-cache');
  });

  it('`--type ir-cache --opt cache=artifact` (ARTIFACT mode / target capability) produces a real CachedExtractEntry artifact — not "Unknown --type: ir-cache"', () => {
    const outDir = mkTmpDir();

    // Would throw (non-zero exit, execFileSync throws on failure) with
    // "Unknown --type: ir-cache" before this fix — the plugin was never in
    // index.ts's `plugins` map at all.
    runCli([
      'generate',
      '--source',
      ALPHA_SRC,
      '--type',
      'ir-cache',
      '--out-dir',
      outDir,
      '--namespace',
      'alpha',
      '--opt',
      'cache=artifact',
    ]);

    const artifactPath = path.join(outDir, 'ir-cache.json');
    expect(fs.existsSync(artifactPath)).toBe(true);

    const entry = JSON.parse(
      fs.readFileSync(artifactPath, 'utf8')
    ) as CachedExtractEntryLike;

    expect(entry.formatVersion).toBe(1);
    expect(typeof entry.extractorVersion).toBe('string');
    expect(entry.extractorVersion.length).toBeGreaterThan(0);
    expect(typeof entry.createdAt).toBe('string');
    // ARTIFACT mode never carries a staleness snapshot (design doc R2.4).
    expect(entry.staleness).toBeUndefined();
    // Real extraction happened: alpha.ts exports exactly one API function
    // (getUser; `__samples__` is not an operation). `project()`'s naming
    // convention kebab-cases + namespaces the id (`alpha/alpha/get-user`),
    // so match on the kebab-cased path segment rather than the raw export
    // name.
    expect(entry.operations).toHaveLength(1);
    expect(entry.operations[0]?.id).toContain('get-user');
  });

  it('`--type ir-cache` without `--opt cache=artifact` fails with the plugin\'s own guard error, proving the REAL target.generate() ran (not a stub)', () => {
    const outDir = mkTmpDir();
    expect(() =>
      runCli([
        'generate',
        '--source',
        ALPHA_SRC,
        '--type',
        'ir-cache',
        '--out-dir',
        outDir,
        '--namespace',
        'alpha',
      ])
    ).toThrowError(/requires --opt cache=artifact/);
  });

  it('`--use ir-cache` (RUNTIME CACHE mode / extractLayer capability) writes a real cache file with a staleness snapshot — not "Unknown --use ir-cache"', () => {
    const outDir = mkTmpDir();
    const cacheDir = mkTmpDir();
    const cacheFile = path.join(cacheDir, 'alpha.ir-cache.json');

    // `irCachePlugin`'s default `extractLayer.layer` resolves its cache-file
    // path from `APIGEN_IR_CACHE_FILE` (see apigen-plugin-ir-cache/src/
    // index.ts's module doc: `Plugin.capabilities.extractLayer.layer` has no
    // per-invocation `opts` parameter today, so the shipped default reads
    // env vars, matching entrypoint/backlog/src/server.ts's existing
    // pattern) — NOT `--opt cache=`. `--opt cache=` configures ARTIFACT mode
    // (`--type ir-cache`, tested above) whose `target.generate()` DOES
    // receive `opts` per-invocation.
    //
    // Would throw before this fix — `ir-cache` was never in run.ts's
    // BUILTIN_USE_PLUGINS, so loadUsePlugins() fell through to dynamic-
    // import resolution of the bare slug `ir-cache` and failed with
    // "Cannot find module 'ir-cache'".
    runCli(
      [
        'generate',
        '--source',
        ALPHA_SRC,
        '--type',
        'cli-output',
        '--out-dir',
        outDir,
        '--namespace',
        'alpha',
        '--use',
        'ir-cache',
      ],
      { APIGEN_IR_CACHE_FILE: cacheFile }
    );

    expect(fs.existsSync(cacheFile)).toBe(true);
    const entry = JSON.parse(
      fs.readFileSync(cacheFile, 'utf8')
    ) as CachedExtractEntryLike;

    expect(entry.formatVersion).toBe(1);
    expect(entry.operations).toHaveLength(1);
    expect(entry.operations[0]?.id).toContain('get-user');
    // RUNTIME CACHE mode always writes a staleness snapshot on a fresh MISS
    // write (design doc R2.3) — this is what the ARTIFACT-mode entry above
    // deliberately lacks, proving the two modes are genuinely distinct code
    // paths, both real, both reachable from the shipped CLI.
    expect(entry.staleness).toBeDefined();
    expect(entry.staleness?.source.path).toContain('alpha.ts');
    expect(typeof entry.staleness?.contentKey).toBe('string');
  });

  it('`--use ir-cache --opt cache=<path>` reuses the cache on a SECOND real CLI run — no re-extraction (mtime unchanged)', () => {
    const outDir1 = mkTmpDir();
    const outDir2 = mkTmpDir();
    const cacheDir = mkTmpDir();
    const cacheFile = path.join(cacheDir, 'alpha-2nd-run.ir-cache.json');

    const args = [
      'generate',
      '--source',
      ALPHA_SRC,
      '--type',
      'cli-output',
      '--namespace',
      'alpha',
      '--use',
      'ir-cache',
      '--opt',
      `cache=${cacheFile}`,
    ];

    // Run 1: MISS — real extraction, cache file written.
    runCli([...args, '--out-dir', outDir1]);
    expect(fs.existsSync(cacheFile)).toBe(true);
    const mtimeAfterRun1 = fs.statSync(cacheFile).mtimeMs;
    const entryAfterRun1 = JSON.parse(
      fs.readFileSync(cacheFile, 'utf8')
    ) as CachedExtractEntryLike;
    expect(entryAfterRun1.staleness).toBeDefined();

    // Run 2: identical source, different --out-dir (proves the HIT is keyed
    // on source content, not incidentally on output location) — should HIT.
    // The entry file's mtime is unchanged, which is only possible if no
    // `put` happened: the terminal extractor never re-ran on run 2.
    runCli([...args, '--out-dir', outDir2]);
    expect(fs.statSync(cacheFile).mtimeMs).toBe(mtimeAfterRun1);

    // The generated output from run 2 is still correct — a HIT returns the
    // real cached operations, not an empty/stub result.
    const generatedFiles = fs.readdirSync(outDir2);
    expect(generatedFiles.length).toBeGreaterThan(0);
  });

  it('ARTIFACT mode -> RUNTIME CACHE mode interop: a real generated artifact is consumed by a real --use run, revalidates once, then fast-HITs', () => {
    const artifactDir = mkTmpDir();
    const outDir1 = mkTmpDir();
    const outDir2 = mkTmpDir();
    const artifactFile = path.join(artifactDir, 'ir-cache.json');

    // Step 1: produce a real ARTIFACT-mode entry via the real CLI.
    runCli([
      'generate',
      '--source',
      ALPHA_SRC,
      '--type',
      'ir-cache',
      '--out-dir',
      artifactDir,
      '--namespace',
      'alpha',
      '--opt',
      'cache=artifact',
    ]);
    expect(fs.existsSync(artifactFile)).toBe(true);
    const artifactEntry = JSON.parse(
      fs.readFileSync(artifactFile, 'utf8')
    ) as CachedExtractEntryLike;
    // ARTIFACT mode never carries a staleness snapshot (design doc R2.4) —
    // this is the precondition for what step 2 must prove.
    expect(artifactEntry.staleness).toBeUndefined();

    const useArgs = [
      'generate',
      '--source',
      ALPHA_SRC,
      '--type',
      'cli-output',
      '--namespace',
      'alpha',
      '--use',
      'ir-cache',
      '--opt',
      `cache=${artifactFile}`,
    ];

    // Step 2: point a real --use run at that SAME artifact file. Per the
    // MUST_FIX fix (an entry with no `staleness` snapshot is folded into the
    // MISS path, never blindly trusted) this must cost exactly ONE real
    // revalidation extraction — the entry is rewritten in place, now WITH a
    // staleness snapshot, so cross-mode switching costs one real extraction,
    // not zero and not silent trust of unverified data.
    runCli([...useArgs, '--out-dir', outDir1]);
    const entryAfterStep2 = JSON.parse(
      fs.readFileSync(artifactFile, 'utf8')
    ) as CachedExtractEntryLike;
    expect(entryAfterStep2.staleness).toBeDefined();
    expect(entryAfterStep2.staleness?.source.path).toContain('alpha.ts');
    const mtimeAfterStep2 = fs.statSync(artifactFile).mtimeMs;

    // Step 3: run again — now a genuine fast-gate HIT. mtime unchanged from
    // step 2, proving the third invocation did NOT re-extract.
    runCli([...useArgs, '--out-dir', outDir2]);
    expect(fs.statSync(artifactFile).mtimeMs).toBe(mtimeAfterStep2);
    expect(fs.readdirSync(outDir2).length).toBeGreaterThan(0);
  });
});
