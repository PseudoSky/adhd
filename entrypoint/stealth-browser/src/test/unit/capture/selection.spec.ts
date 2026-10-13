/**
 * Choosing the answer among the captured responses.
 * Ticket 8468f7b1 AC capture-upgrade.9 · [capture-upgrade.9]
 * Real use: a page fires several matching requests; the agent usually wants the
 * document (largest body) but may pass its own `select`, or take every response.
 */
import { describe, expect, it } from 'vitest'
import { captureAllNetworkResponses, captureNetworkResponse } from '../../../lib/capture/network.js'
import { fixtureWith, optionsFor, useFixture, WS_URL } from './capture-kit.js'

/** two-tabs-parallel with distinct bodies per request. */
const distinctBodies = () =>
  fixtureWith('two-tabs-parallel', (f) => {
    const generic = f.steps.findIndex((s) => s.when.method === 'Network.getResponseBody')
    f.steps.splice(
      generic,
      1,
      { when: { method: 'Network.getResponseBody', params: { requestId: 'A1' } }, reply: { result: { body: 'tiny', base64Encoded: false } } },
      { when: { method: 'Network.getResponseBody', params: { requestId: 'B1' } }, reply: { result: { body: 'a considerably larger document body', base64Encoded: false } } },
    )
  })

describe('8468f7b1 [capture-upgrade.9] default selection and custom select', () => {
  useFixture(distinctBodies)

  it('the default picks the largest body', async () => {
    const out = await captureNetworkResponse(WS_URL, optionsFor('two-tabs-parallel'))
    expect(out.requestId).toBe('B1')
    expect(out.body).toBe('a considerably larger document body')
  })

  it('a custom select is honoured and receives every candidate in landing order', async () => {
    let seen: string[] = []
    const out = await captureNetworkResponse(
      WS_URL,
      optionsFor('two-tabs-parallel', {
        select: (candidates) => {
          seen = candidates.map((c) => c.requestId)
          return candidates.find((c) => c.url.endsWith('/a'))
        },
      }),
    )
    expect(seen).toEqual(['A1', 'B1'])
    expect(out.requestId).toBe('A1')
    expect(out.body).toBe('tiny')
  })

  it('a select that picks nothing is CAPTURE_NO_MATCH', async () => {
    await expect(captureNetworkResponse(WS_URL, optionsFor('two-tabs-parallel', { select: () => undefined }))).rejects.toMatchObject({
      code: 'CAPTURE_NO_MATCH',
    })
  })
})

describe('8468f7b1 [capture-upgrade.9] captureAllNetworkResponses on two-tabs-parallel', () => {
  useFixture('two-tabs-parallel')

  it('returns every match, in start order (equal starts keep the order they were opened)', async () => {
    const all = await captureAllNetworkResponses(WS_URL, optionsFor('two-tabs-parallel'))
    expect(all.map((c) => c.requestId)).toEqual(['A1', 'B1'])
    expect(all.map((c) => c.url)).toEqual(['https://site.test/a', 'https://site.test/b'])
  })
})

describe('8468f7b1 [capture-upgrade.9] ordering is by request start, not by arrival', () => {
  useFixture(() =>
    fixtureWith('two-tabs-parallel', (f) => {
      const nav = f.steps.find((s) => s.when.method === 'Page.navigate')
      for (const ev of nav?.emit ?? []) {
        if (ev.method === 'Network.requestWillBeSent' && ev.params['requestId'] === 'B1') ev.params['timestamp'] = 99.0
      }
    }),
  )

  it('B1 started earlier, so it comes first', async () => {
    const all = await captureAllNetworkResponses(WS_URL, optionsFor('two-tabs-parallel'))
    expect(all.map((c) => c.requestId)).toEqual(['B1', 'A1'])
  })
})
