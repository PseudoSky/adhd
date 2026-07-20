'use strict';

/**
 * Local Nx plugin: infers a `sync-deps` (and `sync-deps-check`) target for
 * every buildable project in the workspace.
 *
 * WHY THIS EXISTS (see BACKLOG.md DEBT-WORKSPACE-DEPCHECK-001,
 * BUG-REPO-PRECOMMIT-PARTIAL-STAGE-001 and
 * BUG-REPO-PRECOMMIT-DEPCHECK-STRIPS-USED-DEPS-001 for the full history):
 *
 * This repo pins Nx 18.3.4. Nx's "sync generators" mechanism (`nx sync`,
 * `nx.json` `sync.globalGenerators`, `@nx/js` package.json/tsconfig sync
 * generators) does not exist until Nx 20 — verified against the installed
 * `nx --help` (no `sync` subcommand) and `@nx/js/generators.json`
 * (`['library','init','convert-to-swc','release-version',
 * 'setup-verdaccio','setup-build']` — no sync generator) at the time this
 * plugin was written. There is no supported "nx sync" to adopt on this
 * version, so this plugin is the pragmatic equivalent: an Nx *inferred
 * tasks* plugin (`createNodes`, the same mechanism `@nx/eslint/plugin`,
 * `@nx/vite/plugin`, etc. already use in this workspace) that synthesizes
 * a `sync-deps` target for every project with a `package.json` sitting
 * next to a `project.json` that defines a `build` target.
 *
 * `sync-deps` runs ESLint's `@nx/dependency-checks --fix` scoped to just
 * that project's `package.json` — the exact same auto-fixer the pre-commit
 * hook used to run implicitly, now available as an explicit, discoverable,
 * standalone command:
 *
 *   npx nx run <project>:sync-deps        # fix one project
 *   npx nx run-many -t sync-deps          # fix every project
 *   npx nx affected -t sync-deps          # fix only affected projects
 *
 * `build` already `dependsOn: ["^build", "lint"]` (nx.json targetDefaults),
 * and `lint` already runs `@nx/dependency-checks` in CHECK mode (no --fix)
 * as part of a project's full `eslint .` — so `nx build`/`nx run-many -t
 * build` already fails loudly (real ESLint error, real exit code) when a
 * package.json's declared deps have drifted from its actual imports. What
 * was missing was a fix path that didn't require a git commit (and
 * therefore the pre-commit hook) to trigger. `sync-deps` is that fix path.
 *
 * `sync-deps-check` is the read-only twin (no `--fix`) — identical to what
 * `lint` already enforces for package.json specifically, exposed as its
 * own target so CI / other tooling can gate on dependency-drift alone
 * without paying for a full style lint pass.
 *
 * NODE_MODULES-INSTALL SAFETY (BUG-REPO-PRECOMMIT-DEPCHECK-STRIPS-USED-
 * DEPS-001 — see scripts/eslint-dependency-checks.mjs's header for the full
 * root-cause writeup): `@nx/dependency-checks` in this repo resolves each
 * package's "canonical" external-node key by reading real files under
 * `<workspaceRoot>/node_modules/<pkg>/package.json` (Nx's yarn-lockfile
 * parser, `getHoistedPackageVersion`). A freshly created git worktree has
 * an EMPTY `node_modules` (git doesn't copy/install it), so that lookup
 * fails for every project-level dep and `--fix` will delete real,
 * fully-static, genuinely-used imports — not just dynamic ones. Both
 * `sync-deps` and `sync-deps-check` below shell out through
 * scripts/eslint-dependency-checks.mjs specifically so they inherit its
 * install-marker guard and refuse to run (loud, actionable error, never a
 * silent false result) rather than mutate/report against an unreliable
 * graph.
 *
 * DYNAMIC-IMPORT SAFETY (BACKLOG DEBT-WORKSPACE-DEPCHECK-001 follow-up):
 * `@nx/dependency-checks`
 * derives a project's "expected" npm/workspace deps from Nx's project
 * graph, which is built by statically scanning for import/require/dynamic
 * import() expressions with a STRING-LITERAL argument
 * (`nx/src/plugins/js/project-graph/build-dependencies` via the native
 * `findImports`). A package reached ONLY via a computed expression (e.g.
 * `require(pkgNameVar)`, `require(['@adhd', name].join('-'))`) is
 * invisible to that scan, so `checkObsoleteDependencies` will flag it and
 * `--fix` — including `sync-deps` here — WILL silently delete it from
 * package.json. This was verified empirically (build+revert probe on
 * `data-core-structures` -> `data-base-transforms`, see BACKLOG). The
 * fix is NOT to disable the check; it's to make the intentionally-dynamic
 * dependency explicit via `ignoredDependencies` in that project's own
 * `.eslintrc.json` `@nx/dependency-checks` override (verified: the
 * dependency then survives `--fix` intact even with a computed-expression
 * require). `sync-deps` runs the SAME rule with the SAME per-project
 * config eslint would otherwise resolve, so this protection applies
 * automatically — there is nothing extra to wire here, only the
 * documentation obligation for any future genuinely-dynamic require site.
 */

const { existsSync, readFileSync } = require('node:fs');
const { dirname, join, basename } = require('node:path');
const { hasBuildTarget } = require('../shared/detect-build-target');

const SYNC_TARGET_NAME = 'sync-deps';
const SYNC_CHECK_TARGET_NAME = 'sync-deps-check';

/**
 * @type {[string, (configFilePath: string, options: unknown, context: { workspaceRoot: string }) => { projects?: Record<string, unknown> }]}
 */
exports.createNodes = [
  '**/package.json',
  (packageJsonPath, _options, context) => {
    const projectRoot = dirname(packageJsonPath);

    if (
      projectRoot === '.' ||
      projectRoot.startsWith('node_modules/') ||
      projectRoot.includes('/node_modules/') ||
      projectRoot.startsWith('dist/') ||
      projectRoot.includes('/dist/') ||
      projectRoot.startsWith('tmp/') ||
      projectRoot.includes('/tmp/')
    ) {
      return {};
    }

    const projectJsonPath = join(
      context.workspaceRoot,
      projectRoot,
      'project.json'
    );
    if (!existsSync(projectJsonPath)) {
      // Not an Nx project (e.g. a fixture/scratch package.json) — skip.
      return {};
    }

    let projectName = basename(projectRoot);
    try {
      const projectJson = JSON.parse(readFileSync(projectJsonPath, 'utf-8'));
      projectName = projectJson.name || projectName;
    } catch {
      return {};
    }

    // @nx/dependency-checks itself only fires for projects with a build
    // target (see the rule source: it early-returns if none of
    // `buildTargets` exists on the project) — a package with nothing to
    // build has nothing to publish, so nothing to sync. `build` is often
    // INFERRED (e.g. via @nx/vite/plugin from vite.config.ts), not
    // declared in project.json — see shared/detect-build-target.js.
    if (!hasBuildTarget(context.workspaceRoot, projectRoot)) {
      return {};
    }

    const packageJsonRel = `${projectRoot}/package.json`;
    // Relative, not `{workspaceRoot}/...`: nx:run-commands only allows the
    // `{workspaceRoot}` token at the very START of an option value, and it
    // would otherwise land mid-string here. `options.cwd` below is already
    // `{workspaceRoot}` (itself token-leading, so valid), so a plain
    // relative path resolves correctly at run time.
    const wrapperScript = './scripts/eslint-dependency-checks.mjs';
    const sharedTargetShape = {
      // Goes through the guarded wrapper (never raw `eslint`) — see its
      // header + the plugin header above for why: an uninstalled
      // node_modules makes @nx/dependency-checks misreport EVERY
      // dependency as unused. This deliberately bypasses nx's `lint`
      // executor plumbing so it works standalone and only ever touches
      // the one package.json file — never anything the caller may have
      // separately staged/edited.
      options: { cwd: '{workspaceRoot}' },
      // Dependency drift is a function of the WHOLE project graph (any
      // other project's source can add/remove what this one "should"
      // depend on), not just this project's own file set — never cache.
      cache: false,
      inputs: [
        '{workspaceRoot}/' + packageJsonRel,
        '{workspaceRoot}/tools/nx-plugins/dependency-sync/plugin.js',
        '{workspaceRoot}/scripts/eslint-dependency-checks.mjs',
      ],
    };

    return {
      projects: {
        [projectRoot]: {
          targets: {
            [SYNC_TARGET_NAME]: {
              ...sharedTargetShape,
              command: `node ${wrapperScript} ${packageJsonRel} --fix`,
              metadata: {
                description: `Auto-repair ${packageJsonRel}'s dependencies to match its actual imports (via @nx/dependency-checks --fix). Run this instead of relying on the pre-commit hook.`,
                technologies: ['eslint'],
              },
            },
            [SYNC_CHECK_TARGET_NAME]: {
              ...sharedTargetShape,
              command: `node ${wrapperScript} ${packageJsonRel}`,
              metadata: {
                description: `Fail loudly if ${packageJsonRel}'s dependencies have drifted from its actual imports. Fix with: npx nx run ${projectName}:${SYNC_TARGET_NAME}`,
                technologies: ['eslint'],
              },
            },
          },
        },
      },
    };
  },
];
