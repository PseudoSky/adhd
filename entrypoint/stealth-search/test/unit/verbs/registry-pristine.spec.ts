/**
 * guards: a spec mutates the shared PROVIDERS registry so a later test sees a changed provider
 * tier: S
 * cites: ticket 8468f7b1 [fix-search-output.2]
 * The provider registry is injected (`SearchDeps.providers`), so a per-test registry copy carries any retry
 * override and the module singleton is never written: two consecutive tests both see the pristine github retry
 * policy, and an override in one test does not leak to the next.
 *
 * Ticket 8468f7b1 · [fix-search-output.2]
 */
import { describe, expect, it } from 'vitest'
import { PROVIDERS } from '../../../src/lib/providers.js'
import { input, makeWorld, providersWithGithubRetry, response, scriptedEngine } from '../../helpers/verbs/harness.js'

const PRISTINE = JSON.stringify(PROVIDERS.github.retry)
const failure = response({ outcome: 'timeout', results: [], count: 0, error: 'nothing captured within 30000ms' })

describe('fix-search-output.2: the registry is pristine across tests (per-test copy)', () => {
  it('registry per-test: an injected abort policy is honoured by this test only (attempts 1)', async () => {
    const world = makeWorld({ strategies: scriptedEngine(failure).strategies, providers: providersWithGithubRetry({ onTimeout: 'abort' }) })
    expect(await world.svc.search(input({ maxAttempts: 3 }))).toMatchObject({ outcome: 'timeout', attempts: 1 })
    expect(JSON.stringify(PROVIDERS.github.retry)).toBe(PRISTINE)
  })

  it('registry pristine: the next test sees the unmodified singleton and the default retry policy (attempts 3)', async () => {
    expect(PROVIDERS.github.retry.onTimeout).toBe('retry')
    expect(JSON.stringify(PROVIDERS.github.retry)).toBe(PRISTINE)
    const world = makeWorld({ strategies: scriptedEngine(failure).strategies })
    expect(await world.svc.search(input({ maxAttempts: 3 }))).toMatchObject({ outcome: 'timeout', attempts: 3 })
  })

  it('per-test copy: the copy is a distinct object graph from the module registry at the github retry level', () => {
    const copy = providersWithGithubRetry({ onTimeout: 'abort' })
    expect(copy.github).not.toBe(PROVIDERS.github)
    expect(copy.github.retry).not.toBe(PROVIDERS.github.retry)
    expect(copy.github.retry.onTimeout).toBe('abort')
    expect(PROVIDERS.github.retry.onTimeout).toBe('retry')
  })
})
