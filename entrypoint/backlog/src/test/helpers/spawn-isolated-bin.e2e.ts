/**
 * spawn-isolated-bin.e2e.ts — the regression guard for the shared
 * HOME-redirect isolation helper (PR #10 review finding `82470ae8`).
 *
 * The helper exists to own ONE invariant: a spawned bin must resolve its
 * store under the throwaway temp root, never the real machine's `~/.adhd`.
 * Before the helper that invariant was copy-pasted at many spawn sites with
 * no guard — so a dropped `HOME:` line at any one site silently reopened the
 * production store and no test noticed.
 *
 * This spec drives the invariant END-TO-END through the helper and the REAL
 * built bin. `sandbox-path` is the store-free diagnostic `cli.ts` special-
 * cases (verified present on this main: it prints
 * `{ sandbox, adhdRoot, dbPath }` — the resolved store path — WITHOUT ever
 * opening or creating it). Spawned through `runIsolatedBin` with the temp
 * root as both `cwd` and `HOME`, the reported `dbPath` MUST live under that
 * root.
 *
 * NEGATIVE CONTROLS — the "would go red if reverted" proof (AGENTS.md §7).
 * Run ONCE during authoring, then restored; they are NOT left in the suite
 * because a permanently-red test is a broken suite, not a guard:
 *
 *   A. In `spawn-isolated-bin.ts`'s `buildIsolatedEnv`, delete the
 *      `HOME: root` entry.
 *      → BOTH the unit and e2e assertions fail (verified 2026-09-22):
 *        - unit: `expected '/Users/nix' to be '/tmp/isolation-unit-root'`
 *        - e2e:  the child falls back to the real machine home and resolves
 *          the real production store (`…/Users/nix/.adhd/backlog/production/
 *          data/backlog.db`), exactly the leak the invariant prevents.
 *      Restore `HOME: root`; green again.
 *
 *   B. In `buildIsolatedEnv`, remove the `AMBIENT_REDIRECT_ENV_KEYS` strip
 *      (i.e. copy the whole `process.env` through).
 *      → the `ambient store-redirect vars do not leak` e2e assertion fails
 *        with the decoy path: `resolved dbPath <decoy>/decoy.db must live
 *        under the isolated root …`. The unit assertion on the stripped keys
 *        also fails. Restore the strip; green again.
 *
 * The `buildIsolatedEnv` unit assertions below are the PERMANENT teeth: they
 * go red the moment the `HOME`/`ADHD_BACKLOG_SCOPE` assignments are removed
 * from the helper OR the ambient-env strip is dropped, so the invariant can
 * never silently regress even on a machine with no global `~/.adhd` config to
 * leak from.
 *
 * The DURABILITY half of this guard — "every spec/e2e file that spawns
 * `process.execPath [DIST_INDEX, …]` imports an isolation helper" — is NOT
 * here. It is a pure fs-read + regex check (no child spawn, no model load), so
 * it lives in the default-running static gate
 * `tools/gate/spawn-isolation-gate.mjs`, wired into the `vocabulary-gate` Nx
 * target and therefore into `nx affected -t test`. Keeping it only in this
 * resource-lane suite silently stopped it running by default once the suite
 * became `*.e2e.ts`; the gate above is now the single source of truth.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AMBIENT_REDIRECT_ENV_KEYS,
  buildIsolatedEnv,
  runIsolatedBin,
} from './spawn-isolated-bin.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = join(HERE, '..', '..', '..', 'dist', 'index.js');

/** Saves, mutates, and restores a set of `process.env` keys. */
function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void
): void {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(vars)) {
    saved.set(key, process.env[key]);
    const value = vars[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('spawn-isolated-bin — the HOME-redirect invariant is enforced, not just copy-pasted', () => {
  let root: string | undefined;
  let decoy: string | undefined;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    if (decoy) rmSync(decoy, { recursive: true, force: true });
    root = undefined;
    decoy = undefined;
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

  // Permanent teeth for the ambient-env strip (PR #12 review finding): the
  // four store-redirect keys are DELETED from the base even when present in
  // the parent, and a deliberate `extraEnv` override re-adds them.
  it('buildIsolatedEnv strips ambient store-redirect vars, while extraEnv still wins', () => {
    const ambient = Object.fromEntries(
      AMBIENT_REDIRECT_ENV_KEYS.map((key) => [key, `/ambient/${key}`])
    );
    withEnv(ambient, () => {
      const env = buildIsolatedEnv('/tmp/isolation-unit-root');
      for (const key of AMBIENT_REDIRECT_ENV_KEYS) {
        expect(
          env[key],
          `${key} leaked from the ambient environment`
        ).toBeUndefined();
      }
      // The deliberate channel still wins over the strip.
      const withOverride = buildIsolatedEnv('/tmp/isolation-unit-root', {
        ADHD_ROOT: '/deliberate/override',
      });
      expect(withOverride['ADHD_ROOT']).toBe('/deliberate/override');
    });
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

  // The teeth for the ambient-env leak specifically: with the redirect vars
  // exported into the PARENT, the child must STILL resolve under the temp
  // root. Without the strip, `ADHD_BACKLOG_DATABASE_PATH`/`ADHD_ROOT` win and
  // the resolved path lands under the decoy.
  it('ambient store-redirect vars (ADHD_ROOT / ADHD_BACKLOG_DATABASE_PATH / SOX_ECOSYSTEM_HOME / APIGEN_IR_CACHE_FILE) do not leak into the child', () => {
    const isolatedRoot = mkdtempSync(join(tmpdir(), 'backlog-isolation-ambient-'));
    const decoyRoot = mkdtempSync(join(tmpdir(), 'backlog-isolation-decoy-'));
    root = isolatedRoot;
    decoy = decoyRoot;
    const realRoot = realpathSync(isolatedRoot);
    const decoyDb = join(decoyRoot, 'decoy.db');

    withEnv(
      {
        ADHD_ROOT: decoyRoot,
        ADHD_BACKLOG_DATABASE_PATH: decoyDb,
        SOX_ECOSYSTEM_HOME: join(decoyRoot, 'sox'),
        APIGEN_IR_CACHE_FILE: join(decoyRoot, 'ir.json'),
      },
      () => {
        const res = runIsolatedBin(DIST_INDEX, ['sandbox-path'], isolatedRoot);
        expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(
          0
        );
        const body = JSON.parse(res.stdout.trim()) as { dbPath: string };
        expect(
          body.dbPath.startsWith(realRoot),
          `resolved dbPath ${body.dbPath} must live under the isolated root ${realRoot} (ambient redirect leaked)`
        ).toBe(true);
        expect(body.dbPath.startsWith(decoyRoot)).toBe(false);
      }
    );
  });

  // The DURABILITY guard — "every spec/e2e file that spawns the real built bin
  // by `process.execPath [DIST_INDEX, …]` routes through an isolation helper" —
  // moved to the default-running static gate `tools/gate/spawn-isolation-gate.mjs`,
  // wired into the `vocabulary-gate` Nx target (so it runs under
  // `nx affected -t test` / the pre-commit + pre-push hooks). It is a pure
  // fs-read + regex check with no child spawn and no model load, so it never
  // needed the resource lane — and leaving it ONLY here meant it silently
  // stopped running by default once this suite was extracted to e2e. It is
  // deliberately NOT duplicated here; the gate is the single source of truth.
});
