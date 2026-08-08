'use strict';
/**
 * changed-set.js — computes the real changed/affected publishable-project set
 * for a release, replacing the unscoped `nx run-many -t publish` anti-pattern
 * identified in `tmp/release-pipeline-audit.md` §6.1
 * (DEBT-RELEASE-UNSCOPED-PUBLISH-001): today's `run-release.mjs` requests the
 * `publish` task for EVERY publishable project in the workspace (~55),
 * regardless of what actually changed, which pulls in the full transitive
 * `test`/`build`/`lint`/`^test`/`^publish` closure for all of them — 486 tasks
 * for a real ~15-package changeset, and the direct, confirmed cause of two
 * resource-contention failures on 2026-07-31 (see the audit's baseline
 * measurement section).
 *
 * THE ALGORITHM — union of two independently-sufficient signals, neither of
 * which alone is enough:
 *
 *   1. GIT-DIFF AFFECTED (`nx show projects --affected --base=<ref>`) — cheap,
 *      no build required, tells us which projects' SOURCE changed (and,
 *      transitively via Nx's own project graph, which projects depend on
 *      something that changed). This is necessary but not sufficient: a
 *      project's OWN version can need bumping even when its source is
 *      untouched by cheap 1-line source changes, IF an earlier `run-release`
 *      attempt already partially executed (e.g. this project's on-disk
 *      package.json was already bumped by a `version` task that ran before a
 *      later failure — see audit §6.2/GATE-1-timing) and it, alone, is out
 *      of sync with what `published-state.json` last recorded.
 *
 *   2. PUBLISHED-STATE-CACHE STALENESS — reuses the EXISTING
 *      `published-state.json` hash-cache machinery (`published-state.js`'s
 *      `readState`, backed by `compare-published.js`'s `normalizedHash`/
 *      `normalizeManifest` — see that module's own header for the full
 *      design). We do NOT invent a second hash-comparison mechanism: this
 *      module only asks "does this project's CURRENT on-disk `version` match
 *      what the cache last recorded as published?" A mismatch means either
 *      (a) a prior partial run already bumped this project's version (it is
 *      unambiguously part of the current release attempt and must stay in
 *      scope even though `nx affected` may not flag it if its own source
 *      hasn't changed again since that bump), or (b) the cache itself is
 *      stale/missing (first run, cache miss) — either way, safe to include
 *      rather than silently drop.
 *
 * The union of (1) and (2) is the computed project set. This is deliberately
 * NOT the `reconcile-core.js`/`normalizedHash` DIST-CONTENT comparison itself
 * (that requires a fresh `build` to have already run, which is the exact
 * thing we're trying to scope BEFORE doing) — it is the cheaper, pre-build
 * proxy the audit's "simpler stopgap" describes (§6.1, second bullet),
 * reusing the cache's RECORDED version field rather than recomputing a hash.
 *
 * FAIL-LOUD CONTRACT: this module has NO code path that returns "everyone" as
 * a fallback. If the affected-computation step (git/nx) fails, it throws —
 * callers (see `run-release.mjs`) must not catch-and-fall-back-to-unscoped;
 * they must surface the error and stop before touching the registry.
 *
 * MANIFEST BACKSTOP (Phase 3, `tmp/release-pipeline-audit.md`): every
 * successful call to `computeChangedProjectSet` also writes its result to
 * `<workspaceRoot>/tmp/release-manifest.json` via `./release-manifest.js`'s
 * `writeReleaseManifest` (unless the caller explicitly opts out with
 * `{ writeManifest: false }`, used by this module's own unit tests to avoid
 * incidental fixture-directory writes). `executors/publish/impl.js` reads
 * that manifest and REFUSES to run a real `npm publish` unless the invoking
 * project is listed in a fresh copy of it — a last-line-of-defense backstop
 * for the case where something upstream calls `nx run-many -t publish` (or a
 * single project's `publish` target) directly, bypassing `run-release.mjs`
 * and this module's own scoping entirely. See `release-manifest.js`'s module
 * header for the full design.
 *
 * @module changed-set
 */
const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { discoverReleaseSet } = require('./range-resolvability');
const { readState } = require('./published-state');
const { writeReleaseManifest } = require('./release-manifest');

/**
 * Derive a base ref from the `publishedFromRef` breadcrumbs that
 * `executors/publish/impl.js` writes AFTER each confirmed publish.
 *
 * Picks the OLDEST recorded ref, not the newest. Packages publish at different
 * commits, so the newest ref would sit ahead of some packages' last publish and
 * silently hide their changes. The oldest is the only choice that guarantees no
 * package's work falls outside the window. Over-wide is safe here and
 * under-wide is not: everything scoped in still passes through `version`'s
 * `normalizedHash` comparison, which no-ops any package whose built content
 * matches the registry (see executors/version/impl.js). Breadth costs cached
 * build time; narrowness silently withholds a package.
 *
 * Every candidate is verified to still EXIST before use. A rebase, squash, or
 * dropped branch can strand a recorded SHA, and diffing against a dangling ref
 * would throw — so unresolvable refs are skipped, and if none survive we fall
 * through to the ordinary defaults. That degradation path is why
 * `publishedFromRef` is advisory and `normalizedHash` stays authoritative.
 *
 * @returns {string|null} a usable ref, or null to fall through
 */
function resolveBaseRefFromPublishedState({ workspaceRoot, publishedState }) {
  let state = publishedState;
  if (!state) {
    try {
      state = readState(workspaceRoot);
    } catch {
      return null;
    }
  }
  const refs = [
    ...new Set(
      Object.values(state || {})
        .map((e) => e && e.publishedFromRef)
        .filter((r) => typeof r === 'string' && /^[0-9a-f]{40}$/i.test(r))
    ),
  ];
  if (!refs.length) return null;

  let oldest = null;
  let oldestTime = Infinity;
  for (const ref of refs) {
    // `<sha>^{commit}` fails for a SHA that no longer resolves to a commit —
    // this is the rebase/squash guard, not a formality.
    const res = spawnSync('git', ['log', '-1', '--format=%ct', `${ref}^{commit}`], {
      cwd: workspaceRoot,
      encoding: 'utf8',
    });
    if (res.status !== 0) continue;
    const t = Number.parseInt(String(res.stdout).trim(), 10);
    if (!Number.isFinite(t)) continue;
    if (t < oldestTime) {
      oldestTime = t;
      oldest = ref;
    }
  }
  return oldest;
}

/**
 * Resolve the git ref this release's changed-set should be diffed against.
 *
 * Precedence:
 *   1. `env.RELEASE_BASE_REF`, if set and non-blank — explicit caller override.
 *   1.5. The OLDEST still-resolvable `publishedFromRef` in
 *      `published-state.json` — "the earliest commit any package was last
 *      published from", i.e. the true start of the unreleased window. See
 *      `resolveBaseRefFromPublishedState` above. This is what makes a correct
 *      base automatic; before it existed, a 21-commit release fell through to
 *      `HEAD~1`, computed an EMPTY changed-set, and published nothing while 10
 *      packages had genuinely changed.
 *   2. `HEAD~1` — "the previous commit," i.e. everything committed on top of
 *      it PLUS the current uncommitted working tree counts as changed. This is
 *      now only a LAST-RESORT default, reached when no usable
 *      `publishedFromRef` exists: a cache written before that field was added,
 *      a package never published from this repo, or refs that no longer
 *      resolve after a rebase.
 *
 *      Treat reaching this case as a warning sign, not a normal path. `HEAD~1`
 *      is correct ONLY when the release is exactly one commit ahead of the last
 *      publish; for anything longer it silently under-scopes. That is not
 *      hypothetical — it is precisely how a 21-commit release computed an empty
 *      set and shipped nothing. If you land here and the release spans multiple
 *      commits, pass `RELEASE_BASE_REF` explicitly rather than trusting it.
 *   3. The git empty-tree sentinel (`git hash-object -t tree /dev/null`'s
 *      well-known constant hash) — only reached on a repo with a single
 *      commit (no `HEAD~1` to diff against), so that everything committed so
 *      far counts as "changed" rather than crashing on a nonexistent ref.
 *
 * @param {{ workspaceRoot: string, env?: NodeJS.ProcessEnv }} opts
 * @returns {string}
 */
function resolveBaseRef({ workspaceRoot, env = process.env, publishedState }) {
  if (env.RELEASE_BASE_REF && env.RELEASE_BASE_REF.trim()) {
    return env.RELEASE_BASE_REF.trim();
  }
  const fromCache = resolveBaseRefFromPublishedState({ workspaceRoot, publishedState });
  if (fromCache) return fromCache;
  const hasParent = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD~1'], {
    cwd: workspaceRoot,
  });
  if (hasParent.status === 0) return 'HEAD~1';
  // Git's well-known empty-tree object hash — diffing against it makes every
  // committed file "changed," the correct behavior for a repo with no parent
  // commit to diff against.
  return '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
}

/**
 * Real implementation: shells out to `nx show projects --affected --base=<ref>
 * --json`, the cheap git-diff-based affected computation (no build required).
 * Throws loudly on any failure (non-zero exit, unparsable output) — this is
 * the ONE step in this module that can fail for reasons outside our control
 * (a missing/invalid ref, nx itself erroring), and per this module's fail-loud
 * contract, a failure here must propagate, never silently degrade to "assume
 * everyone is affected."
 *
 * @param {{ workspaceRoot: string, baseRef: string }} opts
 * @returns {string[]} nx project names (unscoped, e.g. "agent-base-types")
 */
function getAffectedProjectNames({ workspaceRoot, baseRef }) {
  const result = spawnSync(
    'npx',
    ['nx', 'show', 'projects', '--affected', `--base=${baseRef}`, '--json'],
    { cwd: workspaceRoot, encoding: 'utf8', shell: false }
  );
  if (result.error) {
    throw new Error(
      `changed-set: failed to spawn "nx show projects --affected --base=${baseRef}": ${result.error.message}`
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `changed-set: "nx show projects --affected --base=${baseRef}" exited ${result.status} — ` +
        `cannot compute a changed-set scope. Refusing to fall back to an unscoped publish. ` +
        `stderr:\n${result.stderr}`
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(
      `changed-set: could not parse "nx show projects --affected --base=${baseRef} --json" output as JSON ` +
        `(${err.message}). Refusing to fall back to an unscoped publish. Raw stdout:\n${result.stdout}`
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `changed-set: "nx show projects --affected --json" did not return an array — got: ${JSON.stringify(parsed)}`
    );
  }
  return parsed;
}

/**
 * Read a project's nx project name (`project.json`'s own `name` field — the
 * value `nx run-many --projects=<name>` matches against, which is NOT the
 * same string as the scoped npm package name, e.g. nx name `agent-base-types`
 * vs npm name `@adhd/agent-base-types`).
 *
 * Throws if `project.json` is missing/unparsable/nameless — a publishable
 * project this module can't resolve an nx name for would otherwise be
 * silently dropped from the computed `--projects=` list, which is exactly the
 * kind of silent gap this module exists to prevent.
 *
 * @param {string} workspaceRoot
 * @param {string} projectRoot
 * @returns {string}
 */
function readProjectName(workspaceRoot, projectRoot) {
  const projectJsonPath = join(workspaceRoot, projectRoot, 'project.json');
  if (!existsSync(projectJsonPath)) {
    throw new Error(`changed-set: ${projectRoot} has no project.json — cannot resolve its nx project name`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(projectJsonPath, 'utf8'));
  } catch (err) {
    throw new Error(`changed-set: ${projectJsonPath} is not valid JSON: ${err.message}`);
  }
  if (!parsed.name || typeof parsed.name !== 'string') {
    throw new Error(`changed-set: ${projectJsonPath} has no "name" field — cannot target it with --projects`);
  }
  return parsed.name;
}

/**
 * @typedef {object} ChangedProject
 * @property {string} projectRoot        workspace-relative path, e.g. "packages/agent/agent-base-types"
 * @property {string} packageName        the npm package name, e.g. "@adhd/agent-base-types"
 * @property {string} nxProjectName      the nx graph name, e.g. "agent-base-types" — this is what `--projects=` wants
 * @property {string} version            current on-disk package.json version
 * @property {string[]} reasons          why this project is in scope: "affected-by-git-diff" and/or "published-state-cache-stale"
 */

/**
 * Compute the changed/affected publishable-project set for this release —
 * the union of git-diff-affected projects and projects whose on-disk version
 * has already diverged from `published-state.json`'s last-recorded version
 * (see this module's header for the full rationale).
 *
 * Every dependency this function needs is injectable (`opts.discoverReleaseSet`,
 * `opts.getAffectedProjectNames`, `opts.readProjectName`, `opts.publishedState`)
 * so tests can exercise the real union/inclusion/exclusion logic against a
 * fully controlled fixture, with zero real git/nx/registry access — this
 * mirrors `check-release-ranges.mjs`'s own `runCheck({ fetchVersions })`
 * injection convention.
 *
 * @param {{
 *   workspaceRoot: string,
 *   baseRef?: string,
 *   env?: NodeJS.ProcessEnv,
 *   discoverReleaseSet?: (workspaceRoot: string) => Array<{projectRoot:string,name:string,version:string}>,
 *   getAffectedProjectNames?: (opts: {workspaceRoot:string, baseRef:string}) => string[],
 *   readProjectName?: (workspaceRoot: string, projectRoot: string) => string,
 *   publishedState?: Record<string, {version:string}>,
 *   writeManifest?: boolean,
 * }} opts
 * @returns {{ baseRef: string, projects: ChangedProject[], projectNames: string[] }}
 */
function computeChangedProjectSet(opts) {
  if (!opts || !opts.workspaceRoot) {
    throw new Error('changed-set: computeChangedProjectSet requires { workspaceRoot }');
  }
  const { workspaceRoot } = opts;
  const env = opts.env || process.env;
  // NOTE: publishedState is resolved BEFORE baseRef, because resolveBaseRef now
  // derives its default from the cache's `publishedFromRef` breadcrumbs. Reading
  // it first both avoids a second disk read and — more importantly — keeps an
  // INJECTED `opts.publishedState` authoritative for base-ref resolution too;
  // otherwise a test supplying a fixture state would silently have its base ref
  // computed from the real on-disk file.
  const publishedStateResolved = opts.publishedState || readState(workspaceRoot);
  const baseRef =
    opts.baseRef || resolveBaseRef({ workspaceRoot, env, publishedState: publishedStateResolved });
  const discover = opts.discoverReleaseSet || discoverReleaseSet;
  const getAffected = opts.getAffectedProjectNames || getAffectedProjectNames;
  const nameOf = opts.readProjectName || readProjectName;
  const publishedState = publishedStateResolved;

  const releaseSet = discover(workspaceRoot);
  const affectedNames = new Set(getAffected({ workspaceRoot, baseRef }));

  /** @type {ChangedProject[]} */
  const projects = [];
  for (const p of releaseSet) {
    const nxProjectName = nameOf(workspaceRoot, p.projectRoot);
    const cacheEntry = publishedState[p.name];
    const isAffectedByDiff = affectedNames.has(nxProjectName);
    const isCacheStale = !cacheEntry || cacheEntry.version !== p.version;
    if (!isAffectedByDiff && !isCacheStale) continue;
    const reasons = [];
    if (isAffectedByDiff) reasons.push('affected-by-git-diff');
    if (isCacheStale) reasons.push('published-state-cache-stale');
    projects.push({
      projectRoot: p.projectRoot,
      packageName: p.name,
      nxProjectName,
      version: p.version,
      reasons,
    });
  }
  projects.sort((a, b) => a.nxProjectName.localeCompare(b.nxProjectName));
  const projectNames = projects.map((p) => p.nxProjectName);

  // Manifest backstop (Phase 3): persist the computed scope so
  // `executors/publish/impl.js` can refuse to publish anything outside it,
  // even if a future caller bypasses this module and `run-release.mjs`
  // entirely. See `./release-manifest.js`'s header for the full design.
  if (opts.writeManifest !== false) {
    writeReleaseManifest(workspaceRoot, projectNames, { baseRef });
  }

  return { baseRef, projects, projectNames };
}

module.exports = {
  resolveBaseRef,
  resolveBaseRefFromPublishedState,
  getAffectedProjectNames,
  readProjectName,
  computeChangedProjectSet,
};
