import * as fs from 'node:fs'
import * as path from 'node:path'

export interface PackageMeta {
  id: string
  dir: string
  importPath: string
  tags: string[]
}

/** Discover packages in a directory, filtered by tag. Reads package.json for tags/keywords. */
export function discoverPackages(opts: {
  packagesDir: string
  includeTags?: string[]
  excludeTags?: string[]
}): PackageMeta[] {
  const { packagesDir, includeTags = [], excludeTags = [] } = opts
  const entries = fs.readdirSync(packagesDir, { withFileTypes: true })
    .filter(e => e.isDirectory())

  const results: PackageMeta[] = []
  for (const entry of entries) {
    const pkgPath = path.join(packagesDir, entry.name, 'package.json')
    if (!fs.existsSync(pkgPath)) continue

    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      name?: string
      tags?: string[]
      keywords?: string[]
    }
    const tags: string[] = pkg.tags ?? pkg.keywords ?? []

    if (includeTags.length && !includeTags.every(t => tags.includes(t))) continue
    if (excludeTags.some(t => tags.includes(t))) continue

    results.push({
      id: entry.name,
      dir: path.join(packagesDir, entry.name),
      importPath: pkg.name ?? entry.name,
      tags,
    })
  }

  return results.sort((a, b) => a.id.localeCompare(b.id))
}
