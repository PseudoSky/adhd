/**
 * defaultReaperEntry resolves the package entry the detached reaper requires, under ESM and CJS.
 * Ticket 8468f7b1 · [fix-core-lifecycle.1] backlog 86a2318f
 *
 * Backlog 86a2318f: `defaultReaperEntry` read `__filename`, which does not exist when the module
 * is loaded as ESM, so it answered null and the manager ran without a reaper. The fix resolves the
 * package entry from the module URL under ESM (and takes the bundle's own `__filename` under CJS),
 * and a package that cannot be resolved is a typed LifecycleError, never null.
 *
 * The proof is the real resolution: a throwaway `node_modules/@adhd/stealth-core-browser` tree on
 * disk, resolved by Node's own `createRequire` from a module URL inside it. No process, no network.
 * guards: defaultReaperEntry answers null (or throws untyped) when loaded as ESM, so the reaper never starts
 * tier: S
 * cites: 8468f7b1 [fix-core-lifecycle.1]
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { LifecycleError } from '../../../src/lib/lifecycle/errors.js'
import { currentModuleUrl, defaultReaperEntry } from '../../../src/lib/lifecycle/reaper-link.js'

let root: string
let entry: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'reaper-entry-')))
  const pkg = join(root, 'node_modules', '@adhd', 'stealth-core-browser')
  mkdirSync(join(pkg, 'dist'), { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@adhd/stealth-core-browser', main: './dist/index.js' }))
  entry = join(pkg, 'dist', 'index.js')
  writeFileSync(entry, 'module.exports = {}\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('defaultReaperEntry (86a2318f)', () => {
  it('86a2318f defaultReaperEntry under ESM: no __filename, resolves the package entry from the module URL to an absolute path', () => {
    const moduleUrl = pathToFileURL(join(root, 'consumer', 'host.mjs')).href
    const resolved = defaultReaperEntry({ moduleUrl })
    expect(isAbsolute(resolved)).toBe(true)
    expect(resolved).toBe(entry)
    expect(resolved.endsWith(`${sep}dist${sep}index.js`)).toBe(true)
  })

  it('86a2318f defaultReaperEntry under CJS: the bundle __filename is the entry', () => {
    const bundle = join(root, 'dist', 'index.js')
    expect(defaultReaperEntry({ filename: bundle })).toBe(bundle)
  })

  it('86a2318f defaultReaperEntry under CJS prefers the bundle __filename over package resolution', () => {
    const bundle = join(root, 'elsewhere', 'index.cjs')
    const moduleUrl = pathToFileURL(join(root, 'consumer', 'host.js')).href
    expect(defaultReaperEntry({ filename: bundle, moduleUrl })).toBe(bundle)
  })

  it('86a2318f defaultReaperEntry from TypeScript source (CJS __filename is a .ts file) resolves the built package entry, not the source', () => {
    const moduleUrl = pathToFileURL(join(root, 'consumer', 'host.js')).href
    expect(defaultReaperEntry({ filename: join(root, 'src', 'reaper-link.ts'), moduleUrl })).toBe(entry)
  })

  it('86a2318f defaultReaperEntry ESM with an unresolvable package fails with a typed REAPER_UNAVAILABLE LifecycleError', () => {
    const bare = realpathSync(mkdtempSync(join(tmpdir(), 'reaper-entry-bare-')))
    try {
      const moduleUrl = pathToFileURL(join(bare, 'host.mjs')).href
      let caught: unknown
      try {
        defaultReaperEntry({ moduleUrl })
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(LifecycleError)
      expect((caught as LifecycleError).code).toBe('REAPER_UNAVAILABLE')
      expect((caught as LifecycleError).message).toContain('@adhd/stealth-core-browser')
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })

  it('86a2318f defaultReaperEntry with neither __filename nor a module URL fails with a typed LifecycleError, never null', () => {
    expect(() => defaultReaperEntry({})).toThrow(LifecycleError)
  })
})

describe('[fix-core-lifecycle.1] currentModuleUrl names this module without import.meta', () => {
  it('answers the file URL of reaper-link under the running loader', () => {
    const url = currentModuleUrl()
    expect(url).toMatch(/^file:\/\/.*reaper-link\.(?:ts|js)$/)
  })
})
