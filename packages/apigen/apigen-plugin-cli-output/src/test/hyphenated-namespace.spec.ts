/**
 * Regression test for BUG-APIGEN-CLI-001 (packages/apigen/BACKLOG.md): the
 * cli-output plugin derived its generated import-namespace identifier
 * verbatim from the source package id, so a hyphenated source directory
 * name (repo convention — every @adhd/* package dir is hyphenated, e.g.
 * `dispatch-cli`) produced `import * as dispatch-cli_ns from …` — an
 * invalid TS identifier and a hard parse error. Found 2026-07-02 during the
 * dispatch-cli spike; reproduced from `tmp/dispatch-cli-spike/api.ts`,
 * confirmed working from the hyphen-free `tmp/dispatchcli/`.
 *
 * Two layers of proof:
 *   (1) FAST unit check — generate() with a hyphenated `id` never emits the
 *       invalid bare-hyphen identifier form, and emits the sanitized one
 *       instead, while the human-readable namespace stays verbatim in the
 *       schema-key STRING.
 *   (2) REAL regression — generates a CLI from an ACTUAL hyphenated
 *       directory on disk and SPAWNS it (`--help`, then a real subcommand
 *       call), asserting real process exit codes. This is the layer that
 *       actually catches the bug: a parse error only manifests when
 *       node/tsx tries to run the file — a `toContain()` assertion on the
 *       emitted text alone would not have caught it.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { generate } from '../lib/generate'
import type { PluginInput } from '@adhd/apigen-core'

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..')
const TSCONFIG_BASE = path.join(REPO_ROOT, 'tsconfig.base.json')
const TMP_ROOT = path.join(REPO_ROOT, 'tmp', 'apigen-plugin-cli-output', 'hyphenated-regression')

/** Minimal 0-arg composed schema (no session, no domain params) — enough to exercise codegen. */
function makePingSchema() {
  return {
    input: {
      type: 'object',
      properties: { data: { type: 'object', properties: {} } },
      required: ['data'],
    },
    output: { type: 'object', properties: { ok: { type: 'boolean' } } },
  }
}

describe('generate() — hyphenated namespace identifier (unit)', () => {
  it('sanitizes a hyphenated pkg.id into a valid identifier, but keeps it verbatim in the schema-key string', () => {
    const input: PluginInput = {
      packages: [
        { id: 'dispatch-cli', importPath: '@acme/dispatch-cli', schemas: { ping: makePingSchema() } },
      ],
      outputDir: '/tmp/out',
      options: {},
    }
    const { content } = generate(input).files[0]

    // The invalid raw form must never appear — this is a TS parse error.
    expect(content).not.toContain('import * as dispatch-cli_ns')
    expect(content).not.toContain('dispatch-cli_fns')
    // The sanitized identifier form must appear instead.
    expect(content).toContain("import * as dispatch_cli_ns from '@acme/dispatch-cli'")
    expect(content).toContain('const dispatch_cli_fns = buildFnTable(dispatch_cli_ns')
    expect(content).toContain('dispatch(dispatch_cli_fns as any')
    // The human-readable namespace is preserved verbatim as a schema-key STRING.
    expect(content).toContain('"dispatch-cli:ping"')
    expect(content).toContain("schemas['dispatch-cli:ping']")
  })

  it('is a no-op for an already-valid identifier (existing behavior stays byte-identical)', () => {
    const input: PluginInput = {
      packages: [{ id: 'myPkg', importPath: '@acme/my-pkg', schemas: { ping: makePingSchema() } }],
      outputDir: '/tmp/out',
      options: {},
    }
    const { content } = generate(input).files[0]
    expect(content).toContain("import * as myPkg_ns from '@acme/my-pkg'")
    expect(content).toContain('const myPkg_fns = buildFnTable(myPkg_ns')
  })
})

describe('generate() — REAL hyphenated source dir, SPAWNED (end-to-end regression)', () => {
  afterAll(() => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true })
  })

  it('produces a cli.ts that node/tsx can actually parse and run from a hyphenated dir', () => {
    const fixtureDir = path.join(TMP_ROOT, 'my-hyphenated-fixture')
    fs.mkdirSync(fixtureDir, { recursive: true })

    const domainFile = path.join(fixtureDir, 'domain.ts')
    fs.writeFileSync(
      domainFile,
      `export function ping(): { ok: boolean } { return { ok: true } }\n`,
      'utf8',
    )

    // Mirrors apigen-cli's resolveNamespace() fallback exactly (no project
    // tsconfig found): path.basename(path.dirname(sourceFile)). Computed
    // locally, not imported — this package must never depend on
    // @adhd/apigen-cli (apigen-cli depends on the plugins, not the reverse).
    const id = path.basename(fixtureDir)
    expect(id).toContain('-') // sanity: this IS the hyphenated-dir scenario

    const input: PluginInput = {
      packages: [{ id, importPath: domainFile, schemas: { ping: makePingSchema() } }],
      outputDir: fixtureDir,
      options: { name: 'hyphen-fixture-cli' },
    }
    const { content } = generate(input).files[0]
    const cliPath = path.join(fixtureDir, 'cli.ts')
    fs.writeFileSync(cliPath, content, 'utf8')

    const help = spawnSync('npx', ['tsx', '--tsconfig', TSCONFIG_BASE, cliPath, '--help'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 30_000,
    })
    expect(help.error, `spawn error: ${String(help.error)}`).toBeUndefined()
    expect(help.status, `--help stderr:\n${help.stderr}\nstdout:\n${help.stdout}`).toBe(0)
    expect(help.stdout).toContain('ping')

    const call = spawnSync('npx', ['tsx', '--tsconfig', TSCONFIG_BASE, cliPath, 'ping'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 30_000,
    })
    expect(call.error, `spawn error: ${String(call.error)}`).toBeUndefined()
    expect(call.status, `ping stderr:\n${call.stderr}\nstdout:\n${call.stdout}`).toBe(0)
    expect(JSON.parse(call.stdout.trim())).toEqual({ ok: true })
  }, 60_000)
})
