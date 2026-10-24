/**
 * guards: -h or --help typed as the VALUE of an operation flag is read as a help request and the operation never runs
 * tier: S
 * cites: ticket 8468f7b1 [search-hosts.16] [resolve-findings.4] (F48)
 * plan: resolve-findings
 * teeth: red: nx run stealth-search:test --skip-nx-cache -- test/unit/hosts/help-as-value.spec.ts -> exit 1 (2 failed | 1 passed) with parseHostFlags counting every -h or --help token as help.
 * Real use: an agent searches for the text "-h" (`search --provider npm --query -h`); a person asks for help on one operation.
 */
import { describe, expect, it, vi } from 'vitest'
import { runCli } from '../../../src/cli.js'
import { parseHostFlags } from '../../../src/host-flags.js'
import { BUILD_TIMEOUT_MS, cliHarness, fakeVerbs } from '../../helpers/hosts/host-harness.js'

describe('8468f7b1 [resolve-findings.4] a help token that is a flag value is not a help request', () => {
  it('parseHostFlags: -h after a value flag is rest, not help; -h elsewhere and after `--` as expected', () => {
    const valueFlags = new Set(['--query'])
    expect(parseHostFlags(['search', '--query', '-h'], 'cli', { valueFlags })).toMatchObject({ help: false, operation: 'search', rest: ['--query', '-h'] })
    expect(parseHostFlags(['search', '-h'], 'cli', { valueFlags })).toMatchObject({ help: true, operation: 'search', rest: [] })
    expect(parseHostFlags(['search', '--query', 'x', '--', '--help'], 'cli', { valueFlags }).help).toBe(false)
    expect(parseHostFlags(['search', '--query', '--help'], 'cli').help).toBe(true) // without the shape the old reading stands
  })

  it(
    'runCli: `search --provider npm --query -h` runs the search with the query "-h"',
    async () => {
      const search = vi.fn(async () => ({ provider: 'npm', query: '-h', count: 0, results: [], outcome: 'empty', tookMs: 1, attempts: 1, strategy: 'network' }))
      const h = cliHarness(fakeVerbs(vi.fn, { search: search as never }))
      const code = await runCli(['search', '--provider', 'npm', '--query', '-h'], h.deps)
      expect(code).toBe(0)
      expect(search).toHaveBeenCalledTimes(1)
      expect(search.mock.calls[0]).toEqual([{ provider: 'npm', query: '-h' }])
    },
    BUILD_TIMEOUT_MS
  )

  it(
    'runCli: `search -h` still prints the help of the operation and runs nothing',
    async () => {
      const search = vi.fn(async () => ({}))
      const h = cliHarness(fakeVerbs(vi.fn, { search: search as never }))
      expect(await runCli(['search', '-h'], h.deps)).toBe(0)
      expect(search).not.toHaveBeenCalled()
      expect(h.stdout[0]).toContain('--max-content-size <number>')
    },
    BUILD_TIMEOUT_MS
  )
})
