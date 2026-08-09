/**
 * install.published-layout.spec.ts — BUG-013 regression, published (rebased-
 * to-root) layout variant of `server.published-layout.spec.ts`'s own proven
 * pattern. Two REAL, npm-reproduced defects fixed together:
 *
 *  - FIX A: `entrypoint/backlog/skill/SKILL.md` existed in source but was
 *    NEVER copied into `dist/` (the `build` target's own `options.assets`
 *    is a documented no-op for `@nx/vite:build` — verified directly against
 *    that executor's `build.impl.js`, which never reads `options.assets` at
 *    all; the real, already-established copy path in this repo is
 *    `package.json`'s own `"assets"` array, consumed by the separate
 *    `@adhd/nx-assets:copy` target — see `project.json`'s `test.dependsOn`
 *    comment), so the published tarball shipped with NO `skill/` directory.
 *  - FIX B: `packagedSkillMdPath()` (`install-skill.ts`) computed
 *    `join(dirname(import.meta.url), '..', 'skill', 'SKILL.md')` —
 *    correct ONLY for the local dev-built layout (`dist/install-skill.js` ->
 *    `../skill` reaches the real package root's `skill/`), but WRONG for
 *    the real, `npm publish <distDir>`-produced layout, where
 *    `install-skill.js` and (post FIX A) `skill/` are SIBLINGS at the
 *    package root — `../skill` escapes one level too far into a nonexistent
 *    `node_modules/@adhd/skill/SKILL.md`. Reproduced live (manually, against
 *    this exact fix's own built dist, BEFORE FIX B landed):
 *      `backlog install-skill: packaged skill file not found at
 *      .../tmp/backlog/skill/SKILL.md` (one level above the flattened
 *      package root — precisely the escaped, `@adhd/skill`-shaped path the
 *      real npm-installed bug report named).
 *
 * This test flattens the REAL BUILT `dist/` (FIX A already applied, so
 * `dist/skill/SKILL.md` is present here) into a throwaway root — exactly
 * what `npm publish <distDir>` produces — and spawns the real built bin from
 * inside it, proving `install-skill`/`install --skill-only` actually find
 * and copy `SKILL.md` in that shape, rather than crashing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, '..');
const DIST_DIR = join(PKG_ROOT, 'dist');

const TMP_ROOT = join(PKG_ROOT, 'tmp', 'backlog');

interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function flattenDistIntoFreshRoot(): string {
  mkdirSync(TMP_ROOT, { recursive: true });
  const publishedRoot = mkdtempSync(join(TMP_ROOT, 'install-published-layout-'));
  for (const entry of readdirSync(DIST_DIR)) {
    cpSync(join(DIST_DIR, entry), join(publishedRoot, entry), { recursive: true });
  }
  return publishedRoot;
}

function runInstallSkill(publishedRoot: string, extraArgv: string[]): SpawnResult {
  const indexJs = join(publishedRoot, 'index.js');
  const result = spawnSync(process.execPath, [indexJs, 'install-skill', ...extraArgv], {
    cwd: publishedRoot,
    env: { ...process.env, ADHD_BACKLOG_SCOPE: 'project' },
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.error) throw new Error(`spawn failed for ${indexJs} install-skill: ${String(result.error)}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('BUG-013 — install-skill on a published (rebased-to-root) layout', () => {
  let publishedRoot: string | undefined;

  afterEach(() => {
    if (publishedRoot) rmSync(publishedRoot, { recursive: true, force: true });
    publishedRoot = undefined;
  });

  it('FIX A precondition: the real built dist/ actually contains skill/SKILL.md before this test even flattens it', () => {
    const distSkillMd = join(DIST_DIR, 'skill', 'SKILL.md');
    expect(existsSync(distSkillMd), `${distSkillMd} missing — run "nx run backlog:assets" (BUG-013 FIX A) before this suite`).toBe(true);
  });

  it('RED-state proof: the pre-FIX-B escaped path (one level above the flattened package root) is categorically absent — the real bug this test guards against', () => {
    publishedRoot = flattenDistIntoFreshRoot();
    const preFixEscapedPath = join(dirname(publishedRoot), 'skill', 'SKILL.md');
    expect(existsSync(preFixEscapedPath)).toBe(false);
  });

  it('install-skill --host opencode --scope project succeeds (exit 0) and writes the real packaged SKILL.md, never the escaped-path ENOENT', () => {
    publishedRoot = flattenDistIntoFreshRoot();
    const res = runInstallSkill(publishedRoot, ['--host', 'opencode', '--scope', 'project']);

    expect(res.stderr).not.toMatch(/packaged skill file not found/);
    expect(res.stderr).not.toMatch(/@adhd[/\\]skill/);
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(0);

    const body = JSON.parse(res.stdout.trim()) as { installed: Array<{ host: string; scope: string; path: string }> };
    expect(body.installed).toHaveLength(1);
    const installedPath = body.installed[0].path;
    expect(installedPath).toBe(join(publishedRoot, '.opencode', 'skills', 'backlog', 'SKILL.md'));
    expect(existsSync(installedPath)).toBe(true);

    const packagedSkillMd = readFileSync(join(publishedRoot, 'skill', 'SKILL.md'), 'utf8');
    expect(readFileSync(installedPath, 'utf8')).toBe(packagedSkillMd);
    expect(packagedSkillMd.length).toBeGreaterThan(0);
  }, 30_000);

  it('install --skill-only on the published layout behaves identically to install-skill (same underlying installSkillToHosts call)', () => {
    publishedRoot = flattenDistIntoFreshRoot();
    const indexJs = join(publishedRoot, 'index.js');
    const result = spawnSync(process.execPath, [indexJs, 'install', '--host', 'claude', '--scope', 'project', '--skill-only'], {
      cwd: publishedRoot,
      env: { ...process.env, ADHD_BACKLOG_SCOPE: 'project' },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`).toBe(0);
    const body = JSON.parse(result.stdout.trim()) as {
      skill: Array<{ host: string; scope: string; path: string }>;
      mcp: unknown[];
    };
    expect(body.mcp).toEqual([]);
    expect(body.skill).toHaveLength(1);
    expect(existsSync(body.skill[0]!.path)).toBe(true);
  }, 30_000);
});
