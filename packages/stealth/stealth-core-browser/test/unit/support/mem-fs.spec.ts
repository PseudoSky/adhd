/**
 * Harness spec for test/helpers/mem-fs.ts.
 * Ticket 8468f7b1 · [cdp-test-harness.5]
 * Real use: two launchers race for an exclusive lock file; a writer publishes a
 * record by write-temp-then-rename; a janitor lists the directory and checks
 * file ownership and permissions.
 * guards: the first wx open wins and the second fails with EEXIST (EEXIST exclusive-create)
 * tier: S
 * cites: 8468f7b1 [cdp-test-harness.5]
 */
import { describe, expect, it } from 'vitest'
import { MemFs } from '../../helpers/mem-fs.js'

const code = (fn: () => unknown): string | undefined => {
  try {
    fn()
  } catch (e) {
    return (e as NodeJS.ErrnoException).code
  }
  return undefined
}

describe('8468f7b1 [cdp-test-harness.5] MemFs exclusive create', () => {
  it('the first wx open wins and the second fails with EEXIST (EEXIST exclusive-create)', () => {
    const fs = new MemFs()
    fs.mkdirSync('/run/locks', { recursive: true })
    const fd = fs.openSync('/run/locks/9222.lock', 'wx', 0o600)
    expect(code(() => fs.openSync('/run/locks/9222.lock', 'wx'))).toBe('EEXIST')
    fs.closeSync(fd)
    fs.unlinkSync('/run/locks/9222.lock')
    expect(() => fs.openSync('/run/locks/9222.lock', 'wx')).not.toThrow()
  })

  it('exclusive create in a missing directory fails ENOENT and creates nothing', () => {
    const fs = new MemFs()
    expect(code(() => fs.openSync('/nope/a.lock', 'wx'))).toBe('ENOENT')
    expect(fs.existsSync('/nope')).toBe(false)
  })
})

describe('8468f7b1 [cdp-test-harness.5] MemFs rename atomicity', () => {
  it('rename replaces the destination in one step: readers see old or new, never empty', () => {
    const fs = new MemFs()
    fs.mkdirSync('/d')
    fs.writeFileSync('/d/state.json', 'old')
    fs.writeFileSync('/d/state.json.tmp', 'new')
    fs.renameSync('/d/state.json.tmp', '/d/state.json')
    expect(fs.readFileSync('/d/state.json')).toBe('new')
    expect(fs.existsSync('/d/state.json.tmp')).toBe(false)
    expect(fs.readdirSync('/d')).toEqual(['state.json'])
  })

  it('a failed rename (source missing) leaves the destination untouched', () => {
    const fs = new MemFs()
    fs.mkdirSync('/d')
    fs.writeFileSync('/d/state.json', 'keep')
    expect(code(() => fs.renameSync('/d/missing.tmp', '/d/state.json'))).toBe('ENOENT')
    expect(code(() => fs.renameSync('/d/state.json', '/gone/dir/x'))).toBe('ENOENT')
    expect(fs.readFileSync('/d/state.json')).toBe('keep')
  })

  it('rename carries mode and uid with the file and moves directory subtrees', () => {
    const fs = new MemFs(501)
    fs.mkdirSync('/a/sub', { recursive: true })
    fs.writeFileSync('/a/sub/f', 'x', { mode: 0o600 })
    fs.renameSync('/a', '/b')
    expect(fs.readFileSync('/b/sub/f')).toBe('x')
    expect(fs.statSync('/b/sub/f').mode).toBe(0o600)
    expect(fs.existsSync('/a/sub/f')).toBe(false)
  })
})

describe('8468f7b1 [cdp-test-harness.5] MemFs readdir, mode and uid', () => {
  it('readdir lists direct children only, sorted, and errors on files and missing dirs', () => {
    const fs = new MemFs()
    fs.mkdirSync('/p/deep', { recursive: true })
    fs.writeFileSync('/p/b', '')
    fs.writeFileSync('/p/a', '')
    fs.writeFileSync('/p/deep/z', '')
    expect(fs.readdirSync('/p')).toEqual(['a', 'b', 'deep'])
    expect(code(() => fs.readdirSync('/p/a'))).toBe('ENOTDIR')
    expect(code(() => fs.readdirSync('/q'))).toBe('ENOENT')
  })

  it('stat reports mode, owner uid, size and mtime from the injected clock', () => {
    let t = 1000
    const fs = new MemFs(501, () => t)
    fs.writeFileSync('/f', 'abc', { mode: 0o600 })
    expect(fs.statSync('/f')).toMatchObject({ mode: 0o600, uid: 501, size: 3, mtimeMs: 1000 })
    t = 2000
    fs.chmodSync('/f', 0o644)
    fs.setUid('/f', 0)
    fs.setMtime('/f', 1500)
    expect(fs.statSync('/f')).toMatchObject({ mode: 0o644, uid: 0, mtimeMs: 1500 })
    expect(fs.statSync('/f').isFile()).toBe(true)
    expect(fs.statSync('/').isDirectory()).toBe(true)
  })

  it('append mode keeps content and w truncates; reads of a directory fail EISDIR', () => {
    const fs = new MemFs()
    fs.writeFileSync('/log', 'a')
    fs.writeFileSync('/log', 'b', { flag: 'a' })
    expect(fs.readFileSync('/log')).toBe('ab')
    fs.writeFileSync('/log', 'c')
    expect(fs.readFileSync('/log')).toBe('c')
    expect(code(() => fs.readFileSync('/'))).toBe('EISDIR')
    expect(code(() => fs.mkdirSync('/log'))).toBe('EEXIST')
  })
})
