import {
  type Tree,
  type GeneratorCallback,
  formatFiles,
  joinPathFragments,
  logger,
  names,
  offsetFromRoot,
  readProjectConfiguration,
  readJson,
  writeJson,
} from '@nx/devkit';
import { libraryGenerator } from '@nx/js';

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

  logger.info(`Scaffolding ${projectName} at ${dir} (${importPath})`);

  // Generate base library via @nx/js:library
  await libraryGenerator(tree, {
    name: projectName,
    directory: dir,
    importPath,
    publishable: true,
    bundler: 'vite',
    skipFormat: true,
  });

  // Update project.json with correct tags
  const projectRoot = joinPathFragments(dir, projectName); const projectJsonPath = joinPathFragments(projectRoot, 'project.json');
  if (tree.exists(projectJsonPath)) {
    const projectJson = readJson(tree, projectJsonPath);
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
  patchViteConfig(tree, projectRoot);
  patchReleasePublish(tree, projectRoot);
  ensureReadme(tree, projectRoot, projectName);
  patchEslintrc(tree, projectRoot);
  patchTsconfigLib(tree, projectRoot);

  await formatFiles(tree);
}

function patchViteConfig(tree: Tree, dir: string) {
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

  tree.write(vitePath, content);
}

function patchReleasePublish(tree: Tree, dir: string) {
  const projectPath = joinPathFragments(dir, 'project.json');
  if (!tree.exists(projectPath)) return;
  const projectJson = readJson(tree, projectPath);
  const pub = projectJson?.targets?.['nx-release-publish'];
  if (pub && !pub.dependsOn) {
    pub.dependsOn = ['build', 'test'];
    writeJson(tree, projectPath, projectJson);
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
