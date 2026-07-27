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
 * new got versioned. Only when the cache does NOT already know this exact
 * version does `publish` fall through to the real `npm publish` attempt
 * (which needs the network anyway — that's the actual release action).
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
 * Versioning model: the source package.json `version` IS the release
 * version — bump it (via `version`) to cut a new release.
 *
 * Options (forwarded from `nx run-many -t publish --<opt>=<val>`):
 *   --dryRun         pack + report, publish nothing (cache is NOT written)
 *   --otp=<code>     npm one-time password (2FA)
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
 * Write-through: compute this package's `{version, normalizedHash,
 * publishedIntegrity}` from the dist that was JUST packed/published — an
 * OFFLINE local pack + hash, never a re-fetch from the registry (immune to
 * npm read-after-write lag by construction: we know exactly what we shipped).
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
  const entry = { version, normalizedHash: normalizedHash(distDir), publishedIntegrity };
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

async function run(options, context) {
  return withMetrics('publish', context, async (rec) => {
    const projectRoot = context.projectsConfigurations.projects[context.projectName].root;
    const pkgRoot = join(context.root, projectRoot);
    const distDir = join(pkgRoot, 'dist');
    const distPkgPath = join(distDir, 'package.json');

    if (!existsSync(distPkgPath)) {
      console.error(`publish: no ${relative(context.root, distPkgPath)} — build + dist-manifest must run first (this target dependsOn them).`);
      return { success: false };
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
      return { success: false };
    }

    // ZERO-NETWORK existence check: the committed published-state cache.
    const cached = readState(context.root)[name];
    rec.phase('readState');
    if (cached && cached.version === version) {
      console.error(`publish: ${name}@${version} already on npm (published-state cache hit, zero network) — skipping.`);
      return { success: true };
    }

    // DEBT-002 #2: `options.access` (an explicit task-option override) wins
    // when supplied; otherwise defer to the package's OWN declared
    // `publishConfig.access` on the (rebased) dist manifest — never blindly
    // hardcode 'public' over a package's explicit choice. Every package in
    // this workspace is public today, so this is behavior-neutral for them
    // (falls through to the same 'public' default either way); it only
    // changes behavior for a package that actually declares
    // `publishConfig.access: "restricted"`.
    const access = options.access || manifest.publishConfig?.access || 'public';
    const args = ['publish', distDir, '--access', access];
    if (options.tag) args.push('--tag', String(options.tag));
    if (options.otp) args.push('--otp', String(options.otp));
    if (options.dryRun) args.push('--dry-run');

    console.error(`publish: ${name}@${version}${options.dryRun ? ' [dry-run]' : ''} from ${relative(context.root, distDir)}`);
    // stdout stays inherited (a human watching a real publish sees npm's own
    // progress live); stderr is piped so a failure can be inspected here to
    // distinguish "genuinely failed" from "cannot publish over previously
    // published version" (the write-through's read-lag case) — and is echoed
    // to our own stderr afterward either way, so nothing that used to be
    // visible under the old `stdio:'inherit'` is lost.
    const res = rec.time(`npm ${args.join(' ')}`, () => sh('npm', args, { stdio: ['inherit', 'inherit', 'pipe'] }));
    rec.network('npm publish');
    if (res.stderr) process.stderr.write(res.stderr);
    const workDir = join(context.root, 'tmp', 'nx-build-publish', context.projectName);

    if (res.status !== 0) {
      if (isAlreadyPublishedError(res.stderr) || isPublishedLive(name, version, rec)) {
        console.error(`publish: ${name}@${version} already on npm (registry disagreed with a stale cache) — treating as success, reconciling cache.`);
        if (!options.dryRun) await writeThroughCache(context.root, name, version, distDir, workDir, rec);
        return { success: true };
      }
      console.error(`publish: npm publish failed (exit ${res.status}) for ${name}@${version} — nothing published for this package.`);
      return { success: false };
    }

    if (!options.dryRun) {
      await writeThroughCache(context.root, name, version, distDir, workDir, rec);
      console.error(`publish: ${name}@${version} -> published-state.json updated (write-through).`);
    }
    return { success: true };
  });
}

module.exports = run;
module.exports.default = run;
module.exports.__internals = { isPublishedLive, isAlreadyPublishedError, writeThroughCache };
