/**
 * guards: a Cloudflare challenge is retried more than once, or an unrecoverable challenge is not reported as captcha
 * tier: S
 * cites: ticket 8468f7b1 [search-port-engine.3]
 * Cloudflare managed-challenge recovery: reveal the window, poll the provider's ban markers until they clear, retry the
 * search exactly once. An unrecoverable challenge is reported as captcha and no second retry is attempted.
 * Inventory row [I-12] (challenge recovery retries once).
 * Ticket 8468f7b1 · [search-port-engine.3]
 */
import { describe, expect, it } from 'vitest'
import { getProvider } from '../../../src/lib/providers.js'
import {
  CHALLENGE_POLL_MS,
  isChallengeCandidate,
  recoverFromChallenge,
  waitForChallengeClear,
  type ChallengeRecoveryInput,
} from '../../../src/lib/challenge.js'
import { runStrategies } from '../../../src/lib/network.js'
import type { SearchResponse } from '../../../src/lib/types.js'
import { body, FakePage, fixture, makeClock, makeDeps, recordingCapture } from '../../helpers/engine/harness.js'

const pypi = getProvider('pypi')
const challengeHtml = fixture('cf-challenge.html')
const clearHtml = fixture('pypi-results.html')

const hitlCaptcha: SearchResponse = {
  provider: 'pypi',
  query: 'requests',
  count: 0,
  results: [],
  outcome: 'hitl',
  error: 'Challenge detected: captcha — solve in browser to continue',
  tookMs: 10,
  attempts: 1,
  strategy: 'network',
  hitl: { pageUrl: 'https://pypi.org/search/?q=requests', reason: 'captcha', provider: 'pypi', query: 'requests', trippedAt: '2026-10-23T00:00:00.000Z', strategy: 'network' },
}
const success: SearchResponse = { ...hitlCaptcha, outcome: 'success', count: 1, results: [{ title: 'requests', url: 'https://pypi.org/project/requests/', snippet: 'HTTP' }], hitl: undefined, error: undefined }

/** A page whose document is the challenge for the first `challengePolls` reads and clear afterwards. */
const challengedPage = (challengePolls: number) => {
  let reads = 0
  return {
    reads: () => reads,
    closed: 0,
    close() {
      this.closed++
    },
    send: (async (method: string) => {
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
      if (method === 'DOM.getOuterHTML') return { outerHTML: reads++ < challengePolls ? challengeHtml : clearHtml }
      return {}
    }) as FakePage['send'],
  }
}

interface Harness {
  input: ChallengeRecoveryInput
  log: string[]
  retries: () => number
  page: ReturnType<typeof challengedPage>
}
const harness = (init: { response?: SearchResponse; budgetMs?: number; challengePolls?: number; retryResult?: SearchResponse; connectFails?: boolean; revealFails?: boolean }): Harness => {
  const log: string[] = []
  const page = challengedPage(init.challengePolls ?? 1)
  let retries = 0
  return {
    log,
    page,
    retries: () => retries,
    input: {
      response: init.response ?? hitlCaptcha,
      provider: pypi,
      budgetMs: init.budgetMs ?? 25000,
      reveal: async () => {
        log.push('reveal')
        if (init.revealFails) throw new TypeError('window gone')
      },
      connect: async () => {
        log.push('connect')
        if (init.connectFails) throw new TypeError('socket refused')
        return page
      },
      retry: async () => {
        log.push('retry')
        retries++
        return init.retryResult ?? success
      },
    },
  }
}

describe('challenge recovery retries once [search-port-engine.3]', () => {
  it('challenge recovery retries once: reveal, poll until the markers clear, then exactly one retry whose response is returned', async () => {
    const h = harness({ challengePolls: 2 })
    const clock = makeClock()
    const r = await recoverFromChallenge(h.input, makeDeps({ clock }))
    expect(h.log).toEqual(['reveal', 'connect', 'retry'])
    expect(h.page.reads()).toBe(3)
    expect(clock.sleeps).toEqual([CHALLENGE_POLL_MS, CHALLENGE_POLL_MS, CHALLENGE_POLL_MS])
    expect(h.retries()).toBe(1)
    expect(r).toMatchObject({ outcome: 'recovered', retried: true })
    expect(r.response).toBe(success)
    expect(h.page.closed).toBe(1)
  })

  it('unrecoverable challenge: markers that never clear within the budget give outcome captcha and the retry is never run', async () => {
    const h = harness({ challengePolls: Number.POSITIVE_INFINITY, budgetMs: 7000 })
    const clock = makeClock()
    const r = await recoverFromChallenge(h.input, makeDeps({ clock }))
    expect(r.outcome).toBe('captcha')
    expect(r.retried).toBe(false)
    expect(r.response).toBe(hitlCaptcha)
    expect(h.retries()).toBe(0)
    expect(h.log).toEqual(['reveal', 'connect'])
    expect(clock.sleeps).toHaveLength(4)
    expect(h.page.closed).toBe(1)
  })

  it('no second retry: when the retry still returns a captcha the outcome is captcha and the retry ran once, not twice', async () => {
    const stillBlocked: SearchResponse = { ...hitlCaptcha, tookMs: 99 }
    const h = harness({ challengePolls: 0, retryResult: stillBlocked })
    const r = await recoverFromChallenge(h.input, makeDeps({ clock: makeClock() }))
    expect(r.outcome).toBe('captcha')
    expect(r.retried).toBe(true)
    expect(r.response).toBe(stillBlocked)
    expect(h.retries()).toBe(1)
    expect(h.log.filter((x) => x === 'retry')).toHaveLength(1)
  })

  it('skipped: a disabled budget, a non-captcha hitl, a login interrupt, a dom strategy and a success never touch the page', async () => {
    const cases: Array<[string, Partial<Parameters<typeof harness>[0]>]> = [
      ['budget 0', { budgetMs: 0 }],
      ['login_required', { response: { ...hitlCaptcha, hitl: { ...(hitlCaptcha.hitl as NonNullable<SearchResponse['hitl']>), reason: 'login_required' } } }],
      ['dom strategy', { response: { ...hitlCaptcha, strategy: 'dom' } }],
      ['success', { response: success }],
    ]
    for (const [name, init] of cases) {
      const h = harness(init)
      const r = await recoverFromChallenge(h.input, makeDeps({ clock: makeClock() }))
      expect(r.outcome, name).toBe('skipped')
      expect(r.retried, name).toBe(false)
      expect(h.log, name).toEqual([])
      expect(isChallengeCandidate(init.response ?? hitlCaptcha), name).toBe(name === 'budget 0')
    }
  })

  it('a page that cannot be reached is an unrecovered challenge (captcha), never a throw; a failed reveal does not stop the recovery', async () => {
    const down = harness({ connectFails: true })
    const r1 = await recoverFromChallenge(down.input, makeDeps({ clock: makeClock() }))
    expect(r1.outcome).toBe('captcha')
    expect(down.retries()).toBe(0)

    const noWindow = harness({ revealFails: true, challengePolls: 0 })
    const r2 = await recoverFromChallenge(noWindow.input, makeDeps({ clock: makeClock() }))
    expect(r2.outcome).toBe('recovered')
    expect(noWindow.retries()).toBe(1)
  })
})

describe('waitForChallengeClear polls the provider ban markers [search-port-engine.3]', () => {
  it('returns true as soon as a read is free of the provider challenge markers', async () => {
    const page = challengedPage(1)
    const clock = makeClock()
    expect(await waitForChallengeClear(page, pypi, 25000, makeDeps({ clock }))).toBe(true)
    expect(clock.sleeps).toEqual([2000, 2000])
  })

  it('returns false when the budget elapses first', async () => {
    const page = challengedPage(Number.POSITIVE_INFINITY)
    expect(await waitForChallengeClear(page, pypi, 5000, makeDeps({ clock: makeClock() }))).toBe(false)
    expect(page.reads()).toBe(3)
  })

  it('never throws: a read that fails mid-navigation is retried', async () => {
    let n = 0
    const page = {
      send: (async (method: string) => {
        if (method === 'DOM.getDocument') {
          if (n++ === 0) throw new TypeError('Cannot find context with specified id')
          return { root: { nodeId: 1 } }
        }
        return { outerHTML: clearHtml }
      }) as FakePage['send'],
    }
    expect(await waitForChallengeClear(page, pypi, 25000, makeDeps({ clock: makeClock() }))).toBe(true)
  })

  it('the provider decides what cleared means: only its body rules are consulted, never its url rules', async () => {
    const urlOnly = { bans: [{ name: 'u', signal: 'captcha' as const, checkUrl: /./ }] }
    expect(await waitForChallengeClear(challengedPage(0), urlOnly, 5000, makeDeps({ clock: makeClock() }))).toBe(true)
  })
})

describe('the engine runs the recovery once on the captured page [search-port-engine.3]', () => {
  const pageRef = (revealed: string[]) => ({ pageWsUrl: 'ws://page', reveal: async () => void revealed.push('reveal') })

  it('recovery then one retry: a Cloudflare challenge on pypi clears once the window is revealed and the search is retried once', async () => {
    const revealed: string[] = []
    const rec = recordingCapture(async (_c, n) => (n === 0 ? body(challengeHtml) : body(clearHtml)))
    const clean = new FakePage({ html: clearHtml })
    const r = await runStrategies(pageRef(revealed), pypi, 'requests', {}, makeDeps({ capture: rec.capture, clock: makeClock(), connect: async () => clean }))
    expect(revealed).toEqual(['reveal'])
    expect(rec.calls).toHaveLength(2)
    expect(r.outcome).toBe('success')
    expect(r.count).toBe(2)
    expect(clean.closed).toBe(1)
  })

  it('unrecoverable challenge: markers that never clear return hitl captcha for the human gate with one capture and no retry', async () => {
    const revealed: string[] = []
    const rec = recordingCapture(async () => body(challengeHtml))
    const stuck = new FakePage({ html: challengeHtml })
    const r = await runStrategies(pageRef(revealed), pypi, 'requests', { challengeWaitMs: 6000 }, makeDeps({ capture: rec.capture, clock: makeClock(), connect: async () => stuck }))
    expect(r.outcome).toBe('hitl')
    expect(r.hitl?.reason).toBe('captcha')
    expect(rec.calls).toHaveLength(1)
    expect(revealed).toEqual(['reveal'])
  })

  it('no second retry: a challenge that survives the retry returns hitl captcha after exactly two captures', async () => {
    const revealed: string[] = []
    const rec = recordingCapture(async () => body(challengeHtml))
    const clean = new FakePage({ html: clearHtml })
    const r = await runStrategies(pageRef(revealed), pypi, 'requests', {}, makeDeps({ capture: rec.capture, clock: makeClock(), connect: async () => clean }))
    expect(r.outcome).toBe('hitl')
    expect(r.hitl?.reason).toBe('captcha')
    expect(rec.calls).toHaveLength(2)
    expect(revealed).toEqual(['reveal'])
  })

  it('challengeWaitMs 0 disables the recovery: the captcha goes straight to the caller, no reveal, no retry', async () => {
    const revealed: string[] = []
    const rec = recordingCapture(async () => body(challengeHtml))
    const r = await runStrategies(pageRef(revealed), pypi, 'requests', { challengeWaitMs: 0 }, makeDeps({ capture: rec.capture, clock: makeClock() }))
    expect(r.outcome).toBe('hitl')
    expect(rec.calls).toHaveLength(1)
    expect(revealed).toEqual([])
  })
})
