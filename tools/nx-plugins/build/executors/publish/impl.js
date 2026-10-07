'use strict';
/**
 * @adhd/nx-build:publish — per-project publish TASK.
 *
 * The publishable seam is a proper nx target (not a standalone script), so
 * releasing the workspace is just `nx run-many -t publish` — nx handles fan-out,
 * ordering, and the gate `dependsOn` (build → dist-manifest → verify-dist-load →
 * publish-hygiene, wired in plugin.js). Not cached: publishing is a side effect.
 *
 * EXISTENCE CHECK (PUBLISHED-STATE-CACHE-001, zero-network happy path):
 * "is `name@version` already released" is answered from the committed
 * `published-state.json` cache FIRST — `cached.version === version` skips
 * straight to success with NO `npm view` call. This is the common case for
 * every package `nx run-many -t publish` re-visits after a run where nothing
 * new got versioned. A cache hit is a no-op only if the built content hash
 * ALSO equals the cached hash (see DECISION ORDER). Only when the cache does
 * NOT already know this exact version does `publish` fall through to the real
 * `npm publish` attempt (which needs the network anyway — that's the release).
 *
 * WRITE-THROUGH (Deliverable 3): on a successful `npm publish` — OR on npm's
 * "cannot publish over previously published version" error, treated as
 * already-published/success (the real read-lag case: the cache said "not
 * published yet" but the registry disagrees, e.g. a previous run's publish
 * actually landed before this run's cache read) — this writes/updates the
 * package's `{version, normalizedHash, publishedIntegrity}` entry from the
 * dist THIS TASK JUST PACKED, not a re-fetched copy: it's authoritative and
 * immune to npm's own read-after-write propagation lag. The write is
 * concurrency-safe (`lib/published-state.js`'s lockfile-guarded
 * read-modify-write) so parallel `nx run-many -t publish` tasks — each a
 * separate process — never lose one another's update.
 *
 * POST-PUBLISH VERIFICATION (defect 32af828b-fb78-467f-bbe9-cbf96061b258,
 * HIGH): a zero `npm publish` exit status is NOT proof the version is
 * retrievable — npm returns HTTP 202 ("being processed…") on ACCEPTANCE, and
 * promotion into the packument can lag by many minutes (observed ~20). So on
 * the exit-0 path this task now calls `lib/publish-verify.js`'s
 * `verifyVersionRetrievable` BEFORE writing the write-through cache: it does
 * a direct, cache-bypassing `GET /<name>/<version>` in a BOUNDED POLL and
 * only a matching 200 authorises the write. A 202-without-retrievability is
 * treated as FAILURE (`{success:false}`) and writes NOTHING, so a
 * never-promoted version is neither silently reported released nor allowed to
 * poison `published-state.json` (which would make every later run skip it).
 * The failure is honest about the wait and the last observed status; the
 * version is simply re-attempted next run. The `npm view`-based reconcile
 * branch (npm exit != 0) is deliberately UNCHANGED: `isAlreadyPublishedError`
 * is the registry itself refusing and naming the version, and
 * `isPublishedLive` is positive evidence, so neither is speculative.
 *
 * DECISION ORDER (owner directive 2026-10-07: "the build is different from
 * what's on npm -> it should publish"; raw `nx run <p>:publish` / `nx run-many
 * -t publish` / `nx affected -t publish` must never fail for bookkeeping):
 *   1. content equal to what the registry holds (published-state.json hash at
 *      this version)               -> successful NO-OP, decided FIRST, before
 *                                     any manifest or scope check;
 *   2. same version, different build, no bump -> FAIL LOUDLY with the one-line
 *                                     fix (`nx run <p>:version`); never skipped;
 *   3. never published, or a version the registry does not hold -> PUBLISH.
 *      (`version`, a dependsOn of this target, has already bumped a changed
 *      package past its published version, so a raw publish of a changed
 *      package is: version bump -> this publish.)
 * "Version already exists" from npm is itself settled by CONTENT
 * (`settleExistingVersion`): identical -> success; different -> loud failure
 * and the cache is NOT written (it would be poisoned with the wrong bytes).
 *
 * SCOPE ADVISORY (was the "manifest backstop", Phase 3 of
 * `tmp/release-pipeline-audit.md`): `../../lib/release-manifest.js`'s
 * `checkPublishAllowed` used to REFUSE any publish whose project was absent
 * from a fresh `.adhd/tmp/release-manifest.json`, to stop an unscoped
 * `nx run-many -t publish` from re-running the whole workspace (the
 * DEBT-RELEASE-UNSCOPED-PUBLISH-001 cost anti-pattern). It also fired BEFORE
 * the registry decision, so an already-published package was refused for
 * bookkeeping (stale manifest) and the refusal cascaded through `^publish`.
 * Now: it runs only on the path that really `npm publish`es, where the project
 * is in the changed-set by definition (`!cached || cached.version !== version`
 * is exactly changed-set.js's `isCacheStale`), so a missing/stale/out-of-scope
 * manifest is a NOTE. Scoping a release is still `run-release.mjs`'s job (it
 * bounds cost); the executor no longer enforces it. The
 * `RELEASE_FORCE_FULL_PUBLISH` + `RELEASE_FORCE_REASON` override still works and
 * is still audit-logged; a FORCE flag with no reason is still refused (explicit
 * misuse), with the one-line fix printed.
 *
 * OTP / AUTH: `--otp=<code>`, else `NPM_CONFIG_OTP` / `npm_config_otp`, is handed
 * to npm via the ENVIRONMENT (`npm_config_otp`) — never argv, so it is not in
 * `ps` or the metrics label, and it is never logged. An EOTP / 401 / 403-2FA
 * failure fails fast (nx stops the graph) with `describeAuthFailure`'s
 * actionable message. An interactive prompt is not relied on: nx runs tasks
 * without a usable TTY for npm's prompt.
 *
 * Versioning model: the source package.json `version` IS the release
 * version — bump it (via `version`) to cut a new release.
 *
 * Options (forwarded from `nx run-many -t publish --<opt>=<val>`):
 *   --dryRun         pack + report, publish nothing (cache is NOT written)
 *   --otp=<code>     npm one-time password (2FA); or NPM_CONFIG_OTP in the environment
 *   --tag=<dist-tag> publish under a dist-tag (default: latest)
 *   --access=<a>     npm access (default: public)
 */
const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { join, relative } = require('node:path');
// semver is a transitive dep of nx, resolved from the workspace root
// node_modules (confirmed resolvable from this exact file location).
const semver = require('semver');
const { normalizedHash } = require('../version/compare-published');
const { writeDistManifest } = require('../manifest/generate-manifest');
const { packLocalDir, tarballIntegrity } = require('../../lib/npm-registry');
const { readState, updatePublishedState } = require('../../lib/published-state');
const { checkPublishAllowed } = require('../../lib/release-manifest');
const { verifyVersionRetrievable } = require('../../lib/publish-verify');
const { reconcilePackage } = require('../reconcile/reconcile-core');
const { withMetrics } = require('../../../lib/metrics');

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts });
}

/** true iff <name>@<version> is already on the registry (live network check — used only as a cache-miss fallback path, never on the happy path). */
function isPublishedLive(name, version, rec) {
  const res = rec
    ? rec.time('npm view <name>@<version> version', () => sh('npm', ['view', `${name}@${version}`, 'version'], { stdio: ['ignore', 'pipe', 'ignore'] }))
    : sh('npm', ['view', `${name}@${version}`, 'version'], { stdio: ['ignore', 'pipe', 'ignore'] });
  if (rec) rec.network('npm view <name>@<version> version');
  return res.status === 0 && String(res.stdout).trim() === version;
}

/**
 * npm's message when a version already exists on the registry — treated as
 * success (already-published), not a failure, because the cache's write
 * (below) is authoritative regardless of *why* it was stale.
 */
function isAlreadyPublishedError(npmStderrOrStdout) {
  return /cannot publish over( the)? previously published version/i.test(String(npmStderrOrStdout || ''));
}

/**
 * Machine-readable outcome of this publish task.
 *
 * The nx console line for a real publish and an already-published SKIP are
 * identical (`✔ :publish`), and the distinction was otherwise only printed as
 * stderr prose — so a release receipt could not say which packages actually
 * landed without parsing logs or re-querying the registry (which suffers
 * read-after-write/packument lag). Every terminal `return` now carries this
 * object; `withMetrics` persists it on the metrics record (see
 * `tools/nx-plugins/lib/metrics.js`'s `outcome` handling), and
 * `task-report.mjs` partitions PUBLISHED vs SKIPPED from it alone.
 *
 * @param {'published'|'skipped-already-published'|'dry-run'|'failed'|'refused'} status
 * @param {{name?: string, version?: string}} [pkg] the package identity, when known
 * @returns {{status: string, name?: string, version?: string}}
 */
function outcome(status, pkg) {
  const o = { status };
  if (pkg && pkg.name) o.name = pkg.name;
  if (pkg && pkg.version) o.version = pkg.version;
  return o;
}

/**
 * The commit this publish is shipping FROM, or null if it cannot be
 * determined. ADVISORY METADATA ONLY — see `publishedFromRef` in
 * `writeThroughCache` below for why it must never become authoritative.
 *
 * Returns null rather than throwing on any failure (not a git repo, git
 * missing, detached weirdness): a publish must never fail because we could
 * not record a nice-to-have breadcrumb.
 */
function currentGitRef(root) {
  try {
    const res = sh('git', ['rev-parse', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
    if (res.status !== 0) return null;
    const sha = String(res.stdout || '').trim();
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Write-through: compute this package's `{version, normalizedHash,
 * publishedIntegrity, publishedFromRef}` from the dist that was JUST
 * packed/published — an OFFLINE local pack + hash, never a re-fetch from the
 * registry (immune to npm read-after-write lag by construction: we know
 * exactly what we shipped).
 *
 * `publishedFromRef` — the commit this version shipped from. It exists for ONE
 * purpose: to let `lib/changed-set.js` resolve a correct release base ref
 * automatically. Its default is `HEAD~1`, which silently under-scopes any
 * release spanning more than one commit — a real 21-commit release computed an
 * EMPTY changed-set and published nothing, because the only commit it diffed
 * against touched no publishable project.
 *
 * IT IS DELIBERATELY NOT PART OF IDENTITY. `normalizedHash` remains the sole
 * authority for "is this already published", and that is not a stylistic
 * choice: content-addressing is what makes this cache survive rebases,
 * squashes, cherry-picks, worktrees, and publishes from other machines. A SHA
 * has none of those properties — rewrite history and the ref dangles, while
 * the hash stays true. Consumers must therefore treat a missing, unparsable,
 * or no-longer-existing `publishedFromRef` as ordinary and degrade gracefully,
 * never as an error.
 *
 * It is written ONLY here, and this function is called ONLY after npm has
 * confirmed the publish (exit 0, or a failure the registry itself contradicts
 * via `isPublishedLive`), and never under `--dry-run`. So a recorded ref always
 * means "this content is really on the registry, and it came from this commit."
 *
 * @param {string} root workspace root
 * @param {string} name
 * @param {string} version
 * @param {string} distDir
 * @param {string} workDir scratch dir for the local pack
 */
async function writeThroughCache(root, name, version, distDir, workDir, rec) {
  const tgz = rec ? rec.time('npm pack <distDir> (offline, local)', () => packLocalDir(distDir, workDir)) : packLocalDir(distDir, workDir);
  const publishedIntegrity = tgz ? tarballIntegrity(tgz) : null;
  const publishedFromRef = currentGitRef(root);
  const entry = { version, normalizedHash: normalizedHash(distDir), publishedIntegrity };
  // Only record the ref when we actually have one — never write `null`, so an
  // undeterminable ref is indistinguishable from an old entry predating this
  // field, and both degrade down the same path in changed-set.js.
  if (publishedFromRef) entry.publishedFromRef = publishedFromRef;
  let written = entry;
  await updatePublishedState(root, (state) => {
    const existing = state[name];
    // BUG-005 guard: never let a write-through REGRESS the cache's recorded
    // version. This is the second half of the same hazard `version/impl.js`'s
    // semver-directional check guards against — even if something upstream
    // slips a stale/regressed `version` past this task (e.g. a hand-edited
    // package.json, or a future caller that doesn't go through `version`
    // first), the cache itself must never be allowed to move BACKWARDS. A
    // backwards write here is exactly how `published-state.json` gets
    // permanently poisoned: every later run's zero-network decision trusts
    // whatever this file says, so a regressed entry silently and durably
    // corrupts the cache for every future invocation.
    if (existing && semver.valid(existing.version) && semver.valid(version) && semver.lt(version, existing.version)) {
      console.error(
        `publish: REFUSING to regress published-state cache for ${name}: existing cached version ` +
        `${existing.version} is newer than the version just published (${version}) — leaving the cache ` +
        `entry at ${existing.version} untouched. This indicates a version regression slipped past the ` +
        `'version' task's own semver guard; investigate before re-running.`
      );
      written = existing;
      return state; // no-op: leave the existing (newer) entry exactly as-is
    }
    state[name] = entry;
    written = entry;
    return state;
  });
  return written;
}

/**
 * Actionable guidance when `npm publish` fails for an AUTH reason, or null when
 * the failure is not auth-related. Never includes (and never receives) the OTP
 * or any token value — it only inspects npm's stderr for the failure class.
 *
 * npm demands an OTP in three observed shapes: `EOTP` / "one-time password",
 * a 401 with `www-authenticate: OTP`, and the 403 "Two-factor authentication or
 * granular access token with bypass 2fa enabled is required to publish".
 *
 * @param {string} stderr npm's stderr
 * @param {string} projectName nx project name (used to print the exact re-run line)
 * @returns {string|null}
 */
function describeAuthFailure(stderr, projectName) {
  const text = String(stderr || '');
  if (/EOTP|one-time password|two-factor authentication|bypass 2fa|\botp\b/i.test(text)) {
    return (
      `npm requires a one-time password (2FA) to publish. Fix: re-run with the OTP in the environment — ` +
      `NPM_CONFIG_OTP=<code> npx nx run ${projectName}:publish (or --otp=<code>; the value is handed to npm via ` +
      `the environment and is never logged). An OTP is single-use and ~30s lived: for several packages use ` +
      `--parallel=1, or publish with an npm automation / granular token that bypasses 2FA (NODE_AUTH_TOKEN or ~/.npmrc).`
    );
  }
  if (/ENEEDAUTH|E401|need auth|must be logged in|not logged in|authentication required/i.test(text)) {
    return (
      `npm is not authenticated. Fix: run \`npm login\` (or export NODE_AUTH_TOKEN / add an auth token to ~/.npmrc), ` +
      `then re-run npx nx run ${projectName}:publish.`
    );
  }
  return null;
}

/**
 * Scope advisory (formerly the REFUSING "manifest backstop"). See the header's
 * "SCOPE ADVISORY" section: called only on a path that is about to really
 * `npm publish`, where the project is — by the content decision above it —
 * already in the changed-set by construction, so a manifest that is missing,
 * stale or silent about it is a NOTE, never a refusal. The one remaining
 * refusal is an explicit misuse of the override (FORCE flag without a reason).
 *
 * @returns {{proceed: boolean}} proceed=false only for `force-reason-missing`
 */
function scopeAdvisory(context) {
  const check = checkPublishAllowed({ workspaceRoot: context.root, projectName: context.projectName });
  if (check.allowed) {
    if (check.forced) console.error(`publish: ${context.projectName} — ${check.reason}`);
    return { proceed: true };
  }
  if (check.kind === 'force-reason-missing') {
    console.error(
      `publish: REFUSED for ${context.projectName} — ${check.reason} ` +
        `(fix: set RELEASE_FORCE_REASON="<why>", or unset RELEASE_FORCE_FULL_PUBLISH — the override is not needed for a ` +
        `raw \`nx run ${context.projectName}:publish\`).`
    );
    return { proceed: false };
  }
  console.error(
    `publish: NOTE ${context.projectName} — no fresh release manifest lists it (${check.kind}); proceeding because its ` +
      `built content differs from the registry (or it was never published), i.e. it is in the changed-set by definition.`
  );
  return { proceed: true };
}

/**
 * The version already exists on the registry (npm said so). Decide by CONTENT
 * what that means: equal -> reconcile the cache and succeed; different -> fail
 * loudly (we must NOT write-through the local hash under a version that holds
 * other bytes — that would poison published-state.json); unverifiable -> fail
 * (re-run; nothing is cached).
 */
async function settleExistingVersion({ context, name, version, distDir, workDir, options, rec }) {
  let result;
  try {
    result = rec.time('reconcilePackage (registry content vs local dist)', () =>
      reconcilePackage({ name, version, distDir, workDir })
    );
  } catch (err) {
    result = { status: 'error', error: err && err.message ? err.message : String(err) };
  }
  if (result.status === 'fast' || result.status === 'slow') {
    const localHash = normalizedHash(distDir);
    if (result.entry.normalizedHash === localHash) {
      console.error(`publish: ${name}@${version} already on npm with IDENTICAL content — nothing to do, reconciling cache.`);
      if (!options.dryRun) await writeThroughCache(context.root, name, version, distDir, workDir, rec);
      return { success: true, outcome: outcome('skipped-already-published', { name, version }) };
    }
    console.error(
      `publish: ${name}@${version} is already on npm but with DIFFERENT content than the build here — refusing to ` +
        `overwrite (published versions are immutable) and not touching published-state.json. Fix: ` +
        `npx nx run ${context.projectName}:version (bumps past ${version}), then re-run publish.`
    );
    return { success: false, outcome: outcome('failed', { name, version }) };
  }
  console.error(
    `publish: npm reports ${name}@${version} exists but its content could not be fetched for comparison ` +
      `(${result.error || result.status}; registry read lag is possible). Nothing was cached. Fix: re-run ` +
      `npx nx run ${context.projectName}:publish in a minute.`
  );
  return { success: false, outcome: outcome('failed', { name, version }) };
}

async function run(options, context) {
  return withMetrics('publish', context, async (rec) => {
    const projectRoot = context.projectsConfigurations.projects[context.projectName].root;
    const pkgRoot = join(context.root, projectRoot);
    const distDir = join(pkgRoot, 'dist');
    const distPkgPath = join(distDir, 'package.json');

    if (!existsSync(distPkgPath)) {
      console.error(`publish: no ${relative(context.root, distPkgPath)} — build + dist-manifest must run first (this target dependsOn them).`);
      return { success: false, outcome: outcome('failed') };
    }

    // BUG-BUILD-PUBLISH-DISTMANIFEST-CLOBBERED-001: re-stamp the dist manifest
    // HERE, as the truly-last write before the real `npm publish` spawn below —
    // see writeDistManifest's own doc comment (generate-manifest.js) for why
    // `dependsOn: [..., "dist-manifest", ...]` ordering alone isn't sufficient.
    const manifest = await writeDistManifest(context, pkgRoot, distDir);
    rec.phase('writeDistManifest');
    const { name, version } = manifest;
    if (!name || !version) {
      console.error(`publish: ${relative(context.root, distPkgPath)} has no name/version.`);
      return { success: false, outcome: outcome('failed') };
    }

    // DECISION FIRST — by CONTENT vs what the registry holds (the committed
    // published-state.json is the zero-network record of it; `version`, which
    // this target dependsOn, backfills it from npm on a miss). Nothing else —
    // no manifest, no scope check — may stand between an unchanged package and
    // a successful no-op.
    const cached = readState(context.root)[name];
    rec.phase('readState');
    if (cached && cached.version === version) {
      const localHash = normalizedHash(distDir);
      rec.phase('normalizedHash');
      // A legacy entry with no hash cannot be compared; keep the historical
      // (version-equality) no-op for it rather than guess.
      if (!cached.normalizedHash || cached.normalizedHash === localHash) {
        console.error(`publish: ${name}@${version} already on npm with identical content (published-state cache hit, zero network) — nothing to do.`);
        return { success: true, outcome: outcome('skipped-already-published', { name, version }) };
      }
      // Same version, different build, no bump: never silently skipped. `version`
      // owns source + changelog writes, so publish names the one-line fix.
      console.error(
        `publish: ${name}@${version} is already on npm but the built content DIFFERS from it and the version was not ` +
          `bumped (is \`version\` being skipped, e.g. ADHD_NX_VERSION_DRY_RUN=1 or --excludeTaskDependencies?). ` +
          `Fix: npx nx run ${context.projectName}:version, then re-run publish.`
      );
      return { success: false, outcome: outcome('failed', { name, version }) };
    }

    // From here the package really will be published (never published, or a
    // build the registry does not hold). Scope advisory — see header.
    if (!options.dryRun && !scopeAdvisory(context).proceed) {
      return { success: false, outcome: outcome('refused', { name, version }) };
    }

    // DEBT-002 #2: `options.access` (an explicit task-option override) wins
    // when supplied; otherwise defer to the package's OWN declared
    // `publishConfig.access` on the (rebased) dist manifest — never blindly
    // hardcode 'public' over a package's explicit choice.
    const access = options.access || manifest.publishConfig?.access || 'public';
    const args = ['publish', distDir, '--access', access];
    if (options.tag) args.push('--tag', String(options.tag));
    if (options.dryRun) args.push('--dry-run');
    // OTP goes to npm through the ENVIRONMENT (`npm_config_otp`), never argv:
    // argv is visible in `ps` and is echoed into the metrics label below.
    // Precedence: --otp task option, then NPM_CONFIG_OTP, then npm_config_otp.
    const otp = options.otp || process.env.NPM_CONFIG_OTP || process.env.npm_config_otp;
    const npmEnv = { ...process.env };
    if (otp) npmEnv.npm_config_otp = String(otp);

    console.error(`publish: ${name}@${version}${options.dryRun ? ' [dry-run]' : ''} from ${relative(context.root, distDir)}`);
    // stdout stays inherited (a human watching a real publish sees npm's own
    // progress live); stderr is piped so a failure can be inspected here to
    // distinguish "genuinely failed" from "version already exists" and from
    // auth failures — and is echoed to our own stderr afterward either way.
    const res = rec.time(`npm ${args.join(' ')}`, () => sh('npm', args, { stdio: ['inherit', 'inherit', 'pipe'], env: npmEnv }));
    rec.network('npm publish');
    if (res.stderr) process.stderr.write(res.stderr);
    const workDir = join(context.root, 'tmp', 'nx-build-publish', context.projectName);

    if (res.status !== 0) {
      if (isAlreadyPublishedError(res.stderr) || isPublishedLive(name, version, rec)) {
        return settleExistingVersion({ context, name, version, distDir, workDir, options, rec });
      }
      const authHelp = describeAuthFailure(res.stderr, context.projectName);
      if (authHelp) console.error(`publish: ${name}@${version} — ${authHelp}`);
      console.error(`publish: npm publish failed (exit ${res.status}) for ${name}@${version} — nothing published for this package.`);
      return { success: false, outcome: outcome('failed', { name, version }) };
    }

    if (!options.dryRun) {
      // VERIFY BEFORE CACHING (defect 32af828b): npm's exit 0 / HTTP 202 says
      // "accepted", not "retrievable". Confirm the specific version is
      // actually served by the registry before we trust it — otherwise a
      // never-promoted publish would both withhold the package AND poison the
      // cache. See lib/publish-verify.js for the poll and why this is a direct
      // version GET rather than `npm view`.
      const verification = await verifyVersionRetrievable({ name, version });
      if (!verification.retrievable) {
        console.error(
          `publish: ${name}@${version} — npm reported success but the version is NOT retrievable from the registry ` +
          `after ${verification.attempts} attempt(s) (last status: ${verification.lastStatus}). npm's ` +
          `"being processed" (HTTP 202) can lag by many minutes; refusing to write published-state.json so this ` +
          `version is retried on the next run rather than being silently withheld and cached as done.`
        );
        return { success: false, outcome: outcome('failed', { name, version }) };
      }
      await writeThroughCache(context.root, name, version, distDir, workDir, rec);
      console.error(`publish: ${name}@${version} -> published-state.json updated (write-through; version verified over ${verification.attempts} attempt(s)).`);
    }
    return {
      success: true,
      outcome: outcome(options.dryRun ? 'dry-run' : 'published', { name, version }),
    };
  });
}

module.exports = run;
module.exports.default = run;
module.exports.__internals = { isPublishedLive, isAlreadyPublishedError, writeThroughCache, describeAuthFailure };
