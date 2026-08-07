/**
 * Regression test for DEBT-APIGEN-CLI-002 (packages/apigen/BACKLOG.md): the
 * generated `cli.ts` imported its domain module by a machine-absolute path
 * (`import * as ns from '/Users/.../tmp/dispatchcli/api.ts'`), which is not
 * relocatable — the artifact only worked on the machine that generated it,
 * and diffs across machines defeated the nx cache's byte-identical caching
 * expectations. `relativeImportPath()` already existed in `generate.ts` but
 * was unused for the actual import-line emission; a prior fix (see git log
 * on this file) wired it in, but no regression test asserted it — this file
 * closes that gap so a future revert (going back to `pkg.importPath`
 * verbatim in the import line) is caught immediately.
 *
 * Two layers of proof, mirroring hyphenated-namespace.spec.ts:
 *   (1) FAST unit check — an absolute `importPath` with a different
 *       `outputDir` must emit a `./`/`../`-relative import, never the
 *       absolute path text.
 *   (2) REAL regression — generates a CLI whose domain module lives in a
 *       SIBLING directory to its output dir (so the relative path has a
 *       `../` hop) and SPAWNS it, proving the emitted import actually
 *       resolves at runtime — not just that the string looks relative.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { generate } from '../lib/generate'
import type { PluginInput } from '@adhd/apigen-core'

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..')
const TSCONFIG_BASE = path.join(REPO_ROOT, 'tsconfig.base.json')
const TMP_ROOT = path.join(REPO_ROOT, 'tmp', 'apigen-plugin-cli-output', 'relative-import-regression')

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

describe('generate() — relative import path (unit)', () => {
  it('rewrites an absolute importPath to a path relative to outputDir', () => {
    const input: PluginInput = {
      packages: [
        {
          id: 'myPkg',
          // Deliberately machine-absolute and NOT under outputDir, so a
          // correct relative path must climb up via `../`.
          importPath: '/Users/someone/dev/project/src/api.ts',
          schemas: { ping: makePingSchema() },
        },
      ],
      outputDir: '/Users/someone/dev/project/dist/out',
      options: {},
    }
    const { content } = generate(input).files[0]

    // The bug: the raw machine-absolute path baked verbatim into the import.
    expect(content).not.toContain("from '/Users/someone/dev/project/src/api.ts'")
    // The fix: a relative import, computed from outputDir.
    expect(content).toContain("import * as myPkg_ns from '../../src/api.ts'")
  })

  it('leaves a package-name importPath (non-absolute) untouched', () => {
    const input: PluginInput = {
      packages: [{ id: 'myPkg', importPath: '@acme/my-pkg', schemas: { ping: makePingSchema() } }],
      outputDir: '/tmp/out',
      options: {},
    }
    const { content } = generate(input).files[0]
    expect(content).toContain("import * as myPkg_ns from '@acme/my-pkg'")
  })
})

describe('generate() — REAL cross-directory importPath, SPAWNED (end-to-end regression)', () => {
  afterAll(() => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true })
  })

  it('produces a cli.ts whose relative import actually resolves and runs from a different output dir', () => {
    const srcDir = path.join(TMP_ROOT, 'src')
    const outDir = path.join(TMP_ROOT, 'out')
    fs.mkdirSync(srcDir, { recursive: true })
    fs.mkdirSync(outDir, { recursive: true })

    const domainFile = path.join(srcDir, 'domain.ts')
    fs.writeFileSync(
      domainFile,
      `export function ping(): { ok: boolean } { return { ok: true } }\n`,
      'utf8',
    )

    const input: PluginInput = {
      packages: [{ id: 'relImportPkg', importPath: domainFile, schemas: { ping: makePingSchema() } }],
      outputDir: outDir,
      options: { name: 'rel-import-fixture-cli' },
    }
    const { content } = generate(input).files[0]

    // Sanity: the absolute source path must not appear verbatim in the emitted import.
    expect(content).not.toContain(`from '${domainFile}'`)
    expect(content).toMatch(/import \* as relImportPkg_ns from '\.\.\/src\/domain(\.ts)?'/)

    const cliPath = path.join(outDir, 'cli.ts')
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
