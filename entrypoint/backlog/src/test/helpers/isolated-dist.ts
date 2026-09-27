/**
 * isolated-dist.ts — give a suite its OWN copy of the built `dist/`, rooted
 * under the repo's gitignored `tmp/`, instead of renaming/mutating the SHARED
 * `entrypoint/backlog/dist/`.
 *
 * WHY (the defect this closes)
 * ----------------------------
 * The bake-at-build IR-cache / startup-path suites (`ir-cache.durability.e2e.ts`,
 * `ir-cache.integration.e2e.ts`, `ir-cache.perf.e2e.ts`,
 * `server.startup-path.e2e.ts`) exercised their "artifact absent / artifact
 * stale" cases by renaming/mutating the REAL shared `dist/api.ir.json` and
 * `dist/api.d.ts`, then restoring them in a `finally`. That is not isolation:
 *
 *  - a `vite build` (`vite.config.ts` `emptyOutDir: true`) or nx's
 *    directory-output cache restore (`remove(dist); copy(cached, dist)`) deletes
 *    the WHOLE `dist/` dir, so a concurrent build (this repo routinely runs
 *    several `nx affected -t test` at once) can delete the renamed-away
 *    `dist/api.ir.json.<tag>-backup` between the rename and the restore — the
 *    restore then throws `ENOENT`, and the lane dies (exit 130) on whichever
 *    suite happened to be mid-rename;
 *  - while one suite has `dist/api.ir.json` renamed away, every OTHER suite
 *    that reads the shared artifact sees it MISSING — a cross-suite coupling
 *    that is a latent flake even when nothing else runs.
 *
 * The suites test the BUILT BIN's cache/startup BEHAVIOUR, not the shared build
 * output itself, so the honest isolation is to run the identical bundle from a
 * private copy: `backlogDistDir()` (`src/ir-artifact.ts`) resolves the artifact
 * from the RUNNING module's own directory, so a copied `dist/` is a faithful,
 * self-contained stand-in — and renaming/mutating it cannot touch anything a
 * sibling suite or a concurrent build owns.
 *
 * The copy root lives under `entrypoint/backlog/tmp/` (matched by the root
 * `.gitignore`'s `tmp` rule; the sanctioned ephemeral-artifact root, AGENTS.md
 * §10) — NOT the system temp dir. This placement is load-bearing: the bundle
 * externalizes its real npm deps, and `@adhd/apigen-core-client/package.json`
 * (read by `EXPECTED_EXTRACTOR_VERSION`) resolves ONLY through the package's
 * OWN `entrypoint/backlog/node_modules/@adhd/` — the repo-root `node_modules`
 * does not carry it. Node walks `node_modules` UP from the running file, so a
 * copy at `entrypoint/backlog/tmp/…/dist` reaches `entrypoint/backlog/
 * node_modules` exactly as the real dev-built `entrypoint/backlog/dist` does.
 * A copy under `os.tmpdir()` or the repo-root `tmp/` would fail to resolve it
 * (`MODULE_NOT_FOUND`).
 *
 * Cleanup is the caller's job (`IsolatedDist.cleanup()`, called in
 * `afterEach`/`afterAll`) so a FAILING run still removes its copy.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// helpers/ → test/ → src/ → backlog/ (<pkg root>)
const PKG_ROOT = join(HERE, '..', '..', '..');
const SCRATCH_ROOT = join(PKG_ROOT, 'tmp', 'e2e-isolated-dist');

export interface IsolatedDist {
  /** The unique per-suite copy root under `tmp/`. */
  readonly root: string;
  /** `<root>/dist` — the private build output the suite runs against. */
  readonly distDir: string;
  /** `<distDir>/index.js` — spawn THIS, never the shared one. */
  readonly indexPath: string;
  /** `<distDir>/api.d.ts` — safe to mutate; it is this suite's private copy. */
  readonly apiDtsPath: string;
  /** `<distDir>/api.ir.json` — safe to rename away; it is a private copy. */
  readonly apiIrPath: string;
  /** Removes the whole private copy. Safe to call more than once. */
  cleanup(): void;
}

/**
 * Copies `sourceDistDir` into a fresh `entrypoint/backlog/tmp/e2e-isolated-dist/
 * <tag>-*` directory and returns the private paths. Throws loudly (ENOENT) if
 * the source has not been built — never a silent skip.
 */
export function createIsolatedDist(
  sourceDistDir: string,
  tag: string
): IsolatedDist {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const root = mkdtempSync(join(SCRATCH_ROOT, `${tag}-`));
  const distDir = join(root, 'dist');
  cpSync(sourceDistDir, distDir, { recursive: true });
  return {
    root,
    distDir,
    indexPath: join(distDir, 'index.js'),
    apiDtsPath: join(distDir, 'api.d.ts'),
    apiIrPath: join(distDir, 'api.ir.json'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
