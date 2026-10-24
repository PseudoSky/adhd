import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromeProfileDir } from '../helpers.js'
import type { BookmarkNode } from '../types.js'

/** Shape of a node in Chrome's on-disk `Bookmarks` JSON (all fields optional on disk). */
interface RawBookmarkNode {
  id?: string | number
  name?: string
  type?: string
  url?: string
  date_added?: string | number
  date_modified?: string | number
  children?: RawBookmarkNode[]
}

export class BookmarkClient {
  private readonly defaultDir: string

  constructor(profileDir?: string) {
    this.defaultDir = join(profileDir ?? chromeProfileDir(), 'Default')
  }

  private _bookmarksPath(): string { return join(this.defaultDir, 'Bookmarks') }

  getBookmarks(): BookmarkNode[] {
    try {
      const raw = readFileSync(this._bookmarksPath(), 'utf8')
      const data = JSON.parse(raw)
      const roots = (data.roots ?? {}) as Record<string, RawBookmarkNode | undefined>
      const nodes: BookmarkNode[] = []
      for (const key of ['bookmark_bar', 'other', 'synced', 'managed'] as const) {
        if (roots[key]) nodes.push(this._parseBookmarkNode(roots[key]))
      }
      return nodes
    } catch { return [] }
  }

  private _parseBookmarkNode(raw: RawBookmarkNode): BookmarkNode {
    const node: BookmarkNode = {
      id: String(raw.id ?? ''),
      name: String(raw.name ?? ''),
      type: raw.type === 'url' || raw.url ? 'url' : 'folder',
      dateAdded: raw.date_added ? new Date(Math.floor(Number(raw.date_added) / 1000)) : undefined,
      dateModified: raw.date_modified ? new Date(Math.floor(Number(raw.date_modified) / 1000)) : undefined,
    }
    if (raw.type === 'url' || raw.url) node.url = String(raw.url ?? '')
    if (raw.children && Array.isArray(raw.children)) {
      node.children = raw.children.map((c) => this._parseBookmarkNode(c))
    }
    return node
  }

  searchBookmarks(query: string): Array<{ name: string; url: string; path: string }> {
    if (!query) return []
    const q = query.toLowerCase()
    const results: Array<{ name: string; url: string; path: string }> = []

    const walk = (nodes: BookmarkNode[], parentPath: string) => {
      for (const node of nodes) {
        const currentPath = parentPath ? `${parentPath} > ${node.name}` : node.name
        if (node.type === 'url' && node.url) {
          if (node.name.toLowerCase().includes(q) || node.url.toLowerCase().includes(q)) {
            results.push({ name: node.name, url: node.url, path: parentPath })
          }
        }
        if (node.children) {
          walk(node.children, currentPath)
        }
      }
    }

    const roots = this.getBookmarks()
    walk(roots, '')
    return results
  }
}
