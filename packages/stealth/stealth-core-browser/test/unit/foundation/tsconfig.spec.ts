/**
 * The package's TypeScript project layout is coherent: nothing under src/ is type-checked by neither project.
 * Ticket 8468f7b1 · criteria [resolve-findings.2] F78.
 * guards: tsconfig.json keeps a deprecated module setting behind ignoreDeprecations, or a src/**\/*.test.ts file is excluded from the library project and not included by the spec project, so no tsc run ever checks it
 * tier: S
 * cites: 8468f7b1 [resolve-findings.2] F78
 * plan: stealth-browser, state resolve-findings, task resolve-findings-implementer
 * teeth: red: vitest run --config packages/stealth/stealth-core-browser/vite.config.ts test/unit/foundation/tsconfig.spec.ts -> exit 1 (1 failed | 2 passed) with tsconfig.json set back to module commonjs + moduleResolution node10; the ESM + bundler case fails.
 * Reads the three tsconfig files from the package root; no process, no network.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (name: string): { compilerOptions?: Record<string, unknown>; include?: string[]; exclude?: string[] } =>
  JSON.parse(readFileSync(join(root, name), 'utf8')) as { compilerOptions?: Record<string, unknown>; include?: string[]; exclude?: string[] }

describe('[resolve-findings.2] F78 tsconfig layout', () => {
  it('the base project uses ESM + bundler resolution and needs no ignoreDeprecations', () => {
    const base = read('tsconfig.json').compilerOptions ?? {}
    expect(base['module']).toBe('esnext')
    expect(base['moduleResolution']).toBe('bundler')
    expect(base).not.toHaveProperty('ignoreDeprecations')
  })

  it('every src test glob the lib project excludes is included by the spec project', () => {
    const lib = read('tsconfig.lib.json')
    const spec = read('tsconfig.spec.json')
    const excludedSrcTests = (lib.exclude ?? []).filter((g) => g.startsWith('src/') && /\.(test|spec)\./.test(g))
    expect(excludedSrcTests.length).toBeGreaterThan(0)
    for (const glob of excludedSrcTests.filter((g) => g.endsWith('.ts') || g.endsWith('.tsx'))) {
      expect(spec.include ?? [], glob).toContain(glob)
    }
  })

  it('the spec project does not override module settings the base already sets', () => {
    expect(read('tsconfig.spec.json').compilerOptions).not.toHaveProperty('moduleResolution')
  })
})
