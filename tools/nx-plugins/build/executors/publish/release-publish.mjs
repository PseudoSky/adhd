#!/usr/bin/env node
/**
 * tools/nx-plugins/build/executors/publish/release-publish.mjs
 * (moved here from the former `scripts/release-publish.mjs` — see PUBLISHING.md
 * for every reference to this path, all now corrected to point here.)
 *
 * NOTE: this wraps the now-RETIRED `nx release publish` / `nx-release-publish`
 * target model. The CURRENT pipeline (`pnpm release` → `nx run-many -t publish`,
 * the custom `@adhd/nx-build:publish` executor — see `../../plugin.js` and
 * PUBLISHING.md's "Workflow" section) does not call this script; `package.json`'s
 * `release` script invokes `nx run-many -t publish` directly. This file remains
 * only for the "Retired: the former `nx release` workflow" doc section's
 * historical commands — do not wire new callers to it.
 *
 * THE canonical entry point for publishing this workspace's packages. Replaces
 * calling `npx nx release publish` directly — see PUBLISHING.md.
 *
 * WHY THIS EXISTS (BUG-RELEASE-PUBLISH-GATE-BYPASS-001):
 * `nx-release-publish` targets in this repo declare `dependsOn: ["build", "test",
 * "verify-dist-load"]` (per-project `project.json`, plus a `nx.json` targetDefaults
 * fallback of `["build", "test"]`) specifically so a broken build can never reach
 * `npm publish`. Confirmed by direct reproduction in this repo (2026-07-20):
 *
 *   npx nx release publish --projects=apigen-plugin-mcp,apigen-plugin-openapi --dry-run
 *
 * ran ONLY the `nx-release-publish` task for those two projects — ZERO dependency
 * tasks (no build, no test, no verify-dist-load) — and printed "Would publish"
 * for both even though their dist/index.mjs entries threw ReferenceError on load
 * (see BACKLOG.md INVESTIGATION-BUILD-TOOL-001 / BUG-RELEASE-PUBLISH-GATE-BYPASS-001).
 * This is a confirmed upstream Nx limitation, not something misconfigured in this
 * repo — see https://github.com/nrwl/nx/issues/22720,
 * https://github.com/nrwl/nx/issues/27749, and
 * https://github.com/nrwl/nx/issues/30552 (`nx release`'s internal publish
 * orchestration does not expand the task graph through each project's
 * `nx-release-publish.dependsOn` the way `run-many`/`affected`/a direct
 * `nx run <project>:<target>` invocation does).
 *
 * Also confirmed in this repo: UNFILTERED `nx release publish` (no --projects)
 * DOES correctly expand and run the dependency chain (202 dependency tasks ran
 * for a 52-project release, and it correctly failed non-zero when
 * verify-dist-load failed). The bug is specific to the `--projects=<explicit
 * list>` filter path — exactly the path PUBLISHING.md's "Selective publishing"
 * and "Single-package workflow" sections previously told people to use.
 *
 * THE FIX: never call `nx release publish` with `--projects` directly. This
 * script is the one place that decides how to invoke the real publish, and it
 * always routes through a mechanism proven (by the reproduction above and by
 * this script's own negative-control test — no such test currently exists in
 * this repo, a gap; see BACKLOG.md DEBT-BUILD-RELEASE-PUBLISH-NO-TEST-001) to
 * honor dependsOn:
 *
 *   - `--projects=<list>` given  -> `npx nx run-many -t nx-release-publish
 *     --projects=<list>` (run-many always expands dependsOn; nx release's own
 *     --projects filter does not).
 *   - no `--projects` given      -> `npx nx release publish` unfiltered, which
 *     is the one nx release publish invocation shape verified to expand
 *     dependsOn correctly. (Still routed through this script, not called
 *     directly, so the "which command is safe" decision lives in exactly one
 *     place and can't be silently re-broken by copy-pasting the wrong nx
 *     invocation into a doc or a CI step again.)
 *
 * Every other flag (--dry-run, --specifier, etc.) is passed through unchanged.
 *
 * Usage (mirrors `nx release publish`):
 *   node tools/nx-plugins/build/executors/publish/release-publish.mjs --dry-run
 *   node tools/nx-plugins/build/executors/publish/release-publish.mjs --dry-run --projects=apigen-plugin-mcp,apigen-plugin-openapi
 *   node tools/nx-plugins/build/executors/publish/release-publish.mjs
 *
 * Exit code: propagates the underlying nx command's exit code unchanged. A
 * failed build/test/verify-dist-load gate means this exits non-zero and NOTHING
 * gets published — that is the entire point of this wrapper.
 */

import { spawnSync } from 'node:child_process';

function parseArgs(argv) {
  let projects = null;
  const passthrough = [];
  for (const arg of argv) {
    if (arg.startsWith('--projects=')) {
      projects = arg.slice('--projects='.length);
    } else if (arg === '--projects') {
      throw new Error(
        "release-publish: use '--projects=<list>' (with '='), not a separate '--projects <list>' argument pair."
      );
    } else {
      passthrough.push(arg);
    }
  }
  return { projects, passthrough };
}

function run(command, args) {
  console.error(`release-publish: running: ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) {
    console.error(`release-publish: failed to spawn ${command}: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

function main() {
  const { projects, passthrough } = parseArgs(process.argv.slice(2));

  let exitCode;
  if (projects) {
    console.error(
      `release-publish: explicit --projects='${projects}' given. Routing through ` +
        "'nx run-many -t nx-release-publish' — NOT 'nx release publish --projects=', " +
        'which is confirmed to bypass build/test/verify-dist-load dependsOn ' +
        '(BUG-RELEASE-PUBLISH-GATE-BYPASS-001). See this file\'s header comment.'
    );
    exitCode = run('npx', [
      'nx',
      'run-many',
      '-t',
      'nx-release-publish',
      `--projects=${projects}`,
      ...passthrough,
    ]);
  } else {
    console.error(
      'release-publish: no --projects filter given. Unfiltered ' +
        "'nx release publish' is confirmed to correctly expand dependsOn " +
        '(build/test/verify-dist-load) for the full release set — running it directly.'
    );
    exitCode = run('npx', ['nx', 'release', 'publish', ...passthrough]);
  }

  if (exitCode !== 0) {
    console.error(
      `\nrelease-publish: FAILED (exit ${exitCode}) — nothing was published. ` +
        'This is almost certainly a real build/test/verify-dist-load failure in ' +
        'one or more release-eligible projects; fix it before retrying. Do not ' +
        "bypass this script by calling 'nx release publish' directly."
    );
  }
  process.exit(exitCode);
}

main();
