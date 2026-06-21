import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { Command } from 'commander'
import { registerGenerateCommand, resolveExportMode } from '../lib/commands/generate'
import { registerGenerateRegistryCommand } from '../lib/commands/generate-registry'
import { discoverPackages } from '../lib/registry'
import jsonschemaPlugin from '@adhd/apigen-plugin-jsonschema'
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
