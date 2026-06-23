import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing'
import { readProjectConfiguration, readJson } from '@nx/devkit'
import { pluginGenerator } from '../generators/plugin/generator'

describe('plugin generator', () => {
  it('creates project.json with correct tags', async () => {
    const tree = createTreeWithEmptyWorkspace()
    // seed tsconfig.base.json so updateJson has something to update
    tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }))
    await pluginGenerator(tree, { name: 'python-grpc' })
    const config = readProjectConfiguration(tree, 'apigen-plugin-python-grpc')
    expect(config.tags).toEqual(['layer:logic', 'platform:node'])
  })

  it('respects --platform option in project tags', async () => {
    const tree = createTreeWithEmptyWorkspace()
    tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }))
    await pluginGenerator(tree, { name: 'shared-util', platform: 'shared' })
    const config = readProjectConfiguration(tree, 'apigen-plugin-shared-util')
    expect(config.tags).toEqual(['layer:logic', 'platform:shared'])
  })

  it('creates project.json with nx-release-publish dependsOn build and test', async () => {
    const tree = createTreeWithEmptyWorkspace()
    tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }))
    await pluginGenerator(tree, { name: 'python-grpc' })
    const config = readProjectConfiguration(tree, 'apigen-plugin-python-grpc')
    expect(config.targets?.['nx-release-publish']?.dependsOn).toEqual(['build', 'test'])
  })

  it('creates all expected files for a plugin', async () => {
    const tree = createTreeWithEmptyWorkspace()
    tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }))
    await pluginGenerator(tree, { name: 'python-grpc' })
    expect(tree.exists('packages/apigen/plugins/python-grpc/project.json')).toBe(true)
    expect(tree.exists('packages/apigen/plugins/python-grpc/src/lib/plugin.ts')).toBe(true)
    expect(tree.exists('packages/apigen/plugins/python-grpc/src/index.ts')).toBe(true)
    expect(tree.exists('packages/apigen/plugins/python-grpc/src/test/plugin.spec.ts')).toBe(true)
    expect(tree.exists('packages/apigen/plugins/python-grpc/package.json')).toBe(true)
  })

  // -------------------------------------------------------------------------
  // v2 shape assertions — the generated plugin.ts must implement the v2
  // Plugin interface (capabilities.{target,layer,...}) from @adhd/apigen-core
  // -------------------------------------------------------------------------

  it('emits a plugin.ts that imports from @adhd/apigen-core (v2 types)', async () => {
    const tree = createTreeWithEmptyWorkspace()
    tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }))
    await pluginGenerator(tree, { name: 'v2-check' })
    const content = tree.read('packages/apigen/plugins/v2-check/src/lib/plugin.ts', 'utf-8')!
    expect(content).toContain('@adhd/apigen-core')
    // must import Plugin (the v2 interface) — not the v1 OutputPlugin shape
    expect(content).toContain('Plugin')
    expect(content).not.toContain('OutputPlugin')
  })

  it('emits a plugin.ts with a capabilities object (v2 contract)', async () => {
    const tree = createTreeWithEmptyWorkspace()
    tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }))
    await pluginGenerator(tree, { name: 'v2-caps' })
    const content = tree.read('packages/apigen/plugins/v2-caps/src/lib/plugin.ts', 'utf-8')!
    expect(content).toContain('capabilities')
    expect(content).toContain('target')
    expect(content).toContain('generate')
    expect(content).toContain('layer')
  })

  it('emits a plugin.ts without serve() when hasRun is false (generate-only)', async () => {
    const tree = createTreeWithEmptyWorkspace()
    tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }))
    await pluginGenerator(tree, { name: 'no-run' })
    const content = tree.read('packages/apigen/plugins/no-run/src/lib/plugin.ts', 'utf-8')!
    expect(content).not.toContain('serve(')
    // identifier uses camelCase propertyName, not hyphenated fileName
    expect(content).toContain('noRunPlugin')
  })

  it('emits a plugin.ts WITH serve() when hasRun is true (server plugin)', async () => {
    const tree = createTreeWithEmptyWorkspace()
    tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }))
    await pluginGenerator(tree, { name: 'with-run', hasRun: true })
    const content = tree.read('packages/apigen/plugins/with-run/src/lib/plugin.ts', 'utf-8')!
    expect(content).toContain('serve(')
    // Harness type is injected into serve() signature
    expect(content).toContain('Harness')
    // identifier uses camelCase propertyName
    expect(content).toContain('withRunPlugin')
  })

  it('emits a spec template that references v2 capabilities assertions', async () => {
    const tree = createTreeWithEmptyWorkspace()
    tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }))
    await pluginGenerator(tree, { name: 'spec-check' })
    const spec = tree.read('packages/apigen/plugins/spec-check/src/test/plugin.spec.ts', 'utf-8')!
    expect(spec).toContain('capabilities')
    expect(spec).toContain('target')
    // the test must have teeth — if capabilities are missing it should fail
    expect(spec).toContain('toBeDefined')
  })

  it('updates tsconfig.base.json with the new plugin path', async () => {
    const tree = createTreeWithEmptyWorkspace()
    tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }))
    await pluginGenerator(tree, { name: 'tsconfig-test' })
    const tsconfig = readJson(tree, 'tsconfig.base.json')
    expect(tsconfig.compilerOptions.paths['@adhd/apigen-plugin-tsconfig-test'])
      .toEqual(['./packages/apigen/plugins/tsconfig-test/src/index.ts'])
  })

  it('uses custom directory when provided', async () => {
    const tree = createTreeWithEmptyWorkspace()
    tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }))
    await pluginGenerator(tree, { name: 'my-plugin', directory: 'packages/custom/my-plugin' })
    expect(tree.exists('packages/custom/my-plugin/project.json')).toBe(true)
  })

  it('default home is packages/apigen/plugins/<name> and project name is apigen-plugin-<name>', async () => {
    const tree = createTreeWithEmptyWorkspace()
    tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }))
    await pluginGenerator(tree, { name: 'my-target' })
    // default home must never be ts/plugins/ or any other path
    expect(tree.exists('packages/apigen/plugins/my-target/project.json')).toBe(true)
    expect(tree.exists('ts/plugins/my-target/project.json')).toBe(false)
    const config = readProjectConfiguration(tree, 'apigen-plugin-my-target')
    // project name must never be apigen-ts-plugin-*
    expect(config.name).toBe('apigen-plugin-my-target')
  })
})
