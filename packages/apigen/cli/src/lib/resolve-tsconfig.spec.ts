import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { resolveTsconfig } from './resolve-tsconfig'

describe('resolveTsconfig — precedence: explicit > nearest > builtin', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-resolve-'))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('explicit --tsconfig wins over a nearer config (resolved to absolute)', () => {
    const dir = path.join(root, 'pkg')
    fs.mkdirSync(dir, { recursive: true })
    const source = path.join(dir, 'api.ts')
    fs.writeFileSync(source, 'export const x = 1')
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}') // nearest — must be ignored

    const explicit = path.join(root, 'explicit.json')
    fs.writeFileSync(explicit, '{}')

    expect(resolveTsconfig(source, explicit)).toBe(explicit)
  })

  it('picks the NEAREST tsconfig walking up from the source dir', () => {
    // root/tsconfig.json (far) and root/a/b/tsconfig.json (near); source at root/a/b/c/api.ts
    fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}')
    const near = path.join(root, 'a', 'b')
    const deep = path.join(near, 'c')
    fs.mkdirSync(deep, { recursive: true })
    const nearCfg = path.join(near, 'tsconfig.json')
    fs.writeFileSync(nearCfg, '{}')
    const source = path.join(deep, 'api.ts')
    fs.writeFileSync(source, 'export const x = 1')

    expect(resolveTsconfig(source)).toBe(nearCfg)
  })

  it('walks past dirs without a tsconfig to the first ancestor that has one', () => {
    const cfg = path.join(root, 'tsconfig.json')
    fs.writeFileSync(cfg, '{}')
    const deep = path.join(root, 'x', 'y', 'z')
    fs.mkdirSync(deep, { recursive: true })
    const source = path.join(deep, 'api.ts')
    fs.writeFileSync(source, 'export const x = 1')

    expect(resolveTsconfig(source)).toBe(cfg)
  })

  it('falls back to a builtin default tsconfig when none is found up-tree', () => {
    // Use a temp dir guaranteed to have no tsconfig.json anywhere above it would
    // normally hit the repo root, so we mirror the standalone case: a fresh source
    // under os.tmpdir() with the config removed. We assert a real, readable file
    // whose compilerOptions match the shipped builtin.
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-iso-'))
    const source = path.join(isolated, 'api.ts')
    fs.writeFileSync(source, 'export const x = 1')

    const resolved = resolveTsconfig(source)
    // It must be a real file...
    expect(fs.existsSync(resolved)).toBe(true)
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8')) as {
      compilerOptions?: Record<string, unknown>
    }
    // ...carrying the builtin compilerOptions, NOT some unrelated repo tsconfig.
    expect(parsed.compilerOptions?.['moduleResolution']).toBe('bundler')
    expect(parsed.compilerOptions?.['target']).toBe('ES2020')

    fs.rmSync(isolated, { recursive: true, force: true })
  })
})
