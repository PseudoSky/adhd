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

  it('writes plugin.ts without run() when hasRun is false', async () => {
    const tree = createTreeWithEmptyWorkspace()
    tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }))
    await pluginGenerator(tree, { name: 'no-run' })
    const content = tree.read('packages/apigen/plugins/no-run/src/lib/plugin.ts', 'utf-8')!
    expect(content).not.toContain('run(')
    expect(content).not.toContain('RunInput')
    // identifier uses camelCase propertyName, not hyphenated fileName
    expect(content).toContain('noRunPlugin')
  })

  it('writes plugin.ts WITH run() when hasRun is true', async () => {
    const tree = createTreeWithEmptyWorkspace()
    tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }))
    await pluginGenerator(tree, { name: 'with-run', hasRun: true })
    const content = tree.read('packages/apigen/plugins/with-run/src/lib/plugin.ts', 'utf-8')!
    expect(content).toContain('run(')
    expect(content).toContain('RunInput')
    // identifier uses camelCase propertyName
    expect(content).toContain('withRunPlugin')
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
})
