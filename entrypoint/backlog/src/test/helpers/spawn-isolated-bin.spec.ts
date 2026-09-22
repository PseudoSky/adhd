/**
 * spawn-isolated-bin.spec.ts — the regression guard for the shared
 * HOME-redirect isolation helper (PR #10 review finding `82470ae8`).
 *
 * The helper exists to own ONE invariant: a spawned bin must resolve its
 * store under the throwaway temp root, never the real machine's `~/.adhd`.
 * Before the helper that invariant was copy-pasted at 15 spawn sites across
 * 10 spec files with no guard — so a dropped `HOME:` line at any one site
 * silently reopened the production store and no test noticed.
 *
 * This spec drives the invariant END-TO-END through the helper and the REAL
 * built bin. `sandbox-path` is the store-free diagnostic `cli.ts` special-
 * cases (verified present on this main: it prints
 * `{ sandbox, adhdRoot, dbPath }` — the resolved store path — WITHOUT ever
 * opening or creating it). Spawned through `runIsolatedBin` with the temp
 * root as both `cwd` and `HOME`, the reported `dbPath` MUST live under that
 * root.
 *
 * NEGATIVE CONTROL — the "would go red if reverted" proof (AGENTS.md §7).
 * Run ONCE during authoring, then restored; it is NOT left in the suite
 * because a permanently-red test is a broken suite, not a guard:
 *
 *   1. In `spawn-isolated-bin.ts`'s `buildIsolatedEnv`, delete the
 *      `HOME: root` entry.
 *   2. Run this spec. BOTH assertions fail (verified 2026-09-22):
 *        - unit: `expected '/Users/nix' to be '/tmp/isolation-unit-root'`
 *        - e2e:  `resolved dbPath
 *          /Users/nix/.adhd/backlog/production/data/backlog-v2.db must live
 *          under the isolated root /private/var/folders/…/backlog-isolation-
 *          guard-…`
 *      — the child fell back to the real machine home and resolved the real
 *      production store, exactly the leak the invariant exists to prevent.
 *   3. Restore `HOME: root`; the spec goes green again.
 *
 * Evidence for step 2 is recorded in the PR body. The `buildIsolatedEnv`
 * unit assertions below are the PERMANENT teeth: they go red the moment the
 * `HOME`/`ADHD_BACKLOG_SCOPE` assignments are removed from the helper, so the
 * invariant can never silently regress even on a machine with no global
 * `~/.adhd` config to leak from.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIsolatedEnv, runIsolatedBin } from './spawn-isolated-bin.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = join(HERE, '..', '..', '..', 'dist', 'index.js');

describe('spawn-isolated-bin — the HOME-redirect invariant is enforced, not just copy-pasted', () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  // Permanent teeth: the helper's contract itself. Removing `HOME`/scope from
  // `buildIsolatedEnv` fails HERE on every machine, whether or not the real
  // machine home happens to carry a global config for the e2e guard to leak.
  it('buildIsolatedEnv redirects both HOME and the scope, and lets extraEnv win', () => {
    const env = buildIsolatedEnv('/tmp/isolation-unit-root', {
      ADHD_BACKLOG_DATABASE_PATH: '/tmp/override.db',
    });
    expect(env['ADHD_BACKLOG_SCOPE']).toBe('project');
    expect(env['HOME']).toBe('/tmp/isolation-unit-root');
    expect(env['ADHD_BACKLOG_DATABASE_PATH']).toBe('/tmp/override.db');
  });

  it('a store-free CLI run through the helper resolves dbPath UNDER the temp root', () => {
    root = mkdtempSync(join(tmpdir(), 'backlog-isolation-guard-'));
    const res = runIsolatedBin(DIST_INDEX, ['sandbox-path'], root);
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(
      0
    );
    const body = JSON.parse(res.stdout.trim()) as { dbPath: string };
    // realpath both sides: on macOS `/var` → `/private/var`, and the child's
    // own resolved cwd goes through that symlink while `root` here does not.
    const realRoot = realpathSync(root);
    expect(
      body.dbPath.startsWith(realRoot),
      `resolved dbPath ${body.dbPath} must live under the isolated root ${realRoot}`
    ).toBe(true);
    // Store-free: reporting the path must never create it (no leaked artifact
    // from the guard itself).
    expect(existsSync(body.dbPath)).toBe(false);
  });
});
