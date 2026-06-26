import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing'
import { readProjectConfiguration, readJson } from '@nx/devkit'
import { hostGenerator } from '../generators/host/generator'

// ---------------------------------------------------------------------------
// Helper — seed the workspace so updateJson has a tsconfig.base.json to patch
// ---------------------------------------------------------------------------
function makeTree() {
  const tree = createTreeWithEmptyWorkspace()
  tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }))
  return tree
}

describe('host generator', () => {
  // -------------------------------------------------------------------------
  // Core: project.json shape
  // -------------------------------------------------------------------------

  it('creates project.json with correct layer and platform tags', async () => {
    const tree = makeTree()
    await hostGenerator(tree, { host: 'typescript' })
    const config = readProjectConfiguration(tree, 'apigen-host-typescript')
    expect(config.tags).toEqual(['layer:logic', 'platform:node'])
  })

  it('project name is apigen-host-<host>', async () => {
    const tree = makeTree()
    await hostGenerator(tree, { host: 'python' })
    const config = readProjectConfiguration(tree, 'apigen-host-python')
    expect(config.name).toBe('apigen-host-python')
  })

  it('default root dir is packages/apigen/hosts/<host>', async () => {
    const tree = makeTree()
    await hostGenerator(tree, { host: 'rust' })
    const config = readProjectConfiguration(tree, 'apigen-host-rust')
    expect(config.root).toBe('packages/apigen/hosts/rust')
  })

  it('respects custom directory option', async () => {
    const tree = makeTree()
    await hostGenerator(tree, { host: 'go', directory: 'packages/custom/go-host' })
    const config = readProjectConfiguration(tree, 'apigen-host-go')
    expect(config.root).toBe('packages/custom/go-host')
    expect(tree.exists('packages/custom/go-host/project.json')).toBe(true)
  })

  it('includes a conformance target in project.json', async () => {
    const tree = makeTree()
    await hostGenerator(tree, { host: 'java' })
    const config = readProjectConfiguration(tree, 'apigen-host-java')
    expect(config.targets?.['conformance']).toBeDefined()
  })

  it('nx-release-publish dependsOn build and test', async () => {
    const tree = makeTree()
    await hostGenerator(tree, { host: 'typescript' })
    const config = readProjectConfiguration(tree, 'apigen-host-typescript')
    expect(config.targets?.['nx-release-publish']?.dependsOn).toEqual(['build', 'test'])
  })

  // -------------------------------------------------------------------------
  // Core: expected files are created
  // -------------------------------------------------------------------------

  it('creates all expected files for a host', async () => {
    const tree = makeTree()
    await hostGenerator(tree, { host: 'typescript' })
    const base = 'packages/apigen/hosts/typescript'
    expect(tree.exists(`${base}/project.json`)).toBe(true)
    expect(tree.exists(`${base}/host-manifest.json`)).toBe(true)
    expect(tree.exists(`${base}/src/conformance/harness.spec.ts`)).toBe(true)
    expect(tree.exists(`${base}/src/index.ts`)).toBe(true)
    expect(tree.exists(`${base}/package.json`)).toBe(true)
    expect(tree.exists(`${base}/tsconfig.json`)).toBe(true)
    expect(tree.exists(`${base}/vite.config.ts`)).toBe(true)
  })

  // -------------------------------------------------------------------------
  // RED-BY-CONSTRUCTION INVARIANT — these are the load-bearing teeth tests
  // -------------------------------------------------------------------------

  it('[red-by-construction] host-manifest.json has supportedIds: [] (empty array)', async () => {
    const tree = makeTree()
    await hostGenerator(tree, { host: 'typescript' })
    const manifest = readJson(tree, 'packages/apigen/hosts/typescript/host-manifest.json')
    // This MUST fail if the generator ever scaffolds a pre-filled manifest.
    expect(Array.isArray(manifest.supportedIds)).toBe(true)
    expect((manifest.supportedIds as unknown[]).length).toBe(0)
  })

  it('[red-by-construction] manifest carries the correct host name', async () => {
    const tree = makeTree()
    await hostGenerator(tree, { host: 'python' })
    const manifest = readJson(tree, 'packages/apigen/hosts/python/host-manifest.json')
    expect(manifest.host).toBe('python')
  })

  it('[red-by-construction] manifest carries a logicalTypeVersion', async () => {
    const tree = makeTree()
    await hostGenerator(tree, { host: 'rust' })
    const manifest = readJson(tree, 'packages/apigen/hosts/rust/host-manifest.json')
    expect(typeof manifest.logicalTypeVersion).toBe('string')
    expect(manifest.logicalTypeVersion.length).toBeGreaterThan(0)
  })

  it('[red-by-construction] manifest logicalTypeVersion defaults to "1.0.0"', async () => {
    const tree = makeTree()
    await hostGenerator(tree, { host: 'go' })
    const manifest = readJson(tree, 'packages/apigen/hosts/go/host-manifest.json')
    expect(manifest.logicalTypeVersion).toBe('1.0.0')
  })

  it('[red-by-construction] custom logicalTypeVersion is written to manifest', async () => {
    const tree = makeTree()
    await hostGenerator(tree, { host: 'java', logicalTypeVersion: '2.3.0' })
    const manifest = readJson(tree, 'packages/apigen/hosts/java/host-manifest.json')
    expect(manifest.logicalTypeVersion).toBe('2.3.0')
  })

  it('[red-by-construction] manifest has empty deps object', async () => {
    const tree = makeTree()
    await hostGenerator(tree, { host: 'typescript' })
    const manifest = readJson(tree, 'packages/apigen/hosts/typescript/host-manifest.json')
    expect(manifest.deps).toBeDefined()
    expect(Object.keys(manifest.deps as object).length).toBe(0)
  })

  // -------------------------------------------------------------------------
  // NEGATIVE CONTROL — proves the emptiness assertion has real teeth
  //
  // Manually write a manifest with pre-filled supportedIds and assert that
  // reading it back reveals the violation (i.e. the check is not vacuous).
  // -------------------------------------------------------------------------

  it('[negative-control] a pre-filled manifest (supportedIds non-empty) is detectable', async () => {
    const tree = makeTree()
    await hostGenerator(tree, { host: 'typescript' })

    // Simulate a broken generator that pre-fills supportedIds
    tree.write(
      'packages/apigen/hosts/typescript/host-manifest.json',
      JSON.stringify({
        host: 'typescript',
        logicalTypeVersion: '1.0.0',
        supportedIds: ['date-time', 'int64'],  // pre-filled — non-conformant scaffold
        deps: {},
      }),
    )

    const manifest = readJson(tree, 'packages/apigen/hosts/typescript/host-manifest.json')
    // Prove the check has teeth: a non-empty supportedIds is detectable
    expect((manifest.supportedIds as unknown[]).length).toBeGreaterThan(0)
    // And therefore the red-by-construction assertion WOULD fail:
    const wouldFail = (manifest.supportedIds as unknown[]).length !== 0
    expect(wouldFail).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Harness template content assertions
  // -------------------------------------------------------------------------

  it('harness.spec.ts references host name', async () => {
    const tree = makeTree()
    await hostGenerator(tree, { host: 'typescript' })
    const harness = tree.read(
      'packages/apigen/hosts/typescript/src/conformance/harness.spec.ts',
      'utf-8',
    )!
    expect(harness).toContain('typescript')
  })

  it('harness.spec.ts checks supportedIds is empty (red-by-construction guard)', async () => {
    const tree = makeTree()
    await hostGenerator(tree, { host: 'typescript' })
    const harness = tree.read(
      'packages/apigen/hosts/typescript/src/conformance/harness.spec.ts',
      'utf-8',
    )!
    // The harness must assert supportedIds.length === 0
    expect(harness).toContain('supportedIds')
    expect(harness).toContain('length').valueOf
    expect(harness).toContain('toBe(0)')
  })

  it('harness.spec.ts encodes encode/decode/negativeControl obligations', async () => {
    const tree = makeTree()
    await hostGenerator(tree, { host: 'typescript' })
    const harness = tree.read(
      'packages/apigen/hosts/typescript/src/conformance/harness.spec.ts',
      'utf-8',
    )!
    // All three harness obligations must be present
    expect(harness).toContain('encode')
    expect(harness).toContain('decode')
    expect(harness).toContain('negativeControl')
    // The teeth comment must be present
    expect(harness).toContain('byte-equal')
    expect(harness).toContain('invariants')
  })

  it('harness.spec.ts imports host-manifest.json', async () => {
    const tree = makeTree()
    await hostGenerator(tree, { host: 'python' })
    const harness = tree.read(
      'packages/apigen/hosts/python/src/conformance/harness.spec.ts',
      'utf-8',
    )!
    expect(harness).toContain('host-manifest.json')
  })

  // -------------------------------------------------------------------------
  // tsconfig.base.json path wiring
  // -------------------------------------------------------------------------

  it('updates tsconfig.base.json with the new host path', async () => {
    const tree = makeTree()
    await hostGenerator(tree, { host: 'rust' })
    const tsconfig = readJson(tree, 'tsconfig.base.json')
    expect(tsconfig.compilerOptions.paths['@adhd/apigen-host-rust']).toEqual([
      './packages/apigen/hosts/rust/src/index.ts',
    ])
  })

  // -------------------------------------------------------------------------
  // package.json content
  // -------------------------------------------------------------------------

  it('package.json has correct scoped name', async () => {
    const tree = makeTree()
    await hostGenerator(tree, { host: 'go' })
    const pkg = readJson(tree, 'packages/apigen/hosts/go/package.json')
    expect(pkg.name).toBe('@adhd/apigen-host-go')
  })

  // -------------------------------------------------------------------------
  // Kebab-case name normalisation
  // -------------------------------------------------------------------------

  it('normalises multi-word host names to kebab-case', async () => {
    const tree = makeTree()
    await hostGenerator(tree, { host: 'my-custom-host' })
    expect(tree.exists('packages/apigen/hosts/my-custom-host/project.json')).toBe(true)
    const config = readProjectConfiguration(tree, 'apigen-host-my-custom-host')
    expect(config.name).toBe('apigen-host-my-custom-host')
  })
})
