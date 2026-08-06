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
      directory: dir,
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

function patchViteConfig(tree: Tree, dir: string, platform: 'node' | 'browser' | 'shared') {
  const vitePath = joinPathFragments(dir, 'vite.config.ts');
  if (!tree.exists(vitePath)) return;
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

  const vitePath = joinPathFragments(dir, 'vite.config.ts');
  if (tree.exists(vitePath)) {
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

export default scaffoldGenerator;
