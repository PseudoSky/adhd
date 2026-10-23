/**
 * Unit spec for src/lib/storage/bookmarks.ts (BookmarkClient).
 * Ticket 8468f7b1 AC2 · criteria [tests-unit-data.1] [tests-unit-data.2] [tests-unit-data.3] [tests-unit-data.4].
 * Bookmarks JSON fixture written under the OS temp dir; no real profile.
 * guards: getBookmarks returns only the known roots, in order
 * tier: S
 * cites: 8468f7b1 [tests-unit-data.1] [tests-unit-data.2] [tests-unit-data.3] [tests-unit-data.4]
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BookmarkClient } from '../../../src/lib/storage/bookmarks.js'
import { makeProfile, type Fixture } from '../../helpers/domains-storage/profile-fixture.js'

const tree = {
  roots: {
    bookmark_bar: {
      id: '1', name: 'Bar', type: 'folder', date_added: '13000000000000000',
      children: [
        { id: '2', name: 'Alpha Docs', type: 'url', url: 'https://alpha.test/docs' },
        { id: '3', name: 'Sub', type: 'folder', children: [{ id: '4', name: 'Beta', type: 'url', url: 'https://beta.test' }] },
      ],
    },
    other: { id: '5', name: 'Other', type: 'folder', children: [] },
    ignored_root: { id: '9', name: 'Nope', type: 'folder' },
  },
}

describe('8468f7b1 AC2 [tests-unit-data.1] BookmarkClient', () => {
  let fx: Fixture
  beforeEach(() => { fx = makeProfile(); fx.json('Bookmarks', tree) })
  afterEach(() => fx.cleanup())

  it('getBookmarks returns only the known roots, in order', () => {
    const nodes = new BookmarkClient(fx.root).getBookmarks()
    expect(nodes.map((n) => n.name)).toEqual(['Bar', 'Other'])
  })

  it('parses folders, urls and nested children', () => {
    const [bar] = new BookmarkClient(fx.root).getBookmarks()
    expect(bar.type).toBe('folder')
    expect(bar.children?.[0]).toMatchObject({ id: '2', type: 'url', url: 'https://alpha.test/docs' })
    expect(bar.children?.[1].children?.[0].name).toBe('Beta')
  })

  it('converts date_added from Chrome microseconds to a Date', () => {
    const [bar] = new BookmarkClient(fx.root).getBookmarks()
    expect(bar.dateAdded).toEqual(new Date(13_000_000_000_000))
    expect(bar.dateModified).toBeUndefined()
  })

  it('searchBookmarks matches name or url case-insensitively and reports the parent path', () => {
    const c = new BookmarkClient(fx.root)
    expect(c.searchBookmarks('ALPHA')).toEqual([{ name: 'Alpha Docs', url: 'https://alpha.test/docs', path: 'Bar' }])
    expect(c.searchBookmarks('beta.test')).toEqual([{ name: 'Beta', url: 'https://beta.test', path: 'Bar > Sub' }])
  })

  it('searchBookmarks returns [] for an empty query or no match', () => {
    const c = new BookmarkClient(fx.root)
    expect(c.searchBookmarks('')).toEqual([])
    expect(c.searchBookmarks('zzz-no-match')).toEqual([])
  })

  it('[fs-173] parses bookmark roots', () => {
    fx.json('Bookmarks', {
      roots: {
        bookmark_bar: { id: '1', name: 'Bar', type: 'folder', date_added: '13000000000000000', date_modified: '13000000001000000', children: [
          { id: '2', name: 'Link', type: 'url', url: 'https://l.test' },
        ] },
        other: { id: '3', name: 'Other', type: 'folder', children: [] },
        synced: { id: '4', name: 'Mobile', type: 'folder', children: [] },
        managed: { id: '5', name: 'Managed', type: 'folder', children: [] },
        sync_transaction_version: '7',
      },
    })
    const nodes = new BookmarkClient(fx.root).getBookmarks()
    expect(nodes.map((n) => n.name)).toEqual(['Bar', 'Other', 'Mobile', 'Managed'])
    expect(nodes[0].type).toBe('folder')
    expect(nodes[0].children?.[0]).toMatchObject({ type: 'url', url: 'https://l.test' })
    expect(nodes[0].dateModified).toEqual(new Date(13_000_000_001_000))
    fx.raw('Bookmarks', 'not json')
    expect(new BookmarkClient(fx.root).getBookmarks()).toEqual([])
  })

  it('[fs-174] searches bookmarks with folder paths', () => {
    const c = new BookmarkClient(fx.root)
    expect(c.searchBookmarks('bEtA')).toEqual([{ name: 'Beta', url: 'https://beta.test', path: 'Bar > Sub' }])
    expect(c.searchBookmarks('ALPHA.TEST/DOCS')).toEqual([{ name: 'Alpha Docs', url: 'https://alpha.test/docs', path: 'Bar' }])
    expect(c.searchBookmarks('Sub')).toEqual([]) // folders themselves are not results
    expect(c.searchBookmarks('')).toEqual([])
  })

  it('returns [] when the Bookmarks file is missing (error path)', () => {
    const empty = makeProfile()
    try { expect(new BookmarkClient(empty.root).getBookmarks()).toEqual([]) } finally { empty.cleanup() }
  })

  it('returns [] when the Bookmarks file is corrupt JSON (error path)', () => {
    fx.raw('Bookmarks', '{not json')
    expect(new BookmarkClient(fx.root).getBookmarks()).toEqual([])
    expect(new BookmarkClient(fx.root).searchBookmarks('alpha')).toEqual([])
  })
})
