import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing'
import { readProjectConfiguration, readJson } from '@nx/devkit'
import { registryPackageGenerator } from '../generators/registry-package/generator'

function seed(tree: ReturnType<typeof createTreeWithEmptyWorkspace>) {
  // tsconfig.base.json must exist for the additive updateJson wiring.
  tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }))
  return tree
}

describe('registry-package generator', () => {
  it('creates project.json with the layer:ai + platform:node tags', async () => {
    const tree = seed(createTreeWithEmptyWorkspace())
    await registryPackageGenerator(tree, { name: 'budget' })
    const config = readProjectConfiguration(tree, 'agent-budget')
    expect(config.tags).toEqual(['layer:ai', 'platform:node'])
  })

  it('names the project agent-<name> and roots it under packages/ai', async () => {
    const tree = seed(createTreeWithEmptyWorkspace())
    await registryPackageGenerator(tree, { name: 'tool-registry' })
    const config = readProjectConfiguration(tree, 'agent-tool-registry')
    expect(config.root).toBe('packages/ai/agent-tool-registry')
  })

  it('uses @nx/js:tsc for build with the drizzle asset glob', async () => {
    const tree = seed(createTreeWithEmptyWorkspace())
    await registryPackageGenerator(tree, { name: 'budget' })
    const config = readProjectConfiguration(tree, 'agent-budget')
    expect(config.targets?.['build']?.executor).toBe('@nx/js:tsc')
    const assets = config.targets?.['build']?.options?.['assets']
    expect(assets).toEqual([
      { input: 'packages/ai/agent-budget', glob: 'drizzle/**/*', output: '.' },
    ])
  })

  it('does NOT redefine cache/dependsOn on build, test, or typecheck (inherits from nx.json)', async () => {
    const tree = seed(createTreeWithEmptyWorkspace())
    await registryPackageGenerator(tree, { name: 'budget' })
    const config = readProjectConfiguration(tree, 'agent-budget')
    for (const t of ['build', 'test', 'typecheck'] as const) {
      expect(config.targets?.[t]).toBeDefined()
      expect(config.targets?.[t]?.cache).toBeUndefined()
      expect(config.targets?.[t]?.dependsOn).toBeUndefined()
    }
  })

  it('declares db:generate, db:migrate, typecheck, clean, and nx-release-publish targets', async () => {
    const tree = seed(createTreeWithEmptyWorkspace())
    await registryPackageGenerator(tree, { name: 'budget' })
    const config = readProjectConfiguration(tree, 'agent-budget')
    expect(config.targets?.['db:generate']).toBeDefined()
    expect(config.targets?.['db:migrate']).toBeDefined()
    expect(config.targets?.['typecheck']).toBeDefined()
    expect(config.targets?.['clean']).toBeDefined()
    expect(config.targets?.['nx-release-publish']?.dependsOn).toEqual(['build', 'test'])
  })

  it('writes the full golden-path skeleton', async () => {
    const tree = seed(createTreeWithEmptyWorkspace())
    await registryPackageGenerator(tree, { name: 'budget' })
    const base = 'packages/ai/agent-budget'
    for (const f of [
      'package.json',
      'project.json',
      '.eslintrc.json',
      'vite.config.ts',
      'drizzle.config.ts',
      'tsconfig.json',
      'tsconfig.lib.json',
      'tsconfig.spec.json',
      'README.md',
      'CLAUDE.md',
      'src/index.ts',
      'src/db/client.ts',
      'src/db/schema.ts',
      'src/db/migrate.ts',
      'src/db/migrate-runner.ts',
      'src/__tests__/skeleton.test.ts',
      'drizzle/meta/_journal.json',
    ]) {
      expect(tree.exists(`${base}/${f}`)).toBe(true)
    }
  })

  it('package.json declares only drizzle-orm + better-sqlite3 runtime deps (no unused zod)', async () => {
    const tree = seed(createTreeWithEmptyWorkspace())
    await registryPackageGenerator(tree, { name: 'budget' })
    const pkg = readJson(tree, 'packages/ai/agent-budget/package.json')
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['better-sqlite3', 'drizzle-orm'])
    expect(pkg.dependencies.zod).toBeUndefined()
    expect(pkg.name).toBe('@adhd/agent-budget')
  })

  it('eslintrc extends the workspace base so a lint target is inferred', async () => {
    const tree = seed(createTreeWithEmptyWorkspace())
    await registryPackageGenerator(tree, { name: 'budget' })
    const eslint = readJson(tree, 'packages/ai/agent-budget/.eslintrc.json')
    expect(eslint.extends).toEqual(['../../../.eslintrc.base.json'])
  })

  it('derives the table prefix and stamps it into the schema header', async () => {
    const tree = seed(createTreeWithEmptyWorkspace())
    await registryPackageGenerator(tree, { name: 'tool-registry' })
    const schema = tree.read('packages/ai/agent-tool-registry/src/db/schema.ts', 'utf-8')!
    expect(schema).toContain('table prefix: tool_registry_')
  })

  it('honours a custom tablePrefix', async () => {
    const tree = seed(createTreeWithEmptyWorkspace())
    await registryPackageGenerator(tree, { name: 'billing', tablePrefix: 'billing_' })
    const schema = tree.read('packages/ai/agent-billing/src/db/schema.ts', 'utf-8')!
    expect(schema).toContain('table prefix: billing_')
  })

  it('skeleton test uses real DB + close/reopen (no :memory:, no mock)', async () => {
    const tree = seed(createTreeWithEmptyWorkspace())
    await registryPackageGenerator(tree, { name: 'budget' })
    const spec = tree.read('packages/ai/agent-budget/src/__tests__/skeleton.test.ts', 'utf-8')!
    expect(spec).toContain('better-sqlite3')
    expect(spec).toContain('reopen')
    expect(spec).not.toContain(':memory:')
  })

  it('adds the package path to tsconfig.base.json (additive)', async () => {
    const tree = seed(createTreeWithEmptyWorkspace())
    await registryPackageGenerator(tree, { name: 'budget' })
    const tsconfig = readJson(tree, 'tsconfig.base.json')
    expect(tsconfig.compilerOptions.paths['@adhd/agent-budget']).toEqual([
      './packages/ai/agent-budget/src/index.ts',
    ])
  })

  it('CLAUDE.md links the rules doc', async () => {
    const tree = seed(createTreeWithEmptyWorkspace())
    await registryPackageGenerator(tree, { name: 'budget' })
    const claude = tree.read('packages/ai/agent-budget/CLAUDE.md', 'utf-8')!
    expect(claude).toContain('REGISTRY-PACKAGE-RULES.md')
  })

  it('honours a custom directory', async () => {
    const tree = seed(createTreeWithEmptyWorkspace())
    await registryPackageGenerator(tree, { name: 'budget', directory: 'packages/custom/agent-budget' })
    expect(tree.exists('packages/custom/agent-budget/project.json')).toBe(true)
  })
})
