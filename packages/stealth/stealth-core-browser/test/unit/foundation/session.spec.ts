/**
 * Unit spec for src/lib/session.ts.
 * Ticket 8468f7b1 AC2 (behavior-preserving port, unit lane) ·
 * criteria [tests-unit-core.1] [tests-unit-core.2] [tests-unit-core.4].
 * Pure logic: node:crypto's randomUUID is replaced where a case needs a known id; no process, network or profile access.
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

/** Fresh module whose randomUUID yields the given ids in order. */
async function loadWithUuids(ids: string[]): Promise<{ mod: SessionModule; randomUUID: ReturnType<typeof vi.fn> }> {
  vi.resetModules()
  const randomUUID = vi.fn(() => ids.shift() ?? 'exhausted')
  vi.doMock('node:crypto', () => ({ randomUUID }))
  return { mod: await import('../../../src/lib/session.js'), randomUUID }
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('8468f7b1 AC2 [tests-unit-core.1] getSessionId', () => {
  afterEach(() => {
    vi.doUnmock('node:crypto')
    vi.resetModules()
  })

  it('returns an RFC 4122 v4 UUID', async () => {
    const { getSessionId } = await loadFresh()
    expect(getSessionId()).toMatch(UUID_V4)
  })

  it('[fs-093] session id is a stable v4 uuid: is lazily generated once and stable across calls', async () => {
    const { mod, randomUUID } = await loadWithUuids(['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'])
    expect(randomUUID).not.toHaveBeenCalled() // lazy: nothing is generated at import time
    const first = mod.getSessionId()
    const second = mod.getSessionId()
    expect(first).toBe('11111111-1111-4111-8111-111111111111')
    expect(second).toBe(first)
    expect(randomUUID).toHaveBeenCalledTimes(1)
  })

  it('[fs-094] uuid has v4 version and variant bits: every id the real generator yields has them, grouped 8-4-4-4-12', async () => {
    vi.doUnmock('node:crypto')
    const seen = new Set<string>()
    for (let i = 0; i < 25; i++) {
      vi.resetModules()
      const id = (await import('../../../src/lib/session.js')).getSessionId()
      expect(id).toMatch(UUID_V4)
      seen.add(id)
    }
    expect(seen.size).toBe(25) // a fresh module draws a fresh id
  })

  it('a new process-level module instance draws a new id (the cache is per module)', async () => {
    const { mod } = await loadWithUuids(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'])
    expect(mod.getSessionId()).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    const { mod: other } = await loadWithUuids(['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'])
    expect(other.getSessionId()).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
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
