/**
 * Module-format guard (ADR-0003).
 * Ticket 8468f7b1 AC capture-upgrade.27 · [capture-upgrade.27]
 * The store adapter package is ESM-only while this package publishes CommonJS,
 * and Node 22.5 to 22.11 cannot require() an ES module. The recording code must
 * therefore touch it only through `import type` plus ONE lazy dynamic
 * import() inside the loadAdapter default; a static or require() reference
 * would throw at load time for every consumer on those Node versions.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const PKG = '@adhd/sox-store-adapter'
const ROOT = join(__dirname, '..', '..', '..', '..')
const RECORDING = join(ROOT, 'src', 'lib', 'recording')

function sources(dir: string): Array<{ file: string; text: string }> {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ file: f, text: readFileSync(join(dir, f), 'utf8') }))
}

describe('8468f7b1 [capture-upgrade.27] source text of src/lib/recording', () => {
  const files = sources(RECORDING)

  it('references the package at top level only through import type', () => {
    const imports = files.flatMap(({ file, text }) =>
      [...text.matchAll(/^\s*import\s+(type\s+)?([^;]*?)\s+from\s*['"]@adhd\/sox-store-adapter['"]/gm)].map((m) => ({ file, isType: m[1] !== undefined })),
    )
    expect(imports.length).toBeGreaterThan(0)
    expect(imports.filter((i) => !i.isType)).toEqual([])
    expect(files.some((f) => /^\s*export\s+[^;]*from\s*['"]@adhd\/sox-store-adapter['"]/m.test(f.text))).toBe(false)
  })

  it('has exactly one dynamic import() of the package, inside the loadAdapter default of open-store-sink.ts', () => {
    const sites = files.flatMap(({ file, text }) => [...text.matchAll(/import\(\s*['"]@adhd\/sox-store-adapter['"]\s*\)/g)].map(() => file))
    expect(sites).toEqual(['open-store-sink.ts'])
    const open = files.find((f) => f.file === 'open-store-sink.ts')?.text ?? ''
    expect(open).toMatch(/opts\.loadAdapter \?\? \(\(\) => import\('@adhd\/sox-store-adapter'\)\)/)
  })

  it('never uses require, node:sqlite or the process environment', () => {
    for (const { file, text } of files) {
      expect(text, file).not.toMatch(/require\(\s*['"]@adhd\/sox-store-adapter/)
      expect(text, file).not.toContain('node:sqlite')
      expect(text, file).not.toContain('process.env')
    }
  })
})

describe('8468f7b1 [capture-upgrade.27] build wiring', () => {
  it('package.json lists the adapter in dependencies and vite.config.ts externalizes real dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
    expect(pkg.dependencies?.[PKG]).toBeTruthy()
    expect(readFileSync(join(ROOT, 'vite.config.ts'), 'utf8')).toContain('externalizeRealDeps(__dirname)')
  })

  it('a built dist/index.js (when present) has no require of the package', () => {
    const dist = join(ROOT, 'dist', 'index.js')
    if (!existsSync(dist)) return // the build output is optional in the unit lane
    const text = readFileSync(dist, 'utf8')
    expect(text).not.toContain(`require('${PKG}')`)
    expect(text).not.toContain(`require("${PKG}")`)
  })

  it('no spec replaces the real package with vi.mock (the factory is faked through loadAdapter only)', () => {
    const specDir = join(ROOT, 'src', 'test', 'unit', 'capture')
    for (const { file, text } of sources(specDir).filter((f) => f.file.endsWith('.spec.ts'))) {
      expect(text, file).not.toMatch(/vi\.mock\(\s*['"]@adhd\/sox-store-adapter/)
    }
  })
})
