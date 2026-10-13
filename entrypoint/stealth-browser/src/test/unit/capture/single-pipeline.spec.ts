/**
 * One capture pipeline.
 * Ticket 8468f7b1 AC capture-upgrade.1 · [capture-upgrade.1]
 * Real use: an agent captures a page through captureNetworkResponse. The wrapper
 * must reach Chrome only through a CdpSession (one socket, no private WebSocket),
 * speak the stealth command set (no Runtime.evaluate) and send nothing extra.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { captureNetworkResponse } from '../../../lib/capture/network.js'
import { commandLog, optionsFor, useFixture, WS_URL } from './capture-kit.js'

describe('8468f7b1 [capture-upgrade.1] single capture pipeline', () => {
  const rig = useFixture('doc-200')

  it('captures the doc-200 page over exactly one CdpSession socket with the stealth command set', async () => {
    const out = await captureNetworkResponse(WS_URL, optionsFor('doc-200', { urlPattern: /\/home/ }))
    expect(out.body).toBe('<html><body>hello</body></html>')
    expect(out.url).toBe('https://site.test/home')
    expect(rig.server.openCount()).toBe(1)
    expect(commandLog(rig.server)).toEqual(['Page.enable', 'Network.enable', 'Page.navigate', 'Network.getResponseBody'])
    expect(commandLog(rig.server)).not.toContain('Runtime.evaluate')
  })

  it('the wrapper source opens no WebSocket of its own and keeps no private request/response copy', () => {
    const src = readFileSync(join(__dirname, '..', '..', '..', 'lib', 'capture', 'network.ts'), 'utf8')
    expect(src).not.toMatch(/new WebSocket\(/)
    expect(src).toContain('CdpSession')
    expect(src).not.toContain('InflightRequest')
    expect(src).not.toMatch(/interface CdpResponse/)
  })
})
