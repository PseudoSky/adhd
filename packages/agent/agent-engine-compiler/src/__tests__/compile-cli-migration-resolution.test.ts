/**
 * compile-cli-migration-resolution.test.ts
 *
 * Regression test for the sibling-migration-folder resolution bug in
 * `cli/compile.ts` (BUG: `AI_DIST = path.resolve(__dirname, '../../../')`
 * assumed a monolithic dist tree — `dist/packages/agent/<pkg>/drizzle` —
 * that does not exist in this per-project-`dist` monorepo. Each package
 * builds to its OWN `{projectRoot}/dist` via `@nx/js:tsc`, so that 3-hop
 * relative-path math resolved to a nonexistent directory for every sibling,
 * the `fs.existsSync` guard silently skipped all 5 migration sets, and the
 * CLI went on to crash with `no such table: registry_agents`).
 *
 * Drives the REAL built bin as a real child process (`spawnSync`) against a
 * REAL on-disk temp SQLite file, resolving sibling `@adhd/*` packages via
 * the ACTUAL pnpm workspace `node_modules/@adhd/*` symlinks already present
 * on disk — no test-only symlink patching, no in-process shortcuts. This is
 * the exact path a consumer hits.
 *
 * Proves:
 *   - NO `migration folder not found` warning is emitted for ANY of the 5
 *     sibling/own migration sets.
 *   - The migration directories the fix resolves actually EXIST on disk
 *     (independently re-derived here via the same require.resolve +
 *     walk-up-to-package.json approach, so this test doesn't just trust the
 *     production code's own resolution).
 *   - The bin does NOT fail with `no such table` — i.e. all 5 migration
 *     sets were actually applied to the fresh DB.
 *   - It DOES fail with a normal "not found" domain error for an unknown
 *     slug (proving migrations ran far enough to reach real query logic,
 *     not that the bin crashed before doing any work).
 *
 * RED with the OLD code (`AI_DIST` 3-hop constant): every sibling migration
 * folder resolves to a nonexistent
 * `<dist>/agent-engine-compiler/<sibling>/drizzle` path, so this suite's
 * first assertion (no "migration folder not found" on stderr) FAILS — the
 * old code emits exactly that warning 5 times — and the process then goes
 * on to throw `no such table: registry_agents`, failing the second and
 * third assertions too. Verified live during this fix's development by
 * temporarily restoring the old `AI_DIST` constant and re-running this
 * suite: all three assertions went red with that exact output.
 *
 * GREEN with the fix (`resolveSiblingDrizzle` / `resolveOwnDrizzle` walking
 * up from each package's real module-resolution entry point to its
 * `package.json`-declared root): no warnings, all migration dirs exist,
 * "no such table" never appears, and the unknown-slug run fails with a
 * clean domain "not found" error instead.
 *
 * Gate on the child's EXIT CODE and full stderr text — never on
 * `| grep -q passed` (CLAUDE.md verification standard #4).
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// packages/agent/agent-engine-compiler/src/__tests__/ -> repo root (5 hops up)
const REPO_ROOT = path.resolve(__dirname, '../../../../../');
const PKG_ROOT = path.resolve(__dirname, '../../');
const BIN = path.join(PKG_ROOT, 'dist/src/cli/compile.js');

const require = createRequire(import.meta.url);

/**
 * Independently re-derive `<pkgRoot>/drizzle` for a package via real Node
 * module resolution + walk-up-to-package.json — deliberately NOT importing
 * the production `resolveSiblingDrizzle` helper, so this test doesn't just
 * assert "the code agrees with itself". This proves the directories the fix
 * is supposed to find actually exist independently of the code under test.
 */
function independentlyResolveDrizzleDir(pkgName: string): string {
  const entryFile = require.resolve(pkgName);
  let dir = path.dirname(entryFile);
  for (let hop = 0; hop <= 20; hop++) {
    const pkgJsonPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as {
        name?: string;
      };
      if (pkgJson.name === pkgName) {
        return path.join(dir, 'drizzle');
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`test setup: could not resolve package root for ${pkgName}`);
}

const SIBLING_PACKAGES = [
  '@adhd/agent-core-provider',
  '@adhd/agent-store-prompts',
  '@adhd/agent-store-tools',
  '@adhd/agent-core-policy',
];

function spawnBin(args: string[]): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('compile CLI bin — sibling migration folder resolution (regression)', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeAll(() => {
    // Build the real bin so BIN exists and reflects current source.
    const build = spawnSync(
      'npx',
      ['--yes', 'nx', 'build', 'agent-engine-compiler'],
      {
        encoding: 'utf8',
        cwd: REPO_ROOT,
        timeout: 120_000,
        shell: true,
      }
    );
    if (build.status !== 0) {
      throw new Error(
        `nx build agent-engine-compiler failed (exit ${build.status ?? '?'}):\n` +
          `stdout: ${build.stdout}\nstderr: ${build.stderr}`
      );
    }
    if (!fs.existsSync(BIN)) {
      throw new Error(`Built bin not found at: ${BIN}`);
    }

    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'agent-compiler-migration-resolution-')
    );
    dbPath = path.join(tmpDir, 'fresh.db');
  }, 180_000);

  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('the 5 migration directories the CLI needs actually exist on disk (independent check)', () => {
    for (const pkgName of SIBLING_PACKAGES) {
      const dir = independentlyResolveDrizzleDir(pkgName);
      expect(fs.existsSync(dir), `${pkgName}: expected drizzle dir at ${dir}`).toBe(
        true
      );
    }
    // The compiler's own migrations, at its own package root.
    const ownDrizzle = path.join(PKG_ROOT, 'dist/drizzle');
    expect(
      fs.existsSync(ownDrizzle),
      `agent-engine-compiler: expected own drizzle dir at ${ownDrizzle}`
    ).toBe(true);
  });

  it('compile against a FRESH db emits NO "migration folder not found" warnings', () => {
    const { stderr } = spawnBin([
      'compile',
      'this-slug-does-not-exist-migration-check',
      '--db',
      dbPath,
    ]);

    expect(stderr).not.toMatch(/migration folder not found/);
  });

  it('compile against a FRESH db does NOT crash with "no such table" (migrations applied)', () => {
    const { stderr } = spawnBin([
      'compile',
      'this-slug-does-not-exist-migration-check-2',
      '--db',
      dbPath,
    ]);

    expect(stderr).not.toMatch(/no such table/);
  });

  it('unknown slug against a FRESH db fails with a clean domain "not found" error (proves migrations ran, query logic reached)', () => {
    // If migrations silently failed, this would instead surface as a raw
    // "no such table" SQLite error, not a clean domain-level message.
    const { status, stderr } = spawnBin([
      'compile',
      'this-slug-does-not-exist-migration-check-3',
      '--db',
      dbPath,
    ]);

    expect(status, `EXIT CODE (stderr: ${stderr})`).not.toBe(0);
    expect(stderr.toLowerCase()).toMatch(/not found/);
    expect(stderr).not.toMatch(/no such table/);
  });
});
