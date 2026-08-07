#!/usr/bin/env node
/**
 * tools/nx-plugins/build/executors/range-check/check-release-ranges.mjs
 *
 * GATE 1 — pre-publish range-resolvability check (offline, fast; see
 * `../../lib/range-resolvability.js` for the full design rationale and
 * `BUG-RELEASE-UNINSTALLABLE-AGENTMCP-001`).
 *
 * Asserts that EVERY intra-`@adhd/*` dependency range declared by a
 * publishable project in this workspace resolves against
 * {versions already on the registry} ∪ {versions this release is about to
 * publish}. Fetches each unique dependency name's published version list
 * from the registry EXACTLY ONCE (batched, parallel) — no per-edge network,
 * no `npm view` subprocess per package.
 *
 * WIRED INTO THE RELEASE FLOW (package.json):
 *   "release":     "node tools/nx-plugins/build/executors/range-check/check-release-ranges.mjs && pnpm nx run-many -t publish"
 *   "release:dry": "... && node .../check-release-ranges.mjs && npx nx run-many -t publish --dryRun"
 * A non-zero exit here means `&&` never reaches `nx run-many -t publish` —
 * NOTHING touches the registry until this gate is green.
 *
 * Usage:
 *   node tools/nx-plugins/build/executors/range-check/check-release-ranges.mjs [--json]
 *
 * Exit 0 — every internal range resolves.
 * Exit 1 — at least one UNRESOLVABLE edge found (printed with dependent,
 *          dependency, declared range, and what's actually available).
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  discoverReleaseSet,
  collectDependencyNames,
  fetchRegistryVersions,
  checkRangeResolvability,
  formatViolation,
} = require('../../lib/range-resolvability');

const findRoot = (d) => {
  while (d !== dirname(d)) {
    if (existsSync(join(d, 'nx.json'))) return d;
    d = dirname(d);
  }
  return d;
};
const workspaceRoot = findRoot(dirname(fileURLToPath(import.meta.url)));

/**
 * The full check, wired with the real registry fetcher by default. Exposed
 * so the `range-check`-backed nx target / tests can inject a fake
 * `fetchVersions`/`workspaceRoot` without ever hitting the network or the
 * real repo tree.
 *
 * @param {{ workspaceRoot?: string, fetchVersions?: (names: string[]) => Promise<Map<string,string[]>> }} [opts]
 */
export async function runCheck(opts = {}) {
  const root = opts.workspaceRoot || workspaceRoot;
  const releaseSet = discoverReleaseSet(root);
  const dependencyNames = collectDependencyNames(releaseSet);
  const registryVersions = opts.fetchVersions
    ? await opts.fetchVersions(dependencyNames)
    : await fetchRegistryVersions(dependencyNames);
  const { ok, violations } = checkRangeResolvability(releaseSet, registryVersions);
  return { ok, violations, releaseSet, dependencyNames, registryVersions };
}

async function main() {
  const asJson = process.argv.includes('--json');
  const t0 = Date.now();
  const { ok, violations, releaseSet, dependencyNames } = await runCheck();
  const elapsedMs = Date.now() - t0;

  if (asJson) {
    process.stdout.write(
      JSON.stringify(
        {
          ok,
          checkedProjects: releaseSet.length,
          checkedDependencyNames: dependencyNames.length,
          elapsedMs,
          violations,
        },
        null,
        2
      ) + '\n'
    );
  } else {
    console.error(
      `range-check: ${releaseSet.length} publishable project(s), ${dependencyNames.length} unique @adhd/* dependency name(s) resolved against the registry in ${elapsedMs}ms.`
    );
    if (ok) {
      console.error('range-check: OK — every intra-@adhd/* dependency range in the release set is resolvable.');
    } else {
      console.error(`range-check: FAILED — ${violations.length} unresolvable dependency range(s):`);
      for (const v of violations) console.error(`  ✖ ${formatViolation(v)}`);
      console.error(
        '\nrange-check: BLOCKING publish. Fix the above range(s) — either bump the declared range down to a ' +
          'version that is actually published, or include the dangling dependency in THIS release so its own ' +
          'version settles before anything downstream publishes — before retrying.'
      );
    }
  }
  process.exit(ok ? 0 : 1);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main();
}
