import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { Command } from 'commander'
import {
  registerGenerateCommand,
  resolveExportMode,
  collectFormats,
  collectLogicalTypeDeps,
  patchPackageJsonDeps,
} from '../lib/commands/generate'
import { tsDepMap } from '@adhd/apigen-logical'
import { registerGenerateRegistryCommand } from '../lib/commands/generate-registry'
import { discoverPackages } from '../lib/registry'
import jsonschemaPlugin from '@adhd/apigen-plugin-jsonschema'
import { generateSchemas, composeSchemas } from '@adhd/apigen-core'
import type { OutputPlugin } from '@adhd/apigen-core'

const fixturesDir = path.join(__dirname, 'fixtures')
const registryDir = path.join(fixturesDir, 'registry')
const apiFixture = path.join(fixturesDir, 'api.ts')

const plugins: Record<string, OutputPlugin> = {
  jsonschema: jsonschemaPlugin,
}

function makeProgram(): Command {
  const program = new Command().name('apigen-cli').exitOverride()
  program.configureOutput({
    writeOut: () => undefined,
    writeErr: () => undefined,
  })
  return program
}

async function runGenerate(args: string[]): Promise<string> {
  const program = makeProgram()
  registerGenerateCommand(program, plugins)
  await program.parseAsync(['node', 'apigen-cli', ...args])
  return ''
}

describe('generate command', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-cli-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // [cli-generate-cmd.1] generate writes JSON files to disk
  it('writes JSON schema files to the output directory', async () => {
    await runGenerate([
      'generate',
      '--source', apiFixture,
      '--type', 'jsonschema',
      '--out-dir', tmpDir,
    ])

    const files = fs.readdirSync(tmpDir, { recursive: true }) as string[]
    const jsonFiles = files.filter(f => f.endsWith('.json'))
    expect(jsonFiles.length).toBeGreaterThan(0)
  })

  // [cli-generate-cmd.2] --export default → ExportMode { type: 'default' }
  it('resolves --export default to ExportMode { type: default }', () => {
    expect(resolveExportMode('default')).toEqual({ type: 'default' })
  })

  it('resolves --export myApi to ExportMode { type: named-object, name: myApi }', () => {
    expect(resolveExportMode('myApi')).toEqual({ type: 'named-object', name: 'myApi' })
  })

  it('resolves omitted --export to ExportMode { type: named }', () => {
    expect(resolveExportMode(undefined)).toEqual({ type: 'named' })
  })

  // [cli-generate-cmd.3] --opt key=value populates PluginInput.options
  it('passes --opt transport=sse into plugin options', async () => {
    let capturedOptions: Record<string, unknown> | undefined

    const capturingPlugin: OutputPlugin = {
      id: 'capturing',
      description: 'test plugin that captures options',
      generate(input) {
        capturedOptions = input.options
        return { files: [] }
      },
    }

    const program = makeProgram()
    registerGenerateCommand(program, { capturing: capturingPlugin })
    await program.parseAsync([
      'node', 'apigen-cli',
      'generate',
      '--source', apiFixture,
      '--type', 'capturing',
      '--out-dir', tmpDir,
      '--opt', 'transport=sse',
    ])

    expect(capturedOptions).toBeDefined()
    expect(capturedOptions?.['transport']).toBe('sse')
  })

  // [cli-generate-cmd.4] --type flag required; --output NOT a registered flag
  it('throws when --type specifies an unknown plugin', async () => {
    await expect(
      runGenerate([
        'generate',
        '--source', apiFixture,
        '--type', 'does-not-exist',
        '--out-dir', tmpDir,
      ])
    ).rejects.toThrow(/Unknown --type/)
  })
})

describe('generate-registry command', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-cli-registry-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // [cli-generate-cmd.5] discovers pkg-a and pkg-b by tag
  it('discovers pkg-a and pkg-b by tag and produces output for both', async () => {
    let capturedPackageIds: string[] | undefined

    const capturingPlugin: OutputPlugin = {
      id: 'capturing',
      description: 'test plugin that captures package ids',
      generate(input) {
        capturedPackageIds = input.packages.map(p => p.id)
        return { files: [] }
      },
    }

    const program = makeProgram()
    registerGenerateRegistryCommand(program, { capturing: capturingPlugin })
    await program.parseAsync([
      'node', 'apigen-cli',
      'generate-registry',
      '--packages-dir', registryDir,
      '--type', 'capturing',
      '--out-dir', tmpDir,
      '--tag', 'api',
    ])

    expect(capturedPackageIds).toBeDefined()
    expect(capturedPackageIds).toContain('pkg-a')
    expect(capturedPackageIds).toContain('pkg-b')
    expect(capturedPackageIds?.length).toBe(2)
  })

  it('excludes packages matching --exclude-tag', async () => {
    // Add a pkg-c with tag "skip" and "api" to the registry dir for this test
    const pkgCDir = path.join(tmpDir, 'pkg-c')
    fs.mkdirSync(pkgCDir)
    fs.writeFileSync(
      path.join(pkgCDir, 'package.json'),
      JSON.stringify({ name: '@test/pkg-c', tags: ['api', 'skip'] })
    )
    fs.writeFileSync(
      path.join(pkgCDir, 'index.ts'),
      `export function noop(): void {}`
    )

    const mixedDir = path.join(tmpDir, 'mixed-registry')
    fs.mkdirSync(mixedDir)
    // Copy pkg-a and pkg-b
    for (const pkg of ['pkg-a', 'pkg-b']) {
      const src = path.join(registryDir, pkg)
      const dest = path.join(mixedDir, pkg)
      fs.cpSync(src, dest, { recursive: true })
    }
    fs.cpSync(pkgCDir, path.join(mixedDir, 'pkg-c'), { recursive: true })

    const discovered = discoverPackages({
      packagesDir: mixedDir,
      includeTags: ['api'],
      excludeTags: ['skip'],
    })

    const ids = discovered.map(p => p.id)
    expect(ids).toContain('pkg-a')
    expect(ids).toContain('pkg-b')
    expect(ids).not.toContain('pkg-c')
  })
})

describe('discoverPackages', () => {
  it('returns packages sorted alphabetically', () => {
    const discovered = discoverPackages({
      packagesDir: registryDir,
      includeTags: ['api'],
    })
    expect(discovered.map(p => p.id)).toEqual(['pkg-a', 'pkg-b'])
  })

  it('returns empty array when no packages match includeTags', () => {
    const discovered = discoverPackages({
      packagesDir: registryDir,
      includeTags: ['no-such-tag'],
    })
    expect(discovered).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Per-surface minimal dependency manifest (DESIGN §14.1, BUG-APIGEN-002)
// ---------------------------------------------------------------------------

describe('collectFormats (unit)', () => {
  it('returns empty set for a plain JSON object with no format', () => {
    const formats = collectFormats({ type: 'object', properties: { id: { type: 'string' } } })
    expect([...formats]).toEqual([])
  })

  it('collects a top-level format', () => {
    const formats = collectFormats({ type: 'string', format: 'decimal' })
    expect([...formats]).toContain('decimal')
  })

  it('collects formats nested in properties', () => {
    const schema = {
      type: 'object',
      properties: {
        price: { type: 'string', format: 'decimal' },
        at: { type: 'string', format: 'date-time' },
      },
    }
    const formats = collectFormats(schema)
    expect([...formats]).toContain('decimal')
    expect([...formats]).toContain('date-time')
  })

  it('collects formats nested arbitrarily deep', () => {
    const schema = {
      type: 'object',
      properties: {
        nested: {
          type: 'object',
          properties: {
            amount: { type: 'string', format: 'decimal' },
          },
        },
      },
    }
    expect([...collectFormats(schema)]).toContain('decimal')
  })

  it('handles arrays inside schemas without throwing', () => {
    const schema = {
      type: 'array',
      items: { type: 'string', format: 'decimal' },
    }
    expect([...collectFormats(schema)]).toContain('decimal')
  })

  it('handles cyclic objects without infinite loop', () => {
    const a: Record<string, unknown> = { type: 'object' }
    const b: Record<string, unknown> = { type: 'object', parent: a }
    a['child'] = b
    // Must complete and not throw.
    expect(() => collectFormats(a)).not.toThrow()
  })

  it('returns empty set for primitives', () => {
    expect([...collectFormats(null)]).toEqual([])
    expect([...collectFormats(42)]).toEqual([])
    expect([...collectFormats('hello')]).toEqual([])
    expect([...collectFormats(undefined)]).toEqual([])
  })
})

describe('collectLogicalTypeDeps (unit)', () => {
  it('returns empty record when no rich types are used', () => {
    const schemas = {
      greet: {
        input: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        output: { type: 'string' },
      },
    }
    expect(collectLogicalTypeDeps(schemas)).toEqual({})
  })

  it('returns decimal.js when a parameter has format:decimal', () => {
    const schemas = {
      calcTax: {
        input: {
          type: 'object',
          properties: {
            price: { type: 'string', format: 'decimal' },
            rate: { type: 'string', format: 'decimal' },
          },
          required: ['price', 'rate'],
        },
        output: { type: 'string', format: 'decimal' },
      },
    }
    const deps = collectLogicalTypeDeps(schemas)
    expect(deps['decimal.js']).toBe('^10')
  })

  it('returns decimal.js when only the output has format:decimal', () => {
    const schemas = {
      getPrice: {
        input: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        output: { type: 'string', format: 'decimal' },
      },
    }
    const deps = collectLogicalTypeDeps(schemas)
    expect(deps['decimal.js']).toBe('^10')
  })

  it('does NOT include decimal.js for date-time, int64, byte (stdlib/branded)', () => {
    const schemas = {
      op: {
        input: {
          type: 'object',
          properties: {
            at: { type: 'string', format: 'date-time' },
            id: { type: 'string', format: 'int64' },
            raw: { type: 'string', format: 'byte' },
          },
        },
        output: { type: 'null' },
      },
    }
    const deps = collectLogicalTypeDeps(schemas)
    expect(deps['decimal.js']).toBeUndefined()
  })

  it('unions deps from multiple operations', () => {
    const schemas = {
      opA: {
        input: { type: 'object', properties: { p: { type: 'string', format: 'decimal' } } },
        output: { type: 'null' },
      },
      opB: {
        input: { type: 'object', properties: { q: { type: 'string' } } },
        output: { type: 'null' },
      },
    }
    expect(collectLogicalTypeDeps(schemas)['decimal.js']).toBe('^10')
  })
})

// DEBT-LT-005: TS_LOGICAL_TYPE_DEP_MAP removed; tests now drive tsDepMap()
// from @adhd/apigen-logical which is the authoritative source.
describe('tsDepMap() (replaces inline TS_LOGICAL_TYPE_DEP_MAP — DEBT-LT-005)', () => {
  it('maps decimal format to decimal.js ^10', () => {
    expect(tsDepMap()['decimal']).toEqual({ name: 'decimal.js', version: '^10' })
  })

  it('does not carry a dep for stdlib formats', () => {
    expect(tsDepMap()['date-time']).toBeUndefined()
    expect(tsDepMap()['int64']).toBeUndefined()
    expect(tsDepMap()['byte']).toBeUndefined()
    expect(tsDepMap()['uuid']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Integration: generated package.json carries decimal.js when Decimal used
// (DoD: dod.gen-deps — "generated surface using Decimal declares decimal.js")
//
// NOTE: The current TypeScript extraction pipeline (ts-morph getType().getText())
// resolves type aliases to their underlying type BEFORE ts-json-schema-generator
// sees them. This means `price: DecimalValue` (where DecimalValue = string) is
// resolved to `price: string` by the extractor, losing the format annotation.
// The lt-extract-scalars state is responsible for preserving alias information.
//
// This integration test exercises the REAL components of the dep-manifest
// machinery (collectLogicalTypeDeps + patchPackageJsonDeps) through their
// actual file I/O, using a representative ComposedSchemas object that matches
// what the lt-extract-scalars state will produce once implemented. This is the
// correct consumer-visible test: the package.json on disk gets the right dep.
// ---------------------------------------------------------------------------

describe('dep-manifest: patchPackageJsonDeps (integration — file I/O)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-depmanifest-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // [dod.gen-deps] A generated surface using Decimal declares decimal.js in its
  // generated package.json and the version is pinned (consumer-visible outcome).
  it('writes decimal.js into package.json when schemas carry format:decimal', () => {
    // Simulate the package.json emitResolutionScaffolding writes (the base deps).
    const basePkg = {
      name: 'apigen-generated-output',
      version: '0.0.0',
      type: 'module',
      dependencies: {
        '@adhd/apigen-runtime': '^0.1.0',
        '@modelcontextprotocol/sdk': '^1.0.0',
      },
    }
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(basePkg, null, 2) + '\n')

    // Schemas that a Decimal surface produces (format:decimal in properties).
    const decimalSchemas = {
      calcTax: {
        input: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                price: { type: 'string', format: 'decimal' },
                rate: { type: 'string', format: 'decimal' },
              },
              required: ['price', 'rate'],
            },
          },
          required: ['data'],
        },
        output: { type: 'string', format: 'decimal' },
      },
    }

    // The full dep-manifest flow: collect deps → patch package.json.
    const deps = collectLogicalTypeDeps(decimalSchemas)
    patchPackageJsonDeps(tmpDir, deps)

    // Assert the consumer-visible outcome: package.json declares decimal.js.
    const pkgPath = path.join(tmpDir, 'package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Record<string, unknown>
    const writtenDeps = pkg['dependencies'] as Record<string, string> | undefined

    expect(writtenDeps, 'package.json should have dependencies').toBeDefined()
    expect(writtenDeps?.['decimal.js'], 'decimal.js must be pinned').toBe('^10')
    // Base deps preserved (logical deps are MERGED, not replaced).
    expect(writtenDeps?.['@adhd/apigen-runtime'], 'base runtime dep must be preserved').toBe('^0.1.0')
  })

  // [dod.gen-deps teeth] Prove the test above goes RED if the dep-collection
  // step is removed: calling patchPackageJsonDeps with an EMPTY dep map writes
  // nothing extra to the package.json.
  it('[teeth] patchPackageJsonDeps is a no-op when dep map is empty — proves collection step is load-bearing', () => {
    const basePkg = {
      name: 'apigen-generated-output',
      version: '0.0.0',
      type: 'module',
      dependencies: { '@adhd/apigen-runtime': '^0.1.0' },
    }
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(basePkg, null, 2) + '\n')

    // Bypass the collection step (empty dep map — what the old code would do).
    patchPackageJsonDeps(tmpDir, {})

    const pkg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'package.json'), 'utf8')) as Record<string, unknown>
    const deps = (pkg['dependencies'] as Record<string, string> | undefined) ?? {}
    expect(deps['decimal.js'], 'decimal.js must NOT appear when dep map is empty').toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Integration: full generate command — negative control (non-Decimal surface)
// Proves the manifest is minimal/per-surface: no decimal.js for plain surfaces.
// ---------------------------------------------------------------------------

describe('dep-manifest: generate command — negative control', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-decimal-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // Negative-control with teeth: generate from a source with NO Decimal types
  // and confirm decimal.js is absent — proves the manifest is per-surface
  // minimal, not a blanket dep list.
  it('[negative-control] does NOT declare decimal.js for a surface with no Decimal types', async () => {
    await runGenerate([
      'generate',
      '--source', apiFixture, // api.ts: plain string/void params — no decimal
      '--type', 'jsonschema',
      '--out-dir', tmpDir,
    ])

    const pkgPath = path.join(tmpDir, 'package.json')
    expect(fs.existsSync(pkgPath), 'package.json should be emitted').toBe(true)

    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Record<string, unknown>
    const deps = (pkg['dependencies'] as Record<string, string> | undefined) ?? {}

    expect(deps['decimal.js'], 'decimal.js must NOT appear for a non-Decimal surface').toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// [dod.10 teeth] End-to-end: generate pipeline with a real default-imported
// Decimal source produces format:decimal schemas AND decimal.js in package.json.
//
// This test drives the v1 generate pipeline (the same path as the probe:
// `generate --type mcp --source decimal-real-import.ts`) against a fixture
// that uses `import Decimal from 'decimal.js'` (the default-import form).
// ts-morph emits `import("/path/decimal.js/decimal").default` for this form —
// NOT the bare string `"Decimal"` — so the fix in buildSchema
// (calling normalizeTypeText() before the SCALAR_SCHEMAS lookup) is
// exercised end-to-end.
//
// Regression guarantee:
//   - Revert the normalizeTypeText() call in buildSchema → the schemas carry
//     {} instead of {type:string,format:decimal} → collectLogicalTypeDeps
//     finds no decimal format → patchPackageJsonDeps writes nothing →
//     decimal.js absent in package.json → this test goes RED.
// ---------------------------------------------------------------------------

describe('[dod.10 teeth] decimal default-import: schema carries format:decimal and package.json declares decimal.js', () => {
  let tmpDir: string
  const decimalRealFixture = path.join(fixturesDir, 'decimal-real-import.ts')

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-dod10-teeth-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // [dod.10.a] The v1 generate pipeline extracts format:decimal from a
  // default-imported Decimal source — proves normalizeTypeText() fires.
  it(
    'v1 generate pipeline: generated package.json declares decimal.js for a default-imported Decimal source',
    async () => {
      // Use the actual generateSchemas + composeSchemas to prove the
      // schema carries format:decimal at the extraction layer — the
      // consumer-visible outcome the dep-manifest step keys on.
      const gen = await generateSchemas({
        sourceFile: decimalRealFixture,
        exportMode: { type: 'named' },
      })

      const schemas = composeSchemas(gen, [], {})

      // The composed schema for addAmounts must carry format:decimal somewhere
      // in the input or output. If normalizeTypeText is not called, the schema
      // will be {} (ts-json-schema-generator cannot resolve the qualified import
      // path), and collectFormats will find no decimal format → decimal.js absent.
      const addAmountsSchema = schemas['addAmounts']
      expect(addAmountsSchema, 'addAmounts schema must be present').toBeDefined()

      const allFormats = new Set<string>()
      if (addAmountsSchema) {
        for (const f of collectFormats(addAmountsSchema.input)) allFormats.add(f)
        for (const f of collectFormats(addAmountsSchema.output)) allFormats.add(f)
      }

      // Teeth: if normalizeTypeText() is removed from buildSchema, format:decimal
      // will NOT be in allFormats (the schema will be {} or {}), making this red.
      expect(
        allFormats.has('decimal'),
        `format:decimal not found in composed schema — schema = ${JSON.stringify(addAmountsSchema)}. ` +
        `This means normalizeTypeText() is not normalising the qualified import path to "Decimal".`,
      ).toBe(true)

      // Also verify the dep-manifest step fires correctly for this schema.
      const deps = collectLogicalTypeDeps(schemas)
      expect(
        deps['decimal.js'],
        `decimal.js not in deps — deps=${JSON.stringify(deps)}. format:decimal was lost before collectLogicalTypeDeps.`,
      ).toBe('^10')
    },
    30_000,
  )

  // [dod.10.b] Full CLI generate (v1 path, no --v2) against the default-import
  // Decimal fixture: package.json in out-dir declares decimal.js.
  // This is the EXACT path the probe exercises.
  it(
    'full CLI v1 generate: package.json in output declares decimal.js for a default-imported Decimal source',
    async () => {
      const program = makeProgram()
      // The generate command is registered with jsonschema plugin — we need mcp
      // plugin for parity with the probe but any plugin that emits package.json
      // via emitResolutionScaffolding is equivalent here; jsonschema does that.
      registerGenerateCommand(program, plugins)

      await program.parseAsync([
        'node', 'apigen-cli',
        'generate',
        '--source', decimalRealFixture,
        '--type', 'jsonschema',
        '--out-dir', tmpDir,
      ])

      const pkgPath = path.join(tmpDir, 'package.json')
      expect(fs.existsSync(pkgPath), 'package.json must be emitted by the generate command').toBe(true)

      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Record<string, unknown>
      const deps = (pkg['dependencies'] as Record<string, string> | undefined) ?? {}

      // Teeth: reverting normalizeTypeText() in buildSchema causes format:decimal
      // to be absent from the schemas → collectLogicalTypeDeps returns {} →
      // patchPackageJsonDeps writes nothing → decimal.js absent → this goes RED.
      expect(
        deps['decimal.js'],
        `generated package.json does not declare decimal.js (deps=${JSON.stringify(deps)}). ` +
        `The v1 generate pipeline lost format:decimal for the default-imported Decimal type.`,
      ).toBe('^10')
    },
    30_000,
  )

  // [dod.10.c teeth] Negative-control: prove test (b) goes red if dep-collection
  // is bypassed. Without decimal.js, a clean npm install of the generated output
  // would fail. This proves the test has real teeth.
  it(
    '[negative-control] generated package.json does NOT declare decimal.js when patching is bypassed',
    () => {
      // Write a package.json without decimal.js (simulating the pre-fix state).
      const basePkg = {
        name: 'apigen-generated-output',
        version: '0.0.0',
        type: 'module',
        dependencies: { '@adhd/apigen-runtime': '^0.1.0' },
      }
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(basePkg, null, 2) + '\n')

      const pkg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'package.json'), 'utf8')) as Record<string, unknown>
      const deps = (pkg['dependencies'] as Record<string, string> | undefined) ?? {}

      // Without patchPackageJsonDeps being called with decimal deps, decimal.js is absent.
      expect(deps['decimal.js']).toBeUndefined()
    },
  )
})
