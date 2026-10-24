/**
 * guards: the nx key of package.json reaches the published manifest
 * tier: S
 * cites: ticket 8468f7b1 [fix-search-build.2]
 * The published manifest is what `nx run stealth-search:dist-manifest` writes to dist/package.json: the
 * output of `generateDistManifest` over the source package.json. The source keeps its `nx` key; the
 * published manifest must not carry it. The generator is pure, so the spec feeds it the real source
 * manifest: no pack, no build. Ticket 8468f7b1 · plan state fix-search-build.
 *
 * Criteria: [fix-search-build.2]
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..', '..')
const req = createRequire(__filename)
const { generateDistManifest } = req(join(root, '..', '..', 'tools', 'nx-plugins', 'build', 'executors', 'manifest', 'generate-manifest.js')) as {
  generateDistManifest: (pkg: Record<string, unknown>, versions: Record<string, string>) => Record<string, unknown>
}
const source = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>
const versions: Record<string, string> = Object.fromEntries(Object.keys((source['dependencies'] ?? {}) as object).filter((n) => n.startsWith('@adhd/')).map((n) => [n, '1.2.3']))

describe('published manifest nx key [fix-search-build.2]', () => {
  it('nx key control: the source package.json may keep its nx key, so the check on the published manifest is not vacuous', () => {
    expect(source).toHaveProperty('nx')
  })

  it('published manifest carries no nx key', () => {
    const published = generateDistManifest(source, versions)
    expect(Object.keys(published)).not.toContain('nx')
    expect(JSON.stringify(published)).not.toContain('"nx"')
  })

  it('published manifest keeps the fields a consumer needs and drops the build-only ones', () => {
    const published = generateDistManifest(source, versions) as { name: string; bin: Record<string, string>; scripts?: unknown; devDependencies?: unknown; files?: unknown }
    expect(published.name).toBe('@adhd/stealth-search')
    expect(published.bin).toEqual({ 'stealth-search': 'bin/cli.js', 'stealth-search-mcp': 'bin/mcp.js' })
    expect(published.scripts).toBeUndefined()
    expect(published.devDependencies).toBeUndefined()
    expect(published.files).toBeUndefined()
  })

  it('published manifest generation does not mutate the source manifest (its nx key survives)', () => {
    const before = JSON.stringify(source)
    generateDistManifest(source, versions)
    expect(JSON.stringify(source)).toBe(before)
    expect(source).toHaveProperty('nx')
  })
})
