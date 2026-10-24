/**
 * guards: a closed stdin ends a search in silence, or a login wall or captcha exits 0 with empty stdout
 * tier: S
 * plan: resolve-findings
 * teeth: red: nx run stealth-search:test --skip-nx-cache -- test/unit/hosts/hitl.spec.ts -> exit 1 (1 failed) with tookMs and strategy removed from hitlAbortDocument; the whole-SearchOutput assertion of the closed-stdin case fails.
 * cites: ticket 8468f7b1 [resolve-findings.4] [search-hosts.22] [search-hosts.19] [search-hosts.16]
 * A closed stdin never ends a search in silence: the real CLI runner, the real prompter and the
 * real search service over a scripted engine and a memory file system. Ticket 8468f7b1 · plan state
 * search-hosts.
 *
 * Criteria: [search-hosts.22] [search-hosts.19] [search-hosts.16] · backlog 591e1a7 (a login wall or
 * a captcha on a closed stdin is reported, never a silent exit 0 with empty stdout) · inventory row
 * I-38 (stdin close rejects and the CLI exits 2 with a JSON hitl line).
 * Fixtures are synthetic: no Chrome, no socket, no spawned process.
 */
import { describe, expect, it } from 'vitest'
import * as api from '../../../src/api.js'
import { runCli } from '../../../src/cli.js'
import { exitCodeFor } from '../../../src/errors.js'
import type { Verbs } from '../../../src/server.js'
import { hitlResponse, makeFakeCore, makeWorld, response, scriptedEngine } from '../../helpers/verbs/harness.js'
import { BUILD_TIMEOUT_MS, FakeStdin, cliHarness, packageFor, trippedWorld, wire } from '../../helpers/hosts/host-harness.js'

describe('closed stdin on the tripwire gate prompt [search-hosts.22]', () => {
  it(
    '591e1a7 closed stdin: I-38 a tripped provider and a closed stdin give ONE hitl JSON line with attempts 0, exit 2 and the lock still set (HITL_ABORTED at the gate)',
    async () => {
      const world = await trippedWorld()
      const openedBefore = world.core.opened.length
      const engine = scriptedEngine(response())
      const h = cliHarness(api as unknown as Verbs, {
        build: () => packageFor(api as unknown as Verbs),
        configure: wire(world, engine.strategies),
        stdin: new FakeStdin({ isTTY: true, ended: true }),
      })
      const code = await runCli(['search', 'github', 'vite'], h.deps)
      expect(code).toBe(2)
      expect(code).toBe(exitCodeFor('HITL_ABORTED'))
      expect(h.stdout).toHaveLength(1)
      const doc = JSON.parse(h.stdout[0] as string) as Record<string, unknown>
      expect(doc).toMatchObject({ outcome: 'hitl', attempts: 0, provider: 'github', query: 'vite' })
      expect(doc['hitl']).toMatchObject({ reason: 'captcha', provider: 'github', query: 'vite' })
      expect((doc['hitl'] as Record<string, unknown>)['pageUrl']).toEqual(expect.any(String))
      // F88: the document is a whole SearchOutput / SearchHitl, not a partial one.
      expect(doc).toMatchObject({ tookMs: 0, strategy: expect.stringMatching(/^(network|dom|fetch)$/) })
      const hitl = doc['hitl'] as Record<string, unknown>
      expect(Number.isNaN(Date.parse(String(hitl['trippedAt'])))).toBe(false)
      expect(hitl['strategy']).toBe(doc['strategy'])
      expect(h.stderr).toEqual([])
      expect(engine.calls).toHaveLength(0)
      expect(world.core.opened).toHaveLength(openedBefore)
      expect(Object.keys(await world.svc.tripwireStatus())).toEqual(['github'])
      expect(h.events[h.events.length - 1]).toBe('exit(2)')
    },
    BUILD_TIMEOUT_MS
  )

  it(
    '591e1a7 closed stdin: a stdin that is not a TTY at all is the same abort, never a hang and never exit 0',
    async () => {
      const world = await trippedWorld()
      const h = cliHarness(api as unknown as Verbs, {
        build: () => packageFor(api as unknown as Verbs),
        configure: wire(world, scriptedEngine(response()).strategies),
        stdin: new FakeStdin({ isTTY: false }),
      })
      expect(await runCli(['search', 'github', 'vite'], h.deps)).toBe(2)
      expect(JSON.parse(h.stdout[0] as string)).toMatchObject({ outcome: 'hitl', attempts: 0 })
    },
    BUILD_TIMEOUT_MS
  )
})

describe('closed stdin on the solved confirmation [search-hosts.22]', () => {
  it(
    '591e1a7 confirmSolved: I-38 a captcha with a closed stdin rejects the confirmation (HITL_ABORTED), the verb takes its abort path, the hitl response is on stdout and the CLI exits 2',
    async () => {
      const world = makeWorld({ core: makeFakeCore() })
      const engine = scriptedEngine(hitlResponse('captcha'))
      const h = cliHarness(api as unknown as Verbs, {
        build: () => packageFor(api as unknown as Verbs),
        configure: wire(world, engine.strategies),
        stdin: new FakeStdin({ isTTY: true, ended: true }),
      })
      const code = await runCli(['search', 'github', 'vite'], h.deps)
      expect(code).toBe(2)
      expect(h.stdout).toHaveLength(1)
      const doc = JSON.parse(h.stdout[0] as string) as Record<string, unknown>
      expect(doc).toMatchObject({ outcome: 'hitl', provider: 'github', query: 'vite' })
      expect(doc['attempts']).toBe(1)
      expect(doc['hitl']).toMatchObject({ reason: 'captcha', provider: 'github' })
      expect(engine.calls).toHaveLength(1)
      // The human never answered: the lock the challenge set stays.
      expect(Object.keys(await world.svc.tripwireStatus())).toEqual(['github'])
      expect(h.events[h.events.length - 1]).toBe('exit(2)')
    },
    BUILD_TIMEOUT_MS
  )

  it(
    '591e1a7 hitl: no path ends in exit 0 with empty stdout; an ordinary success is still exit 0 with one document',
    async () => {
      const world = makeWorld({ core: makeFakeCore() })
      const ok = cliHarness(api as unknown as Verbs, {
        build: () => packageFor(api as unknown as Verbs),
        configure: wire(world, scriptedEngine(response()).strategies),
        stdin: new FakeStdin({ isTTY: true, ended: true }),
      })
      expect(await runCli(['search', 'github', 'vite'], ok.deps)).toBe(0)
      expect(JSON.parse(ok.stdout[0] as string)).toMatchObject({ outcome: 'success', count: 1 })
      const fail = cliHarness(api as unknown as Verbs, {
        build: () => packageFor(api as unknown as Verbs),
        configure: wire(world, scriptedEngine(hitlResponse('banned')).strategies),
        stdin: new FakeStdin({ isTTY: true, ended: true }),
      })
      const code = await runCli(['search', 'github', 'vite'], fail.deps)
      expect(code === 0 && fail.stdout.length === 0).toBe(false)
      expect(code).toBe(2)
    },
    BUILD_TIMEOUT_MS
  )
})
