/**
 * Unit spec for src/lib/session.ts.
 * Ticket 8468f7b1 AC2 (behavior-preserving port, unit lane) ·
 * criteria [tests-unit-core.1] [tests-unit-core.2] [tests-unit-core.4].
 * Pure logic: crypto is stubbed, no process, network or profile access.
 * guards: returns an RFC 4122 v4 UUID
 * tier: S
 * cites: 8468f7b1 [tests-unit-core.1] [tests-unit-core.2] [tests-unit-core.4]
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type SessionModule = typeof import('../../../src/lib/session.js')

/** Fresh module instance so the lazily cached UUID starts empty. */
async function loadFresh(): Promise<SessionModule> {
  vi.resetModules()
  return import('../../../src/lib/session.js')
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('8468f7b1 AC2 [tests-unit-core.1] getSessionId', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns an RFC 4122 v4 UUID', async () => {
    const { getSessionId } = await loadFresh()
    expect(getSessionId()).toMatch(UUID_V4)
  })

  it('[fs-093] session id is a stable v4 uuid: is lazily generated once and stable across calls', async () => {
    const getRandomValues = vi.fn(<T extends ArrayBufferView | null>(arr: T): T => arr)
    vi.stubGlobal('crypto', { getRandomValues })
    const { getSessionId } = await loadFresh()
    const first = getSessionId()
    const second = getSessionId()
    expect(second).toBe(first)
    expect(getRandomValues).toHaveBeenCalledTimes(1)
  })

  it('[fs-094] uuid has v4 version and variant bits: stamps the version and variant bits and groups the hex as 8-4-4-4-12', async () => {
    vi.stubGlobal('crypto', { getRandomValues: <T extends ArrayBufferView | null>(arr: T): T => arr })
    const { getSessionId } = await loadFresh()
    expect(getSessionId()).toBe('00000000-0000-4000-8000-000000000000')
  })

  it('masks saturated random bytes into the v4 layout', async () => {
    vi.stubGlobal('crypto', {
      getRandomValues: <T extends ArrayBufferView | null>(arr: T): T => {
        ;(arr as unknown as Uint8Array).fill(0xff)
        return arr
      },
    })
    const { getSessionId } = await loadFresh()
    expect(getSessionId()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff')
  })

  it('does not return a nil or non-v4 id (negative)', async () => {
    const { getSessionId } = await loadFresh()
    const id = getSessionId()
    expect(id).not.toBe('')
    expect(id).not.toMatch(/^0{8}-/)
  })

  it('gives each fresh module instance its own id', async () => {
    const a = (await loadFresh()).getSessionId()
    const b = (await loadFresh()).getSessionId()
    expect(a).not.toBe(b)
  })

  it('[port-fixes.7] exposes no legacy getSearchSessionId alias (greenfield)', async () => {
    const mod = await loadFresh()
    expect('getSearchSessionId' in mod).toBe(false)
    expect(typeof mod.getSessionId()).toBe('string')
  })
})

describe('8468f7b1 AC2 [tests-unit-core.1] BrowserSession', () => {
  let mod: SessionModule
  beforeEach(async () => {
    mod = await loadFresh()
  })

  it('reports an empty current id and no targets before any track()', () => {
    const s = new mod.BrowserSession()
    expect(s.currentBrowserSessionId).toBe('')
    expect(s.getAll()).toEqual([])
  })

  it('[fs-095] tracks the most recent target id: tracks targets in order and exposes the most recent one', () => {
    const s = new mod.BrowserSession()
    s.track('t1')
    s.track('t2')
    expect(s.currentBrowserSessionId).toBe('t2')
    expect(s.getAll()).toEqual(['t1', 't2'])
  })

  it('[fs-096] getAll returns a copy: getAll returns a defensive copy (mutating it does not alter the session)', () => {
    const s = new mod.BrowserSession()
    s.track('t1')
    const copy = s.getAll()
    copy.push('rogue')
    expect(s.getAll()).toEqual(['t1'])
    expect(s.getAll()).not.toContain('rogue')
  })

  it('exports a shared browserSession singleton instance', () => {
    expect(mod.browserSession).toBeInstanceOf(mod.BrowserSession)
    mod.browserSession.track('shared')
    expect(mod.browserSession.getAll()).toContain('shared')
  })
})
