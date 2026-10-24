/**
 * guards: a prompt hangs on a closed or non-interactive stdin, or the tripwire gate and HITL prompt misread input
 * tier: S
 * cites: ticket 8468f7b1 [search-hosts.19] [search-hosts.16]
 * The CLI's `InteractionPort` (`createTtyPrompter`) over fake stdin streams and fake timers.
 * Ticket 8468f7b1 · plan state search-hosts.
 *
 * Criteria: [search-hosts.19] [search-hosts.16] · backlog 657bd597 (a prompt never hangs on a
 * closed or non-interactive stdin) · inventory row I-38 (interactive tripwire gate and HITL prompt;
 * stdin close rejects).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROMPT_ABORT_BUDGET_MS, createTtyPrompter } from '../../../src/cli.js'
import { StealthSearchError, exitCodeFor } from '../../../src/errors.js'
import type { GatePromptInfo, SolvedPromptInfo } from '../../../src/lib/config.js'
import { FakeStdin } from '../../helpers/hosts/host-harness.js'

const GATE: GatePromptInfo = { provider: 'github', reason: 'captcha', trippedAt: '2026-10-21T10:00:00.000Z', blockedCount: 2, pageUrl: 'https://github.com/login?return_to=x' }
const SOLVED: SolvedPromptInfo = { provider: 'github', reason: 'captcha', query: 'vite', strategy: 'network', pageUrl: 'https://github.com/search?q=vite' }

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

type Settled = { state: 'pending' | 'resolved' | 'rejected'; value?: unknown; error?: unknown }

function track<T>(p: Promise<T>): Settled {
  const s: Settled = { state: 'pending' }
  p.then(
    (v) => {
      s.state = 'resolved'
      s.value = v
    },
    (e: unknown) => {
      s.state = 'rejected'
      s.error = e
    }
  )
  return s
}

/** Let promise reactions run without moving any fake timer. */
async function microtasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('prompter: a non-interactive or closed stdin never hangs [search-hosts.19]', () => {
  it('657bd597 isTTY: a stdin that is not a TTY rejects the gate prompt with HITL_ABORTED at once, before any 1000 ms timer could fire', async () => {
    const asked: string[] = []
    const stdin = new FakeStdin({ isTTY: false })
    const prompter = createTtyPrompter({ stdin, ask: (t) => void asked.push(t) })
    const s = track(prompter.promptTripwireGate(GATE))
    await microtasks()
    expect(s.state).toBe('rejected')
    expect(s.error).toBeInstanceOf(StealthSearchError)
    expect((s.error as StealthSearchError).code).toBe('HITL_ABORTED')
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(PROMPT_ABORT_BUDGET_MS)
    expect(PROMPT_ABORT_BUDGET_MS).toBe(1000)
    expect(asked).toEqual([])
    expect(stdin.count('data')).toBe(0)
  })

  it('657bd597 isTTY: an undefined isTTY (a pipe, /dev/null, a closed descriptor) is not interactive for confirmSolved either', async () => {
    const stdin = new FakeStdin({})
    const prompter = createTtyPrompter({ stdin, ask: () => undefined })
    const s = track(prompter.confirmSolved(SOLVED))
    await microtasks()
    expect(s.state).toBe('rejected')
    expect((s.error as StealthSearchError).code).toBe('HITL_ABORTED')
    expect((s.error as StealthSearchError).detail).toMatchObject({ provider: 'github', reason: 'captcha', pageUrl: SOLVED.pageUrl })
  })

  it('657bd597 closed stdin: I-38 a TTY whose stream has already ended rejects the gate prompt and confirmSolved with HITL_ABORTED within 1000 ms', async () => {
    const stdin = new FakeStdin({ isTTY: true, ended: true })
    const prompter = createTtyPrompter({ stdin, ask: () => undefined })
    const gate = track(prompter.promptTripwireGate(GATE))
    const solved = track(prompter.confirmSolved(SOLVED))
    await vi.advanceTimersByTimeAsync(PROMPT_ABORT_BUDGET_MS - 1)
    expect(gate.state).toBe('rejected')
    expect(solved.state).toBe('rejected')
    expect((gate.error as StealthSearchError).code).toBe('HITL_ABORTED')
    expect((solved.error as StealthSearchError).code).toBe('HITL_ABORTED')
    expect(stdin.destroyed).toBe(false)
  })

  it('657bd597 closed stdin: a destroyed stream rejects as well, without reading from it', async () => {
    const stdin = new FakeStdin({ isTTY: true })
    stdin.destroyed = true
    const prompter = createTtyPrompter({ stdin, ask: () => undefined })
    const s = track(prompter.promptTripwireGate(GATE))
    await microtasks()
    expect(s.state).toBe('rejected')
    expect(stdin.count('data')).toBe(0)
  })

  it('657bd597 closed stdin: I-38 stdin that ends while the question is open rejects with HITL_ABORTED and removes every listener', async () => {
    const asked: string[] = []
    const stdin = new FakeStdin({ isTTY: true })
    const prompter = createTtyPrompter({ stdin, ask: (t) => void asked.push(t) })
    const s = track(prompter.confirmSolved(SOLVED))
    await microtasks()
    expect(s.state).toBe('pending')
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('github')
    stdin.close()
    await vi.advanceTimersByTimeAsync(PROMPT_ABORT_BUDGET_MS - 1)
    expect(s.state).toBe('rejected')
    expect((s.error as StealthSearchError).code).toBe('HITL_ABORTED')
    for (const ev of ['data', 'end', 'close', 'error']) expect(stdin.count(ev), ev).toBe(0)
    expect(stdin.paused).toBeGreaterThan(0)
  })

  it('657bd597 HITL_ABORTED maps to a stable non-zero exit status from exitCodeFor (2) and adds no new code', () => {
    expect(exitCodeFor('HITL_ABORTED')).toBe(2)
    expect(exitCodeFor('HITL_ABORTED')).toBe(exitCodeFor('HITL_ABORTED'))
  })
})

describe('prompter: a person at a terminal answers by line [search-hosts.19]', () => {
  it('657bd597 isTTY: on a TTY the gate prompt asks on the ask sink (never stdout) and maps r, c and anything else to retry, clear and abort', async () => {
    for (const [line, expected] of [['r\n', 'retry'], ['clear\n', 'clear'], ['a\n', 'abort'], ['\n', 'abort'], ['whatever\n', 'abort']] as const) {
      const asked: string[] = []
      const stdin = new FakeStdin({ isTTY: true })
      const p = createTtyPrompter({ stdin, ask: (t) => void asked.push(t) }).promptTripwireGate(GATE)
      await microtasks()
      stdin.emit('data', line)
      expect(await p, line).toBe(expected)
      expect(asked[0]).toContain('[r]etry')
      expect(asked[0]).toContain(GATE.pageUrl)
      expect(stdin.count('data')).toBe(0)
    }
  })

  it('657bd597 isTTY: a line that arrives in chunks is assembled, and confirmSolved answers solved on Enter and abort on a', async () => {
    const stdin = new FakeStdin({ isTTY: true })
    const prompter = createTtyPrompter({ stdin, ask: () => undefined })
    const solved = prompter.confirmSolved(SOLVED)
    await microtasks()
    stdin.emit('data', '')
    stdin.emit('data', '\n')
    expect(await solved).toBe('solved')
    const abort = prompter.confirmSolved(SOLVED)
    await microtasks()
    stdin.emit('data', 'ab')
    stdin.emit('data', 'ort\n')
    expect(await abort).toBe('abort')
  })
})
