/**
 * Unit spec for AGENTS.md: every file or directory the package notes name exists in the package.
 * Ticket 8468f7b1 · criterion [audit-fixes.5] · audit finding P33 (AGENTS.md listed an e2e target and a vitest.e2e.config.ts that do not exist).
 * Reads the package files only: no process, no network.
 * guards: AGENTS.md names a config, directory or entry point that the package does not contain
 * tier: S
 * cites: 8468f7b1 [audit-fixes.5]
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8')

/** Backticked tokens that look like a package-relative path or a vitest config. */
function pathTokens(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/`([^`\s]+)`/g)) {
    const t = m[1] ?? ''
    if (/^vitest\.[\w.-]+\.config\.ts$/.test(t) || /^(src|test|bin|docs|examples)\/[\w./*-]*$/.test(t)) out.add(t)
  }
  return [...out]
}

describe('8468f7b1 [audit-fixes.5] P33 AGENTS.md names only what the package contains', () => {
  it('finds the paths it asserts on (the check is not vacuous)', () => {
    expect(pathTokens(agents).length).toBeGreaterThan(2)
  })

  it.each(pathTokens(agents).filter((t) => !t.includes('*')))('%s exists', (token) => {
    expect(existsSync(join(root, token))).toBe(true)
  })

  it('does not advertise an e2e lane or a vitest.e2e.config.ts', () => {
    expect(existsSync(join(root, 'vitest.e2e.config.ts'))).toBe(false)
    expect(agents).not.toMatch(/vitest\.e2e\.config\.ts/)
    expect(agents).not.toMatch(/`e2e`/)
  })

  it('names a bin/ entry exactly when the package has a bin/ directory', () => {
    // AGENTS.md is checked against the filesystem, not the other way round: the package gaining a bin/ directory
    // must be documented, and a documented bin/ must exist.
    expect(/`bin\//.test(agents)).toBe(existsSync(join(root, 'bin')))
  })
})
