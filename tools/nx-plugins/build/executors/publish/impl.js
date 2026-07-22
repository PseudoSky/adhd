'use strict';
/**
 * @adhd/nx-build:publish — per-project publish TASK.
 *
 * The publishable seam is a proper nx target (not a standalone script), so
 * releasing the workspace is just `nx run-many -t publish` — nx handles fan-out,
 * ordering, and the gate `dependsOn` (build → dist-manifest → verify-dist-load →
 * publish-hygiene, wired in plugin.js). Not cached: publishing is a side effect.
 *
 * The npm REGISTRY is the source of truth for what's released (no git tags): this
 * publishes the built `dist/` iff `name@version` is not already on the registry,
 * and is a no-op skip if it is (npm refuses to publish over an existing version
 * anyway). Versioning model: the source package.json `version` IS the release
 * version — bump it to cut a new release.
 *
 * Options (forwarded from `nx run-many -t publish --<opt>=<val>`):
 *   --dryRun         pack + report, publish nothing
 *   --otp=<code>     npm one-time password (2FA)
 *   --tag=<dist-tag> publish under a dist-tag (default: latest)
 *   --access=<a>     npm access (default: public)
 */
const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { join, relative } = require('node:path');

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts });
}

/** true iff <name>@<version> is already on the registry (the "published reference"). */
function isPublished(name, version) {
  const res = sh('npm', ['view', `${name}@${version}`, 'version'], { stdio: ['ignore', 'pipe', 'ignore'] });
  return res.status === 0 && String(res.stdout).trim() === version;
}

async function run(options, context) {
  const projectRoot = context.projectsConfigurations.projects[context.projectName].root;
  const distDir = join(context.root, projectRoot, 'dist');
  const distPkgPath = join(distDir, 'package.json');

  if (!existsSync(distPkgPath)) {
    console.error(`publish: no ${relative(context.root, distPkgPath)} — build + dist-manifest must run first (this target dependsOn them).`);
    return { success: false };
  }
  const { name, version } = JSON.parse(readFileSync(distPkgPath, 'utf8'));
  if (!name || !version) {
    console.error(`publish: ${relative(context.root, distPkgPath)} has no name/version.`);
    return { success: false };
  }

  // Registry is the source of truth — skip anything already released.
  if (isPublished(name, version)) {
    console.error(`publish: ${name}@${version} already on npm — skipping.`);
    return { success: true };
  }

  const args = ['publish', distDir, '--access', options.access || 'public'];
  if (options.tag) args.push('--tag', String(options.tag));
  if (options.otp) args.push('--otp', String(options.otp));
  if (options.dryRun) args.push('--dry-run');

  console.error(`publish: ${name}@${version}${options.dryRun ? ' [dry-run]' : ''} from ${relative(context.root, distDir)}`);
  const res = sh('npm', args, { stdio: 'inherit' });
  if (res.status !== 0) {
    console.error(`publish: npm publish failed (exit ${res.status}) for ${name}@${version} — nothing published for this package.`);
    return { success: false };
  }
  return { success: true };
}

module.exports = run;
module.exports.default = run;
