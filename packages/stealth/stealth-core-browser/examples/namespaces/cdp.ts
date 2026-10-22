/**
 * Scenario: protocol-level-inspection -- inspect a running Chrome at the protocol level: confirm it answers,
 * read its version, list its tabs and open a raw CDP session on the first tab to
 * enable the Page domain.
 */
// eslint-disable-next-line @nx/enforce-module-boundaries -- examples import the package root exactly as a consumer does
import { cdp } from '@adhd/stealth-core-browser'

export interface RunOptions {
  /** CDP host (default 127.0.0.1). */
  host?: string
  /** CDP remote-debugging port of the controlled Chrome. */
  port?: number
}

export interface CdpInspection {
  reachable: boolean
  browser?: string
  tabs: Array<{ id: string; url: string }>
  /** True when the Page domain was enabled on the first tab. */
  pageDomainEnabled: boolean
}

export async function run({ host = '127.0.0.1', port = 9333 }: RunOptions = {}): Promise<CdpInspection> {
  const cdpHost = `${host}:${port}`
  if (!(await cdp.isChromeReachable(cdpHost))) return { reachable: false, tabs: [], pageDomainEnabled: false }

  const info = await cdp.getChromeInfo(cdpHost)
  const pages = await cdp.listPageTargetsOnly(cdpHost)
  const tabs = pages.map((p) => ({ id: p.id, url: p.url }))

  let pageDomainEnabled = false
  const first = pages[0]
  if (first?.webSocketDebuggerUrl) {
    const session = new cdp.CdpSession()
    await session.connect(first.webSocketDebuggerUrl)
    try {
      await session.send('Page.enable')
      pageDomainEnabled = true
    } finally {
      session.close()
    }
  }
  return { reachable: true, browser: info.browserVersion, tabs, pageDomainEnabled }
}
