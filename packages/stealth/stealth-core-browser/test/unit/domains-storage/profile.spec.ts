/**
 * Unit spec for src/lib/storage/profile.ts (ProfileClient).
 * Ticket 8468f7b1 AC2 · criteria [tests-unit-data.1] [tests-unit-data.2] [tests-unit-data.3] [tests-unit-data.4].
 * SQLite/JSON/Extensions fixtures are created in the OS temp dir; console.warn is spied.
 * guards: defaultDir is <profile>/Default
 * tier: S
 * cites: 8468f7b1 [tests-unit-data.1] [tests-unit-data.2] [tests-unit-data.3] [tests-unit-data.4] [audit-fixes.5]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProfileClient } from '../../../src/lib/storage/profile.js'
import { chromeMicros, makeProfile, type Fixture } from '../../helpers/domains-storage/profile-fixture.js'

describe('8468f7b1 AC2 [tests-unit-data.1] ProfileClient', () => {
  let fx: Fixture
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    fx = makeProfile()
  })
  afterEach(() => { fx.cleanup(); vi.restoreAllMocks() })

  it('defaultDir is <profile>/Default', () => {
    expect(new ProfileClient(fx.root).defaultDir).toBe(join(fx.root, 'Default'))
  })

  it('getTopSites orders by url_rank desc and applies the limit', () => {
    const d = fx.db('Top Sites', ['CREATE TABLE top_sites (url TEXT, title TEXT, url_rank INTEGER)'])
    const ins = d.prepare('INSERT INTO top_sites VALUES (?,?,?)')
    ins.run('https://a.test', 'A', 1); ins.run('https://b.test', 'B', 5); ins.run('https://c.test', 'C', 3)
    d.close()
    const c = new ProfileClient(fx.root)
    expect(c.getTopSites().map((s) => s.url)).toEqual(['https://b.test', 'https://c.test', 'https://a.test'])
    expect(c.getTopSites(1)).toEqual([{ url: 'https://b.test', title: 'B', score: 5 }])
  })

  it('getFaviconData returns base64 data for a mapped page and null otherwise', () => {
    const d = fx.db('Favicons', [
      'CREATE TABLE icon_mapping (page_url TEXT, icon_id INTEGER)',
      'CREATE TABLE favicons (id INTEGER, url TEXT)',
      'CREATE TABLE favicon_bitmaps (icon_id INTEGER, image_data BLOB, last_updated INTEGER)',
    ])
    d.prepare('INSERT INTO icon_mapping VALUES (?,?)').run('https://a.test/', 1)
    d.prepare('INSERT INTO favicons VALUES (?,?)').run(1, 'https://a.test/favicon.ico')
    d.prepare('INSERT INTO favicon_bitmaps VALUES (?,?,?)').run(1, new Uint8Array([1, 2, 3]), 10)
    d.close()
    const c = new ProfileClient(fx.root)
    expect(c.getFaviconData('https://a.test/')).toEqual({ url: 'https://a.test/favicon.ico', data: 'AQID', mimeType: 'image/png' })
    expect(c.getFaviconData('https://missing.test/')).toBeNull()
  })

  it('getAutofillData converts Chrome microsecond timestamps to Dates', () => {
    const d = fx.db('Web Data', [
      'CREATE TABLE autofill (name TEXT, value TEXT, count INTEGER, date_last_used INTEGER)',
      'CREATE TABLE keywords (short_name TEXT, keyword TEXT, url TEXT)',
    ])
    d.prepare('INSERT INTO autofill VALUES (?,?,?,?)').run('email', 'a@b.test', 4, 1000)
    d.prepare('INSERT INTO autofill VALUES (?,?,?,?)').run('city', 'X', 1, 500)
    d.prepare('INSERT INTO keywords VALUES (?,?,?)').run('Zed', 'z', 'https://z.test/?q={searchTerms}')
    d.prepare('INSERT INTO keywords VALUES (?,?,?)').run('Ant', 'a', 'https://a.test/?q={searchTerms}')
    d.close()
    const rows = new ProfileClient(fx.root).getAutofillData()
    expect(rows.map((r) => r.name)).toEqual(['email', 'city'])
    expect(rows[0]).toMatchObject({ value: 'a@b.test', count: 4 })
    expect(rows[0].lastUsed.getTime()).toBe(1 - 11644473600000)
  })

  it('[audit-fixes.5] P32 getAutofillData({ redactValues: true }) keeps names, counts and dates and masks every value', () => {
    const d = fx.db('Web Data', ['CREATE TABLE autofill (name TEXT, value TEXT, count INTEGER, date_last_used INTEGER)'])
    d.prepare('INSERT INTO autofill VALUES (?,?,?,?)').run('email', 'a@b.test', 4, 1000)
    d.close()
    const [row] = new ProfileClient(fx.root).getAutofillData({ redactValues: true })
    expect(row).toMatchObject({ name: 'email', value: '[REDACTED]', count: 4 })
    expect(JSON.stringify(row)).not.toContain('a@b.test')
    expect(new ProfileClient(fx.root).getAutofillData({ redactValues: false })[0]?.value).toBe('a@b.test')
  })

  it('getSearchEngines is ordered by keyword and mapped to name/keyword/url', () => {
    const d = fx.db('Web Data', ['CREATE TABLE keywords (short_name TEXT, keyword TEXT, url TEXT)'])
    d.prepare('INSERT INTO keywords VALUES (?,?,?)').run('Zed', 'z', 'https://z.test')
    d.prepare('INSERT INTO keywords VALUES (?,?,?)').run('Ant', 'a', 'https://a.test')
    d.close()
    expect(new ProfileClient(fx.root).getSearchEngines()).toEqual([
      { name: 'Ant', keyword: 'a', url: 'https://a.test' },
      { name: 'Zed', keyword: 'z', url: 'https://z.test' },
    ])
  })

  it('getOpenTabs is a not-yet-implemented stub that warns and returns []', () => {
    expect(new ProfileClient(fx.root).getOpenTabs()).toEqual([])
    expect(warn).toHaveBeenCalledWith('[cdp-query] getOpenTabs is not yet implemented')
  })

  it('getPreference walks dotted keys', () => {
    fx.json('Preferences', { profile: { name: 'P', nested: { n: 2 } } })
    const c = new ProfileClient(fx.root)
    expect(c.getPreference<string>('profile.name')).toBe('P')
    expect(c.getPreference<number>('profile.nested.n')).toBe(2)
  })

  it('getPreference is undefined for missing keys, scalar traversal, or missing/corrupt files (error path)', () => {
    const c = new ProfileClient(fx.root)
    expect(c.getPreference('profile.name')).toBeUndefined() // no file yet
    fx.json('Preferences', { profile: { name: 'P' } })
    expect(c.getPreference('profile.absent')).toBeUndefined()
    expect(c.getPreference('profile.name.deeper')).toBeUndefined()
    fx.raw('Preferences', 'not json')
    expect(c.getPreference('profile.name')).toBeUndefined()
  })

  it('getExtensionIds lists only directories', () => {
    const ext = join(fx.defaultDir, 'Extensions')
    mkdirSync(join(ext, 'abcdef'), { recursive: true })
    mkdirSync(join(ext, 'ghijkl'), { recursive: true })
    writeFileSync(join(ext, 'stray.txt'), 'x')
    expect(new ProfileClient(fx.root).getExtensionIds().sort()).toEqual(['abcdef', 'ghijkl'])
  })

  it('getExtensionIds is [] when the directory is missing (error path)', () => {
    expect(new ProfileClient(fx.root).getExtensionIds()).toEqual([])
  })

  it('hasSavedCredentials reflects the logins row count', () => {
    const d = fx.db('Login Data', ['CREATE TABLE logins (origin_url TEXT)'])
    d.close()
    const c = new ProfileClient(fx.root)
    expect(c.hasSavedCredentials()).toBe(false)
    const w = fx.db('Login Data', [])
    w.prepare('INSERT INTO logins VALUES (?)').run('https://a.test')
    w.close()
    expect(c.hasSavedCredentials()).toBe(true)
  })

  it('hasSavedCredentials is false when Login Data is absent (error path)', () => {
    expect(new ProfileClient(fx.root).hasSavedCredentials()).toBe(false)
  })

  it('[fs-170] reads profile data and degrades to empty', () => {
    // a fresh profile with none of the files present: the tolerant readers degrade, never throw
    const c = new ProfileClient(fx.root)
    expect(c.getPreference('anything')).toBeUndefined()
    expect(c.getExtensionIds()).toEqual([])
    expect(c.hasSavedCredentials()).toBe(false)
    expect(c.getOpenTabs()).toEqual([])
    // populate: limit-100 autofill, search engines, extensions, preferences
    const web = fx.db('Web Data', [
      'CREATE TABLE autofill (name TEXT, value TEXT, count INTEGER, date_last_used INTEGER)',
      'CREATE TABLE keywords (short_name TEXT, keyword TEXT, url TEXT)',
    ])
    const ins = web.prepare('INSERT INTO autofill VALUES (?,?,?,?)')
    for (let i = 0; i < 130; i++) ins.run(`n${i}`, 'v', 1, i)
    web.close()
    expect(c.getAutofillData()).toHaveLength(100)
    expect(c.getAutofillData()[0].name).toBe('n129') // newest first
    expect(c.getSearchEngines()).toEqual([])
    mkdirSync(join(fx.defaultDir, 'Extensions', 'ext1'), { recursive: true })
    expect(c.getExtensionIds()).toEqual(['ext1'])
    fx.json('Preferences', { a: { b: 1 } })
    expect(c.getPreference<number>('a.b')).toBe(1)
    // a missing database surfaces from the db-backed readers rather than returning silent garbage
    expect(() => c.getTopSites()).toThrow()
    expect(() => c.getFaviconData('https://a.test/')).toThrow()
  })

  it('[fs-171] getPreference resolves dot paths', () => {
    fx.json('Preferences', { a: { b: { c: 'deep' }, list: [1, 2] }, flat: 0 })
    const c = new ProfileClient(fx.root)
    expect(c.getPreference<string>('a.b.c')).toBe('deep')
    expect(c.getPreference<number>('flat')).toBe(0) // falsy values are returned
    expect(c.getPreference('a.b')).toEqual({ c: 'deep' })
    expect(c.getPreference('a.zzz.c')).toBeUndefined()
    fx.raw('Preferences', '{broken')
    expect(c.getPreference('a.b.c')).toBeUndefined()
  })

  it('[fs-172] counts saved credentials without reading them', () => {
    const d = fx.db('Login Data', ['CREATE TABLE logins (origin_url TEXT, password_value BLOB)'])
    d.prepare('INSERT INTO logins VALUES (?,?)').run('https://a.test', new Uint8Array([9, 9]))
    d.close()
    const c = new ProfileClient(fx.root)
    expect(c.hasSavedCredentials()).toBe(true)
    expect(typeof c.hasSavedCredentials()).toBe('boolean') // no credential material is exposed
    fx.raw('Login Data', 'corrupt, not sqlite')
    expect(c.hasSavedCredentials()).toBe(false) // failure means false
  })

  it('fixture timestamps helper round-trips (sanity)', () => {
    expect(chromeMicros(0)).toBe(11644473600 * 1_000_000)
  })
})
