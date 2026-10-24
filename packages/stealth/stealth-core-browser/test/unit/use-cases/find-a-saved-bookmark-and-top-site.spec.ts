/**
 * Ticket 8468f7b1 · criteria [tests-use-cases.1] [tests-use-cases.2] [tests-use-cases.3]
 * Exercises AC2 (read-only profile access) for the Bookmarks JSON file and the Top Sites database.
 *
 * Someone looking for "that wiki page I saved" searches the bookmark tree of their profile, sees which
 * folder it sits in, and checks their most visited sites, all read-only.
 * guards: [tests-use-cases.3] reads the bookmark roots Chrome wrote
 * tier: S
 * cites: 8468f7b1 [tests-use-cases.1] [tests-use-cases.2] [tests-use-cases.3]
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { storage } from '../../../src/index.js'
import { BOOKMARK_TREE, ProfileBuilder, type BuiltProfile } from '../../helpers/profile-fixtures.js'

let profile: BuiltProfile
beforeEach(() => { profile = ProfileBuilder.realistic().build() })
afterEach(() => profile.cleanup())

describe('Scenario: find a saved bookmark and the most visited sites in my profile', () => {
  it('[tests-use-cases.3] reads the bookmark roots Chrome wrote', () => {
    const roots = new storage.BookmarkClient(profile.root).getBookmarks()
    expect(roots.map((r) => r.name)).toEqual(['Bookmarks bar', 'Other bookmarks', 'Mobile bookmarks'])
    expect(Object.keys(BOOKMARK_TREE.roots)).toContain('bookmark_bar')
  })

  it('[tests-use-cases.2] finds a bookmark by name or address with its folder path', () => {
    const marks = new storage.BookmarkClient(profile.root)
    expect(marks.searchBookmarks('wiki')).toEqual([{ name: 'Team wiki', url: 'https://wiki.test/team', path: 'Bookmarks bar > Work' }])
    expect(marks.searchBookmarks('docs.test/api')).toEqual([{ name: 'API reference', url: 'https://docs.test/api', path: 'Bookmarks bar' }])
    expect(marks.searchBookmarks('')).toEqual([])
    expect(marks.searchBookmarks('absent')).toEqual([])
  })

  it('[tests-use-cases.2] lists the top sites ranked by Chrome', () => {
    expect(new storage.ProfileClient(profile.root).getTopSites()).toEqual([{ url: 'https://docs.test/', title: 'Docs', score: 9 }])
  })

  it('[tests-use-cases.2] a profile without a Bookmarks file simply has none', () => {
    const bare = new ProfileBuilder().history([{ url: 'https://x.test/', title: 'x', secondsAgo: 5 }]).build()
    try {
      expect(new storage.BookmarkClient(bare.root).getBookmarks()).toEqual([])
    } finally {
      bare.cleanup()
    }
  })
})
