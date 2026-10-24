/**
 * Ticket 8468f7b1 · criteria [tests-use-cases.1] [tests-use-cases.2] [tests-use-cases.4]
 * Exercises AC1 (page-target listing) and PA5.4 (CDP_UNREACHABLE, invalid endpoints).
 *
 * A person asks which tabs the controlled Chrome has open so they can pick one to inspect: real pages only,
 * with their ids, and a clear error when Chrome is not running or the endpoint is malformed.
 * guards: [tests-use-cases.2] returns only page targets with ids, addresses and socket urls
 * tier: S
 * cites: 8468f7b1 [tests-use-cases.1] [tests-use-cases.2] [tests-use-cases.4]
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chromeStatus, listPageTargets } from '../../../src/index.js'
import { ChromeWorld } from '../../helpers/use-cases/scenario-kit.js'

const world = new ChromeWorld(9412)

beforeEach(() => {
  world.up = true
  world.installFetch()
  world.tabs = [
    world.tab('T1', 'https://docs.test/a', 'Docs'),
    world.tab('T2', 'https://news.test/', 'News'),
    { id: 'SW1', type: 'service_worker', url: 'https://docs.test/sw.js', title: 'sw' },
    { id: 'BG1', type: 'background_page', url: 'chrome-extension://abc/background.html', title: 'ext' },
  ]
})
afterEach(() => world.dispose())

describe('Scenario: list the open tabs of the controlled Chrome and pick one', () => {
  it('[tests-use-cases.2] returns only page targets with ids, addresses and socket urls', async () => {
    const { targets } = await listPageTargets({ port: world.port })
    expect(targets.map((t) => t.id)).toEqual(['T1', 'T2'])
    expect(targets[0]).toEqual({ id: 'T1', type: 'page', url: 'https://docs.test/a', webSocketDebuggerUrl: `ws://127.0.0.1:${world.port}/devtools/page/T1` })
  })

  it('[tests-use-cases.2] an empty browser lists no tabs', async () => {
    world.tabs = []
    expect(await listPageTargets({ port: world.port })).toEqual({ targets: [] })
  })

  it('[tests-use-cases.4] a Chrome that is not running is a typed CDP_UNREACHABLE for the listing, and running:false for the status', async () => {
    world.up = false
    await expect(listPageTargets({ port: world.port })).rejects.toMatchObject({ code: 'CDP_UNREACHABLE' })
    expect(await chromeStatus({ port: world.port })).toEqual({ running: false, managed: false })
  })

  it('[tests-use-cases.4] a malformed endpoint is rejected before any request is made', async () => {
    await expect(listPageTargets({ port: 0 })).rejects.toMatchObject({ code: 'CDP_UNREACHABLE' })
    await expect(chromeStatus({ host: 'evil/host', port: world.port })).rejects.toMatchObject({ code: 'CDP_UNREACHABLE' })
    expect(world.requested).toEqual([])
  })
})
