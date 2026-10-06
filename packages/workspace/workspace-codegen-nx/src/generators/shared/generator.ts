import {
  type Tree,
  formatFiles,
  joinPathFragments,
  logger,
  readJson,
  writeJson,
} from '@nx/devkit';
import { libraryGenerator } from '@nx/js';
import { readWorkspaceConfig, validateGroup, validatePlatform, validateNxLayer } from './workspace-config';

export interface ScaffoldGeneratorSchema {
  type: 'base' | 'core' | 'engine' | 'store' | 'plugin' | 'generator' | 'query' | 'types' | 'entrypoint';
  name: string;
  group: string;
  nxLayer: string;
  platform: 'node' | 'browser' | 'shared';
  access?: 'domain' | 'public';
  publish?: boolean;
}

const TYPE_TO_CLASS: Record<string, string> = {
  base: 'foundation',
  core: 'foundation',
  engine: 'foundation',
  store: 'foundation',
  query: 'foundation',
  plugin: 'optional',
  generator: 'optional',
  types: 'types',
  entrypoint: 'entrypoint',
};

export async function scaffoldGenerator(tree: Tree, schema: ScaffoldGeneratorSchema) {
  const { type, name, group, nxLayer, platform, access = 'domain', publish = false } = schema;

  // Determine directory and project name
  let dir: string;
  let projectName: string;
  let importPath: string;

  if (type === 'entrypoint') {
    // Entrypoints live under entrypoint/ with <name>/
    dir = `entrypoint/${name}`;
    projectName = name;
    importPath = `@adhd/${name}`;
  } else {
    const pkgName = `${group}-${type}-${name}`;
    dir = `packages/${group}`;
    projectName = pkgName;
    importPath = `@adhd/${pkgName}`;
  }

  // Validate against workspace config
  const config = readWorkspaceConfig(tree);
  if (type !== 'entrypoint') {
    const groupErr = validateGroup(group, config);
    if (groupErr) throw new Error(groupErr);
  }
  const platformErr = validatePlatform(platform, config);
  if (platformErr) throw new Error(platformErr);
  const nxLayerErr = validateNxLayer(nxLayer, config);
  if (nxLayerErr) throw new Error(nxLayerErr);

  logger.info(`Scaffolding ${projectName} at ${dir} (${importPath})`);

  // Generate the package
  let projectRoot: string;
  if (type === 'entrypoint') {
    projectRoot = dir;
    scaffoldEntrypoint(tree, projectRoot, projectName);
  } else {
    await libraryGenerator(tree, {
      name: projectName,
      // Nx 19+ generates "as-provided": `directory` IS the project root, not a
      // parent to append `name` to. Passing only the group dir placed the
      // project at `packages/<group>` instead of `packages/<group>/<name>`.
      directory: joinPathFragments(dir, projectName),
      importPath,
      publishable: true,
      bundler: 'vite',
      skipFormat: true,
    });
    projectRoot = joinPathFragments(dir, projectName);
  }

  // Fix project name and tags
  const projectJsonPath = joinPathFragments(projectRoot, 'project.json');
  if (tree.exists(projectJsonPath)) {
    const projectJson = readJson(tree, projectJsonPath);
    projectJson.name = projectName;
    projectJson.sourceRoot = `${projectRoot}/src`;
    const pkgClass = TYPE_TO_CLASS[type] || 'foundation';
    projectJson.tags = [
      `domain:${group}`,
      `pkg-kind:${type}`,
      `pkg-class:${pkgClass}`,
      `layer:${nxLayer}`,
      `platform:${platform}`,
      `access:${access}`,
    ];
    if (publish) {
      projectJson.tags.push('publish:npm');
    }
    writeJson(tree, projectJsonPath, projectJson);
    logger.info(`  Tags: ${projectJson.tags.join(', ')}`);
  }

  // Add tsconfig paths with ./ prefix for TypeScript compatibility
  const tsconfigPath = 'tsconfig.base.json';
  if (tree.exists(tsconfigPath)) {
    const tsconfig = readJson(tree, tsconfigPath);
    if (!tsconfig.compilerOptions) tsconfig.compilerOptions = {};
    if (!tsconfig.compilerOptions.paths) tsconfig.compilerOptions.paths = {};
    tsconfig.compilerOptions.paths[importPath] = [`./${projectRoot}/src/index.ts`];
    writeJson(tree, tsconfigPath, tsconfig);
  }

  // Post-generation patches (same as generate-lib.sh v4/v5)
  // NOTE: patchInSourceDist MUST run before patchViteConfig — patchViteConfig's
  // copy-readme snippet captures whatever `outDir` value is on disk at the
  // moment it runs and bakes it into a plugin closure; if the stale
  // workspace-root outDir were still present when that capture happens, the
  // copy-readme plugin would target the wrong (pre-migration) directory.
  patchInSourceDist(tree, projectRoot);
  patchViteConfig(tree, projectRoot, platform);
  patchReleasePublish(tree, projectRoot);
  ensureReadme(tree, projectRoot, projectName);
  patchEslintrc(tree, projectRoot);
  patchTsconfigLib(tree, projectRoot);
  patchTsconfigSpec(tree, projectRoot);
  patchTypecheckSpec(tree, projectRoot, projectName);
  // DEBT-WORKSPACE-VITE-PATHS-001: deliberately NOT declaring the
  // vite-paths package (workspace-base-vite-paths) as a package.json
  // dependency here. It is consumed by a RELATIVE import into
  // vite.config.ts (see patchViteConfig below), exactly like the pre-existing
  // "../../../tools/vite-plugins/externalize.mjs" / "vitest-pool-defaults.mjs"
  // imports already in this same file — and NEITHER of those is declared as
  // a package.json dependency anywhere in the repo either, because
  // vite.config.ts is listed in every project's own `.eslintrc.json` under
  // `@nx/dependency-checks`'s `ignoredFiles`. Declaring it WAS tried and
  // proven actively wrong: `sync-deps --fix` (which every `lint` run
  // triggers via `dependsOn: ["sync-deps"]") sees a declared dependency with
  // zero usage in any file `@nx/dependency-checks` actually scans, correctly
  // classifies it "obsolete", and strips it straight back out — reproduced
  // directly via `npx nx run <pkg>:sync-deps` on a package that had the
  // dependency added. It is not needed for the import to resolve (Node/vite
  // module resolution for a plain relative path doesn't consult
  // package.json) and would just get silently deleted again on the next
  // lint/sync-deps run either way.

  await formatFiles(tree);
}

/**
 * Locate a scaffolded project's vite config. Nx 23's `@nx/js:library` emits
 * `vite.config.mts`; older Nx emitted `vite.config.ts`. Check both so the
 * patches below apply regardless of which extension the generator produced.
 */
function findViteConfig(tree: Tree, dir: string): string | null {
  for (const file of [
    'vite.config.mts',
    'vite.config.ts',
    'vite.config.mjs',
    'vite.config.js',
  ]) {
    const candidate = joinPathFragments(dir, file);
    if (tree.exists(candidate)) return candidate;
  }
  return null;
}

function patchViteConfig(tree: Tree, dir: string, platform: 'node' | 'browser' | 'shared') {
  const vitePath = findViteConfig(tree, dir);
  if (!vitePath) return;
  let content = tree.read(vitePath, 'utf-8');
  if (!content) return;

  // Add emptyOutDir: true
  if (!content.includes('emptyOutDir')) {
    content = content.replace(/(\s*outDir:\s*['"][^'"]+['"],)/, '$1\n    emptyOutDir: true,');
  }

  // Add copy-readme plugin
  if (!content.includes('copy-readme')) {
    const match = content.match(/outDir:\s*['"]([^'"]+)['"]/);
    const outDir = match ? match[1] : 'dist';
    const plugin = `    {\n      name: 'copy-readme',\n      apply: 'build',\n      closeBundle() {\n        const fs = require('node:fs'), p = require('node:path');\n        const src = p.resolve(__dirname, 'README.md');\n        if (!fs.existsSync(src)) return;\n        const out = p.resolve(__dirname, '${outDir}');\n        fs.mkdirSync(out, { recursive: true });\n        fs.copyFileSync(src, p.join(out, 'README.md'));\n      },\n    },\n`;
    content = content.replace(/(plugins:\s*\[\n)/, `$1${plugin}`);
  }

  // BUILD-CONSIST-008 / INVESTIGATION-BUILD-TOOL-001: `platform:node` and
  // `platform:shared` libraries must externalize every real npm dependency
  // (and Node builtins) so `@nx/vite:build` never bundles heavy CJS-only
  // packages like ts-morph/typescript into the library's own output —
  // bundling them was the confirmed root cause of `verify-dist-load`
  // failures ("__filename is not defined in ES module scope" /
  // "Cannot read properties of undefined (reading 'timeOrigin')") across 10
  // apigen packages (devops-engineer session, 2026-07-20). `@adhd/*`
  // workspace packages must stay BUNDLED (not externalized) — this repo has
  // no `workspaces` linking, so an externalized `require('@adhd/x')` cannot
  // resolve from a built `dist/` artifact at runtime (BUG-WORKSPACE-NO-LINKING-001).
  // `platform:browser` libraries are left as `external: []` — they're
  // consumed by an app's own bundler, not run directly under Node, so the
  // CJS/ESM interop failure mode this fixes doesn't apply there.
  if (platform === 'node' || platform === 'shared') {
    if (!content.includes('externalizeRealDeps')) {
      content = content.replace(
        /(import \{ nxViteTsPaths \} from '@nx\/vite\/plugins\/nx-tsconfig-paths\.plugin';\n)/,
        `$1import { externalizeRealDeps } from '../../../tools/vite-plugins/externalize.mjs';\n`
      );
    }
    content = content.replace(/external:\s*\[\]/, 'external: externalizeRealDeps(__dirname)');
  }

  // BUG-BUILD-002: Vite 8's library build defaults to Rolldown with
  // `platform: 'browser'`, and Rolldown only polyfills `import.meta.url` for a
  // CJS output format when the platform is `node` — otherwise it lowers
  // `import.meta` to `{}`, so a shipped `createRequire(import.meta.url)` becomes
  // `createRequire({}.url)` and throws `ERR_INVALID_ARG_VALUE` at module load.
  // Wire the shared, format-gated shim (a no-op on ES/IIFE/UMD output and on
  // chunks that never reference `import.meta.url`) into every generated CJS-
  // emitting config so a new package cannot re-introduce the defect later.
  // `platform:browser` packages are skipped: their CJS output is never run
  // under Node, where `require('node:url')`/`__filename` are defined.
  // See tools/vite-plugins/import-meta-url-cjs.mjs.
  if (platform === 'node' || platform === 'shared') {
    if (!content.includes('importMetaUrlCjs')) {
      content = content.replace(
        /(import \{ nxViteTsPaths \} from '@nx\/vite\/plugins\/nx-tsconfig-paths\.plugin';\n)/,
        `$1import { importMetaUrlCjs } from '../../../tools/vite-plugins/import-meta-url-cjs.mjs';\n`
      );
      if (/plugins:\s*\[\n/.test(content)) {
        content = content.replace(/(plugins:\s*\[\n)/, `$1    importMetaUrlCjs(),\n`);
      } else {
        content = content.replace(/plugins:\s*\[([^\n\]]*)\]/, (_m, inner: string) => {
          const trimmed = inner.trim();
          return `plugins: [importMetaUrlCjs()${trimmed ? ', ' + trimmed : ''}]`;
        });
      }
    }
  }

  // DEBT-WORKSPACE-VITE-PATHS-001: `cacheDir` / `coverage.reportsDirectory`
  // are generated as literal strings (or `path.join(repoRoot, '...')`) baked
  // to the package's CURRENT directory. Moving a package afterwards
  // (`git mv` to a new domain/tier) silently strands the old, now-wrong
  // path — vite keeps writing its cache/coverage output to a directory that
  // no longer matches the package, or a stale sibling directory shadows the
  // real one. Route both through the vite-paths package's `projectCacheDir`/
  // `projectCoverage` (package name spelled out two paragraphs down), which
  // derive the path from `__dirname` at vite-config-eval time, so a moved
  // package resolves correctly with zero vite.config.ts edits.
  //
  // IMPORTANT: import it by a RELATIVE path to its `src/index.ts`, NOT its
  // `@adhd/`-scoped package-name specifier. A `vite.config.ts`'s own
  // top-level imports are resolved by plain esbuild/Node module resolution
  // when Vite loads the config file itself — the `nxViteTsPaths()` plugin
  // only rewrites `@adhd/*` imports found inside the LIBRARY SOURCE that
  // plugin subsequently builds, not the config file that declares it. This
  // repo also has no `workspaces` linking (BUG-WORKSPACE-NO-LINKING-001, see
  // `tools/vite-plugins/externalize.mjs`), so there is no matching
  // `node_modules/@adhd/<name>` entry to fall back to either — a bare
  // package-name import here throws `Cannot find module` while Nx
  // tries to infer this project's targets from the config, breaking the
  // ENTIRE repo's project graph. Every other cross-file import already
  // living in this template (`externalizeRealDeps`, `vitestPoolOptions`)
  // is relative for exactly this reason; this one follows the same rule.
  // Every non-entrypoint package lives at `packages/<group>/<name>/`, so
  // `../../workspace/workspace-base-vite-paths/src/index` is constant
  // regardless of `<group>` — including when `<group>/<name>` IS
  // `workspace/workspace-base-vite-paths` itself, where the path resolves
  // straight back to its own `src/index.ts`.
  //
  // NOTE: check the full import specifier, not the bare substring
  // "workspace-base-vite-paths" — when scaffolding the vite-paths package
  // itself, its auto-generated `lib.name: 'workspace-workspace-base-vite-
  // paths'` already contains that bare substring, which made a substring
  // check a false-positive "already patched" and silently skipped the
  // import insertion for the vite-paths package's own vite.config.ts.
  if (!content.includes('workspace-base-vite-paths/src/index')) {
    content = content.replace(
      /(import \{ nxViteTsPaths \} from '@nx\/vite\/plugins\/nx-tsconfig-paths\.plugin';\n)/,
      `$1import { projectCacheDir, projectCoverage } from '../../workspace/workspace-base-vite-paths/src/index';\n`
    );
  }
  content = content.replace(
    /cacheDir:\s*(?:'[^']*'|"[^"]*"|(?:path|p)\.join\([\s\S]*?\))\s*,/,
    'cacheDir: projectCacheDir(__dirname),'
  );
  content = content.replace(
    /reportsDirectory:\s*(?:'[^']*'|"[^"]*"|(?:path|p)\.join\([\s\S]*?\))\s*,/,
    'reportsDirectory: projectCoverage(__dirname),'
  );

  // Centralized test-time source resolution — see
  // `tools/vite-plugins/source-resolution.mjs` for the full rationale and the
  // measured build-size proof (364480 B -> 223798 B with a bare
  // `enforce: 'pre'`, byte-identical with `apply: 'serve'`). At TEST time a
  // bare `@adhd/*` specifier resolves through the node_modules symlink to the
  // dependency's built `dist`, because Vite's built-in `vite:resolve` runs
  // BEFORE normal-order user plugins — so the `nxViteTsPaths()` above is never
  // consulted for workspace packages and the test module graph terminates at
  // project boundaries. `nxViteTsPathsPre()` is the same plugin hoisted ahead
  // of `vite:resolve` via `enforce: 'pre'`, scoped to serve via
  // `apply: 'serve'`. Emitting it here is what makes a freshly-scaffolded
  // project structurally incapable of missing the fix. Uses the same
  // idempotent `content.includes(...)` guard style as the externalize /
  // workspace-base-vite-paths imports above.
  //
  // ⚠️ KNOWN-HAZARDOUS COMBINATION — BUG-062. The emitted plugin is WRONG for
  // any project whose test suite spawns a REAL Node child process that resolves
  // `@adhd/*` (e.g. it `spawnSync(process.execPath, [<built dist entry>])`, or
  // `execFile`s an esbuild bundle that keeps `@adhd/*` external). A real-Node
  // child resolves through node_modules to each dependency's built `dist` and
  // CANNOT be made to follow the parent's tsconfig paths — `enforce: 'pre'`
  // only reorders the vitest PARENT graph. Such a project would then run the
  // parent against `src` and the child against `dist`: one test run, two builds
  // of one package. The harm is LATENT, not always-visible — with `^build` in
  // the test path it passes today, but drop `^build` and it fails loudly on an
  // absent `dist`, or diverges silently on a stale one.
  //
  // THE FIX IS PER-PROJECT OPT-OUT: DELETE the `nxViteTsPathsPre()` entry and
  // its import, add the `Deliberately OMITS nxViteTsPathsPre()` marker comment,
  // and keep `^build` in the project's test `dependsOn` so the child's `dist`
  // stays fresh. Confirmed opt-outs (do NOT re-add — see BUG-062):
  //   entrypoint/agent-mcp                        (main-entry-symlink.test.ts)
  //   entrypoint/dispatch-cli                     (cli-smoke.spec.ts, compiled bin)
  //   packages/agent/agent-engine-compiler        (compile-cli*.test.ts)
  //   packages/apigen/apigen-engine-conformance   (gate-workspace-root.spec.ts)
  // Every generated config also carries a `NOTE (test resolution)` marker
  // stating the same, and `source-resolution-optout.spec.ts` pins the invariant
  // repo-wide (every vite.config.ts either uses the plugin or is a known
  // opt-out — never both, never neither).
  //
  // NOTE: the injected marker deliberately avoids the literal substrings
  // `source-resolution.mjs` and `nxViteTsPathsPre()` so it cannot fool the two
  // `content.includes(...)` idempotency guards below.
  if (!content.includes('NOTE (test resolution)')) {
    // The importMetaUrlCjs() patch above may already have prefixed the array
    // (`plugins: [importMetaUrlCjs(), nxViteTsPaths(), ...]`), so match either
    // shape and preserve any such prefix in the replacement.
    content = content.replace(
      /plugins: \[(importMetaUrlCjs\(\),\s*)?nxViteTsPaths\(\)/,
      (_m: string, pre: string | undefined) =>
        `// NOTE (test resolution): the pre-ordered tsconfig-paths plugin below makes\n` +
        `// the vitest PARENT resolve @adhd/* to \`src\`. If this project's tests spawn a\n` +
        `// real Node child process (which resolves @adhd/* from each dependency's built\n` +
        `// \`dist\`), DELETE that pre-ordered plugin and keep ^build in the test target —\n` +
        `// otherwise one test run uses two builds. See BUG-062.\n` +
        `        plugins: [${pre ?? ''}nxViteTsPaths()`
    );
  }
  if (!content.includes('source-resolution.mjs')) {
    content = content.replace(
      /(import \{ nxViteTsPaths \} from '@nx\/vite\/plugins\/nx-tsconfig-paths\.plugin';\n)/,
      `$1import { nxViteTsPathsPre } from '../../../tools/vite-plugins/source-resolution.mjs';\n`
    );
  }
  if (!content.includes('nxViteTsPathsPre()')) {
    // The `@nx/js` vite template emits `plugins: [nxViteTsPaths(), dts({...})],`
    // (inline array, `dts` on the next line) rather than the fully multi-line
    // shape a hand-authored config has, so match the call token itself instead
    // of a line/array shape. `formatFiles` reformats the result into the
    // conventional multi-line form.
    content = content.replace('nxViteTsPaths()', 'nxViteTsPaths(), nxViteTsPathsPre()');
  }

  tree.write(vitePath, content);
}

function patchReleasePublish(tree: Tree, dir: string) {
  const projectPath = joinPathFragments(dir, 'project.json');
  if (!tree.exists(projectPath)) return;
  const projectJson = readJson(tree, projectPath);
  const pub = projectJson?.targets?.['nx-release-publish'];
  if (pub && !pub.dependsOn) {
    pub.dependsOn = ['build', 'test', 'verify-dist-load', 'dist-manifest', 'publish-hygiene'];
    writeJson(tree, projectPath, projectJson);
  }
}

/**
 * DEBT-WORKSPACE-VITE-PATHS-001 (found while implementing it, not its
 * original scope): `@nx/js:library`'s default `bundler: 'vite'` output
 * still emits the PRE-migration workspace-root-relative dist layout
 * (`dist/{projectRoot}` / `outDir: '../../../dist/{projectRoot}'`) — this
 * generator was never updated for the later pnpm + in-source-dist migration
 * (see CHANGELOG "pnpm + in-source-dist migration") that moved every real
 * package's build output to `{projectRoot}/dist`. This wasn't cosmetic: EVERY
 * `@adhd/nx-build:*` executor (`assets`, `verify-dist-load`, `version`,
 * `dist-manifest`, `publish-hygiene`, ...) HARDCODES
 * `join(project.root, 'dist')` when locating a project's built output —
 * see `tools/nx-plugins/assets/executors/copy/impl.js`,
 * `tools/nx-plugins/build/executors/verify/impl.js`,
 * `tools/nx-plugins/build/executors/version/impl.js`. A freshly-scaffolded
 * package whose build actually writes to the workspace-root path therefore
 * fails `verify-dist-load` outright ("no dist for <project> (build first)")
 * even immediately after a successful `build` — the executors are looking
 * in the wrong place, not because the build failed.
 */
function patchInSourceDist(tree: Tree, dir: string) {
  const projectJsonPath = joinPathFragments(dir, 'project.json');
  if (tree.exists(projectJsonPath)) {
    const projectJson = readJson(tree, projectJsonPath);
    const buildOpts = projectJson?.targets?.build?.options;
    if (buildOpts?.outputPath === `dist/${dir}`) {
      buildOpts.outputPath = `${dir}/dist`;
    }
    const versionOpts = projectJson?.release?.version?.generatorOptions;
    if (versionOpts?.packageRoot === 'dist/{projectRoot}') {
      versionOpts.packageRoot = '{projectRoot}';
    }
    const publishOpts = projectJson?.targets?.['nx-release-publish']?.options;
    if (publishOpts?.packageRoot === 'dist/{projectRoot}') {
      publishOpts.packageRoot = '{projectRoot}/dist';
    }
    writeJson(tree, projectJsonPath, projectJson);
  }

  const vitePath = findViteConfig(tree, dir);
  if (vitePath) {
    let content = tree.read(vitePath, 'utf-8');
    if (content) {
      // root: __dirname already anchors relative build paths to the
      // package's own directory, so `outDir: 'dist'` IS `{projectRoot}/dist`.
      content = content.replace(
        /outDir:\s*(?:'\.\.\/(?:\.\.\/)*dist\/[^']+'|"\.\.\/(?:\.\.\/)*dist\/[^"]+")/,
        "outDir: 'dist'"
      );
      tree.write(vitePath, content);
    }
  }
}

function ensureReadme(tree: Tree, dir: string, projectName: string) {
  const readmePath = joinPathFragments(dir, 'README.md');
  if (tree.exists(readmePath)) return;
  tree.write(
    readmePath,
    `# @adhd/${projectName}\n\n> TODO: one-line description of \`${projectName}\`.\n\n\`\`\`bash\nnpm install @adhd/${projectName}\n\`\`\`\n`
  );
}

function patchEslintrc(tree: Tree, dir: string) {
  const eslintPath = joinPathFragments(dir, '.eslintrc.json');
  if (!tree.exists(eslintPath)) return;
  const eslint = readJson(tree, eslintPath);
  if (eslint.ignorePatterns && !eslint.ignorePatterns.some((p: string) => p.includes('vite.config'))) {
    eslint.ignorePatterns.push('vite.config.js', 'vite.config.ts', 'vite.config.mjs', 'vite.config.mts');
    writeJson(tree, eslintPath, eslint);
  }
}

function scaffoldEntrypoint(tree: Tree, root: string, name: string) {
  tree.write(joinPathFragments(root, 'src/index.ts'), `// Entrypoint: @adhd/${name}\n`);
  tree.write(joinPathFragments(root, 'project.json'), JSON.stringify({
    name,
    $schema: '../../node_modules/nx/schemas/project-schema.json',
    sourceRoot: `${root}/src`,
    projectType: 'application',
    tags: [`entrypoint:${name}`, 'pkg-class:entrypoint', 'platform:node'],
    targets: {
      build: {
        executor: 'nx:run-commands',
        options: { command: `tsc -p ${root}/tsconfig.json` },
      },
    },
  }, null, 2) + '\n');
  tree.write(joinPathFragments(root, 'package.json'), JSON.stringify({ name: `@adhd/${name}`, version: '0.0.1', private: true }, null, 2) + '\n');
  tree.write(joinPathFragments(root, 'tsconfig.json'), JSON.stringify({ extends: '../../tsconfig.base.json', compilerOptions: { outDir: '../../dist/entrypoint' }, include: ['src'] }, null, 2) + '\n');
}

function patchTsconfigLib(tree: Tree, dir: string) {
  const tsconfigLibPath = joinPathFragments(dir, 'tsconfig.lib.json');
  if (!tree.exists(tsconfigLibPath)) return;
  const tsconfigLib = readJson(tree, tsconfigLibPath);
  if (tsconfigLib.exclude && !tsconfigLib.exclude.includes('src/test/**')) {
    tsconfigLib.exclude.push('src/test/**');
    writeJson(tree, tsconfigLibPath, tsconfigLib);
  }
}

/**
 * a4c837a2: make the scaffolded spec corpus compile CLEAN under the new
 * `typecheck-spec` gate, so the baseline it ships with can honestly be empty.
 * Measured on a real scaffold, `tsconfig.spec.json` (which includes
 * `vite.config.mts`) carried 5 errors out of the box: 2x TS1343 (the Nx vite
 * template's `import.meta.dirname` under the inherited `module: commonjs`) and
 * 3x TS7016 (the patched-in `tools/vite-plugins/*.mjs` imports have no
 * declaration files). The spec corpus is ESM run by vitest/vite, so
 * `module: esnext` + `moduleResolution: bundler` is the correct setting, and
 * `allowJs` lets the `.mjs` plugin imports resolve and type from their source.
 * Scoped to tsconfig.spec.json only; the library build config is untouched.
 */
function patchTsconfigSpec(tree: Tree, dir: string) {
  const specPath = joinPathFragments(dir, 'tsconfig.spec.json');
  if (!tree.exists(specPath)) return;
  const spec = readJson(tree, specPath);
  spec.compilerOptions = {
    ...(spec.compilerOptions ?? {}),
    module: 'esnext',
    moduleResolution: 'bundler',
    allowJs: true,
  };
  writeJson(tree, specPath, spec);
}

/** Workspace-relative home of every typecheck-spec ratchet baseline. */
const TYPECHECK_SPEC_DIR = 'tools/nx-plugins/build/executors/typecheck-spec';

/**
 * Wire the spec-corpus compile gate (a4c837a2). `@nx/js:library` emits
 * `tsconfig.spec.json`, but `nx.json`'s `production` namedInput excludes it and
 * no inferred target compiles it, so a fresh package fails release GATE 0 /
 * lane-reachability rule 6 ("tsconfig.spec.json with no compiling target").
 * Emits, mirroring packages/agent/agent-core-native-tooling/project.json:
 *   - a cached `typecheck-spec` target running the ratchet over the package's
 *     tsconfig.spec.json against its own baseline,
 *   - `typecheck-spec` in `test.dependsOn` (the partial override relists the
 *     workspace `targetDefaults.test.dependsOn` of lint + ^build, because a
 *     project-level `dependsOn` replaces the default wholesale),
 *   - an EMPTY baseline (`total: 0`) in the Tree. Fresh code carries no
 *     pre-existing spec errors to baseline, and ratchet.mjs exits 2 on a
 *     missing baseline, so the file must exist; empty is the strictest correct
 *     value (any spec type error is an increase and fails).
 * No-op when the package has no tsconfig.spec.json (entrypoints are scaffolded
 * without a spec tsconfig, so rule 6 does not apply to them).
 */
function patchTypecheckSpec(tree: Tree, dir: string, projectName: string) {
  const specTsconfig = joinPathFragments(dir, 'tsconfig.spec.json');
  const projectPath = joinPathFragments(dir, 'project.json');
  if (!tree.exists(specTsconfig) || !tree.exists(projectPath)) return;

  const baselinePath = joinPathFragments(TYPECHECK_SPEC_DIR, `${projectName}.baseline.json`);
  const projectJson = readJson(tree, projectPath);
  projectJson.targets = projectJson.targets ?? {};
  projectJson.targets['typecheck-spec'] = {
    '//': `Type-checks the SPEC corpus (${specTsconfig}). Closes lane-reachability rule 6: a tsconfig.spec.json with no compiling target lets the spec corpus carry type errors no gate can see (nx.json production namedInput excludes it). The ratchet fails on any per-file increase over ${baselinePath} or on include narrowing. Wired into test.dependsOn so nx affected -t test runs it.`,
    executor: 'nx:run-commands',
    cache: true,
    inputs: ['default', { externalDependencies: ['typescript'] }],
    options: {
      cwd: '.',
      command: `node ${TYPECHECK_SPEC_DIR}/ratchet.mjs --tsconfig ${specTsconfig} --baseline ${baselinePath}`,
    },
  };
  const test = projectJson.targets.test ?? {};
  const dependsOn: unknown[] = Array.isArray(test.dependsOn) ? test.dependsOn : ['lint', '^build'];
  if (!dependsOn.includes('typecheck-spec')) dependsOn.push('typecheck-spec');
  test.dependsOn = dependsOn;
  projectJson.targets.test = test;
  writeJson(tree, projectPath, projectJson);

  writeJson(tree, baselinePath, {
    '//': `typecheck-spec ratchet baseline for ${specTsconfig}. Per-file error counts; the gate fails on any INCREASE (or a new file with errors). Empty because the package was scaffolded clean; this number may only go DOWN. Regenerate with ratchet.mjs --write-baseline.`,
    total: 0,
    files: {},
  });
}

export default scaffoldGenerator;
